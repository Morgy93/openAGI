// Deterministic fleet metrics. No disk, network, clock or model calls here.
import { STORAGE_DEFAULTS } from "./contracts.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTION_LOG_MAX = 5 * 1024 * 1024;
export const localDay = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ms = (at) => typeof at === "number" ? at : Date.parse(at ?? "");
const ratio = (a, b) => b ? a / b : 0;
const failed = (a) => a.status === "failed";
const text = (a) => `${a.reason ?? ""} ${a.detail ?? ""}`;
const automatic = (a) => ["nudge", "escalate-manager"].includes(a.kind)
  || (!a.kind && ["peer-relay", "codex-exec", "computer-use"].includes(a.route) && !/^owner-/.test(a.playbook ?? ""));

// Updates have no kind or original timestamp. Keep those from the record.
export function foldActions(lines) {
  const byId = new Map();
  for (const row of lines ?? []) {
    if (!row || typeof row.id !== "string") continue;
    const { op: _op, ...fields } = row;
    byId.set(row.id, { ...byId.get(row.id), ...fields });
  }
  return [...byId.values()];
}

export function diagnose({ actions = [], questions = [], state = {}, feedback = [], budget = [], storage = {}, now, window = "24h", area = null, cheap = false, completeDay = false } = {}) {
  const day = new Date(now);
  if (completeDay) day.setDate(day.getDate() - 1);
  const metricDay = localDay(day);
  const since = now - (window === "7d" ? 7 : 1) * DAY_MS;
  const inRange = (at, start = since) => ms(at) >= start && ms(at) <= now;
  const history = foldActions(actions).filter((a) => inRange(a.at, now - 8 * DAY_MS));
  const recent = history.filter((a) => inRange(a.at));
  const daily = history.filter((a) => localDay(a.at) === metricDay);
  const week = history.filter((a) => inRange(a.at, now - 7 * DAY_MS));
  const anomalies = [];
  const add = (metric, targetArea, events, evidence = [], { days = window === "7d" ? 7 : 1, ...extra } = {}) => {
    if (area && area !== targetArea) return;
    anomalies.push({ id: `anomaly-${anomalies.length}`, metric, area: targetArea, events, eventsPerDay: events / days,
      evidenceActionIds: evidence.map((a) => a.id).filter(Boolean).slice(-20), severity: "normal", ...extra });
  };
  const nudges = recent.filter((a) => a.kind === "nudge");
  const blocked = nudges.filter((a) => a.route === "computer-use" && a.status === "blocked");
  const metrics = {
    day: metricDay, plannedNudges: nudges.length,
    computerUseBlocked: blocked.length,
    computerUseBlockedRate: ratio(blocked.length, nudges.length),
    sendsByRoute: {}, repeats: [], questions: {}, judge: {}, review: {}, escalation: {},
    sharedTitles: 0, ownerHoldViolations: 0, spend: {}, feedback: [], storage: { ...storage },
    health: { lastError: state.lastError ?? null, lastReview: state.lastReview ?? null,
      sourceErrors: state.snapshot?.sourceErrors ?? {}, infraBlocked: state.infraBlocked ?? {}, uiBlocked: state.uiBlockedSince ?? {} }
  };

  const holds = questions.filter((q) => String(q.dedupeKey ?? "").startsWith("held:") || q.kind === "owner-hold");
  const violations = recent.filter((a) => ["sent", "done", "escalated"].includes(a.status) && automatic(a)
    && (a.ownerHold === true || holds.some((q) => q.threadKey === a.threadKey && ms(a.startedAt ?? a.at) >= ms(q.reopenedAt ?? q.liveSince ?? q.createdAt)
      && ms(a.startedAt ?? a.at) < (ms(q.answeredAt ?? q.expiredAt) || (q.status === "open" ? Infinity : 0)))));
  metrics.ownerHoldViolations = violations.length;
  if (violations.length) add("owner-hold", "policy", violations.length, violations, { severity: "high" });
  if (Number.isFinite(storage.freeBytes) && storage.freeBytes < (storage.lowGb ?? STORAGE_DEFAULTS.lowGb) * 1024 ** 3) add("storage-free", "sources", 1);
  const staleTmp = (storage.tmpFiles ?? []).filter((f) => f.size === 0 && now - ms(f.mtimeMs ?? f.mtime) > 60 * 60_000);
  if (staleTmp.length) add("storage-tmp", "sources", staleTmp.length);
  if (storage.actionsBytes > ACTION_LOG_MAX) add("storage-actions", "sources", 1);
  if (cheap) return { at: new Date(now).toISOString(), window, area, metrics, anomalies };

  const days = new Map();
  for (const a of nudges) {
    const key = localDay(a.at);
    const d = days.get(key) ?? { planned: 0, blocked: 0 };
    d.planned += 1;
    if (a.route === "computer-use" && a.status === "blocked") d.blocked += 1;
    days.set(key, d);
  }
  metrics.blockedByDay = Object.fromEntries(days);
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(now); day.setDate(day.getDate() - i);
    const previous = new Date(day); previous.setDate(previous.getDate() - 1);
    const consecutive = [days.get(localDay(day)), days.get(localDay(previous))];
    if (consecutive.every((d) => d && ratio(d.blocked, d.planned) > 0.5)) {
      add("computer-use-blocked", "ui-delivery", consecutive.reduce((n, d) => n + d.blocked, 0), blocked.filter((a) => [localDay(day), localDay(previous)].includes(localDay(a.at))));
      break;
    }
  }
  for (const route of ["peer-relay", "codex-exec", "computer-use"]) {
    // Older executor records name the route but omit kind; done is CLI success.
    const sent = recent.filter((a) => a.route === route && (!a.kind || ["nudge", "escalate-manager", "owner-message", "owner-answer"].includes(a.kind)) && ["sent", "done", "failed", "owner-answer", "escalated"].includes(a.status));
    const failures = sent.filter(failed);
    metrics.sendsByRoute[route] = { attempts: sent.length, failures: failures.length, failureRate: ratio(failures.length, sent.length), exit1: failures.filter((a) => a.exitCode === 1 || /exit\s*1\b/i.test(text(a))).length };
    if (sent.length >= 10 && failures.length / sent.length > 0.2) add(`send-failure:${route}`, "ui-delivery", failures.length, failures);
  }
  const repeats = new Map();
  for (const a of recent.filter((a) => automatic(a) && ["sent", "done"].includes(a.status))) {
    const key = JSON.stringify([localDay(a.at), a.threadKey, a.playbook, a.head ?? a.facts?.head ?? a.progressMark ?? a.factsKey ?? ""]);
    const group = repeats.get(key) ?? [];
    group.push(a); repeats.set(key, group);
  }
  for (const [key, group] of repeats) if (group.length > 3) {
    metrics.repeats.push({ key, count: group.length });
    add("repeat-nudge", "policy", group.length, group);
  }
  const asked = questions.filter((q) => inRange(q.createdAt, now - 7 * DAY_MS));
  const unanswered = asked.filter((q) => q.status !== "open" && q.status !== "answered" && !q.answer);
  const reopens = questions.flatMap((q) => q.reopenHistory ?? (q.reopenedAt ? [q.reopenedAt] : [])).filter((at) => inRange(at) && localDay(at) === metricDay);
  metrics.questions = { asked: asked.length, closedUnanswered: unanswered.length, unansweredRate: ratio(unanswered.length, asked.length), reopens: reopens.length };
  if (asked.length && unanswered.length / asked.length > 0.6) add("questions-unanswered", "policy", unanswered.length, [], { days: 7 });
  if (reopens.length > 5) add("question-flicker", "policy", reopens.length, [], { days: 1 });
  const judged = week.filter((a) => a.kind === "judge" && !failed(a));
  const waits = judged.filter((a) => a.verdict === "wait");
  const judgeFailures = daily.filter((a) => a.kind === "judge" && failed(a));
  metrics.judge = { total: judged.length, waits: waits.length, waitShare: ratio(waits.length, judged.length), failures: judgeFailures.length };
  if (judged.length && waits.length / judged.length > 0.7) add("judge-wait", "judge", waits.length, waits, { days: 7 });
  if (judgeFailures.length >= 3) add("judge-failures", "judge", judgeFailures.length, judgeFailures, { days: 1 });
  const reviews = daily.filter((a) => a.kind === "review" && failed(a));
  const limits = reviews.filter((a) => /(?:usage|rate|session|message|token|model|spending).{0,30}limit|(?:hit|reached|exceeded).{0,30}limit|quota|\b429\b/i.test(text(a)));
  metrics.review = { failures: reviews.length, modelLimitFailures: limits.length };
  if (reviews.length >= 5) add("review-failures", "review", reviews.length, reviews, { days: 1 });
  if (limits.length) add("review-model-limits", "review", limits.length, limits, { days: 1 });
  // Observe/propose plans and unsent (stale, dry-run) records never tried a delivery.
  const escalations = recent.filter((a) => a.kind === "escalate-manager" && !["planned", "proposed", "stale", "dry-run"].includes(a.status));
  const succeeded = escalations.filter((a) => ["sent", "escalated", "done"].includes(a.status));
  metrics.escalation = { attempts: escalations.length, succeeded: succeeded.length, successRate: ratio(succeeded.length, escalations.length) };
  if (escalations.length && succeeded.length / escalations.length < 0.5) add("escalation-success", "policy", escalations.length - succeeded.length, escalations.filter((a) => !succeeded.includes(a)));
  const titles = daily.filter((a) => /two threads share this title/i.test(text(a)));
  metrics.sharedTitles = titles.length;
  if (titles.length > 5) add("shared-title", "classify", titles.length, titles, { days: 1 });
  for (const channel of ["autopilot", "voice", "self-fix"]) {
    const totals = new Map();
    const baseline = new Date(day); baseline.setDate(baseline.getDate() - 7); baseline.setHours(0, 0, 0, 0);
    for (const row of budget.filter((r) => r.channel === channel && inRange(r.at, baseline.getTime()))) {
      const key = localDay(row.at);
      const usd = Number(row.usd);
      if (Number.isFinite(usd) && usd >= 0) totals.set(key, (totals.get(key) ?? 0) + usd);
    }
    const prior = [];
    for (let i = 1; i <= 7; i += 1) { const d = new Date(day); d.setDate(d.getDate() - i); prior.push(totals.get(localDay(d)) ?? 0); }
    prior.sort((a, b) => a - b);
    const spend = totals.get(metricDay) ?? 0;
    metrics.spend[channel] = { today: spend, median: prior[3] };
    if (prior[3] > 0 && spend > 2 * prior[3]) add(`spend:${channel}`, channel === "voice" ? "voice" : "self-fix", 1, [], { days: 1 });
  }
  const complaints = new Map();
  for (const f of feedback.filter((f) => f.intent === "change" && ["new", "triaged"].includes(f.status) && f.target && inRange(f.at, now - 7 * DAY_MS))) {
    const key = JSON.stringify(Object.entries(f.target).filter(([k]) => k !== "view").sort(([a], [b]) => a.localeCompare(b)));
    if (key === "[]") continue;
    const group = complaints.get(key) ?? []; group.push(f); complaints.set(key, group);
  }
  for (const [target, group] of complaints) if (group.length >= 2) {
    metrics.feedback.push({ target, count: group.length });
    add(`feedback:${target}`, "policy", group.length, [], { days: 7, feedbackIds: group.map((f) => f.id), complaints: group.map((f) => f.utterance) });
  }
  return { at: new Date(now).toISOString(), window, area, metrics, anomalies };
}
