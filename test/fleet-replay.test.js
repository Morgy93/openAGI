import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareReplay, replayPair } from "../scripts/fleet-replay.mjs";

const sample = (questions, sent = 0) => ({ rows: [], questions: [], sent: [], metrics: { questions }, playbooks: { classify: { questions, sent } } });
test("replay requires target movement and blocks untouched playbook question or send regressions", () => {
  assert.equal(compareReplay(sample(10), sample(9), { name: "questions", direction: "down" }).passed, true);
  assert.equal(compareReplay(sample(10), sample(10), { name: "questions", direction: "down" }).passed, false);
  assert.equal(compareReplay(sample(10), sample(9, 1), { name: "questions", direction: "down" }).passed, false);
  assert.equal(compareReplay(sample(10), sample(9), { name: "unmeasured", direction: "down" }).passed, false);
});
test("base and fix get identical frozen fixture data, live inputs remain unchanged", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replay-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "fleet"));
  const state = JSON.stringify({ snapshot: { at: "2026-10-13T12:00:00Z", threads: [] } });
  fs.writeFileSync(path.join(dataDir, "fleet/state.json"), state);
  fs.writeFileSync(path.join(dataDir, "fleet/actions.jsonl"), "");
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const result = replayPair({ baseDir: repo, fixDir: repo, dataDir, metric: { name: "questions", direction: "down" } });
  assert.deepEqual(result.base, result.fix); assert.equal(result.passed, false);
  assert.equal(fs.readFileSync(path.join(dataDir, "fleet/state.json"), "utf8"), state);
});

test("base versus fix compares different revisions over the same frozen inputs", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-replay-diff-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "fleet"));
  fs.writeFileSync(path.join(dataDir, "fleet/state.json"), '{"questions":[]}');
  const reads = [];
  const run = (_node, args) => {
    reads.push(fs.readFileSync(path.join(args[3], "fleet/state.json"), "utf8"));
    fs.writeFileSync(path.join(args[3], "fleet/state.json"), '{"changed":true}');
    return { status: 0, stdout: JSON.stringify(sample(args[2] === "/base" ? 10 : 9)) };
  };
  assert.equal(replayPair({ baseDir: "/base", fixDir: "/fix", dataDir, metric: { name: "questions", direction: "down" }, run }).passed, true);
  assert.deepEqual(reads, ['{"questions":[]}', '{"questions":[]}']);
  assert.equal(fs.readFileSync(path.join(dataDir, "fleet/state.json"), "utf8"), '{"questions":[]}');
});
