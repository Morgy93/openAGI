const BOTS = new Set(["chatgpt-codex-connector[bot]", "cursor[bot]"]);

export function botFindings(items, head) {
  return (items ?? []).filter((item) => BOTS.has(item?.user?.login) && (!head || item.commit_id === head || item.original_commit_id === head))
    .flatMap((item) => {
      const text = String(item.body ?? "");
      const severity = /\bP1\b|\bHigh\b/i.test(text) ? "P1" : /\bP2\b|\bMedium\b/i.test(text) ? "P2" : null;
      return severity ? [{ severity, file: item.path ?? "", line: item.line ?? item.original_line ?? 0, summary: text.slice(0, 6000), small: false, source: item.user.login }] : [];
    });
}

export function requiredFindings(findings) {
  return (findings ?? []).filter((finding) => finding.severity === "P1" || (finding.severity === "P2" && finding.small === true));
}

export async function reviewLoop({ review, repair, replay, initialRound = 0, maxRounds = 3, onRound = () => {} }) {
  let round = initialRound;
  for (;;) {
    const findings = await review();
    const required = requiredFindings(findings);
    if (!required.length) return { round, findings };
    if (round >= Math.min(3, maxRounds)) throw new Error("Review round cap reached with required findings unresolved.");
    round += 1;
    await onRound(round);
    await repair(required);
    await replay();
  }
}
