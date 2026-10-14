import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULTS, SUPERVISOR_PREFIX, resolveFleetConfig } from "../src/fleet/contracts.js";
import { decodeStep, findLanguageServer, listAntigravityThreads, quotaResetFor } from "../src/fleet/sources/antigravity.js";
import { classifyThread } from "../src/fleet/classify.js";

const NOW = Date.parse("2026-10-14T06:00:00.000Z");
const MIN = 60_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// conversation_summaries stores Go times: "2026-10-14 05:50:00.123456+00:00".
const goTime = (msAgo) => `${iso(msAgo).replace("T", " ").replace("Z", "")}000+00:00`;
const GO_ZERO = "0001-01-01 00:00:00+00:00";

// ---------- protobuf wire encoding, as the language server writes steps ----------

function varint(value) {
  const out = [];
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return Buffer.from(out);
}

function field(number, value) {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

const msg = (...parts) => Buffer.concat(parts);
const stamp = (at) => {
  const ms = Date.parse(at);
  return msg(field(1, Math.floor(ms / 1000)), field(2, (ms % 1000) * 1e6));
};
// f1 type, f4 status, f5 metadata (5.1 created, 5.3 source).
const head = (type, status, at, source) => msg(field(1, type), field(4, status), field(5, msg(field(1, stamp(at)), field(3, source))));

const QUOTA_TEXT = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37m19s.";
const quotaDetails = (resetIso) => JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [
  { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", metadata: { model: "gemini-4-argon-high", quotaResetTimeStamp: resetIso } }
] } }, null, 2);

const step = {
  user: (text, at) => msg(head(14, 3, at, 4), field(19, msg(field(2, text), field(3, msg(field(1, text)))))),
  reply: (text, at) => msg(head(15, 3, at, 2), field(20, msg(field(1, text), field(8, text), field(12, 2)))),
  tool: (status, at) => msg(head(132, status, at, 2)),
  system: (content, at, sender = "system") => msg(head(101, 3, at, 5),
    field(114, msg(field(1, `[Message] timestamp=${at} sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}`), field(2, msg(field(1, "Message from System")))))),
  error: (shown, details, at) => msg(head(17, 3, at, 5),
    field(24, msg(field(3, msg(field(1, shown), field(2, `RESOURCE_EXHAUSTED (code 429): ${shown}`), field(5, details), field(7, 429)))))),
  // A truncated blob (substr cut, or a malformed write) never throws.
  cut: (at) => msg(head(15, 3, at, 2), Buffer.from([0xa2, 0x01, 0x40, 0x0a]))
};

// ---------- fixture databases (real table and column names) ----------

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-antigravity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const dataDir = (home) => path.join(home, ".gemini", "antigravity");

function writeSummaries(home, rows) {
  const dir = dataDir(home);
  fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
    step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, status text NOT NULL DEFAULT "",
    source text NOT NULL DEFAULT "", project_id text NOT NULL DEFAULT "", agent_name text NOT NULL DEFAULT "", parent_conversation_id text NOT NULL DEFAULT "",
    nesting_depth integer NOT NULL DEFAULT 0, not_fully_idle numeric NOT NULL DEFAULT false, killed numeric NOT NULL DEFAULT false,
    last_user_input_time datetime NOT NULL, last_user_input_step_index integer NOT NULL DEFAULT -1, raw_summary blob, group_id text NOT NULL DEFAULT "",
    PRIMARY KEY (conversation_id))`);
  const insert = db.prepare(`INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, workspace_uris, status,
    project_id, agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_user_input_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.id, row.title ?? "", row.steps ?? 1, row.modified ?? goTime(5 * MIN), row.workspaces ?? JSON.stringify(["file:///work/app"]),
      row.status ?? "CASCADE_RUN_STATUS_IDLE", row.projectId ?? "proj-1", row.agentName ?? "", row.parent ?? "", row.depth ?? 0,
      row.notFullyIdle ? 1 : 0, row.killed ? 1 : 0, row.userInput ?? GO_ZERO);
  }
  db.close();
}

function writeSteps(home, id, payloads) {
  const db = new DatabaseSync(path.join(dataDir(home), "conversations", `${id}.db`));
  db.exec(`CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false,
    metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))`);
  const insert = db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)");
  // step_type 132 (GENERIC) stands for many tool steps; the payload has the real type.
  payloads.forEach((payload, idx) => insert.run(idx, 132, 3, payload));
  db.close();
}

function config(home, overrides = {}) {
  return resolveFleetConfig({}, { home, limits: { ...DEFAULTS }, ...overrides });
}

const list = (home, options = {}, overrides = {}) => listAntigravityThreads(config(home, overrides), { now: NOW, languageServer: null, ...options });

// ---------- tests ----------

test("no Antigravity data dir, or the toggle off, is an empty list", async (t) => {
  const home = makeHome(t);
  assert.deepEqual(await list(home), []);
  writeSummaries(home, [{ id: "c1" }]);
  assert.equal((await list(home)).length, 1);
  assert.deepEqual(await list(home, {}, { antigravity: { enabled: false } }), []);
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_ANTIGRAVITY: "0" }, { home }).antigravity.enabled, false);
  assert.equal(resolveFleetConfig({}, { home }).antigravity.enabled, true);
  assert.equal(resolveFleetConfig({}, { home }).paths.antigravityHome, dataDir(home));
});

test("maps a conversation to the fleet thread shape", async (t) => {
  const home = makeHome(t);
  const id = "7a962056-4c27-48e0-82f4-c22ee00ff45b";
  writeSummaries(home, [
    { id, title: "Data Room Setup", workspaces: JSON.stringify(["file:///Users/me/Dev/revops"]), modified: goTime(4 * MIN), userInput: goTime(20 * MIN), projectId: "p-9" },
    // Subagents run under a parent and are reached through it.
    { id: "sub-1", agentName: "research", parent: id, depth: 1 },
    { id: "sub-2", agentName: "self", depth: 1 },
    // Past the lookback.
    { id: "old-1", modified: goTime(72 * 60 * MIN) },
    // No workspace folder (agentapi's outside-of-project).
    { id: "loose-1", workspaces: "" }
  ]);
  writeSteps(home, id, [
    step.user("get this pushed to vercel", iso(20 * MIN)),
    step.reply("On it.", iso(19 * MIN)),
    step.tool(3, iso(18 * MIN)),
    step.reply(`Deployed. Use curl -H "Authorization: Bearer kV3BVG-MkBIKhIt_8UWQkQ" to read it. ${"x".repeat(900)} Done: https://app.example`, iso(5 * MIN)),
    step.tool(3, iso(4 * MIN))
  ]);
  const threads = await list(home);
  assert.deepEqual(threads.map((thread) => thread.id).sort(), [id, "loose-1"].sort());
  const thread = threads.find((entry) => entry.id === id);
  assert.equal(thread.key, `antigravity:${id}`);
  assert.equal(thread.kind, "antigravity");
  assert.equal(thread.title, "Data Room Setup");
  assert.equal(thread.cwd, "/Users/me/Dev/revops");
  assert.equal(thread.repo, null);
  assert.equal(thread.agentStatus, "idle");
  assert.equal(thread.error, null);
  assert.equal(thread.excluded, null);
  assert.equal(thread.lastActivityAt, iso(4 * MIN));
  assert.equal(thread.lastAgentAt, iso(5 * MIN));
  // The end of the last reply, redacted and clamped like other sources.
  assert.ok(thread.lastAgentText.length <= DEFAULTS.excerptMax);
  assert.match(thread.lastAgentText, /Done: https:\/\/app\.example$/);
  assert.doesNotMatch(thread.lastAgentFull, /kV3BVG/);
  assert.equal(thread.lastUserText, "get this pushed to vercel");
  assert.equal(thread.lastUserAt, iso(20 * MIN));
  assert.equal(thread.live, null);
  assert.equal(thread.meta.app, "antigravity");
  assert.equal(thread.meta.projectId, "p-9");
  assert.deepEqual(thread.meta.openChat, { app: "antigravity", url: null, label: "Data Room Setup (Antigravity)", note: "Antigravity has no link to one conversation: open the app and pick it in the sidebar." });
  const loose = threads.find((entry) => entry.id === "loose-1");
  assert.equal(loose.excluded, "no-repo");
  assert.equal(loose.title, "Antigravity conversation");
  assert.equal(loose.lastUserAt, null, "Go's zero time is no owner message");
});

test("a quota error that ended the run is a usage limit with the exact reset", async (t) => {
  const home = makeHome(t);
  writeSummaries(home, [{ id: "q1", modified: goTime(10 * MIN) }, { id: "q2", modified: goTime(10 * MIN) }]);
  const reset = "2026-10-14T06:15:03Z";
  writeSteps(home, "q1", [step.user("build it", iso(40 * MIN)), step.reply("Working.", iso(39 * MIN)), step.error(QUOTA_TEXT, quotaDetails(reset), iso(10 * MIN))]);
  // The owner wrote after the error: it no longer stands.
  writeSteps(home, "q2", [step.error(QUOTA_TEXT, quotaDetails(reset), iso(30 * MIN)), step.user("try again", iso(12 * MIN)), step.reply("Done.", iso(10 * MIN))]);
  const threads = await list(home);
  const limited = threads.find((thread) => thread.id === "q1");
  assert.equal(limited.agentStatus, "error");
  assert.deepEqual(limited.error, { kind: "usage-limit", text: QUOTA_TEXT, resetAt: "2026-10-14T06:15:03.000Z" });
  assert.equal(limited.meta.model, "gemini-4-argon-high");
  assert.equal(limited.meta.resetFrom, "error");
  assert.equal(limited.lastAgentText, "Working.");
  const moved = threads.find((thread) => thread.id === "q2");
  assert.equal(moved.agentStatus, "idle");
  assert.equal(moved.error, null);
  // classify sends a limit to infra-blocked whatever the status.
  const classified = classifyThread({ ...limited, repo: "acme/app", branch: "spencer/x" }, { now: NOW, config: config(home) });
  assert.equal(classified.state, "infra-blocked");
  assert.equal(classified.infraKind, "usage-limit");
});

test("run status, background work, approvals and the owner's stop", async (t) => {
  const home = makeHome(t);
  writeSummaries(home, [
    { id: "run", status: "CASCADE_RUN_STATUS_RUNNING", modified: goTime(2 * MIN) },
    { id: "bg", notFullyIdle: true, modified: goTime(3 * MIN) },
    { id: "hung", status: "CASCADE_RUN_STATUS_RUNNING", modified: goTime(90 * MIN) },
    { id: "ask", modified: goTime(2 * MIN) },
    { id: "gen", modified: goTime(1 * MIN) },
    { id: "kill", killed: true, modified: goTime(2 * MIN) },
    { id: "cut", modified: goTime(2 * MIN) }
  ]);
  for (const id of ["run", "bg", "hung", "kill"]) writeSteps(home, id, [step.reply("Going.", iso(95 * MIN))]);
  // A tool step waiting on the owner's approval after the reply that asked for it.
  writeSteps(home, "ask", [step.reply("I need to run the migration.", iso(3 * MIN)), step.tool(9, iso(2 * MIN))]);
  writeSteps(home, "gen", [step.user("go", iso(2 * MIN)), step.tool(8, iso(1 * MIN))]);
  writeSteps(home, "cut", [step.reply("Earlier.", iso(5 * MIN)), step.cut(iso(2 * MIN))]);
  const byId = new Map((await list(home)).map((thread) => [thread.id, thread]));
  assert.equal(byId.get("run").agentStatus, "running");
  assert.equal(byId.get("bg").agentStatus, "running");
  assert.equal(byId.get("bg").meta.notFullyIdle, true);
  // Busy with no step for longer than the silent window: the server died mid-run.
  assert.equal(byId.get("hung").agentStatus, "stalled");
  assert.equal(byId.get("ask").agentStatus, "waiting");
  assert.equal(byId.get("ask").meta.blockedOnOwner, true);
  assert.equal(byId.get("gen").agentStatus, "running");
  assert.equal(byId.get("kill").agentStatus, "aborted");
  assert.equal(byId.get("kill").meta.abortReason, "aborted by user");
  assert.equal(byId.get("cut").agentStatus, "idle");
  assert.equal(byId.get("cut").lastAgentText, "Earlier.");
});

test("supervisor messages delivered by agentapi are marked, not owner text", async (t) => {
  const home = makeHome(t);
  writeSummaries(home, [{ id: "s1", modified: goTime(1 * MIN), userInput: goTime(30 * MIN) }]);
  writeSteps(home, "s1", [
    step.user("fix the build", iso(30 * MIN)),
    step.reply("Stopped on the quota.", iso(29 * MIN)),
    step.system(`${SUPERVISOR_PREFIX} The quota reset; continue.`, iso(2 * MIN)),
    step.system("Task id finished", iso(1.5 * MIN), "s1/task-3"),
    step.reply("Continuing.", iso(1 * MIN))
  ]);
  const [thread] = await list(home);
  assert.equal(thread.meta.lastSupervisorAt, iso(2 * MIN));
  assert.equal(thread.lastUserText, "fix the build");
  assert.equal(thread.lastUserAt, iso(30 * MIN));
  assert.equal(thread.lastAgentText, "Continuing.");
});

test("decodeStep reads the real field layout", () => {
  const at = iso(1 * MIN);
  const reply = decodeStep({ idx: 4, payload: step.reply("PONG", at) });
  assert.deepEqual({ type: reply.type, status: reply.status, at: reply.at, text: reply.text }, { type: 15, status: 3, at, text: "PONG" });
  const error = decodeStep({ payload: step.error(QUOTA_TEXT, quotaDetails("2026-10-14T06:15:03Z"), at) });
  assert.equal(error.type, 17);
  assert.equal(error.error.text, QUOTA_TEXT);
  assert.equal(error.error.model, "gemini-4-argon-high");
  assert.equal(decodeStep({ payload: Buffer.from([0xff, 0xff]), step_type: 21, status: 3 }).type, 21);
});

test("the language server's quota sets the reset: spent family waits, refilled family resumes", async (t) => {
  const home = makeHome(t);
  writeSummaries(home, [{ id: "q1", modified: goTime(10 * MIN) }]);
  // No reset in the error: only the quota can tell.
  writeSteps(home, "q1", [step.reply("Working.", iso(39 * MIN)), step.error("You have exhausted your quota on this model.", '{"metadata":{"model":"gemini-4-argon-high"}}', iso(10 * MIN))]);
  const calls = [];
  const status = (geminiFraction) => ({
    userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { label: "Gemini 4 Argon (High)", modelOrAlias: { model: "MODEL_PLACEHOLDER_M417" }, quotaInfo: { ...(geminiFraction ? { remainingFraction: geminiFraction } : {}), resetTime: "2026-10-14T07:04:08Z" } },
      { label: "Gemini 3.8 Flash (Low)", quotaInfo: { ...(geminiFraction ? { remainingFraction: geminiFraction } : {}), resetTime: "2026-10-14T07:04:08Z" } },
      { label: "Claude Opus 5.5 (High)", quotaInfo: { remainingFraction: 1, resetTime: "2026-10-14T11:01:02Z" } }
    ] } }
  });
  let fraction = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, token: init.headers["x-codeium-csrf-token"], body: init.body });
    return { ok: true, status: 200, json: async () => status(fraction) };
  };
  const server = { pid: 7, address: "127.0.0.1:50489" };
  Object.defineProperty(server, "csrfToken", { value: "test-token", enumerable: false });
  const spent = (await list(home, { languageServer: server, fetchImpl }))[0];
  assert.equal(spent.error.kind, "usage-limit");
  assert.equal(spent.error.resetAt, "2026-10-14T07:04:08.000Z");
  assert.equal(spent.meta.resetFrom, "quota");
  assert.equal(calls[0].url, "http://127.0.0.1:50489/exa.language_server_pb.LanguageServerService/GetUserStatus");
  assert.equal(calls[0].token, "test-token");
  fraction = 0.72;
  const refilled = (await list(home, { languageServer: server, fetchImpl }))[0];
  assert.ok(Date.parse(refilled.error.resetAt) <= NOW, "quota back: the reset has passed");
  // An unreadable server leaves the error's own reset (none here).
  const offline = (await list(home, { languageServer: null, fetchImpl }))[0];
  assert.equal(offline.error.resetAt, null);
  // A quota read never runs when no thread is limited.
  assert.equal(quotaResetFor({ error: { kind: "overloaded" }, meta: {} }, [{ family: "gemini", remaining: 0 }]), null);
});

test("findLanguageServer reads the pid and token from ps, the RPC port from lsof, and hides the token", async () => {
  const bin = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith("ps")) {
      return { code: 0, stdout: [
        "  101 /Applications/Antigravity IDE.app/Contents/Resources/bin/language_server --csrf_token other",
        `  202 ${bin}x --csrf_token wrong`,
        `  303 ${bin} --standalone --subclient_type hub --https_server_port 0 --csrf_token sekret-123 --host_bridge_token hb-9`
      ].join("\n") };
    }
    return { code: 0, stdout: "p303\nf7\nn127.0.0.1:50488\nf8\nn127.0.0.1:50489\n" };
  };
  const fetchImpl = async (url) => ({ status: url === "http://127.0.0.1:50489/healthz" ? 200 : 400 });
  const server = await findLanguageServer(resolveFleetConfig({}, { home: "/home/fixture", bins: { ps: "/bin/ps", lsof: "/usr/sbin/lsof" } }), { run, fetchImpl });
  assert.equal(server.pid, 303);
  assert.equal(server.address, "127.0.0.1:50489");
  assert.equal(server.csrfToken, "sekret-123");
  assert.doesNotMatch(JSON.stringify(server), /sekret/);
  assert.deepEqual(calls[1], ["/usr/sbin/lsof", "-nP", "-a", "-p", "303", "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  // Not running: null.
  assert.equal(await findLanguageServer(resolveFleetConfig({}, { home: "/home/fixture" }), { run: async () => ({ code: 0, stdout: "" }), fetchImpl }), null);
});

test("a send-time re-read takes one conversation whatever its age", async (t) => {
  const home = makeHome(t);
  writeSummaries(home, [{ id: "old-1", modified: goTime(72 * 60 * MIN) }, { id: "new-1" }]);
  const threads = await list(home, { only: ["old-1"] });
  assert.deepEqual(threads.map((thread) => thread.id), ["old-1"]);
});

test("reads rows still in the WAL of a database the app holds open, and never creates its -wal or -shm", async (t) => {
  const home = makeHome(t);
  writeSummaries(home, [{ id: "c1" }]);
  const file = path.join(dataDir(home), "conversation_summaries.db");
  const setup = new DatabaseSync(file);
  setup.exec("PRAGMA journal_mode=WAL");
  setup.close();
  const sidecars = () => ["-wal", "-shm"].filter((suffix) => fs.existsSync(`${file}${suffix}`));
  assert.deepEqual(sidecars(), []);
  // Closed by the app: an immutable snapshot, and nothing appears beside it.
  assert.deepEqual((await list(home)).map((thread) => thread.id), ["c1"]);
  assert.deepEqual(sidecars(), []);
  // Open in the app with a row not yet checkpointed: the read-only handle sees it.
  const app = new DatabaseSync(file);
  t.after(() => { try { app.close(); } catch { /* closed */ } });
  app.exec("PRAGMA wal_autocheckpoint=0");
  app.prepare(`INSERT INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, last_user_input_time)
    VALUES ('c2', 'fresh', ?, '["file:///work/app"]', ?)`).run(goTime(1 * MIN), GO_ZERO);
  assert.deepEqual(sidecars(), ["-wal", "-shm"]);
  assert.deepEqual((await list(home)).map((thread) => thread.id).sort(), ["c1", "c2"]);
});
