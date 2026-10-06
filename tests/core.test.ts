import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, buildContext, parseToolCall, parsePlan, planStages, systemPrompt, message, estimateTokens, boundedNumber } from '../src/core';
import { addUsage, emptyUsage } from '../src/types';

test('context retains original objective and recent contributions within a bounded prompt', () => {
  const room = createRoom(), agent = room.agents[0]!;
  room.messages = [message('user', 'Build a robust parser')];
  for (let i = 0; i < 60; i++) room.messages.push(message('agent', `Contribution ${i}: ` + 'reasoning '.repeat(100), 'Reviewer'));
  const context = buildContext(room, agent, 4000);
  assert.match(context.prompt, /Build a robust parser/);
  assert.match(context.prompt, /Contribution 59/);
  assert.ok(context.omitted > 0);
  assert.ok(estimateTokens(context.system + context.prompt) < 4200);
});
test('stable prompt prefixes are unchanged as discussion grows', () => {
  const room = createRoom(), agent = room.agents[0]!;
  room.messages.push(message('user', 'Review architecture'));
  const before = buildContext(room, agent, 12000);
  room.messages.push(message('agent', 'Use a queue', 'Claude'));
  const after = buildContext(room, agent, 12000);
  assert.equal(before.system, after.system);
  assert.equal(before.prompt.split('\n\n')[0], after.prompt.split('\n\n')[0]);
});
test('large objectives cannot bypass a small context budget', () => {
  const room = createRoom(); room.messages.push(message('user', 'large objective '.repeat(2000)));
  const context = buildContext(room, room.agents[0]!, 2000);
  assert.ok(estimateTokens(context.system + context.prompt) <= 2000);
  assert.match(context.prompt, /objective truncated/);
});
test('tool parsing requires an isolated envelope and a known tool', () => {
  assert.equal(parseToolCall('Here is an example: <chatroom-tool>{}</chatroom-tool>'), undefined);
  assert.throws(() => parseToolCall('<chatroom-tool>{"name":"shell","arguments":{}}</chatroom-tool>'));
  assert.throws(() => parseToolCall('<chatroom-tool>invalid</chatroom-tool>'));
  assert.deepEqual(parseToolCall('<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>'), { name: 'read_file', arguments: { path: 'README.md' } });
});
test('usage aggregation preserves reported cost, cache and estimate provenance', () => {
  const result = addUsage({ ...emptyUsage(), input: 100, cached: 50, cost: .01 }, { ...emptyUsage(), input: 50, output: 20, estimated: true });
  assert.equal(result.input + result.output, 170); assert.equal(result.cached, 50); assert.equal(result.cost, .01); assert.equal(result.estimated, true);
  assert.equal(addUsage(emptyUsage(), emptyUsage()).cost, undefined);
});
test('numeric controls reject NaN and clamp unsafe values', () => {
  assert.equal(boundedNumber(NaN, 1, 10, 3), 3); assert.equal(boundedNumber(Infinity, 1, 10, 3), 3);
  assert.equal(boundedNumber(100, 1, 10, 3), 10); assert.equal(boundedNumber(-20, 1, 10, 3), 1);
});
test('plans resolve agents by name or provider, drop unknown agents and forward dependencies', () => {
  const room = createRoom(), [codex, claude] = room.agents;
  const parsed = parsePlan('Approach.\n<chatroom-plan>```json\n{"steps":[{"id":"a","agent":"claude","task":"Review","after":["b"]},{"id":"b","agent":"Gemini","task":"X"},{"id":"c","agent":"codex","task":"Build","after":["a","zzz"]},{"id":"d","agent":"Codex","task":""}]}\n```</chatroom-plan>', room.agents)!;
  assert.equal(parsed.text, 'Approach.');
  assert.deepEqual(parsed.steps.map(s => [s.id, s.agentId, s.after]), [['a', claude!.id, []], ['c', codex!.id, ['a']]]);
  assert.equal(parsed.notes.length, 2); assert.match(parsed.notes.join(), /"Gemini" is not an enabled agent/);
  assert.equal(parsePlan('No plan here', room.agents), undefined);
  assert.deepEqual(parsePlan('Oops <chatroom-plan>{not json</chatroom-plan>', room.agents)!.steps, []);
  assert.deepEqual(planStages(parsed.steps).map(stage => stage.map(s => s.id)), [['a'], ['c']]);
});
test('system prompts give every agent the roster, its tools, and attached documents', () => {
  const room = createRoom(), [codex] = room.agents;
  room.documents = [{ id: 'd', name: 'spec.pdf', hash: 'h', kind: 'pdf', source: 'attached', status: 'ready', chars: 1200, chunks: 2, pages: 3, ocrPages: 1, addedAt: 0 }];
  const system = systemPrompt(codex!, room);
  assert.match(system, /Codex \(you\)[\s\S]*Claude · Claude Code sonnet[\s\S]*Copilot/);
  assert.match(system, /spec\.pdf · PDF, 3 pages, 1 read with OCR/); assert.match(system, /search_documents/);
  room.agents[1]!.enabled = false; room.agents[2]!.enabled = false;
  assert.match(systemPrompt(codex!, room, { kind: 'plan' }), /only enabled agent/);
});
