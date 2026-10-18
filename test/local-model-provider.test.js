import test from "node:test";
import assert from "node:assert/strict";
import { LocalModelProvider } from "../src/local-model-provider.js";
import { createModelProvider } from "../src/model-provider.js";
import { ToolLoopContext } from "../src/context-trim.js";

test("explicit local inference never falls through to a configured cloud provider", async () => {
  const provider = createModelProvider({ preferred: "local", anthropic: { apiKey: "cloud" }, local: { model: "" } });
  assert.equal(provider.name, "local");
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(provider.generate({ input: "hi" }), /installed/);
});

test("keyless local inference uses Chat Completions and does not send cloud credentials", async () => {
  const requests = [];
  const provider = new LocalModelProvider({ model: "llama3.2", fetchImpl: async (url, request) => {
    requests.push({ url, ...request });
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  } });
  const result = await provider.generate({ input: "hi", agent: { name: "test" } });
  assert.equal(result.text, "Hello");
  assert.equal(requests[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(JSON.parse(requests[0].body).messages.at(-1).content, "hi");
});

test("local tool calls use the normal registry and return results to the model", async () => {
  const requests = [], invoked = [];
  const replies = [
    { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "recall", arguments: '{"query":"style"}' } }] },
    { content: "You prefer short replies." }
  ];
  const provider = new LocalModelProvider({ model: "llama", fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({ choices: [{ message: replies.shift() }] });
  } });
  const context = { approval: "normal-gates" };
  const result = await provider.generate({ input: "How do I work?", context, agent: { name: "test" }, toolRegistry: {
    toOpenAITools: () => [{ name: "recall", parameters: { type: "object" } }],
    invoke: async (...args) => { invoked.push(args); return { ok: true, result: "short replies" }; }
  } });
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(invoked[0], ["recall", { query: "style" }, context]);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call-1");
});

test("failed and empty local responses cannot masquerade as a working model", async () => {
  for (const response of [new Response("down", { status: 503 }), Response.json({ choices: [{ message: { content: "" } }] })]) {
    const provider = new LocalModelProvider({ model: "llama", fetchImpl: async () => response });
    await assert.rejects(provider.generate({ input: "hi", agent: { name: "test" } }), /HTTP 503|no answer/);
  }
});

test("context trimming preserves local tool-call pairing and trims the content field", () => {
  const budget = new ToolLoopContext({ maxInputTokens: 1_000 });
  const old = budget.mark({ role: "tool", tool_call_id: "old-call", content: "x".repeat(10_000) }, { kind: "output", contentKey: "content", tool: "recall", hop: 0 });
  const recent = budget.mark({ role: "tool", tool_call_id: "latest-call", content: "recent" }, { kind: "output", contentKey: "content", tool: "recall", hop: 1 });
  budget.fit([old, recent]);
  assert.match(old.content, /tool output trimmed/);
  assert.equal(old.tool_call_id, "old-call");
  assert.equal(old.output, undefined);
  assert.equal(recent.content, "recent");
});
