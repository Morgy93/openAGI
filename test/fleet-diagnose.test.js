import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTION_LOG_MAX, DAY_MS, diagnose, foldActions } from "../src/fleet/diagnose.js";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { createDiagnoseModels, diagnoseDue, readDiagnoseInputs } from "../src/fleet/suggestions.js";
import { october13 } from "./fixtures/fleet-diagnose.js";

const NOW = new Date(2026, 9, 13, 20).getTime();
const at = (offset = 0) => new Date(NOW + offset).toISOString();
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-diagnose-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("October 13 fixture: 432 blocked, 89/99 unanswered, 28 relay exit 1, 35 Claude limits", () => {
  const report = diagnose(october13(NOW));
  assert.equal(report.metrics.computerUseBlocked, 432);
  assert.equal(report.metrics.plannedNudges, 540);
  assert.equal(report.metrics.questions.asked, 99);
  assert.equal(report.metrics.questions.closedUnanswered, 89);
  assert.equal(report.metrics.questions.unansweredRate, 89 / 99);
  assert.equal(report.metrics.sendsByRoute["peer-relay"].exit1, 28);
  assert.equal(report.metrics.review.failures, 37);
  assert.equal(report.metrics.review.modelLimitFailures, 35);
  for (const metric of ["questions-unanswered", "send-failure:peer-relay", "review-failures", "review-model-limits"]) assert.ok(report.anomalies.some((a) => a.metric === metric), metric);
});

test("folding update-only rows retains kind, route and original time, and counts once", () => {
  assert.deepEqual(foldActions([{ id: "a", kind: "review", at: at(), status: "planned" }, { op: "update", id: "a", status: "failed" }]), [{ id: "a", kind: "review", at: at(), status: "failed" }]);
  assert.equal(diagnose({ now: NOW, actions: [{ op: "update", id: "orphan", status: "failed" }] }).metrics.plannedNudges, 0);
});

test("computer blocks need two adjacent days above 50%, not two separated days", () => {
  const rows = (day, blocked = 6) => Array.from({ length: 10 }, (_, i) => ({ id: `${day}-${i}`, kind: "nudge", at: at(-day * DAY_MS), route: "computer-use", status: i < blocked ? "blocked" : "sent" }));
  const metric = (actions) => diagnose({ actions, now: NOW }).anomalies.some((a) => a.metric === "computer-use-blocked");
  assert.equal(metric([...rows(0), ...rows(1)]), true);
  assert.equal(metric([...rows(0), ...rows(2)]), false);
  assert.equal(metric([...rows(0, 5), ...rows(1)]), false);
});

test("route failures need ten sends and strictly more than twenty percent", () => {
  const rows = (n, failures) => Array.from({ length: n }, (_, i) => ({ id: String(i), at: at(), kind: "nudge", route: "codex-exec", status: i < failures ? "failed" : "sent" }));
  const anomalous = (rows) => diagnose({ now: NOW, actions: rows }).anomalies.some((a) => a.metric === "send-failure:codex-exec");
  assert.equal(anomalous(rows(9, 9)), false);
  assert.equal(anomalous(rows(10, 2)), false);
  assert.equal(anomalous(rows(10, 3)), true);
});

test("legacy executor delivery rows without kind and CLI done count as send outcomes", () => {
  const actions = Array.from({ length: 10 }, (_, i) => ({ id: `old${i}`, at: at(), route: "codex-exec", status: i < 3 ? "failed" : "done" }));
  actions.push({ id: "click", at: at(), kind: "click", route: "codex-exec", status: "failed" });
  const report = diagnose({ now: NOW, actions });
  assert.equal(report.metrics.sendsByRoute["codex-exec"].attempts, 10);
  assert.equal(report.metrics.sendsByRoute["codex-exec"].failures, 3);
  assert.ok(report.anomalies.some((a) => a.metric === "send-failure:codex-exec"));
});

test("repeats, judge waits/failures, flicker, titles, escalation and spend thresholds", () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push({ id: `j${i}`, kind: "judge", at: at(), status: "done", verdict: i < 8 ? "wait" : "send" });
  for (let i = 0; i < 3; i += 1) rows.push({ id: `jf${i}`, kind: "judge", at: at(), status: "failed" });
  for (let i = 0; i < 6; i += 1) rows.push({ id: `n${i}`, kind: "nudge", threadKey: "t", playbook: "resume", progressMark: "head1", at: at(), status: "sent", detail: "Two threads share this title" });
  rows.push({ id: "e", kind: "escalate-manager", at: at(), status: "failed" });
  const report = diagnose({ now: NOW, actions: rows, questions: [{ reopenHistory: Array(6).fill(at()) }], budget: [{ at: at(), channel: "voice", usd: 3 }, ...Array.from({ length: 7 }, (_, i) => ({ at: at(-(i + 1) * DAY_MS), channel: "voice", usd: 1 }))] });
  for (const metric of ["repeat-nudge", "judge-wait", "judge-failures", "question-flicker", "shared-title", "escalation-success", "spend:voice"]) assert.ok(report.anomalies.some((a) => a.metric === metric), metric);
  assert.equal(diagnose({ now: NOW, actions: rows.map((r, i) => ({ ...r, progressMark: String(i) })) }).metrics.repeats.length, 0);
});

test("hourly checks storage and actual sends inside owner holds; owner answers are exempt", () => {
  const actions = [
    { id: "send", at: at(-1000), kind: "nudge", status: "sent", threadKey: "t" },
    { id: "legacy", at: at(-1000), route: "codex-exec", status: "done", threadKey: "t" },
    { id: "owner", at: at(-1000), route: "codex-exec", playbook: "owner-message", status: "done", threadKey: "t" },
    { id: "answer", at: at(-1000), kind: "owner-answer", status: "owner-answer", threadKey: "t" },
    { id: "blocked", at: at(-1000), kind: "nudge", status: "blocked", threadKey: "t" }
  ];
  const report = diagnose({ now: NOW, cheap: true, actions, questions: [{ dedupeKey: "held:t:h", threadKey: "t", status: "open", createdAt: at(-5000) }], storage: { freeBytes: 4 * 1024 ** 3, actionsBytes: ACTION_LOG_MAX + 1, tmpFiles: [{ size: 0, mtimeMs: NOW - 3600001 }, { size: 1, mtimeMs: 0 }] } });
  assert.equal(report.metrics.ownerHoldViolations, 2);
  assert.equal(report.anomalies.find((a) => a.metric === "owner-hold").severity, "high");
  assert.equal(report.anomalies.length, 4);
  assert.equal(diagnose({ now: NOW, actions, questions: [{ dedupeKey: "held:t:h", threadKey: "t", createdAt: at(-5000), answeredAt: at(-2000), status: "answered" }] }).metrics.ownerHoldViolations, 0);
});

test("repeated change feedback groups a stable target regardless of key order/view", () => {
  const feedback = [
    { id: "1", at: at(), intent: "change", status: "new", utterance: "Too many asks", target: { view: "one", threadKey: "t", actionId: "a" } },
    { id: "2", at: at(), intent: "change", status: "triaged", utterance: "Again too many", target: { actionId: "a", threadKey: "t", view: "two" } }
  ];
  const report = diagnose({ now: NOW, feedback });
  assert.equal(report.anomalies.length, 1);
  assert.deepEqual(report.anomalies[0].feedbackIds, ["1", "2"]);
  assert.equal(diagnose({ now: NOW, feedback: [...feedback.slice(0, 1), { ...feedback[1], status: "fix-queued" }] }).anomalies.length, 0);
});

test("daily local 07:30 defers through quiet hours; hourly and persisted daily markers", () => {
  const time = (h, m = 0) => new Date(2026, 9, 13, h, m).getTime();
  assert.equal(diagnoseDue({}, time(7, 29), { start: 22, end: 7 }).daily, false);
  assert.equal(diagnoseDue({}, time(7, 30), { start: 22, end: 7 }).daily, true);
  assert.equal(diagnoseDue({}, time(7, 30), { start: 22, end: 8 }).daily, false);
  assert.equal(diagnoseDue({}, time(8), { start: 22, end: 8 }).daily, true);
  assert.equal(diagnoseDue({ dailyDay: "2026-10-13", hourlyAt: new Date(time(8)).toISOString() }, time(8, 5)).daily, false);
  assert.equal(diagnoseDue({ hourlyAt: new Date(time(8)).toISOString() }, time(8, 5)).hourly, false);
});

test("storage reader and rotation use the temporary dataDir, retaining folded records", (t) => {
  const dataDir = temp(t);
  const store = new FleetStore({ dir: path.join(dataDir, "fleet"), now: () => NOW });
  const rows = Array.from({ length: 160 }, (_, i) => ({ id: `a${i}`, at: at(-i), kind: "nudge", status: "planned", detail: "x".repeat(33000) }));
  rows.push({ op: "update", id: "a0", status: "failed" });
  fs.writeFileSync(store.journalPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(store.dir, "old.tmp"), "");
  fs.utimesSync(path.join(store.dir, "old.tmp"), new Date(NOW - DAY_MS), new Date(NOW - DAY_MS));
  const input = readDiagnoseInputs({ store, dataDir, now: NOW });
  assert.ok(input.storage.actionsBytes > ACTION_LOG_MAX);
  assert.equal(input.storage.tmpFiles.length, 1);
  assert.equal(store.rotateActions(), true);
  assert.ok(fs.statSync(store.journalPath).size < ACTION_LOG_MAX);
  const reloaded = new FleetStore({ dir: store.dir });
  const action = reloaded.actionHistory().find((a) => a.id === "a0");
  assert.equal(action.kind, "nudge"); assert.equal(action.status, "failed");
  assert.equal(new Set(reloaded.actionHistory().map((a) => a.id)).size, reloaded.actionHistory().length);
});

test("a journal update can recover its missing record fields from the state tail", (t) => {
  const store = new FleetStore({ dir: path.join(temp(t), "fleet"), now: () => NOW });
  const record = store.recordAction({ kind: "nudge", route: "computer-use", status: "planned" });
  fs.writeFileSync(store.journalPath, JSON.stringify({ op: "update", id: record.id, status: "failed" }) + "\n");
  const [folded] = store.actionHistory();
  assert.equal(folded.kind, "nudge"); assert.equal(folded.route, "computer-use"); assert.equal(folded.status, "failed");
});

test("supervisor daily diagnosis is once across reloads, hourly checks persist, on-demand is read-only", async (t) => {
  const dataDir = temp(t);
  let calls = 0;
  const deps = { now: () => NOW, diagnoseModels: { explain: async () => { calls += 1; return { area: "review", rootCause: "Limits", proposedFix: "Use available review model", acceptance: "Reviews complete", confidence: 0.7, minutesSavedPerDay: 5, evidenceActionIds: [] }; }, duplicate: async () => false }, notifier: { notifyQuestion: async () => ({ pushed: false }) } };
  const config = resolveFleetConfig({}, { home: dataDir, selfFix: { mode: "propose" } });
  const supervisor = new FleetSupervisor({ dataDir, config, deps });
  for (const row of october13(NOW).actions.filter((a) => a.kind === "review")) supervisor.store.recordAction(row);
  await supervisor.diagnoseTick();
  assert.equal(calls, 1); assert.equal(supervisor.suggestions().length, 1);
  assert.equal(supervisor.store.openQuestions()[0].kind, "suggestion");
  const reload = new FleetSupervisor({ dataDir, config, deps });
  await reload.diagnoseTick(); assert.equal(calls, 1);
  const before = fs.readFileSync(supervisor.store.statePath, "utf8");
  await supervisor.diagnose();
  assert.equal(fs.readFileSync(supervisor.store.statePath, "utf8"), before);
  assert.equal(calls, 2);
});

test("diagnose models share the locked-down judge, exact models, schemas and fail-closed probe", async (t) => {
  const home = temp(t);
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex/config.toml"), 'model_provider = "lb"\n[model_providers.lb]\nbase_url = "http://example.invalid"\nwire_api = "responses"\nenv_key = "CODEX_LB_API_KEY"\n');
  const calls = [];
  const run = async (_bin, args, options) => {
    if (args[0] === "features") return { code: 0, stdout: "shell_tool stable false\napps stable false" };
    if (args[0] === "mcp") return { code: 0, stdout: "[]" };
    calls.push(args);
    assert.equal(args[args.indexOf("-s") + 1], "read-only");
    assert.notEqual(options.env.HOME, home);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.HOST_BRIDGE_TOKEN, undefined);
    assert.ok(args.includes("--output-schema"));
    const out = args[args.indexOf("-m") + 1] === "gpt-6-luna" ? { duplicate: false } : { area: "review", rootCause: "Limits", proposedFix: "Retry review", acceptance: "Passes", confidence: 0.8, minutesSavedPerDay: 2, evidenceActionIds: [] };
    fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(out));
    return { code: 0, stdout: "" };
  };
  const config = resolveFleetConfig({}, { home, bins: { codex: "/bin/fake-codex" } });
  const models = createDiagnoseModels({ config, run, now: () => NOW, env: { PATH: process.env.PATH, HOME: home, OPENAI_API_KEY: "not-for-child", HOST_BRIDGE_TOKEN: "not-for-child" } });
  await models.explain({ anomalies: [{ metric: "review-failures" }] });
  assert.equal(await models.duplicate({ candidate: {} }), false);
  assert.deepEqual(calls.map((a) => a[a.indexOf("-m") + 1]), ["gpt-6.1-sol", "gpt-6-luna"]);
  const unsafe = createDiagnoseModels({ config, run: async () => ({ code: 0, stdout: "shell_tool stable true" }) });
  await assert.rejects(unsafe.explain({}), /lockdown failed/);
});
