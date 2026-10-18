import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { keyScrubber } from "./guard.js";
import { fleetChildEnv } from "../fleet/executor.js";

export const REPO = "Spshulem/openAGI";
export const TOKEN_CARD = "Create a fine-grained token: GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token. Resource owner: Spshulem. Repository access: Only select repositories > openAGI. Repository permissions: Contents: Read and write; Pull requests: Read and write; Metadata: Read. Protect main with required owner review. Save it on the Mac as ~/.openagi/self-fix-gh-token with chmod 600, or set OPENAGI_SELF_FIX_GH_TOKEN. Never use the owner's gh login. The owner merges.";

export function readGitHubToken({ env = process.env, home = os.homedir() } = {}) {
  if (env.OPENAGI_SELF_FIX_GH_TOKEN?.trim()) return env.OPENAGI_SELF_FIX_GH_TOKEN.trim();
  const file = path.join(home, ".openagi", "self-fix-gh-token");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe token file");
    const token = fs.readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch { /* fail closed */ }
  throw Object.assign(new Error("Dedicated self-fix GitHub token missing or not owner-only (0600)."), { code: "SELF_FIX_TOKEN" });
}

export function createFixGitHub({ run, token, configDir, env = process.env }) {
  if (!token || !configDir) throw new Error("Dedicated GitHub credentials required.");
  const childEnv = { ...fleetChildEnv(env), GH_TOKEN: token, GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", SELF_FIX_GIT_TOKEN: token };
  const gitArgs = ["-c", "core.hooksPath=/dev/null", "-c", "push.followTags=false", "-c", "credential.helper=", "-c", "credential.helper=!f() { printf 'username=x-access-token\\npassword=%s\\n' \"$SELF_FIX_GIT_TOKEN\"; }; f"];
  const scrub = keyScrubber(token);
  const gh = async (args) => {
    try { return (await run("gh", args, { env: childEnv })).stdout.trim(); }
    catch (error) { throw new Error(scrub(error.message)); }
  };
  return {
    auth: () => gh(["auth", "status", "--hostname", "github.com"]),
    git: (args, options = {}) => run("git", [...gitArgs, ...args], { ...options, env: childEnv }),
    async push(cwd, branch, expectedHead = null) {
      if (!/^selffix\/[A-Za-z0-9_-]+$/.test(branch)) throw new Error("Invalid fix branch.");
      const result = await run("git", [...gitArgs, "ls-remote", "origin", "refs/heads/" + branch], { cwd, env: childEnv });
      const remoteHead = result.stdout.trim().split(/\s+/)[0] || null;
      if (remoteHead !== expectedHead) throw new Error("Remote head changed; refusing push.");
      if (remoteHead) await run("git", ["merge-base", "--is-ancestor", remoteHead, "HEAD"], { cwd });
      await run("git", [...gitArgs, "push", "-u", "origin", "HEAD:refs/heads/" + branch], { cwd, env: childEnv });
      return (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    },
    async create(fix, bodyFile) {
      const url = await gh(["pr", "create", "--repo", REPO, "--base", "main", "--head", fix.branch, "--title", "Self-fix: " + fix.title, "--label", "self-fix", "--body-file", bodyFile]);
      const match = /^https:\/\/github\.com\/Spshulem\/openAGI\/pull\/(\d+)$/i.exec(url);
      if (!match) throw new Error("Invalid self-fix PR response.");
      return { prUrl: url, prNumber: Number(match[1]), prRef: REPO + "#" + match[1] };
    },
    reviews: (number) => Promise.all([gh(["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${number}/reviews`]), gh(["api", "--paginate", "--slurp", `repos/${REPO}/pulls/${number}/comments`])]).then((parts) => parts.flatMap((part) => JSON.parse(part).flat())),
    state: (number) => gh(["pr", "view", String(number), "--repo", REPO, "--json", "state,headRefOid"]).then(JSON.parse),
    close: (number) => gh(["pr", "close", String(number), "--repo", REPO])
  };
}
