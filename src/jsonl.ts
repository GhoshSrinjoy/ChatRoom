import { spawn, ChildProcess } from 'node:child_process';
import { Executable } from './types';
import { killTree } from './process';

export interface JsonlProcessOptions {
  cwd: string; env: NodeJS.ProcessEnv;
  /** Each parsed JSON line; non-JSON lines go to onText. */
  onMessage: (message: any) => void;
  onText?: (line: string) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (code: number | null) => void;
  /** Test injection. */
  spawnProcess?: typeof spawn;
  /** Longest stdout line accepted, in characters; longer kills the process. Default 16,000,000. */
  maxLine?: number;
}
export interface JsonlProcess {
  readonly pid: number | undefined; readonly alive: boolean;
  /** Last 4000 characters of stderr. */
  readonly stderrTail: string;
  readonly exited: Promise<number | null>;
  /** Writes one JSON line; throws when the process is not running. */
  send(message: unknown): void;
  /** Ends stdin, waits `graceMs` (default 3000) for the exit, then kills the tree. */
  close(graceMs?: number): Promise<void>;
  kill(): Promise<void>;
}
/** After 'exit', how long to wait for pipes that a leftover descendant may hold before treating the process as closed. */
const PIPE_GRACE_MS = 2000;

export function spawnJsonl(executable: Executable, args: string[], options: JsonlProcessOptions): JsonlProcess {
  const maxLine = options.maxLine ?? 16_000_000;
  let alive = true, finished = false, pending = '', stderrTail = '', exitCode: number | null = null, pipeTimer: NodeJS.Timeout | undefined;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>(resolve => { resolveExit = resolve; });
  const child: ChildProcess = (options.spawnProcess ?? spawn)(executable.command, [...executable.prefix, ...args], {
    cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const line = (raw: string) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!text.trim()) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = undefined; }
    try {
      if (value !== null && typeof value === 'object') options.onMessage(value); else options.onText?.(text);
    } catch { /* A handler error must not break the stream. */ }
  };
  const finish = (code: number | null) => {
    if (finished) return; finished = true; alive = false; clearTimeout(pipeTimer);
    if (pending) { const rest = pending; pending = ''; line(rest); }
    resolveExit(code);
    try { options.onExit?.(code); } catch { /* Ignore handler errors. */ }
  };
  const release = () => { child.stdout?.destroy(); child.stderr?.destroy(); finish(exitCode); };
  /** True when the process exits within `ms`. */
  const waitExit = (ms: number) => new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    void exited.then(() => { clearTimeout(timer); resolve(true); });
  });
  child.stdin?.on('error', () => {});
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) { const raw = pending.slice(0, index); pending = pending.slice(index + 1); line(raw); }
    if (pending.length > maxLine) {
      pending = ''; stderrTail = (stderrTail + '\n[chatroom] Output line exceeded the size limit.').slice(-4000);
      void handle.kill();
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    try { options.onStderr?.(chunk); } catch { /* Ignore handler errors. */ }
  });
  child.on('error', error => { stderrTail = (stderrTail + '\n' + error.message).slice(-4000); alive = false; finish(exitCode); });
  child.on('exit', code => { alive = false; exitCode = code; pipeTimer = setTimeout(release, PIPE_GRACE_MS); });
  child.on('close', code => finish(code ?? exitCode));
  const handle: JsonlProcess = {
    get pid() { return child.pid; },
    get alive() { return alive; },
    get stderrTail() { return stderrTail; },
    exited,
    send(message: unknown) {
      if (!alive || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('process is not running');
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    async close(graceMs = 3000) {
      if (finished) return;
      try { child.stdin?.end(); } catch { /* Already closed. */ }
      if (!await waitExit(graceMs)) await handle.kill();
    },
    async kill() {
      if (finished) return;
      if (child.pid === undefined) child.kill(); else { await killTree(child.pid); try { child.kill('SIGKILL'); } catch { /* Already gone. */ } }
      if (!await waitExit(PIPE_GRACE_MS)) release();
    },
  };
  return handle;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'RpcError'; }
}
export interface RpcOptions {
  /** jsonrpc2 adds "jsonrpc":"2.0" (ACP); codex omits it (Codex app-server). */
  dialect: 'jsonrpc2' | 'codex';
  onNotification: (method: string, params: any) => void;
  /** Throw RpcError to reply with that error; unknown methods should throw RpcError(-32601). */
  onRequest: (method: string, params: any, id: string | number) => Promise<unknown>;
}
interface Pending { method: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export class RpcConnection {
  private next = 1;
  private readonly pending = new Map<string, Pending>();
  private closed?: Error;
  constructor(private readonly send: (message: unknown) => void, private readonly options: RpcOptions) {}
  private frame(message: Record<string, unknown>) { return this.options.dialect === 'jsonrpc2' ? { jsonrpc: '2.0', ...message } : message; }
  private write(message: Record<string, unknown>) { try { this.send(this.frame(message)); } catch { /* The process is gone; pending requests are rejected by close(). */ } }
  receive(message: any): boolean {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    const hasId = typeof message.id === 'string' || typeof message.id === 'number';
    if (typeof message.method === 'string') {
      if (hasId) void this.answer(message.method, message.params, message.id);
      else { try { this.options.onNotification(message.method, message.params); } catch { /* Ignore handler errors. */ } }
      return true;
    }
    if (!hasId || !('result' in message || 'error' in message)) return false;
    const entry = this.pending.get(String(message.id));
    if (entry) {
      this.pending.delete(String(message.id)); clearTimeout(entry.timer);
      if (message.error) entry.reject(new RpcError(Number(message.error.code ?? -32603), String(message.error.message ?? 'Request failed'), message.error.data));
      else entry.resolve(message.result);
    }
    return true;
  }
  private async answer(method: string, params: any, id: string | number) {
    try {
      const result = await this.options.onRequest(method, params, id);
      this.write({ id, result: result ?? null });
    } catch (error) {
      const rpc = error instanceof RpcError ? error : undefined;
      this.write({ id, error: { code: rpc?.code ?? -32603, message: error instanceof Error ? error.message : String(error), ...(rpc?.data !== undefined ? { data: rpc.data } : {}) } });
    }
  }
  request<T = any>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      try { this.send(this.frame({ id, method, ...(params !== undefined ? { params } : {}) })); }
      catch (error) { this.pending.delete(String(id)); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  notify(method: string, params?: unknown): void { this.write({ method, ...(params !== undefined ? { params } : {}) }); }
  close(reason: Error): void {
    this.closed = reason;
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); this.pending.delete(id); entry.reject(reason); }
  }
}
