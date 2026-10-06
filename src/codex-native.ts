import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ActivityItem, Agent, AgentCapabilities, AgentOptions, ApprovalDecision, ApprovalRequest, CodexSandbox, DriverHost, ModelInfo, NativeCommand, NativeDriver,
  NativeTurnRequest, NativeTurnResult, ProviderError, Room, SharedMcpServer, TurnSink, Usage, emptyUsage } from './types';
import { JsonlProcess, RpcConnection, RpcError, spawnJsonl } from './jsonl';
import { childEnv } from './process';
import { codexEditorText } from './editor-context';
import { filterNativeCommands } from './commands';

export const EFFORT_ORDER: string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const rank = (effort: string) => EFFORT_ORDER.indexOf(effort);
/** Think-hard: the next supported level above `current` that is at least `high`, else the highest supported (never `ultra`). */
export function bumpEffort(current: string, supported: string[]): string {
  const candidates = supported.filter(e => e !== 'ultra' && rank(e) >= 0).sort((a, b) => rank(a) - rank(b));
  return candidates.find(e => rank(e) > rank(current) && rank(e) >= rank('high')) ?? candidates[candidates.length - 1] ?? current;
}
const highest = (efforts: string[]) => [...efforts].filter(e => rank(e) >= 0).sort((a, b) => rank(a) - rank(b)).pop();

/** §5.2: approval policy and sandbox per permission level. Plan stays read-only whatever the sandbox override says. */
export function codexPolicy(options: AgentOptions, extraDirs: string[]): { approvalPolicy: string; sandbox: CodexSandbox; sandboxPolicy: object; plan: boolean } {
  const level = options.permission;
  const derived: CodexSandbox = level === 'full' ? 'danger-full-access' : level === 'auto-edit' ? 'workspace-write' : 'read-only';
  // A sandbox override may only tighten what the permission level allows, so a saved looser value cannot turn Ask into Auto-edit.
  const rank: Record<CodexSandbox, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };
  const sandbox: CodexSandbox = level === 'plan' ? 'read-only' : options.sandbox && rank[options.sandbox] < rank[derived] ? options.sandbox : derived;
  const sandboxPolicy = sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [...extraDirs], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    : { type: 'readOnly', networkAccess: false };
  return { approvalPolicy: level === 'plan' || level === 'full' ? 'never' : 'on-request', sandbox, sandboxPolicy, plan: level === 'plan' };
}

interface Breakdown { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number }
interface Skill { name: string; description: string; path: string; scope: string }
interface Server {
  proc: JsonlProcess; rpc: RpcConnection; models: ModelInfo[];
  /** Settles once config/read answered (or failed); fills the fields below. */
  config?: Promise<void>;
  /** MCP servers from the user's config.toml files (never the built-in apps server). */
  mcpNames: string[];
  /** The user's configured model and effort: what "Default" means for this CLI. */
  configModel?: string; configEffort?: string;
  skills?: Promise<Skill[]>; extraRoots: string; dead?: ProviderError;
}
interface Handle { server: Server; threadId: string; model?: string; effort?: string; configKey: string }
interface Live {
  server: Server; threadId: string; turnId?: string; agent: Agent; sink: TurnSink; signal: AbortSignal; permission: AgentOptions['permission'];
  messages: Map<string, string>; thinking: string; reasoningKey?: string; reasoned: Set<string>;
  activities: Map<string, ActivityItem>; changes: Map<string, { paths: string; diff: string }>;
  baseline?: Breakdown; total?: Breakdown; lastError?: any; review?: string;
  complete(turn: any): void; crash(error: ProviderError): void; compacted(): void; turnStarted(): void;
}
type Mode = 'turn' | 'review' | 'compact';

const SIGN_IN = 'Sign in to Codex (open the Codex extension or run codex login).';
const MAPPED: NativeCommand[] = [
  { name: 'review', description: 'Review uncommitted changes, or follow your review instructions', argumentHint: '[instructions]', source: 'mapped' },
  { name: 'goal', description: 'Set, show or clear a long-running goal for this agent', argumentHint: '[objective | clear]', source: 'mapped' },
  { name: 'mcp', description: 'List MCP servers and their tools', source: 'mapped' },
  { name: 'skills', description: 'List the skills Codex can use', source: 'mapped' },
  { name: 'init', description: 'Create an AGENTS.md file with instructions for this repository', source: 'mapped' },
];
const STATUS: Record<string, ActivityItem['status']> = { inProgress: 'running', completed: 'done', failed: 'failed', declined: 'declined', interrupted: 'failed' };
const statusOf = (value: unknown, done: boolean): ActivityItem['status'] => STATUS[String(value)] ?? (done ? 'done' : 'running');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const tail = (text: string, n: number) => text.length > n ? text.slice(-n) : text;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const estimate = (text: string) => Math.ceil(text.length / 3);
const keyOf = (roomId: string, agentId: string) => `${roomId}\u0000${agentId}`;

const commandText = (command: unknown) => (Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '').trim();
/** PowerShell running exactly one quoted script: `pwsh.exe [-Flag…] -Command '<script>'`. Anything else is shown as is. */
const PWSH = /^(?:"[^"]*(?:pwsh|powershell)(?:\.exe)?"|\S*(?:pwsh|powershell)(?:\.exe)?)(?:\s+-(?!c\b|command\b)\w+)*\s+-(?:c|command)\s+(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)")\s*$/i;
/** Display form of a Codex command: the script inside a `pwsh.exe -Command '…'` wrapper, else the command itself; long ones end in '…'. */
export function commandTitle(command: unknown): string {
  const text = commandText(command), m = PWSH.exec(text);
  const inner = m ? (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]!.replace(/\\(.)/g, '$1')) : text;
  return inner.length > 300 ? inner.slice(0, 299) + '…' : inner;
}
/** The exact command for an approval card, so a summary can never hide what runs. */
function commandDetail(command: unknown): string {
  const full = commandText(command), max = 6000;
  return full.length > max ? `${full.slice(0, max)}\n… (${full.length - max} more characters not shown)` : full;
}
function modelInfo(m: any): ModelInfo | undefined {
  const id = typeof m?.model === 'string' ? m.model : typeof m?.id === 'string' ? m.id : undefined;
  if (!id || m.hidden) return undefined;
  const reasoning = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
    .map((r: any) => typeof r === 'string' ? r : r?.reasoningEffort).filter((e: unknown): e is string => typeof e === 'string');
  return { id, name: typeof m.displayName === 'string' && m.displayName ? m.displayName : id, ...(typeof m.description === 'string' ? { description: m.description } : {}),
    isDefault: !!m.isDefault, ...(typeof m.defaultReasoningEffort === 'string' ? { defaultReasoning: m.defaultReasoningEffort } : {}), reasoning, ultra: reasoning.includes('ultra') };
}
/** Per-thread config overrides (§5.4.2). */
function threadConfig(options: AgentOptions, mcpNames: string[], shared: Record<string, SharedMcpServer>): Record<string, unknown> {
  const config: Record<string, unknown> = { model_reasoning_summary: options.summary };
  if (options.webSearch !== undefined) config.web_search = options.webSearch === false ? 'disabled' : 'live';
  if (options.useMcp === false) {
    // Only servers from config.toml are named: the built-in apps server has no transport and fails the config when named.
    for (const name of mcpNames) if (!/[.\s"]/.test(name) && !(name in shared)) config[`mcp_servers.${name}.enabled`] = false;
    config['features.apps'] = false;
  }
  for (const [name, server] of Object.entries(shared ?? {})) {
    if (!server || /[.\s"]/.test(name)) continue;
    config[`mcp_servers.${name}`] = server.url ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }
      : { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) };
  }
  if (options.useProjectSettings === false) config.project_doc_max_bytes = 0;
  config.project_doc_fallback_filenames = ['CLAUDE.md'];
  return config;
}
/** Model and effort a thread/start or thread/resume reports for the thread. */
const threadState = (result: any): { model?: string; effort?: string } => ({ ...(typeof result?.model === 'string' && result.model ? { model: result.model } : {}),
  ...(typeof result?.reasoningEffort === 'string' && result.reasoningEffort ? { effort: result.reasoningEffort } : {}) });
function quotaOf(limits: any): Usage['quota'] | undefined {
  const primary = limits?.primary, secondary = limits?.secondary;
  if (!primary && !secondary) return undefined;
  const minutes = (w: any) => typeof w?.windowDurationMins === 'number' ? w.windowDurationMins : undefined;
  return { primaryUsedPercent: num(primary?.usedPercent), secondaryUsedPercent: num(secondary?.usedPercent),
    ...(minutes(primary) !== undefined ? { primaryWindowMinutes: minutes(primary) } : {}), ...(minutes(secondary) !== undefined ? { secondaryWindowMinutes: minutes(secondary) } : {}), observedAt: Date.now() };
}
/** The latest reset of an exhausted window, in ms (Codex reports Unix seconds). */
function resetOf(limits: any): number | undefined {
  const times = [limits?.primary, limits?.secondary].filter(w => num(w?.usedPercent) >= 100 && num(w?.resetsAt) > 0).map(w => w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt);
  return times.length ? Math.max(...times) : undefined;
}
const signedOut = (text: string) => /unauthori[sz]ed|not logged in|log ?in|sign in|authenticat/i.test(text);
function rpcFailure(what: string, error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signedOut(message(error))) return new ProviderError(SIGN_IN, 'signed-out');
  return new ProviderError(`${what}: ${message(error)}`, error instanceof RpcError ? 'failed' : 'protocol');
}

export class CodexDriver implements NativeDriver {
  readonly provider = 'codex' as const;
  private current?: Server;
  private starting?: Promise<Server>;
  private readonly handles = new Map<string, Handle>();
  private readonly live = new Map<string, Live>();
  private readonly totals = new Map<string, Breakdown>();
  /** Sub-agent thread → the running parent thread, so their approvals and room-tool calls reach the parent's turn. */
  private readonly parents = new Map<string, string>();
  private busy = 0;
  private idle?: NodeJS.Timeout;
  private disposed = false;
  constructor(private readonly host: DriverHost, private readonly spawnProcess?: typeof spawn) {}

  async turn(req: NativeTurnRequest): Promise<NativeTurnResult> {
    if (req.command && !req.agent.session?.id) return { text: `No session yet: nothing to ${req.command.name}.`, usage: emptyUsage(), status: 'complete' };
    if (req.signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
    this.busy++; clearTimeout(this.idle);
    // Setup (spawn, resume, inject) stops waiting on abort; the turn itself is interrupted natively.
    const stop = new Promise<never>((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    stop.catch(() => undefined);
    const until = <T>(work: Promise<T>) => Promise.race([work, stop]);
    try {
      const server = await until(this.server());
      await until(this.syncSkillRoots(server, req.room));
      const options = this.effective(req.agent.options, req.sink);
      const { handle, lost } = await until(this.thread(server, req, options));
      if (req.command) return await this.command(server, handle, req, options);
      const context = lost ? req.fullContext() : req.context;
      let prefix = '';
      if (context.trim()) {
        try { await until(server.rpc.request('thread/inject_items', { threadId: handle.threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: context }] }] }, 30_000)); }
        catch (error) { if (server.dead) throw server.dead; if (req.signal.aborted) throw error; prefix = context + '\n\n'; }
      }
      const request = req.ask || 'Continue.';
      const text = prefix + (req.editor ? codexEditorText(req.editor, request) : request);
      return await this.prompt(server, handle, req, options, [{ type: 'text', text, text_elements: [] }], text);
    } catch (error) {
      if (req.signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
      throw error instanceof ProviderError ? error : new ProviderError(message(error), 'failed');
    } finally { this.busy--; this.arm(); }
  }

  async capabilities(room: Room, agent: Agent): Promise<AgentCapabilities> {
    const base = { provider: 'codex' as const, runtime: 'cli' as const, models: [], efforts: [], tools: [], skills: [], commands: MAPPED, mcpServers: [],
      supports: this.supports(undefined), ...(agent.session?.context ? { context: agent.session.context } : {}), updatedAt: Date.now() };
    let server: Server;
    this.busy++;
    try { server = await this.server(); }
    catch (error) { this.busy--; this.arm(); return { ...base, status: error instanceof ProviderError && error.code === 'missing' ? 'missing' : 'error', detail: message(error) }; }
    try {
      await this.syncSkillRoots(server, room);
      const [account, skills, mcp] = await Promise.all([
        server.rpc.request('account/read', {}, 10_000).catch(() => undefined), this.skills(server, false),
        server.rpc.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }, 10_000).catch(() => undefined)]);
      const runtime = await this.host.runtime('codex').catch(() => undefined);
      await server.config;
      const model = this.modelFor(server, agent.model || server.configModel) ?? (agent.model ? undefined : this.modelFor(server, undefined));
      const defaultEffort = (!agent.model || agent.model === server.configModel) && server.configEffort ? server.configEffort : model?.defaultReasoning;
      const who = account?.account;
      const signedOutNow = !who && account?.requiresOpenaiAuth === true;
      const commands = filterNativeCommands('codex', [...MAPPED, ...skills.filter(s => !MAPPED.some(m => m.name === s.name)).map(s => ({ name: s.name, description: s.description, source: 'skill' as const }))]);
      return { ...base, status: signedOutNow ? 'signed-out' : 'ready', ...(signedOutNow ? { detail: SIGN_IN } : {}), ...(runtime ? { version: runtime.version } : {}),
        ...(who?.type === 'chatgpt' ? { account: [who.email, who.planType].filter(Boolean).join(' · ') } : who?.type === 'apiKey' ? { account: 'API key' } : {}),
        models: server.models, efforts: model?.reasoning ?? [], ...(defaultEffort ? { defaultEffort } : {}),
        skills: skills.map(s => ({ name: s.name, description: s.description, source: s.scope })), commands,
        mcpServers: (Array.isArray(mcp?.data) ? mcp.data : []).filter((s: any) => typeof s?.name === 'string')
          .map((s: any) => ({ name: s.name, status: String(s.runtimeStatus ?? (s.toolsError ? 'failed' : 'configured')), tools: Object.keys(s.tools ?? {}).length })),
        supports: this.supports(model) };
    } finally { this.busy--; this.arm(); }
  }

  async release(roomId: string, agentId?: string): Promise<void> {
    const released: Handle[] = [];
    for (const [key, handle] of [...this.handles]) {
      const [room, agent] = key.split('\u0000');
      if (room === roomId && (agentId === undefined || agent === agentId)) { this.handles.delete(key); released.push(handle); }
    }
    if (!this.handles.size && !this.live.size && !this.busy) { await this.shutdown(false); return; }
    // Unloaded threads take the current options on their next resume (a loaded thread ignores resume overrides).
    await Promise.all(released.filter(h => h.server === this.current && !h.server.dead && !this.live.has(h.threadId))
      .map(h => h.server.rpc.request('thread/unsubscribe', { threadId: h.threadId }, 10_000).catch(() => undefined)));
  }

  async dispose(): Promise<void> {
    this.disposed = true; clearTimeout(this.idle);
    const starting = this.starting;
    const stopping = this.shutdown(true);
    if (starting) await starting.then(server => server.proc.kill(), () => undefined);
    await stopping;
  }

  private supports(model: ModelInfo | undefined) {
    return { thinking: false, summary: true, sandbox: true, webSearch: true, useMcp: true, useSkills: false, useProjectSettings: true, extraDirs: true,
      ultraSession: !!model?.ultra, ultraTurn: !!model?.ultra, thinkHard: true, fullAccess: true, customAgent: false };
  }
  /** Full access needs chatroom.allowFullAccess, whatever the stored options say. */
  private effective(options: AgentOptions, sink: TurnSink): AgentOptions {
    const effective: AgentOptions = { ...options, extraDirs: Array.isArray(options.extraDirs) ? options.extraDirs : [] };
    if (!this.host.settings().allowFullAccess && (effective.permission === 'full' || effective.sandbox === 'danger-full-access')) {
      if (effective.permission === 'full') effective.permission = 'ask';
      if (effective.sandbox === 'danger-full-access') delete effective.sandbox;
      sink.activity({ id: 'full-access', kind: 'info', title: 'Full access is off in settings (chatroom.allowFullAccess) · using Ask', status: 'done', at: Date.now() });
    }
    return effective;
  }
  private modelFor(server: Server, id: string | undefined): ModelInfo | undefined {
    return id ? server.models.find(m => m.id === id) : server.models.find(m => m.isDefault);
  }
  private arm(): void {
    clearTimeout(this.idle);
    if (!this.current || this.busy || this.live.size || this.disposed) return;
    this.idle = setTimeout(() => { if (!this.busy && !this.live.size) void this.shutdown(false); }, Math.max(1000, this.host.settings().idleSessionMs));
    this.idle.unref?.();
  }
  private async shutdown(kill: boolean): Promise<void> {
    clearTimeout(this.idle);
    const server = this.current;
    this.current = undefined; this.handles.clear();
    if (!server) return;
    await (kill ? server.proc.kill() : server.proc.close(3000));
  }

  private server(): Promise<Server> {
    if (this.disposed) return Promise.reject(new ProviderError('Chatroom is shutting down.', 'crashed'));
    if (this.current && !this.current.dead) return Promise.resolve(this.current);
    return this.starting ??= this.start().finally(() => { this.starting = undefined; });
  }
  private async start(): Promise<Server> {
    const runtime = await this.host.runtime('codex');
    if (!runtime) throw new ProviderError('The Codex CLI was not found. Install the Codex VS Code extension or set chatroom.codexPath.', 'missing');
    const exe = runtime.executable, codexPath = join(dirname(exe.command), 'codex-path');
    const server = { models: [], mcpNames: [], extraRoots: '[]' } as unknown as Server;
    server.proc = spawnJsonl(exe, ['app-server'], {
      cwd: this.host.cwd(), env: childEnv(exe, 'codex', { pathPrepend: existsSync(codexPath) ? [codexPath] : [] }), spawnProcess: this.spawnProcess,
      onMessage: value => { server.rpc?.receive(value); },
      onExit: code => this.exited(server, code),
    });
    server.rpc = new RpcConnection(value => server.proc.send(value), {
      dialect: 'codex',
      onNotification: (method, params) => this.notification(server, method, params),
      onRequest: (method, params) => this.request(method, params),
    });
    try {
      await server.rpc.request('initialize', { clientInfo: { name: 'chatroom', title: 'Chatroom', version: this.host.version },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['remoteControl/status/changed'] } }, 20_000);
    } catch (error) {
      void server.proc.kill();
      if (server.dead) throw server.dead;
      throw new ProviderError(`Codex app-server did not start: ${message(error)}${server.proc.stderrTail.trim() ? '\n' + tail(server.proc.stderrTail.trim(), 1500) : ''}`, 'protocol');
    }
    server.rpc.notify('initialized');
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      try {
        const result = await server.rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 20_000);
        server.models.push(...(Array.isArray(result?.data) ? result.data : []).map(modelInfo).filter((m: ModelInfo | undefined): m is ModelInfo => !!m));
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      } catch { cursor = undefined; }
      if (!cursor) break;
    }
    const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
    server.config = server.rpc.request('config/read', { includeLayers: false, cwd: this.host.cwd() }, 10_000).then(result => {
      const config = result?.config && typeof result.config === 'object' ? result.config : {};
      server.mcpNames = Object.keys(config.mcp_servers && typeof config.mcp_servers === 'object' ? config.mcp_servers : {});
      server.configModel = text(config.model); server.configEffort = text(config.model_reasoning_effort);
    }, () => undefined);
    if (server.dead) throw server.dead;
    if (this.disposed) { void server.proc.kill(); throw new ProviderError('Chatroom is shutting down.', 'crashed'); }
    this.current = server;
    return server;
  }
  private exited(server: Server, code: number | null): void {
    const error = new ProviderError(`Codex app-server exited (code ${code}): ${tail(server.proc?.stderrTail.trim() ?? '', 1500) || 'no error output'}`, 'crashed');
    server.dead = error;
    server.rpc?.close(error);
    if (this.current === server) this.current = undefined;
    for (const [key, handle] of this.handles) if (handle.server === server) this.handles.delete(key);
    for (const live of [...this.live.values()]) if (live.server === server) live.crash(error);
  }
  private async syncSkillRoots(server: Server, room: Room): Promise<void> {
    const roots = room.shareSkills ? this.host.skillWiring()?.codexExtraRoots ?? [] : [];
    const key = JSON.stringify(roots);
    if (key === server.extraRoots) return;
    try { await server.rpc.request('skills/extraRoots/set', { extraRoots: roots }, 10_000); server.extraRoots = key; server.skills = undefined; }
    catch { /* Shared skills are optional. */ }
  }
  private skills(server: Server, force: boolean): Promise<Skill[]> {
    if (force || !server.skills) {
      const loading: Promise<Skill[]> = server.rpc.request('skills/list', { cwds: [this.host.cwd()], forceReload: force }, 15_000).then(result => {
        const seen = new Set<string>();
        return (Array.isArray(result?.data) ? result.data : []).flatMap((entry: any) => Array.isArray(entry?.skills) ? entry.skills : [])
          .filter((s: any) => typeof s?.name === 'string' && typeof s?.path === 'string' && s.enabled !== false && !seen.has(s.name) && !!seen.add(s.name))
          .map((s: any) => ({ name: s.name, description: String(s.shortDescription || s.description || ''), path: s.path, scope: String(s.scope ?? '') }));
      }, () => { if (server.skills === loading) server.skills = undefined; return []; });
      server.skills = loading;
    }
    return server.skills!;
  }

  /** Loads the agent's thread in this app-server: the live handle, a resume of the stored id, or a new thread. */
  private async thread(server: Server, req: NativeTurnRequest, options: AgentOptions): Promise<{ handle: Handle; lost: boolean }> {
    const { agent, room, sink } = req;
    const key = keyOf(room.id, agent.id), stored = agent.session?.id;
    const policy = codexPolicy(options, options.extraDirs);
    await server.config;
    const config = threadConfig(options, server.mcpNames, this.host.settings().sharedMcpServers ?? {});
    const configKey = JSON.stringify(config);
    const common = { cwd: this.host.cwd(), model: agent.model || null, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, approvalsReviewer: 'user',
      developerInstructions: req.framing, config };
    const existing = this.handles.get(key);
    if (existing && existing.server === server && existing.threadId === stored) {
      if (existing.configKey === configKey) return { handle: existing, lost: false };
      // A loaded thread ignores resume overrides: unload it, then resume it below with the new config.
      await server.rpc.request('thread/unsubscribe', { threadId: existing.threadId }, 10_000).catch(() => undefined);
      if (server.dead) throw server.dead;
      this.handles.delete(key);
    }
    let lost = false;
    if (stored) {
      try {
        const result = await server.rpc.request('thread/resume', { threadId: stored, ...common, excludeTurns: true }, 60_000);
        const handle: Handle = { server, threadId: stored, ...threadState(result), configKey };
        this.handles.set(key, handle);
        return { handle, lost: false };
      } catch (error) {
        if (server.dead) throw server.dead;
        if (req.command) throw new ProviderError(`The Codex session could not be resumed: ${message(error)}`, 'session-lost');
        lost = true;
      }
    }
    let result: any;
    try {
      result = await server.rpc.request('thread/start', { ...common,
        dynamicTools: this.host.roomTools.definitions().map(d => ({ type: 'function', name: d.name, description: d.description, inputSchema: d.inputSchema })) }, 60_000);
    } catch (error) { throw server.dead ?? rpcFailure('Codex could not start a session', error); }
    const id = result?.thread?.id;
    if (typeof id !== 'string' || !id) throw new ProviderError('Codex did not return a thread id.', 'protocol');
    const handle: Handle = { server, threadId: id, ...threadState(result), configKey };
    this.handles.set(key, handle);
    sink.session({ id, provider: 'codex', startedAt: Date.now() });
    if (lost) sink.activity({ id: 'resume', kind: 'info', title: 'Previous session could not be resumed · started a new one with recent room history', status: 'done', at: Date.now() });
    return { handle, lost };
  }

  /** A turn/start with the agent's model, effort, summary, sandbox and approval policy. */
  private prompt(server: Server, handle: Handle, req: NativeTurnRequest, options: AgentOptions, input: object[], inputText: string): Promise<NativeTurnResult> {
    const policy = codexPolicy(options, options.extraDirs);
    // "Default" model and effort mean the user's Codex config (then the thread's own), never the catalog's defaults.
    const resolvedModel = req.agent.model || server.configModel || handle.model || this.modelFor(server, undefined)?.id;
    const model = this.modelFor(server, resolvedModel);
    const efforts = model?.reasoning ?? [];
    const usable = (value: string | undefined) => !!value && (!efforts.length || efforts.includes(value));
    let effort = options.effort || [server.configEffort, handle.effort].find(usable) || model?.defaultReasoning || 'medium';
    if (req.flags?.think) effort = bumpEffort(effort, efforts.length ? efforts : ['low', 'medium', 'high']);
    if (req.flags?.ultra || options.ultra) {
      if (efforts.includes('ultra')) effort = 'ultra';
      else {
        effort = highest(efforts) ?? effort;
        req.sink.activity({ id: 'ultra', kind: 'info', title: `Ultra is not available for ${resolvedModel || 'this model'} · using ${effort} effort`, status: 'done', at: Date.now() });
      }
    }
    const params = { threadId: handle.threadId, input, ...(resolvedModel ? { model: resolvedModel } : {}), effort, summary: options.summary,
      approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy,
      ...(resolvedModel ? { collaborationMode: { mode: policy.plan ? 'plan' : 'default', settings: { model: resolvedModel, reasoning_effort: effort, developer_instructions: null } } } : {}) };
    return this.execute(server, handle, req, options, 'turn', inputText, () => server.rpc.request('turn/start', params, 60_000));
  }

  /** Runs one native turn on the thread and resolves at turn/completed (or interrupt, or crash). */
  private execute(server: Server, handle: Handle, req: NativeTurnRequest, options: AgentOptions, mode: Mode, inputText: string, send: () => Promise<any>): Promise<NativeTurnResult> {
    return new Promise<NativeTurnResult>((resolve, reject) => {
      let settled = false, compactTimer: NodeJS.Timeout | undefined, abortTimer: NodeJS.Timeout | undefined, interruptOnStart = false;
      const threads = new Set([handle.threadId]);
      const text = () => [...live.messages.values()].filter(t => t.trim()).join('\n\n');
      const finalText = () => mode === 'compact' ? 'Context compacted.' : text() || (mode === 'review' ? live.review ?? '' : '');
      const usage = (): Usage => live.total && live.baseline
        ? { ...emptyUsage(), input: Math.max(0, live.total.inputTokens - live.baseline.inputTokens), cached: Math.max(0, live.total.cachedInputTokens - live.baseline.cachedInputTokens),
          cacheWrite: Math.max(0, live.total.cacheWriteInputTokens - live.baseline.cacheWriteInputTokens), output: Math.max(0, live.total.outputTokens - live.baseline.outputTokens), requests: 1 }
        : { ...emptyUsage(), input: estimate(req.framing + inputText), output: estimate(finalText()), requests: 1, estimated: true };
      const finish = (run: () => void) => {
        if (settled) return; settled = true;
        clearTimeout(compactTimer); clearTimeout(abortTimer); req.signal.removeEventListener('abort', onAbort);
        for (const id of threads) if (this.live.get(id) === live) this.live.delete(id);
        for (const [child, parent] of this.parents) if (threads.has(parent)) this.parents.delete(child);
        run();
      };
      // Once Codex started the turn, the thread holds the input even if the turn is stopped.
      const stopped = (): NativeTurnResult => ({ text: text(), usage: usage(), status: 'interrupted', ...(live.turnId ? { delivered: true } : {}) });
      const interrupted = () => finish(() => resolve(stopped()));
      const interrupt = () => {
        if (!live.turnId) { interruptOnStart = true; return; }
        server.rpc.request('turn/interrupt', { threadId: live.threadId, turnId: live.turnId }, 5_000).catch(() => undefined);
      };
      const onAbort = () => { interrupt(); abortTimer = setTimeout(interrupted, 5_000); };
      const live: Live = {
        server, threadId: handle.threadId, agent: req.agent, sink: req.sink, signal: req.signal, permission: options.permission,
        messages: new Map(), thinking: '', reasoned: new Set(), activities: new Map(), changes: new Map(),
        turnStarted: () => { if (interruptOnStart) { interruptOnStart = false; interrupt(); } },
        crash: error => finish(() => req.signal.aborted ? resolve(stopped()) : reject(error)),
        compacted: () => { if (mode === 'compact') compactTimer ??= setTimeout(() => finish(() => resolve({ text: finalText(), usage: usage(), status: 'complete' })), 3_000); },
        complete: turn => {
          if (req.signal.aborted || turn?.status === 'interrupted') return interrupted();
          if (turn?.status !== 'failed') return finish(() => resolve({ text: finalText(), usage: usage(), status: 'complete' }));
          if (settled) return;
          void this.failure(server, turn?.error ?? live.lastError).then(error => finish(() => reject(error)));
        },
      };
      if (this.live.has(handle.threadId)) return reject(new ProviderError('This Codex agent is already running a turn.', 'failed'));
      this.live.set(handle.threadId, live);
      req.signal.addEventListener('abort', onAbort, { once: true });
      send().then(result => {
        const turnId = result?.turn?.id;
        if (typeof turnId === 'string' && !live.turnId) { live.turnId = turnId; live.turnStarted(); }
        const reviewThread = result?.reviewThreadId;
        if (mode === 'review' && typeof reviewThread === 'string' && reviewThread !== handle.threadId && !settled) { threads.add(reviewThread); this.live.set(reviewThread, live); }
      }, error => finish(() => req.signal.aborted ? resolve({ text: text(), usage: usage(), status: 'interrupted' }) : reject(server.dead ?? rpcFailure('Codex rejected the request', error))));
    });
  }

  private async failure(server: Server, error: any): Promise<ProviderError> {
    const info = error?.codexErrorInfo, text = typeof error?.message === 'string' && error.message ? error.message : 'Codex turn failed.';
    if (info === 'usageLimitExceeded') {
      let resetsAt: number | undefined;
      try { resetsAt = resetOf((await server.rpc.request('account/rateLimits/read', {}, 5_000))?.rateLimits); } catch { /* The reset time is optional. */ }
      return new ProviderError(`Codex usage limit reached.${resetsAt ? ` It resets ${new Date(resetsAt).toLocaleString()}.` : ''} Other agents can continue.`, 'usage-limit', resetsAt ? { resetsAt } : {});
    }
    if (info === 'unauthorized') return new ProviderError(SIGN_IN, 'signed-out');
    if (info === 'contextWindowExceeded') return new ProviderError(`${text} Run /compact for this agent.`, 'failed');
    return new ProviderError(text, 'failed');
  }

  private async command(server: Server, handle: Handle, req: NativeTurnRequest, options: AgentOptions): Promise<NativeTurnResult> {
    const { name, args } = req.command!;
    const threadId = handle.threadId, rpc = server.rpc;
    const plain = (text: string): NativeTurnResult => { req.sink.text(text); return { text, usage: emptyUsage(), status: 'complete' }; };
    const call = async (method: string, params: object) => { try { return await rpc.request(method, params, 30_000); } catch (error) { throw server.dead ?? rpcFailure(`Codex /${name} failed`, error); } };
    switch (name) {
      case 'compact': return this.execute(server, handle, req, options, 'compact', '', () => rpc.request('thread/compact/start', { threadId }, 30_000));
      case 'review': return this.execute(server, handle, req, options, 'review', args,
        () => rpc.request('review/start', { threadId, target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' }, delivery: 'inline' }, 30_000));
      case 'goal': {
        if (args.toLowerCase() === 'clear') { await call('thread/goal/clear', { threadId }); return plain('Goal cleared.'); }
        if (!args) {
          const goal = (await call('thread/goal/get', { threadId }))?.goal;
          return plain(goal ? `Goal: ${goal.objective} (${goal.status}${goal.tokenBudget ? `, ${num(goal.tokensUsed)} of ${goal.tokenBudget} tokens used` : ''})` : 'No goal set.');
        }
        await call('thread/goal/set', { threadId, objective: args, status: 'active' });
        return plain('Goal set: ' + args);
      }
      case 'mcp': {
        const servers = (await call('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId }))?.data;
        const lines = (Array.isArray(servers) ? servers : []).filter((s: any) => typeof s?.name === 'string')
          .map((s: any) => `- ${s.name} · ${s.runtimeStatus ?? (s.toolsError ? 'failed' : 'configured')} · ${Object.keys(s.tools ?? {}).length} tools${s.toolsError ? ` · ${s.toolsError}` : ''}`);
        return plain(lines.length ? 'MCP servers:\n' + lines.join('\n') : 'No MCP servers are configured for Codex.');
      }
      case 'skills': {
        const skills = await this.skills(server, true);
        return plain(skills.length ? 'Skills:\n' + skills.map(s => `- ${s.name}${s.scope ? ` (${s.scope})` : ''}${s.description ? `: ${s.description}` : ''}`).join('\n') : 'No skills found.');
      }
      case 'init': {
        const text = 'Create an AGENTS.md file with instructions for working in this repository.';
        return this.prompt(server, handle, req, options, [{ type: 'text', text, text_elements: [] }], text);
      }
    }
    const skill = (await this.skills(server, false)).find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!skill) throw new ProviderError(`Codex has no /${name} command.`, 'unsupported');
    const text = args || `Use the ${skill.name} skill.`;
    return this.prompt(server, handle, req, options, [{ type: 'skill', name: skill.name, path: skill.path }, { type: 'text', text, text_elements: [] }], text);
  }

  private notification(server: Server, method: string, params: any): void {
    if (method === 'skills/changed') { server.skills = undefined; return; }
    if (method === 'account/rateLimits/updated') {
      const quota = quotaOf(params?.rateLimits);
      if (quota) for (const live of new Set(this.live.values())) if (live.server === server) live.sink.session({ quota });
      return;
    }
    if (method === 'thread/started') return this.child(params?.thread?.id, params?.thread?.parentThreadId ?? params?.thread?.source?.subAgent?.thread_spawn?.parent_thread_id);
    const threadId = params?.threadId;
    if (typeof threadId !== 'string') return;
    const live = this.live.get(threadId);
    if (method === 'thread/tokenUsage/updated') return this.tokens(threadId, live, params?.tokenUsage);
    if (!live) {
      // A sub-agent's edits and commands show in its parent's turn (their diffs feed approval cards); its text stays its own.
      const parent = this.live.get(this.parents.get(threadId) ?? '');
      if (parent && (method === 'item/started' || method === 'item/completed') && ['fileChange', 'commandExecution'].includes(params?.item?.type)) this.item(parent, params.item, method === 'item/completed');
      return;
    }
    switch (method) {
      case 'turn/started': if (!live.turnId && typeof params?.turn?.id === 'string') { live.turnId = params.turn.id; live.turnStarted(); } return;
      case 'item/started': return this.item(live, params?.item, false);
      case 'item/completed': return this.item(live, params?.item, true);
      case 'item/agentMessage/delta':
        if (typeof params?.itemId !== 'string' || typeof params?.delta !== 'string') return;
        live.messages.set(params.itemId, (live.messages.get(params.itemId) ?? '') + params.delta);
        return this.emitText(live);
      case 'item/reasoning/summaryTextDelta': {
        if (typeof params?.delta !== 'string') return;
        const key = `${params.itemId}:${params.summaryIndex ?? 0}`;
        if (live.thinking && live.reasoningKey !== key) live.thinking += '\n\n';
        live.reasoningKey = key; live.reasoned.add(String(params.itemId));
        live.thinking = tail(live.thinking + params.delta, 40_000);
        return live.sink.thinking(live.thinking);
      }
      case 'item/commandExecution/outputDelta': {
        const previous = live.activities.get(String(params?.itemId));
        if (previous && typeof params?.delta === 'string') this.activity(live, { ...previous, detail: tail((previous.detail ?? '') + params.delta, 300) });
        return;
      }
      case 'turn/plan/updated': {
        const plan = Array.isArray(params?.plan) ? params.plan : [];
        const detail = plan.map((p: any) => (p?.status === 'completed' ? '✓ ' : p?.status === 'inProgress' ? '→ ' : '· ') + String(p?.step ?? '')).join('\n');
        return this.activity(live, { id: 'plan', kind: 'plan', title: 'Plan', detail, status: plan.length && plan.every((p: any) => p?.status === 'completed') ? 'done' : 'running' });
      }
      case 'error':
        if (params?.willRetry) this.activity(live, { id: 'retry', kind: 'info', title: `Retrying · ${String(params?.error?.message ?? 'connection problem').slice(0, 200)}`, status: 'running' });
        else live.lastError = params?.error;
        return;
      case 'thread/compacted': return live.compacted();
      case 'turn/completed':
        if (live.turnId && typeof params?.turn?.id === 'string' && params.turn.id !== live.turnId) return;
        return live.complete(params?.turn);
    }
  }
  private tokens(threadId: string, live: Live | undefined, usage: any): void {
    const total = usage?.total;
    if (!total || typeof total !== 'object') return;
    const breakdown = (b: any): Breakdown => ({ inputTokens: num(b?.inputTokens), cachedInputTokens: num(b?.cachedInputTokens), cacheWriteInputTokens: num(b?.cacheWriteInputTokens), outputTokens: num(b?.outputTokens) });
    const now = breakdown(total), last = breakdown(usage.last), previous = this.totals.get(threadId);
    this.totals.set(threadId, now);
    if (!live) return;
    live.baseline ??= previous ?? { inputTokens: Math.max(0, now.inputTokens - last.inputTokens), cachedInputTokens: Math.max(0, now.cachedInputTokens - last.cachedInputTokens),
      cacheWriteInputTokens: Math.max(0, now.cacheWriteInputTokens - last.cacheWriteInputTokens), outputTokens: Math.max(0, now.outputTokens - last.outputTokens) };
    live.total = now;
    const window = num(usage.modelContextWindow), tokens = last.inputTokens + last.outputTokens;
    if (window > 0) live.sink.session({ context: { tokens, window, percent: Math.round(100 * tokens / window) } });
  }
  private child(id: unknown, parent: unknown): void {
    if (typeof id !== 'string' || typeof parent !== 'string' || id === parent) return;
    const root = this.parents.get(parent) ?? parent;
    if (this.live.has(root)) this.parents.set(id, root);
  }
  private emitText(live: Live): void { live.sink.text([...live.messages.values()].filter(t => t.trim()).join('\n\n')); }
  private activity(live: Live, patch: Omit<ActivityItem, 'at'> & { at?: number }): void {
    const previous = live.activities.get(patch.id);
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<ActivityItem>;
    const next: ActivityItem = { ...previous, ...defined, at: previous?.at ?? Date.now() } as ActivityItem;
    live.activities.set(next.id, next);
    live.sink.activity({ ...next });
  }
  private item(live: Live, item: any, done: boolean): void {
    if (!item || typeof item.id !== 'string') return;
    const id = item.id, status = statusOf(item.status, done);
    switch (item.type) {
      case 'agentMessage':
        if (done && typeof item.text === 'string') { live.messages.set(id, item.text); this.emitText(live); }
        else if (!live.messages.has(id)) live.messages.set(id, typeof item.text === 'string' ? item.text : '');
        return;
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? item.summary.filter((s: unknown) => typeof s === 'string' && s) : [];
        if (!done || live.reasoned.has(id) || !summary.length) return;
        live.reasoned.add(id);
        live.thinking = tail((live.thinking ? live.thinking + '\n\n' : '') + summary.join('\n\n'), 40_000);
        return live.sink.thinking(live.thinking);
      }
      case 'commandExecution': {
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : live.activities.get(id)?.detail ?? '';
        const detail = done ? [typeof item.exitCode === 'number' ? `exit ${item.exitCode}` : '', tail(output, 300)].filter(Boolean).join('\n') : undefined;
        return this.activity(live, { id, kind: 'command', title: commandTitle(item.command) || 'Command', status, detail });
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map((c: any) => String(c?.path ?? '')).filter(Boolean).join(', ');
        const diff = changes.map((c: any) => typeof c?.diff === 'string' ? c.diff : '').filter(Boolean).join('\n').slice(0, 4000);
        live.changes.set(id, { paths, diff });
        const title = changes.map((c: any) => `${c?.kind?.type ?? 'update'} ${c?.path ?? ''}`.trim()).join(', ').slice(0, 300) || 'File changes';
        return this.activity(live, { id, kind: 'edit', title, status, ...(diff ? { diff } : {}) });
      }
      case 'mcpToolCall': return this.activity(live, { id, kind: 'mcp', title: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`, status, detail: item.error?.message ? String(item.error.message).slice(0, 300) : undefined });
      case 'dynamicToolCall': return this.activity(live, { id, kind: 'tool', title: `chatroom.${item.tool ?? 'tool'}`, status });
      case 'webSearch': return this.activity(live, { id, kind: 'search', title: String(item.query || item.action?.query || item.action?.url || 'Web search').slice(0, 300), status });
      case 'collabAgentToolCall':
        for (const child of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) this.child(child, live.threadId);
        return this.activity(live, { id, kind: 'subagent', title: String(item.tool ?? 'subagent'), status, detail: typeof item.prompt === 'string' ? item.prompt.slice(0, 300) : undefined });
      case 'subAgentActivity': return this.activity(live, { id, kind: 'subagent', title: String(item.kind ?? 'subagent'), status, detail: typeof item.agentPath === 'string' ? item.agentPath : undefined });
      case 'contextCompaction': return this.activity(live, { id, kind: 'compact', title: 'Compacting context', status });
      case 'plan': return this.activity(live, { id: 'plan', kind: 'plan', title: 'Plan', detail: typeof item.text === 'string' ? item.text.slice(0, 4000) : undefined, status: done ? 'done' : 'running' });
      case 'exitedReviewMode': if (done && typeof item.review === 'string') live.review = item.review; return;
    }
  }

  /** Server→client requests: approvals, dynamic room tools, and answers that keep Codex from blocking. */
  private async request(method: string, params: any): Promise<unknown> {
    const threadId = params?.threadId ?? params?.conversationId;
    const live = typeof threadId === 'string' ? this.live.get(threadId) ?? this.live.get(this.parents.get(threadId) ?? '') : undefined;
    const v2 = (d: ApprovalDecision) => d.decision === 'allow' ? 'accept' : d.decision === 'allow-session' ? 'acceptForSession' : 'decline';
    const v1 = (d: ApprovalDecision) => d.decision === 'allow' ? 'approved' : d.decision === 'allow-session' ? 'approved_for_session' : { denied: { rejection: d.message || 'The user denied this in Chatroom.' } };
    const where = (cwd: unknown, reason: unknown) => [typeof cwd === 'string' && cwd ? 'in ' + cwd : '', typeof reason === 'string' ? reason : ''].filter(Boolean).join('\n');
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : undefined;
        const network = params?.networkApprovalContext;
        const request: ApprovalRequest = { kind: network ? 'network' : 'command', tool: 'shell', title: commandTitle(params?.command) || (network?.host ? `Network access to ${network.host}` : 'Run a command'),
          detail: [commandDetail(params?.command), where(params?.cwd, params?.reason)].filter(Boolean).join('\n\n'), canAllowSession: !available || available.includes('acceptForSession') };
        return { decision: v2(await this.decide(live, request)) };
      }
      case 'item/fileChange/requestApproval': {
        const cached = live?.changes.get(String(params?.itemId));
        const detail = [typeof params?.reason === 'string' ? params.reason : '', typeof params?.grantRoot === 'string' && params.grantRoot ? `Write access to ${params.grantRoot}` : ''].filter(Boolean).join('\n');
        const request: ApprovalRequest = { kind: 'edit', tool: 'apply_patch', title: cached?.paths || (typeof params?.reason === 'string' && params.reason) || 'Edit files',
          ...(cached?.diff ? { diff: cached.diff } : {}), ...(detail ? { detail } : {}), canAllowSession: true };
        return { decision: v2(await this.decide(live, request)) };
      }
      case 'item/permissions/requestApproval': {
        const permissions = params?.permissions && typeof params.permissions === 'object' ? params.permissions : {};
        const granted = Object.fromEntries(Object.entries(permissions).filter(([, v]) => v !== null && v !== undefined));
        const request: ApprovalRequest = { kind: permissions.network ? 'network' : 'other', tool: 'permissions', title: (typeof params?.reason === 'string' && params.reason) || 'Extra permissions',
          detail: JSON.stringify(permissions, null, 2).slice(0, 4000), canAllowSession: true };
        const decision = await this.decide(live, request);
        return decision.decision === 'deny' ? { permissions: {}, scope: 'turn' } : { permissions: granted, scope: decision.decision === 'allow-session' ? 'session' : 'turn' };
      }
      case 'item/tool/call': {
        const fail = (text: string) => ({ contentItems: [{ type: 'inputText', text }], success: false });
        if (!live) return fail('Tool error: no Chatroom turn is running for this thread.');
        try {
          const result = await this.host.roomTools.call(live.agent.id, String(params?.tool ?? ''), params?.arguments ?? {}, live.signal);
          return { contentItems: [{ type: 'inputText', text: result.text }], success: !result.isError };
        } catch (error) { return fail('Tool error: ' + message(error)); }
      }
      case 'item/tool/requestUserInput': return { answers: {} };
      case 'mcpServer/elicitation/request': return { action: 'decline', content: null, _meta: null };
      case 'execCommandApproval': {
        const request: ApprovalRequest = { kind: 'command', tool: 'shell', title: commandTitle(params?.command) || 'Run a command',
          detail: [commandDetail(params?.command), where(params?.cwd, params?.reason)].filter(Boolean).join('\n\n'), canAllowSession: true };
        return { decision: v1(await this.decide(live, request)) };
      }
      case 'applyPatchApproval': {
        const files = params?.fileChanges && typeof params.fileChanges === 'object' ? Object.entries(params.fileChanges as Record<string, any>) : [];
        const diff = files.map(([path, c]) => `--- ${path}\n${c?.unified_diff ?? c?.content ?? ''}`).join('\n').slice(0, 4000);
        const request: ApprovalRequest = { kind: 'edit', tool: 'apply_patch', title: files.map(([path]) => path).join(', ') || 'Edit files', ...(diff ? { diff } : {}),
          ...(typeof params?.reason === 'string' && params.reason ? { detail: params.reason } : {}), canAllowSession: true };
        return { decision: v1(await this.decide(live, request)) };
      }
    }
    throw new RpcError(-32601, `Chatroom does not handle ${method}.`);
  }
  /** Plan never approves; full always does; otherwise the user decides on a card. Any failure denies. */
  private async decide(live: Live | undefined, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!live || live.signal.aborted) return { decision: 'deny' };
    if (live.permission === 'full') return { decision: 'allow' };
    if (live.permission === 'plan') return { decision: 'deny', message: 'Plan mode is read-only.' };
    try { return await live.sink.approval(request, live.signal); } catch { return { decision: 'deny' }; }
  }
}
