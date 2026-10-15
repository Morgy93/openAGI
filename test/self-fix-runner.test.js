import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { SelfFixRunner, runFixProcess, createSelfFixCapability } from "../src/self-fix/runner.js";
import { FleetStore } from "../src/fleet/store.js";
import { SelfFixHub } from "../src/fleet/remote.js";
import { createFleetRoute } from "../src/fleet/routes.js";

const FIX = { title: "Stop duplicate questions", problem: "Duplicate questions", area: "policy", acceptance: "Questions decline." };
const CONFIG = 'model_provider = "codex-lb"\n[model_providers.codex-lb]\nname = "test"\nbase_url = "https://unit.invalid"\nenv_key = "CODEX_LB_API_KEY"\nwire_api = "responses"';

function fixture(t, settings = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-runner-"));
  const root = path.join(dir, "fixes"); fs.mkdirSync(path.join(root, "_repo/node_modules"), { recursive: true });
  const calls = [];
  let testFailures = 0, ownReviews = 0, replays = 0;
  const run = async (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    const override = await extra.onRun?.(bin, args, options);
    if (override) return override;
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
    if (args.some((arg) => arg.endsWith("fleet-replay.mjs"))) return { stdout: JSON.stringify({ passed: extra.replay?.(replays++) ?? true, metric: { name: "questions", before: 2, after: 1 }, regressions: [] }) };
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

test("dedicated checkout refreshes before briefs and replay on every run", async (t) => {
  let current = "first", repo;
  const { runner, root, calls } = fixture(t, {}, { onRun: (bin, args, options) => {
    if (bin === "git" && args[0] === "fetch") execFileSync("git", ["update-ref", "refs/remotes/origin/main", current], { cwd: repo });
    if (bin === "git" && args[0] === "reset") return { stdout: execFileSync("git", args, { cwd: repo, encoding: "utf8" }) };
    if ((bin === "fake-codex" && options.cwd === repo) || args.some((arg) => arg.endsWith("fleet-replay.mjs"))) {
      assert.equal(fs.readFileSync(path.join(repo, "version.txt"), "utf8"), current);
      assert.equal(fs.readFileSync(path.join(repo, "scripts/fleet-replay.mjs"), "utf8"), current);
    }
  } });
  repo = path.join(root, "_repo");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.mkdirSync(path.join(repo, "scripts"));
  for (const version of ["stale", "first", "second"]) {
    fs.writeFileSync(path.join(repo, "version.txt"), version);
    fs.writeFileSync(path.join(repo, "scripts/fleet-replay.mjs"), version);
    git("add", "version.txt", "scripts/fleet-replay.mjs"); git("commit", "-qm", version); git("tag", version);
  }
  git("reset", "--hard", "stale");
  for (const version of ["first", "second"]) {
    current = version;
    const fix = runner.enqueue({ ...FIX, title: version }); await runner.idle();
    assert.equal(runner.store.fix(fix.id).state, "owner-ask");
  }
  assert.equal(calls.filter((call) => call.args?.[0] === "reset").length, 2);
});

test("owner revision resolves the ready card through success and failure", async (t) => {
  for (const fail of [false, true]) {
    const { runner } = fixture(t, {}, { replay: () => !fail || !runner.store.fixes().some((fix) => fix.ownerRounds) });
    const fix = runner.enqueue(FIX); await runner.idle();
    const ready = runner.store.openQuestions().find((q) => q.dedupeKey === "self-fix:" + fix.id);
    runner.revise(fix.id, "Fix the rejected behavior.");
    assert.equal(runner.store.question(ready.id).status, "resolved");
    assert.ok(!runner.store.openQuestions().some((q) => q.kind === "self-fix"));
    await runner.idle();
    assert.equal(runner.store.fix(fix.id).state, fail ? "failed" : "owner-ask");
    assert.equal(runner.store.openQuestions().filter((q) => q.kind === "self-fix").length, fail ? 0 : 1);
  }
});

test("review replay failure retains the initial published head without pushing repairs", async (t) => {
  for (const fail of [false, true]) {
    const { runner, calls } = fixture(t, {}, { findings: (round) => round ? [] : [{ severity: "P1", summary: "Real failure", small: true }], replay: (round) => !fail || round === 0 });
    const fix = runner.enqueue(FIX); await runner.idle();
    assert.equal(runner.store.fix(fix.id).state, fail ? "failed" : "owner-ask");
    assert.equal(calls.filter((call) => call.publish).length, fail ? 1 : 2);
    const order = calls.filter((call) => call.publish || call.args?.some((arg) => arg.endsWith("fleet-replay.mjs"))).map((call) => call.publish ? "publish" : "replay");
    assert.deepEqual(order, fail ? ["replay", "publish", "replay"] : ["replay", "publish", "replay", "publish"]);
  }
});

test("async capability shutdown waits for a child ignoring SIGTERM and cleans the lock", async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const kills = [];
  const { runner, root } = fixture(t, {}, { codingWait: (options) => runFixProcess(process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
    { ...options, env: { PATH: process.env.PATH }, onLine: () => entered(), kill: (pid, signal) => { kills.push(signal); process.kill(pid, signal); } }) });
  const node = createSelfFixCapability({ dataDir: runner.dataDir, home: runner.home, env: {}, config: runner.config, deps: runner.deps, store: runner.store });
  t.after(() => node.stop());
  const fix = node.runner.enqueue(FIX); await started;
  await node.stop();
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(node.runner.active, null);
  assert.equal(node.runner.store.fix(fix.id).state, "failed");
  assert.equal(fs.existsSync(path.join(root, ".active-lock")), false);
});

test("shutdown interrupts only the active run; stop all keeps review-ready fixes", async (t) => {
  let block = false, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { runner } = fixture(t, {}, { codingWait: (options) => {
    if (block) { entered(); return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })); }
    options.onLine(JSON.stringify({ type: "thread.started", thread_id: "fixer-session" }));
    options.onLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } }));
    return { stdout: "" };
  } });
  const node = createSelfFixCapability({ dataDir: runner.dataDir, home: runner.home, env: {}, config: runner.config, deps: runner.deps, store: runner.store });
  t.after(() => node.stop());
  const ready = node.runner.enqueue(FIX); await node.runner.idle();
  assert.equal(node.runner.store.fix(ready.id).state, "owner-ask");
  block = true;
  const active = node.runner.enqueue({ ...FIX, title: "Active", area: "voice" }); await started;
  const queued = node.runner.enqueue({ ...FIX, title: "Queued", area: "judge" });
  await node.stop();
  assert.equal(node.runner.store.fix(active.id).state, "failed");
  assert.equal(node.runner.store.fix(queued.id).state, "queued");
  assert.equal(node.runner.store.fix(ready.id).state, "owner-ask");
  assert.equal(node.runner.active, null); assert.equal(node.runner.jobs.size, 0);
  assert.ok(node.runner.store.openQuestions().some((question) => question.dedupeKey === "self-fix:" + ready.id));
  // Observe mode stops queued work but keeps the open PR; stopping it by id still works.
  assert.deepEqual(node.runner.stop("all").map((fix) => fix.id), [queued.id]);
  assert.equal(node.runner.store.fix(ready.id).state, "owner-ask");
  assert.deepEqual(node.runner.stop(ready.id).map((fix) => fix.id), [ready.id]);
});

test("node_modules link is ignored, so guard passes and owner-close cleanup removes the worktree", async (t) => {
  let root;
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const fixtureRun = fixture(t, {}, { prState: "MERGED", onRun: (bin, args, options) => {
    if (bin !== "git") return;
    if (args[0] === "worktree" && args[1] === "add" && args[2] === "-b") git(args, options.cwd);
    if (args[0] === "status" || (args[0] === "worktree" && args[1] === "remove" && args[2].startsWith(path.join(root, "fix_")))) return { stdout: git(args, options.cwd) };
  } });
  root = fixtureRun.root;
  const { runner } = fixtureRun;
  const repo = path.join(root, "_repo");
  git(["init", "-q"], repo); git(["config", "user.name", "Fixture"], repo); git(["config", "user.email", "fixture@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(repo, "test")); fs.writeFileSync(path.join(repo, "test/fixture.test.js"), "");
  git(["add", ".gitignore", "test/fixture.test.js"], repo); git(["commit", "-qm", "base"], repo);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  const fix = runner.enqueue(FIX); await runner.idle();
  const { worktree, state } = runner.store.fix(fix.id);
  assert.equal(state, "owner-ask", runner.store.fix(fix.id).error);
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink());
  assert.equal(git(["status", "--porcelain"], worktree), "");
  await runner.reconcile();
  assert.equal(runner.store.fix(fix.id).state, "done");
  assert.equal(fs.existsSync(worktree), false);
  assert.ok(fs.existsSync(path.join(repo, "node_modules")));
});

function hubFixture(t) {
  const { runner, dir } = fixture(t);
  const store = new FleetStore({ dir: path.join(dir, "hub") });
  const operations = [];
  const runtime = { nodeCapabilities: { dispatch: async (_node, _capability, operation, payload) => {
    operations.push(operation);
    if (operation === "start") runner.enqueue(payload.fix);
    if (operation === "revise") runner.revise(payload.id, payload.instructions, payload.requestId);
    return runner.snapshot();
  } } };
  const hub = new SelfFixHub({ store, runtime, config: runner.config, nodeId: "coding-mac" });
  return { hub, runner, store, runtime, operations };
}

test("failed and token cards stay closed on hub sync, including old deliver cards", async (t) => {
  for (const kind of ["deliver", "self-fix-attention"]) {
    for (const dismiss of [false, true]) {
      const { hub, runner, store } = hubFixture(t);
      const fix = store.queueFix(FIX); runner.store.importFix(fix); runner.store.updateFix(fix.id, { state: "owner-ask" });
      for (const dedupeKey of ["self-fix:failed:" + fix.id, "self-fix:token"]) runner.store.upsertQuestion({ kind, dedupeKey, title: "Needs attention", options: ["OK"] });
      await hub.sync();
      for (const question of store.openQuestions()) {
        if (dismiss) store.dismissQuestion(question.id); else assert.equal((await hub.answer(question.id, "OK")).delivery.detail, "Acknowledged");
      }
      await hub.sync(); await hub.sync();
      assert.equal(store.openQuestions().length, 0);
      assert.equal(store.state.questions.length, 2);
    }
  }
});

test("second revision is refused locally and old capped commands cannot poison sync", async (t) => {
  const { hub, runner, store, operations } = hubFixture(t);
  const fix = await hub.queue(FIX); await runner.idle(); await hub.sync();
  await hub.revise(fix.id, "One revision."); await runner.idle(); await hub.sync();
  assert.equal(store.fix(fix.id).ownerRounds, 1);
  await assert.rejects(hub.revise(fix.id, "Second revision."), /cap/);
  assert.deepEqual(store.fixCommands(), {});
  store.updateFix(fix.id, { ownerRounds: 0 });
  store.queueFixCommand("revise:" + fix.id, { operation: "revise", payload: { id: fix.id, instructions: "Old command", requestId: "old-request" } });
  const count = operations.filter((operation) => operation === "revise").length;
  await hub.sync();
  assert.deepEqual(store.fixCommands(), {});
  assert.equal(operations.filter((operation) => operation === "revise").length, count);
  assert.equal(store.fix(fix.id).state, "owner-ask");
  assert.equal(store.openQuestions().filter((q) => q.kind === "self-fix").length, 1);
});

test("Request changes hides the hub card immediately while offline and during replay", async (t) => {
  const { hub, runner, store, runtime } = hubFixture(t);
  const fix = await hub.queue(FIX); await runner.idle(); await hub.sync();
  const ready = store.openQuestions().find((q) => q.kind === "self-fix");
  const dispatch = runtime.nodeCapabilities.dispatch;
  runtime.nodeCapabilities.dispatch = async () => { throw new Error("offline"); };
  const supervisor = { getState: () => ({ questions: store.openQuestions() }), reviseFix: (...args) => hub.revise(...args) };
  const route = createFleetRoute({ supervisor });
  const response = await route("POST", "/fleet/api/questions/" + ready.id, null, async () => ({ answer: "Request changes", instructions: "Cover this case." }));
  assert.equal(response.status, 200);
  assert.equal(response.body.question, null);
  assert.equal(response.body.state.questions.length, 0);
  assert.equal(store.fix(fix.id).state, "queued");
  await assert.rejects(hub.revise(fix.id, "Again while offline."), /cap/);
  runtime.nodeCapabilities.dispatch = dispatch;
  await hub.sync(); await runner.idle(); await hub.sync();
  assert.equal(runner.store.fix(fix.id).ownerRounds, 1);
  assert.equal(store.fix(fix.id).state, "owner-ask");
  assert.equal(store.openQuestions().filter((q) => q.kind === "self-fix").length, 1);
});
