import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, extname } from 'node:path';

export interface Executable { command: string; prefix: string[] }
export function resolveCli(configured: string, provider: 'codex' | 'claude'): Executable | undefined {
  const entries = isAbsolute(configured) ? [configured] : (process.env.PATH ?? '').split(delimiter).flatMap(p => [join(p, configured), join(p, configured + '.exe'), join(p, configured + '.cmd')]);
  for (const candidate of entries) {
    if (!existsSync(candidate)) continue;
    const ext = extname(candidate).toLowerCase();
    if (ext === '.exe' || (process.platform !== 'win32' && !ext)) return { command: candidate, prefix: [] };
    if (ext === '.js' || ext === '.mjs') return { command: process.execPath, prefix: [candidate] };
    // Resolve npm shims to JavaScript, avoiding cmd.exe and shell interpolation.
    const script = join(dirname(candidate), 'node_modules', provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js');
    if (existsSync(script)) return { command: process.execPath, prefix: [script] };
    if (ext === '.cmd' || ext === '.ps1') {
      const shim = readFileSync(candidate, 'utf8');
      const relative = /node_modules[\\/][^\r\n"']+?\.(?:m?js)/.exec(shim)?.[0];
      if (relative && existsSync(join(dirname(candidate), relative))) return { command: process.execPath, prefix: [join(dirname(candidate), relative)] };
    }
  }
}
/**
 * VS Code's own executable runs JavaScript CLIs only with ELECTRON_RUN_AS_NODE. Native executables
 * must not get it, or their own child processes (including Electron apps) would inherit it.
 */
export function childEnv(executable: Executable): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (executable.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
  return env;
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
