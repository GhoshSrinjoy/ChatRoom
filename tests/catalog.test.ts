import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexModels, Runtime } from '../src/catalog';
import { cliArgs } from '../src/cli-provider';
import { createRoom } from '../src/core';

const runtime: Runtime = { executable: { command: 'codex', prefix: [] }, version: '0.160.0', source: 'fixture', modern: true };
test('Codex catalog preserves actual model IDs and supported reasoning, excluding hidden entries', () => {
  const models = normalizeCodexModels([{ id: 'opaque', model: 'actual-model', displayName: 'Actual model', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, { model: 'hidden', hidden: true }]);
  assert.equal(models.length, 1); assert.equal(models[0]!.id, 'actual-model'); assert.equal(models[0]!.defaultReasoning, 'high'); assert.deepEqual(models[0]!.reasoning, ['low', 'high']);
});
test('Codex explicitly overrides inherited effort and passes the selected model to the runtime', () => {
  const agent = createRoom().agents[0]!; agent.model = 'selected-model';
  const args = cliArgs('codex', runtime, { agent, system: 'Stable system' });
  assert.ok(args.includes('model_reasoning_effort="medium"')); assert.equal(args[args.indexOf('--model') + 1], 'selected-model'); assert.ok(args.includes('--ephemeral'));
  agent.reasoning = 'xhigh'; assert.ok(cliArgs('codex', runtime, { agent, system: '' }).includes('model_reasoning_effort="xhigh"'));
  assert.throws(() => cliArgs('codex', { ...runtime, modern: false, version: '0.40.0' }, { agent, system: '' }), /does not support/);
});
test('Claude keeps the stable system prefix separate and explicitly passes its model', () => {
  const agent = createRoom().agents[1]!; agent.model = 'haiku';
  const args = cliArgs('claude', runtime, { agent, system: 'Stable system' });
  assert.equal(args[args.indexOf('--model') + 1], 'haiku'); assert.equal(args[args.indexOf('--system-prompt') + 1], 'Stable system');
  assert.ok(args.includes('--strict-mcp-config')); assert.equal(args[args.indexOf('--tools') + 1], '');
});
