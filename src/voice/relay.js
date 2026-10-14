// WSS /nodes/voice: the one door every voice device uses (Mac Quick Ask,
// the phone's Supervisor tab, G2 glasses). The upgrade bypasses the HTTP
// handler, so it authenticates itself from the subprotocol pair
// ["openagi-voice", <token>]: the owner's bearer (Mac), a paired phone's node
// token or a G2 token. No URL tokens and no provider key from the client.
//
// Frames: binary = PCM16 mono at the declared rate (G2 16k, resampled here
// to 24k); text = JSON control: start {gesture, mode?, focus?}, commit,
// barge {playedMs?}, context {focus}, mode {handsFree}, stop.
// The owner principal is minted only on start with a real gesture (hotkey,
// mic button, tap); a wake word never opens a session. One session per
// device (a newer one replaces it), idle 120 s, hard 55 min.

import WebSocket, { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { ownerPrincipal } from "../owner-authority.js";
import { EVEN_G2_PLATFORM } from "../integrations/g2-channel.js";
import { MOBILE_PLATFORM } from "../mobile-node.js";
import { createResampler } from "./audio.js";
import { VOICE_RATE, voiceEnabled } from "./broker.js";

export const VOICE_PATH = "/nodes/voice";
export const VOICE_PROTOCOL = "openagi-voice";
const GESTURES = new Set(["hotkey", "mic", "button", "tap"]);
const MAX_FRAME = 64_000;
const CONTROL_MAX = 4_096;
const CLIENT_BACKLOG = 512_000;
const MAX_SESSIONS = 8;
const START_WAIT_MS = 10_000;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Which device a token belongs to, or null. The owner's bearer is the Mac.
export function voiceDevice(token, { nodeRegistry, ownerToken }) {
  if (ownerToken && safeEqual(token, ownerToken)) {
    return { kind: "owner", key: "owner", nodeId: null, name: "Mac", source: "mac-voice", inputRate: VOICE_RATE, output: "audio", handsFreeAllowed: true };
  }
  const enrollment = nodeRegistry?.enrollmentForToken?.(token);
  if (!enrollment?.nodeId) return null;
  if (enrollment.platform === MOBILE_PLATFORM) {
    return { kind: "phone", key: `node:${enrollment.nodeId}`, nodeId: enrollment.nodeId, name: enrollment.name ?? null, source: "android-voice", inputRate: VOICE_RATE, output: "audio", handsFreeAllowed: true };
  }
  if (enrollment.platform === EVEN_G2_PLATFORM) {
    return { kind: "g2", key: `node:${enrollment.nodeId}`, nodeId: enrollment.nodeId, name: enrollment.name ?? null, source: "g2-voice", inputRate: 16000, output: "text", handsFreeAllowed: false };
  }
  return null;
}

// createSession(params, io) -> { appendAudio, commit, barge, setFocus,
// setHandsFree, close } (src/voice/broker.js createVoiceSessionFactory).
export function attachVoiceRelay({ nodeRegistry, getAuthToken = () => null, createSession, env = process.env,
  idleMs = 120_000, maxMs = 55 * 60_000, heartbeatMs = 10_000, startWaitMs = START_WAIT_MS } = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME, handleProtocols: () => VOICE_PROTOCOL });
  const active = new Map();
  const attempts = new Map();
  let closing = false;

  const upgrade = (req, socket, head) => {
    const deny = (status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return deny(400); }
    if (url.pathname !== VOICE_PATH) return deny(404);
    // Off unless OPENAGI_VOICE=1: the route does not exist.
    if (!voiceEnabled(env)) return deny(404);
    if (closing || req.method !== "GET") return deny(503);
    const protocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
    if (protocols.length !== 2 || protocols[0] !== VOICE_PROTOCOL || !/^[A-Za-z0-9._~+-]{16,512}$/.test(protocols[1])) return deny(403);
    const token = protocols[1];
    const device = voiceDevice(token, { nodeRegistry, ownerToken: getAuthToken() });
    if (!device) return deny(403);
    const params = [...url.searchParams.keys()];
    const rate = Number(url.searchParams.get("rate") ?? device.inputRate);
    const mode = url.searchParams.get("mode") ?? "ptt";
    if (params.some((key) => !["rate", "mode"].includes(key)) || params.length !== new Set(params).size
        || ![16000, 24000].includes(rate) || !["ptt", "handsfree"].includes(mode)
        || (mode === "handsfree" && !device.handsFreeAllowed)) return deny(400);
    if (!active.has(device.key) && active.size >= MAX_SESSIONS) return deny(429);
    const now = Date.now();
    for (const [id, attempt] of attempts) if (attempt.until <= now) attempts.delete(id);
    const attempt = attempts.get(device.key) ?? { count: 0, until: now + 60_000 };
    if (attempt.count >= 10) return deny(429);
    attempt.count++; attempts.set(device.key, attempt);
    try {
      wss.handleUpgrade(req, socket, head, (client) => {
        // One session per device: the newer one wins.
        active.get(device.key)?.end("Replaced by a newer voice session.", 4000);
        const connection = connect(client, { device, token, rate, handsFree: mode === "handsfree" });
        active.set(device.key, connection);
      });
    } catch { socket.destroy(); }
  };

  function stillAuthorized(device, token) {
    if (device.kind === "owner") return safeEqual(token, getAuthToken() ?? "");
    return Boolean(nodeRegistry?.authenticate?.(device.nodeId, token));
  }

  function connect(client, { device, token, rate, handsFree }) {
    const resample = rate === VOICE_RATE ? null : createResampler(rate, VOICE_RATE);
    const bytesPerMs = rate * 2 / 1000;
    // Two seconds of burst, refilled in real time.
    const audioBurst = 2_000 * bytesPerMs;
    let audioBudget = audioBurst;
    let budgetAt = Date.now();
    let controlBudget = 20;
    let controlAt = Date.now();
    let session = null;
    let starting = false;
    let done = false;
    let alive = true;
    let lastActivity = Date.now();
    let closeTimer;

    const io = {
      send(event) {
        if (done || client.readyState !== WebSocket.OPEN) return;
        lastActivity = Date.now();
        const text = JSON.stringify(event);
        if (client.bufferedAmount + Buffer.byteLength(text) > CLIENT_BACKLOG) { end("Voice events fell behind the connection.", 1011, "client_backlog"); return; }
        client.send(text);
      },
      sendAudio(pcm) {
        if (done || client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount + pcm.length > CLIENT_BACKLOG) { end("Reply audio fell behind the connection.", 1011, "client_backlog"); return; }
        lastActivity = Date.now();
        client.send(pcm, { binary: true });
      },
      end(reason, code) { end(reason, code === "voice_cap" ? 4002 : code === "closed" ? 1000 : 1011, code); }
    };

    const end = (reason, closeCode = 1000, code = "ended") => {
      if (done) return;
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "end", code, reason: String(reason ?? "").slice(0, 200) }));
      done = true;
      clearTimeout(startTimer); clearTimeout(hardTimer); clearInterval(heartbeat);
      if (active.get(device.key) === connection) active.delete(device.key);
      try { session?.close?.(reason); } catch { /* closing */ }
      if (client.readyState === WebSocket.OPEN) {
        client.close(closeCode, String(reason ?? "").slice(0, 120));
        closeTimer = setTimeout(() => client.terminate(), 1000); closeTimer.unref?.();
      } else client.terminate();
    };
    const fail = (reason, code = "bad_frame") => end(reason, 1008, code);

    async function start(control) {
      if (session || starting) return fail("Voice session already started.");
      if (control.gesture === "wake") return fail("A wake word never opens a voice session; use the hotkey, mic button or a tap.", "gesture");
      if (!GESTURES.has(control.gesture)) return fail("Start needs the owner's gesture: hotkey, mic, button or tap.", "gesture");
      const wantsHandsFree = control.mode === undefined ? handsFree : control.mode === "handsfree";
      if (wantsHandsFree && !device.handsFreeAllowed) return fail("Hands-free is not available on this device.", "mode");
      starting = true;
      clearTimeout(startTimer);
      try {
        const principal = ownerPrincipal("voice", device.nodeId);
        const created = await createSession({ device, principal, handsFree: wantsHandsFree, focus: control.focus ?? null, output: device.output, gesture: control.gesture }, io);
        if (done) { created?.close?.("client left"); return; }
        session = created;
      } catch (error) {
        end(String(error?.message ?? "Voice is unavailable.").slice(0, 200), error?.code === "voice_cap" ? 4002 : 1011, String(error?.code ?? "unavailable").slice(0, 40));
      } finally {
        starting = false;
      }
    }

    function control(data) {
      if (data.length > CONTROL_MAX) return fail("Voice control frame too large.");
      const now = Date.now();
      controlBudget = Math.min(20, controlBudget + Math.max(0, now - controlAt) / 1000 * 10); controlAt = now;
      if (--controlBudget < 0) return fail("Too many voice control frames.");
      let message;
      try { message = JSON.parse(data.toString()); } catch { return fail("Voice control must be JSON."); }
      if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") return fail("Voice control must be an object with a type.");
      if (message.type === "start") return start(message);
      if (message.type === "stop") return end("Stopped.", 1000, "stopped");
      if (!session) return starting ? undefined : fail("Send start before anything else.");
      switch (message.type) {
        case "commit": return session.commit();
        case "barge": return session.barge({ playedMs: Number.isFinite(message.playedMs) ? message.playedMs : null });
        case "context": return session.setFocus(message.focus ?? null);
        case "mode":
          if (message.handsFree === true && !device.handsFreeAllowed) return fail("Hands-free is not available on this device.", "mode");
          return session.setHandsFree(message.handsFree === true);
        default: return fail("Unknown voice control.");
      }
    }

    function audio(data) {
      if (!session) return fail("Audio arrived before start.");
      if (!data.length || data.length % 2) return fail("Invalid PCM frame: expected 16-bit mono audio.", "invalid_pcm");
      const now = Date.now();
      audioBudget = Math.min(audioBurst, audioBudget + Math.max(0, now - budgetAt) * bytesPerMs); budgetAt = now;
      if (data.length > audioBudget) return fail("Audio arrived faster than real time. Check pacing and the declared rate.", "audio_rate");
      audioBudget -= data.length;
      const pcm = resample ? resample(data) : data;
      if (!session.appendAudio(pcm)) end("Voice upload backed up. Start again.", 1011, "upstream_backlog");
    }

    client.on("error", () => end("Voice connection interrupted.", 1011, "client"));
    client.on("close", () => { end("Client closed.", 1000, "closed"); clearTimeout(closeTimer); });
    client.on("pong", () => { alive = true; });
    client.on("message", (data, binary) => {
      if (done) return;
      lastActivity = Date.now();
      if (binary) audio(data); else control(data);
    });

    const startTimer = setTimeout(() => { if (!session && !starting) fail("No start within 10 seconds.", "no_start"); }, startWaitMs);
    startTimer.unref?.();
    const hardTimer = setTimeout(() => end("Voice sessions end after 55 minutes. Start again.", 4003, "hard_cap"), maxMs);
    hardTimer.unref?.();
    const heartbeat = setInterval(() => {
      if (!stillAuthorized(device, token)) { end("Voice access was revoked.", 1008, "revoked"); return; }
      if (Date.now() - lastActivity >= idleMs) { end("Voice went quiet for two minutes and closed.", 4001, "idle"); return; }
      if (!alive) { end("Device disconnected.", 1011, "gone"); return; }
      alive = false; client.ping();
    }, Math.min(heartbeatMs, idleMs));
    heartbeat.unref?.();

    const connection = { end, device };
    return connection;
  }

  return {
    path: VOICE_PATH,
    upgrade,
    active: () => [...active.values()].map((connection) => connection.device.key),
    close() {
      closing = true;
      for (const connection of [...active.values()]) connection.end("The hub is shutting down.", 1001, "shutdown");
      wss.close();
    }
  };
}
