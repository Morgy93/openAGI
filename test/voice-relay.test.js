import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import WebSocket from "ws";
import { attachVoiceRelay, VOICE_PROTOCOL } from "../src/voice/relay.js";
import { createVoiceSessionFactory, createVoiceSpend } from "../src/voice/broker.js";
import { attachG2SpeechRelay } from "../src/integrations/g2-speech-relay.js";
import { isOwnerPrincipal } from "../src/owner-authority.js";
import { ToolRegistry } from "../src/tool-registry.js";

const OWNER = "o".repeat(43);
const PHONE = "p".repeat(43);
const G2 = "g".repeat(43);
const OTHER = "x".repeat(43);

function fakeSession() {
  const calls = [];
  const session = {
    calls,
    audio: [],
    appendOk: true,
    appendAudio(pcm) { session.audio.push(pcm); return session.appendOk; },
    commit() { calls.push(["commit"]); },
    barge(options) { calls.push(["barge", options]); },
    setFocus(focus) { calls.push(["focus", focus]); },
    setHandsFree(on) { calls.push(["handsFree", on]); },
    close(reason) { calls.push(["close", reason]); }
  };
  return session;
}

async function fixture(t, { env = { OPENAGI_VOICE: "1" }, createSession, viaG2 = false, ...timing } = {}) {
  const server = http.createServer();
  let revoked = false;
  const nodeRegistry = {
    enrollmentForToken: (token) => (token === PHONE ? { nodeId: "phone-1", platform: "mobile", name: "Pixel" }
      : token === G2 && !revoked ? { nodeId: "g2-1", platform: "even_g2" }
      : token === OTHER ? { nodeId: "mac-node", platform: "openagi" } : null),
    authenticate: (id, token) => (id === "phone-1" && token === PHONE) || (id === "g2-1" && token === G2 && !revoked)
  };
  const sessions = [];
  const relay = attachVoiceRelay({
    nodeRegistry, env, getAuthToken: () => OWNER,
    createSession: createSession ?? (async (params, io) => { const session = fakeSession(); session.params = params; session.io = io; sessions.push(session); return session; }),
    ...timing
  });
  let g2Relay = null;
  if (viaG2) g2Relay = attachG2SpeechRelay(server, { nodeRegistry, getChannel: () => ({ deepgramApiKey: "dg" }), upgrades: [relay] });
  else server.on("upgrade", relay.upgrade);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `ws://127.0.0.1:${server.address().port}`;
  t.after(async () => { relay.close(); g2Relay?.close(); await new Promise((resolve) => server.close(resolve)); });
  return { origin, sessions, relay, revoke: () => { revoked = true; } };
}

function connect(origin, token, query = "") {
  const ws = new WebSocket(`${origin}/nodes/voice${query}`, [VOICE_PROTOCOL, token]);
  const events = [];
  const waiting = [];
  ws.on("error", () => {});
  ws.on("message", (data, binary) => {
    const event = binary ? { type: "audio", bytes: data.length } : JSON.parse(data.toString());
    if (waiting.length) waiting.shift()(event); else events.push(event);
  });
  const next = () => (events.length ? Promise.resolve(events.shift()) : new Promise((resolve) => waiting.push(resolve)));
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  return { ws, next, closed, opened: once(ws, "open"), send: (value) => ws.send(JSON.stringify(value)) };
}

function denied(url, protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("open", () => { ws.terminate(); reject(new Error("Unexpected upgrade")); });
  });
}

const until = async (check, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("off unless OPENAGI_VOICE=1", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { env: {} });
  assert.equal(await denied(`${f.origin}/nodes/voice`, [VOICE_PROTOCOL, OWNER]), 404);
});

test("auth per token type: owner bearer is the Mac, phone and G2 tokens are theirs, anything else is refused", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const url = `${f.origin}/nodes/voice`;
  assert.equal(await denied(url, [VOICE_PROTOCOL, "z".repeat(43)]), 403);
  assert.equal(await denied(url, [VOICE_PROTOCOL, OTHER]), 403, "a coding node token is not a voice device");
  assert.equal(await denied(url, ["openagi-g2-speech", OWNER]), 403);
  assert.equal(await denied(url, [VOICE_PROTOCOL]), 403);
  assert.equal(await denied(`${url}?mode=handsfree`, [VOICE_PROTOCOL, G2]), 400, "G2 is tap-to-talk only");
  assert.equal(await denied(`${url}?rate=8000`, [VOICE_PROTOCOL, OWNER]), 400);
  assert.equal(await denied(`${url}?token=${OWNER}`, [VOICE_PROTOCOL, OWNER]), 400, "no URL tokens");

  for (const [token, kind, source, output, rate] of [[OWNER, "owner", "mac-voice", "audio", 24000], [PHONE, "phone", "android-voice", "audio", 24000], [G2, "g2", "g2-voice", "text", 16000]]) {
    const client = connect(f.origin, token);
    await client.opened;
    client.send({ type: "start", gesture: kind === "g2" ? "tap" : "hotkey" });
    await until(() => f.sessions.some((session) => session.params.device.kind === kind));
    const { params } = f.sessions.find((session) => session.params.device.kind === kind);
    assert.equal(params.device.source, source);
    assert.equal(params.output, output);
    assert.equal(params.device.inputRate, rate);
    assert.equal(isOwnerPrincipal(params.principal), true);
    assert.equal(params.principal.via, "voice");
    assert.equal(params.principal.nodeId, params.device.nodeId);
    client.ws.close();
  }
});

test("the principal needs a gesture: a wake word or audio before start never opens a session", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const wake = connect(f.origin, OWNER);
  await wake.opened;
  wake.send({ type: "start", gesture: "wake" });
  assert.equal((await wake.next()).code, "gesture");
  assert.equal((await wake.closed).code, 1008);
  const early = connect(f.origin, PHONE);
  await early.opened;
  early.ws.send(Buffer.alloc(320));
  assert.equal((await early.closed).code, 1008);
  assert.equal(f.sessions.length, 0);
});

test("push-to-talk controls reach the session: commit, barge with played ms, context, mode", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const client = connect(f.origin, OWNER, "?mode=ptt");
  await client.opened;
  client.send({ type: "start", gesture: "hotkey", focus: { view: "supervisor" } });
  await until(() => f.sessions.length === 1);
  const [session] = f.sessions;
  assert.equal(session.params.handsFree, false);
  assert.deepEqual(session.params.focus, { view: "supervisor" });
  client.ws.send(Buffer.alloc(4800));
  client.send({ type: "commit" });
  client.send({ type: "barge", playedMs: 320 });
  client.send({ type: "context", focus: { threadKey: "codex:t1" } });
  client.send({ type: "mode", handsFree: true });
  await until(() => session.calls.length >= 4);
  assert.deepEqual(session.calls, [["commit"], ["barge", { playedMs: 320 }], ["focus", { threadKey: "codex:t1" }], ["handsFree", true]]);
  assert.equal(session.audio[0].length, 4800);
  // The broker's events and audio reach the device.
  session.io.send({ type: "reply.delta", text: "On it." });
  session.io.sendAudio(Buffer.alloc(480));
  assert.deepEqual(await client.next(), { type: "reply.delta", text: "On it." });
  assert.deepEqual(await client.next(), { type: "audio", bytes: 480 });
  client.send({ type: "stop" });
  assert.equal((await client.closed).code, 1000);
  await until(() => session.calls.some(([name]) => name === "close"));
});

test("pacing: faster than real time is refused; a backed-up upload ends the session", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const fast = connect(f.origin, OWNER);
  await fast.opened;
  fast.send({ type: "start", gesture: "mic" });
  await until(() => f.sessions.length === 1);
  // Two seconds of burst is allowed; three at once is not.
  fast.ws.send(Buffer.alloc(48_000));
  fast.ws.send(Buffer.alloc(48_000));
  fast.ws.send(Buffer.alloc(48_000));
  const end = await fast.next();
  assert.equal(end.code, "audio_rate");
  assert.equal((await fast.closed).code, 1008);

  const slow = connect(f.origin, PHONE);
  await slow.opened;
  slow.send({ type: "start", gesture: "mic" });
  await until(() => f.sessions.length === 2);
  f.sessions[1].appendOk = false;
  slow.ws.send(Buffer.alloc(960));
  assert.equal((await slow.next()).code, "upstream_backlog");
  assert.equal((await slow.closed).code, 1011);
  // Odd-length PCM is not 16-bit audio.
  const odd = connect(f.origin, OWNER);
  await odd.opened;
  odd.send({ type: "start", gesture: "mic" });
  await until(() => f.sessions.length === 3);
  odd.ws.send(Buffer.alloc(101));
  assert.equal((await odd.next()).code, "invalid_pcm");
});

test("G2 audio at 16 kHz is resampled to 24 kHz before the session", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const client = connect(f.origin, G2);
  await client.opened;
  client.send({ type: "start", gesture: "tap" });
  await until(() => f.sessions.length === 1);
  for (let i = 0; i < 4; i++) client.ws.send(Buffer.alloc(3200));
  await until(() => f.sessions[0].audio.length === 4);
  const total = f.sessions[0].audio.reduce((sum, pcm) => sum + pcm.length, 0);
  assert.ok(Math.abs(total - 19200) <= 4, `got ${total}`);
});

test("one session per device: a newer one replaces it", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const first = connect(f.origin, OWNER);
  await first.opened;
  const second = connect(f.origin, OWNER);
  await second.opened;
  assert.equal((await first.closed).code, 4000);
  assert.deepEqual(f.relay.active(), ["owner"]);
  second.ws.close();
});

test("idle 120 s and the 55 minute cap close the session (shortened here)", { timeout: 3000 }, async (t) => {
  const idle = await fixture(t, { idleMs: 120, heartbeatMs: 30 });
  const quiet = connect(idle.origin, OWNER);
  await quiet.opened;
  quiet.send({ type: "start", gesture: "hotkey" });
  const end = await quiet.next();
  assert.equal(end.code, "idle");
  assert.equal((await quiet.closed).code, 4001);

  const hard = await fixture(t, { maxMs: 100, idleMs: 10_000 });
  const busy = connect(hard.origin, PHONE);
  await busy.opened;
  busy.send({ type: "start", gesture: "mic" });
  const timer = setInterval(() => { try { busy.ws.send(Buffer.alloc(960)); } catch { /* closed */ } }, 20);
  t.after(() => clearInterval(timer));
  assert.equal((await busy.closed).code, 4003);
});

test("a revoked G2 token ends the session at the next heartbeat", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { heartbeatMs: 30 });
  const client = connect(f.origin, G2);
  await client.opened;
  client.send({ type: "start", gesture: "tap" });
  await until(() => f.sessions.length === 1);
  f.revoke();
  assert.equal((await client.closed).code, 1008);
});

test("end to end through the G2 server hook: real broker, fake OpenAI, key never reaches the device", { timeout: 5000 }, async (t) => {
  class Upstream extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
    event(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  }
  let upstream;
  const registry = new ToolRegistry();
  const factory = createVoiceSessionFactory({
    runtime: { tools: registry, budget: null },
    env: { OPENAI_API_KEY: "sk-hub-only", OPENAGI_VOICE: "1" },
    upstreamFactory: (url, options) => { upstream = new Upstream(url, options); return upstream; },
    spend: createVoiceSpend({ capUsd: 5 })
  });
  const f = await fixture(t, { viaG2: true, createSession: (params, io) => factory.create(params, io) });
  const client = connect(f.origin, G2);
  await client.opened;
  client.send({ type: "start", gesture: "tap" });
  await until(() => upstream);
  assert.equal(upstream.options.headers.Authorization, "Bearer sk-hub-only");
  upstream.event({ type: "session.created" });
  upstream.event({ type: "session.updated" });
  const ready = await client.next();
  assert.equal(ready.type, "ready");
  assert.equal(ready.output, "text");
  assert.deepEqual(upstream.sent[0].session.output_modalities, ["text"]);
  client.ws.send(Buffer.alloc(6400));
  client.send({ type: "commit" });
  await until(() => upstream.sent.some((event) => event.type === "input_audio_buffer.commit"));
  const append = upstream.sent.find((event) => event.type === "input_audio_buffer.append");
  assert.ok(Math.abs(Buffer.from(append.audio, "base64").length - 9600) <= 4);
  upstream.event({ type: "error", error: { code: "x", message: "boom" } });
  const error = await client.next();
  assert.equal(error.type, "error");
  assert.ok(!JSON.stringify(error).includes("sk-hub-only"));
  // Other paths are still the G2 relay's to refuse.
  assert.equal(await denied(`${f.origin}/nodes/other`, [VOICE_PROTOCOL, OWNER]), 404);
  client.ws.close();
});

test("a slow text device hits the same outbound backlog cap as audio", { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const client = connect(f.origin, G2);
  await client.opened;
  client.send({ type: "start", gesture: "tap" });
  await until(() => f.sessions.length === 1);
  f.sessions[0].io.send({ type: "reply.delta", text: "x".repeat(512_001) });
  assert.equal((await client.next()).code, "client_backlog");
  assert.equal((await client.closed).code, 1011);
});

test("start followed immediately by audio and controls preserves their order", { timeout: 3000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const f = await fixture(t, { createSession: async () => {
    await gate;
    return {
      appendAudio(pcm) { calls.push(["audio", pcm.length]); return true; },
      commit() { calls.push(["commit"]); },
      setFocus(focus) { calls.push(["context", focus]); },
      close() {}
    };
  } });
  const client = connect(f.origin, OWNER);
  await client.opened;
  client.send({ type: "start", gesture: "hotkey" });
  client.ws.send(Buffer.alloc(4800));
  client.send({ type: "commit" });
  client.send({ type: "context", focus: { view: "supervisor" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await until(() => calls.length === 3);
  assert.deepEqual(calls, [["audio", 4800], ["commit"], ["context", { view: "supervisor" }]]);
  client.send({ type: "stop" });
  assert.equal((await client.closed).code, 1000);
});

test("startup audio is still paced and startup frames are bounded", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, { createSession: () => new Promise(() => {}) });
  const fast = connect(f.origin, OWNER);
  await fast.opened;
  fast.send({ type: "start", gesture: "mic" });
  for (let i = 0; i < 3; i++) fast.ws.send(Buffer.alloc(48_000));
  assert.equal((await fast.next()).code, "audio_rate");
  const tiny = connect(f.origin, PHONE);
  await tiny.opened;
  tiny.send({ type: "start", gesture: "mic" });
  for (let i = 0; i < 501; i++) tiny.ws.send(Buffer.alloc(2));
  assert.equal((await tiny.next()).code, "upstream_backlog");
});
