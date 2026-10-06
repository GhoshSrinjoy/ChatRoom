import test from 'node:test';
import assert from 'node:assert/strict';
import { CliEvents, cliUsage } from '../src/cli-events';
import { repetitionBoundary } from '../src/ollama';

test('modern Codex events produce a completed answer and reported cache usage', () => {
  const events = new CliEvents('codex', () => {}, () => {});
  events.accept({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer' } });
  events.accept({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } });
  assert.equal(events.text, 'Answer'); assert.equal(events.completed, true); assert.equal(events.usage?.cached, 80);
});
test('legacy Codex 0.40 messages and cumulative usage are supported without double counting', () => {
  const events = new CliEvents('codex', () => {}, () => {});
  events.accept({ id: '0', msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, output_tokens: 5 } } } });
  events.accept({ id: '0', msg: { type: 'agent_message', message: 'Legacy answer' } });
  events.accept({ id: '0', msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 120, output_tokens: 15 } } } });
  assert.equal(events.completed, true); assert.equal(events.text, 'Legacy answer'); assert.equal(events.usage?.input, 120);
});
test('Claude streaming text is replaced by the final result and includes all cache categories', () => {
  const events = new CliEvents('claude', () => {}, () => {});
  events.accept({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } });
  events.accept({ type: 'result', result: 'Hello room', usage: { input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 5 }, total_cost_usd: .001 });
  assert.equal(events.text, 'Hello room'); assert.equal(events.usage?.input, 100); assert.equal(events.usage?.cached, 70); assert.equal(events.usage?.cacheWrite, 10);
});
test('CLI errors fail the turn rather than masquerading as model output', () => {
  assert.throws(() => new CliEvents('codex', () => {}, () => {}).accept({ id: '0', msg: { type: 'error', message: 'Login required' } }), /Login/);
  assert.throws(() => new CliEvents('claude', () => {}, () => {}).accept({ type: 'result', is_error: true, result: 'Quota exceeded' }), /Quota/);
  assert.equal(cliUsage('codex', { input_tokens: -10, output_tokens: NaN }).input, 0);
});
test('reported Codex quota snapshots survive subsequent usage events', () => {
  const events = new CliEvents('codex', () => {}, () => {});
  events.accept({ msg: { type: 'token_count', rate_limits: { primary_used_percent: 25, secondary_used_percent: 10, primary_window_minutes: 300, secondary_window_minutes: 10080 } } });
  events.accept({ msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } });
  assert.equal(events.usage?.quota?.primaryUsedPercent, 25); assert.equal(events.usage?.quota?.primaryWindowMinutes, 300);
});
test('OCR repetition guard triggers on sustained loops while preserving normal text', () => {
  assert.equal(repetitionBoundary('Normal OCR with two lines.\nAnother line.'), undefined);
  assert.ok(repetitionBoundary('Heading\n' + 'CHATROOM 123\n'.repeat(5)) !== undefined);
});
