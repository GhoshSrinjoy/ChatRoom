import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCodexModels, normalizeClaudeModels, findRuntime } from '../src/catalog';

test('Codex catalog preserves actual model IDs and supported reasoning, excluding hidden entries', () => {
  const models = normalizeCodexModels([{ id: 'opaque', model: 'actual-model', displayName: 'Actual model', description: 'Fast and smart', isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] }, { model: 'hidden', hidden: true }]);
  assert.equal(models.length, 1); assert.equal(models[0]!.id, 'actual-model'); assert.equal(models[0]!.defaultReasoning, 'high'); assert.deepEqual(models[0]!.reasoning, ['low', 'high', 'ultra']);
  assert.equal(models[0]!.description, 'Fast and smart'); assert.equal(models[0]!.ultra, true); assert.equal(models[0]!.isDefault, true);
  assert.equal(normalizeCodexModels([{ model: 'plain', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }])[0]!.ultra, false);
});
test('Claude catalog maps efforts, adaptive thinking, ultracode and the default entry from the initialize response', () => {
  const models = normalizeClaudeModels([
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true },
    { value: 'haiku', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
    { value: 'claude-opus-4-6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    { displayName: 'no value' }
  ]);
  assert.deepEqual(models.map(m => m.id), ['default', 'haiku', 'claude-opus-4-6']);
  assert.deepEqual(models[0], { id: 'default', name: 'Default (recommended)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, ultra: true, isDefault: true, description: 'Opus 5.5 · Best for everyday, complex tasks' });
  assert.deepEqual(models[1], { id: 'haiku', name: 'Haiku 4.5', reasoning: [], thinking: false, ultra: false, isDefault: false, description: 'Fastest for quick answers' });
  assert.equal(models[2]!.name, 'claude-opus-4-6'); assert.equal(models[2]!.ultra, false);
  assert.deepEqual(normalizeClaudeModels(undefined as any), []);
});
test('Copilot runtime discovery reads the version from a configured CLI and from an npm shim layout', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-copilot-'));
  const print = `if (process.argv.includes('--version')) { console.log('GitHub Copilot CLI 1.0.92.'); console.log("Run 'copilot update' to check for updates."); }`;
  try {
    const script = join(dir, 'fake-copilot.js'); await writeFile(script, print);
    const configured = await findRuntime('copilot', script);
    assert.equal(configured?.version, '1.0.92'); assert.equal(configured?.source, 'Configured executable'); assert.equal(configured?.modern, true);
    assert.equal(configured?.executable.command, process.execPath); assert.deepEqual(configured?.executable.prefix, [script]);
    const bin = join(dir, 'npm'); await mkdir(join(bin, 'node_modules', '@github', 'copilot'), { recursive: true });
    await writeFile(join(bin, 'node_modules', '@github', 'copilot', 'npm-loader.js'), print);
    await writeFile(join(bin, 'copilot.cmd'), '@ECHO off\r\nnode "%~dp0\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n');
    const shim = await findRuntime('copilot', join(bin, 'copilot.cmd'));
    assert.equal(shim?.version, '1.0.92'); assert.deepEqual(shim?.executable.prefix, [join(bin, 'node_modules', '@github', 'copilot', 'npm-loader.js')]);
    assert.equal(await findRuntime('copilot', join(dir, 'missing.js')), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
