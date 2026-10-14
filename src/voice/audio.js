// PCM16 helpers shared by the voice relay and broker. Mono, little-endian.

// Streaming linear resampler: one per device stream, so a frame boundary
// never clicks (the last input sample carries over to the next frame).
export function createResampler(fromRate, toRate) {
  const step = fromRate / toRate;
  let carry = null;
  let pos = 0;
  return (chunk) => {
    const count = Math.floor(chunk.length / 2);
    const offset = carry === null ? 0 : 1;
    const length = count + offset;
    if (!length) return Buffer.alloc(0);
    const at = (index) => (index < offset ? carry : chunk.readInt16LE((index - offset) * 2));
    const out = Buffer.alloc(Math.ceil((length - pos) / step + 1) * 2);
    let written = 0;
    for (; pos <= length - 1; pos += step) {
      const index = Math.floor(pos);
      const frac = pos - index;
      const value = index + 1 < length ? at(index) + (at(index + 1) - at(index)) * frac : at(index);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), written);
      written += 2;
    }
    carry = at(length - 1);
    pos -= length - 1;
    return out.subarray(0, written);
  };
}

export function resamplePcm16(buffer, fromRate, toRate) {
  if (fromRate === toRate) return Buffer.from(buffer);
  return createResampler(fromRate, toRate)(buffer);
}

// Realtime list prices, USD per 1M tokens. A cached token bills at the cached
// rate once, never again at the full rate.
export const REALTIME_PRICES = Object.freeze({
  "gpt-realtime-2.1": { textIn: 4, textCached: 0.4, textOut: 24, audioIn: 32, audioCached: 0.4, audioOut: 64 },
  "gpt-realtime": { textIn: 4, textCached: 0.4, textOut: 16, audioIn: 32, audioCached: 0.4, audioOut: 64 },
  "gpt-4o-mini-transcribe": { textIn: 1.25, textCached: 1.25, textOut: 5, audioIn: 3, audioCached: 3, audioOut: 0 }
});

export function realtimePrice(model) {
  const price = REALTIME_PRICES[String(model ?? "")];
  if (!Object.hasOwn(REALTIME_PRICES, String(model ?? ""))) throw new Error("Realtime model has no known pricing.");
  return price;
}

// USD for one response.done usage (or a transcription's usage).
export function realtimeCostUsd(usage, model) {
  if (!usage || typeof usage !== "object") return 0;
  const price = realtimePrice(model);
  const inDetails = usage.input_token_details ?? {};
  const outDetails = usage.output_token_details ?? {};
  const cached = inDetails.cached_tokens_details ?? {};
  const num = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const audioIn = num(inDetails.audio_tokens);
  const textIn = num(inDetails.text_tokens ?? (num(usage.input_tokens) - audioIn));
  const cachedAudio = Math.min(audioIn, num(cached.audio_tokens));
  const cachedText = Math.min(textIn, num(cached.text_tokens ?? (num(inDetails.cached_tokens) - cachedAudio)));
  const audioOut = num(outDetails.audio_tokens);
  const textOut = num(outDetails.text_tokens ?? (num(usage.output_tokens) - audioOut));
  return ((textIn - cachedText) * price.textIn + cachedText * price.textCached
    + (audioIn - cachedAudio) * price.audioIn + cachedAudio * price.audioCached
    + textOut * price.textOut + audioOut * price.audioOut) / 1e6;
}
