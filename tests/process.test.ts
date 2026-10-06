import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runJsonLines, resolveCli, childEnv, STOP_GRACE_MS, RELEASE_GRACE_MS } from '../src/process';
import { CliProvider } from '../src/cli-provider';
import { createRoom } from '../src/core';

const node = { command: process.execPath, prefix: [] };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 100)); return check(); };
// A helper that inherits the CLI's stdout keeps the pipe open, like a CLI's background subprocess.
// unref() lets the CLI itself exit while the helper lives on.
const helper = (lifetime: number) => `const { spawn } = require('node:child_process'); const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${lifetime})'], { stdio: 'inherit' }); helper.unref(); console.log(JSON.stringify({ helper: helper.pid }));`;

test('JSONL subprocess keeps prompts off the command line and returns non-JSON output for diagnostics', { timeout: 10000 }, async () => {
  const events: unknown[] = [];
  const script = `process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{console.log('diagnostic');console.log(JSON.stringify({prompt:text}));});`;
  const prompt = 'literal $(echo secret) & <tag> "quoted"\nnew line';
  const output = await runJsonLines(node, ['-e', script], prompt, process.cwd(), new AbortController().signal, event => events.push(event));
  assert.deepEqual(events, [{ prompt }]); assert.equal(output.stdout, 'diagnostic');
});
test('subprocess cancellation closes the process before settling', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const run = runJsonLines(node, ['-e', `console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000);`], '', process.cwd(), controller.signal,
    () => controller.abort(new Error('Stop test')));
  await assert.rejects(run, /Stop test/);
});
test('a CLI that ignores the stop request is forced to stop within a bounded time', { timeout: 15000 }, async () => {
  const controller = new AbortController(), started = Date.now();
  const run = runJsonLines(node, ['-e', `process.on('SIGTERM', () => {}); console.log(JSON.stringify({ready:true})); setInterval(() => {}, 1000);`], '', process.cwd(), controller.signal,
    () => controller.abort(new Error('Stopped by you.')));
  await assert.rejects(run, /Stopped by you/);
  assert.ok(Date.now() - started < STOP_GRACE_MS + RELEASE_GRACE_MS + 3000);
});
test('stopping reaches helper processes the CLI started, even when the CLI ignores the stop request', { timeout: 15000 }, async () => {
  const controller = new AbortController(); let pid = 0;
  try {
    const run = runJsonLines(node, ['-e', `process.on('SIGTERM', () => {}); ${helper(20000)} setInterval(() => {}, 1000);`], '', process.cwd(), controller.signal,
      event => { pid = event.helper; controller.abort(new Error('Stopped by you.')); });
    await assert.rejects(run, /Stopped by you/);
    assert.ok(pid > 0); assert.equal(await waitUntil(() => !alive(pid), 4000), true, 'The helper process was stopped too');
  } finally { if (pid && alive(pid)) process.kill(pid); }
});
test('a CLI that exits while a helper still holds its output settles without waiting for the helper', { timeout: 15000 }, async () => {
  const events: { helper: number }[] = [], started = Date.now();
  try {
    await runJsonLines(node, ['-e', `${helper(20000)} console.log(JSON.stringify({ answer: 'done' }));`], '', process.cwd(), new AbortController().signal, event => events.push(event));
    assert.deepEqual(events[1], { answer: 'done' });
    assert.ok(Date.now() - started < RELEASE_GRACE_MS + 4000, `Settled after ${Date.now() - started} ms`);
  } finally { if (events[0]?.helper && alive(events[0].helper)) process.kill(events[0].helper); }
});
// A process whose pipes never report closed, as when a leftover descendant holds them (common on POSIX).
function stuckChild() {
  const child = Object.assign(new EventEmitter(), { pid: 2 ** 22 + 17, exitCode: null as number | null, kills: 0,
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill() { child.kills++; return true; } });
  return child;
}
test('when the CLI exits but its pipes never close, the run settles after a short grace', { timeout: 10000 }, async () => {
  const child = stuckChild(), events: unknown[] = [], started = Date.now();
  const run = runJsonLines(node, [], '', process.cwd(), new AbortController().signal, event => events.push(event), (() => child) as any);
  child.stdout.write('{"answer":"done"}\n'); child.exitCode = 0; child.emit('exit', 0);
  await run;
  assert.deepEqual(events, [{ answer: 'done' }]);
  assert.ok(Date.now() - started >= RELEASE_GRACE_MS - 100 && Date.now() - started < RELEASE_GRACE_MS + 2000);
});
test('a stopped CLI that never closes is forced, then released, so the room cannot hang', { timeout: 15000 }, async () => {
  const child = stuckChild(), controller = new AbortController(), started = Date.now();
  const run = runJsonLines(node, [], '', process.cwd(), controller.signal, () => {}, (() => child) as any);
  controller.abort(new Error('Turn timed out.'));
  await assert.rejects(run, /Turn timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= STOP_GRACE_MS + RELEASE_GRACE_MS - 100 && elapsed < STOP_GRACE_MS + RELEASE_GRACE_MS + 3000, `Settled after ${elapsed} ms`);
  assert.ok(child.kills >= 1, 'A forced kill was attempted');
});
test('a failing CLI reports its plain-text stdout when stderr is empty', { timeout: 10000 }, async () => {
  await assert.rejects(runJsonLines(node, ['-e', `console.log('Not logged in. Run codex login.'); process.exit(2);`], '', process.cwd(), new AbortController().signal, () => {}), /Not logged in\. Run codex login\./);
});
test('a CLI that prints a plain-text message instead of an answer explains itself', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-cli-'));
  try {
    const script = join(dir, 'fake-claude.js');
    await writeFile(script, `process.stdin.resume(); process.stdin.on('end', () => console.log('Invalid API key · Please run /login'));`);
    const provider = new CliProvider('claude', () => dir, async () => ({ executable: { command: process.execPath, prefix: [script] }, version: '2.1.289', source: 'test', modern: true }));
    const agent = createRoom().agents[1]!;
    await assert.rejects(provider.run({ agent, system: 'System', prompt: 'Hello', signal: new AbortController().signal, onText: () => {}, onActivity: () => {} }),
      /Claude CLI returned no answer\. It printed:\nInvalid API key · Please run \/login/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('only VS Code\'s own executable runs with ELECTRON_RUN_AS_NODE', () => {
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  try {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    assert.equal(childEnv(node).ELECTRON_RUN_AS_NODE, '1');
    assert.equal(childEnv({ command: join(tmpdir(), 'codex.exe'), prefix: [] }).ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(childEnv(node).NO_COLOR, '1');
  } finally { if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous; }
});
test('nonexistent provider returns a clean missing executable result', () => {
  assert.equal(resolveCli('chatroom-nonexistent-command-92810', 'codex'), undefined);
});
