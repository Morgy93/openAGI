import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultRuntime } from '../src/index.js';

function fixture() {
  const runtime = createDefaultRuntime();
  runtime.scrutiny.evaluate = () => ({ action: 'observe', score: 0.6, reasons: ['retain useful evidence'], dimensions: {} });
  runtime.propagation.shouldPropagate = () => ({ decision: false });
  return runtime;
}
function signal(content) {
  return { id: 'synthetic-signal', source: 'synthetic-integration', summary: 'Project update', content,
    domain: 'general', taskType: 'update', tags: [], novelty: 0.6, risk: 0.2, repetition: 0.1 };
}

test('signal memory retains body and distinguishes facts sharing a summary', () => {
  const runtime = fixture();
  const first = runtime.processSignal(signal('Delivery moved to Tuesday.'));
  const second = runtime.processSignal(signal('Delivery moved to Friday.'));
  assert.match(first.memory.content, /Delivery moved to Tuesday\./);
  assert.match(second.memory.content, /Delivery moved to Friday\./);
  assert.notEqual(first.memory.id, second.memory.id);
  assert.equal(runtime.memory.snapshot().medium.length, 2);
});

test('summary-only signals retain a clean memory and exact repeats still deduplicate', () => {
  const runtime = fixture();
  const first = runtime.processSignal(signal(undefined));
  const second = runtime.processSignal(signal(undefined));
  assert.match(first.memory.content, /Project update/);
  assert.doesNotMatch(first.memory.content, /undefined|null/);
  assert.equal(first.memory.id, second.memory.id);
  const repeated = runtime.processSignal(signal('Delivery moved to Tuesday.'));
  assert.equal(runtime.processSignal(signal('Delivery moved to Tuesday.')).memory.id, repeated.memory.id);
});

test('ignored and ephemeral bodies are never committed to memory', () => {
  const runtime = fixture();
  assert.equal(runtime.processSignal(signal('Synthetic connectivity probe'), { ephemeral: true }).memory, null);
  runtime.scrutiny.evaluate = () => ({ action: 'ignore', score: 0, reasons: [], dimensions: {} });
  assert.equal(runtime.processSignal(signal('Synthetic low-signal noise')).memory, null);
  assert.equal(runtime.memory.items.size, 0);
});
