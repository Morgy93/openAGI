#!/usr/bin/env node
// Diagnose a disposable copy. Never open or write the owner's live store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";

const source = path.join(os.homedir(), ".openagi");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-diagnose-copy-"));
try {
  fs.mkdirSync(path.join(dataDir, "fleet"));
  for (const name of ["state.json", "actions.jsonl"]) fs.copyFileSync(path.join(source, "fleet", name), path.join(dataDir, "fleet", name));
  if (fs.existsSync(path.join(source, "budget/ledger.jsonl"))) {
    fs.mkdirSync(path.join(dataDir, "budget"));
    fs.copyFileSync(path.join(source, "budget/ledger.jsonl"), path.join(dataDir, "budget/ledger.jsonl"));
  }
  const config = resolveFleetConfig(process.env, { selfFix: { mode: "propose" } });
  const supervisor = new FleetSupervisor({ dataDir, config, forceMode: "observe" });
  const report = await supervisor.diagnose({ window: "7d" });
  // Health errors can contain owner transcript text. Print only their presence.
  report.metrics.health = { lastError: Boolean(report.metrics.health.lastError),
    failedSources: Object.keys(report.metrics.health.sourceErrors),
    infraBlocked: Object.keys(report.metrics.health.infraBlocked), uiBlocked: Object.keys(report.metrics.health.uiBlocked) };
  delete report.metrics.repeats;
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.modelError) process.exitCode = 1;
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
