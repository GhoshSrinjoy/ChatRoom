import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, extname } from 'node:path';
import { Executable, NativeProviderId } from './types';

export type { Executable } from './types';
/** For an npm shim or global install, the JavaScript entry or (Copilot) the native executable it launches. */
function npmTarget(dir: string, provider: NativeProviderId): Executable | undefined {
  if (provider !== 'copilot') {
    const script = join(dir, 'node_modules', provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
    return existsSync(script) ? { command: process.execPath, prefix: [script] } : undefined;
  }
  const exe = process.platform === 'win32' ? 'copilot.exe' : 'copilot', pkg = `copilot-${process.platform}-${process.arch}`;
  for (const root of [join(dir, 'node_modules'), join(dir, '..', 'lib', 'node_modules')]) {
    for (const native of [join(root, '@github', 'copilot', 'node_modules', '@github', pkg, exe), join(root, '@github', pkg, exe)]) if (existsSync(native)) return { command: native, prefix: [] };
    const loader = join(root, '@github', 'copilot', 'npm-loader.js');
    if (existsSync(loader)) return { command: process.execPath, prefix: [loader] };
  }
}
export function resolveCli(configured: string, provider: NativeProviderId): Executable | undefined {
  const entries = isAbsolute(configured) ? [configured] : (process.env.PATH ?? '').split(delimiter).flatMap(p => [join(p, configured), join(p, configured + '.exe'), join(p, configured + '.cmd')]);
  for (const candidate of entries) {
    if (!existsSync(candidate)) continue;
    const ext = extname(candidate).toLowerCase();
    if (ext === '.exe') return { command: candidate, prefix: [] };
    if (ext === '.js' || ext === '.mjs') return { command: process.execPath, prefix: [candidate] };
    // Resolve npm shims to the native executable or JavaScript, avoiding cmd.exe and shell interpolation.
    const target = npmTarget(dirname(candidate), provider);
    if (target) return target;
    if (process.platform !== 'win32' && !ext) return { command: candidate, prefix: [] };
    if (ext === '.cmd' || ext === '.ps1') {
      const shim = readFileSync(candidate, 'utf8');
      const relative = /node_modules[\\/][^\r\n"']+?\.(?:m?js)/.exec(shim)?.[0];
      if (relative && existsSync(join(dirname(candidate), relative))) return { command: process.execPath, prefix: [join(dirname(candidate), relative)] };
    }
  }
}
/** Variables a parent Claude Code, IDE or debugger session sets; a nested CLI must not inherit them. */
export const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID',
  'CLAUDE_EFFORT', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_EMIT_STARTUP_TIMING', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
  'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_SSE_PORT', 'ENABLE_IDE_INTEGRATION', 'MCP_CONNECTION_NONBLOCKING', 'AI_AGENT', 'TRACEPARENT', 'NODE_OPTIONS', 'DEBUG',
  'COPILOT_OTEL_FILE_EXPORTER_PATH'];
const SCRUB_PATTERN = /^CLAUDE_CODE_(SESSION|MESSAGING|CHILD|ENTRYPOINT|EXECPATH|SSE_PORT|EMIT_|QUESTION_)/;
/**
 * VS Code's own executable runs JavaScript CLIs only with ELECTRON_RUN_AS_NODE. Native executables
 * must not get it, or their own child processes (including Electron apps) would inherit it.
 */
export function childEnv(executable: Executable, provider?: NativeProviderId, extra: { keepGithubTokens?: boolean; pathPrepend?: string[] } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (executable.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
  const scrub = new Set(SCRUB_ENV);
  if (provider === 'copilot' && !extra.keepGithubTokens) scrub.add('GH_TOKEN').add('GITHUB_TOKEN');
  for (const key of Object.keys(env)) if (scrub.has(key.toUpperCase()) || SCRUB_PATTERN.test(key.toUpperCase())) delete env[key];
  if (provider === 'claude') env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
  if (provider === 'codex' && !env.RUST_LOG) env.RUST_LOG = 'warn';
  if (provider === 'copilot') env.COPILOT_AUTO_UPDATE = 'false';
  if (extra.pathPrepend?.length) {
    const key = Object.keys(env).find(k => process.platform === 'win32' ? k.toUpperCase() === 'PATH' : k === 'PATH') ?? 'PATH';
    env[key] = [...extra.pathPrepend, env[key]].filter(Boolean).join(delimiter);
  }
  return env;
}
/** Ends a process and its descendants. Errors are ignored. */
export function killTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
      resolve(); return;
    }
    const timer = setTimeout(resolve, 5000);
    const done = () => { clearTimeout(timer); resolve(); };
    try {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', done); killer.on('exit', done);
    } catch { done(); }
  });
}
/** Grace before a stop becomes a forced kill, and before pipes held by leftover descendants are released. */
export const STOP_GRACE_MS = 2000, RELEASE_GRACE_MS = 2000;
export interface ProcessOutput { stdout: string; stderr: string }
/** Runs a JSONL CLI. Resolves with the tail of its non-JSON stdout and stderr, for diagnostics. */
export function runJsonLines(executable: Executable, args: string[], input: string, cwd: string, signal: AbortSignal, onEvent: (event: any) => void, spawnProcess: typeof spawn = spawn): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    // On POSIX the CLI leads its own process group, so a stop reaches the helpers it started.
    const child = spawnProcess(executable.command, [...executable.prefix, ...args], { cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32',
      env: childEnv(executable), stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', stdout = '', stderr = '', settled = false, closed = false, stopping = false, eventError: Error | undefined;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, run: () => void) => { timers.push(setTimeout(run, ms)); };
    const finish = (error?: Error) => {
      if (settled) return; settled = true; timers.forEach(clearTimeout); signal.removeEventListener('abort', stop);
      error ? reject(error) : resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const signalTree = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (force) { child.kill(); return; }
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code !== 0) child.kill(); });
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
      }
    };
    // Stop politely, then force, then stop waiting for pipes that a surviving descendant may hold open.
    const stop = () => {
      if (stopping) return; stopping = true;
      signalTree(false);
      later(STOP_GRACE_MS, () => { if (closed) return; signalTree(true); later(RELEASE_GRACE_MS, release); });
    };
    const release = () => { if (closed) return; child.stdout.destroy(); child.stderr.destroy(); onClose(child.exitCode); };
    signal.addEventListener('abort', stop, { once: true });
    const consume = (line: string) => {
      if (!line.trim() || eventError) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { stdout = (stdout + line + '\n').slice(-4000); return; }
      try { onEvent(value); } catch (error) { eventError = error instanceof Error ? error : new Error(String(error)); stop(); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 8_000_000) { eventError = new Error('Provider stream exceeded the buffer limit.'); pending = ''; stop(); return; }
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); consume(line); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', finish);
    // 'close' waits for every holder of the output pipes; after the CLI itself exits, wait only briefly.
    child.on('exit', () => later(RELEASE_GRACE_MS, release));
    const onClose = (code: number | null) => {
      if (closed) return; closed = true;
      if (pending) { consume(pending); pending = ''; }
      if (signal.aborted) finish(new Error(signal.reason instanceof Error ? signal.reason.message : 'Turn cancelled.'));
      else if (eventError) finish(eventError);
      else if (code !== 0) finish(new Error(stderr.trim() || stdout.trim() || `Provider exited with code ${code}. Check the CLI login in a terminal.`));
      else finish();
    };
    child.on('close', code => onClose(code));
    if (signal.aborted) stop(); else child.stdin.end(input);
  });
}
