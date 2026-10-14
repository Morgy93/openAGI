import test from "node:test";
import assert from "node:assert/strict";
import { botFindings, requiredFindings, reviewLoop } from "../src/self-fix/review-loop.js";

test("bot parsing trusts identities and current head, handles Codex P1 and Cursor High", () => {
  const comment = (login, body, commit_id = "head") => ({ user: { login }, body, commit_id, path: "src/fleet/policy.js", line: 17 });
  const findings = botFindings([comment("chatgpt-codex-connector[bot]", "[P1] Core failure"), comment("cursor[bot]", "**High**: send failure"), comment("owner", "P1"), comment("cursor[bot]", "High", "old"), comment("cursor[bot]", "Medium: optional improvement")], "head");
  assert.equal(findings.length, 3);
  assert.equal(requiredFindings(findings).length, 2);
  assert.equal(findings[0].line, 17);
  assert.equal(requiredFindings([{ severity: "P2", small: true }, { severity: "P3", small: true }]).length, 1);
});
test("review repairs required findings, runs replay each round, and stops at three", async () => {
  let repairs = 0, replays = 0;
  await assert.rejects(reviewLoop({ review: async () => [{ severity: "P1" }], repair: async () => repairs++, replay: async () => replays++, maxRounds: 10 }), /round cap/);
  assert.equal(repairs, 3); assert.equal(replays, 3);
  repairs = 0;
  const result = await reviewLoop({ review: async () => repairs ? [{ severity: "P3" }] : [{ severity: "P1" }], repair: async () => repairs++, replay: async () => {} });
  assert.equal(result.round, 1); assert.equal(result.findings[0].severity, "P3");
});
test("review repairs publish only after replay passes", async () => {
  for (const fail of [false, true]) {
    const order = [];
    let reviews = 0;
    const pending = reviewLoop({ review: async () => reviews++ ? [] : [{ severity: "P1" }],
      repair: async () => order.push("repair"), replay: async () => { order.push("replay"); if (fail) throw new Error("replay failed"); },
      publish: async () => order.push("publish") });
    if (fail) await assert.rejects(pending, /replay failed/); else await pending;
    assert.deepEqual(order, fail ? ["repair", "replay"] : ["repair", "replay", "publish"]);
  }
});
