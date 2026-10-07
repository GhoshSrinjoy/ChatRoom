import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JsonlProcess, spawnJsonl } from './jsonl';
import { childEnv } from './process';
import { claudeEditorBlocks } from './editor-context';
import { filterNativeCommands } from './commands';
import { ROOM_TOOL_NAMES } from './tool-specs';
import {
  ActivityItem, Agent, AgentCapabilities, ApprovalKind, ApprovalRequest, DriverHost, DriverSettings, ModelInfo, NativeCommand, NativeDriver,
  NativeTurnRequest, NativeTurnResult, PermissionLevel, ProviderError, ProviderErrorCode, Room, Runtime, SkillWiring, TurnSink, Usage, emptyUsage,
} from './types';

const INIT_TIMEOUT_MS = 30_000, CONTROL_TIMEOUT_MS = 10_000, INTERRUPT_GRACE_MS = 5_000, CLOSE_GRACE_MS = 3_000;
const MODES: Record<PermissionLevel, string> = { plan: 'plan', ask: 'default', 'auto-edit': 'acceptEdits', full: 'bypassPermissions' };
const LEVELS: Record<string, PermissionLevel> = { plan: 'plan', default: 'ask', manual: 'ask', acceptEdits: 'auto-edit', bypassPermissions: 'full' };
const LOST_TITLE = 'Previous session could not be resumed · started a new one with recent room history';
const RANK: Record<PermissionLevel, number> = { plan: 0, ask: 1, 'auto-edit': 2, full: 3 };
/** Exactly the room tools of the in-process `chatroom` server (other servers' tools can share the prefix). */
const ROOM_TOOLS = new Set(ROOM_TOOL_NAMES.map(name => `mcp__chatroom__${name}`));
/**
 * Suggestions sent back on "Allow for session": session-scoped rules only. A `setMode` suggestion would switch the
 * whole session to another permission mode (acceptEdits), and other destinations write settings files in the repo.
 */
const sessionRules = (request: any): any[] => (Array.isArray(request?.permission_suggestions) ? request.permission_suggestions : [])
  .filter((s: any) => s && typeof s === 'object' && s.destination === 'session' && s.type !== 'setMode');

/** Full access needs the chatroom.allowFullAccess setting; without it the agent asks. */
const permissionOf = (agent: Agent, settings: DriverSettings): PermissionLevel =>
  agent.options.permission === 'full' && !settings.allowFullAccess ? 'ask' : agent.options.permission;

export function claudeArgs(agent: Agent, room: Room, model: ModelInfo | undefined, session: { id: string; resume: boolean }, wiring: SkillWiring | undefined, settings: DriverSettings, storageDir: string): string[] {
  void storageDir;
  const o = agent.options, permission = permissionOf(agent, settings);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', MODES[permission]];
  if (permission === 'full') args.push('--allow-dangerously-skip-permissions');
  if (agent.model) args.push('--model', agent.model);
  if (o.effort && (!model?.reasoning || model.reasoning.includes(o.effort))) args.push('--effort', o.effort);
  if (o.thinking === 'off') args.push('--thinking', 'disabled');
  args.push('--thinking-display', 'summarized');
  args.push(session.resume ? '--resume' : '--session-id', session.id);
  if (room.shareSkills && wiring?.claudePluginDir) args.push('--plugin-dir', wiring.claudePluginDir);
  if (room.shareSkills && wiring?.indexDir) args.push('--add-dir', wiring.indexDir);
  for (const dir of o.extraDirs ?? []) args.push('--add-dir', dir);
  const shared = settings.sharedMcpServers ?? {};
  if (Object.keys(shared).length || o.useMcp === false) args.push('--mcp-config', JSON.stringify({ mcpServers: shared }));
  if (o.useMcp === false) args.push('--strict-mcp-config');
  if (o.useProjectSettings === false) args.push('--setting-sources', 'user');
  if (o.useSkills === false) args.push('--disable-slash-commands');
  if (o.webSearch === false) args.push('--disallowedTools', 'WebSearch,WebFetch');
  if (o.customAgent) args.push('--agent', o.customAgent);
  return args;
}
function spawnKey(agent: Agent, room: Room, wiring: SkillWiring | undefined, settings: DriverSettings): string {
  const o = agent.options;
  return JSON.stringify({ full: permissionOf(agent, settings) === 'full', thinking: o.thinking, plugin: room.shareSkills ? wiring?.claudePluginDir : undefined,
    indexDir: room.shareSkills ? wiring?.indexDir : undefined, extraDirs: o.extraDirs, mcp: settings.sharedMcpServers ?? {}, useMcp: o.useMcp,
    useProjectSettings: o.useProjectSettings, useSkills: o.useSkills, webSearch: o.webSearch, customAgent: o.customAgent });
}
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
export function claudeUsage(u: any): Usage {
  const cached = num(u?.cache_read_input_tokens), cacheWrite = num(u?.cache_creation_input_tokens);
  return { input: num(u?.input_tokens) + cached + cacheWrite, output: num(u?.output_tokens), cached, cacheWrite, requests: 1, estimated: false };
}
/** Sum of a result's cumulative per-model usage, counted like claudeUsage. */
function modelTotals(modelUsage: unknown): Usage | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const all = Object.values(modelUsage as Record<string, any>).filter(u => u && typeof u === 'object');
  if (!all.length) return undefined;
  const sum = (key: string) => all.reduce((n, u) => n + num(u[key]), 0);
  const cached = sum('cacheReadInputTokens'), cacheWrite = sum('cacheCreationInputTokens');
  return { input: sum('inputTokens') + cached + cacheWrite, output: sum('outputTokens'), cached, cacheWrite, requests: 1, estimated: false };
}
export function claudeModel(m: any): ModelInfo | undefined {
  if (typeof m?.value !== 'string') return;
  const reasoning: string[] = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e: unknown) => typeof e === 'string') : [];
  return { id: m.value, name: m.displayName || m.value, ...(m.description ? { description: m.description } : {}), reasoning,
    thinking: !!m.supportsAdaptiveThinking, ultra: !!m.supportsEffort && reasoning.includes('xhigh'), isDefault: m.value === 'default' };
}
const cap = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const str = (value: unknown) => typeof value === 'string' ? value : '';
export function toolKind(name: string): ActivityItem['kind'] {
  if (name.startsWith('mcp__')) return 'mcp';
  if (/^(Bash|PowerShell)$/.test(name)) return 'command';
  if (/^(Edit|Write|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Read|Grep|Glob)$/.test(name)) return 'read';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'search';
  if (/^(Task|Workflow|Agent)$/.test(name)) return 'subagent';
  if (/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(name)) return 'plan';
  return 'tool';
}
export function toolSummary(name: string, input: any): string {
  let text = '';
  if (name.startsWith('mcp__')) { const [server, ...tool] = name.slice(5).split('__'); text = `${server}.${tool.join('__')}`; }
  else if (/^(Bash|PowerShell)$/.test(name)) text = str(input?.command);
  else if (/^(Read|Write|Edit|NotebookEdit)$/.test(name)) text = str(input?.file_path) || str(input?.notebook_path);
  else if (/^(Grep|Glob)$/.test(name)) text = str(input?.pattern);
  else if (name === 'WebFetch') text = str(input?.url);
  else if (name === 'WebSearch') text = str(input?.query);
  else if (/^(Task|Workflow|Agent)$/.test(name)) text = str(input?.description);
  return cap(text, 300);
}
function approvalKind(name: string): ApprovalKind {
  if (name === 'ExitPlanMode') return 'plan';
  const kind = toolKind(name);
  return kind === 'edit' ? 'edit' : kind === 'command' ? 'command' : kind === 'search' ? 'network' : kind === 'mcp' ? 'mcp' : kind === 'read' ? 'read' : 'other';
}
export function claudeApproval(request: any): ApprovalRequest {
  const name = str(request?.tool_name), input = request?.input ?? {};
  let detail: string;
  if (name === 'ExitPlanMode') detail = str(input.plan);
  else if (name === 'Edit') detail = cap('- ' + str(input.old_string) + '\n+ ' + str(input.new_string), 4000);
  else if (name === 'Write') detail = str(input.content).split('\n').slice(0, 60).join('\n');
  else detail = cap(JSON.stringify(input, null, 2) ?? '', 4000);
  const reason = request?.decision_reason;
  if (reason) detail += (detail ? '\n\n' : '') + (typeof reason === 'string' ? reason : JSON.stringify(reason));
  return { kind: approvalKind(name), tool: str(request?.display_name) || name || 'tool', title: toolSummary(name, input) || str(request?.description) || name || 'Tool request',
    ...(detail ? { detail } : {}), canAllowSession: sessionRules(request).length > 0 };
}
const kTokens = (n: unknown) => { const v = num(n); return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(v); };
function patchText(patch: unknown): string {
  if (!Array.isArray(patch) || !patch.length) return '';
  return patch.map((h: any) => `@@ -${num(h?.oldStart)},${num(h?.oldLines)} +${num(h?.newStart)},${num(h?.newLines)} @@\n` + (Array.isArray(h?.lines) ? h.lines.join('\n') : '')).join('\n').slice(0, 4000);
}
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => typeof c?.text === 'string' ? c.text : '').filter(Boolean).join('\n');
  return '';
}
function errorCode(text: string): ProviderErrorCode {
  return /usage limit|rate limit|quota/i.test(text) ? 'usage-limit' : /issue with the selected model|model [^\n.]{0,80}may not exist/i.test(text) ? 'model-unavailable'
    : /login|api key|authenticat/i.test(text) ? 'signed-out' : 'failed';
}
function claudeError(text: string, fallback: ProviderErrorCode, resetsAt?: number): ProviderError {
  const code = errorCode(text) === 'failed' ? fallback : errorCode(text);
  const message = code === 'signed-out' ? `Claude Code is not signed in: ${text} Run "claude" in a terminal and log in with /login, then try again.`
    : code === 'usage-limit' ? `Claude Code usage limit reached: ${text}${resetsAt ? ` It resets ${new Date(resetsAt).toLocaleString()}.` : ''} Other agents can continue.`
    : `Claude Code: ${text}`;
  return new ProviderError(message, code, code === 'usage-limit' && resetsAt ? { resetsAt } : {});
}
class ResumeLost extends Error {}

interface Plan { stored?: string; id: string; resume: boolean; lost: boolean }
interface Turn {
  req: NativeTurnRequest; command?: string;
  text: string; sep: boolean; deltas: boolean; parts: string[];
  thinking: string; thinkSep: boolean; thinkDeltas: boolean;
  activities: Map<string, ActivityItem>; compact?: string; compactError?: string; compactMeta?: any;
  /** The user message reached the CLI, so an interrupted turn is still in its session. */
  delivered?: boolean;
  interrupted: boolean; done: boolean; killTimer?: NodeJS.Timeout; onAbort: () => void;
  resolve: (result: NativeTurnResult) => void; reject: (error: Error) => void;
}
interface Live {
  key: string; roomId: string; agentId: string; agent: Agent; sessionId: string; resumed: boolean; spawnKey: string; framing?: string; version: string;
  proc: JsonlProcess; ready: Promise<any>; init?: any; initEvent?: any; mcpStatus?: any;
  controls: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  approvals: Map<string, AbortController>; abort: AbortController;
  applied: { model: string; effort: string; permission: PermissionLevel; ultra: boolean };
  baseline?: number; resetsAt?: number; startupError?: string;
  /** Last cumulative modelUsage of this process, the baseline for turns whose result carries no usage (/compact). */
  modelTotals?: Usage;
  turn?: Turn; closing: boolean; idleTimer?: NodeJS.Timeout;
}

export class ClaudeDriver implements NativeDriver {
  readonly provider = 'claude';
  private readonly lives = new Map<string, Live>();
  private readonly plans = new Map<string, Plan>();
  private readonly framings = new Map<string, string>();
  private models: ModelInfo[] = [];
  private commands: any[] = [];
  private seq = 0;
  constructor(private readonly host: DriverHost, private readonly spawnProcess?: typeof spawn) {}

  async turn(req: NativeTurnRequest): Promise<NativeTurnResult> {
    const { room, agent, command } = req;
    if (command && !agent.session?.id) return { text: `No session yet: nothing to ${command.name}.`, usage: emptyUsage(), status: 'complete' };
    if (req.signal.aborted) return { text: '', usage: emptyUsage(), status: 'interrupted' };
    const runtime = await this.runtime();
    const key = keyOf(room.id, agent.id);
    this.framings.set(key, req.framing);
    const live = await this.prepare(room, agent, runtime, req.framing);
    if (live.turn) throw new ProviderError('Claude Code is still working on the previous turn for this agent.', 'protocol');
    live.agent = agent;
    clearTimeout(live.idleTimer);
    const plan = this.plans.get(key)!, lost = plan.lost, fresh = !plan.resume;
    // The fresh process stays ready for the next message, which then brings the room history (a command has none to send).
    if (command && lost) { this.armIdle(live); throw new ProviderError('The Claude Code session could not be resumed. Send a message to start a new one with recent room history.', 'session-lost'); }
    if (fresh) req.sink.session({ id: live.sessionId, provider: 'claude', startedAt: Date.now() });
    this.plans.set(key, { stored: live.sessionId, id: live.sessionId, resume: true, lost: false });
    if (lost) req.sink.activity({ id: 'session-lost', kind: 'info', title: LOST_TITLE, status: 'done', at: Date.now() });
    if (req.signal.aborted) { this.armIdle(live); return { text: '', usage: emptyUsage(), status: 'interrupted' }; }
    let content: string | { type: 'text'; text: string }[];
    if (command) {
      const name = command.name.toLowerCase();
      const known = (Array.isArray(live.init?.commands) ? live.init.commands : this.commands)
        .some((c: any) => c?.name === name || (Array.isArray(c?.aliases) && c.aliases.includes(name)));
      if (name !== 'compact' && !known) { this.armIdle(live); throw new ProviderError(`Claude Code has no /${command.name} command.`, 'unsupported'); }
      content = ('/' + name + (command.args.trim() ? ' ' + command.args.trim() : '')).trim();
    } else content = this.blocks(req, lost, agent);
    await this.applyLive(live, agent, req.sink);
    return new Promise<NativeTurnResult>((resolve, reject) => {
      const turn: Turn = { req, ...(command ? { command: command.name.toLowerCase() } : {}), text: '', sep: false, deltas: false, parts: [], thinking: '', thinkSep: false, thinkDeltas: false,
        activities: new Map(), interrupted: false, done: false, resolve, reject, onAbort: () => this.interrupt(live, turn) };
      live.turn = turn;
      req.signal.addEventListener('abort', turn.onAbort, { once: true });
      try { live.proc.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }); turn.delivered = true; }
      catch { this.finish(live, turn, { error: this.exitError(live, null) }); return; }
      if (req.signal.aborted) turn.onAbort();
    });
  }

  async capabilities(room: Room, agent: Agent): Promise<AgentCapabilities> {
    const runtime = await this.host.runtime('claude');
    if (!runtime) return this.emptyCaps('missing', 'Claude Code was not found. Install Claude Code or set chatroom.claudePath.');
    try {
      const key = keyOf(room.id, agent.id), existing = this.lives.get(key);
      const live = existing && existing.proc.alive && !existing.closing ? existing : await this.prepare(room, agent, runtime, this.framings.get(key) ?? this.host.framing?.(room, agent));
      await live.ready;
      if (!live.turn) live.agent = agent;
      const status = await this.control(live, { subtype: 'mcp_status' }).catch(() => undefined);
      if (status) live.mcpStatus = status;
      if (!live.turn) this.armIdle(live);
      return this.caps(live, agent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.emptyCaps(error instanceof ProviderError && error.code === 'signed-out' ? 'signed-out' : 'error', message, runtime.version);
    }
  }

  async release(roomId: string, agentId?: string): Promise<void> {
    await Promise.all([...this.lives.values()].filter(l => l.roomId === roomId && (!agentId || l.agentId === agentId)).map(l => this.close(l)));
  }
  async dispose(): Promise<void> { await Promise.all([...this.lives.values()].map(l => this.close(l))); }

  private async runtime(): Promise<Runtime> {
    const runtime = await this.host.runtime('claude');
    if (!runtime) throw new ProviderError('Claude Code was not found. Install Claude Code (or its VS Code extension) or set chatroom.claudePath.', 'missing');
    return runtime;
  }
  private modelFor(agent: Agent): ModelInfo | undefined {
    return this.models.find(m => m.id === (agent.model || 'default')) ?? (agent.model ? undefined : this.models.find(m => m.isDefault));
  }
  /** The session this agent's next process should use. */
  private plan(key: string, agent: Agent): Plan {
    const stored = agent.session?.id, current = this.plans.get(key);
    if (current && current.stored === stored) return current;
    const plan: Plan = stored ? { stored, id: stored, resume: true, lost: false } : { id: randomUUID(), resume: false, lost: false };
    this.plans.set(key, plan);
    return plan;
  }
  /** A live, initialized process for this agent: reused, or (re)spawned with --session-id / --resume. */
  private async prepare(room: Room, agent: Agent, runtime: Runtime, framing: string | undefined): Promise<Live> {
    const key = keyOf(room.id, agent.id), settings = this.host.settings(), wiring = this.host.skillWiring();
    const plan = this.plan(key, agent), wanted = spawnKey(agent, room, wiring, settings);
    const existing = this.lives.get(key);
    if (existing) {
      const framed = framing === undefined || existing.framing === framing || (plan.resume && existing.framing !== undefined);
      if (existing.proc.alive && !existing.closing && existing.spawnKey === wanted && existing.sessionId === plan.id && framed) { await existing.ready; return existing; }
      await this.close(existing);
    }
    try { return await this.start(room, agent, runtime, plan, wanted, framing); }
    catch (error) {
      if (!(error instanceof ResumeLost)) throw error;
      const fresh: Plan = { stored: plan.stored, id: randomUUID(), resume: false, lost: true };
      this.plans.set(key, fresh);
      return this.start(room, agent, runtime, fresh, wanted, framing);
    }
  }
  private async start(room: Room, agent: Agent, runtime: Runtime, plan: Plan, wanted: string, framing: string | undefined): Promise<Live> {
    const settings = this.host.settings(), key = keyOf(room.id, agent.id);
    const args = claudeArgs(agent, room, this.modelFor(agent), { id: plan.id, resume: plan.resume }, this.host.skillWiring(), settings, this.host.storageDir());
    const live = { key, roomId: room.id, agentId: agent.id, agent, sessionId: plan.id, resumed: plan.resume, spawnKey: wanted, version: runtime.version,
      ...(framing !== undefined ? { framing } : {}), controls: new Map(), approvals: new Map(), abort: new AbortController(), closing: false,
      applied: { model: agent.model, effort: agent.options.effort, permission: permissionOf(agent, settings), ultra: false } } as unknown as Live;
    live.proc = spawnJsonl(runtime.executable, args, { cwd: this.host.cwd(), env: childEnv(runtime.executable, 'claude'), spawnProcess: this.spawnProcess,
      onMessage: message => this.route(live, message), onExit: code => this.exited(live, code) });
    this.lives.set(key, live);
    live.ready = this.control(live, { subtype: 'initialize', hooks: {}, ...(framing ? { appendSystemPrompt: framing } : {}), sdkMcpServers: ['chatroom'] }, INIT_TIMEOUT_MS, 'init-1')
      .then(init => {
        live.init = init ?? {};
        const models = Array.isArray(init?.models) ? init.models.map(claudeModel).filter((m: ModelInfo | undefined): m is ModelInfo => !!m) : [];
        if (models.length) this.models = models;
        if (Array.isArray(init?.commands)) this.commands = init.commands;
        return live.init;
      });
    try { await live.ready; }
    catch (error) {
      void this.close(live);
      const text = [live.startupError, live.proc.stderrTail].filter(Boolean).join('\n').trim();
      if (plan.resume && /No conversation found/i.test(text)) throw new ResumeLost(text);
      if (/ENOENT|EACCES/.test(text)) throw new ProviderError(`Claude Code could not be started (${runtime.executable.command}): ${text}`, 'missing');
      if (live.proc.alive || /timed out/.test(error instanceof Error ? error.message : '')) throw new ProviderError(`Claude Code did not answer the initialize request in ${INIT_TIMEOUT_MS / 1000} s.${text ? ' ' + text : ''}`, 'protocol');
      throw claudeError(text || (error instanceof Error ? error.message : String(error)), 'crashed');
    }
    return live;
  }
  private blocks(req: NativeTurnRequest, lost: boolean, agent: Agent): { type: 'text'; text: string }[] {
    const context = lost ? req.fullContext() : req.context;
    const texts = [...(req.editor ? claudeEditorBlocks(req.editor) : []), ...(context ? [context] : []), req.ask || 'Continue.'];
    let last = texts.pop()!;
    if (req.flags.think) last += '\n\nultrathink';
    if (req.flags.ultra) {
      if (this.modelFor(agent)?.ultra === false) req.sink.activity({ id: 'ultra', kind: 'info', title: 'Ultra is not available for this model', status: 'done', at: Date.now() });
      else last += '\n\nultracode';
    }
    return [...texts, last].map(text => ({ type: 'text' as const, text }));
  }
  /** Model, effort, ultra and (non-full) permission changes, applied to the running session before the user message. */
  private async applyLive(live: Live, agent: Agent, sink: TurnSink) {
    const o = agent.options, applied = live.applied, model = this.modelFor(agent), permission = permissionOf(agent, this.host.settings());
    const run = async (what: string, request: { subtype: string; [key: string]: unknown }) => {
      try { await this.control(live, request); }
      catch (error) { sink.activity({ id: 'control-' + what, kind: 'info', title: `Could not change ${what}: ${error instanceof Error ? error.message : String(error)}`, status: 'failed', at: Date.now() }); }
    };
    if (applied.model !== agent.model) { applied.model = agent.model; await run('the model', { subtype: 'set_model', model: agent.model || 'default' }); }
    if (applied.effort !== o.effort) {
      applied.effort = o.effort;
      if (!o.effort || !model?.reasoning || model.reasoning.includes(o.effort)) await run('the effort', { subtype: 'apply_flag_settings', settings: { effortLevel: o.effort || null } });
    }
    if (applied.ultra !== o.ultra) { applied.ultra = o.ultra; await run('ultra', { subtype: 'apply_flag_settings', settings: { ultracode: o.ultra } }); }
    if (applied.permission !== permission && permission !== 'full' && applied.permission !== 'full') {
      applied.permission = permission;
      await run('the permission mode', { subtype: 'set_permission_mode', mode: MODES[permission] });
    }
  }
  private control(live: Live, request: { subtype: string; [key: string]: unknown }, timeoutMs = CONTROL_TIMEOUT_MS, id = `req-${++this.seq}`): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { live.controls.delete(id); reject(new Error(`${request.subtype} timed out`)); }, timeoutMs);
      live.controls.set(id, { resolve, reject, timer });
      try { live.proc.send({ type: 'control_request', request_id: id, request }); }
      catch (error) { clearTimeout(timer); live.controls.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private reply(live: Live, id: string, response: unknown) {
    try { live.proc.send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }); } catch { /* The process is gone. */ }
  }
  private route(live: Live, message: any) {
    switch (message.type) {
      case 'control_response': {
        const id = message.response?.request_id, pending = id !== undefined ? live.controls.get(String(id)) : undefined;
        if (!pending) return;
        live.controls.delete(String(id)); clearTimeout(pending.timer);
        if (message.response.subtype === 'error') pending.reject(new Error(str(message.response.error) || 'Control request failed'));
        else pending.resolve(message.response.response ?? {});
        return;
      }
      case 'control_request': void this.onRequest(live, String(message.request_id ?? ''), message.request ?? {}); return;
      case 'control_cancel_request': live.approvals.get(String(message.request_id))?.abort(); return;
      case 'keep_alive': return;
    }
    if (message.type === 'system' && message.subtype === 'init') live.initEvent = message;
    if (message.type === 'result' && !live.init) live.startupError = [str(message.result), ...(Array.isArray(message.errors) ? message.errors.map(String) : [])].filter(Boolean).join('\n');
    if (message.type === 'result' && typeof message.total_cost_usd === 'number' && !live.turn) live.baseline = message.total_cost_usd;
    if (live.turn && !live.turn.done) this.onEvent(live, live.turn, message);
  }
  private async onRequest(live: Live, id: string, request: any) {
    const subtype = request.subtype;
    if (subtype === 'can_use_tool') return this.onPermission(live, id, request);
    if (subtype === 'mcp_message') {
      let response: any;
      try { response = await this.host.roomTools.mcp(live.agentId, request.message, live.turn?.req.signal ?? live.abort.signal); }
      catch (error) { response = { jsonrpc: '2.0', id: request.message?.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }; }
      return this.reply(live, id, { mcp_response: response ?? { jsonrpc: '2.0', result: {} } });
    }
    if (subtype === 'hook_callback') return this.reply(live, id, {});
    if (subtype === 'elicitation') return this.reply(live, id, { action: 'decline' });
    try { live.proc.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported by Chatroom' } }); } catch { /* The process is gone. */ }
  }
  private async onPermission(live: Live, id: string, request: any) {
    const name = str(request.tool_name), input = request.input ?? {}, toolUseID = request.tool_use_id;
    const allow = (extra: object = {}) => this.reply(live, id, { behavior: 'allow', updatedInput: input, ...(toolUseID !== undefined ? { toolUseID } : {}), ...extra });
    const deny = (message: string) => this.reply(live, id, { behavior: 'deny', message, ...(toolUseID !== undefined ? { toolUseID } : {}) });
    const turn = live.turn, agent = turn?.req.agent ?? live.agent;
    if (ROOM_TOOLS.has(name)) return allow();
    if (name === 'AskUserQuestion') return deny("Chatroom can't show interactive questions. Ask the user in your reply instead.");
    if (permissionOf(agent, this.host.settings()) === 'full') return allow();
    if (!turn || turn.done) return deny('No one is available in Chatroom to approve this right now.');
    const controller = new AbortController(), abort = () => controller.abort();
    if (turn.req.signal.aborted) controller.abort(); else turn.req.signal.addEventListener('abort', abort, { once: true });
    live.approvals.set(id, controller);
    try {
      const decision = await turn.req.sink.approval(claudeApproval(request), controller.signal);
      if (controller.signal.aborted) return live.closing ? undefined : deny(decision.message || 'Cancelled in Chatroom.');
      if (decision.decision === 'deny') return deny(decision.message || 'The user denied this in Chatroom.');
      const rules = decision.decision === 'allow-session' ? sessionRules(request) : [];
      allow(rules.length ? { updatedPermissions: rules } : {});
      if (name === 'ExitPlanMode') { live.applied.permission = 'ask'; turn.req.sink.options({ permission: 'ask', exitPlan: true }); }
    } catch {
      deny('The approval request failed in Chatroom.');
    } finally {
      live.approvals.delete(id);
      turn.req.signal.removeEventListener('abort', abort);
    }
  }
  private upsert(turn: Turn, id: string, patch: Partial<ActivityItem>) {
    const previous = turn.activities.get(id);
    const item: ActivityItem = { id, kind: 'tool', title: 'Tool', status: 'running', at: Date.now(), ...previous, ...patch };
    turn.activities.set(id, item);
    turn.req.sink.activity({ ...item });
  }
  private onEvent(live: Live, turn: Turn, m: any) {
    const sink = turn.req.sink, sub = m.parent_tool_use_id != null;
    switch (m.type) {
      case 'system': return this.onSystem(live, turn, m);
      case 'stream_event': {
        const e = m.event ?? {};
        if (e.type === 'content_block_start') {
          const block = e.content_block ?? {};
          if (block.type === 'text' && !sub) turn.sep = turn.text.length > 0;
          if (block.type === 'thinking' && !sub) turn.thinkSep = turn.thinking.length > 0;
          if (block.type === 'tool_use' && typeof block.id === 'string') this.upsert(turn, block.id, { kind: toolKind(str(block.name)), title: str(block.name) || 'Tool', status: 'running' });
        } else if (e.type === 'content_block_delta' && !sub) {
          const d = e.delta ?? {};
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            turn.text += (turn.sep ? '\n\n' : '') + d.text; turn.sep = false; turn.deltas = true; sink.text(turn.text);
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            turn.thinking = (turn.thinking + (turn.thinkSep ? '\n\n' : '') + d.thinking).slice(-20000); turn.thinkSep = false; turn.thinkDeltas = true; sink.thinking(turn.thinking);
          }
        }
        return;
      }
      case 'assistant': {
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.id === 'string') {
            const name = str(block.name);
            this.upsert(turn, block.id, { kind: toolKind(name), title: name || 'Tool', detail: toolSummary(name, block.input) });
          }
        }
        if (sub) return;
        const text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
        if (text && !turn.deltas) { turn.parts.push(text); turn.text = turn.parts.join('\n\n'); sink.text(turn.text); }
        const thought = content.filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string').map((b: any) => b.thinking).join('');
        if (thought && !turn.thinkDeltas) { turn.thinking = (turn.thinking ? turn.thinking + '\n\n' : '') + thought; sink.thinking(turn.thinking.slice(-20000)); }
        return;
      }
      case 'user': {
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const block of content) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const output = cap(resultText(block.content), 300), diff = patchText(m.tool_use_result?.structuredPatch);
          this.upsert(turn, block.tool_use_id, { status: block.is_error ? 'failed' : 'done', ...(output ? { detail: output } : {}), ...(diff ? { diff } : {}) });
        }
        return;
      }
      case 'rate_limit_event': {
        const info = m.rate_limit_info ?? {}, w = info.unifiedWindows;
        if (typeof info.resetsAt === 'number' && info.status && info.status !== 'allowed') live.resetsAt = info.resetsAt * 1000;
        if (w) sink.session({ quota: { primaryUsedPercent: Math.round(num(w.five_hour?.utilization) * 1000) / 10, secondaryUsedPercent: Math.round(num(w.seven_day?.utilization) * 1000) / 10,
          primaryWindowMinutes: 300, secondaryWindowMinutes: 10080, observedAt: Date.now() } });
        return;
      }
      case 'conversation_reset':
        if (typeof m.new_conversation_id === 'string') this.newSession(live, turn, m.new_conversation_id);
        return;
      case 'result': return this.onResult(live, turn, m);
    }
  }
  private newSession(live: Live, turn: Turn, id: string) {
    if (id === live.sessionId) return;
    live.sessionId = id;
    this.plans.set(live.key, { stored: id, id, resume: true, lost: false });
    turn.req.sink.session({ id, provider: 'claude', startedAt: Date.now() });
  }
  private onSystem(live: Live, turn: Turn, m: any) {
    const sink = turn.req.sink;
    switch (m.subtype) {
      case 'init':
        if (typeof m.session_id === 'string' && m.session_id) this.newSession(live, turn, m.session_id);
        sink.capabilities(this.caps(live, turn.req.agent));
        return;
      case 'status':
        if (m.status === 'compacting') this.upsert(turn, 'compact', { kind: 'compact', title: 'Compacting context', status: 'running' });
        if (m.compact_result === 'failed') {
          turn.compactError = str(m.compact_error) || 'Compaction failed.';
          this.upsert(turn, 'compact', { kind: 'compact', title: turn.compactError, status: 'failed' });
        }
        if (typeof m.permissionMode === 'string') {
          // A raised mode stays in this process (the next turn sets the agent's own level again); only a lowered one is saved.
          const level = LEVELS[m.permissionMode];
          if (level) live.applied.permission = level;
          if (level && RANK[level] < RANK[turn.req.agent.options.permission]) sink.options({ permission: level });
        }
        return;
      case 'compact_boundary': {
        const meta = m.compact_metadata ?? {};
        turn.compactMeta = meta;
        turn.compact = `Compacted ${kTokens(meta.pre_tokens)} → ${kTokens(meta.post_tokens)} tokens`;
        this.upsert(turn, 'compact', { kind: 'compact', title: turn.compact, status: 'done' });
        return;
      }
      case 'api_retry':
        this.upsert(turn, 'api-retry', { kind: 'info', title: 'Retrying the API request' + (m.attempt ? ` (attempt ${m.attempt})` : ''), ...(m.error ? { detail: cap(typeof m.error === 'string' ? m.error : JSON.stringify(m.error), 300) } : {}), status: 'running' });
        return;
      case 'api_error':
        this.upsert(turn, 'api-error', { kind: 'error', title: cap(str(m.error?.message) || str(m.message) || (typeof m.error === 'string' ? m.error : 'API error'), 300), status: 'failed' });
        return;
      case 'commands_changed':
        if (Array.isArray(m.commands) && live.init) { live.init.commands = m.commands; this.commands = m.commands; }
        sink.capabilities(this.caps(live, turn.req.agent));
        return;
    }
  }
  private onResult(live: Live, turn: Turn, r: any) {
    const usage = claudeUsage(r.usage), agent = turn.req.agent, sink = turn.req.sink, totals = modelTotals(r.modelUsage);
    // /compact reports no usage; its cost shows in the cumulative modelUsage, else estimate from the compaction sizes.
    if (usage.input + usage.output === 0 && turn.command === 'compact') {
      if (totals && live.modelTotals) Object.assign(usage, { input: Math.max(0, totals.input - live.modelTotals.input), output: Math.max(0, totals.output - live.modelTotals.output),
        cached: Math.max(0, totals.cached - live.modelTotals.cached), cacheWrite: Math.max(0, totals.cacheWrite - live.modelTotals.cacheWrite) });
      else if (turn.compactMeta) Object.assign(usage, { input: num(turn.compactMeta.pre_tokens), output: num(turn.compactMeta.post_tokens), estimated: true });
    }
    if (totals) live.modelTotals = totals;
    if (typeof r.total_cost_usd === 'number') {
      const stored = agent.session?.cost ?? 0;
      const base = live.baseline ?? (live.resumed && r.total_cost_usd >= stored ? stored : 0);
      usage.cost = Math.max(0, r.total_cost_usd - base);
      live.baseline = r.total_cost_usd;
      sink.session({ cost: r.total_cost_usd });
    }
    const final = str(r.result);
    if (turn.interrupted) return this.finish(live, turn, { result: { text: turn.text, usage, status: 'interrupted', delivered: !!turn.delivered } });
    if (r.is_error || /^error/.test(str(r.subtype))) {
      const text = final || (Array.isArray(r.errors) ? r.errors.map(String).join('\n') : '') || 'The turn failed.';
      return this.finish(live, turn, { error: claudeError(text, 'failed', live.resetsAt) });
    }
    // The result holds only the last text block; keep the streamed text when it already ends with it.
    const streamed = turn.text.trim();
    let text = final && !(streamed && streamed.endsWith(final.trim())) ? final : turn.text || final;
    if (turn.command === 'compact') text = final || turn.compactError || turn.compact || 'Context compacted.';
    this.finish(live, turn, { result: { text, usage, status: 'complete' } });
    void this.afterTurn(live, agent, sink);
  }
  private async afterTurn(live: Live, agent: Agent, sink: TurnSink) {
    try {
      const u = await this.control(live, { subtype: 'get_context_usage' });
      const tokens = num(u?.totalTokens), window = num(u?.maxTokens);
      if (window > 0) sink.session({ context: { percent: typeof u.percentage === 'number' ? Math.round(u.percentage) : Math.round(100 * tokens / window), tokens, window } });
    } catch { /* Optional. */ }
    try { const status = await this.control(live, { subtype: 'mcp_status' }); if (status) live.mcpStatus = status; } catch { /* Optional. */ }
    sink.capabilities(this.caps(live, agent));
  }
  private interrupt(live: Live, turn: Turn) {
    if (turn.done || turn.interrupted) return;
    turn.interrupted = true;
    for (const approval of live.approvals.values()) approval.abort();
    this.control(live, { subtype: 'interrupt' }, INTERRUPT_GRACE_MS).catch(() => {});
    turn.killTimer = setTimeout(() => {
      this.finish(live, turn, { result: { text: turn.text, usage: emptyUsage(), status: 'interrupted', delivered: !!turn.delivered } });
      void this.close(live, true);
    }, INTERRUPT_GRACE_MS);
  }
  private finish(live: Live, turn: Turn, outcome: { result?: NativeTurnResult; error?: Error }) {
    if (turn.done) return;
    turn.done = true;
    clearTimeout(turn.killTimer);
    turn.req.signal.removeEventListener('abort', turn.onAbort);
    if (live.turn === turn) live.turn = undefined;
    if (!live.closing && live.proc.alive) this.armIdle(live);
    if (outcome.error) turn.reject(outcome.error); else turn.resolve(outcome.result!);
  }
  private exitError(live: Live, code: number | null): ProviderError {
    const tail = live.proc.stderrTail.trim();
    const text = `Claude Code exited${code !== null ? ` (code ${code})` : ''} during the turn.${tail ? ' ' + tail : ''}`;
    return claudeError(text, 'crashed', live.resetsAt);
  }
  private exited(live: Live, code: number | null) {
    clearTimeout(live.idleTimer);
    live.abort.abort();
    for (const [id, pending] of live.controls) { clearTimeout(pending.timer); live.controls.delete(id); pending.reject(new Error(`Claude Code exited${code !== null ? ` (code ${code})` : ''}.`)); }
    for (const approval of live.approvals.values()) approval.abort();
    if (this.lives.get(live.key) === live) this.lives.delete(live.key);
    const turn = live.turn;
    if (!turn) return;
    if (turn.interrupted || live.closing) this.finish(live, turn, { result: { text: turn.text, usage: emptyUsage(), status: 'interrupted', delivered: !!turn.delivered } });
    else this.finish(live, turn, { error: this.exitError(live, code) });
  }
  private armIdle(live: Live) {
    clearTimeout(live.idleTimer);
    const ms = this.host.settings().idleSessionMs;
    if (!(ms > 0)) return;
    live.idleTimer = setTimeout(() => { if (!live.turn) void this.close(live); }, ms);
    live.idleTimer.unref?.();
  }
  private async close(live: Live, kill = false) {
    live.closing = true;
    clearTimeout(live.idleTimer);
    if (this.lives.get(live.key) === live) this.lives.delete(live.key);
    for (const approval of live.approvals.values()) approval.abort();
    if (kill) await live.proc.kill(); else await live.proc.close(CLOSE_GRACE_MS);
  }
  private caps(live: Live, agent: Agent): AgentCapabilities {
    const init = live.init ?? {}, ev = live.initEvent ?? {}, model = this.modelFor(agent);
    const raw: any[] = (Array.isArray(init.commands) ? init.commands : this.commands).filter((c: any) => typeof c?.name === 'string');
    const names = new Set(raw.map(c => c.name));
    const extra = (Array.isArray(ev.slash_commands) ? ev.slash_commands : []).filter((n: unknown): n is string => typeof n === 'string' && !names.has(n)).map((name: string) => ({ name }));
    const all = [...raw, ...extra];
    const source = (c: any): NativeCommand['source'] => c.builtin ? 'builtin' : c.name.includes(':') ? 'plugin' : 'skill';
    const commands = filterNativeCommands('claude', all.map(c => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases } : {}), source: source(c) })));
    const describe = new Map(all.map(c => [c.name, c]));
    const skills = Array.isArray(ev.skills)
      ? ev.skills.map((s: any) => typeof s === 'string' ? s : s?.name).filter((s: unknown): s is string => typeof s === 'string')
        .map((name: string) => ({ name, ...(describe.get(name)?.description ? { description: describe.get(name).description } : {}), source: name.includes(':') ? 'plugin' : 'skill' }))
      : all.filter(c => c.name.includes(':') || !c.builtin).map(c => ({ name: c.name, ...(c.description ? { description: c.description } : {}), source: source(c) }));
    const servers: any[] = Array.isArray(live.mcpStatus?.mcpServers) ? live.mcpStatus.mcpServers : Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [];
    const account = [str(init.account?.email), str(init.account?.subscriptionType)].filter(Boolean).join(' · ');
    const ultra = !!model?.ultra;
    return {
      provider: 'claude', runtime: 'cli', status: 'ready', version: live.version, ...(account ? { account } : {}),
      models: this.models, efforts: model?.reasoning ?? [],
      tools: Array.isArray(ev.tools) ? ev.tools.filter((t: unknown): t is string => typeof t === 'string') : [],
      skills, commands,
      mcpServers: servers.filter(s => typeof s?.name === 'string').map(s => ({ name: s.name, status: str(s.status) || 'unknown', ...(Array.isArray(s.tools) ? { tools: s.tools.length } : {}) })),
      plugins: (Array.isArray(ev.plugins) ? ev.plugins : []).map((p: any) => typeof p === 'string' ? p : p?.name).filter((p: unknown): p is string => typeof p === 'string'),
      agents: (Array.isArray(init.agents) ? init.agents : []).map((a: any) => a?.name).filter((a: unknown): a is string => typeof a === 'string'),
      supports: { thinking: true, summary: false, sandbox: false, webSearch: true, useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: true,
        ultraSession: ultra, ultraTurn: ultra, thinkHard: true, fullAccess: true, customAgent: true },
      ...(agent.session?.context ? { context: agent.session.context } : {}),
      updatedAt: Date.now(),
    };
  }
  private emptyCaps(status: AgentCapabilities['status'], detail: string, version?: string): AgentCapabilities {
    return { provider: 'claude', runtime: 'cli', status, detail, ...(version ? { version } : {}), models: this.models, efforts: [], tools: [], skills: [], commands: [], mcpServers: [],
      supports: { thinking: true, summary: false, sandbox: false, webSearch: true, useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: true,
        ultraSession: false, ultraTurn: false, thinkHard: true, fullAccess: true, customAgent: true },
      updatedAt: Date.now() };
  }
}
const keyOf = (roomId: string, agentId: string) => `${roomId}\u0000${agentId}`;
