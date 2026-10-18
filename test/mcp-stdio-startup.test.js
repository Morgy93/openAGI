import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpStdioClient } from "../src/mcp-client.js";
import { McpRegistry } from "../src/mcp-registry.js";

test("missing MCP executable rejects immediately instead of waiting five minutes", { timeout: 2000 }, async (t) => {
  const client = new McpStdioClient({ name: "obsidian", command: "/nonexistent/openagi-mcp-fixture/node" });
  t.after(() => client.close());
  await assert.rejects(client.connect(), /executable or working directory was not found/);
  assert.equal(client.status().connected, false);
  assert.match(client.status().lastError, /app's PATH/);
  assert.equal(client.pending.size, 0);
});

test("a stdio notes server can initialize, list and call a read tool, then reconnect", { timeout: 5000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-notes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "notes.mjs");
  fs.writeFileSync(script, `import readline from 'node:readline';
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', line => {
      const m = JSON.parse(line);
      if (m.id == null) return;
      const result = m.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notes-fixture', version: '1' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'read_note', description: 'Read a fixture note', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'Fixture note' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });`);
  const registry = new McpRegistry({ dataDir: dir });
  registry.registerServer({ name: "obsidian", command: process.execPath, args: [script], trustLevel: "untrusted" });
  t.after(() => registry.disconnect("obsidian"));
  const status = await registry.connect("obsidian");
  assert.equal(status.connected, true);
  assert.deepEqual(status.tools, ["read_note"]);
  assert.deepEqual((await registry.callTool("obsidian", "read_note", {})).content, [{ type: "text", text: "Fixture note" }]);
  await registry.disconnect("obsidian");
  assert.equal((await registry.connect("obsidian")).connected, true);
});
