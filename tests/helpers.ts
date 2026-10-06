import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { Agent, AgentCapabilities, AgentSession, ActivityItem, ApprovalDecision, ApprovalRequest, DriverHost, ProviderId, Room, RoomTools, TurnSink, AgentOptions, RoomToolName } from '../src/types';

export interface FakeChild {
  /** Extra: the spawned command. */
  command: string;
  args: string[]; env: NodeJS.ProcessEnv; cwd: string;
  /** Every JSON line the code under test wrote to stdin, parsed (raw text for non-JSON lines). */
  received: any[];
  /** Called for each line written to stdin (parsed JSON). */
  onLine(handler: (message: any) => void): void;
  /** Writes one JSON line to the child's stdout. */
  emit(message: unknown): void;
  emitRaw(text: string): void;
  stderr(text: string): void;
  /** Emits 'exit' and 'close' with this code. */
  exit(code?: number | null): void;
  stdinEnded: boolean; killed: boolean;
  /** Extra: exit(0) when stdin ends, like a CLI reaching EOF (default true). */
  exitOnEnd: boolean;
  /** Extra: true once 'exit' was emitted. */
  exited: boolean;
}
/**
 * spawnProcess replacement. `script` runs for each spawn (in spawn order); the child has pid undefined so no real taskkill runs.
 * Output (emit, emitRaw, stderr, exit) and stdin handlers run asynchronously, in order, like a real process.
 */
export function fakeSpawn(script: (child: FakeChild, index: number) => void): { spawn: typeof spawn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const fake = ((command: string, args: readonly string[] = [], options: any = {}) => {
    const proc = new EventEmitter() as any;
    const stdout = new PassThrough(), stderr = new PassThrough(), handlers: ((message: any) => void)[] = [];
    let buffer = '';
    const later = (run: () => void) => setImmediate(run);
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message: any; try { message = JSON.parse(line); } catch { message = line; }
          child.received.push(message);
          later(() => { for (const handler of handlers) handler(message); });
        }
        callback();
      },
    });
    stdin.on('finish', () => { child.stdinEnded = true; if (child.exitOnEnd) child.exit(0); });
    const child: FakeChild = {
      command, args: [...args], env: options.env ?? {}, cwd: options.cwd ?? '', received: [], stdinEnded: false, killed: false, exitOnEnd: true, exited: false,
      onLine: handler => { handlers.push(handler); },
      emit: message => later(() => { if (!child.exited) stdout.write(JSON.stringify(message) + '\n'); }),
      emitRaw: text => later(() => { if (!child.exited) stdout.write(text); }),
      stderr: text => later(() => { if (!child.exited) stderr.write(text); }),
      exit: (code = 0) => later(() => {
        if (child.exited) return; child.exited = true; proc.exitCode = code;
        stdout.end(); stderr.end();
        proc.emit('exit', code, null);
        setImmediate(() => proc.emit('close', code, null));
      }),
    };
    Object.assign(proc, { pid: undefined, exitCode: null, stdin, stdout, stderr,
      kill: () => { child.killed = true; child.exit(null); return true; } });
    children.push(child);
    script(child, children.length - 1);
    return proc;
  }) as unknown as typeof spawn;
  return { spawn: fake, children };
}
/** Replies to JSON-RPC requests by method. dialect 'codex' omits "jsonrpc". A handler may return a value (result), throw {code,message} (error), or return undefined to stay silent. */
export function rpcPeer(child: FakeChild, dialect: 'jsonrpc2' | 'codex', handlers: Record<string, (params: any, id: string | number) => unknown>): { notify(method: string, params?: unknown): void; request(method: string, params?: unknown): Promise<any> } {
  const frame = (message: object) => dialect === 'jsonrpc2' ? { jsonrpc: '2.0', ...message } : message;
  const waiting = new Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>();
  let next = 9000;
  child.onLine(async message => {
    if (!message || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === 'string') {
      const handler = handlers[message.method];
      if (!hasId) { try { await handler?.(message.params, message.id); } catch { /* Notifications have no reply. */ } return; }
      if (!handler) { child.emit(frame({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })); return; }
      try {
        const result = await handler(message.params, message.id);
        if (result !== undefined) child.emit(frame({ id: message.id, result }));
      } catch (error: any) {
        child.emit(frame({ id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error), ...(error?.data !== undefined ? { data: error.data } : {}) } }));
      }
      return;
    }
    const entry = hasId ? waiting.get(String(message.id)) : undefined;
    if (!entry) return;
    waiting.delete(String(message.id));
    if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? 'error'), { code: message.error.code, data: message.error.data }));
    else entry.resolve(message.result);
  });
  return {
    notify: (method, params) => child.emit(frame({ method, ...(params !== undefined ? { params } : {}) })),
    request: (method, params) => new Promise((resolve, reject) => {
      const id = next++; waiting.set(String(id), { resolve, reject });
      child.emit(frame({ id, method, ...(params !== undefined ? { params } : {}) }));
    }),
  };
}
const ROOM_TOOL_NAMES: RoomToolName[] = ['search_documents', 'read_document', 'semantic_search', 'ollama_ocr'];
export function fakeRoomTools(): RoomTools & { calls: { agentId: string; name: string; args: unknown }[]; mcpMessages: any[] } {
  const calls: { agentId: string; name: string; args: unknown }[] = [], mcpMessages: any[] = [];
  const definitions = () => ROOM_TOOL_NAMES.map(name => ({ name, description: `Test ${name}`, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }));
  const call = async (agentId: string, name: string, args: unknown) => {
    calls.push({ agentId, name, args });
    return ROOM_TOOL_NAMES.includes(name as RoomToolName) ? { text: `${name} result`, isError: false } : { text: `Tool error: unknown tool ${name}`, isError: true };
  };
  return {
    calls, mcpMessages, definitions, call,
    async mcp(agentId, message) {
      mcpMessages.push(message);
      const reply = (body: object) => ({ jsonrpc: '2.0', id: message?.id, ...body });
      const method = message?.method;
      if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
      if (method === 'initialize') return reply({ result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chatroom', version: '0.4.0-test' } } });
      if (method === 'ping') return reply({ result: {} });
      if (method === 'tools/list') return reply({ result: { tools: definitions() } });
      if (method === 'tools/call') { const r = await call(agentId, message.params?.name, message.params?.arguments); return reply({ result: { content: [{ type: 'text', text: r.text }], isError: r.isError } }); }
      return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    },
    async httpEndpoint() { return { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer test' } }; },
  };
}
export function fakeHost(patch: Partial<DriverHost> = {}): DriverHost & { logs: string[]; tools: ReturnType<typeof fakeRoomTools> } {
  const logs: string[] = [], tools = fakeRoomTools();
  let storage: string | undefined;
  return {
    version: '0.4.0-test',
    cwd: () => tmpdir(),
    storageDir: () => storage ??= mkdtempSync(join(tmpdir(), 'chatroom-test-')),
    runtime: async () => ({ executable: { command: 'fake-cli', prefix: [] }, version: '9.9.9', source: 'test', modern: true }),
    settings: () => ({ allowFullAccess: false, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} }),
    roomTools: tools,
    skillWiring: () => undefined,
    log: (text: string) => { logs.push(text); },
    ...patch,
    logs, tools,
  };
}
export interface RecordingSink extends TurnSink { texts: string[]; thinkings: string[]; activities: ActivityItem[]; approvals: ApprovalRequest[]; sessions: Partial<AgentSession>[]; caps: AgentCapabilities[]; optionPatches: Partial<AgentOptions>[] }
/** `decide` answers approvals (default allow). An aborted signal answers deny. */
export function recordingSink(decide?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>): RecordingSink {
  const sink: RecordingSink = {
    texts: [], thinkings: [], activities: [], approvals: [], sessions: [], caps: [], optionPatches: [],
    text: full => { sink.texts.push(full); },
    thinking: full => { sink.thinkings.push(full); },
    activity: item => { sink.activities.push({ ...item }); },
    approval: (request, signal) => {
      sink.approvals.push(request);
      if (signal.aborted) return Promise.resolve({ decision: 'deny', message: 'Cancelled.' });
      return new Promise<ApprovalDecision>((resolve, reject) => {
        const abort = () => resolve({ decision: 'deny', message: 'Cancelled.' });
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(decide ? decide(request) : { decision: 'allow' } as ApprovalDecision)
          .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    },
    session: patch => { sink.sessions.push({ ...patch }); },
    capabilities: caps => { sink.caps.push(caps); },
    options: patch => { sink.optionPatches.push({ ...patch }); },
  };
  return sink;
}
const NAMES: Record<ProviderId, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', ollama: 'Ollama' };
export function testAgent(provider: ProviderId, patch: Partial<Agent> = {}): Agent {
  const options: AgentOptions = { effort: '', thinking: 'on', summary: 'auto', permission: 'ask', useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false,
    ...(provider === 'copilot' ? { copilotRuntime: 'auto' as const } : {}), ...(patch.options ?? {}) };
  return { id: `${provider}-1`, name: NAMES[provider], provider, model: '', role: '', enabled: true, tools: [], ...patch, options };
}
export function testRoom(agents: Agent[]): Room {
  return { id: 'room-1', title: 'Test room', createdAt: Date.now(), agents, messages: [], activity: [], tokenBudget: 0, usage: {}, status: 'idle', completedTurns: 0,
    mode: 'sequential', concurrency: 2, schema: 5, loop: { kind: 'once', rounds: 2, everyMinutes: 10, maxIterations: 5, maxMinutes: 60, maxTokens: 0 },
    attachEditor: true, shareSkills: true };
}
/** Extra: polls until `check` is truthy (default 2 s), then returns its value; throws on timeout. */
export async function waitFor<T>(check: () => T | undefined | false | null, ms = 2000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
