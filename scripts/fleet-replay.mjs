import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function compareReplay(base, fix, metric) {
  const before = base.metrics[metric?.name];
  const after = fix.metrics[metric?.name];
  const moved = Number.isFinite(before) && Number.isFinite(after) && (metric.direction === "up" ? after > before : after < before);
  const groups = new Set([...Object.keys(base.playbooks), ...Object.keys(fix.playbooks)]);
  const regressions = [...groups].filter((name) => name !== metric?.playbook && ["questions", "sent"].some((key) => (fix.playbooks[name]?.[key] ?? 0) > (base.playbooks[name]?.[key] ?? 0) * 1.1));
  return { passed: moved && !regressions.length, metric: { name: metric?.name, before, after }, regressions, base, fix };
}

export function replayPair({ baseDir, fixDir, dataDir, metric, node = process.execPath, run = spawnSync }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-replay-"));
  try {
    // A frozen input shared by both runs; live files are only read here.
    const input = path.join(temp, "input");
    fs.mkdirSync(path.join(input, "fleet"), { recursive: true });
    for (const file of ["state.json", "actions.jsonl"]) {
      const source = path.join(dataDir, "fleet", file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(input, "fleet", file));
    }
    const skills = path.join(dataDir, "skills");
    if (fs.existsSync(skills)) fs.cpSync(skills, path.join(input, "skills"), { recursive: true, dereference: false });
    const read = (repo, name) => {
      const sandbox = path.join(temp, name);
      fs.cpSync(input, sandbox, { recursive: true });
      const result = run(node, [fileURLToPath(import.meta.url), "--single", repo, sandbox], { env: { PATH: process.env.PATH, HOME: sandbox, OPENAGI_DATA_DIR: sandbox }, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      if (result.status !== 0 || result.error) throw new Error("Replay failed: " + name);
      return JSON.parse(result.stdout);
    };
    return compareReplay(read(baseDir, "base"), read(fixDir, "fix"), metric);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

import { fileURLToPath } from "node:url";
export async function replaySingle(repo, dataDir) {
  const { FleetSupervisor } = await import(pathToFileURL(path.join(repo, "src/fleet/supervisor.js")));
  const { resolveFleetConfig } = await import(pathToFileURL(path.join(repo, "src/fleet/contracts.js")));
  const stateFile = path.join(dataDir, "fleet/state.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  const snapshot = state.snapshot ?? {};
  const threads = (snapshot.threads ?? []).map((row) => ({ ...row,
    id: row.id ?? row.key?.split(':').slice(1).join(':'), cwd: row.cwd ?? null,
    prRefs: row.prRefs ?? (row.pr?.ref ? [row.pr.ref] : []), meta: row.meta ?? {}, openTasks: row.openTasks ?? []
  }));
  const prs = new Map((snapshot.prs ?? threads.map((row) => row.pr).filter(Boolean)).map((pr) => [pr.ref, { ...pr, repo: pr.repo ?? pr.ref?.split('#')[0], headOid: pr.headOid ?? pr.head, number: pr.number ?? Number(pr.ref?.split('#')[1]) }]));
  const config = resolveFleetConfig({}, { home: dataDir, mode: "observe", push: null, storage: { enabled: false }, review: { enabled: false }, judge: { enabled: false } });
  const sent = [];
  const supervisor = new FleetSupervisor({ dataDir, config, forceMode: "observe", deps: {
    now: () => Date.parse(snapshot.at ?? state.fixes?.[0]?.createdAt ?? "2026-01-01T12:00:00Z"),
    listCodexThreads: async () => threads.filter((row) => row.kind === "codex"),
    listClaudeThreads: async () => threads.filter((row) => row.kind === "claude"),
    listConductorThreads: async () => threads.filter((row) => row.kind === "conductor"),
    readLivePeers: () => new Map(), readCodexLbErrors: () => [], findLocalHeavyVerification: async () => [],
    probeBuildBot3: async () => snapshot.infra?.bb3 ?? null, checkLb: async () => snapshot.infra?.lb ?? null,
    findManagerSession: () => null, findPrForBranch: async () => null,
    readLocalGit: async (cwd) => snapshot.localGit?.[cwd] ?? { branch: threads.find((row) => row.cwd === cwd)?.branch, dirty: false },
    fetchPrStates: async () => prs, fetchPrStateLite: async () => prs,
    run: async () => { throw new Error("External commands disabled in replay."); },
    executor: { deliver: async (args) => { sent.push(args); return { status: "dry-run" }; }, inFlight: () => [], whenIdle: async () => {} },
    notifier: { notifyQuestion: async () => ({ pushed: false }) }, uiDriver: null
  } });
  try {
    await supervisor.tick({ reason: "replay" });
    const result = supervisor.getState();
    const questions = result.questions;
    const rows = result.snapshot?.threads ?? [];
    const actions = supervisor.store.actions(10000);
    // Observe records send plans rather than calling the delivery adapter.
    sent.push(...actions.filter((action) => action.kind === "nudge" && action.status === "planned"));
    const playbooks = {};
    for (const question of questions) { const group = playbooks[question.playbook ?? question.kind] ??= { questions: 0, sent: 0 }; group.questions++; }
    for (const action of sent) { const group = playbooks[action.playbook] ??= { questions: 0, sent: 0 }; group.sent++; }
    const metrics = { questions: questions.length, sent: sent.length, blocked: rows.filter((row) => row.state === "infra-blocked").length,
      rows: rows.length, failed: actions.filter((row) => row.status === "failed").length,
      repeats: actions.length - new Set(actions.map((row) => [row.threadKey, row.playbook, row.head].join(":"))).size,
      unanswered: questions.filter((row) => !row.answer).length, judgeWait: actions.filter((row) => row.kind === "judge" && row.verdict === "wait").length };
    return { rows, questions, sent, metrics, playbooks };
  } finally { supervisor.stop(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--single") console.log(JSON.stringify(await replaySingle(process.argv[3], process.argv[4])));
  else {
    const [baseDir, fixDir, dataDir, name, direction = "down"] = process.argv.slice(2);
    if (!baseDir || !fixDir || !dataDir || !name) throw new Error("Usage: fleet-replay.mjs BASE FIX DATA_DIR METRIC [up|down]");
    const result = replayPair({ baseDir, fixDir, dataDir, metric: { name, direction } });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
}
