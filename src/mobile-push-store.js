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
// `activity` ({ startedAt } or null) is the Live Activity this daemon started
// on the phone, persisted for the same reason: after a restart the next change
// updates it instead of starting a second one. `activities: false` means the
// phone takes alerts only (no Live Activity token, or the relay said so).
export const PUSH_PASS_MAX = 2000;
export const PUSH_ENVS = Object.freeze(["sandbox", "production"]);

const FILE_VERSION = 1;
const NOTIFIED_MAX = 200;

/// Check a phone's POST /mobile/push body. Returns { ok: true, value } or
/// { ok: false, error }, never throws.
export function validatePushRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const { pass, key, env, activities } = body;
  if (typeof pass !== "string" || !pass.startsWith("p1.") || pass.length > PUSH_PASS_MAX) {
    return { ok: false, error: `pass must start with "p1." and be at most ${PUSH_PASS_MAX} chars` };
  }
  if (!decodePushKey(key)) return { ok: false, error: "key must be base64url of exactly 32 bytes" };
  if (!PUSH_ENVS.includes(env)) return { ok: false, error: `env must be one of ${PUSH_ENVS.join(", ")}` };
  if (activities !== undefined && typeof activities !== "boolean") return { ok: false, error: "activities must be a boolean" };
  return { ok: true, value: { pass, key, env, activities: activities !== false } };
}

const copy = (record) => ({ ...record, notified: [...record.notified], activity: record.activity ? { ...record.activity } : null });

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
        notified: Array.isArray(record.notified) ? record.notified.filter((id) => typeof id === "string") : [],
        activities: record.activities !== false,
        noLiveActivity: record.noLiveActivity === true,
        activity: Number.isFinite(Date.parse(record.activity?.startedAt ?? "")) ? { startedAt: record.activity.startedAt } : null
      });
    }
  }

  list() {
    return [...this.records.values()].map(copy);
  }

  get(nodeId) {
    const record = this.records.get(nodeId);
    return record ? copy(record) : null;
  }

  /// Replace this node's registration. The phone re-POSTs on every refresh:
  /// the same pass keeps its activity state, a new pass is a new push-to-start
  /// token whose activity is not ours to update. The notified ids carry over
  /// either way: it is the same phone, which already saw those alerts.
  put(nodeId, { pass, key, env, activities = true }) {
    const prior = this.records.get(nodeId);
    const samePass = prior?.pass === pass;
    const record = {
      nodeId, pass, key, env,
      updatedAt: this.now().toISOString(),
      notified: prior?.notified ?? [],
      activities: activities !== false,
      // The relay's "no_live_activity" belongs to the pass, not the request.
      noLiveActivity: samePass ? prior.noLiveActivity === true : false,
      activity: samePass ? prior.activity ?? null : null
    };
    this.records.set(nodeId, record);
    this.save();
    return copy(record);
  }

  setActivity(nodeId, activity) {
    const record = this.records.get(nodeId);
    if (!record || (record.activity?.startedAt ?? null) === (activity?.startedAt ?? null)) return;
    record.activity = activity ? { startedAt: activity.startedAt } : null;
    this.save();
  }

  /// The relay has no Live Activity channel for this pass: alerts only.
  markNoLiveActivity(nodeId) {
    const record = this.records.get(nodeId);
    if (!record || (record.noLiveActivity && !record.activity)) return;
    record.noLiveActivity = true;
    record.activity = null;
    this.save();
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
