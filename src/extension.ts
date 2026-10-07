import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Agent, AgentCapabilities, Connection, DriverHost, DriverSettings, LoopConfig, ModelDefaults, ModelInfo, PermissionLevel, ProviderError, ProviderId, Room, RoomMode, RoomToolName, SandboxRequest, SharedMcpServer, SharedSkill, SkillWiring, StatePayload, TaskPreset, TeamConfig, Unavailable, WorktreeMode, addUsage, emptyUsage } from './types';
import { BUILTIN_TEAMS, DEFAULT_LOOP, DEFAULT_TOOLS, PERMISSIONS, PERMISSION_LABELS, PROVIDER_LABELS, TOOL_NAMES, boundedNumber, createRoom, defaultOptions, leadAgent, message, migrateRoom, normalizeTeam, overLimit, patchLoop, roomFraming, sandboxReport, teamPlan, unavailableText } from './core';
import { RoomEngine } from './engine';
import { OllamaClient } from './ollama';
import { Drivers, createDrivers, createLegacyProviders, detectConnections, legacyCapabilities, nativeDriverFor, providerRuntime } from './providers';
import { ToolService } from './tools';
import { RoomToolHost } from './room-tools';
import { discoverSkills, prepareSkillWiring } from './skills';
import { EditorTracker } from './editor-tracker';
import { EFFORT_ORDER } from './codex-native';
import { ROOM_COMMANDS, SANDBOX_USAGE, parseComposer, parseLoop, parseSandbox, parseTeam, parseWorktrees, resolveMention } from './commands';
import { DocumentService, LocalModels } from './documents';
import { KnowledgeStore, sha256 } from './knowledge';
import { MAX_DOCUMENT_BYTES } from './extract';
import { RoomWorktrees, WorktreeManager, cleanCodexTrust, worktreeRoot } from './worktrees';
import { DockerStatus, SANDBOX_DECLINED, SANDBOX_OFF, SandboxService, SandboxSettings, requestFromResult, sandboxOn, sandboxRequest, sandboxSettings, startDockerDesktop } from './sandbox';

const MODES: RoomMode[] = ['orchestrated', 'sequential', 'parallel', 'pipeline'];
const PRESETS: TaskPreset[] = ['planning', 'drafting', 'review'];
const PROVIDERS: ProviderId[] = ['codex', 'claude', 'copilot', 'ollama'];
const SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const AGENT_NAMES: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude', copilot: 'Copilot', ollama: 'Ollama' };
const RUNTIME_LABELS: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex CLI', copilot: 'GitHub Copilot CLI', ollama: 'Ollama' };
const BUSY = 'Wait for the agents to finish or press Stop.';
const FULL_ACCESS = 'Enable "chatroom.allowFullAccess" in Settings to use Full access.';
const NO_TEAM = 'Set up a team first: /team edit or /team Lead: Claude > Review: Codex';
const BAD_TEAM = 'That team has no stage with an agent.';
const WORKTREE_MODES: WorktreeMode[] = ['off', 'auto', 'always'];
const WORKTREE_ACTIONS = ['review', 'apply', 'keep', 'discard', 'cleanup'];
const NO_REPO = 'Worktrees need a git repository · agents share the folder.';
const MODE_TEXT: Record<WorktreeMode, string> = { off: 'off · agents share the folder', auto: 'auto · agents that edit without asking get their own worktree when others could edit at the same time',
  always: 'always · every agent that can edit gets its own worktree' };
const SANDBOX_SETTING_OFF = 'The sandbox is turned off in Settings (chatroom.sandbox.enabled). Turn it on there to use it.';
const SANDBOX_ROOM_OFF = 'The sandbox is off in this room. Turn it on with /sandbox on, or in Room setup.';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

let app: ChatroomApp | undefined;
export function activate(context: vscode.ExtensionContext): void {
  app = new ChatroomApp(context);
  context.subscriptions.push(app,
    vscode.window.registerWebviewViewProvider('chatroom.chat', app, { webviewOptions: { retainContextWhenHidden: true } }),
    // Restored layouts from 0.1 still request this view ID. Keep its resolver
    // registered even though new windows contribute only the right-hand view.
    vscode.window.registerWebviewViewProvider('chatroom.sidebar', app, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('chatroom.open', () => vscode.commands.executeCommand('chatroom.chat.focus')),
    vscode.commands.registerCommand('chatroom.openEditor', () => app!.openPanel()),
    vscode.commands.registerCommand('chatroom.new', () => app!.newRoom()),
    vscode.commands.registerCommand('chatroom.refresh', () => app!.refreshAll()),
    vscode.commands.registerCommand('chatroom.export', () => app!.exportRoom()),
    vscode.commands.registerCommand('chatroom.copilotLogin', () => app!.copilotTerminal('login')));
}
export function deactivate(): Promise<void> | undefined { return app?.dispose(); }

class ChatroomApp implements vscode.WebviewViewProvider, vscode.Disposable {
  private views = new Set<vscode.Webview>();
  private panel?: vscode.WebviewPanel;
  private rooms: Room[];
  private connections: Connection[] = [];
  private engine: RoomEngine;
  private ollama: OllamaClient;
  private tools: ToolService;
  private models: LocalModels;
  private knowledge: KnowledgeStore;
  private documents: DocumentService;
  private roomTools: RoomToolHost;
  private tracker: EditorTracker;
  private host: DriverHost;
  private drivers: Drivers;
  private legacy: ReturnType<typeof createLegacyProviders>;
  private caps = new Map<string, AgentCapabilities>();
  private capsLoading = new Set<string>();
  private sharedSkills: SharedSkill[] = [];
  private wiring?: SkillWiring;
  private skillsJob: Promise<void> = Promise.resolve();
  private ingestions = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  /** When the oldest unsaved change happened; streaming saves at least every 5 s. */
  private unsavedSince?: number;
  /** Minimum time between state broadcasts; grows with the cost of the last one (large rooms). */
  private broadcastDelay = 55;
  private disposed?: Promise<void>;
  private discovering = false;
  private pendingCopilot = false;
  /** The "Ollama isn't running" notice is posted once per window session. */
  private ollamaNoticed = false;
  private ollamaChecked = 0;
  private persistence: Promise<unknown> = Promise.resolve();
  /** Per-agent worktrees: the repository's manager (undefined when the workspace is not a git repository) and the room logic over it. */
  private worktreeManager?: WorktreeManager;
  private worktrees: RoomWorktrees;
  private worktreesAvailable = false;
  private worktreesSwept = false;
  private worktreeNoticed = false;
  /** Optional sandbox runs in Docker: the service, Docker's last known status, and whether orphans were swept this session. */
  private sandbox: SandboxService;
  private dockerChecking?: Promise<void>;
  private sandboxSwept = false;
  private dockerStarting = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<unknown[]>('chatroom.rooms.v1', []);
    this.rooms = (Array.isArray(saved) ? saved : []).filter((r: any) => r && typeof r.id === 'string' && Array.isArray(r.agents) && Array.isArray(r.messages)).slice(0, 20).map(r => this.restore(r));
    if (!this.rooms.length) this.rooms.push(this.createConfiguredRoom());
    this.models = context.workspaceState.get<LocalModels>('chatroom.localModels', { vision: '', embedding: '' });
    this.ollama = new OllamaClient(() => this.config('ollamaUrl', 'http://127.0.0.1:11434'), () => this.config('ollamaKeepAlive', '5m'),
      usage => { const room = this.engine.room; room.usage['local-tools'] = addUsage(room.usage['local-tools'] ?? emptyUsage(), usage); this.changed(); },
      () => { if (overLimit(this.engine.room)) throw new Error('This message reached its token limit before a local model request. Resume or change the limit in Usage.'); });
    this.knowledge = new KnowledgeStore(join((context.storageUri ?? context.globalStorageUri).fsPath, 'knowledge'));
    this.documents = new DocumentService(this.knowledge, this.ollama, this.models, (text, kind) => this.engine.log(text, kind ?? 'tool'), () => this.changed());
    this.tools = new ToolService(() => this.root(), this.documents, () => this.engine.room, text => this.engine.log(text, 'tool'));
    this.roomTools = new RoomToolHost((agentId, name, args, signal) => this.roomTool(agentId, name, args, signal));
    this.tracker = new EditorTracker(() => this.changed());
    this.worktrees = new RoomWorktrees({
      manager: () => this.worktreeManager,
      mode: room => room.worktrees ?? this.worktreeSetting(),
      native: agent => !!this.native(agent),
      copy: () => this.stringList('worktreeCopy'),
      links: () => this.stringList('worktreeLinks'),
      autoApply: () => this.config<boolean>('worktreeAutoApply', false) === true,
      log: (text, kind) => this.engine.log(text, kind ?? 'info'),
      toast: (type, text) => this.toast(type, text),
      release: roomId => this.release(roomId),
      changed: () => this.changed()
    });
    this.host = {
      version: String(context.extension?.packageJSON?.version ?? '0.4.0'),
      cwd: () => this.root(),
      cwdFor: (room, agent) => this.worktrees.cwdFor(room, agent) ?? this.root(),
      storageDir: () => context.globalStorageUri.fsPath,
      runtime: provider => providerRuntime(provider),
      settings: () => this.settings(),
      roomTools: this.roomTools,
      skillWiring: () => this.wiring,
      framing: (room, agent) => this.framingFor(agent, room, false),
      log: (text, kind) => this.engine.log(text, kind ?? 'info')
    };
    this.sandbox = new SandboxService({
      settings: () => this.sandboxSettings(),
      storageDir: () => context.globalStorageUri.fsPath,
      approve: (room, agentId, request, signal) => room === this.engine.room ? this.engine.requestApproval(agentId, request, signal)
        : Promise.resolve({ decision: 'deny', message: 'This room is not open.' }),
      changed: () => this.changed(),
      log: (text, kind) => this.engine.log(text, kind ?? 'tool')
    });
    this.drivers = createDrivers(this.host);
    this.legacy = createLegacyProviders(this.ollama, models => this.copilotModels(models));
    this.engine = this.makeEngine(this.rooms[0]!);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('chatroom')) return;
        if (event.affectsConfiguration('chatroom.allowFullAccess')) this.enforceFullAccess();
        if (event.affectsConfiguration('chatroom.sharedMcpServers')) this.caps.clear();
        if (event.affectsConfiguration('chatroom.worktrees')) this.worktreeNotice();
        if (event.affectsConfiguration('chatroom.sandbox')) void this.detectDocker();
        this.changed();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refreshSkills(); void this.detectWorktrees(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { this.changed(); void this.detectWorktrees(); void this.refreshCapabilities(undefined, true); }));
    void vscode.workspace.fs.createDirectory(context.globalStorageUri).then(() => this.refreshSkills(), () => this.refreshSkills());
    void this.refresh(false);
  }
  /** Saved rooms come back idle and migrated to the current schema; interrupted plans and document jobs are marked as such. */
  private restore(raw: unknown): Room {
    const room = migrateRoom(raw, { attachEditor: this.config('attachOpenFile', true), shareSkills: this.config('shareSkills', true), permission: this.defaultPermission() });
    room.status = 'idle'; room.currentAgent = undefined; room.activeAgents = []; room.queuedTurns = 0; room.agentStates = {};
    room.mode ??= 'sequential'; room.concurrency ??= 3; room.preset ??= 'planning'; room.flow = undefined; delete room.progress;
    room.documents = (room.documents ?? []).map(d => d.status === 'ready' || d.status === 'error' ? d : { ...d, status: 'error', detail: 'Interrupted · attach it again.' });
    if (!this.userConfig('allowFullAccess', false)) for (const agent of room.agents) this.limitAccess(agent);
    return room;
  }
  private config<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('chatroom').get<T>(key, fallback); }
  /** Settings that grant access or start programs come from user settings only, never from a workspace's .vscode/settings.json. */
  private userConfig<T>(key: string, fallback: T): T {
    const info = vscode.workspace.getConfiguration('chatroom').inspect<T>(key);
    return (info?.globalValue ?? info?.defaultValue ?? fallback) as T;
  }
  private defaultPermission(): PermissionLevel {
    const value = this.userConfig<string>('defaultPermission', 'ask') as PermissionLevel;
    return PERMISSIONS.includes(value) && (value !== 'full' || this.userConfig('allowFullAccess', false)) ? value : 'ask';
  }
  private settings(): DriverSettings {
    return { allowFullAccess: this.userConfig('allowFullAccess', false), idleSessionMs: boundedNumber(this.config('idleSessionMinutes', 20), 1, 240, 20) * 60000,
      copilotUseEnvToken: this.userConfig('copilotUseEnvToken', false), sharedMcpServers: this.sharedMcp() };
  }
  /** `chatroom.sharedMcpServers`, keeping only well-formed stdio and http entries. */
  private sharedMcp(): Record<string, SharedMcpServer> {
    const raw = this.userConfig<unknown>('sharedMcpServers', {}), result: Record<string, SharedMcpServer> = {};
    const strings = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    for (const [name, value] of Object.entries(raw as Record<string, any>)) {
      // "chatroom" is the room server; names that Claude normalizes onto its tool prefix (chatroom__x, chatroom.x) are reserved too.
      if (!/^[\w.-]{1,64}$/.test(name) || /^chatroom(?:$|[^A-Za-z0-9-])/i.test(name.replace(/[^A-Za-z0-9_-]/g, '_')) || !value || typeof value !== 'object') continue;
      if (typeof value.url === 'string' && /^https?:\/\//.test(value.url)) result[name] = { type: 'http', url: value.url, ...(strings(value.headers) ? { headers: strings(value.headers) } : {}) };
      else if (typeof value.command === 'string' && value.command.trim()) result[name] = { type: 'stdio', command: value.command, args: Array.isArray(value.args) ? value.args.filter((a: unknown) => typeof a === 'string') : [], ...(strings(value.env) ? { env: strings(value.env) } : {}) };
    }
    return result;
  }
  /** Full access needs `chatroom.allowFullAccess`; without it, agents fall back to asking first. */
  private limitAccess(agent: Agent): boolean {
    let changed = false;
    if (agent.options.permission === 'full') { agent.options.permission = 'ask'; changed = true; }
    if (agent.options.sandbox === 'danger-full-access') { delete agent.options.sandbox; changed = true; }
    return changed;
  }
  private enforceFullAccess(): void {
    if (this.userConfig('allowFullAccess', false)) return;
    let changed = false;
    for (const room of this.rooms) for (const agent of room.agents) changed = this.limitAccess(agent) || changed;
    if (changed) this.engine.log('Full access was turned off in Settings · those agents now ask before edits and commands');
  }
  /** Fills empty OCR/embedding selections from installed local models, unless the user chose them. */
  private pickLocalModels(): void {
    if (this.context.workspaceState.get('chatroom.localModelsChosen', false)) return;
    const installed = (this.connections.find(c => c.id === 'ollama')?.models ?? []).filter(m => !m.remote && !m.error);
    const vision = installed.filter(m => m.capabilities?.includes('vision')), embedding = installed.filter(m => m.capabilities?.includes('embedding'));
    let picked = false;
    if (!this.models.vision && vision.length) { this.models.vision = (vision.find(m => /ocr/i.test(m.id)) ?? vision[0]!).id; picked = true; }
    if (!this.models.embedding && embedding.length) { this.models.embedding = (embedding.find(m => /embed/i.test(m.id)) ?? embedding[0]!).id; picked = true; }
    if (picked) void this.context.workspaceState.update('chatroom.localModels', this.models);
  }
  private defaults(): ModelDefaults {
    const saved = this.config<ModelDefaults>('modelDefaults', { planning: {}, drafting: {}, review: {} });
    const result: ModelDefaults = { planning: {}, drafting: {}, review: {} };
    for (const preset of PRESETS) for (const provider of PROVIDERS) {
      const models = (this.connections.find(c => c.id === provider)?.models ?? []).filter(m => !m.error && (provider !== 'ollama' || (!m.remote && m.capabilities?.includes('completion'))));
      const suggested = provider === 'claude' ? ({ planning: 'opus', drafting: 'haiku', review: 'sonnet' })[preset]
        : (preset === 'drafting' ? models.find(m => /(?:luna|mini|haiku)/i.test(m.id))?.id : undefined) ?? models.find(m => m.isDefault)?.id ?? models[0]?.id ?? '';
      result[preset][provider] = saved?.[preset]?.[provider] || suggested;
    }
    return result;
  }
  private createConfiguredRoom(): Room {
    const room = createRoom(this.defaults(), this.config<TaskPreset>('defaultPreset', 'planning'), this.defaultPermission());
    const mode = this.config<RoomMode>('executionMode', 'orchestrated');
    room.mode = MODES.includes(mode) ? mode : 'orchestrated'; room.concurrency = boundedNumber(this.config('maxParallelAgents', 3), 1, 4, 3);
    // A new room in Custom team mode starts with the first saved team (or template).
    if (room.mode === 'pipeline') { const team = normalizeTeam(this.teams()[0]); if (team) room.team = team; else room.mode = 'orchestrated'; }
    room.attachEditor = this.config('attachOpenFile', true); room.shareSkills = this.config('shareSkills', true);
    return room;
  }
  private modelInfo(agent: Agent, model = agent.model): ModelInfo | undefined {
    return this.caps.get(agent.id)?.models.find(m => m.id === model) ?? this.connections.find(c => c.id === agent.provider)?.models.find(m => m.id === model);
  }
  private knownModels(agent: Agent): string[] {
    return [...new Set([...(this.caps.get(agent.id)?.models ?? []), ...(this.connections.find(c => c.id === agent.provider)?.models ?? [])].filter(m => !m.error).map(m => m.id))];
  }
  private efforts(agent: Agent): string[] { return [...new Set([...(this.caps.get(agent.id)?.efforts ?? []), ...(this.modelInfo(agent)?.reasoning ?? [])])]; }
  /** Sets the model; an effort the new model does not support falls back to the CLI default. */
  private selectModel(agent: Agent, model: string): void {
    agent.model = model;
    const reasoning = this.modelInfo(agent)?.reasoning;
    if (agent.options.effort && reasoning?.length && !reasoning.includes(agent.options.effort)) agent.options.effort = '';
  }
  private root(): string { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) throw new Error('Open a local workspace folder to use Chatroom.'); return root; }
  private native(agent: Agent) { return nativeDriverFor(agent, this.drivers, this.connections); }
  private capsFor(agent: Agent): AgentCapabilities | undefined {
    return this.native(agent) ? this.caps.get(agent.id) : legacyCapabilities(agent, this.connections.find(c => c.id === agent.provider));
  }
  private capsRecord(room: Room): Record<string, AgentCapabilities> {
    const result: Record<string, AgentCapabilities> = {};
    for (const agent of room.agents) { const caps = this.capsFor(agent); if (caps) result[agent.id] = caps; }
    return result;
  }
  private framingFor(agent: Agent, room: Room, legacy: boolean): string {
    return roomFraming(agent, room, { connections: this.connections, caps: this.capsRecord(room), skillsIndex: this.wiring?.indexPath, legacy, unavailable: a => this.availabilityOf(a) });
  }
  /** Live reasons an agent can't run, from connections and capabilities (not stored on the agent). */
  private liveAvailability(agent: Agent): Unavailable | undefined {
    const connection = this.connections.find(c => c.id === agent.provider), now = Date.now();
    const mark = (reason: Unavailable['reason'], detail = ''): Unavailable => ({ reason, detail: detail.slice(0, 300), at: now });
    if (agent.provider === 'ollama') return connection && connection.status !== 'ready' && connection.status !== 'unchecked' ? mark('offline', connection.detail) : undefined;
    if (this.native(agent)) {
      const caps = this.caps.get(agent.id);
      if (caps?.status === 'missing' || caps?.status === 'signed-out') return mark(caps.status, caps.detail);
      if ((agent.provider === 'claude' || agent.provider === 'codex') && connection?.status === 'missing') return mark('missing', connection.detail);
      return undefined;
    }
    // Copilot through VS Code chat models: no models means not signed in.
    return agent.provider === 'copilot' && connection?.status === 'missing' ? mark('signed-out', connection.detail) : undefined;
  }
  /** The agent's own mark while it lasts, else live status. */
  private availabilityOf(agent: Agent): Unavailable | undefined {
    const mark = agent.unavailable;
    return mark && (mark.until === undefined || mark.until > Date.now()) ? mark : this.liveAvailability(agent);
  }
  /** Saved teams (chatroom.teams), then the templates whose names are not taken. */
  private teams(): TeamConfig[] {
    const saved: TeamConfig[] = [], list = this.config<unknown>('teams', []);
    for (const raw of Array.isArray(list) ? list : []) {
      const team = normalizeTeam(raw);
      if (team && !saved.some(t => t.name.toLowerCase() === team.name.toLowerCase())) saved.push(team);
    }
    return [...saved, ...BUILTIN_TEAMS.filter(t => !saved.some(s => s.name.toLowerCase() === t.name.toLowerCase()))];
  }
  /** Replaces (by name, any case) or adds a team in the user's chatroom.teams. */
  private async writeTeams(update: (teams: unknown[]) => unknown[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('chatroom'), current = config.inspect<unknown[]>('teams')?.globalValue;
    await config.update('teams', update(Array.isArray(current) ? current : []), vscode.ConfigurationTarget.Global);
  }
  private sameName(raw: unknown, name: string): boolean {
    return !!raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' && (raw as { name: string }).name.trim().toLowerCase() === name.trim().toLowerCase();
  }
  private async saveTeam(team: TeamConfig): Promise<void> {
    await this.writeTeams(teams => {
      const index = teams.findIndex(t => this.sameName(t, team.name));
      return index >= 0 ? teams.map((t, i) => i === index ? team : t) : [...teams, team];
    });
  }
  private async deleteTeam(name: string): Promise<boolean> {
    const current = vscode.workspace.getConfiguration('chatroom').inspect<unknown[]>('teams')?.globalValue;
    if (!name.trim() || !Array.isArray(current) || !current.some(t => this.sameName(t, name))) return false;
    await this.writeTeams(teams => teams.filter(t => !this.sameName(t, name)));
    return true;
  }
  /** Uses a team in the room (mode 'pipeline'). */
  private applyTeam(room: Room, raw: unknown, inline = false): void {
    if (this.engine.busy) throw new Error('Pause or stop the run before changing the team.');
    const team = normalizeTeam(raw);
    if (!team) throw new Error(BAD_TEAM);
    room.team = team; room.mode = 'pipeline';
    this.notice(`Team set: ${team.name} — ${teamPlan(team, room)}.${inline ? ' Keep it with /team save <name>.' : ''}`);
  }
  private makeEngine(room: Room): RoomEngine {
    return new RoomEngine(room, {
      providers: this.legacy,
      native: agent => this.native(agent),
      tools: (call, agent, signal) => this.tools.execute(call, agent, signal),
      briefing: (target, query, signal) => this.documents.briefing(target, query, signal),
      framing: (agent, target, legacy) => this.framingFor(agent, target, legacy),
      capabilities: (agent, caps) => { this.caps.set(agent.id, caps); this.changed(); },
      contextTokens: () => boundedNumber(this.config('contextTokens', 12000), 2000, 64000, 12000),
      timeoutMs: () => boundedNumber(this.config('turnTimeoutSeconds', 300), 15, 3600, 300) * 1000,
      approvalTimeoutMs: () => boundedNumber(this.config('approvalTimeoutSeconds', 300), 30, 3600, 300) * 1000,
      maxHandoffs: () => boundedNumber(this.config('maxHandoffs', 6), 0, 20, 6),
      changed: () => this.changed(),
      availability: agent => this.liveAvailability(agent),
      presetModel: (agent, preset) => this.defaults()[preset][agent.provider] ?? '',
      isolation: this.worktrees
    });
  }
  private worktreeSetting(): WorktreeMode {
    const value = this.config<string>('worktrees', 'off') as WorktreeMode;
    return WORKTREE_MODES.includes(value) ? value : 'off';
  }
  private stringList(key: string): string[] {
    const value = this.config<unknown>(key, []);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 50) : [];
  }
  /** Worktrees are available when the workspace is a git repository; checked at startup, on refresh and when folders or trust change. The first detection sweeps orphans. */
  private async detectWorktrees(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repo = folder && vscode.workspace.isTrusted ? await WorktreeManager.detect(folder) : undefined;
    if (!repo || !folder) this.worktreeManager = undefined;
    else if (this.worktreeManager?.repo !== repo) this.worktreeManager = new WorktreeManager({ repo, root: worktreeRoot(this.host.storageDir(), repo), owner: folder });
    this.worktreesAvailable = !!this.worktreeManager;
    this.worktreeNotice(); this.changed();
    const manager = this.worktreeManager;
    if (!manager || this.worktreesSwept) return;
    this.worktreesSwept = true;
    // Chatroom never made a worktree for this repository: nothing to sweep, and git is not run.
    if (!existsSync(manager.root)) return;
    // Orphans of rooms that no longer exist, in the background; nothing is removed on deactivate.
    void manager.sweep(new Set(this.rooms.map(r => r.id))).then(async result => {
      await cleanCodexTrust(manager.root).catch(() => false);
      if (result.removed.length) this.engine.log(`Removed ${result.removed.length} old worktree${result.removed.length === 1 ? '' : 's'}${result.keptBranches.length ? ` · kept branches with work: ${result.keptBranches.join(', ')}` : ''}`);
    }, error => this.engine.log(`Worktree cleanup skipped · ${errorText(error)}`, 'error'));
  }
  /** Logs once when a room or setting asks for worktrees but the workspace is not a git repository. */
  private worktreeNotice(): void {
    if (this.worktreesAvailable || this.worktreeNoticed || !vscode.workspace.workspaceFolders?.length) return;
    if (this.worktreeSetting() === 'off' && !this.rooms.some(r => (r.worktrees ?? 'off') !== 'off' || r.agents.some(a => a.isolate))) return;
    this.worktreeNoticed = true;
    this.engine.log(NO_REPO);
  }
  private copilotModels(models: vscode.LanguageModelChat[]): void {
    const previous = this.connections.find(c => c.id === 'copilot');
    if (!models.length || previous?.runtime === 'cli') return;
    const merged = new Map((previous?.models ?? []).map(m => [m.id, m]));
    for (const model of models) merged.set(model.id, { id: model.id, name: model.name });
    const connection: Connection = { ...previous, id: 'copilot', status: 'ready', runtime: 'vscode-lm', detail: `${merged.size} models available through VS Code`, models: [...merged.values()], modelSource: 'VS Code Copilot catalog' };
    this.connections = [...this.connections.filter(c => c.id !== 'copilot'), connection]; this.changed();
  }
  private async roomTool(agentId: string, name: RoomToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (!vscode.workspace.isTrusted) throw new Error('Room tools require a trusted workspace.');
    const agent = this.rooms.flatMap(r => r.agents).find(a => a.id === agentId);
    this.engine.log(`${agent?.name ?? 'An agent'} → chatroom.${name}`, 'tool');
    if (name === 'isolate_workspace') return this.isolateTool(agentId);
    if (name === 'sandbox_run') return this.sandboxTool(agentId, args, signal);
    return this.tools.executeRoomTool(name, args, signal);
  }
  /** isolate_workspace: an agent in Full access asks for its own worktree from its next turn. */
  private isolateTool(agentId: string): string {
    const room = this.rooms.find(r => r.agents.some(a => a.id === agentId)), agent = room?.agents.find(a => a.id === agentId);
    if (!room || !agent) throw new Error('This agent is not in a Chatroom room.');
    if (agent.options.permission !== 'full' || !this.userConfig('allowFullAccess', false)) throw new Error('isolate_workspace is available in Full access; ask the user to isolate you in your settings.');
    if (!this.worktreeManager) throw new Error('Worktrees need a git repository, and this workspace is not one.');
    agent.isolate = true; this.changed();
    return `From your next turn you work in your own worktree (branch ${this.worktrees.branchFor(room, agent)}); the room combines and reviews the changes.`;
  }
  /** The changes card's buttons and /worktrees: review opens the diff; the others need the room to be idle. */
  private async worktreeAction(room: Room, action: unknown, name?: string): Promise<void> {
    if (typeof action !== 'string' || !WORKTREE_ACTIONS.includes(action)) return;
    this.requireTrust();
    if (!this.worktreeManager) throw new Error(NO_REPO);
    if (action === 'review') {
      const text = await this.worktrees.review(room, !this.engine.busy);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: text, language: 'diff' }), { preview: true });
      return;
    }
    if (this.engine.busy) throw new Error(BUSY);
    if (action === 'apply') await this.worktrees.apply(room);
    else if (action === 'keep') await this.worktrees.keep(room, name?.trim().slice(0, 80) || undefined);
    else if (action === 'discard') { await this.worktrees.discard(room); this.toast('notice', 'Discarded the agents\' changes and removed their worktrees.'); }
    else {
      const result = await this.worktrees.cleanup(this.rooms);
      this.notice(`${result.removed ? `Removed ${result.removed} old worktree${result.removed === 1 ? '' : 's'}.` : 'No old worktrees to clean up.'}${result.kept.length ? ` Kept branches with work: ${result.kept.join(', ')}.` : ''}`);
    }
    this.changed();
  }
  // ── Sandbox (optional) ────────────────────────────────────────────────────
  private sandboxSettings(): SandboxSettings {
    return sandboxSettings({ enabled: this.config('sandbox.enabled', true), images: this.config<unknown>('sandbox.images', undefined), cpus: this.config<unknown>('sandbox.cpus', undefined),
      memoryMb: this.config<unknown>('sandbox.memoryMb', undefined), timeoutSeconds: this.config<unknown>('sandbox.timeoutSeconds', undefined), maxCopyMb: this.config<unknown>('sandbox.maxCopyMb', undefined) });
  }
  /** Docker's last known status (only checked while chatroom.sandbox.enabled is on). */
  private dockerState(): DockerStatus {
    if (this.dockerStarting) return { available: false, detail: 'Starting Docker Desktop…', action: 'startDocker' };
    return this.sandbox.lastStatus ?? { available: false, detail: 'Checking Docker…' };
  }
  private sandboxState(room: Room): StatePayload['settings']['sandbox'] {
    const settings = this.sandboxSettings();
    if (!settings.enabled) return { enabled: false, available: false, detail: SANDBOX_SETTING_OFF };
    const docker = this.dockerState();
    return { enabled: sandboxOn(settings, room), available: docker.available, detail: docker.detail, ...(!docker.available && docker.action ? { action: docker.action } : {}) };
  }
  /** Checks Docker while the sandbox setting is on (nothing runs while it is off); the first time Docker answers, leftover containers are removed. */
  private detectDocker(): Promise<void> {
    if (!this.sandboxSettings().enabled || this.disposed) { this.changed(); return Promise.resolve(); }
    return this.dockerChecking ??= (async () => {
      try {
        const status = await this.sandbox.status(0);
        if (status.available && !this.sandboxSwept) {
          this.sandboxSwept = true;
          void this.sandbox.sweep().then(swept => {
            if (swept.containers.length) this.engine.log(`Removed ${swept.containers.length} leftover sandbox container${swept.containers.length === 1 ? '' : 's'}`);
          }, error => this.engine.log(`Sandbox cleanup skipped · ${errorText(error)}`, 'error'));
        }
      } catch (error) { this.engine.log(`Docker check failed · ${errorText(error)}`, 'error'); }
      finally { this.dockerChecking = undefined; this.changed(); }
    })();
  }
  /** The folder a run copies for an agent: its worktree while isolated, else the workspace. */
  private agentFolder(room: Room, agent: Agent): string { return this.worktrees.cwdFor(room, agent) ?? this.root(); }
  /** sandbox_run: the approval card, then the run; the agent's turn waits without timing out. */
  private async sandboxTool(agentId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const room = this.rooms.find(r => r.agents.some(a => a.id === agentId)), agent = room?.agents.find(a => a.id === agentId);
    if (!room || !agent) throw new Error('This agent is not in a Chatroom room.');
    const settings = this.sandboxSettings();
    if (!sandboxOn(settings, room)) throw new Error(SANDBOX_OFF);
    if (room !== this.engine.room) throw new Error('This room is not open in Chatroom right now.');
    const request = sandboxRequest(args, { timeoutSeconds: settings.timeoutSeconds, workdirFrom: 'agent' });
    const hold = this.engine.holdTurn(agentId);
    try {
      const result = await this.sandbox.run({ room, request, requestedBy: agent.name, agentId, folder: request.workdirFrom === 'none' ? undefined : this.agentFolder(room, agent),
        signal: hold.signal ? AbortSignal.any([signal, hold.signal]) : signal,
        onStatus: r => { if (r.status === 'pulling' || r.status === 'running') hold.detail(r.status === 'pulling' ? `Sandbox: downloading ${r.image}` : 'Sandbox: running'); } });
      if (result.status === 'denied') return `${SANDBOX_DECLINED}${result.error ? ` ${result.error}` : ''}`;
      if (result.status === 'cancelled' && !room.messages.some(m => m.sandbox === result)) return 'The sandbox run was cancelled before it started.';
      return sandboxReport(result, { tail: 8000, texts: true, max: 23_000 });
    } finally { hold.release(); }
  }
  /** The user's own run (/sandbox, a code block's Run button, Run again): checked now, then the approval card from You. */
  private async userSandbox(room: Room, request: SandboxRequest, folderAgentId?: string): Promise<void> {
    this.requireTrust();
    const settings = this.sandboxSettings();
    if (!settings.enabled) throw new Error(SANDBOX_SETTING_OFF);
    if (!sandboxOn(settings, room)) throw new Error(SANDBOX_ROOM_OFF);
    const status = await this.sandbox.status(0);
    this.changed();
    if (!status.available) throw new Error(status.detail);
    const agent = folderAgentId ? room.agents.find(a => a.id === folderAgentId) : undefined;
    const folder = request.workdirFrom === 'none' ? undefined : agent ? this.agentFolder(room, agent) : this.root();
    void this.sandbox.run({ room, request, requestedBy: 'You', folder }).catch(error => this.toast('error', errorText(error)));
  }
  /** The webview's sandbox actions: run, rerun and cancel (by the run's id or its card's message id), and start Docker Desktop. */
  private async sandboxAction(room: Room, data: any): Promise<void> {
    const card = typeof data.id === 'string' ? room.messages.find(m => m.sandbox && (m.sandbox.id === data.id || m.id === data.id))?.sandbox : undefined;
    const settings = this.sandboxSettings();
    switch (data.action) {
      case 'run':
        await this.userSandbox(room, sandboxRequest({ command: data.command, code: data.code, language: data.language, profile: data.profile, network: data.network === true },
          { timeoutSeconds: settings.timeoutSeconds, workdirFrom: 'workspace' }));
        return;
      case 'rerun': {
        if (!card) throw new Error('That sandbox run is not in this room.');
        const request = this.sandbox.original(card.id)?.request ?? requestFromResult(card, settings.images, card.agentId ? 'agent' : 'workspace');
        await this.userSandbox(room, request, card.agentId);
        return;
      }
      case 'cancel':
        if (!card || !this.sandbox.cancel(card.id)) throw new Error('This sandbox run is not running.');
        return;
      case 'startDocker': await this.startDocker(); return;
    }
  }
  /** Starts Docker Desktop and waits for it (up to 3 minutes); without Docker it opens the download page. */
  private async startDocker(): Promise<void> {
    if (this.dockerStarting) return;
    const status = await this.sandbox.status(0);
    if (status.available) { this.changed(); void this.detectDocker(); return; }
    if (status.action === 'installDocker') { await vscode.env.openExternal(vscode.Uri.parse('https://www.docker.com/products/docker-desktop/')); return; }
    const error = startDockerDesktop();
    if (error) throw new Error(error);
    this.dockerStarting = true; this.changed();
    try {
      for (let i = 0; i < 60 && !this.disposed; i++) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const next = await this.sandbox.status(0);
        if (next.available) { this.toast('notice', `Docker is running · ${next.detail}.`); return; }
      }
      this.toast('error', 'Docker Desktop did not start within 3 minutes.');
    } finally { this.dockerStarting = false; this.changed(); void this.detectDocker(); }
  }
  /** /sandbox status. */
  private describeSandbox(room: Room): string {
    const settings = this.sandboxSettings(), docker = this.dockerState(), running = this.sandbox.running.length;
    if (!settings.enabled) return SANDBOX_SETTING_OFF;
    return [`Sandbox: ${sandboxOn(settings, room) ? 'on' : 'off'} in this room${room.sandbox === undefined ? ' (setting)' : ''} · ${docker.detail}`,
      `Images: bash ${settings.images.bash}, python ${settings.images.python}, node ${settings.images.node} · limits ${settings.cpus} CPUs, ${settings.memoryMb} MB, ${settings.timeoutSeconds} s by default · copies up to ${settings.maxCopyMb} MB.`,
      running ? `${running} run${running === 1 ? '' : 's'} going.` : '',
      SANDBOX_USAGE].filter(Boolean).join('\n');
  }
  private release(roomId: string, agentId?: string): Promise<void> {
    return Promise.allSettled(Object.values(this.drivers).map(driver => driver.release(roomId, agentId))).then(() => {});
  }
  /** Shows another room: the previous room's CLI processes are released, their sessions resume later. */
  private showRoom(room: Room): void {
    const previous = this.engine;
    previous.dispose(); void this.release(previous.room.id);
    this.engine = this.makeEngine(room); this.changed();
    void this.refreshCapabilities(undefined, true);
  }

  // ── Webview ───────────────────────────────────────────────────────────────
  resolveWebviewView(view: vscode.WebviewView): void { this.setup(view.webview); view.onDidDispose(() => this.views.delete(view.webview)); }
  openPanel(): void {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel('chatroom.room', 'Chatroom', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media/chatroom.svg');
    const webview = this.panel.webview; this.setup(webview);
    this.panel.onDidDispose(() => { this.views.delete(webview); this.panel = undefined; });
  }
  private setup(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file)).toString();
    const nonce = randomBytes(18).toString('base64');
    this.views.add(webview);
    this.context.subscriptions.push(webview.onDidReceiveMessage(data => { void this.handle(data).catch(error => void webview.postMessage({ type: 'error', text: errorText(error) })); }));
    // Install the bridge before navigating the webview so the first ready
    // message cannot race registration on a warm webview cache.
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('app.css')}"><title>Chatroom</title></head><body><div id="app"><p>Opening Chatroom…</p></div><script nonce="${nonce}" src="${uri('app.js')}"></script></body></html>`;
  }
  private toast(type: 'error' | 'notice', text: string): void { for (const view of this.views) void view.postMessage({ type, text }); }
  private changed(): void {
    if (this.disposed) return;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.broadcast(); }, this.broadcastDelay);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const now = Date.now();
    this.unsavedSince ??= now;
    if (now - this.unsavedSince >= 5000) this.persist();
    else this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.persist(); }, 700);
  }
  private persist(): void {
    this.unsavedSince = undefined;
    // Serialize snapshots to avoid a slower old save overwriting newer room state.
    const snapshot = JSON.parse(JSON.stringify(this.rooms)) as Room[];
    this.persistence = this.persistence.then(() => this.context.workspaceState.update('chatroom.rooms.v1', snapshot)).catch(() => {});
  }
  private broadcast(): void {
    const room = this.engine.room, attachOpenFile = this.config('attachOpenFile', true);
    const state: StatePayload = { type: 'state', room, rooms: this.rooms.map(r => ({ id: r.id, title: r.title })), connections: this.connections,
      capabilities: this.capsRecord(room), editor: attachOpenFile ? this.tracker.snapshot() ?? null : null, sharedSkills: this.sharedSkills, roomCommands: ROOM_COMMANDS, teams: this.teams(),
      localModels: this.models, discovering: this.discovering, modelDefaults: this.defaults(),
      defaultPreset: this.config<TaskPreset>('defaultPreset', 'planning'), executionMode: this.config<RoomMode>('executionMode', 'orchestrated'), maxParallelAgents: this.config('maxParallelAgents', 3),
      settings: { allowFullAccess: this.userConfig('allowFullAccess', false), attachOpenFile, approvalTimeoutSeconds: boundedNumber(this.config('approvalTimeoutSeconds', 300), 30, 3600, 300),
        worktrees: this.worktreeSetting(), worktreesAvailable: this.worktreesAvailable, sandbox: this.sandboxState(room) },
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? 'No folder open', trusted: vscode.workspace.isTrusted };
    const started = Date.now();
    for (const view of this.views) void view.postMessage(state);
    // postMessage serializes the whole room; a large room broadcasts less often while it streams.
    this.broadcastDelay = Math.min(1000, Math.max(55, (Date.now() - started) * 8));
  }

  // ── Discovery ─────────────────────────────────────────────────────────────
  async refresh(copilot: boolean): Promise<void> {
    if (this.discovering) { this.pendingCopilot ||= copilot; return; }
    this.discovering = true; this.changed();
    try {
      const worktrees = this.detectWorktrees().catch(error => this.engine.log(`Worktrees: ${errorText(error)}`, 'error'));
      void this.detectDocker();
      this.connections = await detectConnections(this.ollama, copilot, this.connections);
      await worktrees;
      this.pickLocalModels();
      for (const room of this.rooms) for (const agent of room.agents) if (!agent.model && room.status !== 'running') this.selectModel(agent, this.defaults()[room.preset ?? 'planning'][agent.provider] ?? '');
      for (const room of this.rooms) if (room.status !== 'running') this.availableLead(room);
      this.clearMarks();
      this.ollamaNotice();
    } finally { this.discovering = false; this.changed(); if (this.pendingCopilot) { this.pendingCopilot = false; void this.refresh(true); } }
  }
  /** Drops marks that no longer apply: a CLI that is installed again, Ollama running again, a sign-in that works. */
  private clearMarks(): void {
    for (const room of this.rooms) for (const agent of room.agents) {
      const reason = agent.unavailable?.reason, ready = this.connections.find(c => c.id === agent.provider)?.status === 'ready';
      if (((reason === 'missing' || reason === 'offline') && ready) || (reason === 'signed-out' && (ready || this.caps.get(agent.id)?.status === 'ready'))) delete agent.unavailable;
    }
  }
  /** Ollama that wasn't running is checked again before a message (at most every 30 s), so starting it needs no manual refresh. */
  private async recheckOllama(): Promise<void> {
    const room = this.engine.room, ollama = this.connections.find(c => c.id === 'ollama');
    if (!ollama || ollama.status === 'ready' || ollama.status === 'unchecked' || Date.now() - this.ollamaChecked < 30_000) return;
    if (!room.documents?.length && !room.agents.some(a => a.enabled && a.provider === 'ollama')) return;
    this.ollamaChecked = Date.now();
    try {
      const models = await this.ollama.models();
      this.connections = this.connections.map(c => c.id === 'ollama' ? { ...c, status: 'ready', runtime: 'http', detail: `${models.length} installed models · loopback endpoint`, models, modelSource: 'Ollama installed models' } : c);
      for (const agent of room.agents) if (agent.provider === 'ollama' && agent.unavailable?.reason === 'offline') delete agent.unavailable;
      this.pickLocalModels(); this.engine.log('Ollama is running again'); this.changed();
    } catch { /* Still not running: its agents stay skipped. */ }
  }
  private ollamaNotice(): void {
    const room = this.engine.room, ollama = this.connections.find(c => c.id === 'ollama');
    if (this.ollamaNoticed || !ollama || ollama.status === 'ready' || ollama.status === 'unchecked') return;
    if (!room.documents?.length && !room.agents.some(a => a.enabled && a.provider === 'ollama')) return;
    this.ollamaNoticed = true;
    this.notice('Ollama isn\'t running: Ollama agents are skipped, documents use keyword search, and scanned pages can\'t be read until it starts.');
  }
  /** A lead whose CLI is missing or failing hands the lead to the first enabled agent whose connection is ready. */
  private availableLead(room: Room): void {
    const status = (agent: Agent) => this.connections.find(c => c.id === agent.provider)?.status;
    const lead = leadAgent(room), state = lead && status(lead);
    if (!lead || (state !== 'missing' && state !== 'error')) return;
    const next = room.agents.find(a => a.enabled && a.id !== lead.id && status(a) === 'ready');
    if (!next) return;
    room.leadId = next.id;
    if (room === this.engine.room) this.engine.log(`${lead.name} is not available (${state === 'missing' ? 'not installed' : 'connection error'}) · ${next.name} leads this room now`);
  }
  /** Connections, shared skills and agent capabilities, all rediscovered. */
  async refreshAll(): Promise<void> {
    this.caps.clear();
    await Promise.all([this.refresh(true), this.refreshSkills()]);
    await this.refreshCapabilities();
  }
  private refreshSkills(): Promise<void> {
    this.skillsJob = this.skillsJob.then(async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      try {
        const skills = await discoverSkills(workspace);
        this.wiring = await prepareSkillWiring(skills, this.host.storageDir(), workspace);
        this.sharedSkills = skills;
      } catch (error) { this.engine.log(`Skill sharing skipped · ${errorText(error)}`, 'error'); }
      this.changed();
    });
    return this.skillsJob;
  }
  /** Asks native drivers for their capabilities (they may start the CLI, never inference). */
  private async refreshCapabilities(id?: string, missingOnly = false): Promise<void> {
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length || this.disposed) return;
    const room = this.engine.room;
    await Promise.all(room.agents.filter(a => id ? a.id === id : a.enabled).map(async agent => {
      const driver = this.native(agent);
      if (!driver || this.capsLoading.has(agent.id) || (missingOnly && this.caps.has(agent.id))) return;
      this.capsLoading.add(agent.id);
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${PROVIDER_LABELS[agent.provider]} did not report its capabilities in time.`)), 90000); });
        const caps = await Promise.race([driver.capabilities(room, agent), timeout]);
        this.caps.set(agent.id, caps);
        if (caps.status === 'ready' && (agent.unavailable?.reason === 'missing' || agent.unavailable?.reason === 'signed-out')) delete agent.unavailable;
      } catch (error) { this.caps.set(agent.id, this.errorCaps(agent, error)); }
      finally { clearTimeout(timer); this.capsLoading.delete(agent.id); this.changed(); }
    }));
  }
  private errorCaps(agent: Agent, error: unknown): AgentCapabilities {
    const code = error instanceof ProviderError ? error.code : undefined;
    return { provider: agent.provider, runtime: 'cli', status: code === 'missing' ? 'missing' : code === 'signed-out' ? 'signed-out' : 'error', detail: errorText(error),
      models: [], efforts: [], tools: [], skills: [], commands: [], mcpServers: [], updatedAt: Date.now(),
      ...(error instanceof ProviderError && error.extra.action ? { action: error.extra.action } : {}),
      supports: { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: false, useSkills: false, useProjectSettings: false, extraDirs: false, ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: false, customAgent: false } };
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  newRoom(): void {
    if (this.engine.busy) { void vscode.window.showInformationMessage('Stop the current run before opening another room.'); return; }
    const room = this.createConfiguredRoom(); this.rooms.unshift(room); this.rooms = this.rooms.slice(0, 20); this.showRoom(room);
  }
  async exportRoom(): Promise<void> {
    const room = this.engine.room;
    const name = (id: string) => room.agents.find(a => a.id === id)?.name ?? 'Removed agent';
    const text = `# ${room.title}\n\n` + room.messages.map(m => m.kind === 'approval' && m.approval ? `> ${m.author} asked to ${m.approval.tool}: ${m.approval.title} — ${m.approval.status}\n`
      : m.sandbox ? `## Sandbox\n\n~~~text\n${sandboxReport(m.sandbox, { tail: 4000, echo: true, texts: true, max: 40_000 })}\n~~~\n`
      : `## ${m.author}${m.step ? ` · step ${m.step.id}` : m.turn === 'synthesis' ? ' · final answer' : ''}${m.status !== 'complete' ? ` (${m.status})` : ''}\n\n${m.step ? `> ${m.step.task}\n\n` : ''}${m.text}\n${m.plan?.length ? '\n' + m.plan.map(s => `- **${s.id}** ${name(s.agentId)}: ${s.task}${s.after.length ? ` _(after ${s.after.join(', ')})_` : ''} — ${s.status}`).join('\n') + '\n' : ''}`).join('\n');
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${this.root()}/chatroom-${room.id.slice(0, 8)}.md`), filters: { Markdown: ['md'] } });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  }
  async copilotTerminal(action: 'install' | 'login'): Promise<void> {
    const terminal = vscode.window.terminals.find(t => t.name === 'Copilot CLI') ?? vscode.window.createTerminal({ name: 'Copilot CLI' });
    terminal.show();
    if (action === 'install') { terminal.sendText('npm i -g @github/copilot'); return; }
    const exe = (await providerRuntime('copilot').catch(() => undefined))?.executable;
    if (!exe || exe.prefix.length) { terminal.sendText('copilot login'); return; }
    terminal.sendText(`${/pwsh|powershell/i.test(vscode.env.shell) ? '& ' : ''}"${exe.command}" login`);
  }
  private notice(text: string): void { this.engine.room.messages.push(message('notice', text, 'Chatroom')); this.changed(); }
  private requireTrust(): void { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting agents.'); this.root(); }
  private async handle(data: any): Promise<void> {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    const room = this.engine.room;
    const agentOf = (id: unknown) => typeof id === 'string' ? room.agents.find(a => a.id === id) : undefined;
    switch (data.type) {
      case 'ready':
        this.broadcast();
        if (!this.connections.find(c => c.id === 'copilot' && c.status !== 'unchecked')) void this.refresh(true).then(() => this.refreshCapabilities(undefined, true));
        else void this.refreshCapabilities(undefined, true);
        break;
      case 'open': this.openPanel(); break;
      case 'refresh': await this.refreshAll(); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:chatroom-local.chatroom'); break;
      case 'new': this.newRoom(); break;
      case 'export': await this.exportRoom(); break;
      case 'switch': {
        if (this.engine.busy) throw new Error('Stop the current run before switching rooms.');
        const next = this.rooms.find(r => r.id === data.id);
        if (next && next !== room) this.showRoom(next);
        break;
      }
      case 'send': {
        const text = typeof data.text === 'string' ? data.text.trim().slice(0, 24000) : '';
        if (!text) throw new Error('Write a message first.');
        const parsed = parseComposer(text, room.agents, this.capsRecord(room), this.engine.lead()?.id);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.command?.scope === 'room') { await this.runRoomCommand(parsed.command.name, parsed.command.args, parsed.command.agentIds, parsed.text); break; }
        this.requireTrust();
        if (parsed.command) { await this.engine.runAgentCommand(parsed.command.agentIds, parsed.command.name, parsed.command.args, parsed.text); break; }
        if (this.engine.busy) throw new Error('Agents are working. Wait or press Stop.');
        await this.recheckOllama();
        const editor = data.editor === true && room.attachEditor && this.config('attachOpenFile', true) ? this.tracker.snapshot() : undefined;
        await this.engine.start({ text: parsed.text, targets: parsed.targets, all: parsed.all, editor, flags: { think: data.think === true, ultra: data.ultra === true } });
        break;
      }
      case 'start': this.requireTrust(); await this.recheckOllama(); await this.engine.start(); break;
      case 'pause': this.engine.pause(); break;
      case 'stop': this.sandbox.cancelRoom(room.id); this.engine.stop(); break;
      case 'stopAgent': if (typeof data.id === 'string') this.engine.stopAgent(data.id); break;
      case 'options': this.updateRoom(room, data); break;
      case 'saveDefaults': {
        const defaults: ModelDefaults = { planning: {}, drafting: {}, review: {} };
        for (const preset of PRESETS) for (const provider of PROVIDERS) {
          const value = data.modelDefaults?.[preset]?.[provider];
          if (typeof value === 'string') defaults[preset][provider] = value.trim().slice(0, 160);
        }
        const config = vscode.workspace.getConfiguration('chatroom');
        await config.update('modelDefaults', defaults, vscode.ConfigurationTarget.Global);
        if (PRESETS.includes(data.defaultPreset)) await config.update('defaultPreset', data.defaultPreset, vscode.ConfigurationTarget.Global);
        if (MODES.includes(data.executionMode)) await config.update('executionMode', data.executionMode, vscode.ConfigurationTarget.Global);
        await config.update('maxParallelAgents', boundedNumber(data.maxParallelAgents, 1, 4, 3), vscode.ConfigurationTarget.Global);
        this.changed(); break;
      }
      case 'agent': {
        const agent = agentOf(data.id);
        if (!agent) return;
        this.updateAgent(room, agent, data);
        this.changed(); break;
      }
      case 'addAgent': {
        if (this.engine.busy) throw new Error('Pause or stop the run before adding agents.');
        if (room.agents.length >= 8) throw new Error('A room supports up to 8 agents.');
        if (!PROVIDERS.includes(data.provider)) return;
        const provider = data.provider as ProviderId;
        room.agents.push({ id: randomUUID(), provider, name: AGENT_NAMES[provider], model: this.defaults()[room.preset ?? 'planning'][provider] ?? '', role: '', enabled: true,
          tools: [...DEFAULT_TOOLS], options: defaultOptions(provider, this.defaultPermission()) });
        this.changed(); void this.refreshCapabilities(room.agents.at(-1)!.id); break;
      }
      case 'removeAgent': {
        if (this.engine.busy) throw new Error('Pause or stop the run before removing agents.');
        const agent = agentOf(data.id);
        if (!agent) return;
        room.agents = room.agents.filter(a => a !== agent); this.caps.delete(agent.id);
        if (room.leadId === agent.id) room.leadId = undefined;
        void this.release(room.id, agent.id); this.changed(); break;
      }
      case 'localModels': {
        if (this.engine.busy) throw new Error('Pause or stop the run before changing local tools.');
        const available = this.connections.find(c => c.id === 'ollama')?.models ?? [];
        for (const key of ['vision', 'embedding'] as const) {
          if (typeof data[key] !== 'string') continue;
          if (data[key] && !available.some(m => m.id === data[key] && !m.remote && m.capabilities?.includes(key))) throw new Error(`Choose an installed local ${key} model.`);
          this.models[key] = data[key];
        }
        await this.context.workspaceState.update('chatroom.localModels', this.models);
        await this.context.workspaceState.update('chatroom.localModelsChosen', true); this.changed(); break;
      }
      case 'attachDocuments': {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching documents.');
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach to Chatroom', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          filters: { 'Documents and images': ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'log'], 'All files': ['*'] } });
        for (const uri of uris ?? []) {
          const name = vscode.workspace.asRelativePath(uri, false);
          if ((await vscode.workspace.fs.stat(uri)).size > MAX_DOCUMENT_BYTES) { this.engine.log(`${name} is larger than 40 MB and was not attached`, 'error'); continue; }
          const bytes = await vscode.workspace.fs.readFile(uri), key = `${room.id}:${sha256(bytes)}`, controller = new AbortController();
          this.ingestions.get(key)?.abort(); this.ingestions.set(key, controller);
          // The user chose these files, so extraction is not blocked by the agents' room budget; usage is still counted.
          void this.documents.ingest(room, name, bytes, { source: 'attached', signal: controller.signal, checkBudget: false })
            .finally(() => { if (this.ingestions.get(key) === controller) this.ingestions.delete(key); });
        }
        break;
      }
      case 'removeDocument': {
        const doc = room.documents?.find(d => d.id === data.id);
        if (!doc) return;
        this.ingestions.get(`${room.id}:${doc.hash}`)?.abort(new Error('Document removed.'));
        room.documents = room.documents!.filter(d => d.id !== doc.id); this.changed(); break;
      }
      case 'approval': {
        if (typeof data.id !== 'string' || !['allow', 'allow-session', 'deny'].includes(data.decision)) return;
        const decided = this.engine.decide(data.id, { decision: data.decision, ...(typeof data.message === 'string' && data.message.trim() ? { message: data.message.trim().slice(0, 2000) } : {}) });
        if (!decided) throw new Error('This request is no longer pending.');
        break;
      }
      case 'agentSession': {
        const agent = agentOf(data.id);
        if (!agent) return;
        if (data.action === 'new') {
          await this.engine.resetSession([agent.id], 'forget');
          this.toast('notice', `${agent.name} starts a new session from its next turn.`);
        } else if (data.action === 'copyResume') {
          const id = agent.session?.id;
          const command = id && ({ claude: `claude --resume ${id}`, codex: `codex resume ${id}`, copilot: `copilot --resume ${id}` } as Partial<Record<ProviderId, string>>)[agent.provider];
          if (!command) throw new Error(`${agent.name} has no session to resume yet.`);
          await vscode.env.clipboard.writeText(command);
          this.toast('notice', `Copied: ${command}`);
        }
        break;
      }
      case 'capabilities': await this.refreshCapabilities(typeof data.id === 'string' ? data.id : undefined); break;
      case 'editor': if (data.action === 'reveal') await this.tracker.reveal(); break;
      case 'copilot': if (data.action === 'install' || data.action === 'login') await this.copilotTerminal(data.action); break;
      case 'team': {
        if (data.team === null) {
          if (this.engine.busy) throw new Error('Pause or stop the run before changing the team.');
          room.mode = 'orchestrated'; delete room.team; this.changed(); break;
        }
        this.applyTeam(room, data.team); break;
      }
      case 'saveTeam': {
        const team = normalizeTeam(data.team);
        if (!team) throw new Error(BAD_TEAM);
        await this.saveTeam(team);
        this.toast('notice', `Saved team "${team.name}".`); this.changed(); break;
      }
      case 'deleteTeam': {
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!await this.deleteTeam(name)) throw new Error(`No saved team named "${name}".`);
        this.toast('notice', `Deleted team "${name}".`); this.changed(); break;
      }
      case 'agentRetry': {
        const agent = agentOf(data.id);
        if (!agent) return;
        delete agent.unavailable;
        if (room.agentStates?.[agent.id]?.status === 'unavailable') delete room.agentStates[agent.id];
        this.toast('notice', `${agent.name} will be tried again on the next message.`);
        this.changed();
        // Check it again: native agents report their capabilities, the others their connection.
        void (this.native(agent) ? this.refreshCapabilities(agent.id) : this.refresh(agent.provider === 'copilot')).then(() => this.changed());
        break;
      }
      case 'worktree': await this.worktreeAction(room, data.action, typeof data.name === 'string' ? data.name : undefined); break;
      case 'sandbox': await this.sandboxAction(room, data); break;
    }
  }
  /** Room settings from the composer chips (§9.1). Only the editor toggle is accepted while agents work. */
  private updateRoom(room: Room, data: any): void {
    if (typeof data.attachEditor === 'boolean') room.attachEditor = data.attachEditor;
    if (typeof data.sandbox === 'boolean') { room.sandbox = data.sandbox; if (data.sandbox) void this.detectDocker(); }
    const keys = ['mode', 'leadId', 'concurrency', 'tokenBudget', 'preset', 'loop', 'shareSkills', 'permission', 'rounds', 'worktrees'].filter(key => data[key] !== undefined);
    if (keys.length && this.engine.busy) throw new Error('Pause or stop the run before changing room settings.');
    if (data.mode === 'pipeline' && !room.team) throw new Error(NO_TEAM);
    if (data.worktrees !== undefined) {
      if (!WORKTREE_MODES.includes(data.worktrees)) throw new Error('Choose off, auto or always for worktrees.');
      room.worktrees = data.worktrees; this.worktreeNotice();
    }
    if (data.permission !== undefined) this.setPermission(room.agents, data.permission, FULL_ACCESS);
    if (data.tokenBudget !== undefined) { const limit = boundedNumber(data.tokenBudget, 0, 10_000_000, room.tokenBudget); room.tokenBudget = limit && Math.max(1000, limit); }
    if (MODES.includes(data.mode)) room.mode = data.mode;
    if (typeof data.leadId === 'string' && room.agents.some(a => a.id === data.leadId)) room.leadId = data.leadId;
    if (data.concurrency !== undefined) room.concurrency = boundedNumber(data.concurrency, 1, 4, room.concurrency ?? 3);
    if (PRESETS.includes(data.preset)) {
      room.preset = data.preset;
      for (const agent of room.agents) this.selectModel(agent, this.defaults()[room.preset!][agent.provider] ?? '');
    }
    if (data.loop && typeof data.loop === 'object') this.setLoop(room, data.loop);
    if (typeof data.shareSkills === 'boolean' && data.shareSkills !== room.shareSkills) { room.shareSkills = data.shareSkills; void this.refreshSkills(); }
    this.changed();
  }
  private setLoop(room: Room, patch: Partial<LoopConfig>): void {
    room.loop = patchLoop(room.loop ?? { ...DEFAULT_LOOP }, patch);
    // A changed loop applies to the next message; an armed interval timer is dropped.
    if (!this.engine.busy) { room.loopState = undefined; this.engine.scheduleLoop(); }
  }
  private setPermission(agents: Agent[], value: unknown, fullError: string): PermissionLevel {
    if (!PERMISSIONS.includes(value as PermissionLevel)) throw new Error('Choose plan, ask, auto-edit or full.');
    if (value === 'full' && !this.userConfig('allowFullAccess', false)) throw new Error(fullError);
    for (const agent of agents) agent.options.permission = value as PermissionLevel;
    return value as PermissionLevel;
  }
  /** Agent edits from the settings dialog (§11.4). They apply from the agent's next turn. */
  private updateAgent(room: Room, agent: Agent, data: any): void {
    const options = data.options && typeof data.options === 'object' ? data.options : {};
    const allowFull = this.userConfig('allowFullAccess', false);
    if ((options.permission === 'full' || options.sandbox === 'danger-full-access') && !allowFull) throw new Error(FULL_ACCESS);
    const warnings: string[] = [];
    if (typeof data.enabled === 'boolean') {
      if (!data.enabled && agent.enabled) { this.engine.stopAgent(agent.id); void this.release(room.id, agent.id); }
      else if (data.enabled) agent.enabled = true;
    }
    if (typeof data.name === 'string') agent.name = data.name.trim().slice(0, 40) || agent.name;
    // The user's own choice: from the agent's next turn (false also clears what the agent set itself).
    if (data.isolate === true) { agent.isolate = true; this.worktreeNotice(); } else if (data.isolate === false) delete agent.isolate;
    if (typeof data.role === 'string') agent.role = data.role.trim().slice(0, 1600);
    if (Array.isArray(data.tools)) agent.tools = TOOL_NAMES.filter(t => data.tools.includes(t));
    if (typeof data.model === 'string') {
      const model = data.model.trim().slice(0, 160);
      if (model !== agent.model) {
        if (room.activeAgents?.includes(agent.id)) agent.model = model; else this.selectModel(agent, model);
        if (agent.unavailable?.reason === 'model') delete agent.unavailable;
      }
    }
    const o = agent.options;
    if (options.permission !== undefined) { if (PERMISSIONS.includes(options.permission)) o.permission = options.permission; else warnings.push('Unknown permission level.'); }
    if (typeof options.effort === 'string') {
      const effort = options.effort.trim(), efforts = this.efforts(agent);
      if (!effort || efforts.includes(effort) || (!efforts.length && EFFORT_ORDER.includes(effort))) o.effort = effort;
      else warnings.push(`${agent.name}'s model has no "${effort}" effort level.`);
    }
    if (options.thinking === 'on' || options.thinking === 'off') o.thinking = options.thinking;
    if (options.summary !== undefined) { if (SUMMARIES.includes(options.summary)) o.summary = options.summary; else warnings.push('Unknown reasoning summary.'); }
    if ('sandbox' in options) {
      if (options.sandbox === undefined || options.sandbox === null || options.sandbox === '') delete o.sandbox;
      else if (SANDBOXES.includes(options.sandbox)) o.sandbox = options.sandbox; else warnings.push('Unknown sandbox.');
    }
    if ('webSearch' in options) { if (typeof options.webSearch === 'boolean') o.webSearch = options.webSearch; else if (options.webSearch === null || options.webSearch === undefined) delete o.webSearch; }
    for (const key of ['useMcp', 'useSkills', 'useProjectSettings', 'ultra'] as const) if (typeof options[key] === 'boolean') o[key] = options[key];
    if (Array.isArray(options.extraDirs)) {
      const dirs = [...new Set(options.extraDirs.filter((d: unknown): d is string => typeof d === 'string').map((d: string) => d.trim()).filter(Boolean))] as string[];
      const valid = dirs.filter(dir => { try { return isAbsolute(dir) && statSync(dir).isDirectory(); } catch { return false; } }).slice(0, 10);
      if (valid.length < dirs.length) warnings.push(`Skipped ${dirs.length - valid.length} folder${dirs.length - valid.length === 1 ? '' : 's'}: use absolute paths of existing folders (at most 10).`);
      o.extraDirs = valid;
    }
    if ('customAgent' in options) { const name = typeof options.customAgent === 'string' ? options.customAgent.trim().slice(0, 100) : ''; if (name) o.customAgent = name; else delete o.customAgent; }
    if (agent.provider === 'copilot' && ['auto', 'cli', 'vscode-lm'].includes(options.copilotRuntime) && options.copilotRuntime !== o.copilotRuntime) {
      o.copilotRuntime = options.copilotRuntime; this.caps.delete(agent.id); void this.release(room.id, agent.id);
    }
    if (warnings.length) this.toast('error', warnings.join(' '));
  }

  // ── Room commands (§8.3) ──────────────────────────────────────────────────
  private describeLoop(loop: LoopConfig): string {
    const max = ` (at most ${loop.maxIterations} run${loop.maxIterations === 1 ? '' : 's'})`;
    const kind = loop.kind === 'rounds' ? `${loop.rounds} rounds` : loop.kind === 'consensus' ? `until every agent agrees${max}` : loop.kind === 'lead-done' ? `until the lead says done${max}`
      : loop.kind === 'interval' ? `every ${loop.everyMinutes} min${max}${loop.prompt ? `: "${loop.prompt.slice(0, 80)}"` : ''}` : 'once';
    const caps = loop.kind === 'once' ? [] : [loop.maxMinutes ? `stops after ${loop.maxMinutes} min` : '', loop.maxTokens ? `or ${loop.maxTokens.toLocaleString('en')} new tokens` : ''].filter(Boolean);
    return [kind, ...caps].join(', ');
  }
  private async runRoomCommand(name: string, args: string, agentIds: string[], text: string): Promise<void> {
    const room = this.engine.room, enabled = room.agents.filter(a => a.enabled);
    const targets = agentIds.map(id => room.agents.find(a => a.id === id)).filter((a): a is Agent => !!a);
    const names = (agents: Agent[]) => agents.map(a => a.name).join(', ') || 'no agents';
    const idle = () => { if (this.engine.busy) throw new Error(BUSY); };
    switch (name) {
      case 'help':
        this.notice(['Chatroom commands:', ...ROOM_COMMANDS.map(c => `/${c.name}${c.args ? ' ' + c.args : ''} — ${c.description}`), 'Agents\' own commands: type @Agent / to browse them.'].join('\n'));
        return;
      case 'clear': {
        idle();
        const list = targets.length ? targets : enabled;
        await this.engine.resetSession(list.map(a => a.id), 'forget');
        this.notice(`Context cleared for ${names(list)}. They start fresh from here.`);
        return;
      }
      case 'compact': {
        idle(); this.requireTrust();
        const list = (targets.length ? targets : enabled.filter(a => this.native(a))).map(a => a.id);
        if (!list.length) throw new Error('No agent here has a native session to compact.');
        await this.engine.runAgentCommand(list, 'compact', args, text);
        return;
      }
      case 'new': this.newRoom(); return;
      case 'export': await this.exportRoom(); return;
      case 'stop': this.sandbox.cancelRoom(room.id); this.engine.stop(); return;
      case 'loop': {
        const parsed = parseLoop(args);
        if (parsed.show) { this.notice(`Loop: ${this.describeLoop(room.loop)}.`); return; }
        if (parsed.error) throw new Error(parsed.error);
        idle();
        this.setLoop(room, { ...(parsed.loop ?? {}), ...(parsed.loop?.kind === 'interval' ? { prompt: parsed.prompt ?? '' } : {}) });
        if (room.loop.kind === 'interval' && parsed.prompt) {
          this.requireTrust();
          this.notice(`Loop set: ${this.describeLoop(room.loop)}. Starting now.`);
          await this.engine.start({ text: parsed.prompt, author: 'You' });
          return;
        }
        this.notice(`Loop set: ${this.describeLoop(room.loop)}. It applies to your next message.`);
        return;
      }
      case 'mode': {
        idle();
        const mode = ({ team: 'orchestrated', orchestrated: 'orchestrated', relay: 'sequential', sequential: 'sequential', parallel: 'parallel', custom: 'pipeline', pipeline: 'pipeline' } as Record<string, RoomMode>)[args.trim().toLowerCase()];
        if (!mode) throw new Error('Usage: /mode team | relay | parallel | custom');
        if (mode === 'pipeline' && !room.team) throw new Error(NO_TEAM);
        room.mode = mode;
        this.notice(mode === 'orchestrated' ? `Team mode: ${this.engine.lead()?.name ?? 'the lead'} leads.` : mode === 'sequential' ? 'Relay mode: agents reply one after another.'
          : mode === 'pipeline' ? `Custom team: ${room.team!.name} — ${teamPlan(room.team!, room)}.` : 'Parallel mode: agents answer at the same time.');
        return;
      }
      case 'lead': {
        idle();
        const token = args.trim().replace(/^@/, '').replace(/^"(.*)"$/, '$1');
        const hit = targets[0] ? [targets[0]] : token ? resolveMention(token, room.agents, room.leadId) : undefined;
        const lead = Array.isArray(hit) ? hit[0] : undefined;
        if (!lead) throw new Error('Usage: /lead <agent>, for example /lead Claude');
        room.leadId = lead.id; room.mode = 'orchestrated';
        this.notice(`${lead.name} leads this room (Team mode).`);
        return;
      }
      case 'team': {
        const parsed = parseTeam(args);
        if (parsed.error) throw new Error(parsed.error);
        const teams = this.teams();
        if (parsed.show) {
          const saved = teams.filter(t => !t.builtIn).map(t => t.name), templates = teams.filter(t => t.builtIn).map(t => t.name);
          this.notice([room.mode === 'pipeline' && room.team ? `Team: ${room.team.name} — ${teamPlan(room.team, room)}.` : 'This room is not using a team of its own.',
            saved.length ? `Your teams: ${saved.join(', ')}.` : 'You have no saved teams yet.',
            templates.length ? `Templates: ${templates.join(', ')}.` : '',
            'Use one with /team <name>, write one like /team Lead: Claude > Draft: Codex > Review: Claude, Copilot, or open the builder with /team edit.'].filter(Boolean).join('\n'));
          return;
        }
        if (parsed.edit) { for (const view of this.views) void view.postMessage({ type: 'openTeam' }); return; }
        if (parsed.off) {
          idle(); room.mode = 'orchestrated';
          this.notice(`Team mode: ${this.engine.lead()?.name ?? 'the lead'} leads.`);
          return;
        }
        if (parsed.remove !== undefined) {
          if (!await this.deleteTeam(parsed.remove)) throw new Error(`No saved team named "${parsed.remove}".`);
          this.notice(`Deleted team "${parsed.remove}".`);
          return;
        }
        if (parsed.save !== undefined) {
          if (!room.team) throw new Error(NO_TEAM);
          const name = parsed.save || (room.team.name === 'Custom team' ? '' : room.team.name);
          if (!name) throw new Error('Usage: /team save <name>');
          room.team.name = name;
          await this.saveTeam({ ...room.team, name });
          this.notice(`Saved team "${name}".`);
          return;
        }
        if (parsed.use !== undefined) {
          const team = teams.find(t => t.name.toLowerCase() === parsed.use!.toLowerCase());
          if (!team) throw new Error(`No team named "${parsed.use}". Teams: ${teams.map(t => t.name).join(', ')}.`);
          this.applyTeam(room, team);
          return;
        }
        if (parsed.team) this.applyTeam(room, parsed.team, true);
        return;
      }
      case 'worktrees': {
        const parsed = parseWorktrees(args);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.mode) {
          idle(); room.worktrees = parsed.mode; this.worktreeNotice();
          this.notice(`Worktrees for this room: ${MODE_TEXT[parsed.mode]}.${parsed.mode !== 'off' && !this.worktreesAvailable ? ' This folder is not a git repository, so agents share it.' : ''}`);
          return;
        }
        if (parsed.action === 'status') { this.notice(this.worktrees.describe(room, this.worktreesAvailable)); return; }
        await this.worktreeAction(room, parsed.action, parsed.name);
        return;
      }
      case 'sandbox': {
        const parsed = parseSandbox(args), settings = this.sandboxSettings();
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.toggle !== undefined) {
          room.sandbox = parsed.toggle;
          if (!parsed.toggle) { this.notice('Sandbox off for this room: agents can\'t run code in it. Turn it on again with /sandbox on.'); return; }
          if (!settings.enabled) { this.notice(`Sandbox on for this room, but it is turned off in Settings (chatroom.sandbox.enabled). Turn it on there to use it.`); return; }
          await this.detectDocker();
          const docker = this.dockerState();
          this.notice(`Sandbox on for this room: agents can ask to run code with sandbox_run, and you can use /sandbox <command>. Every run asks you first.${docker.available ? '' : ` ${docker.detail}`}`);
          return;
        }
        if (parsed.status) { await this.detectDocker(); this.notice(this.describeSandbox(room)); return; }
        if (!settings.enabled) { this.notice(SANDBOX_SETTING_OFF); return; }
        if (!sandboxOn(settings, room)) { this.notice(SANDBOX_ROOM_OFF); return; }
        await this.userSandbox(room, sandboxRequest({ command: parsed.command, code: parsed.code, language: parsed.language, profile: parsed.profile, network: parsed.network,
          timeoutSeconds: parsed.timeoutSeconds, copyFiles: parsed.copyFiles }, { timeoutSeconds: settings.timeoutSeconds, workdirFrom: 'workspace' }));
        return;
      }
      case 'model': {
        idle();
        if (targets.length !== 1) throw new Error('Mention the agent: @Claude /model opus');
        const agent = targets[0]!, model = args.trim().slice(0, 160);
        if (!model) { this.notice(`${agent.name} uses ${agent.model || 'its default model'}.`); return; }
        if (agent.provider !== 'claude') {
          const known = this.knownModels(agent);
          if (!known.includes(model)) throw new Error(known.length ? `${agent.name} has no model "${model}". Choose one of: ${known.slice(0, 12).join(', ')}` : `${agent.name}'s models are not loaded yet. Open its settings or press Refresh, then try again.`);
        }
        this.selectModel(agent, model);
        this.notice(`${agent.name} now uses ${model}.`);
        return;
      }
      case 'effort': {
        idle();
        const level = args.trim().toLowerCase();
        if (!level) throw new Error('Usage: /effort <level>, for example /effort high');
        const value = level === 'default' ? '' : level, applied: Agent[] = [], skipped: Agent[] = [];
        for (const agent of targets.length ? targets : enabled.filter(a => this.native(a))) {
          const efforts = this.efforts(agent);
          if (this.native(agent) && (!value || efforts.includes(value) || (!efforts.length && EFFORT_ORDER.includes(value)))) { agent.options.effort = value; applied.push(agent); } else skipped.push(agent);
        }
        this.notice(`Effort ${value || 'default'} for ${names(applied)}.${skipped.length ? ` Not available for ${names(skipped)}.` : ''}`);
        return;
      }
      case 'permissions': {
        idle();
        const level = ({ auto: 'auto-edit', 'auto-edit': 'auto-edit', plan: 'plan', ask: 'ask', full: 'full' } as Record<string, PermissionLevel>)[args.trim().toLowerCase()];
        if (!level) throw new Error('Usage: /permissions plan | ask | auto | full');
        const list = targets.length ? targets : room.agents;
        if (level === 'full') {
          if (!this.userConfig('allowFullAccess', false)) throw new Error('Enable "chatroom.allowFullAccess" in Settings first.');
          const choice = await vscode.window.showWarningMessage('Allow agents to edit files and run commands without asking?', { modal: true }, 'Allow full access');
          if (choice !== 'Allow full access') return;
        }
        this.setPermission(list, level, 'Enable "chatroom.allowFullAccess" in Settings first.');
        this.notice(`Permissions: ${PERMISSION_LABELS[level]} for ${names(list)}.`);
        return;
      }
      case 'status': {
        const list = targets.length ? targets : room.agents;
        this.notice(list.map(agent => {
          const caps = this.capsFor(agent), connection = this.connections.find(c => c.id === agent.provider), native = !!this.native(agent);
          const runtime = native ? RUNTIME_LABELS[agent.provider] : agent.provider === 'copilot' ? 'GitHub Copilot (VS Code chat model)' : PROVIDER_LABELS[agent.provider];
          const version = caps?.version ?? connection?.version ?? '';
          const away = this.availabilityOf(agent);
          return `${agent.name} · ${runtime}${version ? ' ' + version : ''} · ${agent.model || 'default'} · effort ${agent.options.effort || 'default'} · ${native ? PERMISSION_LABELS[agent.options.permission] : 'Read-only (Chatroom tools)'} · session ${agent.session?.id?.slice(0, 8) || 'new'} · context ${agent.session?.context?.percent ?? '—'}%${agent.enabled ? '' : ' · off'}${away ? ` · unavailable: ${unavailableText(away, Date.now())}` : ''}`;
        }).join('\n'));
        return;
      }
      default: throw new Error(`Unknown command /${name}. Type / to see the commands.`);
    }
  }
  dispose(): Promise<void> {
    if (this.disposed) return this.disposed;
    this.engine.dispose();
    this.sandbox.dispose();
    for (const controller of this.ingestions.values()) controller.abort();
    void this.knowledge.flush();
    // Drivers start killing their processes synchronously; deactivate waits for them.
    this.disposed = Promise.allSettled(Object.values(this.drivers).map(driver => driver.dispose())).then(() => {});
    void this.roomTools.dispose().catch(() => {});
    this.tracker.dispose();
    if (this.timer) clearTimeout(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persist();
    return this.disposed.then(() => this.persistence).then(() => {});
  }
}
