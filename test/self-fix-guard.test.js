import test from "node:test";
import assert from "node:assert/strict";
import { guardDiff, keyScrubber } from "../src/self-fix/guard.js";
import { readGitHubToken, createFixGitHub } from "../src/self-fix/gh.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const file of ["scripts/install.sh", "scripts/install-mac.sh", "scripts/update.sh", ".github/workflows/ci.yml", ".env.local", "config/.env", "x.pem", "x.key", "releases/v1.json", "mac/appcast.xml", ".openagi/state.json", "../live", "/tmp/live"]) {
  test("guard denies " + file, () => assert.throws(() => guardDiff({ files: [file], diff: "" }), /protected/));
}
test("guard blocks version changes, ordinary and encoded credentials; allows source repairs", () => {
  assert.throws(() => guardDiff({ files: ["package.json"], diff: '+  "version": "2"' }), /version/);
  for (const prefix of ["sk-", "ek_", "ghp_", "github_pat_"]) assert.throws(() => guardDiff({ files: ["src/x.js"], diff: "+ " + prefix + "unitfixture000000" }), /secret/);
  const secret = "unit-test-only-lb-credential";
  for (const value of [secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)]) {
    assert.throws(() => guardDiff({ files: ["src/x.js"], diff: value, secrets: [secret] }), /secret/);
    assert.equal(keyScrubber(secret)(value), "[redacted]");
  }
  assert.equal(guardDiff({ files: ["src/x.js", "package.json"], diff: '+  "description": "fixed"' }), true);
});
test("GitHub credentials never fall back to owner login and reject symlinks and loose modes", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "self-fix-token-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => readGitHubToken({ home, env: { GH_TOKEN: "owner-token" } }), /Dedicated/);
  fs.mkdirSync(path.join(home, ".openagi"));
  const file = path.join(home, ".openagi/self-fix-gh-token");
  fs.writeFileSync(file, "unit-test-only-token", { mode: 0o644 });
  assert.throws(() => readGitHubToken({ home, env: {} }));
  fs.chmodSync(file, 0o600);
  assert.equal(readGitHubToken({ home, env: {} }), "unit-test-only-token");
  fs.renameSync(file, file + ".real"); fs.symlinkSync(file + ".real", file);
  assert.throws(() => readGitHubToken({ home, env: {} }));
});
test("push compares remote head and proves ancestry; never force pushes or publishes main", async () => {
  const calls = [];
  let remote = "";
  const run = async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: args.includes("ls-remote") ? remote : args.includes("rev-parse") ? "head\n" : "" };
  };
  const gh = createFixGitHub({ run, token: "unit-fixer-token", configDir: "/tmp/isolated-gh", env: { GH_TOKEN: "owner", OPENAI_API_KEY: "owner", PATH: process.env.PATH } });
  await gh.push("/tmp/wt", "selffix/fix-one");
  remote = "old\trefs/heads/selffix/fix-one\n";
  await assert.rejects(gh.push("/tmp/wt", "selffix/fix-one", "different"), /Remote head/);
  await gh.push("/tmp/wt", "selffix/fix-one", "old");
  assert.ok(calls.some((call) => call.args.includes("--is-ancestor")));
  assert.ok(calls.every((call) => !call.args.includes("--force")));
  assert.ok(calls.filter((call) => call.args.includes("push")).every((call) => call.options.env.GH_TOKEN === "unit-fixer-token" && !call.options.env.OPENAI_API_KEY));
  await assert.rejects(gh.push("/tmp/wt", "main"), /Invalid/);
});
