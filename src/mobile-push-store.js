import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { decodePushKey } from "./mobile-push-envelope.js";

// One push registration per paired phone, in <dataDir>/nodes/push.json
// (0600, beside the node registry it hangs off). A record holds the relay
// pass (opaque to us, sealed by the relay), the phone's envelope key, and
// the APNs environment. The key is what keeps the relay blind, so this file
// is as private as the node credentials next to it.
//
// `notified` is the question ids already alerted to this phone. It lives here,
// not in memory, so a daemon restart does not ping the owner a second time.
export const PUSH_PASS_MAX = 2000;
export const PUSH_ENVS = Object.freeze(["sandbox", "production"]);

const FILE_VERSION = 1;
const NOTIFIED_MAX = 200;

/// Check a phone's POST /mobile/push body. Returns { ok: true, value } or
/// { ok: false, error }, never throws.
export function validatePushRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const { pass, key, env } = body;
  if (typeof pass !== "string" || !pass.startsWith("p1.") || pass.length > PUSH_PASS_MAX) {
    return { ok: false, error: `pass must start with "p1." and be at most ${PUSH_PASS_MAX} chars` };
  }
  if (!decodePushKey(key)) return { ok: false, error: "key must be base64url of exactly 32 bytes" };
  if (!PUSH_ENVS.includes(env)) return { ok: false, error: `env must be one of ${PUSH_ENVS.join(", ")}` };
  return { ok: true, value: { pass, key, env } };
}

export class MobilePushStore {
  constructor({ dir, now = () => new Date() } = {}) {
    this.file = path.join(dir, "push.json");
    this.now = now;
    const saved = readJsonFile(this.file, null);
    this.records = new Map();
    for (const record of Array.isArray(saved?.registrations) ? saved.registrations : []) {
      if (typeof record?.nodeId !== "string" || !record.nodeId) continue;
      if (!validatePushRegistration(record).ok) continue;
      this.records.set(record.nodeId, {
        nodeId: record.nodeId,
        pass: record.pass,
        key: record.key,
        env: record.env,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
        notified: Array.isArray(record.notified) ? record.notified.filter((id) => typeof id === "string") : []
      });
    }
  }

  list() {
    return [...this.records.values()].map((record) => ({ ...record, notified: [...record.notified] }));
  }

  get(nodeId) {
    const record = this.records.get(nodeId);
    return record ? { ...record, notified: [...record.notified] } : null;
  }

  /// Replace this node's registration. The notified ids carry over: a token
  /// rotation is the same phone, which already saw those alerts.
  put(nodeId, { pass, key, env }) {
    const prior = this.records.get(nodeId);
    const record = { nodeId, pass, key, env, updatedAt: this.now().toISOString(), notified: prior?.notified ?? [] };
    this.records.set(nodeId, record);
    this.save();
    return { ...record, notified: [...record.notified] };
  }

  remove(nodeId) {
    if (!this.records.delete(nodeId)) return false;
    this.save();
    return true;
  }

  setNotified(nodeId, ids) {
    const record = this.records.get(nodeId);
    if (!record) return;
    const next = [...new Set(ids)].slice(-NOTIFIED_MAX);
    if (next.length === record.notified.length && next.every((id, i) => id === record.notified[i])) return;
    record.notified = next;
    this.save();
  }

  save() {
    writeJsonAtomic(this.file, { version: FILE_VERSION, registrations: [...this.records.values()] });
  }
}
