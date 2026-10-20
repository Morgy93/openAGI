import assert from "node:assert/strict";
import test from "node:test";
import { MemorySystem } from "../src/memory-system.js";
import { MemoryCondenser } from "../src/memory-condenser.js";

function fixture(tier = "medium") {
  const memory = new MemorySystem();
  const rows = ["Obsolete schedule: review at nine, with the old detailed instructions.", "Review checklist includes a summary.", "Review checklist includes a decision."].map(content =>
    memory.remember({ content, source: "local", tags: ["review", "schedule"] }, { tier, strength: 0.8 }));
  return { memory, rows };
}

for (const tier of ["short", "medium"]) {
  test(`condensation excludes corrected ${tier} evidence from prompt and lineage`, async () => {
    const { memory, rows } = fixture(tier);
    const { item: correction } = memory.correct({ id: rows[0].id, content: "Review starts at ten." });
    let prompt;
    const provider = { isConfigured: () => true, async generate({ input }) {
      prompt = input;
      return { text: "Review starts at ten. (confidence: high)" };
    } };
    const result = await new MemoryCondenser({ runtime: { memory, agentHost: { modelProvider: provider } } }).condense();
    assert.equal(result.principles, 1);
    assert.ok(!prompt.includes(rows[0].content), "superseded fact never reaches the model");
    assert.ok(prompt.includes(correction.content));
    const principle = memory.items.get(result.items[0].id);
    assert.deepEqual(new Set(principle.metadata.sources), new Set([rows[1].id, rows[2].id, correction.id]));
    assert.equal(rows[0].metadata.condensedInto, undefined);
    assert.equal(memory.items.get(rows[0].id), rows[0], "historical source is retained");
  });
}

test("superseded sources do not satisfy the minimum evidence threshold", async () => {
  const { memory, rows } = fixture();
  memory.correct({ id: rows[0].id, content: "Review starts at ten." });
  memory.correct({ id: rows[1].id, content: "Review starts at ten." });
  // Keep the current corrections outside the input tiers, as happens after promotion.
  for (const row of memory.items.values()) if (row.kind === "correction") row.tier = "long";
  const result = await new MemoryCondenser({ runtime: { memory } }).condense();
  assert.equal(result.principles, 0);
  assert.equal(memory.byTier("long").filter(row => row.kind === "principle").length, 0);
});

test("a correction during model generation discards stale output and allows a fresh run", async () => {
  const { memory, rows } = fixture();
  let corrected = false;
  const indexed = [];
  const provider = { isConfigured: () => true, async generate() {
    if (!corrected) {
      memory.correct({ id: rows[0].id, content: "Review starts at ten." });
      corrected = true;
      return { text: "Review starts at nine. (confidence: high)" };
    }
    return { text: "Review starts at ten. (confidence: high)" };
  } };
  const condenser = new MemoryCondenser({ runtime: { memory, agentHost: { modelProvider: provider },
    vectorStore: { async upsert(...args) { indexed.push(args); } } } });
  const first = await condenser.condense();
  assert.equal(first.principles, 0);
  assert.equal(indexed.length, 0);
  assert.ok(rows.every(row => !row.metadata.condensedInto));
  const second = await condenser.condense();
  assert.equal(second.principles, 1);
  assert.equal(indexed.length, 1);
  assert.equal(second.items[0].text, "Review starts at ten.");
});
