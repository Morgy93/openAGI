#!/usr/bin/env node
// Live smoke for the voice broker's unknowns, against the real Realtime API.
// Streams one utterance (a WAV, or speech made with gpt-4o-mini-tts) into a
// gpt-realtime session with push-to-talk (turn_detection null, manual
// commit), then checks the input transcript, one function call round trip
// and the usage the response reports. Prints events, never the key.
//
//   node scripts/voice-smoke.mjs [--wav file.wav] [--text "..."] [--rate 24000|16000]
//        [--resample] [--model gpt-realtime-2.1] [--vad] [--text-out] [--json]
//
// --rate      the input rate declared in session.update (default 24000)
// --resample  send 16 kHz audio through the relay's 16k->24k resampler
// --text-out  output_modalities ["text"], as the G2 session asks for
// --vad --broker-responds  semantic_vad with create_response false; the
//             script sends response.create on each server commit, as the broker does
// --barge     cancel and truncate the first reply at its first audio (barge-in)
// The key comes from OPENAI_API_KEY, else <dataDir>/.env.
//
// Results on gpt-realtime-2.1 (2026-10-13): format rate 16000 is rejected
// ("Expected a value >= 24000"), so 16 kHz devices are resampled on the hub;
// turn_detection null plus a manual commit works; the input transcript lands
// 0.45-0.7 s after the commit; fleet_status was called and its output read
// back; a reply cost about $0.018-0.021 in audio, $0.005 as text; barge-in
// (response.cancel + conversation.item.truncate) is acknowledged; semantic_vad
// with create_response false works when the caller sends response.create.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadEnvFile } from "../src/file-utils.js";
import { resamplePcm16, realtimeCostUsd } from "../src/voice/audio.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const model = option("model", process.env.OPENAGI_VOICE_MODEL || "gpt-realtime-2.1");
const declaredRate = Number(option("rate", "24000"));
const resample = flag("resample");
const vad = flag("vad");
const asJson = flag("json");
const textOut = flag("text-out");
const barge = flag("barge");
const brokerResponds = flag("broker-responds");
const text = option("text", "Hey, what is the fleet status right now?");
const wavPath = option("wav", null);

loadEnvFile(path.join(process.env.OPENAGI_DATA_DIR || path.join(os.homedir(), ".openagi"), ".env"));
const key = process.env.OPENAI_API_KEY;
if (!key) { console.error("OPENAI_API_KEY is not set (env or ~/.openagi/.env)."); process.exit(2); }

const log = (...parts) => { if (!asJson) console.log(...parts); };

// PCM16 mono at `rate`: from the WAV, else synthesized speech.
async function utterance(rate) {
  if (wavPath) {
    const wav = fs.readFileSync(wavPath);
    const fmt = wav.indexOf("fmt ");
    const data = wav.indexOf("data");
    if (wav.toString("ascii", 0, 4) !== "RIFF" || fmt < 0 || data < 0) throw new Error("Not a WAV file.");
    const channels = wav.readUInt16LE(fmt + 10);
    const sampleRate = wav.readUInt32LE(fmt + 12);
    const bits = wav.readUInt16LE(fmt + 22);
    if (channels !== 1 || bits !== 16) throw new Error("Use a mono 16-bit WAV.");
    const pcm = wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4));
    return sampleRate === rate ? pcm : resamplePcm16(pcm, sampleRate, rate);
  }
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" })
  });
  if (!response.ok) throw new Error(`TTS failed: HTTP ${response.status}`);
  // gpt-4o-mini-tts pcm is 24 kHz mono 16-bit little-endian.
  const pcm24 = Buffer.from(await response.arrayBuffer());
  return rate === 24000 ? pcm24 : resamplePcm16(pcm24, 24000, rate);
}

const TOOL = {
  type: "function",
  name: "fleet_status",
  description: "Read the coding-agent fleet: counts, open questions and threads. Call it whenever the owner asks about the fleet.",
  parameters: { type: "object", properties: {}, additionalProperties: false }
};

async function run({ label, rate, sendRate }) {
  const result = { label, model, declaredRate: rate, sendRate, resampled: sendRate !== rate, errors: [], events: {} };
  const audio = await utterance(sendRate);
  const pcm = sendRate === rate ? audio : resamplePcm16(audio, sendRate, rate);
  result.audioMs = Math.round(pcm.length / 2 / rate * 1000);
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: { authorization: `Bearer ${key}` }, perMessageDeflate: false
  });
  const send = (event) => ws.send(JSON.stringify(event));
  const started = Date.now();
  const usage = [];
  let phase = "connect";
  let committedAt = 0;
  return await new Promise((resolve) => {
    const finish = (why) => {
      clearTimeout(timer);
      result.end = why;
      result.ms = Date.now() - started;
      result.usage = usage;
      result.usd = Number(usage.reduce((sum, u) => sum + realtimeCostUsd(u.usage, u.model), 0).toFixed(5));
      try { ws.close(); } catch { /* closing */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), 45_000);
    ws.on("error", (error) => { result.errors.push(`ws: ${error.message}`); finish("ws error"); });
    ws.on("unexpected-response", (_req, res) => { result.errors.push(`http ${res.statusCode}`); finish("rejected"); });
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      result.events[event.type] = (result.events[event.type] ?? 0) + 1;
      if (event.type === "error") {
        result.errors.push(`${phase}: ${event.error?.code ?? ""} ${event.error?.message ?? ""}`.trim());
        log(`  ! error in ${phase}: ${event.error?.message}`);
        if (phase === "update") { finish("session.update rejected"); }
        return;
      }
      if (event.type === "session.created") {
        phase = "update";
        result.sessionDefaults = { model: event.session?.model, rate: event.session?.audio?.input?.format?.rate, turnDetection: event.session?.audio?.input?.turn_detection?.type ?? null };
        send({ type: "session.update", session: {
          type: "realtime",
          instructions: "You are a terse voice assistant for a coding-agent fleet. Use fleet_status for fleet questions. Answer in one short sentence.",
          output_modalities: [textOut ? "text" : "audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate },
              transcription: { model: "gpt-4o-mini-transcribe", prompt: "OpenAGI, Conductor, Codex, fleet" },
              turn_detection: vad ? { type: "semantic_vad", eagerness: "auto", create_response: !brokerResponds, interrupt_response: true } : null
            },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" }
          },
          tools: [TOOL],
          tool_choice: "auto",
          truncation: { type: "retention_ratio", retention_ratio: 0.8 },
          reasoning: { effort: "low" }
        } });
        return;
      }
      if (event.type === "session.updated" && phase === "update") {
        phase = "audio";
        result.session = { rate: event.session?.audio?.input?.format?.rate, turnDetection: event.session?.audio?.input?.turn_detection ?? null, reasoning: event.session?.reasoning ?? null, truncation: event.session?.truncation ?? null, voice: event.session?.audio?.output?.voice ?? null };
        log(`  session.updated: rate ${result.session.rate}, turn_detection ${JSON.stringify(result.session.turnDetection)}, reasoning ${JSON.stringify(result.session.reasoning)}`);
        // 100 ms chunks, as a device would send them.
        const chunk = Math.round(rate / 10) * 2;
        for (let at = 0; at < pcm.length; at += chunk) send({ type: "input_audio_buffer.append", audio: pcm.subarray(at, at + chunk).toString("base64") });
        if (vad) {
          // Trailing silence so the server VAD ends the turn.
          const silence = Buffer.alloc(chunk);
          for (let i = 0; i < 15; i++) send({ type: "input_audio_buffer.append", audio: silence.toString("base64") });
          phase = "vad";
        } else {
          send({ type: "input_audio_buffer.commit" });
          committedAt = Date.now();
          send({ type: "response.create" });
          phase = "response";
        }
        return;
      }
      if (event.type === "input_audio_buffer.committed" && !committedAt) {
        committedAt = Date.now();
        if (vad && brokerResponds) send({ type: "response.create" });
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        result.transcript = event.transcript;
        result.transcriptMs = Date.now() - committedAt;
        result.transcriptionUsage = event.usage ?? null;
        if (event.usage) usage.push({ model: "gpt-4o-mini-transcribe", usage: event.usage });
        log(`  transcript (${result.transcriptMs} ms after commit): ${JSON.stringify(event.transcript)}`);
        return;
      }
      if (event.type === "response.output_audio.delta" && !result.firstAudioMs) {
        result.firstAudioMs = Date.now() - committedAt;
        if (barge && !result.barge) {
          // What the relay does on ctrl barge: stop the reply, cut what was not heard.
          result.barge = { itemId: event.item_id };
          send({ type: "response.cancel" });
          send({ type: "conversation.item.truncate", item_id: event.item_id, content_index: 0, audio_end_ms: 100 });
        }
      }
      if (event.type === "conversation.item.truncated") {
        result.barge = { ...result.barge, truncated: true, audioEndMs: event.audio_end_ms };
        log(`  truncated ${event.item_id} at ${event.audio_end_ms} ms`);
      }
      if (event.type === "response.output_text.done") {
        (result.replies ??= []).push(event.text);
        log(`  reply (text): ${JSON.stringify(event.text)}`);
      }
      if (event.type === "response.output_audio_transcript.done") {
        (result.replies ??= []).push(event.transcript);
        log(`  reply: ${JSON.stringify(event.transcript)}`);
      }
      if (event.type === "response.done") {
        const response = event.response ?? {};
        if (response.usage) usage.push({ model, usage: response.usage });
        const calls = (response.output ?? []).filter((item) => item.type === "function_call");
        log(`  response.done: ${response.status}${calls.length ? `, calls ${calls.map((c) => c.name).join(",")}` : ""}, usage ${JSON.stringify(response.usage ?? null)}`);
        if (barge && response.status === "cancelled") {
          result.barge = { ...result.barge, cancelled: true };
          // The truncate ack can trail the cancel.
          setTimeout(() => finish("barged"), 1500);
          return;
        }
        if (response.status === "failed") result.errors.push(`response failed: ${JSON.stringify(response.status_details ?? null)}`);
        if (calls.length && !result.functionCall) {
          result.functionCall = { name: calls[0].name, arguments: calls[0].arguments, ms: Date.now() - committedAt };
          for (const call of calls) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ mode: "propose", threads: 7, needsYou: 2, questions: [{ id: "fq_1", title: "Merge PR 42?" }] }) } });
          send({ type: "response.create" });
          return;
        }
        result.functionRoundTrip = Boolean(result.functionCall);
        finish("done");
      }
    });
  });
}

const runs = flag("rate") || resample || wavPath
  ? [{ label: resample ? "16k audio resampled to 24k" : `declared ${declaredRate}`, rate: declaredRate, sendRate: resample ? 16000 : declaredRate }]
  : [
      { label: "24k audio, rate 24000", rate: 24000, sendRate: 24000 },
      { label: "16k audio, rate 16000", rate: 16000, sendRate: 16000 },
      { label: "16k audio resampled to 24k", rate: 24000, sendRate: 16000 }
    ];
const results = [];
for (const spec of runs) {
  log(`\n== ${spec.label} (${model}${vad ? ", semantic_vad" : ", push-to-talk"})`);
  const result = await run(spec);
  results.push(result);
  log(`  end: ${result.end}; ${result.ms} ms; function call ${result.functionCall ? `${result.functionCall.name} at ${result.functionCall.ms} ms` : "none"}; round trip ${result.functionRoundTrip ? "ok" : "no"}; cost $${result.usd}`);
  if (result.errors.length) log(`  errors: ${result.errors.join(" | ")}`);
}
if (asJson) console.log(JSON.stringify(results, null, 2));
