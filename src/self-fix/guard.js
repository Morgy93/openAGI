import path from "node:path";
import { redactSecrets } from "../fleet/contracts.js";

export function keyScrubber(...secrets) {
  const forms = secrets.filter((key) => typeof key === "string" && key.length >= 8)
    .flatMap((key) => [key, Buffer.from(key).toString("base64"), Buffer.from(key).toString("base64").replace(/=+$/, ""), encodeURIComponent(key)]);
  return (text) => {
    let out = String(text ?? "");
    for (const form of forms) out = out.split(form).join("[redacted]");
    return redactSecrets(out);
  };
}

export function guardDiff({ files, diff, secrets = [] } = {}) {
  const denied = (files ?? []).filter((file) => {
    const name = String(file).replaceAll("\\", "/");
    return path.isAbsolute(name) || name.split("/").includes("..") || /(^|\/)\.openagi(\/|$)/.test(name)
      || /(^|\/)\.env[^/]*$|\.(pem|key)$/i.test(name) || /^\.github\/workflows\//.test(name)
      || /^scripts\/(install[^/]*|update\.sh)$/.test(name)
      || /(^|\/)(releases?|appcast)(\/|[.-])|(^|\/)release[^/]*\.(json|ya?ml|xml)$/i.test(name);
  });
  if (denied.length) throw new Error("Guard blocked protected files: " + denied.join(", "));
  if ((files ?? []).includes("package.json") && /^[+-](?![+-]).*"version"\s*:/m.test(diff ?? "")) throw new Error("Guard blocked package version change.");
  if (/(?:sk-|ek_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/.test(diff ?? "") || keyScrubber(...secrets)(diff) !== redactSecrets(diff)) throw new Error("Guard blocked a secret in the diff.");
  return true;
}
