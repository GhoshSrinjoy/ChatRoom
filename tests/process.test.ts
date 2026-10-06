import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { delimiter } from 'node:path';
import { runJsonLines, resolveCli, childEnv, killTree, SCRUB_ENV, STOP_GRACE_MS, RELEASE_GRACE_MS } from '../src/process';

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
/** Runs `body` with these environment variables set (undefined deletes), then restores them. */
function withEnv(vars: Record<string, string | undefined>, body: () => void | Promise<void>) {
  const previous = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  apply(vars);
  const restore = () => apply(previous);
  try { const result = body(); if (result instanceof Promise) return result.finally(restore); restore(); } catch (error) { restore(); throw error; }
}
const nativeExe = { command: join(tmpdir(), 'claude.exe'), prefix: [] };
test('childEnv scrubs nested-session variables but keeps user configuration', () => withEnv({
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_SESSION_SOMETHING_NEW: 'x', CLAUDE_CODE_MESSAGING_FOO: 'x',
  CLAUDE_CODE_EMIT_FOO: 'x', NODE_OPTIONS: '--inspect', DEBUG: '*', TRACEPARENT: 't', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_USE_BEDROCK: '1', ELECTRON_RUN_AS_NODE: '1',
}, () => {
  const env = childEnv(nativeExe);
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_SOMETHING_NEW', 'CLAUDE_CODE_MESSAGING_FOO', 'CLAUDE_CODE_EMIT_FOO', 'NODE_OPTIONS', 'DEBUG', 'TRACEPARENT', 'ELECTRON_RUN_AS_NODE'])
    assert.equal(env[key], undefined, key);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg'); assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1'); assert.equal(env.NO_COLOR, '1');
  assert.ok(SCRUB_ENV.includes('CLAUDE_CODE_SSE_PORT'));
}));
test('childEnv per provider: Claude entrypoint, Codex log level, Copilot tokens and auto-update', () => withEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli', GH_TOKEN: 'ghp', GITHUB_TOKEN: 'ghp2', RUST_LOG: undefined }, () => {
  assert.equal(childEnv(nativeExe, 'claude').CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  assert.equal(childEnv(nativeExe, 'codex').RUST_LOG, 'warn');
  const copilot = childEnv(nativeExe, 'copilot');
  assert.equal(copilot.GH_TOKEN, undefined); assert.equal(copilot.GITHUB_TOKEN, undefined); assert.equal(copilot.COPILOT_AUTO_UPDATE, 'false');
  const kept = childEnv(nativeExe, 'copilot', { keepGithubTokens: true });
  assert.equal(kept.GH_TOKEN, 'ghp'); assert.equal(kept.GITHUB_TOKEN, 'ghp2');
  assert.equal(childEnv(nativeExe, 'claude').GH_TOKEN, 'ghp');
  process.env.RUST_LOG = 'debug';
  assert.equal(childEnv(nativeExe, 'codex').RUST_LOG, 'debug');
}));
test('childEnv prepends to PATH', () => {
  const env = childEnv(nativeExe, 'codex', { pathPrepend: ['/opt/codex-path'] });
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH')!;
  assert.ok(env[key]!.startsWith('/opt/codex-path' + delimiter));
  assert.equal(Object.keys(env).filter(k => k.toUpperCase() === 'PATH').length, 1);
});
test('resolveCli finds the native Copilot executable behind an npm shim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-copilot-'));
  try {
    const shim = join(dir, process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
    await writeFile(shim, '@ECHO off\r\nnode "%~dp0\\node_modules\\@github\\copilot\\npm-loader.js" %*\r\n');
    const pkg = join(dir, 'node_modules', '@github', 'copilot');
    await mkdir(pkg, { recursive: true }); await writeFile(join(pkg, 'npm-loader.js'), '');
    assert.deepEqual(resolveCli(shim, 'copilot'), { command: process.execPath, prefix: [join(pkg, 'npm-loader.js')] });
    const nativeDir = join(pkg, 'node_modules', '@github', `copilot-${process.platform}-${process.arch}`);
    const exe = join(nativeDir, process.platform === 'win32' ? 'copilot.exe' : 'copilot');
    await mkdir(nativeDir, { recursive: true }); await writeFile(exe, '');
    assert.deepEqual(resolveCli(shim, 'copilot'), { command: exe, prefix: [] });
    const winget = join(dir, 'copilot.exe'); await writeFile(winget, '');
    assert.deepEqual(resolveCli(winget, 'copilot'), { command: winget, prefix: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('killTree ignores processes that are already gone', async () => {
  await killTree(2 ** 22 + 99);
});
