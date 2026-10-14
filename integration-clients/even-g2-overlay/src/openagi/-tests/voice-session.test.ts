import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { G2VoiceSession, supervisorVoiceFocus, type VoiceSocket } from '../voice-session'

import { FakeVoiceSocket } from './voice-socket'

function fixture() {
  const sockets: FakeVoiceSocket[] = []
  let receive: (pcm: Uint8Array) => void = () => {}
  const audio = { active: false, start: vi.fn((callback: typeof receive) => { receive = callback; audio.active = true; return Promise.resolve() }), stop: vi.fn(() => { audio.active = false; return Promise.resolve() }) }
  const callbacks = { state: vi.fn(), reply: vi.fn(), transcript: vi.fn(), notice: vi.fn(), error: vi.fn<(error: Error) => void>() }
  const factory = vi.fn<(url: string, protocols: string[]) => VoiceSocket>(() => { const socket = new FakeVoiceSocket(); sockets.push(socket); return socket })
  const session = new G2VoiceSession(audio, callbacks, factory)
  const press = () => session.press({ url: 'wss://main.example/nodes/voice?rate=16000&mode=ptt', token: 'g2-test-token-123456' }, { view: 'supervisor', questionId: 'fq_1' })
  const ready = async () => { sockets[0].open(); sockets[0].event({ type: 'ready', output: 'text' }); await vi.advanceTimersByTimeAsync(1) }
  return { session, audio, callbacks, factory, sockets, press, ready, receive: (pcm: Uint8Array) => receive(pcm) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('maps the outreach card to its fleet question, with a thread only when present', () => {
  expect(supervisorVoiceFocus({ id: 'outreach-7', questionId: 'fq_1', supervisor: true, threadKey: 'codex:one' })).toEqual({ view: 'supervisor', questionId: 'fq_1', threadKey: 'codex:one' })
  expect(supervisorVoiceFocus({ id: 'outreach-7', supervisor: true })).toEqual({ view: 'supervisor' })
  expect(supervisorVoiceFocus({ id: 'mail', questionId: 'fq_wrong' })).toEqual({ view: 'supervisor' })
  expect(supervisorVoiceFocus()).toEqual({ view: 'supervisor' })
})

it('authenticates by subprotocol, waits for ready, streams PCM16 unchanged and commits once on release', async () => {
  const f = fixture(); f.press(); f.press()
  expect(f.factory).toHaveBeenCalledExactlyOnceWith('wss://main.example/nodes/voice?rate=16000&mode=ptt', ['openagi-voice', 'g2-test-token-123456'])
  expect(f.audio.start).not.toHaveBeenCalled()
  await f.ready()
  const pcm = new Uint8Array([0, 128, 255, 127])
  f.receive(pcm); pcm.fill(0)
  expect(f.sockets[0].frames()).toEqual([{ type: 'start', gesture: 'tap', mode: 'ptt', focus: { view: 'supervisor', questionId: 'fq_1' } }, { type: 'context', focus: { view: 'supervisor', questionId: 'fq_1' } }, new Uint8Array([0, 128, 255, 127]).buffer])
  f.session.release(); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  expect(f.audio.stop).toHaveBeenCalledOnce()
  expect(f.sockets[0].frames().filter(frame => !(frame instanceof ArrayBuffer) && 'type' in frame && frame.type === 'commit')).toHaveLength(1)
  f.receive(new Uint8Array(320)); expect(f.sockets[0].send).toHaveBeenCalledTimes(4)
  f.session.close()
})

it('remembers a release before ready and before microphone opening finishes', async () => {
  const f = fixture()
  let opened!: () => void
  f.audio.start.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
  f.press(); f.session.release()
  f.sockets[0].open(); f.sockets[0].event({ type: 'ready' })
  expect(f.sockets[0].frames()).not.toContainEqual({ type: 'commit' })
  opened(); await vi.advanceTimersByTimeAsync(1)
  expect(f.sockets[0].frames()).toContainEqual({ type: 'commit' })
  expect(f.session.state).toBe('waiting'); f.session.close()
})

it('renders bounded text replies and barges before the next microphone opens', async () => {
  const f = fixture(); f.press(); await f.ready(); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  f.sockets[0].event({ type: 'reply.delta', text: 'Hello ' })
  f.sockets[0].event({ type: 'reply.delta', text: 'there' })
  expect(f.callbacks.reply).toHaveBeenLastCalledWith('Hello there', false)
  f.press()
  expect(f.sockets[0].frames().slice(-2)).toEqual([{ type: 'barge' }, { type: 'context', focus: { view: 'supervisor', questionId: 'fq_1' } }])
  f.sockets[0].event({ type: 'reply.done', text: 'Old cancelled reply' })
  expect(f.callbacks.reply).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  f.sockets[0].event({ type: 'reply.done', text: 'x'.repeat(5000) })
  expect(f.callbacks.reply).toHaveBeenLastCalledWith('x'.repeat(4000), true)
  expect(f.factory).toHaveBeenCalledOnce(); f.session.close()
})

it('passes spoken confirmations as audio and never interprets or submits them locally', async () => {
  const f = fixture(); f.press(); await f.ready(); f.receive(new Uint8Array(6400)); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  f.sockets[0].event({ type: 'transcript', role: 'owner', text: 'yes 42' })
  expect(f.callbacks.transcript).toHaveBeenCalledWith('yes 42')
  expect(f.sockets[0].frames().filter(frame => !(frame instanceof ArrayBuffer))).toHaveLength(3)
  f.session.close()
})

it('discards a barged partial reply even when its completion arrives after the next release', async () => {
  const f = fixture(); f.press(); await f.ready(); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  f.sockets[0].event({ type: 'reply.delta', text: 'Old partial' })
  f.press(); await vi.advanceTimersByTimeAsync(1); f.receive(new Uint8Array(6400)); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  f.sockets[0].event({ type: 'reply.delta', text: ' cancelled tail' })
  f.sockets[0].event({ type: 'reply.done', text: 'Old cancelled reply' })
  expect(f.callbacks.reply).toHaveBeenCalledExactlyOnceWith('Old partial', false)
  expect(f.session.state).toBe('waiting')
  f.sockets[0].event({ type: 'reply.delta', text: 'New reply' })
  f.sockets[0].event({ type: 'reply.done', text: 'New reply' })
  expect(f.callbacks.reply).toHaveBeenLastCalledWith('New reply', true)
  f.session.close()
})

it('queues an interrupt during microphone stop and commits before barging and reopening', async () => {
  const f = fixture(); f.press(); await f.ready()
  let stopped!: () => void
  f.audio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
  f.session.release(); f.press(); f.press()
  expect(f.audio.start).toHaveBeenCalledOnce()
  stopped(); await vi.advanceTimersByTimeAsync(1)
  expect(f.sockets[0].frames().slice(-3)).toEqual([{ type: 'commit' }, { type: 'barge' }, { type: 'context', focus: { view: 'supervisor', questionId: 'fq_1' } }])
  expect(f.audio.start).toHaveBeenCalledTimes(2)
  expect(f.session.state).toBe('listening')
  f.session.close()
})

it('remembers a hold release while the interrupt is queued behind microphone stop', async () => {
  const f = fixture(); f.press(); await f.ready()
  let stopped!: () => void
  f.audio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
  f.session.release(); f.press(); f.session.release()
  stopped(); await vi.advanceTimersByTimeAsync(1)
  expect(f.audio.start).toHaveBeenCalledTimes(2)
  expect(f.sockets[0].frames().filter(frame => 'type' in frame && frame.type === 'commit')).toHaveLength(2)
  f.session.close()
})

it('accepts the next press after close while an old microphone open is unresolved', async () => {
  const f = fixture(); let opened!: () => void
  f.audio.start.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
  f.press(); f.sockets[0].open(); f.sockets[0].event({ type: 'ready' }); f.session.close()
  let reopened!: () => void
  f.audio.start.mockImplementationOnce(() => new Promise<void>(resolve => { reopened = resolve }))
  f.press(); f.sockets[1].open(); f.sockets[1].event({ type: 'ready' })
  expect(f.factory).toHaveBeenCalledTimes(2)
  opened(); await vi.advanceTimersByTimeAsync(1)
  f.session.release()
  expect(f.sockets[1].frames()).not.toContainEqual({ type: 'commit' })
  expect(f.audio.stop).toHaveBeenCalledOnce()
  reopened(); await vi.advanceTimersByTimeAsync(1)
  expect(f.sockets[1].frames()).toContainEqual({ type: 'commit' })
  f.session.close()
})

it('accepts the next press after close while an old microphone stop is unresolved', async () => {
  const f = fixture(); f.press(); await f.ready()
  let stopped!: () => void
  f.audio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
  f.session.release(); f.press(); f.session.close(); f.press()
  f.sockets[1].open(); f.sockets[1].event({ type: 'ready' }); await vi.advanceTimersByTimeAsync(1)
  stopped(); await vi.advanceTimersByTimeAsync(1)
  expect(f.factory).toHaveBeenCalledTimes(2)
  expect(f.audio.start).toHaveBeenCalledTimes(2)
  expect(f.session.state).toBe('listening')
  expect(f.sockets[0].frames()).not.toContainEqual({ type: 'commit' })
  f.session.close()
})

it('ends at idle and reconnects only on a new gesture, ignoring events from the old socket', async () => {
  const f = fixture(); f.press(); await f.ready(); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  f.sockets[0].event({ type: 'reply.done', text: 'Done' })
  const stale = f.sockets[0].onmessage!
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.sockets[0].close).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledOnce()
  f.press(); stale(new MessageEvent('message', { data: '{"type":"reply.done","text":"stale"}' }))
  expect(f.callbacks.reply).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledTimes(2)
  f.session.close()
})

it('closes a suspended opening without committing or retaining late microphone audio', async () => {
  const f = fixture(); let opened!: () => void
  f.audio.start.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
  f.press(); f.sockets[0].open(); f.sockets[0].event({ type: 'ready' }); f.session.close()
  opened(); await vi.advanceTimersByTimeAsync(1); f.receive(new Uint8Array(3200)); f.session.release()
  expect(f.sockets[0].frames()).toHaveLength(2)
  expect(f.audio.stop).toHaveBeenCalled(); expect(f.session.state).toBe('idle')
})

it('commits at the 30-second cap once, even if release follows', async () => {
  const f = fixture(); f.press(); await f.ready()
  await vi.advanceTimersByTimeAsync(30_000); f.session.release(); await vi.advanceTimersByTimeAsync(1)
  expect(f.callbacks.notice).toHaveBeenCalledWith(expect.stringContaining('30-second limit'))
  expect(f.sockets[0].frames().filter(frame => 'type' in frame && frame.type === 'commit')).toHaveLength(1)
  f.session.close()
})

it('fails closed on backlog, malformed PCM and a ready timeout, without logging server errors', async () => {
  for (const cause of ['backlog', 'pcm', 'timeout', 'error', 'cap']) {
    const f = fixture(); f.press()
    if (cause === 'timeout') await vi.advanceTimersByTimeAsync(15_000)
    else {
      await f.ready()
      if (cause === 'backlog') { f.sockets[0].bufferedAmount = 256_000; f.receive(new Uint8Array(320)) }
      if (cause === 'pcm') f.receive(new Uint8Array(3))
      if (cause === 'error') f.sockets[0].event({ type: 'error', message: 'private-server-detail' })
      if (cause === 'cap') f.sockets[0].event({ type: 'end', code: 'voice_cap' })
    }
    expect(f.sockets[0].close).toHaveBeenCalledOnce()
    expect(f.callbacks.error).toHaveBeenCalledOnce()
    expect(f.callbacks.error.mock.calls[0][0].message).not.toContain('private-server-detail')
  }
})
