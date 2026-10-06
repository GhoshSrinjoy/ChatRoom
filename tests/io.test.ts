import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePath } from '../src/paths';
import { jsonLines, localEndpoint, OllamaClient } from '../src/ollama';
import { createServer } from 'node:http';
import { defaultOptions } from '../src/core';

test('workspace path guard rejects traversal, credentials, absolute paths and escaping junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chatroom-test-'));
  try {
    const workspace = join(root, 'workspace'), outside = join(root, 'outside');
    await mkdir(workspace); await mkdir(outside); await writeFile(join(workspace, 'safe.txt'), 'hello'); await writeFile(join(outside, 'private.txt'), 'private');
    await symlink(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await safePath(workspace, 'safe.txt'), await realpath(join(workspace, 'safe.txt')));
    await assert.rejects(safePath(workspace, '../outside/private.txt'), /outside/);
    await assert.rejects(safePath(workspace, 'link/private.txt'), /outside/);
    await assert.rejects(safePath(workspace, '.env'), /credential/);
    await assert.rejects(safePath(workspace, join(outside, 'private.txt')), /workspace-relative/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Ollama rejects remote endpoints, credentials and URL query strings', () => {
  assert.equal(localEndpoint('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.throws(() => localEndpoint('https://example.com')); assert.throws(() => localEndpoint('file:///etc/passwd'));
  assert.throws(() => localEndpoint('http://user:pass@localhost:11434')); assert.throws(() => localEndpoint('http://localhost/?url=remote'));
});
test('NDJSON handles split UTF-8, blank lines and a final unterminated event', async () => {
  const bytes = new TextEncoder().encode('{"text":"héllo"}\n\n{"done":true}');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const events = []; for await (const event of jsonLines(stream, new AbortController().signal)) events.push(event);
  assert.deepEqual(events, [{ text: 'héllo' }, { done: true }]);
});
test('Ollama HTTP adapter streams text and maps actual terminal usage', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/chat');
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end('{"message":{"content":"Hello "}}\n{"message":{"content":"room"}}\n{"done":true,"prompt_eval_count":22,"eval_count":3}\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const client = new OllamaClient(() => `http://127.0.0.1:${address.port}`, () => '5m');
    const chunks: string[] = [];
    const result = await client.run({ agent: { id: '1', provider: 'ollama', model: 'mock', name: 'Local', role: 'Helper', enabled: true, tools: [], options: defaultOptions('ollama') }, system: 'System', prompt: 'Hi', signal: new AbortController().signal, onText: text => chunks.push(text), onActivity: () => {} });
    assert.equal(result.text, 'Hello room'); assert.equal(result.usage.input, 22); assert.equal(result.usage.output, 3);
    assert.deepEqual(chunks, ['Hello ', 'Hello room']);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('one retired Ollama model cannot hide healthy local models', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'retired:cloud' }, { name: 'local-embed' }] })); return; }
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (JSON.parse(body).model === 'retired:cloud') { res.writeHead(410).end('Retired model'); }
      else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ capabilities: ['embedding'] })); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new OllamaClient(() => `http://127.0.0.1:${(server.address() as { port: number }).port}`, () => '5m');
    const models = await client.models();
    assert.equal(models.length, 2); assert.match(models[0]!.error!, /410/);
    assert.deepEqual(models[1]!.capabilities, ['embedding']); assert.equal(models[1]!.remote, false);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
