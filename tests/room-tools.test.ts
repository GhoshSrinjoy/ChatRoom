import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { RoomToolHost } from '../src/room-tools';

const signal = () => new AbortController().signal;
function host(calls: { agentId: string; name: string; args: Record<string, unknown> }[] = []) {
  return new RoomToolHost(async (agentId, name, args) => {
    calls.push({ agentId, name, args });
    if (args.fail) throw new Error('broken');
    return name === 'search_documents' ? 'x'.repeat(30000) : `ran ${name}`;
  });
}
function post(url: string, body: string, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('room tool definitions are the six fixed tools in a stable order', () => {
  const defs = host().definitions();
  assert.deepEqual(defs.map(d => d.name), ['search_documents', 'read_document', 'semantic_search', 'ollama_ocr', 'isolate_workspace', 'sandbox_run']);
  assert.match(defs[5]!.description, /^Run a shell command or a script in a throwaway Docker container on a copy of your folder, after the user approves it on a card\./);
  const sandbox = defs[5]!.inputSchema as any;
  assert.deepEqual(Object.keys(sandbox.properties), ['command', 'code', 'language', 'profile', 'network', 'timeoutSeconds', 'outputs', 'purpose', 'copyFiles']);
  assert.deepEqual(sandbox.required, []); assert.equal(sandbox.additionalProperties, false);
  assert.deepEqual(sandbox.properties.language.enum, ['bash', 'python', 'node']); assert.deepEqual(sandbox.properties.profile.enum, ['test', 'security']);
  assert.match(defs[4]!.description, /^Work in your own git worktree from your next turn, so your edits can't collide with other agents'\. .* Available in Full access\.$/);
  assert.deepEqual(defs[4]!.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.match(defs[1]!.description, /^Read a PDF, Word \(\.docx\) or image file/);
  assert.deepEqual((defs[2]!.inputSchema as any).required, ['query']);
});
test('call validates names, coerces arguments, caps output and turns errors into isError results', async () => {
  const calls: { agentId: string; name: string; args: Record<string, unknown> }[] = [], tools = host(calls);
  assert.deepEqual(await tools.call('a1', 'read_document', '{"path":"doc.pdf"}', signal()), { text: 'ran read_document', isError: false });
  assert.deepEqual(calls[0], { agentId: 'a1', name: 'read_document', args: { path: 'doc.pdf' } });
  assert.deepEqual(await tools.call('a1', 'ollama_ocr', [1, 2], signal()), { text: 'ran ollama_ocr', isError: false });
  assert.deepEqual(calls[1]!.args, {});
  assert.equal((await tools.call('a1', 'search_documents', {}, signal())).text.length, 24000);
  assert.deepEqual(await tools.call('a1', 'semantic_search', { fail: true }, signal()), { text: 'Tool error: broken', isError: true });
  const unknown = await tools.call('a1', 'list_files', {}, signal());
  assert.equal(unknown.isError, true); assert.equal(calls.length, 4);
});
test('MCP handler answers initialize, tools/list, tools/call and rejects unknown methods', async () => {
  const tools = host();
  const init = await tools.mcp('a', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.deepEqual(init, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'chatroom', version: '0.4.0' } } });
  assert.equal((await tools.mcp('a', { jsonrpc: '2.0', id: 'x', method: 'initialize' })).result.protocolVersion, '2025-06-18');
  assert.equal(await tools.mcp('a', { jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.deepEqual(await tools.mcp('a', { jsonrpc: '2.0', id: 2, method: 'ping' }), { jsonrpc: '2.0', id: 2, result: {} });
  assert.equal((await tools.mcp('a', { jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.length, 6);
  assert.deepEqual(await tools.mcp('a', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_document', arguments: { path: 'a.pdf' } } }),
    { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'ran read_document' }], isError: false } });
  const failed = await tools.mcp('a', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ollama_ocr', arguments: { fail: true } } });
  assert.equal(failed.result.isError, true); assert.equal(failed.result.content[0].text, 'Tool error: broken');
  const unknown = await tools.mcp('a', { jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(unknown.id, 6); assert.equal(unknown.jsonrpc, '2.0'); assert.equal(unknown.error.code, -32601);
});
test('HTTP endpoint is loopback only, token protected and maps each token to its agent', async () => {
  const calls: { agentId: string; name: string; args: Record<string, unknown> }[] = [], tools = host(calls);
  try {
    const a = await tools.httpEndpoint('agent-a'), b = await tools.httpEndpoint('agent-b');
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/); assert.equal(a.url, b.url);
    assert.notEqual(a.headers.Authorization, b.headers.Authorization); assert.match(a.headers.Authorization!, /^Bearer [0-9a-f]{48}$/);
    assert.deepEqual(await tools.httpEndpoint('agent-a'), a);
    const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal((await post(a.url, list)).status, 401);
    assert.equal((await post(a.url, list, { Authorization: 'Bearer wrong' })).status, 401);
    const ok = await post(a.url, list, a.headers);
    assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).result.tools.length, 6);
    assert.equal((await post(a.url, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), a.headers)).status, 202);
    const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_document', arguments: { path: 'x.pdf' } } });
    await post(b.url, JSON.stringify(call(2)), b.headers);
    const batch = await post(a.url, JSON.stringify([call(3), { jsonrpc: '2.0', method: 'notifications/initialized' }]), a.headers);
    assert.equal(batch.status, 200); assert.deepEqual(JSON.parse(batch.body).map((r: any) => r.id), [3]);
    assert.deepEqual(calls.map(c => c.agentId), ['agent-b', 'agent-a']);
    assert.equal((await post(a.url, '{not json', a.headers)).status, 400);
    assert.equal((await post(a.url, 'x'.repeat(1_100_000), a.headers)).status, 413);
    assert.equal((await post(a.url.replace('/mcp', '/other'), list, a.headers)).status, 404);
    assert.equal((await post(a.url, '', a.headers, 'GET')).status, 405);
  } finally { await tools.dispose(); }
});
