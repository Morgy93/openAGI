import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SelfFixRunner, runFixProcess, createSelfFixCapability } from "../src/self-fix/runner.js";
import { FleetStore } from "../src/fleet/store.js";
import { SelfFixHub } from "../src/fleet/remote.js";

const FIX = { title: "Stop duplicate questions", problem: "Duplicate questions", area: "policy", acceptance: "Questions decline." };
const CONFIG = 'model_provider = "codex-lb"\n[model_providers.codex-lb]\nname = "test"\nbase_url = "https://unit.invalid"\nenv_key = "CODEX_LB_API_KEY"\nwire_api = "responses"';

function fixture(t, settings = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-runner-"));
  const root = path.join(dir, "fixes"); fs.mkdirSync(path.join(root, "_repo/node_modules"), { recursive: true });
  const calls = [];
  let testFailures = 0, ownReviews = 0;
  const run = async (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    if (args.includes("worktree") && args.includes("add")) {
      const wt = args.at(-2); fs.mkdirSync(path.join(wt, "test"), { recursive: true });
      fs.writeFileSync(path.join(wt, "test/fixture.test.js"), "");
    }
    if (bin === "fake-codex") {
      if (!args.includes("--output-schema") && extra.codingWait) return extra.codingWait(options);
      options.onLine(JSON.stringify({ type: "thread.started", thread_id: "fixer-session" }));
      options.onLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } }));
      if (args.includes("--output-schema")) {
        const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
        const out = schema.properties.findings ? { findings: extra.findings?.(ownReviews++) ?? [] } : { problem: FIX.problem, acceptance: FIX.acceptance, targetFiles: ["src/fleet/policy.js"], evidenceActionIds: [], metric: { name: "questions", direction: "down" } };
        fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(out));
      }
    }
    if (args[0] === "--test" && testFailures++ < (extra.testFailures ?? 0)) throw new Error("fixture test failure");
    if (args.some((arg) => arg.endsWith("fleet-replay.mjs"))) return { stdout: JSON.stringify({ passed: true, metric: { name: "questions", before: 2, after: 1 }, regressions: [] }) };
    return { stdout: args.includes("get-url") ? "https://github.com/Spshulem/openAGI.git\n" : args.includes("rev-parse") ? "base-head\n" : args.includes("--name-only") ? "src/fleet/policy.js\0test/fixture.test.js\0" : args[0] === "diff" ? "+ safe repair\n" : "" };
  };
  const gh = { auth: async () => {}, push: async () => { calls.push({ publish: true }); return "fixed-head"; },
    create: async () => ({ prUrl: "https://github.com/Spshulem/openAGI/pull/1", prNumber: 1, prRef: "Spshulem/openAGI#1" }),
    reviews: async () => [], state: async () => ({ state: extra.prState ?? "OPEN" }), close: async () => {}, git: (...args) => run("git", ...args) };
  const deps = { run, gh, lbKey: "unit-lb-credential", readToken: () => "unit-fixer-credential", codexConfig: CONFIG, freeGb: async () => 7, ...extra.deps };
  const runner = new SelfFixRunner({ dataDir: dir, home: dir, env: {}, config: { selfFix: { root, codex: "fake-codex", node: process.execPath, reviewWaitMs: 0, ...settings } }, deps });
  t.after(async () => { runner.stop("all"); await runner.idle(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { runner, dir, root, calls };
}

test("state machine runs tests, guard, replay, PR, review, and owner question using only fake tools", async (t) => {
  const { runner, calls } = fixture(t);
  const fix = runner.enqueue(FIX); await runner.idle();
  const result = runner.store.fix(fix.id);
  assert.equal(result.state, "owner-ask"); assert.equal(result.prNumber, 1); assert.ok(result.tokens > 0);
  const states = runner.store.actions(100).filter((action) => action.kind === "self-fix").map((action) => action.state);
  for (const state of ["preflight", "brief", "worktree", "coding", "tests", "guard", "pr", "awaiting-review", "replay", "owner-ask"]) assert.ok(states.includes(state), state);
  assert.deepEqual(runner.store.selfSessions(), ["fixer-session"]);
  assert.deepEqual(runner.store.openQuestions()[0].options, ["Review PR", "Request changes", "Close PR"]);
  assert.match(runner.store.openQuestions()[0].card, /Metric/);
  assert.ok(calls.findIndex((call) => call.args?.some((arg) => arg.endsWith("fleet-replay.mjs"))) < calls.findIndex((call) => call.publish));
  assert.ok(calls.filter((call) => call.bin === "fake-codex").every((call) => !call.options.env.GH_TOKEN));
  assert.equal(Object.keys(runner.store.state.fixLocks).length, 0);
});
test("off and low-confidence auto refuse; token, disk, usage and daily caps fail without publication", async (t) => {
  const off = fixture(t, { mode: "off" }).runner;
  assert.throws(() => off.enqueue(FIX), /off/);
  const auto = fixture(t, { mode: "auto" }).runner;
  assert.throws(() => auto.enqueue({ ...FIX, auto: true, confidence: 0.7 }), /confidence/);
  for (const [settings, deps, error] of [[{}, { readToken: () => { throw new Error("Dedicated self-fix GitHub token missing."); } }, /GitHub token/], [{}, { freeGb: async () => 4 }, /5 GiB/], [{ tokenCap: 10 }, {}, /token cap/], [{ dailyCap: 1 }, {}, /daily cap/]]) {
    const { runner, calls } = fixture(t, settings, { deps });
    if (settings.dailyCap) { const previous = runner.store.queueFix(FIX); runner.store.updateFix(previous.id, { state: "done", startedAt: new Date().toISOString() }); }
    const fix = runner.enqueue(FIX); await runner.idle();
    assert.equal(runner.store.fix(fix.id).state, "failed"); assert.match(runner.store.fix(fix.id).error, error);
    assert.ok(!calls.some((call) => call.publish));
  }
});
test("runner fixes test failure once, bounds review and owner revisions, reconciles owner closure", async (t) => {
  const { runner } = fixture(t, {}, { testFailures: 1, findings: (round) => round ? [] : [{ severity: "P1", file: "src/fleet/policy.js", line: 1, summary: "Customer sends fail", small: false }], prState: "CLOSED" });
  const fix = runner.enqueue(FIX); await runner.idle();
  assert.equal(runner.store.fix(fix.id).round, 1);
  runner.revise(fix.id, "Cover reopened questions."); await runner.idle();
  assert.equal(runner.store.fix(fix.id).ownerRounds, 1);
  assert.throws(() => runner.revise(fix.id, "Again"), /cap/);
  await runner.reconcile();
  assert.equal(runner.store.fix(fix.id).outcome, "declined");
});
test("abort kills the child's process group and rejects before another command", async () => {
  const child = new EventEmitter(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const controller = new AbortController(); const kills = [];
  const pending = runFixProcess("fake", [], { signal: controller.signal, spawnImpl: (_bin, _args, options) => { assert.equal(options.detached, true); return child; }, kill: (pid, signal) => { kills.push([pid, signal]); child.emit("close", null); } });
  controller.abort(new Error("Owner stop"));
  await assert.rejects(pending, /Owner stop/);
  assert.deepEqual(kills[0], [-424242, "SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.deepEqual(kills[1], [-424242, "SIGKILL"]);
});
test("hub retains queued and stop state while offline; dispatch is pinned and idempotent", async (t) => {
  const { runner, dir } = fixture(t);
  const store = new FleetStore({ dir: path.join(dir, "hub") });
  let online = false; const operations = [];
  const runtime = { nodeCapabilities: { dispatch: async (node, capability, operation, payload) => {
    assert.equal(node, "coding-mac"); assert.equal(capability, "self-fix"); operations.push(operation);
    if (!online) throw new Error("offline");
    if (operation === "start") runner.enqueue(payload.fix);
    if (operation === "stop") runner.stop(payload.id);
    return runner.snapshot();
  } } };
  const hub = new SelfFixHub({ store, runtime, config: runner.config, nodeId: "coding-mac" });
  const fix = await hub.queue(FIX); assert.equal(fix.state, "queued");
  online = true; await hub.sync(); await runner.idle(); await hub.sync();
  assert.equal(store.fix(fix.id).state, "owner-ask");
  assert.deepEqual(store.selfSessions(), ["fixer-session"]);
  online = false; await hub.stop(fix.id); online = true; await hub.sync();
  assert.equal(store.fix(fix.id).state, "abandoned"); assert.equal(runner.store.fix(fix.id).state, "abandoned");
  assert.equal(runner.store.fixes().length, 1);
});
test("node capability rejects merge and arbitrary operations", async (t) => {
  const { runner, dir } = fixture(t);
  const capability = createSelfFixCapability({ dataDir: dir, home: dir, env: {}, config: { selfFix: { mode: "off", root: path.join(dir, "other") } } });
  await assert.rejects(capability.execute({ capability: "self-fix", operation: "merge" }), /Unsupported/);
  assert.equal(runner.active, null);
});

test("global on-disk lock prevents two runner processes sharing a coding computer", async (t) => {
  const { runner, root, calls } = fixture(t);
  fs.writeFileSync(path.join(root, ".active-lock"), JSON.stringify({ pid: process.pid, fixId: "another-fix" }));
  const fix = runner.enqueue(FIX); await runner.idle();
  assert.match(runner.store.fix(fix.id).error, /global lock/);
  assert.ok(!calls.some((call) => call.publish));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".active-lock"), "utf8")).fixId, "another-fix");
});

test("wall clock cap and stop abort coding, retain worktree and prevent publication", async (t) => {
  for (const stop of [false, true]) {
    let entered, expire;
    const started = new Promise((resolve) => { entered = resolve; });
    const { runner, calls } = fixture(t, {}, {
      deps: { setTimeout: (callback) => { expire = callback; return setTimeout(callback, 60000); } },
      codingWait: ({ signal }) => new Promise((_resolve, reject) => {
        entered();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    });
    const fix = runner.enqueue(FIX); await started;
    if (stop) runner.stop(fix.id); else expire();
    await runner.idle();
    const result = runner.store.fix(fix.id);
    assert.equal(result.state, stop ? "abandoned" : "failed");
    assert.ok(fs.existsSync(result.worktree));
    if (!stop) assert.match(result.error, /wall clock cap/);
    assert.ok(!calls.some((call) => call.publish));
  }
});
