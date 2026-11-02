import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ActivityItem, Agent, AgentCapabilities, ApprovalKind, ApprovalRequest, DriverHost, DriverSettings, ModelInfo, NativeDriver, NativeTurnRequest, NativeTurnResult,
  PermissionLevel, ProviderError, Room, Runtime, SkillWiring, emptyUsage } from './types';
import { JsonlProcess, RpcConnection, RpcError, spawnJsonl } from './jsonl';
import { childEnv } from './process';
import { acpEditorBlocks } from './editor-context';
import { blockText, diffOf, estimate, insideRoots, mapKind, mapStatus, outputText, summary, usageOf } from './copilot-native';
import { filterNativeCommands } from './commands';
import { disabledNames } from './core';
import { GEMINI_MIN_VERSION } from './catalog';

const ANSWER_MS = 30_000, OPTION_MS = 10_000, PROMPT_MS = 12 * 3_600_000, STOP_MS = 5_000, COMMANDS_WAIT_MS = 2_000, REPLAY_QUIET_MS = 200, REPLAY_MAX_MS = 5_000;
const MISSING = 'The Gemini CLI was not found. Install it to add Gemini to the room: npm i -g @google/gemini-cli';
const outdated = (version: string) => `Gemini CLI ${version} is too old: Chatroom needs ${GEMINI_MIN_VERSION} or newer. Update it: npm i -g @google/gemini-cli@latest`;
const SIGNED_OUT = 'Sign in to the Gemini CLI: run "gemini" in a terminal and log in, or set GEMINI_API_KEY, then try again.';
const RETIRED = 'Google stopped serving the Gemini CLI to free, Google One, AI Pro and AI Ultra logins on June 18, 2026. It still works with a paid Gemini API key (GEMINI_API_KEY) or a Gemini Code Assist Standard or Enterprise license.';
/** With a Google login selected and none saved, the CLI asks on the console at startup and takes our first message as the reply, so that message is never answered. */
const NO_ANSWER = 'The Gemini CLI did not answer in time. It is probably waiting for a sign-in it cannot ask for here.';
/** The CLI's exit code when it cannot sign in. */
const AUTH_EXIT = 41;
const COMPACT_NOTE = 'The Gemini CLI compresses its own session when it fills up; it has no compact command here.';
const RESUME_NOTE = 'Previous session could not be resumed · started a new one with recent room history';
const DENY_MESSAGE = 'The user turned this off in Chatroom.';
/** Room tools the CLI runs without a card of its own: the read-only ones, and sandbox_run, whose gate is Chatroom's own approval card. */
const ROOM_TOOLS = ['search_documents', 'read_document', 'semantic_search', 'ollama_ocr', 'sandbox_run'];
const WEB_TOOLS = ['google_web_search', 'web_fetch'];
const MODES: Record<PermissionLevel, string> = { plan: 'plan', ask: 'default', 'auto-edit': 'autoEdit', full: 'yolo' };
interface TurnState { req: NativeTurnRequest; text: string; thinking: string; breakPending: boolean; items: Map<string, ActivityItem> }
interface Live {
  key: string; roomId: string; agentId: string; spawnKey: string; proc: JsonlProcess; rpc: RpcConnection; ready: Promise<void>; version?: string;
  /** The agent's folder this process (and its sessions) started in. */
  cwd: string;
  sessionId?: string; unprompted: boolean; retired: Set<string>;
  /** While a resumed session replays its history: its updates are not part of any turn. */
  loading: boolean; lastUpdate: number;
  modes?: { currentModeId?: string; availableModes?: any[] }; models?: { currentModelId?: string; availableModels?: any[] }; defaultModel?: string;
  commands?: any[]; commandWaiters: (() => void)[]; mcpNames: string[]; context?: { percent: number; tokens: number; window: number };
  applied: { model?: string };
  turn?: TurnState; onExit?: (code: number | null) => void; idle?: NodeJS.Timeout; closed: boolean;
}
const keyOf = (roomId: string, agentId: string) => `${roomId}\u0000${agentId}`;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const text = (value: string) => ({ type: 'text', text: value });
const effectivePermission = (agent: Agent, settings: DriverSettings): PermissionLevel =>
  agent.options?.permission === 'full' && !settings.allowFullAccess ? 'ask' : agent.options?.permission ?? 'ask';
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** A rule reaches a server through its tools' names, which keep only these characters and at most 64 in all. */
const ruleReaches = (server: string) => server.length <= 25 && /^[\w.:-]+$/.test(server);
/** Spawn arguments. `wiring` is passed only when the room shares skills; `allowed` only when a turned-off server cannot be denied by a rule. */
export function geminiArgs(agent: Agent, wiring: SkillWiring | undefined, policy: string | undefined, allowed?: string[]): string[] {
  const options = agent.options, dirs = [...(wiring?.indexDir ? [wiring.indexDir] : []), ...(wiring?.geminiDirs ?? []), ...(options.extraDirs ?? [])];
  return ['--acp', ...dirs.flatMap(dir => ['--include-directories', dir]), ...(policy ? ['--policy', policy] : []),
    ...(options.useMcp === false ? ['chatroom'] : allowed ?? []).flatMap(name => ['--allowed-mcp-server-names', name])];
}
/** TOML basic strings take JSON's escapes. */
const tomlString = (value: string) => JSON.stringify(value);
const rule = (fields: Record<string, string>, decision: 'allow' | 'deny', priority: number) => ['[[rule]]',
  ...Object.entries(fields).map(([key, value]) => `${key} = ${tomlString(value)}`), `decision = "${decision}"`, `priority = ${priority}`,
  ...(decision === 'deny' ? [`denyMessage = ${tomlString(DENY_MESSAGE)}`] : []), ''].join('\n');
/** The agent's policy rules: room tools run without a card, and what the user turned off is denied, which also hides a whole tool from the model. */
export function geminiPolicy(agent: Agent): string {
  const options = agent.options, escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const denied = [...new Set([...disabledNames(agent, 'tools'), ...(options.webSearch === false ? WEB_TOOLS : []), ...(options.useSkills === false ? ['activate_skill'] : [])])];
  return ['# Written by Chatroom for one run of the Gemini CLI.', '',
    ...ROOM_TOOLS.map(toolName => rule({ mcpName: 'chatroom', toolName }, 'allow', 900)),
    ...denied.map(toolName => rule({ toolName }, 'deny', 999)),
    // The CLI's documented form without toolName does not stop anything: it takes the wildcard.
    ...disabledNames(agent, 'mcpServers').filter(ruleReaches).map(mcpName => rule({ mcpName, toolName: '*' }, 'deny', 999)),
    ...disabledNames(agent, 'skills').map(name => rule({ toolName: 'activate_skill', argsPattern: `"name":"${escaped(name)}"` }, 'deny', 999))].join('\n');
}
/** MCP servers in a Gemini settings file (which allows full-line comments). A missing or unreadable file has none. */
async function settingsServers(path: string): Promise<string[]> {
  try {
    const servers = JSON.parse((await readFile(path, 'utf8')).replace(/^\s*\/\/.*$/gm, ''))?.mcpServers;
    return servers && typeof servers === 'object' ? Object.keys(servers) : [];
  } catch { return []; }
}
function approvalKind(call: any): ApprovalKind {
  const kind = call?.kind;
  if (kind === 'execute') return 'command';
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'edit';
  if (kind === 'fetch') return 'network';
  if (kind === 'read' || kind === 'search') return 'read';
  return kind === 'switch_mode' ? 'plan' : 'other';
}
/** -32000 is ACP's "authentication required", which the CLI answers with its reason for any failed sign-in. */
const isAuthError = (error: unknown) => error instanceof RpcError && (error.code === 401 || error.code === -32000 || /authenticat|not signed in|sign in|log ?in|api key|credential/i.test(error.message));
const isTimeout = (error: unknown) => !(error instanceof ProviderError) && !(error instanceof RpcError) && /timed? ?out/i.test(message(error));
const isRetired = (text: string) => /antigravity|no longer (?:available|supported|serv)|not eligible|ineligible/i.test(text);
function providerError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const detail = message(error), code = error instanceof RpcError ? error.code : 0;
  if (code === 403 || isRetired(detail)) return new ProviderError(`${RETIRED} The CLI said: ${detail}`, 'signed-out', { action: 'geminiLogin' });
  if (isAuthError(error)) return new ProviderError(`${SIGNED_OUT} The CLI said: ${detail}`, 'signed-out', { action: 'geminiLogin' });
  if (code === 429 || /quota|rate.?limit|exhausted|resource_exhausted/i.test(detail)) return new ProviderError(`Gemini usage limit reached: ${detail}`, 'usage-limit');
  if (code === 404 && /model/i.test(detail)) return new ProviderError(`Gemini model not available: ${detail}`, 'model-unavailable');
  return new ProviderError(`Gemini CLI: ${detail}`, error instanceof RpcError ? 'failed' : 'protocol');
}
const loginFailed = (tail: string) => providerError(new RpcError(401, tail.trim().slice(-1500) || 'Authentication failed.'));
const noAnswer = () => new ProviderError(`${NO_ANSWER} ${SIGNED_OUT}`, 'signed-out', { action: 'geminiLogin' });

/** The Gemini CLI over the Agent Client Protocol: one `gemini --acp` process and one session per (room, agent). */
export class GeminiDriver implements NativeDriver {
  readonly provider = 'gemini';
  private readonly lives = new Map<string, Live>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly host: DriverHost, private readonly spawnProcess: typeof spawn = spawn, private readonly answerMs = ANSWER_MS) {}

  async turn(req: NativeTurnRequest): Promise<NativeTurnResult> {
    const { room, agent, signal } = req, key = keyOf(room.id, agent.id);
    const command = req.command ? req.command.name.trim().replace(/^\//, '').toLowerCase() : undefined;
    if (command !== undefined && !agent.session?.id) return { text: `No session yet: nothing to ${command}.`, usage: emptyUsage(), status: 'complete' };
    if (command === 'compact') return { text: COMPACT_NOTE, usage: emptyUsage(), status: 'complete' };
    if (signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
    const runtime = await this.usableRuntime();
    let prepared: { live: Live; fresh: boolean; resumeFailed: boolean; name?: string };
    try { prepared = await this.locked(key, () => this.prepare(req, runtime, command)); }
    catch (error) {
      // A process without a session (signed out, failed start) is closed; one with a session idles out as usual.
      const failed = this.lives.get(key);
      if (failed && !failed.turn) { if (failed.sessionId) this.arm(failed); else await this.close(failed); }
      if (signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
      throw providerError(error);
    }
    const { live, fresh, resumeFailed } = prepared;
    if (signal.aborted) { this.arm(live); return { text: '', usage: emptyUsage(), status: 'interrupted' }; }
    let blocks: object[];
    if (command !== undefined) { const args = String(req.command?.args ?? '').trim(); blocks = [text('/' + prepared.name + (args ? ' ' + args : ''))]; }
    else {
      const context = resumeFailed ? req.fullContext() : req.context;
      blocks = [...(fresh && req.framing ? [text(req.framing)] : []), ...(context ? [text(context)] : []), ...(req.editor ? acpEditorBlocks(req.editor) : []), text(req.ask || 'Continue.')];
    }
    try { return await this.prompt(live, req, blocks, command !== undefined); }
    finally { this.arm(live); }
  }

  async capabilities(room: Room, agent: Agent): Promise<AgentCapabilities> {
    const found = await this.host.runtime('gemini').catch(() => undefined);
    if (!found) return this.caps(undefined, agent, { status: 'missing', detail: MISSING, action: 'installGemini' });
    if (!found.modern) return this.caps(undefined, agent, { status: 'missing', detail: outdated(found.version), version: found.version, action: 'updateGemini' });
    const key = keyOf(room.id, agent.id);
    try {
      return await this.locked(key, async () => {
        const live = await this.live(room, agent, found);
        if (!live.sessionId || (agent.session?.id && agent.session.id !== live.sessionId)) await this.session(live, agent, agent.session?.id, 'skip');
        if (live.sessionId) await this.commandsListed(live);
        this.arm(live);
        return this.caps(live, agent, { version: live.version ?? found.version });
      });
    } catch (error) {
      const failure = providerError(error), live = this.lives.get(key);
      if (live && !live.turn) await this.close(live);
      return this.caps(undefined, agent, { status: failure.code === 'signed-out' ? 'signed-out' : failure.code === 'missing' ? 'missing' : 'error', detail: failure.message, version: found.version,
        ...(failure.extra.action ? { action: failure.extra.action } : {}) });
    }
  }

  async release(roomId: string, agentId?: string): Promise<void> {
    await Promise.all([...this.lives.values()].filter(l => l.roomId === roomId && (agentId === undefined || l.agentId === agentId)).map(l => this.close(l)));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.lives.values()].map(live => { this.retire(live); return live.proc.kill(); }));
  }

  private async usableRuntime(): Promise<Runtime> {
    const runtime = await this.host.runtime('gemini');
    if (!runtime) throw new ProviderError(MISSING, 'missing', { action: 'installGemini' });
    if (!runtime.modern) throw new ProviderError(outdated(runtime.version), 'missing', { action: 'updateGemini' });
    return runtime;
  }

  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  /** Spawns or reuses the agent's process, opens its session and applies its options. Runs under the agent's lock. */
  private async prepare(req: NativeTurnRequest, runtime: Runtime, command: string | undefined) {
    const { room, agent } = req;
    const live = await this.live(room, agent, runtime);
    const stored = agent.session?.id, opened = await this.session(live, agent, stored, command === undefined ? 'create' : 'throw');
    if (live.sessionId && live.sessionId !== stored) req.sink.session({ id: live.sessionId, provider: 'gemini', startedAt: Date.now() });
    if (opened.resumeFailed) req.sink.activity({ id: 'resume', kind: 'info', title: RESUME_NOTE, status: 'done', at: Date.now() });
    if (command !== undefined) return { live, fresh: opened.fresh, resumeFailed: opened.resumeFailed, name: await this.command(live, command) };
    await this.applyOptions(live, req);
    return { live, fresh: opened.fresh, resumeFailed: opened.resumeFailed };
  }

  /** The agent's folder: its worktree while it is isolated, else the workspace. */
  private cwd(room: Room, agent: Agent): string { return this.host.cwdFor?.(room, agent) ?? this.host.cwd(); }

  /** Writes the policy under a name taken from its content, so agents with the same rules share one file and none piles up per agent. */
  private async policyFile(agent: Agent): Promise<string> {
    const content = geminiPolicy(agent), dir = join(this.host.storageDir(), 'gemini-policy');
    const path = join(dir, `policy-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.toml`);
    await mkdir(dir, { recursive: true });
    await writeFile(path, content);
    return path;
  }

  private async live(room: Room, agent: Agent, runtime: Runtime): Promise<Live> {
    const key = keyOf(room.id, agent.id), cwd = this.cwd(room, agent), policy = await this.policyFile(agent);
    const args = geminiArgs(agent, room.shareSkills ? this.host.skillWiring() : undefined, policy, await this.allowList(agent, cwd));
    const spawnKey = JSON.stringify([runtime.executable, args, cwd, disabledNames(agent, 'mcpServers'), this.host.settings().sharedMcpServers ?? {}]);
    let live = this.lives.get(key);
    // A spawn-time change (the folder included) applies at the next turn; a running turn keeps its process.
    if (live && !live.closed && live.spawnKey !== spawnKey && !live.turn) { await this.close(live); live = undefined; }
    if (!live || live.closed) live = this.spawn(room.id, agent.id, key, spawnKey, runtime, args, cwd);
    clearTimeout(live.idle);
    try { await live.ready; } catch (error) { await this.close(live); throw error; }
    return live;
  }

  private spawn(roomId: string, agentId: string, key: string, spawnKey: string, runtime: Runtime, args: string[], cwd: string): Live {
    let live!: Live;
    // Chatroom runs only in a workspace the user trusted in VS Code, so the CLI does not start in its restricted mode.
    const env = { ...childEnv(runtime.executable, 'gemini'), GEMINI_CLI_TRUST_WORKSPACE: 'true' };
    const proc = spawnJsonl(runtime.executable, args, { cwd, env,
      onMessage: m => live?.rpc.receive(m), onExit: code => this.exited(live, code), spawnProcess: this.spawnProcess });
    const rpc = new RpcConnection(m => proc.send(m), { dialect: 'jsonrpc2',
      onNotification: (method, params) => { if (method === 'session/update') this.update(live, params); },
      onRequest: async (method, params) => {
        if (method === 'session/request_permission') return this.permission(live, params);
        throw new RpcError(-32601, `Chatroom does not support ${method}.`);
      } });
    live = { key, roomId, agentId, spawnKey, cwd, proc, rpc, ready: Promise.resolve(), unprompted: false, loading: false, lastUpdate: 0, retired: new Set(), commandWaiters: [], mcpNames: [], applied: {}, closed: false };
    live.ready = this.initialize(live);
    live.ready.catch(() => undefined);
    this.lives.set(key, live);
    return live;
  }

  private async initialize(live: Live): Promise<void> {
    const exit = live.proc.exited.then(code => {
      const tail = live.proc.stderrTail.trim();
      throw /ENOENT|not recognized|cannot find/i.test(tail) ? new ProviderError(MISSING, 'missing', { action: 'installGemini' })
        : code === AUTH_EXIT ? loginFailed(tail)
        : new ProviderError(`The Gemini CLI exited before it was ready (code ${code}).${tail ? ' ' + tail.slice(-1500) : ''}`, 'crashed');
    });
    exit.catch(() => undefined);
    try {
      const result: any = await Promise.race([live.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'chatroom', version: this.host.version } }, this.answerMs), exit]);
      live.version = str(result?.agentInfo?.version);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (isTimeout(error)) throw noAnswer();
      throw new ProviderError(`The Gemini CLI did not complete the ACP handshake: ${message(error)}`, 'protocol');
    }
  }

  private exited(live: Live | undefined, code: number | null): void {
    if (!live) return;
    // Anything still waiting on the process hears the reason from here, first.
    this.retire(live, code === AUTH_EXIT ? loginFailed(live.proc.stderrTail) : undefined);
    const handler = live.onExit; live.onExit = undefined; handler?.(code);
  }

  private retire(live: Live, reason?: ProviderError): void {
    live.closed = true; clearTimeout(live.idle);
    if (this.lives.get(live.key) === live) this.lives.delete(live.key);
    live.rpc.close(reason ?? new ProviderError(`The Gemini CLI process ended.${live.proc.stderrTail.trim() ? ' ' + live.proc.stderrTail.trim().slice(-1500) : ''}`, 'crashed'));
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

  /** For a turned-off server no rule can reach: every other server by name. It is the exception, because it also stops servers it cannot name (from extensions). */
  private async allowList(agent: Agent, cwd: string): Promise<string[] | undefined> {
    const off = disabledNames(agent, 'mcpServers');
    if (agent.options.useMcp === false || off.every(ruleReaches)) return undefined;
    return [...new Set(['chatroom', ...await this.serverNames(agent, await this.mcpServers(agent), cwd)])].filter(name => name === 'chatroom' || !off.includes(name));
  }

  /** The servers Chatroom hands to the session, without the ones the user turned off. */
  private async mcpServers(agent: Agent): Promise<object[]> {
    const pairs = (values?: Record<string, string>) => Object.entries(values ?? {}).map(([name, value]) => ({ name, value: String(value) }));
    const off = new Set(disabledNames(agent, 'mcpServers')), servers: object[] = [];
    if (!off.has('chatroom')) {
      try {
        const { url, headers } = await this.host.roomTools.httpEndpoint(agent.id);
        servers.push({ type: 'http', name: 'chatroom', url, headers: pairs(headers) });
      } catch (error) { this.host.log(`Room tools are unavailable to ${agent.name}: ${message(error)}`, 'error'); }
    }
    if (agent.options.useMcp === false) return servers;
    for (const [name, server] of Object.entries(this.host.settings().sharedMcpServers ?? {})) {
      if (name === 'chatroom' || off.has(name) || !server || typeof server !== 'object') continue;
      if (server.url) servers.push({ type: 'http', name, url: server.url, headers: pairs(server.headers) });
      else if (server.command) servers.push({ name, command: server.command, args: server.args ?? [], env: pairs(server.env) });
    }
    return servers;
  }

  /** Every server this agent can use: the ones from Chatroom, then the user's and the workspace's settings. */
  private async serverNames(agent: Agent, servers: object[], cwd: string): Promise<string[]> {
    const passed = servers.map(s => (s as { name: string }).name);
    if (agent.options.useMcp === false) return passed;
    const home = process.env.GEMINI_CLI_HOME || homedir();
    const [user, project] = await Promise.all([settingsServers(join(home, '.gemini', 'settings.json')), settingsServers(join(cwd, '.gemini', 'settings.json'))]);
    return [...new Set([...passed, ...user, ...project])];
  }

  /** Reuses, loads or creates the session. `onLoadFailure`: create a new one (turns), throw (commands) or leave it (capabilities). */
  private async session(live: Live, agent: Agent, stored: string | undefined, onLoadFailure: 'create' | 'throw' | 'skip'): Promise<{ fresh: boolean; resumeFailed: boolean }> {
    if (live.sessionId && (live.sessionId === stored || (!stored && live.unprompted))) return { fresh: live.unprompted, resumeFailed: false };
    const servers = await this.mcpServers(agent), cwd = live.cwd;
    live.mcpNames = await this.serverNames(agent, servers, cwd);
    if (stored) {
      live.loading = true; live.lastUpdate = Date.now();
      try {
        const result = await live.rpc.request('session/load', { sessionId: stored, cwd, mcpServers: servers }, this.answerMs);
        this.adopt(live, stored, result, false);
        await this.replayEnded(live);
        return { fresh: false, resumeFailed: false };
      } catch (error) {
        if (error instanceof RpcError && isRetired(error.message)) throw providerError(error);
        if (live.closed) throw error;
        // session/load refuses a login that session/new accepts (an API key with no saved auth type), so only session/new can say the user is signed out.
        if (onLoadFailure === 'skip' && !isAuthError(error) && !isTimeout(error)) return { fresh: false, resumeFailed: false };
        if (onLoadFailure === 'throw') throw isAuthError(error) ? providerError(error) : new ProviderError(`Gemini could not resume this agent's session: ${message(error)}. Send a message to start a new one.`, 'session-lost');
        this.host.log(`Gemini session ${stored.slice(0, 8)} could not be resumed: ${message(error)}`, 'error');
      } finally { live.loading = false; }
    }
    const result: any = await live.rpc.request('session/new', { cwd, mcpServers: servers }, this.answerMs).catch(error => { throw isTimeout(error) ? noAnswer() : providerError(error); });
    if (typeof result?.sessionId !== 'string' || !result.sessionId) throw new ProviderError('The Gemini CLI returned no session id.', 'protocol');
    this.adopt(live, result.sessionId, result, true);
    return { fresh: true, resumeFailed: !!stored };
  }

  /** The CLI starts replaying a resumed session's history before it answers session/load, and goes on after. Those updates must not reach the next turn. */
  private async replayEnded(live: Live): Promise<void> {
    const started = Date.now();
    while (!live.closed && Date.now() - live.lastUpdate < REPLAY_QUIET_MS && Date.now() - started < REPLAY_MAX_MS) await delay(REPLAY_QUIET_MS / 4);
  }

  private adopt(live: Live, sessionId: string, result: any, created: boolean): void {
    if (live.sessionId && live.sessionId !== sessionId) live.retired.add(live.sessionId);
    live.sessionId = sessionId; live.unprompted = created; live.applied = {};
    if (result?.modes && typeof result.modes === 'object') live.modes = result.modes;
    if (result?.models && typeof result.models === 'object') live.models = result.models;
    live.defaultModel = str(live.models?.currentModelId);
  }

  private async request(live: Live, method: string, params: object, label: string, note: (title: string) => void): Promise<boolean> {
    try { await live.rpc.request(method, params, OPTION_MS); return true; } catch (error) { note(`Could not set ${label}: ${message(error)}`); return false; }
  }

  /** Applies the model and the permission level when they differ from what this session last had. */
  private async applyOptions(live: Live, req: NativeTurnRequest): Promise<void> {
    const { agent } = req, sessionId = live.sessionId;
    let notes = 0;
    const note = (title: string) => req.sink.activity({ id: `gemini-option-${++notes}`, kind: 'info', title, status: 'done', at: Date.now() });
    // '' keeps the CLI default; after an explicit model, '' returns to the session's original one.
    const model = agent.model || (live.applied.model !== undefined ? live.defaultModel : undefined);
    if (model && model !== live.applied.model && await this.request(live, 'session/set_model', { sessionId, modelId: model }, 'model', note)) live.applied.model = model;
    // Plan mode can be off in the CLI's settings; the permission handler then rejects edits and commands itself.
    const wanted = MODES[effectivePermission(agent, this.host.settings())], modes = Array.isArray(live.modes?.availableModes) ? live.modes!.availableModes! : [];
    const modeId = modes.some(m => m?.id === wanted) ? wanted : MODES.ask;
    if (modes.length && modeId !== live.modes?.currentModeId && await this.request(live, 'session/set_mode', { sessionId, modeId }, 'mode', note)) live.modes = { ...live.modes, currentModeId: modeId };
  }

  /** The CLI lists its commands just after it answers session/new or session/load. */
  private async commandsListed(live: Live): Promise<void> {
    if (!live.commands && !live.closed) await new Promise<void>(resolve => { const timer = setTimeout(resolve, COMMANDS_WAIT_MS); live.commandWaiters.push(() => { clearTimeout(timer); resolve(); }); });
  }

  private async command(live: Live, name: string): Promise<string> {
    await this.commandsListed(live);
    const known = filterNativeCommands('gemini', (live.commands ?? []).filter(c => typeof c?.name === 'string').map(c => ({ name: c.name, source: 'builtin' as const })));
    const match = known.find(c => c.name.toLowerCase() === name);
    if (!match) throw new ProviderError(`The Gemini CLI has no /${name} command.`, 'unsupported');
    return match.name;
  }

  private prompt(live: Live, req: NativeTurnRequest, blocks: object[], command: boolean): Promise<NativeTurnResult> {
    const state: TurnState = { req, text: '', thinking: '', breakPending: false, items: new Map() };
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
        : reject(new ProviderError(`The Gemini CLI exited during the turn (code ${code}).${live.proc.stderrTail.trim() ? ' ' + live.proc.stderrTail.trim().slice(-1500) : ''}`, 'crashed')));
      live.onExit = exit;
      signal.addEventListener('abort', abort, { once: true });
      live.rpc.request('session/prompt', { sessionId, prompt: blocks }, PROMPT_MS).then((result: any) => finish(() => {
        // The CLI answered this prompt, so its session holds it.
        if (result?.stopReason === 'cancelled' || signal.aborted) return resolve(interrupted(true));
        if (result?.stopReason === 'refusal') return reject(new ProviderError('Gemini refused the request.', 'failed'));
        const usage = usageOf(result?.usage);
        // A slash command the CLI ran itself reports zero tokens.
        resolve({ text: state.text, usage: usage && (usage.input || usage.output) ? usage : command ? emptyUsage() : estimate(input, state.text), status: 'complete' });
      }), error => finish(() => signal.aborted ? resolve(interrupted()) : reject(providerError(error))));
      if (signal.aborted) abort();
    });
  }

  private update(live: Live | undefined, params: any): void {
    const update = params?.update;
    if (!live || !update || typeof update !== 'object' || (typeof params.sessionId === 'string' && live.retired.has(params.sessionId))) return;
    live.lastUpdate = Date.now();
    const turn = live.turn;
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        live.commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        live.commandWaiters.splice(0).forEach(wake => wake());
        return this.pushCaps(live);
      case 'current_mode_update':
        if (typeof update.currentModeId === 'string') live.modes = { ...(live.modes ?? {}), currentModeId: update.currentModeId };
        return this.pushCaps(live);
      case 'usage_update': {
        const tokens = num(update.used), window = num(update.size);
        if (window > 0) { live.context = { tokens, window, percent: Math.round(100 * tokens / window) }; turn?.req.sink.session({ context: live.context }); }
        return;
      }
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      // The CLI reports a changed approval mode as message text.
      const mode = /^\[MODE_UPDATE\]\s*(\S+)\s*$/.exec(blockText(update.content));
      if (mode) { live.modes = { ...(live.modes ?? {}), currentModeId: mode[1]! }; return; }
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
        turn.thinking = (turn.thinking + (turn.thinking ? '\n\n' : '') + chunk).slice(-20000); sink.thinking(turn.thinking); return;
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
    // "For this session" only: one tool rather than a whole server, and never the option that saves a rule for all future sessions.
    const forSession = () => { const session = options.filter(o => o.kind === 'allow_always' && !/save/i.test(o.optionId)); return (session.find(o => /tool/i.test(o.optionId)) ?? session[0])?.optionId; };
    const select = (optionId: string | undefined) => optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const turn = live?.turn, call = params?.toolCall ?? {}, kind = call.kind;
    if (!turn || turn.req.signal.aborted) return cancelled;
    const permission = effectivePermission(turn.req.agent, this.host.settings());
    if (permission === 'full') return select(pick('allow_once'));
    if (permission === 'plan' && ['edit', 'delete', 'move', 'execute'].includes(kind)) return select(pick('reject_once'));
    if (permission === 'auto-edit' && (kind === 'think' || (['read', 'edit', 'search'].includes(kind) && insideRoots(call, [live!.cwd, ...(turn.req.agent.options.extraDirs ?? [])].map(r => resolve(r))))))
      return select(pick('allow_once'));
    const diff = diffOf(call.content);
    const request: ApprovalRequest = { kind: approvalKind(call), tool: str(kind) ?? 'tool', title: str(call.title) || summary(call.rawInput) || 'Gemini wants to use a tool',
      canAllowSession: !!forSession(), ...(diff ? { diff } : {}) };
    try {
      const decision = await turn.req.sink.approval(request, turn.req.signal);
      if (turn.req.signal.aborted) return cancelled;
      if (decision.decision !== 'deny' && kind === 'switch_mode') turn.req.sink.options({ permission: 'ask', exitPlan: true });
      return select(decision.decision === 'allow' ? pick('allow_once') : decision.decision === 'allow-session' ? forSession() ?? pick('allow_once') : pick('reject_once'));
    } catch { return turn.req.signal.aborted ? cancelled : select(pick('reject_once')); }
  }

  private caps(live: Live | undefined, agent: Agent, extra: Partial<AgentCapabilities> = {}): AgentCapabilities {
    // Subcommands are listed with spaces ("memory show"); they run as the parent command's arguments.
    const raw = (live?.commands ?? []).filter(c => typeof c?.name === 'string' && !/\s/.test(c.name));
    const commands = filterNativeCommands('gemini', raw.map(c => ({ name: c.name, description: str(c.description), source: 'builtin' as const })));
    const listed: ModelInfo[] = (Array.isArray(live?.models?.availableModels) ? live!.models!.availableModels! : []).filter(m => typeof m?.modelId === 'string')
      .map(m => ({ id: m.modelId, name: str(m.name) || m.modelId, ...(str(m.description) ? { description: m.description } : {}), ...(m.modelId === live?.defaultModel ? { isDefault: true } : {}) }));
    // The ACP has no skill or tool list; these are the skills the CLI loads from its own folders.
    const skills = agent.options.useSkills === false ? [] : (this.host.skillWiring()?.skills ?? []).filter(s => s.nativeTo.includes('gemini')).map(s => ({ name: s.name, ...(s.description ? { description: s.description } : {}), source: s.source }));
    return { provider: 'gemini', runtime: 'cli', status: 'ready', ...(live?.version ? { version: live.version } : {}), models: listed, efforts: [], tools: [], skills, commands,
      mcpServers: (live?.mcpNames ?? []).map(name => ({ name, status: 'configured' })),
      supports: { thinking: false, summary: false, sandbox: false, webSearch: true, useMcp: true, useSkills: true, useProjectSettings: false, extraDirs: true,
        ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: true, customAgent: false },
      canDisable: { tools: true, toolsByName: true, skills: true, mcpServers: true, commands: true },
      ...((live?.context ?? agent.session?.context) ? { context: live?.context ?? agent.session?.context } : {}), updatedAt: Date.now(), ...extra };
  }
}
