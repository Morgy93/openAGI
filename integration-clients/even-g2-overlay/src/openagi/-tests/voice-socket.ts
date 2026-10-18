import { vi } from 'vitest'

export class FakeVoiceSocket {
  readyState = 0
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  send = vi.fn<(data: string | ArrayBuffer) => void>()
  close = vi.fn(() => { this.readyState = 3 })
  open(): void { this.readyState = 1; this.onopen?.(new Event('open')) }
  event(value: object): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })) }
  frames(): object[] { return this.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) as object : data) }
}
