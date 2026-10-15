import test from "node:test";
import assert from "node:assert/strict";
import { smokeExitCode } from "../scripts/voice-smoke.mjs";

const passed = () => ({ declaredRate: 24000, sendRate: 24000, end: "done", errors: [], transcript: "Fleet status?", functionRoundTrip: true, replies: ["All clear."] });

test("smoke exit status fails missing transcripts, tool round trips, replies, and provider failures", () => {
  assert.equal(smokeExitCode([passed()]), 0);
  assert.equal(smokeExitCode([]), 1);
  for (const changes of [{ end: "timeout" }, { transcript: "" }, { functionRoundTrip: false }, { replies: [] }, { errors: ["provider failed"] }]) {
    assert.equal(smokeExitCode([{ ...passed(), ...changes }]), 1, JSON.stringify(changes));
  }
});

test("only the expected direct 16k format rejection passes", () => {
  const rejected = { declaredRate: 16000, sendRate: 16000, end: "session.update rejected", errors: ["update: integer_below_min_value Invalid value: 16000. Expected a value >= 24000"] };
  assert.equal(smokeExitCode([passed(), rejected]), 0);
  for (const changes of [{ declaredRate: 24000 }, { end: "timeout" }, { errors: ["invalid api key"] }, { errors: [...rejected.errors, "another error"] }]) {
    assert.equal(smokeExitCode([{ ...rejected, ...changes }]), 1);
  }
});

test("barge smoke requires both cancel and truncate acknowledgements and a transcript", () => {
  const barged = { ...passed(), end: "barged", barge: { cancelled: true, truncated: true }, functionRoundTrip: false, replies: [] };
  assert.equal(smokeExitCode([barged], { barge: true }), 0);
  assert.equal(smokeExitCode([{ ...barged, barge: { cancelled: true } }], { barge: true }), 1);
  assert.equal(smokeExitCode([{ ...barged, transcript: "" }], { barge: true }), 1);
  assert.equal(smokeExitCode([passed()], { barge: true, textOut: true }), 0);
});
