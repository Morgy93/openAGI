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

test('normalized summary-only integration signals store text once and retain diagnostics', () => {
  const runtime = fixture();
  const summary = 'Synthetic status detail. '.repeat(14).trim();
  const [output] = runtime.processIntegrationEvent('abi', { ...signal(undefined), summary });
  assert.equal(output.signal.content, output.signal.summary, 'exercise normalized fallback');
  assert.equal(output.memory.content.split(summary).length - 1, 1);
  assert.match(output.memory.content, /Decision: observe/);
  assert.match(output.memory.content, /Reasons: retain useful evidence/);
});

test('long compressed memory retains distinct bodies behind a maximum-length summary', () => {
  const runtime = fixture();
  const summary = 'Synthetic repeated project context. '.repeat(20);
  const input = { ...signal('Delivery moved to Tuesday.'), summary, risk: 0.7, novelty: 0.6, specificity: 0.45 };
  const [first] = runtime.processIntegrationEvent('abi', input);
  const [second] = runtime.processIntegrationEvent('abi', { ...input, content: 'Delivery moved to Friday.' });
  assert.ok(first.signal.summary.length >= 500);
  assert.equal(first.memory.tier, 'long');
  assert.equal(first.memory.fidelity, 'compressed');
  assert.match(first.memory.content, /Delivery moved to Tuesday\./);
  assert.match(second.memory.content, /Delivery moved to Friday\./);
  assert.notEqual(first.memory.id, second.memory.id);
  assert.ok(first.memory.content.length <= 362);
  assert.equal(runtime.memory.retrieve('Tuesday', { limit: 1 })[0].item.id, first.memory.id);
});
