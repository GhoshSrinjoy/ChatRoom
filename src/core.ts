import { createHash, randomUUID } from 'node:crypto';
import { Agent, AgentCapabilities, AgentOptions, Connection, Flow, LoopConfig, Message, ModelDefaults, PermissionLevel, PlanStep, ProviderError, ProviderId, Room, RoomChanges, RoomDocument, SandboxLanguage, SandboxResult, TaskPreset, TeamConfig, TeamStage, ToolCall, ToolName, TurnKind, Unavailable, UnavailableReason, Usage, emptyUsage } from './types';

export const SCHEMA = 5;
export const TOOL_NAMES: ToolName[] = ['list_files', 'read_file', 'search_files', 'search_documents', 'ollama_ocr', 'semantic_search'];
export const DEFAULT_TOOLS: ToolName[] = ['list_files', 'read_file', 'search_files', 'search_documents'];
export const PROVIDER_LABELS = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot', ollama: 'Ollama' } as const;
export const PERMISSION_LABELS: Record<PermissionLevel, string> = { plan: 'Plan', ask: 'Ask', 'auto-edit': 'Auto-edit', full: 'Full access' };
export const PERMISSIONS: PermissionLevel[] = ['plan', 'ask', 'auto-edit', 'full'];
export const MAX_PLAN_STEPS = 8;
export const DEFAULT_LOOP: LoopConfig = { kind: 'once', rounds: 2, everyMinutes: 10, maxIterations: 5, maxMinutes: 60, maxTokens: 0 };
/** Personas that versions before 0.4 assigned by default. Migration clears them; they are never assigned again. */
const OLD_DEFAULT_ROLES = new Set(['Engineer. Propose a concrete implementation and identify technical tradeoffs.', 'Reviewer. Challenge assumptions, catch edge cases, and improve the proposed solution.',
  'Integrator. Reconcile the discussion into practical next steps and a clear answer.', 'Specialist. Contribute your perspective and help resolve the user’s objective.']);

export function defaultOptions(provider: ProviderId, permission: PermissionLevel = 'ask'): AgentOptions {
  return { effort: '', thinking: 'on', summary: 'auto', permission, useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false,
    ...(provider === 'copilot' ? { copilotRuntime: 'auto' as const } : {}) };
}
function newAgent(name: string, provider: ProviderId, model: string, permission: PermissionLevel): Agent {
  return { id: randomUUID(), name, provider, model, role: '', enabled: true, tools: [...DEFAULT_TOOLS], options: defaultOptions(provider, permission) };
}
export function createRoom(defaults?: ModelDefaults, preset: TaskPreset = 'planning', permission: PermissionLevel = 'ask'): Room {
  return { id: randomUUID(), title: 'New conversation', createdAt: Date.now(), messages: [], activity: [], schema: SCHEMA,
    tokenBudget: 0, usage: {}, status: 'idle', completedTurns: 0, preset, mode: 'sequential', concurrency: 3, activeAgents: [], queuedTurns: 0, documents: [],
    loop: { ...DEFAULT_LOOP }, attachEditor: true, shareSkills: true,
    agents: [
      newAgent('Codex', 'codex', defaults?.[preset]?.codex ?? '', permission),
      newAgent('Claude', 'claude', defaults?.[preset]?.claude || 'sonnet', permission),
      newAgent('Copilot', 'copilot', defaults?.[preset]?.copilot ?? '', permission)
    ] };
}
function migrateAgent(raw: any, schema: number, permission: PermissionLevel): Agent {
  const provider: ProviderId = ['codex', 'claude', 'copilot', 'ollama'].includes(raw.provider) ? raw.provider : 'ollama';
  const options: AgentOptions = { ...defaultOptions(provider, permission), ...(raw.options && typeof raw.options === 'object' ? raw.options : {}) };
  if (typeof raw.reasoning === 'string' && options.effort === '') options.effort = raw.reasoning;
  if (!PERMISSIONS.includes(options.permission)) options.permission = permission;
  if (!Array.isArray(options.extraDirs)) options.extraDirs = [];
  delete raw.reasoning;
  raw.provider = provider; raw.options = options;
  raw.name = typeof raw.name === 'string' && raw.name ? raw.name : PROVIDER_LABELS[provider];
  raw.model = typeof raw.model === 'string' ? raw.model : '';
  raw.role = typeof raw.role === 'string' && !OLD_DEFAULT_ROLES.has(raw.role) ? raw.role : '';
  raw.enabled = raw.enabled !== false;
  raw.tools = Array.isArray(raw.tools) ? raw.tools.filter((t: unknown) => TOOL_NAMES.includes(t as ToolName)) : [...DEFAULT_TOOLS];
  if (schema < 3 && raw.tools.includes('read_file') && !raw.tools.includes('search_documents')) raw.tools.push('search_documents');
  if (schema < 5 || (raw.session && typeof raw.session !== 'object')) delete raw.session;
  if (raw.isolate !== undefined && raw.isolate !== true) delete raw.isolate;
  if (raw.worktree !== undefined && (typeof raw.worktree?.path !== 'string' || typeof raw.worktree?.branch !== 'string')) delete raw.worktree;
  return raw as Agent;
}
/** Upgrades a saved room to the current schema. Safe to run more than once. */
export function migrateRoom(raw: any, defaults: { attachEditor: boolean; shareSkills: boolean; permission: PermissionLevel }): Room {
  const schema = typeof raw.schema === 'number' ? raw.schema : 0;
  raw.agents = (Array.isArray(raw.agents) ? raw.agents : []).filter((a: any) => a && typeof a.id === 'string').map((a: any) => migrateAgent(a, schema, defaults.permission));
  raw.messages = (Array.isArray(raw.messages) ? raw.messages : []).filter((m: any) => m && typeof m.id === 'string');
  raw.activity = Array.isArray(raw.activity) ? raw.activity : [];
  raw.usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  raw.tokenBudget = typeof raw.tokenBudget === 'number' ? raw.tokenBudget : 0;
  // The old default room budget (50,000 tokens for the room's whole life) stopped runs after one Codex turn.
  if (schema < 4 && raw.tokenBudget === 50000) raw.tokenBudget = 0;
  raw.completedTurns = typeof raw.completedTurns === 'number' ? raw.completedTurns : 0;
  raw.title = typeof raw.title === 'string' ? raw.title : 'New conversation';
  raw.status ??= 'idle';
  const rounds = typeof raw.rounds === 'number' ? Math.min(50, Math.floor(raw.rounds)) : 1;
  raw.loop = raw.loop && typeof raw.loop === 'object' ? { ...DEFAULT_LOOP, ...raw.loop } : rounds > 1 ? { ...DEFAULT_LOOP, kind: 'rounds', rounds } : { ...DEFAULT_LOOP };
  delete raw.rounds;
  raw.attachEditor ??= defaults.attachEditor; raw.shareSkills ??= defaults.shareSkills;
  if (raw.loopState && typeof raw.loopState === 'object') delete raw.loopState.nextAt; else delete raw.loopState;
  if (raw.worktrees !== undefined && !['off', 'auto', 'always'].includes(raw.worktrees)) delete raw.worktrees;
  if (raw.changes !== undefined && (typeof raw.changes?.base !== 'string' || typeof raw.changes?.branch !== 'string' || !Array.isArray(raw.changes?.files))) delete raw.changes;
  if (raw.sandbox !== undefined && typeof raw.sandbox !== 'boolean') delete raw.sandbox;
  for (const m of raw.messages as Message[]) {
    if (m.status === 'streaming') m.status = 'cancelled';
    if (m.approval?.status === 'pending') m.approval.status = 'expired';
    if (m.sandbox && typeof m.sandbox === 'object' && !sandboxFinished(m.sandbox) && m.sandbox.status !== 'denied') {
      Object.assign(m.sandbox, { status: 'cancelled', error: 'Interrupted when the window closed.' });
      m.text = sandboxSummary(m.sandbox);
    }
    for (const step of m.plan ?? []) if (step.status === 'pending' || step.status === 'running') Object.assign(step, { status: 'skipped', detail: 'Interrupted when the window closed.' });
  }
  raw.schema = SCHEMA;
  return raw as Room;
}
/**
 * Applies a loop patch (bounded). The time cap counts from the loop's start, scheduled waits included, so an interval loop
 * that keeps the default cap without asking for one (as /loop every … does) drops it when it would cut the loop short.
 */
export function patchLoop(current: LoopConfig, patch: Partial<LoopConfig>): LoopConfig {
  const loop: LoopConfig = {
    kind: (['once', 'rounds', 'consensus', 'lead-done', 'interval'] as LoopConfig['kind'][]).includes(patch.kind as LoopConfig['kind']) ? patch.kind as LoopConfig['kind'] : current.kind,
    rounds: boundedNumber(patch.rounds, 1, 50, current.rounds), everyMinutes: boundedNumber(patch.everyMinutes, 1, 1440, current.everyMinutes),
    maxIterations: boundedNumber(patch.maxIterations, 1, 50, current.maxIterations), maxMinutes: boundedNumber(patch.maxMinutes, 0, 1440, current.maxMinutes),
    maxTokens: boundedNumber(patch.maxTokens, 0, 10_000_000, current.maxTokens)
  };
  const prompt = typeof patch.prompt === 'string' ? patch.prompt.trim().slice(0, 24000) : 'prompt' in patch ? '' : current.prompt;
  if (prompt) loop.prompt = prompt;
  if (loop.kind === 'interval' && patch.maxMinutes === undefined && loop.maxMinutes > 0 && loop.maxMinutes <= loop.everyMinutes * (loop.maxIterations - 1)) loop.maxMinutes = 0;
  return loop;
}
export function message(kind: Message['kind'], text: string, author = 'You', agentId?: string): Message {
  return { id: randomUUID(), kind, text, author, agentId, createdAt: Date.now(), status: 'complete' };
}

// ── The changes card (agents' worktrees) ─────────────────────────────────────
const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
/** The card's text; the webview renders the card from `changes`, this is what exports and plain views show. */
export function changesText(c: RoomChanges): string {
  const totals = `(+${c.added} −${c.removed})`;
  switch (c.status) {
    case 'applied': return `Applied ${files(c.files.length)} ${totals} to your folder. They are not committed.`;
    case 'kept': return `Kept the agents' changes as branch ${c.kept ?? c.branch}.`;
    case 'discarded': return 'Discarded the agents\' changes.';
    default: return `Agents changed ${files(c.files.length)} in their worktrees ${totals}. Review them, then apply them to your folder or keep them as a branch.`;
  }
}
const copyChanges = (c: RoomChanges): RoomChanges => ({ ...c, files: c.files.map(f => ({ ...f })), ...(c.conflicts ? { conflicts: c.conflicts.map(x => ({ ...x, files: [...x.files] })) } : {}) });
/**
 * Keeps one live card for the room's changes: the latest card is updated in place while it is for the same base and still open
 * (ready or conflict); otherwise a new card is posted (when `push`). Returns the card.
 */
export function upsertChangesCard(room: Room, now: number, push = true): Message | undefined {
  const changes = room.changes;
  if (!changes) return;
  const last = [...room.messages].reverse().find(m => m.kind === 'notice' && m.changes);
  const copy = copyChanges(changes);
  if (last?.changes && last.changes.base === changes.base && (last.changes.status === 'ready' || last.changes.status === 'conflict')) {
    last.changes = copy; last.text = changesText(copy);
    return last;
  }
  if (!push) return;
  const card = message('notice', changesText(copy), 'Chatroom');
  card.createdAt = now; card.changes = copy;
  room.messages.push(card);
  return card;
}

// ── The sandbox card ─────────────────────────────────────────────────────────
export const SANDBOX_LANGUAGE_NAMES: Record<SandboxLanguage, string> = { bash: 'Bash', python: 'Python', node: 'Node.js' };
const SANDBOX_ALIASES: Record<string, SandboxLanguage> = { bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', python: 'python', python3: 'python', py: 'python',
  node: 'node', nodejs: 'node', js: 'node', javascript: 'node', mjs: 'node', cjs: 'node' };
/** "py", "javascript", "sh"… (a code fence's language) as a sandbox language. */
export const sandboxLanguage = (value: unknown): SandboxLanguage | undefined => typeof value === 'string' && Object.hasOwn(SANDBOX_ALIASES, value.trim().toLowerCase()) ? SANDBOX_ALIASES[value.trim().toLowerCase()] : undefined;
/** A run that has ended (with a result, or failed, timed out or cancelled); 'denied' runs never started. */
export const sandboxFinished = (r: SandboxResult) => r.status === 'done' || r.status === 'failed' || r.status === 'timeout' || r.status === 'cancelled';
export const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
/** What ran, in one line: the command's first line, or "Python code: <first line>". */
export function sandboxWhat(r: SandboxResult): string {
  const lines = String(r.command ?? '').split('\n').map(l => l.trim()).filter(Boolean), first = lines[0] ?? '';
  const short = first.length > 100 ? `${first.slice(0, 99)}…` : first;
  if (r.language) return `${SANDBOX_LANGUAGE_NAMES[r.language] ?? r.language} code${short ? `: ${short}` : ''}`;
  return `${short}${lines.length > 1 ? ' …' : ''}`;
}
/** The run's state in a few words: "running", "exit code 1 · 2.4 s", "timed out after 120 s"… */
export function sandboxStatusText(r: SandboxResult): string {
  switch (r.status) {
    case 'pending': return 'preparing';
    case 'pulling': return `downloading ${r.image}`;
    case 'running': return 'running';
    case 'done': return `exit code ${r.exitCode ?? '?'}${r.durationMs !== undefined ? ` · ${formatSeconds(r.durationMs)}` : ''}`;
    case 'timeout': return `timed out after ${r.limits.timeoutSeconds} s and was stopped`;
    case 'cancelled': return 'cancelled';
    case 'denied': return 'declined';
    default: return `failed${r.error ? `: ${r.error}` : ''}`;
  }
}
/** The card's text (exports and plain views); the webview renders the card from `sandbox`. */
export const sandboxSummary = (r: SandboxResult) => `Sandbox · ${sandboxWhat(r)} · ${sandboxStatusText(r)}`;
/**
 * A run as text: what ran, how it ended, the output tails and the files it made. `echo` repeats the command or code (other agents
 * need it; the agent that asked does not); `texts` adds the requested output files' text while it fits in `max`.
 */
export function sandboxReport(r: SandboxResult, opts: { tail?: number; echo?: boolean; texts?: boolean; max?: number } = {}): string {
  const tail = opts.tail ?? 8000, max = opts.max ?? 23_000;
  const cut = (text: string) => text.length > tail ? `[… ${(text.length - tail).toLocaleString('en')} earlier characters]\n${text.slice(-tail)}` : text;
  const code = (text: string) => text.length > 2000 ? `${text.slice(0, 2000)}\n[… ${(text.length - 2000).toLocaleString('en')} more characters]` : text;
  const files = r.files ?? [];
  const parts = [
    `Sandbox run requested by ${r.requestedBy} · ${r.image} · ${r.profile} profile · network ${r.network ? 'on' : 'off'} · limits ${r.limits.cpus} CPUs, ${r.limits.memoryMb} MB, ${r.limits.timeoutSeconds} s`,
    opts.echo ? (r.language ? `${SANDBOX_LANGUAGE_NAMES[r.language] ?? r.language} code:\n${code(r.command)}` : `Command: ${code(r.command)}`) : '',
    r.purpose && opts.echo ? `Purpose: ${r.purpose}` : '',
    `Result: ${sandboxStatusText(r)}`,
    r.error && r.status !== 'failed' ? `Note: ${r.error}` : '',
    r.stdout ? `stdout:\n${cut(r.stdout)}` : 'stdout: (empty)',
    r.stderr ? `stderr:\n${cut(r.stderr)}` : 'stderr: (empty)',
    files.length ? `Files created or changed in /work (${files.length}): ${files.map(f => `${f.path} (${formatBytes(f.size)})`).join(', ')}` : ''
  ].filter(Boolean);
  let text = parts.join('\n');
  if (opts.texts) for (const file of files.filter(f => f.text !== undefined)) {
    const room = max - text.length - 80;
    if (room < 200) { text += `\n[More file contents are on the sandbox card.]`; break; }
    const body = file.text!.length > room ? `${file.text!.slice(0, room)}\n[… truncated]` : file.text!;
    text += `\n--- ${file.path} ---\n${body}`;
  }
  return text.slice(0, max);
}
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);
export const usageTotal = (usage: Usage) => usage.input + usage.output;
export const roomTotal = (room: Room) => Object.values(room.usage).reduce((sum, u) => sum + usageTotal(u), 0);
/** Tokens that are new work. Clients report cached re-reads inside `input`; they are excluded here. */
export const freshTokens = (usage: Usage) => Math.max(0, usage.input - usage.cached) + usage.output;
export const roomFresh = (room: Room) => Object.values(room.usage).reduce((sum, u) => sum + freshTokens(u), 0);
/** The optional token limit (0 = none) counts new tokens since the current message was sent or resumed. */
export const runTokens = (room: Room) => Math.max(0, roomFresh(room) - (room.runStartTokens ?? 0));
export const overLimit = (room: Room) => room.tokenBudget > 0 && runTokens(room) >= room.tokenBudget;
export function estimatedUsage(input: string, output: string): Usage {
  return { ...emptyUsage(), input: estimateTokens(input), output: estimateTokens(output), requests: 1, estimated: true };
}
/** The agent that plans and answers in Team mode: the chosen lead, else the first enabled agent. */
export function leadAgent(room: Room): Agent | undefined {
  return room.agents.find(a => a.id === room.leadId && a.enabled) ?? room.agents.find(a => a.enabled);
}

// ── Availability ─────────────────────────────────────────────────────────────
const USAGE_TEXT = /usage limit|quota|rate.?limit|exceeded your|credit balance|insufficient_quota|out of credits|premium requests?/i;
const MODEL_TEXT = /\bmodel\b[^\n.]{0,80}\b(not found|not available|unavailable|does not exist|doesn'?t exist|isn'?t available|not supported|unsupported|invalid|no access|not allowed)|\b(unknown|invalid|unsupported) model\b|No matching Copilot model/i;
const OFFLINE_TEXT = /fetch failed|ECONNREFUSED|ECONNRESET|connect E|socket hang up|not running/i;
/** Whether a failed turn means the agent cannot run for now (usage limit, missing CLI, signed out, model not available, Ollama not running). */
export function classifyUnavailable(error: unknown, agent: Agent, now: number): Unavailable | undefined {
  const text = error instanceof Error ? error.message : String(error), detail = text.slice(0, 300);
  const mark = (reason: UnavailableReason, extra: Partial<Unavailable> = {}): Unavailable => ({ reason, detail, at: now, ...extra });
  const model = () => mark('model', agent.model ? { model: agent.model } : {});
  if (error instanceof ProviderError) {
    if (error.code === 'usage-limit') return mark('usage-limit', { until: error.extra?.resetsAt ?? now + 15 * 60000 });
    if (error.code === 'missing' || error.code === 'signed-out') return mark(error.code);
    if (error.code === 'model-unavailable') return model();
  }
  if (USAGE_TEXT.test(text)) return mark('usage-limit', { until: now + 15 * 60000 });
  if (MODEL_TEXT.test(text)) return model();
  if (agent.provider === 'ollama' && OFFLINE_TEXT.test(text)) return mark('offline', { until: now + 2 * 60000 });
}
/** A short phrase: "out of usage until Thu 23:23", "not installed", "signed out", "model x is not available", "not running". */
export function unavailableText(u: Unavailable, now: number): string {
  switch (u.reason) {
    case 'usage-limit': {
      if (u.until === undefined) return 'out of usage';
      const far = u.until - now > 6 * 86400000;
      return `out of usage until ${new Date(u.until).toLocaleString('en', { ...(far ? { month: 'short', day: 'numeric' } : { weekday: 'short' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
    }
    case 'missing': return 'not installed';
    case 'signed-out': return 'signed out';
    case 'model': return `model ${u.model || 'default'} is not available`;
    default: return 'not running';
  }
}
/** No mark on the agent, or its mark has run out. */
const availableNow = (agent: Agent) => !agent.unavailable || (agent.unavailable.until !== undefined && agent.unavailable.until <= Date.now());

// ── The user's own teams ─────────────────────────────────────────────────────
const stage = (name: string, agents: string[], extra: Partial<TeamStage> = {}): TeamStage => ({ name, agents, run: 'parallel', lead: false, ...extra });
export const BUILTIN_TEAMS: TeamConfig[] = [
  { name: 'Lead, draft, review', builtIn: true, wrapUp: true, stages: [stage('Leads', ['Claude'], { lead: true }), stage('Drafting', ['Codex'], { preset: 'drafting' }), stage('Review', ['Claude', 'Copilot'], { preset: 'review' })] },
  { name: 'Build and test', builtIn: true, wrapUp: true, stages: [stage('Leads', ['Claude'], { lead: true }), stage('Coding', ['Codex']), stage('Testing', ['Copilot'], { task: 'Write and run tests for the change' }), stage('Review', ['Claude'], { preset: 'review' })] },
  { name: 'Draft and review', builtIn: true, wrapUp: false, stages: [stage('Drafting', ['Codex'], { preset: 'drafting' }), stage('Review', ['Claude'])] }
];
const PRESET_NAMES: TaskPreset[] = ['planning', 'drafting', 'review'];
const clip = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
/** A team from settings or the webview, bounded and cleaned; undefined when no stage has an agent. */
export function normalizeTeam(raw: unknown): TeamConfig | undefined {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Record<string, unknown>, stages: TeamStage[] = [];
  for (const item of Array.isArray(r.stages) ? r.stages : []) {
    if (stages.length >= 8) break;
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>, agents: string[] = [];
    for (const ref of Array.isArray(s.agents) ? s.agents : []) {
      const value = clip(ref, 40);
      if (value && agents.length < 8 && !agents.some(a => a.toLowerCase() === value.toLowerCase())) agents.push(value);
    }
    if (!agents.length) continue;
    const name = clip(s.name, 40) || `Stage ${stages.length + 1}`, task = clip(s.task, 500);
    stages.push({ name, agents, run: s.run === 'relay' ? 'relay' : 'parallel', lead: typeof s.lead === 'boolean' ? s.lead : /^lead(s|er|ers)?\b/i.test(name),
      ...(task ? { task } : {}), ...(PRESET_NAMES.includes(s.preset as TaskPreset) ? { preset: s.preset as TaskPreset } : {}) });
  }
  if (!stages.length) return;
  return { name: clip(r.name, 40) || 'My team', stages, wrapUp: typeof r.wrapUp === 'boolean' ? r.wrapUp : stages.some(s => s.lead) };
}
const STAGE_PROVIDERS: Record<string, ProviderId> = { claude: 'claude', codex: 'codex', copilot: 'copilot', ollama: 'ollama', 'claude code': 'claude', 'github copilot': 'copilot' };
/** A stage's enabled agents, by agent name or by provider name when exactly one enabled agent has that provider. */
export function stageAgents(stage: TeamStage, room: Room): Agent[] {
  const enabled = room.agents.filter(a => a.enabled), out: Agent[] = [];
  for (const ref of stage.agents) {
    const key = ref.trim().toLowerCase(), provider = STAGE_PROVIDERS[key], owners = provider ? enabled.filter(a => a.provider === provider) : [];
    const agent = enabled.find(a => a.name.trim().toLowerCase() === key) ?? (owners.length === 1 ? owners[0] : undefined);
    if (agent && !out.includes(agent)) out.push(agent);
  }
  return out;
}
/** "Leads (Claude) → Drafting (Codex) → Review (Claude, Copilot)". */
export function teamPlan(team: TeamConfig, room: Room): string {
  return team.stages.map(s => `${s.name} (${stageAgents(s, room).map(a => a.name).join(', ') || 'nobody'})`).join(' → ');
}
/** The first available agent of the team's first lead stage. */
export function pipelineLead(room: Room, available: (agent: Agent) => boolean = availableNow): Agent | undefined {
  const first = room.team?.stages.find(s => s.lead);
  return first ? stageAgents(first, room).find(available) : undefined;
}

// ── Room framing (§7) ────────────────────────────────────────────────────────
export interface FramingContext {
  connections: Connection[]; caps: Record<string, AgentCapabilities | undefined>; skillsIndex?: string; legacy?: boolean;
  /** Why an agent cannot run right now (its mark, or live status); undefined = it can. */
  unavailable?: (agent: Agent) => Unavailable | undefined;
}
/** Whether an agent runs as its own CLI (native tools and session) rather than as a chat model. */
export function usesCli(agent: Agent, connections: Connection[]): boolean {
  if (agent.provider === 'claude' || agent.provider === 'codex') return true;
  if (agent.provider !== 'copilot') return false;
  const choice = agent.options?.copilotRuntime ?? 'auto';
  return choice !== 'vscode-lm' && (choice === 'cli' || connections.find(c => c.id === 'copilot')?.runtime === 'cli');
}
function runtimeLabel(agent: Agent, native: boolean): string {
  if (agent.provider === 'claude') return 'Claude Code';
  if (agent.provider === 'codex') return 'Codex CLI';
  if (agent.provider === 'copilot') return native ? 'GitHub Copilot CLI' : 'GitHub Copilot (VS Code chat model)';
  return 'Ollama (local model)';
}
const ABILITY: Record<PermissionLevel, string> = { plan: 'read-only (planning)', ask: 'edits files and runs commands with the user\'s approval',
  'auto-edit': 'edits files directly, asks before other actions', full: 'full access' };
const mentionName = (name: string) => /\s/.test(name) ? `"${name}"` : name;
export function roomFraming(agent: Agent, room: Room, ctx: FramingContext): string {
  const now = Date.now(), why = (a: Agent) => a.id === agent.id ? undefined : ctx.unavailable?.(a);
  const enabled = room.agents.filter(a => a.enabled), team = enabled.filter(a => !why(a)), other = team.find(a => a.id !== agent.id);
  const away = enabled.filter(a => why(a)).map(a => `${a.name} (${unavailableText(why(a)!, now)})`);
  const pipeline = room.mode === 'pipeline' && room.team ? room.team : undefined, chosen = room.mode === 'orchestrated' || (room.mode === 'pipeline' && !pipeline) ? leadAgent(room) : undefined;
  const lead = chosen && why(chosen) ? team[0] : chosen;
  const line = (a: Agent) => {
    const native = usesCli(a, ctx.connections);
    return `- ${a.name}${a.id === agent.id ? ' (you)' : ''} · ${runtimeLabel(a, native)}${a.model ? ` (${a.model})` : ''} · ${native ? `own tools, skills and MCP; ${ABILITY[a.options?.permission ?? 'ask']}` : 'chat model with Chatroom\'s read-only file tools'}`;
  };
  return [
    `You are ${agent.name}, one of the AI agents in Chatroom: a shared chat room in VS Code where the user works with several agents together.`,
    'In the room:',
    '- The user',
    ...team.map(line),
    ctx.legacy ? 'The conversation so far is included below as <room from="Name">…</room> blocks.'
      : 'Messages from the user and the other agents reach you as <room from="Name">…</room> blocks. Your own earlier replies are already in your history, so you only receive what is new.',
    'Work as a team: build on what others found, correct mistakes with evidence, share findings that help, and don\'t redo work someone already did. Help teammates when they ask, but the user\'s requests come first.',
    team.length >= 2 && other ? `To ask a teammate for help or hand off a task, start a line with @Name and say what you need, for example "@${mentionName(other.name)} can you check the failing test?". Mention someone only when you need them.` : '',
    pipeline ? `This room works as a team in stages: ${teamPlan(pipeline, room)}.`
      : lead ? (lead.id === agent.id ? 'You lead this room: the user\'s requests come to you first, and you decide whether to answer yourself or bring in teammates.' : `${lead.name} leads this room and may ask you for help.`) : '',
    away.length ? `Unavailable right now: ${away.join(', ')}.` : '',
    agent.role.trim() ? `Your focus in this room: ${agent.role.trim()}` : '',
    !ctx.legacy && agent.worktree ? `You work in your own git worktree (branch ${agent.worktree.branch}); your edits reach the user's folder only after the room combines and reviews them. Other agents' changes reach you when the room combines the work.` : '',
    !ctx.legacy && room.shareSkills && ctx.skillsIndex ? `Skills from the other agents are listed in ${ctx.skillsIndex}; open a SKILL.md from there when one fits the task.` : ''
  ].filter(Boolean).join('\n');
}
export function framingHash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 16); }
/** The room-update entry sent to an existing session when its framing changed. */
export function roomUpdate(framing: string): string { return `<room from="Chatroom">Room update:\n${framing.split('\n').slice(1).join('\n')}</room>`; }

// ── Delta delivery (§6.2) ────────────────────────────────────────────────────
/** What a turn is for. Determines the ask and which messages the agent receives. */
export interface TurnSpec {
  kind: TurnKind; parallel?: boolean; flow?: Flow; step?: PlanStep; round?: number; rounds?: number; wavesLeft?: number;
  handoff?: { from: string; line: string }; loop?: LoopConfig; iteration?: number; briefing?: string; trigger?: Message;
  /** A turn in a stage of the room's own team; `others` are the stage's other agents, `plan` is teamPlan(). */
  stage?: { index: number; total: number; name: string; lead?: boolean; task?: string; others: string[]; plan: string; standIn?: string[] };
  /** The wrap-up synthesis after a team's stages: teamPlan(). */
  teamPlan?: string;
  /** A merge turn: the files whose conflict markers the agent resolves in its own worktree. */
  merge?: { files: string[] };
}
const OMITTED = 'omitted:';
const attr = (value: string) => value.replace(/"/g, '\'');
const body = (text: string) => text.replace(/<\/room>/gi, '<\\/room>');
export const isRoomUpdate = (m: Message) => m.kind === 'notice' && m.text.startsWith('Room update:');
export function renderEntry(m: Message, room: Room): string {
  const name = (id: string) => room.agents.find(a => a.id === id)?.name ?? id;
  if (m.kind === 'notice' && m.sandbox) return `<room from="Sandbox">\n${body(sandboxReport(m.sandbox, { tail: 4000, echo: true, max: 12_000 }))}\n</room>`;
  if (m.kind === 'notice') return `<room from="Chatroom">${body(m.text)}</room>`;
  const author = m.kind === 'user' ? 'User' : room.agents.find(a => a.id === m.agentId)?.name ?? m.author;
  const to = m.kind === 'user' ? m.targets : m.handoff && m.handoff.from === m.agentId ? m.handoff.to : undefined;
  const attrs = [`from="${attr(author)}"`,
    to?.length ? `to="${attr(to.map(name).join(', '))}"` : '',
    m.step ? `step="${attr(`${m.step.id}: ${m.step.task.slice(0, 120)}`)}"` : '',
    m.stage ? `stage="${attr(`${m.stage.name} (${m.stage.index + 1}/${m.stage.total})`)}"` : '',
    m.turn === 'plan' ? 'kind="plan"' : m.turn === 'synthesis' ? 'kind="final answer"' : ''].filter(Boolean).join(' ');
  return `<room ${attrs}>\n${body(m.text)}${m.plan?.length ? `\n${body(planText(m.plan, room.agents))}` : ''}\n</room>`;
}
export function renderContext(messages: Message[], room: Room, maxChars: number): string {
  const blocks = messages.map(m => m.id.startsWith(OMITTED) ? m.text : renderEntry(m, room));
  const selected: string[] = [];
  let remaining = Math.max(200, maxChars), omitted = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.length + 2 > remaining) {
      if (selected.length) omitted = i + 1;
      else { selected.unshift(block.slice(0, remaining - 40) + '\n[message truncated]'); omitted = i; }
      break;
    }
    selected.unshift(block); remaining -= block.length + 2;
  }
  return [omitted ? `[${omitted} earlier room messages omitted]` : '', ...selected].filter(Boolean).join('\n\n');
}
function deliverable(m: Message, agentId: string, includeOwn = false): boolean {
  if (m.turn === 'command') return false;
  if (m.kind === 'user') return true;
  if (m.kind === 'agent') return m.status === 'complete' && (includeOwn || m.agentId !== agentId);
  // A finished sandbox run reaches every agent; the agent that asked for it already has the result from its tool call.
  if (m.kind === 'notice' && m.sandbox) return sandboxFinished(m.sandbox) && (includeOwn || m.sandbox.agentId !== agentId);
  return isRoomUpdate(m);
}
/** Steps see the history, the plan and only the outputs they build on; the synthesis sees every output of the plan. */
function stepFilter(room: Room, spec: TurnSpec): (m: Message, index: number) => boolean {
  const planId = spec.flow?.planId;
  if ((spec.kind !== 'step' && spec.kind !== 'synthesis') || !planId) return () => true;
  const planIndex = room.messages.findIndex(m => m.id === planId);
  if (planIndex < 0) return () => true;
  const needed = spec.kind === 'step' ? new Set(spec.step?.after ?? []) : undefined;
  return (m, index) => index <= planIndex || (!!m.step && m.step.plan === planId && (!needed || needed.has(m.step.id)));
}
export function boundedHistory(room: Room, agent: Agent, maxTokens: number, spec: TurnSpec): Message[] {
  const visible = stepFilter(room, spec);
  const eligible = room.messages.filter((m, i) => deliverable(m, agent.id, true) && visible(m, i));
  const first = eligible.find(m => m.kind === 'user');
  const budget = Math.max(600, maxTokens * 3);
  const objectiveLimit = Math.min(9000, Math.floor(budget * (eligible.length > 1 ? 0.45 : 0.9)));
  const objective = first && first.text.length > objectiveLimit ? { ...first, text: first.text.slice(0, objectiveLimit) + '\n[objective truncated]' } : first;
  let remaining = budget - (objective ? renderEntry(objective, room).length + 2 : 0);
  const rest = eligible.filter(m => m !== first), selected: Message[] = [];
  let omitted = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]!, size = renderEntry(m, room).length + 2;
    if (size > remaining) {
      if (!selected.length && remaining > 300) selected.unshift({ ...m, text: m.text.slice(0, remaining - 200) + '\n[message truncated]' });
      omitted = selected.length && selected[0]!.id === m.id ? i : i + 1; break;
    }
    selected.unshift(m); remaining -= size;
  }
  const marker: Message[] = omitted ? [{ id: `${OMITTED}${omitted}`, kind: 'notice', author: 'Chatroom', text: `[${omitted} earlier messages omitted]`, createdAt: 0, status: 'complete' }] : [];
  return [...(objective ? [objective] : []), ...marker, ...selected];
}
/** The count in boundedHistory's omission marker, if any. */
export const omittedCount = (messages: Message[]) => Number(messages.find(m => m.id.startsWith(OMITTED))?.id.slice(OMITTED.length) ?? 0);
export function unseenEntries(room: Room, agent: Agent, spec: TurnSpec, maxTokens = 12000): Message[] {
  const session = agent.session;
  if (!session) return boundedHistory(room, agent, maxTokens, spec);
  const seen = session.seen ? room.messages.findIndex(m => m.id === session.seen) : -1;
  const start = seen >= 0 ? seen + 1 : Math.max(0, room.messages.length - 20);
  const visible = stepFilter(room, spec);
  // After a step turn seen stays at the plan; outputs the agent's own completed steps already received as inputs are not sent again.
  const given = new Set(room.messages.filter(m => m.agentId === agent.id && m.status === 'complete' && m.step?.plan).flatMap(m => m.step!.after.map(id => `${m.step!.plan}#${id}`)));
  return room.messages.filter((m, i) => i >= start && deliverable(m, agent.id) && visible(m, i) && !(m.step?.plan && given.has(`${m.step.plan}#${m.step.id}`)));
}

// ── Asks (§6.4) ──────────────────────────────────────────────────────────────
const PLAN_ASK = 'You\'re leading this request. If you can answer it well yourself, just answer. To bring in teammates, end your reply with one line per teammate: "@Name <their task>"; they work in parallel and you\'ll get their results to write the final answer. If some tasks depend on others, end instead with <chatroom-plan>{"steps":[{"id":"s1","agent":"Name","task":"…","after":[]},{"id":"s2","agent":"Name","task":"…","after":["s1"]}]}</chatroom-plan>.';
export function turnAsk(agent: Agent, room: Room, spec: TurnSpec): string {
  const lead = room.agents.find(a => a.id === spec.flow?.leadId) ?? leadAgent(room);
  const n = spec.rounds ?? 1, R = n > 1 ? `, round ${spec.round ?? 1} of ${n}` : '';
  let ask = '';
  switch (spec.kind) {
    case 'discussion':
      ask = spec.parallel ? `It's your turn (parallel${R}): the others are answering at the same time; you'll see their replies next round.`
        : `It's your turn (relay${R}): respond to the latest request and build on the replies above.`;
      break;
    case 'plan': ask = room.agents.filter(a => a.enabled).length > 1 ? PLAN_ASK : ''; break;
    case 'step': {
      const step = spec.step!, name = lead?.name ?? 'The lead';
      ask = `${name} asked you (step ${step.id}): ${step.task}${step.after.length ? ` It builds on step ${step.after.join(', ')} above.` : ''} Do just this part; ${name} will combine the results.`;
      break;
    }
    case 'synthesis': {
      const k = spec.wavesLeft ?? 0;
      if (spec.teamPlan) { ask = `The team has finished its stages (${spec.teamPlan}). Write the final answer for the user: combine their work, resolve disagreements, and fix mistakes you notice.`; break; }
      ask = `Your teammates have replied above. Write the final answer for the user: combine their work, resolve disagreements, and fix mistakes you notice.${k > 0 ? ` If essential work is still missing, you can delegate again the same way (${k} more round${k === 1 ? '' : 's'} allowed).` : ''}`;
      break;
    }
    case 'handoff': ask = spec.handoff ? `${spec.handoff.from} mentioned you: "${spec.handoff.line}"` : ''; break;
    case 'merge': {
      const files = spec.merge?.files ?? [], shown = files.length > 20 ? `${files.slice(0, 20).join(', ')} and ${files.length - 20} more` : files.join(', ');
      ask = `Your changes conflict with the team's combined work in: ${shown}. The conflict markers are in your files now. Resolve them so both changes' intent is kept, then reply with one line saying what you kept.`;
      break;
    }
    case 'stage': {
      const s = spec.stage, task = s?.task?.trim().replace(/[\s.!?]+$/, '');
      if (!s) break;
      const next = s.index + 1 < s.total;
      ask = `Team stage ${s.index + 1} of ${s.total}: ${s.name}${s.others.length ? ` (with ${s.others.join(', ')})` : ''}. The team works in stages: ${s.plan}.${s.standIn?.length ? ` You're standing in for ${s.standIn.join(' and ')}, who can't run right now: do this stage's work yourself.` : ''}${task ? ` Your part: ${task}.` : ''}`
        + (s.lead ? ' You lead: if you can answer the request yourself, do it and end with [DONE]; otherwise set up the work for the next stages without doing their parts.'
          : s.index === 0 ? (next ? ' The next stage picks up from yours.' : '')
          : ` Build on the earlier stages' work above${next ? '; the next stage picks up from yours' : ''}.`);
      break;
    }
  }
  const i = spec.iteration ?? 1;
  if (i >= 2 && (spec.kind === 'discussion' || spec.kind === 'plan' || (spec.kind === 'stage' && spec.stage?.index === 0))) ask = `Round ${i}${spec.loop?.kind === 'rounds' ? ` of ${spec.loop.rounds}` : ''}: keep going — respond to what's new above. ${ask}`;
  if (spec.loop?.kind === 'consensus') ask += ' When you have nothing to add, say so briefly and end your reply with [AGREE].';
  const leads = spec.kind === 'stage' ? !!spec.stage?.lead : spec.teamPlan ? true : leadAgent(room)?.id === agent.id;
  if (spec.loop?.kind === 'lead-done' && leads) ask += ' When the task is complete, end your reply with [DONE].';
  return ask.trim();
}

// ── Legacy providers (Ollama, Copilot through vscode.lm) ─────────────────────
const TOOL_USAGE: Record<ToolName, string> = {
  list_files: '{"name":"list_files","arguments":{"glob":"src/**"}} — list workspace files.',
  read_file: '{"name":"read_file","arguments":{"path":"docs/spec.pdf"}} — read a workspace file (up to 24 KB of text). PDF, Word and image files are converted to text automatically, using local OCR for scans and images.',
  search_files: '{"name":"search_files","arguments":{"query":"literal text","glob":"src/**"}} — literal text search.',
  search_documents: '{"name":"search_documents","arguments":{"query":"what to look up"}} — search the documents attached to this room by meaning and return the most relevant passages.',
  ollama_ocr: '{"name":"ollama_ocr","arguments":{"path":"image.png"}} — extract text from a workspace image using the local vision model.',
  semantic_search: '{"name":"semantic_search","arguments":{"query":"your question","glob":"src/**"}} — rank workspace snippets with the local embedding model.'
};
function describeDocument(d: RoomDocument): string {
  const parts = [d.kind === 'pdf' ? 'PDF' : d.kind === 'docx' ? 'Word' : d.kind];
  if (d.pages) parts.push(`${d.pages} page${d.pages === 1 ? '' : 's'}`);
  if (d.ocrPages) parts.push(`${d.ocrPages} read with OCR`);
  parts.push(`${d.chars.toLocaleString('en')} characters`);
  return `- ${d.name} · ${parts.join(', ')}`;
}
/** Legacy system prompt from an already built (legacy) framing: framing, documents, then the tool protocol as the last paragraph. */
export function legacySystem(framing: string, agent: Agent, room: Room): string {
  const documents = (room.documents ?? []).filter(d => d.status === 'ready');
  return [framing,
    documents.length ? `Documents attached to this room (text already extracted; use search_documents to look up details):\n${documents.map(describeDocument).join('\n')}` : '',
    agent.tools.length ? 'Read-only file tools are available. Never invent filenames, file contents or tool results.\n\nTo use a Chatroom tool, output ONLY <chatroom-tool>{"name":"tool_name","arguments":{...}}</chatroom-tool>. Wait for its result before answering. Your tools:\n' + agent.tools.map(t => TOOL_USAGE[t]).join('\n')
      : 'No Chatroom tools are enabled for you.'
  ].filter(Boolean).join('\n\n');
}
export function systemPrompt(agent: Agent, room: Room, ctx: FramingContext): string {
  return legacySystem(roomFraming(agent, room, { ...ctx, legacy: true }), agent, room);
}
/** Bounded transcript plus the ask for a legacy provider, given its system prompt. */
export function legacyContext(room: Room, agent: Agent, maxTokens: number, spec: TurnSpec, system: string): { system: string; prompt: string; omitted: number } {
  const ask = turnAsk(agent, room, spec) || `Reply to the latest message as ${agent.name}.`;
  const available = Math.max(600, maxTokens * 3 - system.length - ask.length - 256);
  const briefingLimit = Math.floor(available * 0.3);
  const briefing = spec.briefing && briefingLimit > 200 ? spec.briefing.slice(0, briefingLimit) : '';
  const space = available - briefing.length;
  const history = boundedHistory(room, agent, Math.floor(space / 3), spec);
  const prompt = [briefing, renderContext(history, room, space), ask].filter(Boolean).join('\n\n');
  return { system, prompt, omitted: omittedCount(history) };
}
export function buildContext(room: Room, agent: Agent, maxTokens: number, spec: TurnSpec, ctx: FramingContext): { system: string; prompt: string; omitted: number } {
  return legacyContext(room, agent, maxTokens, spec, systemPrompt(agent, room, ctx));
}

// ── Plans and tool calls ─────────────────────────────────────────────────────
export function planStages(steps: PlanStep[]): PlanStep[][] {
  const level = new Map<string, number>(), stages: PlanStep[][] = [];
  for (const step of steps) {
    const value = Math.max(0, ...step.after.map(id => (level.get(id) ?? -1) + 1));
    level.set(step.id, value); (stages[value] ??= []).push(step);
  }
  return stages.filter(Boolean);
}
export function planText(steps: PlanStep[], agents: Agent[]): string {
  return '[Plan]\n' + steps.map(s => `${s.id} · ${agents.find(a => a.id === s.agentId)?.name ?? 'unknown agent'}: ${s.task}${s.after.length ? ` (after ${s.after.join(', ')})` : ''}`).join('\n');
}
export function parseToolCall(text: string): ToolCall | undefined {
  // Accept an action at the end of a response, including a short explanatory preamble.
  // Inline quoted examples are not actions. Native-capable providers use tool calls instead.
  const cleaned = text.trim().replace(/^```(?:json|xml)?\s*\n([\s\S]*?)\n```$/, '$1');
  const match = /(?:^|\n)[ \t]*<chatroom-tool>([\s\S]*?)<\/chatroom-tool>\s*$/.exec(cleaned);
  if (!match) return;
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]!); } catch { throw new Error('Agent returned invalid tool JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid tool request.');
  const call = parsed as ToolCall;
  if (!TOOL_NAMES.includes(call.name) || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Unknown tool or invalid arguments.');
  return call;
}
/**
 * Extracts a lead's step graph. Invalid steps are dropped with a note rather than failing the
 * lead's whole reply, and dependencies may only point at earlier steps, so the graph is acyclic.
 */
export function parsePlan(text: string, agents: Agent[]): { text: string; steps: PlanStep[]; notes: string[] } | undefined {
  const match = /<chatroom-plan>([\s\S]*?)(?:<\/chatroom-plan>|$)/.exec(text);
  if (!match) return;
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/```(?:json|xml)?\s*```/g, '').trim();
  const body = match[1]!.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let data: unknown;
  try { data = JSON.parse(body); } catch { return { text: rest, steps: [], notes: ['The lead returned an unreadable plan · its reply is treated as the answer'] }; }
  const raw = Array.isArray(data) ? data : (data as { steps?: unknown })?.steps;
  if (!Array.isArray(raw)) return { text: rest, steps: [], notes: ['The lead\'s plan has no steps · its reply is treated as the answer'] };
  const find = (value: string) => {
    const key = value.trim().toLowerCase(), byProvider = agents.filter(a => a.provider === key);
    return agents.find(a => a.id === value) ?? agents.find(a => a.name.toLowerCase() === key) ?? (byProvider.length === 1 ? byProvider[0] : undefined);
  };
  const steps: PlanStep[] = [], notes: string[] = [], ids = new Set<string>();
  for (const [index, item] of raw.slice(0, MAX_PLAN_STEPS).entries()) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    let id = typeof entry.id === 'string' || typeof entry.id === 'number' ? String(entry.id).trim().slice(0, 16) : '';
    if (!id || ids.has(id)) id = `s${index + 1}`;
    while (ids.has(id)) id += '+';
    const agent = find(String(entry.agent ?? '')), task = typeof entry.task === 'string' ? entry.task.trim().slice(0, 1500) : '';
    if (!agent || !task) { notes.push(`Skipped plan step ${id}: ${agent ? 'it has no task' : `"${String(entry.agent ?? '')}" is not an enabled agent`}`); continue; }
    const after = (Array.isArray(entry.after) ? entry.after : typeof entry.after === 'string' ? [entry.after] : []).map(String).filter(d => ids.has(d));
    ids.add(id); steps.push({ id, agentId: agent.id, task, after: [...new Set(after)], status: 'pending' });
  }
  if (raw.length > MAX_PLAN_STEPS) notes.push(`The plan was limited to ${MAX_PLAN_STEPS} steps`);
  return { text: rest, steps, notes };
}
export function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
}
