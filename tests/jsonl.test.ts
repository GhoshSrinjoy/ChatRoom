import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnJsonl, RpcConnection, RpcError } from '../src/jsonl';
import { childEnv } from '../src/process';
import { fakeSpawn, waitFor } from './helpers';

const exe = { command: 'fake-cli', prefix: [] };
const node = { command: process.execPath, prefix: [] };
function open(script: Parameters<typeof fakeSpawn>[0], extra: { maxLine?: number } = {}) {
  const fake = fakeSpawn(script), messages: any[] = [], texts: string[] = [], exits: (number | null)[] = [];
  const proc = spawnJsonl(exe, ['--x'], { cwd: '/tmp', env: { A: '1' }, spawnProcess: fake.spawn, onMessage: m => messages.push(m), onText: t => texts.push(t), onExit: c => exits.push(c), ...extra });
  return { proc, messages, texts, exits, children: fake.children };
}

test('JSON lines are framed across split chunks and CRLF; other lines go to onText', async () => {
  const { proc, messages, texts, exits, children } = open(child => {
    child.emitRaw('{"a":1}\r\n{"b"'); child.emitRaw(':"é"}\n\n   \nnot json\r\n42\n'); child.emitRaw('{"tail":true}'); child.exit(0);
  });
  assert.equal(await proc.exited, 0);
  assert.deepEqual(messages, [{ a: 1 }, { b: 'é' }, { tail: true }]);
  assert.deepEqual(texts, ['not json', '42']);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(children[0]!.args, ['--x']);
  assert.equal(proc.alive, false);
});
test('stdin lines are JSON; send after exit throws', async () => {
  const { proc, children } = open(child => child.onLine(m => { if (m.type === 'quit') child.exit(3); }));
  proc.send({ type: 'hello', text: 'line\nbreak' }); proc.send({ type: 'quit' });
  assert.equal(await proc.exited, 3);
  assert.deepEqual(children[0]!.received, [{ type: 'hello', text: 'line\nbreak' }, { type: 'quit' }]);
  assert.throws(() => proc.send({ type: 'late' }), /process is not running/);
});
test('an oversized line kills the process', async () => {
  const { proc, exits, children } = open(child => child.emitRaw('x'.repeat(200)), { maxLine: 100 });
  await proc.exited;
  assert.equal(children[0]!.killed, true);
  assert.equal(exits.length, 1);
  assert.match(proc.stderrTail, /size limit/);
});
test('stderr keeps the last 4000 characters', async () => {
  const { proc } = open(child => { child.stderr('a'.repeat(5000)); child.stderr('END'); child.exit(1); });
  assert.equal(await proc.exited, 1);
  assert.equal(proc.stderrTail.length, 4000); assert.ok(proc.stderrTail.endsWith('END'));
});
test('close() ends stdin and the process exits by itself', async () => {
  const { proc, children } = open(() => {});
  await proc.close(1000);
  assert.equal(children[0]!.stdinEnded, true); assert.equal(children[0]!.killed, false);
});
test('close() kills the process after the grace period when it ignores EOF', async () => {
  const { proc, children } = open(child => { child.exitOnEnd = false; });
  const started = Date.now();
  await proc.close(150);
  assert.equal(children[0]!.stdinEnded, true); assert.equal(children[0]!.killed, true);
  assert.ok(Date.now() - started >= 140, 'waited for the grace period');
  assert.equal(proc.alive, false);
});
test('a real process: lines round-trip, and kill() ends a process that ignores EOF', { timeout: 15000 }, async () => {
  const echoed: any[] = [];
  const echo = spawnJsonl(node, ['-e', `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);process.stdout.write(JSON.stringify({echo:JSON.parse(l)})+'\\r\\n');}});`],
    { cwd: process.cwd(), env: childEnv(node), onMessage: m => echoed.push(m) });
  echo.send({ n: 1 });
  await waitFor(() => echoed.length === 1, 5000, 'echo');
  assert.deepEqual(echoed, [{ echo: { n: 1 } }]);
  await echo.close(3000);
  assert.equal(echo.alive, false);
  const stuck = spawnJsonl(node, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), env: childEnv(node), onMessage: () => {} });
  assert.ok(stuck.pid);
  const started = Date.now();
  await stuck.kill();
  await stuck.exited;
  assert.ok(Date.now() - started < 6000);
});

function rpc(dialect: 'jsonrpc2' | 'codex', onRequest: (method: string, params: any) => Promise<unknown> = async () => { throw new RpcError(-32601, 'Method not found'); }) {
  const sent: any[] = [], notes: [string, any][] = [];
  const connection = new RpcConnection(m => sent.push(m), { dialect, onNotification: (method, params) => notes.push([method, params]), onRequest });
  return { connection, sent, notes };
}
test('RpcConnection correlates responses in the jsonrpc2 dialect', async () => {
  const { connection, sent } = rpc('jsonrpc2');
  const first = connection.request('session/new', { cwd: '/w' }), second = connection.request('ping');
  assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/w' } }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.equal(connection.receive({ jsonrpc: '2.0', id: 2, result: { pong: true } }), true);
  assert.equal(connection.receive({ jsonrpc: '2.0', id: 1, result: { sessionId: 's' } }), true);
  assert.deepEqual(await first, { sessionId: 's' }); assert.deepEqual(await second, { pong: true });
  assert.equal(connection.receive({ type: 'not-rpc' }), false);
});
test('RpcConnection omits jsonrpc in the codex dialect and rejects error responses with RpcError', async () => {
  const { connection, sent } = rpc('codex');
  const pending = connection.request('thread/start', { cwd: '/w' });
  assert.deepEqual(sent[0], { id: 1, method: 'thread/start', params: { cwd: '/w' } });
  connection.receive({ id: 1, error: { code: -32600, message: 'bad thread', data: { x: 1 } } });
  await assert.rejects(pending, (error: unknown) => error instanceof RpcError && error.code === -32600 && error.message === 'bad thread' && (error.data as any).x === 1);
});
test('RpcConnection times out requests and close() rejects pending ones', async () => {
  const { connection } = rpc('codex');
  await assert.rejects(connection.request('slow', {}, 30), /slow timed out/);
  const pending = connection.request('never');
  connection.close(new Error('process exited'));
  await assert.rejects(pending, /process exited/);
  await assert.rejects(connection.request('after'), /process exited/);
});
test('RpcConnection answers incoming requests and forwards notifications', async () => {
  const { connection, sent, notes } = rpc('jsonrpc2', async (method, params) => {
    if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: params.pick } };
    if (method === 'fail') throw new RpcError(-32000, 'Nope', { why: 'test' });
    if (method === 'boom') throw new Error('crashed');
    throw new RpcError(-32601, `Method not found: ${method}`);
  });
  assert.equal(connection.receive({ jsonrpc: '2.0', method: 'session/update', params: { u: 1 } }), true);
  assert.deepEqual(notes, [['session/update', { u: 1 }]]);
  connection.receive({ jsonrpc: '2.0', id: 'r1', method: 'session/request_permission', params: { pick: 'allow' } });
  connection.receive({ jsonrpc: '2.0', id: 7, method: 'fail' });
  connection.receive({ jsonrpc: '2.0', id: 8, method: 'boom' });
  connection.receive({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file' });
  await waitFor(() => sent.length === 4);
  assert.deepEqual(sent.find(m => m.id === 'r1'), { jsonrpc: '2.0', id: 'r1', result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  assert.deepEqual(sent.find(m => m.id === 7), { jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'Nope', data: { why: 'test' } } });
  assert.equal(sent.find(m => m.id === 8).error.code, -32603);
  assert.equal(sent.find(m => m.id === 9).error.code, -32601);
});
test('RpcConnection codex-dialect replies and notifications have no jsonrpc field', async () => {
  const { connection, sent } = rpc('codex', async () => ({ decision: 'decline' }));
  connection.receive({ id: 0, method: 'item/commandExecution/requestApproval', params: {} });
  connection.notify('initialized');
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent, [{ method: 'initialized' }, { id: 0, result: { decision: 'decline' } }]);
});
