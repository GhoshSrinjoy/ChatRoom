import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { ActivityItem, Agent, AgentCapabilities, ApprovalKind, ApprovalRequest, DriverHost, DriverSettings, ModelInfo, NativeDriver, NativeTurnRequest, NativeTurnResult,
  PermissionLevel, ProviderError, Room, Runtime, SkillWiring, Usage, emptyUsage } from './types';
import { JsonlProcess, RpcConnection, RpcError, spawnJsonl } from './jsonl';
import { childEnv } from './process';
import { acpEditorBlocks } from './editor-context';
import { bumpEffort } from './codex-native';
import { filterNativeCommands } from './commands';

const INIT_MS = 20_000, SESSION_MS = 60_000, OPTION_MS = 10_000, PROMPT_MS = 12 * 3_600_000, STOP_MS = 5_000, COMMANDS_WAIT_MS = 2_000;
const MISSING = 'The GitHub Copilot CLI was not found. Install it to give Copilot its own tools, skills and sessions: npm i -g @github/copilot';
const SIGNED_OUT = 'Sign in to the GitHub Copilot CLI: run "copilot login" in a terminal, then try again.';
const RESUME_NOTE = 'Previous session could not be resumed · started a new one with recent room history';
/** Room tools the CLI may run without its own card: the read-only ones, and sandbox_run, whose gate is Chatroom's own approval card. */
const ROOM_TOOL = /\b(search_documents|read_document|semantic_search|ollama_ocr|sandbox_run)\b/;
/** A room tool's title when the CLI reports no server: exactly `chatroom-<tool>` (or `.`, `/`, `_` separators), nothing else. */
const ROOM_TOOL_TITLE = /^chatroom[-_/.]{1,2}(search_documents|read_document|semantic_search|ollama_ocr|sandbox_run)$/;
interface TurnState { req: NativeTurnRequest; text: string; thinking: string; breakPending: boolean; items: Map<string, ActivityItem>; command: boolean }
interface Live {
  key: string; roomId: string; agentId: string; spawnKey: string; proc: JsonlProcess; rpc: RpcConnection; ready: Promise<void>; version?: string;
  /** The agent's folder this process (and its sessions) started in. */
  cwd: string;
  sessionId?: string; unprompted: boolean; loading: boolean; retired: Set<string>;
  modes?: { currentModeId?: string; availableModes?: any[] }; models?: { currentModelId?: string; availableModels?: any[] }; configOptions: any[]; defaultModel?: string; defaultEffort?: string;
  commands?: any[]; commandWaiters: (() => void)[]; mcpNames: string[]; context?: { percent: number; tokens: number; window: number };
  applied: { model?: string; effort?: string; mode?: string; allowAll?: boolean; customAgent?: string };
  turn?: TurnState; onExit?: (code: number | null) => void; idle?: NodeJS.Timeout; closed: boolean;
}
const keyOf = (roomId: string, agentId: string) => `${roomId}\u0000${agentId}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const text = (value: string) => ({ type: 'text', text: value });
const effectivePermission = (agent: Agent, settings: DriverSettings): PermissionLevel =>
  agent.options?.permission === 'full' && !settings.allowFullAccess ? 'ask' : agent.options?.permission ?? 'ask';

/** Spawn arguments. `wiring` is passed only when the room shares skills; `--allow-all` only when a full-access session lacks the allow_all option. */
export function copilotArgs(agent: Agent, wiring: SkillWiring | undefined, settings: DriverSettings, forceAllowAll = false): string[] {
  const options = agent.options, dir = (path?: string) => path ? ['--add-dir', path] : [];
  return ['--acp', '--no-auto-update', '--no-color', '--log-level', 'warning', ...dir(wiring?.copilotAddDir), ...dir(wiring?.indexDir),
    ...(options.extraDirs ?? []).flatMap(path => dir(path)),
    ...(options.useProjectSettings === false ? ['--no-custom-instructions'] : []),
    ...(options.useMcp === false ? ['--disable-builtin-mcps'] : []),
    ...(forceAllowAll && effectivePermission(agent, settings) === 'full' ? ['--allow-all'] : [])];
}
function findOption(live: Live | undefined, id: string, category?: string): any | undefined {
  const options = (live?.configOptions ?? []).filter(o => o && typeof o === 'object');
  return options.find(o => o.id === id) ?? (category ? options.find(o => o.category === category) : undefined);
}
function optionChoices(option: any): { value: string; name: string; description?: string }[] {
  const flat = (list: unknown): any[] => Array.isArray(list) ? list.flatMap(o => Array.isArray(o?.options) ? flat(o.options) : [o]) : [];
  return flat(option?.options).filter(o => typeof o?.value === 'string').map(o => ({ value: o.value, name: str(o.name) || o.value, ...(str(o.description) ? { description: o.description } : {}) }));
}
const optionValues = (option: any) => optionChoices(option).map(o => o.value);
const ON = /^(on|true|enabled?|yes|allow[-_ ]?all|all)$/i, OFF = /^(off|false|disabled?|no|manual|ask)$/i;
const isOn = (value: unknown) => value === true || (typeof value === 'string' && ON.test(value));
/** Boolean config options may be modelled as a select of on/off values. */
function configValue(option: any, value: string | boolean): string | boolean {
  if (typeof value === 'string' || option?.type === 'boolean' || typeof option?.currentValue === 'boolean') return value;
  return optionValues(option).find(v => (value ? ON : OFF).test(v)) ?? value;
}
function mapKind(kind: unknown): ActivityItem['kind'] {
  if (kind === 'read') return 'read';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit';
  if (kind === 'search' || kind === 'fetch') return 'search';
  if (kind === 'execute') return 'command';
  return kind === 'think' ? 'info' : 'tool';
}
function mapStatus(status: unknown, fallback: ActivityItem['status'] = 'running'): ActivityItem['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'rejected') return 'declined';
  return status === 'pending' || status === 'in_progress' ? 'running' : fallback;
}
function blockText(content: unknown): string {
  if (Array.isArray(content)) return content.map(blockText).join('');
  const block = content as any;
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
}
function summary(input: unknown): string | undefined {
  if (typeof input === 'string') return input.slice(0, 300);
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description']) { const value = str(raw[key]); if (value) return value.slice(0, 300); }
  try { const json = JSON.stringify(raw); return json === '{}' ? undefined : json.slice(0, 300); } catch { return undefined; }
}
function outputText(content: unknown): string | undefined {
  const parts = Array.isArray(content) ? content.flatMap(c => c?.type === 'content' ? [blockText(c.content)] : []).filter(Boolean) : [];
  return parts.length ? parts.join('\n').slice(0, 300) : undefined;
}
export function simpleDiff(oldText: string | null | undefined, newText: string | null | undefined): string {
  const a = oldText ? oldText.split('\n') : [], b = newText ? newText.split('\n') : [];
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [...a.slice(start, endA).map(line => '-' + line), ...b.slice(start, endB).map(line => '+' + line)].join('\n');
}
function diffOf(content: unknown): string | undefined {
  const diffs = Array.isArray(content) ? content.filter(c => c?.type === 'diff' && typeof c.path === 'string') : [];
  return diffs.length ? diffs.map(d => `--- ${d.path}\n${simpleDiff(d.oldText, d.newText)}`).join('\n').slice(0, 4000) : undefined;
}
/** The MCP server of a tool call, from the CLI's own metadata only: rawInput holds the model's arguments and is never trusted. */
function serverOf(call: any): string | undefined {
  return [call?._meta?.mcpServerName, call?._meta?.serverName].find(v => typeof v === 'string' && v);
}
/**
 * Room tools are allowed here without a card of their own (they are read-only, or sandbox_run, which shows Chatroom's approval card
 * before anything runs): the chatroom server (from CLI metadata) with a room tool name, or exactly a room tool's title.
 */
function isRoomTool(call: any): boolean {
  if (['execute', 'edit', 'delete', 'move', 'fetch'].includes(call?.kind)) return false;
  const title = str(call?.title) ?? '', server = serverOf(call);
  return server ? server === 'chatroom' && (ROOM_TOOL.test(title) || ROOM_TOOL.test(str(call?._meta?.mcpToolName) ?? '')) : ROOM_TOOL_TITLE.test(title);
}
/** Every file path a tool call names (locations and the usual argument keys). */
function pathsOf(call: any): string[] {
  const raw = call?.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  return [...(Array.isArray(call?.locations) ? call.locations.map((l: any) => l?.path) : []), raw.path, raw.file_path, raw.filePath, ...(Array.isArray(raw.paths) ? raw.paths : [])]
    .filter((p: unknown): p is string => typeof p === 'string' && !!p);
}
/** True when the call names at least one path and every path is inside one of `roots`. */
function insideRoots(call: any, roots: string[]): boolean {
  const paths = pathsOf(call);
  return paths.length > 0 && paths.every(p => roots.some(root => { const rel = relative(root, resolve(root, p)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }));
}
function approvalKind(call: any): ApprovalKind {
  const kind = call?.kind;
  if (kind === 'execute') return 'command';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit';
  if (kind === 'fetch') return 'network';
  if (kind === 'read' || kind === 'search') return 'read';
  return serverOf(call) ? 'mcp' : 'other';
}
function usageOf(value: any): Usage | undefined {
  if (!value || typeof value !== 'object' || ![value.inputTokens, value.outputTokens, value.totalTokens].some(v => typeof v === 'number')) return undefined;
  return { ...emptyUsage(), input: num(value.inputTokens), output: num(value.outputTokens), cached: num(value.cachedReadTokens), cacheWrite: num(value.cachedWriteTokens), requests: 1 };
}
const estimate = (input: string, output: string): Usage => ({ ...emptyUsage(), input: Math.ceil(input.length / 3), output: Math.ceil(output.length / 3), requests: 1, estimated: true });
const isAuthError = (error: unknown) => error instanceof RpcError && /authenticat|not signed in|sign in|log ?in/i.test(error.message);
const signedOut = () => new ProviderError(SIGNED_OUT, 'signed-out', { action: 'copilotLogin' });
function providerError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isAuthError(error)) return signedOut();
  const text = message(error);
  if (/quota|rate.?limit|usage limit|premium request|ai credits|exceeded your/i.test(text)) return new ProviderError(`Copilot usage limit reached: ${text}`, 'usage-limit');
  return new ProviderError(`Copilot CLI: ${text}`, error instanceof RpcError ? 'failed' : 'protocol');
}

/** GitHub Copilot CLI over the Agent Client Protocol: one `copilot --acp` process and one session per (room, agent). */
export class CopilotDriver implements NativeDriver {
  readonly provider = 'copilot';
  private readonly lives = new Map<string, Live>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Agents whose sessions expose no allow_all option: full access then needs the --allow-all spawn flag. */
  private readonly allowAllFlag = new Set<string>();
  constructor(private readonly host: DriverHost, private readonly spawnProcess: typeof spawn = spawn) {}

  async turn(req: NativeTurnRequest): Promise<NativeTurnResult> {
    const { room, agent, signal } = req, key = keyOf(room.id, agent.id);
    const command = req.command ? req.command.name.trim().replace(/^\//, '').toLowerCase() : undefined;
    if (command !== undefined && !agent.session?.id) return { text: `No session yet: nothing to ${command}.`, usage: emptyUsage(), status: 'complete' };
    if (signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
    const runtime = await this.host.runtime('copilot');
    if (!runtime) throw new ProviderError(MISSING, 'missing', { action: 'installCopilot' });
    let prepared: { live: Live; fresh: boolean; resumeFailed: boolean; restore?: string; name?: string };
    try { prepared = await this.locked(key, () => this.prepare(req, runtime, command)); }
    catch (error) {
      // A process without a session (signed out, failed start) is closed; one with a session idles out as usual.
      const failed = this.lives.get(key);
      if (failed && !failed.turn) { if (failed.sessionId) this.arm(failed); else await this.close(failed); }
      if (signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
      throw providerError(error);
    }
    const { live, fresh, resumeFailed, restore } = prepared;
    if (signal.aborted) { this.arm(live); return { text: '', usage: emptyUsage(), status: 'interrupted' }; }
    let blocks: object[];
    if (command !== undefined) { const args = String(req.command?.args ?? '').trim(); blocks = [text('/' + prepared.name + (args ? ' ' + args : ''))]; }
    else {
      const context = resumeFailed ? req.fullContext() : req.context;
      // Copilot resolves a slash command only when the message starts with it, so /fleet leads and the room material follows it.
      blocks = req.flags?.ultra
        ? [text(['/fleet ' + (req.ask || 'Continue.'), fresh ? req.framing : '', context].filter(Boolean).join('\n\n')), ...(req.editor ? acpEditorBlocks(req.editor) : [])]
        : [...(fresh && req.framing ? [text(req.framing)] : []), ...(context ? [text(context)] : []), ...(req.editor ? acpEditorBlocks(req.editor) : []), text(req.ask || 'Continue.')];
    }
    try { return await this.prompt(live, req, blocks, command !== undefined); }
    finally {
      if (restore !== undefined) void this.locked(key, async () => { const option = findOption(live, 'reasoning_effort', 'thought_level'); if (option && await this.setConfig(live, option, restore)) live.applied.effort = restore; });
      this.arm(live);
    }
  }

  async capabilities(room: Room, agent: Agent): Promise<AgentCapabilities> {
    const runtime = await this.host.runtime('copilot').catch(() => undefined);
    if (!runtime) return this.caps(undefined, agent, { status: 'missing', detail: MISSING, action: 'installCopilot' });
    const key = keyOf(room.id, agent.id);
    try {
      return await this.locked(key, async () => {
        const live = await this.live(room, agent, runtime);
        if (!live.sessionId || (agent.session?.id && agent.session.id !== live.sessionId)) await this.session(live, agent, agent.session?.id, 'skip');
        this.arm(live);
        return this.caps(live, agent, { version: live.version ?? runtime.version });
      });
    } catch (error) {
      const failure = providerError(error), live = this.lives.get(key);
      if (live && !live.turn) await this.close(live);
      return this.caps(undefined, agent, { status: failure.code === 'signed-out' ? 'signed-out' : failure.code === 'missing' ? 'missing' : 'error', detail: failure.message, version: runtime.version,
        ...(failure.extra.action ? { action: failure.extra.action } : {}) });
    }
  }

  async release(roomId: string, agentId?: string): Promise<void> {
    await Promise.all([...this.lives.values()].filter(l => l.roomId === roomId && (agentId === undefined || l.agentId === agentId)).map(l => this.close(l)));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.lives.values()].map(live => { this.retire(live); return live.proc.kill(); }));
  }

  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /** Spawns or reuses the agent's process, opens its session and applies its options. Runs under the agent's lock. */
  private async prepare(req: NativeTurnRequest, runtime: Runtime, command: string | undefined) {
    const { room, agent } = req, key = keyOf(room.id, agent.id);
    let fresh = false, resumeFailed = false, stored = agent.session?.id, reported = agent.session?.id;
    for (let attempt = 0; ; attempt++) {
      const live = await this.live(room, agent, runtime);
      const opened = await this.session(live, agent, stored, command === undefined ? 'create' : 'throw');
      fresh ||= opened.fresh; resumeFailed ||= opened.resumeFailed;
      if (live.sessionId && live.sessionId !== reported) { reported = live.sessionId; req.sink.session({ id: live.sessionId, provider: 'copilot', startedAt: Date.now() }); }
      if (opened.resumeFailed) req.sink.activity({ id: 'resume', kind: 'info', title: RESUME_NOTE, status: 'done', at: Date.now() });
      stored = live.sessionId;
      if (command !== undefined) return { live, fresh, resumeFailed, name: await this.command(live, command) };
      if (attempt === 0 && effectivePermission(agent, this.host.settings()) === 'full' && !findOption(live, 'allow_all') && !this.allowAllFlag.has(key)) {
        this.allowAllFlag.add(key); await this.close(live); continue;
      }
      return { live, fresh, resumeFailed, restore: await this.applyOptions(live, req) };
    }
  }

  /** The agent's folder: its worktree while it is isolated, else the workspace. */
  private cwd(room: Room, agent: Agent): string { return this.host.cwdFor?.(room, agent) ?? this.host.cwd(); }

  private async live(room: Room, agent: Agent, runtime: Runtime): Promise<Live> {
    const key = keyOf(room.id, agent.id), settings = this.host.settings(), cwd = this.cwd(room, agent);
    const args = copilotArgs(agent, room.shareSkills ? this.host.skillWiring() : undefined, settings, this.allowAllFlag.has(key));
    const spawnKey = JSON.stringify([runtime.executable, args, settings.copilotUseEnvToken, cwd]);
    let live = this.lives.get(key);
    // A spawn-time change (the folder included) applies at the next turn; a running turn keeps its process.
    if (live && !live.closed && live.spawnKey !== spawnKey && !live.turn) { await this.close(live); live = undefined; }
    if (!live || live.closed) live = this.spawn(room.id, agent.id, key, spawnKey, runtime, args, settings, cwd);
    clearTimeout(live.idle);
    try { await live.ready; } catch (error) { await this.close(live); throw error; }
    return live;
  }

  private spawn(roomId: string, agentId: string, key: string, spawnKey: string, runtime: Runtime, args: string[], settings: DriverSettings, cwd: string): Live {
    let live!: Live;
    const proc = spawnJsonl(runtime.executable, args, { cwd, env: childEnv(runtime.executable, 'copilot', { keepGithubTokens: settings.copilotUseEnvToken }),
      onMessage: m => live?.rpc.receive(m), onExit: code => this.exited(live, code), spawnProcess: this.spawnProcess });
    const rpc = new RpcConnection(m => proc.send(m), { dialect: 'jsonrpc2',
      onNotification: (method, params) => { if (method === 'session/update') this.update(live, params); },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') return this.permission(live, params);
        throw new RpcError(-32601, `Chatroom does not support ${method}.`);
      } });
    live = { key, roomId, agentId, spawnKey, cwd, proc, rpc, ready: Promise.resolve(), unprompted: false, loading: false, retired: new Set(), configOptions: [], commandWaiters: [], mcpNames: [], applied: {}, closed: false };
    live.ready = this.initialize(live);
    live.ready.catch(() => undefined);
    this.lives.set(key, live);
    return live;
  }

  private async initialize(live: Live): Promise<void> {
    const exit = live.proc.exited.then(code => {
      const tail = live.proc.stderrTail.trim();
      throw /ENOENT|not recognized|cannot find/i.test(tail) ? new ProviderError(MISSING, 'missing', { action: 'installCopilot' })
        : new ProviderError(`The Copilot CLI exited before it was ready (code ${code}).${tail ? ' ' + tail.slice(-1500) : ''}`, 'crashed');
    });
    exit.catch(() => undefined);
    try {
      const result: any = await Promise.race([live.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'chatroom', version: this.host.version } }, INIT_MS), exit]);
      live.version = str(result?.agentInfo?.version);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(`The Copilot CLI did not complete the ACP handshake: ${message(error)}`, 'protocol');
    }
  }

  private exited(live: Live | undefined, code: number | null): void {
    if (!live) return;
    this.retire(live);
    const handler = live.onExit; live.onExit = undefined; handler?.(code);
  }

  private retire(live: Live): void {
    live.closed = true; clearTimeout(live.idle);
    if (this.lives.get(live.key) === live) this.lives.delete(live.key);
    live.rpc.close(new ProviderError(`The Copilot CLI process ended.${live.proc.stderrTail.trim() ? ' ' + live.proc.stderrTail.trim().slice(-1500) : ''}`, 'crashed'));
    live.commandWaiters.splice(0).forEach(wake => wake());
  }

  private async close(live: Live): Promise<void> {
    this.retire(live);
    await live.proc.close(3000);
  }

  private arm(live: Live): void {
    clearTimeout(live.idle);
    const ms = this.host.settings().idleSessionMs;
    if (live.closed || !(ms > 0)) return;
    live.idle = setTimeout(() => { if (!live.turn) void this.close(live); }, ms);
    live.idle.unref?.();
  }

  private async mcpServers(agent: Agent): Promise<object[]> {
    const pairs = (values?: Record<string, string>) => Object.entries(values ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    const servers: object[] = [];
    try {
      const { url, headers } = await this.host.roomTools.httpEndpoint(agent.id);
      servers.push({ type: 'http', name: 'chatroom', url, headers: pairs(headers) });
    } catch (error) { this.host.log(`Room tools are unavailable to ${agent.name}: ${message(error)}`, 'error'); }
    for (const [name, server] of Object.entries(this.host.settings().sharedMcpServers ?? {})) {
      if (name === 'chatroom' || !server || typeof server !== 'object') continue;
      if (server.url) servers.push({ type: 'http', name, url: server.url, headers: pairs(server.headers) });
      else if (server.command) servers.push({ name, command: server.command, args: server.args ?? [], env: pairs(server.env) });
    }
    return servers;
  }

  /** Reuses, loads or creates the session. `onLoadFailure`: create a new one (turns), throw (commands) or leave it (capabilities). */
  private async session(live: Live, agent: Agent, stored: string | undefined, onLoadFailure: 'create' | 'throw' | 'skip'): Promise<{ fresh: boolean; resumeFailed: boolean }> {
    if (live.sessionId && (live.sessionId === stored || (!stored && live.unprompted))) return { fresh: live.unprompted, resumeFailed: false };
    const servers = await this.mcpServers(agent), cwd = live.cwd;
    live.mcpNames = servers.map(s => (s as { name: string }).name);
    if (stored) {
      live.loading = true;
      try {
        const result = await live.rpc.request('session/load', { sessionId: stored, cwd, mcpServers: servers }, SESSION_MS);
        this.adopt(live, stored, result, false);
        return { fresh: false, resumeFailed: false };
      } catch (error) {
        if (isAuthError(error)) throw signedOut();
        if (live.closed) throw error;
        if (onLoadFailure === 'skip') return { fresh: false, resumeFailed: false };
        if (onLoadFailure === 'throw') throw new ProviderError(`Copilot could not resume this agent's session: ${message(error)}. Send a message to start a new one.`, 'session-lost');
        this.host.log(`Copilot session ${stored.slice(0, 8)} could not be resumed: ${message(error)}`, 'error');
      } finally { live.loading = false; }
    }
    let result: any;
    try { result = await live.rpc.request('session/new', { cwd, mcpServers: servers }, SESSION_MS); }
    catch (error) { throw isAuthError(error) ? signedOut() : error; }
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new ProviderError('The Copilot CLI returned no session id.', 'protocol');
    this.adopt(live, result.sessionId, result, true);
    return { fresh: true, resumeFailed: !!stored };
  }

  private adopt(live: Live, sessionId: string, result: any, created: boolean): void {
    if (live.sessionId && live.sessionId !== sessionId) live.retired.add(live.sessionId);
    live.sessionId = sessionId; live.unprompted = created; live.applied = {};
    if (result?.modes && typeof result.modes === 'object') live.modes = result.modes;
    if (result?.models && typeof result.models === 'object') live.models = result.models;
    if (Array.isArray(result?.configOptions)) live.configOptions = result.configOptions;
    live.defaultModel = str(findOption(live, 'model', 'model')?.currentValue) ?? str(live.models?.currentModelId);
    live.defaultEffort = str(findOption(live, 'reasoning_effort', 'thought_level')?.currentValue);
  }

  private async setConfig(live: Live, option: any, value: string | boolean, note?: (title: string) => void): Promise<boolean> {
    try {
      const result: any = await live.rpc.request('session/set_config_option', { sessionId: live.sessionId, configId: option.id, value: configValue(option, value) }, OPTION_MS);
      if (Array.isArray(result?.configOptions)) live.configOptions = result.configOptions;
      return true;
    } catch (error) { note?.(`Could not set ${str(option.name) ?? option.id}: ${message(error)}`); return false; }
  }

  private async request(live: Live, method: string, params: object, label: string, note: (title: string) => void): Promise<boolean> {
    try { await live.rpc.request(method, params, OPTION_MS); return true; } catch (error) { note(`Could not set ${label}: ${message(error)}`); return false; }
  }

  /** Applies model, mode, full access, custom agent and effort when they differ from what this process last applied. Returns the effort to restore after a think-hard turn. */
  private async applyOptions(live: Live, req: NativeTurnRequest): Promise<string | undefined> {
    const { agent } = req, options = agent.options, sessionId = live.sessionId;
    let notes = 0;
    const note = (title: string) => req.sink.activity({ id: `copilot-option-${++notes}`, kind: 'info', title, status: 'done', at: Date.now() });
    // '' keeps the CLI default; after an explicit model, '' returns to the session's original one.
    const model = agent.model || (live.applied.model !== undefined ? live.defaultModel : undefined);
    if (model && model !== live.applied.model) {
      const option = findOption(live, 'model', 'model');
      if (option ? await this.setConfig(live, option, model, note) : await this.request(live, 'session/set_model', { sessionId, modelId: model }, 'model', note)) live.applied.model = model;
    }
    const permission = effectivePermission(agent, this.host.settings()), modes = Array.isArray(live.modes?.availableModes) ? live.modes!.availableModes! : [];
    const modeId = str(modes.find(m => typeof m?.id === 'string' && m.id.endsWith(permission === 'plan' ? '#plan' : '#agent'))?.id);
    if (modeId && modeId !== (live.modes?.currentModeId ?? live.applied.mode) && await this.request(live, 'session/set_mode', { sessionId, modeId }, 'mode', note)) {
      live.applied.mode = modeId; if (live.modes) live.modes.currentModeId = modeId;
    }
    const allowAll = findOption(live, 'allow_all');
    if (allowAll && (permission === 'full') !== (live.applied.allowAll ?? isOn(allowAll.currentValue)) && await this.setConfig(live, allowAll, permission === 'full', note)) live.applied.allowAll = permission === 'full';
    const custom = findOption(live, 'agent');
    if (custom && options.customAgent && options.customAgent !== live.applied.customAgent && await this.setConfig(live, custom, options.customAgent, note)) live.applied.customAgent = options.customAgent;
    const effort = findOption(live, 'reasoning_effort', 'thought_level');
    if (!effort) return undefined;
    const values = optionValues(effort), current = live.applied.effort ?? str(effort.currentValue);
    let want = options.effort || (live.applied.effort !== undefined ? live.defaultEffort ?? '' : ''), restore: string | undefined;
    if (want && values.length && !values.includes(want)) { note(`Effort ${want} is not available for this model; using the CLI default.`); want = ''; }
    if (req.flags?.think && values.length) {
      const base = want || current || 'medium', bumped = bumpEffort(base, values);
      if (bumped && bumped !== base) { restore = want || current; want = bumped; }
    }
    if (want && want !== current && await this.setConfig(live, effort, want, note)) live.applied.effort = want;
    else if (want !== current) restore = undefined;
    return restore;
  }

  private async command(live: Live, name: string): Promise<string> {
    if (name === 'compact') return name;
    if (!live.commands && !live.closed) await new Promise<void>(resolve => { const timer = setTimeout(resolve, COMMANDS_WAIT_MS); live.commandWaiters.push(() => { clearTimeout(timer); resolve(); }); });
    const known = filterNativeCommands('copilot', (live.commands ?? []).filter(c => typeof c?.name === 'string').map(c => ({ name: c.name, source: 'builtin' as const })));
    const match = known.find(c => c.name.toLowerCase() === name);
    if (!match) throw new ProviderError(`The Copilot CLI has no /${name} command.`, 'unsupported');
    return match.name;
  }

  private prompt(live: Live, req: NativeTurnRequest, blocks: object[], command: boolean): Promise<NativeTurnResult> {
    const state: TurnState = { req, text: '', thinking: '', breakPending: false, items: new Map(), command };
    const sessionId = live.sessionId, signal = req.signal, input = blocks.map(b => blockText(b)).join('\n');
    live.turn = state;
    if (!command) live.unprompted = false;
    return new Promise<NativeTurnResult>((resolve, reject) => {
      let settled = false, killTimer: NodeJS.Timeout | undefined;
      const interrupted = (delivered = false): NativeTurnResult => ({ text: state.text, usage: estimate(input, state.text), status: 'interrupted', ...(delivered ? { delivered } : {}) });
      const finish = (run: () => void) => {
        if (settled) return; settled = true; clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        if (live.turn === state) live.turn = undefined;
        if (live.onExit === exit) live.onExit = undefined;
        run();
      };
      const abort = () => {
        try { live.rpc.notify('session/cancel', { sessionId }); } catch { /* The process is gone. */ }
        killTimer ??= setTimeout(() => finish(() => { void live.proc.kill(); resolve(interrupted()); }), STOP_MS);
      };
      const exit = (code: number | null) => finish(() => signal.aborted ? resolve(interrupted())
        : reject(new ProviderError(`The Copilot CLI exited during the turn (code ${code}).${live.proc.stderrTail.trim() ? ' ' + live.proc.stderrTail.trim().slice(-1500) : ''}`, 'crashed')));
      live.onExit = exit;
      signal.addEventListener('abort', abort, { once: true });
      live.rpc.request('session/prompt', { sessionId, prompt: blocks }, PROMPT_MS).then((result: any) => finish(() => {
        // The CLI answered this prompt, so its session holds it.
        if (result?.stopReason === 'cancelled' || signal.aborted) return resolve(interrupted(true));
        if (result?.stopReason === 'refusal') return reject(new ProviderError('Copilot refused the request.', 'failed'));
        resolve({ text: state.text, usage: usageOf(result?.usage) ?? estimate(input, state.text), status: 'complete' });
      }), error => finish(() => signal.aborted ? resolve(interrupted()) : reject(providerError(error))));
      if (signal.aborted) abort();
    });
  }

  private update(live: Live | undefined, params: any): void {
    const update = params?.update;
    if (!live || !update || typeof update !== 'object' || (typeof params.sessionId === 'string' && live.retired.has(params.sessionId))) return;
    const turn = live.turn;
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        live.commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        live.commandWaiters.splice(0).forEach(wake => wake());
        return this.pushCaps(live);
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') live.modes = { ...(live.modes ?? {}), currentModeId: update.currentModeId };
        return this.pushCaps(live);
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) live.configOptions = update.configOptions;
        return this.pushCaps(live);
      case 'usage_update': {
        const tokens = num(update.used), window = num(update.size);
        if (window > 0) { live.context = { tokens, window, percent: Math.round(100 * tokens / window) }; turn?.req.sink.session({ context: live.context }); }
        return;
      }
    }
    if (live.loading || !turn) return;
    const sink = turn.req.sink;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const chunk = blockText(update.content); if (!chunk) return;
        if (turn.breakPending && turn.text && !turn.text.endsWith('\n')) turn.text += '\n\n';
        turn.breakPending = false; turn.text += chunk; sink.text(turn.text); return;
      }
      case 'agent_thought_chunk': {
        const chunk = blockText(update.content); if (!chunk) return;
        turn.thinking = (turn.thinking + chunk).slice(-20000); sink.thinking(turn.thinking); return;
      }
      case 'tool_call': case 'tool_call_update': {
        const id = str(update.toolCallId); if (!id) return;
        const previous = turn.items.get(id), status = mapStatus(update.status, previous?.status);
        const location = Array.isArray(update.locations) ? str(update.locations[0]?.path) : undefined;
        const detail = (status === 'failed' ? outputText(update.content) : undefined) ?? location ?? summary(update.rawInput) ?? previous?.detail;
        const diff = diffOf(update.content) ?? previous?.diff;
        const item: ActivityItem = { id, kind: update.kind ? mapKind(update.kind) : previous?.kind ?? 'tool', title: str(update.title) || previous?.title || str(update.kind) || 'Tool', status, at: previous?.at ?? Date.now(),
          ...(detail ? { detail: detail.slice(0, 300) } : {}), ...(diff ? { diff } : {}) };
        turn.items.set(id, item); turn.breakPending = true; sink.activity(item); return;
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries.filter((e: any) => typeof e?.content === 'string') : [];
        sink.activity({ id: 'plan', kind: 'plan', title: 'Plan', status: entries.length && entries.every((e: any) => e.status === 'completed') ? 'done' : 'running', at: Date.now(),
          detail: entries.map((e: any) => (e.status === 'completed' ? '✓ ' : e.status === 'in_progress' ? '→ ' : '· ') + e.content).join('\n') });
        return;
      }
    }
  }

  private pushCaps(live: Live): void {
    const turn = live.turn;
    if (turn && !live.loading) turn.req.sink.capabilities(this.caps(live, turn.req.agent));
  }

  private async permission(live: Live | undefined, params: any): Promise<object> {
    const options: any[] = Array.isArray(params?.options) ? params.options.filter((o: any) => typeof o?.optionId === 'string') : [];
    const pick = (kind: string) => (options.find(o => o.kind === kind) ?? options.find(o => typeof o.kind === 'string' && o.kind.split('_')[0] === kind.split('_')[0]))?.optionId;
    const select = (optionId: string | undefined) => optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const turn = live?.turn, call = params?.toolCall ?? {}, kind = call.kind;
    if (!turn || turn.req.signal.aborted) return cancelled;
    if (isRoomTool(call)) return select(pick('allow_once'));
    const permission = effectivePermission(turn.req.agent, this.host.settings());
    if (permission === 'full') return select(pick('allow_once'));
    if (permission === 'plan' && ['edit', 'delete', 'move', 'execute'].includes(kind)) return select(pick('reject_once'));
    if (permission === 'auto-edit' && (kind === 'think' || (['read', 'edit', 'search'].includes(kind) && insideRoots(call, [live!.cwd, ...(turn.req.agent.options.extraDirs ?? [])].map(r => resolve(r))))))
      return select(pick('allow_once'));
    let detail: string | undefined;
    try { detail = call.rawInput === undefined ? undefined : JSON.stringify(call.rawInput, null, 2)?.slice(0, 4000); } catch { detail = undefined; }
    const diff = diffOf(call.content);
    const request: ApprovalRequest = { kind: approvalKind(call), tool: str(kind) ?? serverOf(call) ?? 'tool', title: str(call.title) || summary(call.rawInput) || 'Copilot wants to use a tool',
      canAllowSession: options.some(o => o.kind === 'allow_always'), ...(detail ? { detail } : {}), ...(diff ? { diff } : {}) };
    try {
      const decision = await turn.req.sink.approval(request, turn.req.signal);
      if (turn.req.signal.aborted) return cancelled;
      return select(decision.decision === 'allow' ? pick('allow_once') : decision.decision === 'allow-session' ? pick('allow_always') ?? pick('allow_once') : pick('reject_once'));
    } catch { return turn.req.signal.aborted ? cancelled : select(pick('reject_once')); }
  }

  private caps(live: Live | undefined, agent: Agent, extra: Partial<AgentCapabilities> = {}): AgentCapabilities {
    const effort = findOption(live, 'reasoning_effort', 'thought_level'), efforts = optionValues(effort);
    const skillNames = new Set((this.host.skillWiring()?.skills ?? []).map(s => s.name.toLowerCase()));
    const raw = (live?.commands ?? []).filter(c => typeof c?.name === 'string');
    const commands = filterNativeCommands('copilot', raw.map(c => ({ name: c.name, description: str(c.description), argumentHint: str(c.input?.hint), source: skillNames.has(c.name.toLowerCase()) ? 'skill' as const : 'builtin' as const })));
    const modelOption = findOption(live, 'model', 'model');
    const listed: ModelInfo[] = modelOption ? optionChoices(modelOption).map(o => ({ id: o.value, name: o.name, ...(o.description ? { description: o.description } : {}), ...(o.value === live?.defaultModel ? { isDefault: true } : {}) }))
      : (Array.isArray(live?.models?.availableModels) ? live!.models!.availableModels! : []).filter(m => typeof m?.modelId === 'string')
        .map(m => ({ id: m.modelId, name: str(m.name) || m.modelId, ...(str(m.description) ? { description: m.description } : {}), ...(m.modelId === live?.defaultModel ? { isDefault: true } : {}) }));
    // The CLI can list the same model twice (e.g. "auto" as a placeholder and as the enabled entry); keep the first.
    const models = listed.filter((m, i) => listed.findIndex(o => o.id === m.id) === i);
    const agents = optionValues(findOption(live, 'agent'));
    return { provider: 'copilot', runtime: 'cli', status: 'ready', ...(live?.version ? { version: live.version } : {}),
      models, efforts, ...(str(effort?.currentValue) ? { defaultEffort: effort.currentValue } : {}), tools: [],
      skills: raw.filter(c => skillNames.has(c.name.toLowerCase())).map(c => ({ name: c.name, ...(str(c.description) ? { description: c.description } : {}), source: 'skill' })),
      commands, mcpServers: (live?.mcpNames ?? []).map(name => ({ name, status: 'configured' })), ...(agents.length ? { agents } : {}),
      supports: { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: true, useSkills: false, useProjectSettings: true, extraDirs: true,
        ultraSession: false, ultraTurn: true, thinkHard: efforts.length > 0, fullAccess: true, customAgent: true },
      ...((live?.context ?? agent.session?.context) ? { context: live?.context ?? agent.session?.context } : {}), updatedAt: Date.now(), ...extra };
  }
}
