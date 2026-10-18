// Counts from the 2026-10-13 investigation, without owner transcript text.
export function october13(now) {
  const at = new Date(now - 60_000).toISOString();
  const actions = [];
  for (let i = 0; i < 500; i += 1) {
    const id = `computer-${i}`;
    actions.push({ op: "record", id, at, kind: "nudge", route: "computer-use", status: "planned", threadKey: `t-${i}`, playbook: "resume" });
    actions.push({ op: "update", id, updatedAt: at, status: i < 432 ? "blocked" : "sent" });
  }
  for (let i = 0; i < 40; i += 1) actions.push({ id: `relay-${i}`, at, kind: "nudge", route: "peer-relay", status: i < 28 ? "failed" : "sent", exitCode: i < 28 ? 1 : 0 });
  for (let i = 0; i < 37; i += 1) actions.push({ id: `review-${i}`, at, kind: "review", status: "failed", detail: i < 35 ? "Claude usage limit reached" : "review unavailable" });
  const questions = Array.from({ length: 99 }, (_, i) => ({ id: `question-${i}`, createdAt: at, status: i < 89 ? "resolved" : "answered", answer: i < 89 ? null : "Yes" }));
  return { actions, questions, now };
}
