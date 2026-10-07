export type ProviderId = 'codex' | 'claude' | 'copilot' | 'ollama';
export type NativeProviderId = 'codex' | 'claude' | 'copilot';
/** Chatroom's read-only tools for agents without native tools (Ollama, Copilot through vscode.lm). */
export type ToolName = 'list_files' | 'read_file' | 'search_files' | 'search_documents' | 'ollama_ocr' | 'semantic_search';
/** Room tools offered to native CLIs through MCP or Codex dynamic tools. */
export type RoomToolName = 'search_documents' | 'read_document' | 'semantic_search' | 'ollama_ocr' | 'isolate_workspace' | 'sandbox_run';
/** test: an isolated run on a writable copy; security: also no root user and a read-only copy. */
export type SandboxProfile = 'test' | 'security';
export type SandboxLanguage = 'bash' | 'python' | 'node';
/** What a sandbox run should do. Either `command` (a shell command) or `code` + `language` (a script). */
export interface SandboxRequest {
  command?: string; code?: string; language?: SandboxLanguage;
  profile: SandboxProfile;
  /** Network inside the container; off unless the user approves it. */
  network: boolean;
  timeoutSeconds: number;
  /** Globs of files (relative to /work) whose text is returned when small. */
  outputs?: string[];
  /** Why the run is needed, shown on the approval card. */
  purpose?: string;
  /** Which folder is copied into /work: the agent's folder (its worktree when isolated), the workspace, or nothing. */
  workdirFrom: 'agent' | 'workspace' | 'none';
}
/** A sandbox run and its result, shown as a card in the room. */
export interface SandboxResult {
  id: string;
  status: 'pending' | 'pulling' | 'running' | 'done' | 'failed' | 'denied' | 'timeout' | 'cancelled';
  image: string; profile: SandboxProfile; network: boolean;
  /** The command or script as run (scripts: the language and the code). */
  command: string; language?: SandboxLanguage; purpose?: string;
  limits: { cpus: number; memoryMb: number; timeoutSeconds: number };
  exitCode?: number; durationMs?: number;
  /** Tails, at most 16,000 characters each. */
  stdout: string; stderr: string;
  /** Files created or changed in /work (at most 50); text for requested outputs under 64 KB. */
  files?: { path: string; size: number; text?: string }[];
  error?: string;
  /** Agent name, or 'You'. */
  requestedBy: string; agentId?: string;
  createdAt: number; startedAt?: number; finishedAt?: number;
}
export type TaskPreset = 'planning' | 'drafting' | 'review';
export type ModelDefaults = Record<TaskPreset, Partial<Record<ProviderId, string>>>;
/** orchestrated: a lead plans for the team; sequential: relay; parallel: independent rounds; pipeline: the user's own team stages. */
export type RoomMode = 'orchestrated' | 'sequential' | 'parallel' | 'pipeline';
export type TurnKind = 'discussion' | 'direct' | 'plan' | 'step' | 'synthesis' | 'handoff' | 'command' | 'stage' | 'merge';
/** off: agents share the workspace folder; auto: agents that edit without asking get their own git worktree when another agent could edit at the same time; always: every agent that can edit gets one. */
export type WorktreeMode = 'off' | 'auto' | 'always';
export type PermissionLevel = 'plan' | 'ask' | 'auto-edit' | 'full';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface AgentOptions {
  /** Native effort level; '' = the CLI's own default. */
  effort: string;
  /** Claude extended thinking. */
  thinking: 'on' | 'off';
  /** Codex reasoning summary. */
  summary: ReasoningSummary;
  permission: PermissionLevel;
  /** Codex sandbox override; undefined = derived from permission. */
  sandbox?: CodexSandbox;
  /** undefined = CLI default; false = off; true = live web search. */
  webSearch?: boolean;
  useMcp: boolean;
  useSkills: boolean;
  /** CLAUDE.md / AGENTS.md / project settings and hooks. */
  useProjectSettings: boolean;
  extraDirs: string[];
  /** Session-level ultra: Claude ultracode, Codex 'ultra' effort. */
  ultra: boolean;
  /** Claude --agent / Copilot custom agent. */
  customAgent?: string;
  copilotRuntime?: 'auto' | 'cli' | 'vscode-lm';
}
export interface AgentSession {
  /** Claude session_id, Codex thread id or ACP sessionId. */
  id?: string;
  provider?: ProviderId;
  /** Last room message id delivered to (or skipped for) this agent's native session. */
  seen?: string;
  framingHash?: string;
  /** Claude: last cumulative total_cost_usd, the baseline for per-turn cost. */
  cost?: number;
  context?: { percent: number; tokens: number; window: number };
  quota?: Usage['quota'];
  startedAt?: number;
  lastUsedAt?: number;
  /** The folder the native session was started in; a different folder (a worktree) means a new session. */
  cwd?: string;
}
/** An agent's own git worktree while it is isolated. */
export interface AgentWorktree { path: string; branch: string; createdAt: number; checkpoints: number }
/** The combined work of a room's isolated agents, waiting for the user. */
export interface RoomChanges {
  /** The snapshot the worktrees started from: HEAD plus the user's uncommitted and untracked files at that time. */
  base: string;
  /** The integration branch and worktree that combine every agent's branch. */
  branch: string; path: string;
  files: { path: string; added: number; removed: number; status: 'A' | 'M' | 'D' | 'R' }[];
  added: number; removed: number;
  status: 'ready' | 'conflict' | 'applied' | 'discarded' | 'kept';
  /** status 'conflict': agents whose branch could not be merged, and the files. */
  conflicts?: { agentId: string; files: string[] }[];
  /** status 'kept': the branch name the user kept. */
  kept?: string;
  updatedAt: number;
}
/** Why an agent is skipped: out of usage, CLI not installed, signed out, its model is not available, or its local server is not running. */
export type UnavailableReason = 'usage-limit' | 'missing' | 'signed-out' | 'model' | 'offline';
export interface Unavailable {
  reason: UnavailableReason; detail: string;
  /** When it was detected (ms). */
  at: number;
  /** Retry after this time (ms); undefined = until it is fixed or the user presses Try again. */
  until?: number;
  /** reason 'model': the model that was not available. */
  model?: string;
}
/** One stage of a user-defined team. Stages run in order; each sees the work of the stages before it. */
export interface TeamStage {
  name: string;
  /** Agent names (or provider names such as "codex"), resolved in each room. */
  agents: string[];
  /** The stage's agents answer together (parallel) or one after another (relay). */
  run: 'parallel' | 'relay';
  /** A lead stage sets up the work for the stages after it, or answers directly and ends with [DONE]. */
  lead?: boolean;
  /** Optional short instruction from the user for this stage. */
  task?: string;
  /** Model routing for this stage; undefined = each agent's own model. */
  preset?: TaskPreset;
}
export interface TeamConfig {
  name: string; stages: TeamStage[];
  /** After the last stage, the first lead writes the final answer. */
  wrapUp: boolean;
  /** A template that ships with Chatroom (not saved in settings). */
  builtIn?: boolean;
}
export interface Agent {
  id: string; name: string; provider: ProviderId; model: string; role: string;
  enabled: boolean;
  /** Set when the agent cannot run (usage limit, missing CLI, model not available…); the room skips it until then. */
  unavailable?: Unavailable;
  /** Always work in an own git worktree (set by the user, or by the agent itself in Full access). */
  isolate?: boolean;
  /** The agent's worktree while it is isolated. */
  worktree?: AgentWorktree;
  /** Legacy Chatroom tools (Ollama, Copilot via vscode.lm). */
  tools: ToolName[];
  options: AgentOptions;
  session?: AgentSession;
}
export interface Usage {
  input: number; output: number; cached: number; cacheWrite: number;
  requests: number; estimated: boolean; cost?: number;
  quota?: { primaryUsedPercent: number; secondaryUsedPercent: number; primaryWindowMinutes?: number; secondaryWindowMinutes?: number; observedAt: number };
}
export interface PlanStep {
  id: string; agentId: string; task: string; after: string[];
  status: 'pending' | 'running' | 'complete' | 'error' | 'skipped'; detail?: string; messageId?: string;
}
/** Live state of a lead-and-team run. Steps run when every step in `after` is complete. */
export interface Flow { wave: number; leadId: string; phase: 'plan' | 'steps' | 'synthesis'; steps: PlanStep[]; planId?: string }
export interface ActivityItem {
  id: string;
  kind: 'tool' | 'command' | 'edit' | 'read' | 'search' | 'mcp' | 'subagent' | 'plan' | 'compact' | 'info' | 'error';
  title: string; detail?: string; diff?: string;
  status: 'running' | 'done' | 'failed' | 'declined';
  at: number;
}
export type ApprovalKind = 'command' | 'edit' | 'read' | 'network' | 'mcp' | 'plan' | 'sandbox' | 'other';
export interface ApprovalRequest { kind: ApprovalKind; tool: string; title: string; detail?: string; diff?: string; canAllowSession: boolean }
export interface ApprovalDecision { decision: 'allow' | 'allow-session' | 'deny'; message?: string }
export interface ApprovalInfo extends ApprovalRequest {
  id: string; agentId: string; provider: ProviderId;
  status: 'pending' | 'allowed' | 'allowed-session' | 'denied' | 'expired' | 'cancelled';
  createdAt: number; expiresAt: number; decidedAt?: number;
}
export interface EditorSnapshot {
  /** Absolute file path (or the URI string for untitled documents). */
  path: string; relPath: string; label: string; languageId?: string;
  kind: 'text' | 'notebook' | 'image' | 'other';
  /** 1-based inclusive lines; text capped at 100,000 characters. */
  selection?: { startLine: number; endLine: number; text: string };
  dirty?: boolean;
  /** Up to 5 recently active files, excluding this one. */
  openTabs: { label: string; relPath: string }[];
  key: string;
}
export interface TurnFlags { think?: boolean; ultra?: boolean }
export interface Message {
  id: string; author: string; agentId?: string; kind: 'user' | 'agent' | 'tool' | 'notice' | 'approval';
  text: string; createdAt: number; status: 'complete' | 'streaming' | 'cancelled' | 'error'; usage?: Usage;
  turn?: TurnKind; plan?: PlanStep[]; step?: { id: string; plan?: string; task: string; after: string[] };
  /** User message: agents explicitly @mentioned. */
  targets?: string[];
  /** User message: open-file context sent with it. */
  editor?: EditorSnapshot;
  flags?: TurnFlags;
  /** Agent message: streamed thinking or reasoning summary (last 20,000 characters). */
  thinking?: string;
  /** Agent message: native tool activity during the turn (at most 80 items). */
  activity?: ActivityItem[];
  approval?: ApprovalInfo;
  /** Agent message that handed off to other agents, or a handoff turn's origin. */
  handoff?: { from: string; to: string[] };
  marker?: 'agree' | 'done';
  /** Agent message: a turn in a stage of the room's own team. index is 0-based. */
  stage?: { index: number; total: number; name: string; lead?: boolean };
  /** Notice: the room's combined worktree changes (kept up to date while it is the latest one). */
  changes?: RoomChanges;
  /** Notice: a sandbox run and its result (updated in place while it runs). */
  sandbox?: SandboxResult;
}
export interface RoomDocument {
  id: string; name: string; hash: string; kind: 'text' | 'pdf' | 'image' | 'docx'; source: 'attached' | 'workspace';
  status: 'extracting' | 'ocr' | 'embedding' | 'ready' | 'error'; detail?: string;
  chars: number; chunks: number; pages?: number; ocrPages?: number; embedded?: string; addedAt: number;
}
export interface Activity { id: string; text: string; time: number; kind: 'info' | 'tool' | 'error' }
export type LoopKind = 'once' | 'rounds' | 'consensus' | 'lead-done' | 'interval';
export interface LoopConfig {
  kind: LoopKind;
  /** Passes for 'rounds' (relay/parallel) or waves (team), 1..50. */
  rounds: number;
  /** Interval minutes, 1..1440. */
  everyMinutes: number;
  /** Cap for consensus, lead-done and interval, 1..50. */
  maxIterations: number;
  /** Wall-clock cap from loop start; 0 = none. */
  maxMinutes: number;
  /** New-token cap from loop start; 0 = none. */
  maxTokens: number;
  /** Interval prompt; default: the latest user message. */
  prompt?: string;
}
export interface LoopState { iteration: number; startedAt: number; startTokens: number; nextAt?: number; stoppedReason?: string }
export interface Room {
  id: string; title: string; createdAt: number; agents: Agent[]; messages: Message[];
  activity: Activity[]; tokenBudget: number; usage: Record<string, Usage>;
  status: 'idle' | 'running' | 'paused'; currentAgent?: string; completedTurns: number;
  agentStates?: Record<string, { status: 'queued' | 'thinking' | 'tool' | 'approval' | 'complete' | 'error' | 'stopped' | 'unavailable'; detail?: string }>;
  mode?: RoomMode; concurrency?: number; preset?: TaskPreset; activeAgents?: string[]; queuedTurns?: number;
  leadId?: string; flow?: Flow; documents?: RoomDocument[]; schema?: number;
  /** New-token total when the current run began; the optional `tokenBudget` (0 = no limit) applies per run. */
  runStartTokens?: number;
  loop: LoopConfig;
  loopState?: LoopState;
  /** Send the open editor file and selection with messages. */
  attachEditor: boolean;
  /** Share skills between native agents. */
  shareSkills: boolean;
  /** The user's own team, used when mode is 'pipeline'. */
  team?: TeamConfig;
  /** While a team run is in progress: the current stage (1-based). */
  progress?: { stage: number; total: number; name: string };
  /** Per-room worktree mode; undefined = the chatroom.worktrees setting. */
  worktrees?: WorktreeMode;
  /** Combined changes from isolated agents that the user has not applied or discarded yet. */
  changes?: RoomChanges;
  /** Per-room sandbox switch; undefined = the chatroom.sandbox.enabled setting. */
  sandbox?: boolean;
}
export interface ModelInfo {
  id: string; name: string; capabilities?: string[]; remote?: boolean; error?: string;
  reasoning?: string[]; defaultReasoning?: string; isDefault?: boolean;
  description?: string;
  /** Claude: supports adaptive thinking. */
  thinking?: boolean;
  /** Claude: ultracode available; Codex: 'ultra' effort available. */
  ultra?: boolean;
}
export type HintAction = 'installCopilot' | 'copilotLogin' | 'openSettings';
export interface Connection {
  id: ProviderId; status: 'ready' | 'missing' | 'error' | 'unchecked'; detail: string; models: ModelInfo[];
  modelSource?: string; executable?: string; version?: string;
  runtime?: 'cli' | 'vscode-lm' | 'http';
  hint?: { text: string; action?: HintAction };
}
export interface NativeCommand { name: string; description?: string; argumentHint?: string; aliases?: string[]; source: 'builtin' | 'skill' | 'plugin' | 'mapped' }
export interface CapabilitySupport {
  thinking: boolean; summary: boolean; sandbox: boolean; webSearch: boolean;
  useMcp: boolean; useSkills: boolean; useProjectSettings: boolean; extraDirs: boolean;
  ultraSession: boolean; ultraTurn: boolean; thinkHard: boolean; fullAccess: boolean; customAgent: boolean;
}
export interface AgentCapabilities {
  provider: ProviderId; runtime: 'cli' | 'vscode-lm' | 'ollama';
  status: 'ready' | 'missing' | 'signed-out' | 'error' | 'unchecked';
  detail?: string; version?: string; account?: string;
  models: ModelInfo[]; efforts: string[]; defaultEffort?: string;
  tools: string[];
  skills: { name: string; description?: string; source?: string }[];
  commands: NativeCommand[];
  mcpServers: { name: string; status: string; tools?: number }[];
  plugins?: string[]; agents?: string[];
  supports: CapabilitySupport;
  context?: { percent: number; tokens: number; window: number };
  action?: HintAction;
  updatedAt: number;
}
// Legacy provider contract (Ollama, Copilot via vscode.lm).
export interface ProviderRequest { agent: Agent; system: string; prompt: string; signal: AbortSignal; onText: (text: string) => void; onActivity: (text: string) => void; continuation?: unknown; toolResults?: { call: ToolCall; output: string }[]; allowTools?: boolean }
export interface ProviderResult { text: string; usage: Usage; toolCalls?: ToolCall[]; continuation?: unknown }
export interface Provider { run(request: ProviderRequest): Promise<ProviderResult> }
export interface ToolCall { name: ToolName; arguments: Record<string, unknown>; id?: string }
// Native driver contract.
export interface TurnSink {
  text(full: string): void;
  thinking(full: string): void;
  /** Upserts by id. */
  activity(item: ActivityItem): void;
  approval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  session(patch: Partial<AgentSession>): void;
  capabilities(caps: AgentCapabilities): void;
  /** The CLI changed an option itself. Permission changes only apply as downgrades, except `exitPlan` (plan → ask after an approved plan). */
  options(patch: Partial<AgentOptions> & { exitPlan?: boolean }): void;
}
export interface NativeTurnRequest {
  room: Room; agent: Agent; kind: TurnKind;
  /** Room framing appended to the CLI's own system prompt for a new session. */
  framing: string;
  /** Rendered room messages this agent has not seen; may be ''. */
  context: string;
  /** Bounded room history, used when a stored session could not be resumed. */
  fullContext: () => string;
  /** Trigger plus turn note; may be ''. */
  ask: string;
  editor?: EditorSnapshot;
  flags: TurnFlags;
  /** Native slash command instead of a prompt (compact, review, skills…). */
  command?: { name: string; args: string };
  signal: AbortSignal;
  sink: TurnSink;
}
export interface NativeTurnResult {
  text: string; usage: Usage; status: 'complete' | 'interrupted';
  /** Interrupted turns: the CLI had already received the input, so its session holds it. */
  delivered?: boolean;
}
export interface NativeDriver {
  readonly provider: NativeProviderId;
  turn(request: NativeTurnRequest): Promise<NativeTurnResult>;
  /** Spawns and initializes when needed; never starts inference. */
  capabilities(room: Room, agent: Agent): Promise<AgentCapabilities>;
  /** Ends processes or handles of a room (or one agent); stored session ids remain valid. */
  release(roomId: string, agentId?: string): Promise<void>;
  dispose(): Promise<void>;
}
export type ProviderErrorCode = 'missing' | 'signed-out' | 'usage-limit' | 'model-unavailable' | 'session-lost' | 'crashed' | 'protocol' | 'unsupported' | 'failed';
export class ProviderError extends Error {
  constructor(message: string, readonly code: ProviderErrorCode, readonly extra: { action?: HintAction; resetsAt?: number } = {}) { super(message); this.name = 'ProviderError'; }
}
export interface Executable { command: string; prefix: string[] }
export interface Runtime { executable: Executable; version: string; source: string; modern: boolean }
export interface RoomToolDefinition { name: RoomToolName; description: string; inputSchema: object }
export interface RoomTools {
  definitions(): RoomToolDefinition[];
  call(agentId: string, name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  /** MCP JSON-RPC 2.0 message handler; undefined for notifications. */
  mcp(agentId: string, message: any, signal?: AbortSignal): Promise<any | undefined>;
  httpEndpoint(agentId: string): Promise<{ url: string; headers: Record<string, string> }>;
}
export type SkillSource = 'claude-user' | 'claude-project' | 'claude-plugin' | 'agents-user' | 'agents-project' | 'codex-user' | 'codex-project' | 'github-project' | 'copilot-user';
export interface SharedSkill { name: string; description: string; path: string; dir: string; source: SkillSource; nativeTo: NativeProviderId[] }
export interface SkillWiring { claudePluginDir?: string; copilotAddDir?: string; codexExtraRoots: string[]; indexPath?: string; indexDir?: string; skills: SharedSkill[] }
export interface SharedMcpServer { type?: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
export interface DriverSettings {
  allowFullAccess: boolean;
  idleSessionMs: number;
  copilotUseEnvToken: boolean;
  sharedMcpServers: Record<string, SharedMcpServer>;
}
export interface DriverHost {
  readonly version: string;
  cwd(): string;
  storageDir(): string;
  runtime(provider: NativeProviderId): Promise<Runtime | undefined>;
  settings(): DriverSettings;
  roomTools: RoomTools;
  skillWiring(): SkillWiring | undefined;
  /** The room framing the agent's next turn will use, so a capabilities process can be reused by that turn. */
  framing?(room: Room, agent: Agent): string;
  /** The folder this agent works in: its worktree while isolated, else cwd(). */
  cwdFor?(room: Room, agent: Agent): string;
  log(text: string, kind?: 'info' | 'tool' | 'error'): void;
}
export interface RoomCommandInfo { name: string; args?: string; description: string; agentScoped: boolean }
/** Host → webview state message. */
export interface StatePayload {
  type: 'state';
  room: Room; rooms: { id: string; title: string }[];
  connections: Connection[];
  capabilities: Record<string, AgentCapabilities>;
  editor: EditorSnapshot | null;
  sharedSkills: SharedSkill[];
  roomCommands: RoomCommandInfo[];
  /** Saved teams (chatroom.teams) followed by the built-in templates. */
  teams: TeamConfig[];
  localModels: { vision: string; embedding: string };
  discovering: boolean; modelDefaults: ModelDefaults; defaultPreset: TaskPreset; executionMode: RoomMode; maxParallelAgents: number;
  settings: { allowFullAccess: boolean; attachOpenFile: boolean; approvalTimeoutSeconds: number; worktrees: WorktreeMode; worktreesAvailable: boolean;
    /** enabled: the setting (and the room switch); available: Docker answers; detail: why not, or the Docker version. */
    sandbox: { enabled: boolean; available: boolean; detail: string; action?: 'installDocker' | 'startDocker' } };
  workspace: string; trusted: boolean;
}
/** Webview → host messages (validated by the host). */
export type WebviewMessage =
  | { type: 'ready' | 'open' | 'refresh' | 'settings' | 'new' | 'export' | 'pause' | 'stop' | 'start' | 'attachDocuments' }
  | { type: 'switch' | 'stopAgent' | 'removeAgent' | 'removeDocument'; id: string }
  | { type: 'send'; text: string; editor: boolean; think: boolean; ultra: boolean }
  | { type: 'options'; mode?: RoomMode; leadId?: string; concurrency?: number; tokenBudget?: number; preset?: TaskPreset; loop?: Partial<LoopConfig>; attachEditor?: boolean; shareSkills?: boolean; permission?: PermissionLevel; worktrees?: WorktreeMode; sandbox?: boolean }
  | { type: 'saveDefaults'; modelDefaults: ModelDefaults; defaultPreset: TaskPreset; executionMode: RoomMode; maxParallelAgents: number }
  | { type: 'agent'; id: string; name?: string; model?: string; role?: string; enabled?: boolean; tools?: ToolName[]; options?: Partial<AgentOptions>; isolate?: boolean }
  | { type: 'addAgent'; provider: ProviderId }
  | { type: 'localModels'; vision?: string; embedding?: string }
  | { type: 'approval'; id: string; decision: ApprovalDecision['decision']; message?: string }
  | { type: 'agentSession'; id: string; action: 'new' | 'copyResume' }
  | { type: 'capabilities'; id?: string }
  | { type: 'editor'; action: 'reveal' }
  | { type: 'copilot'; action: 'install' | 'login' }
  /** Use a team in this room (mode 'pipeline'); null returns the room to Team (lead) mode. */
  | { type: 'team'; team: TeamConfig | null }
  /** Save a team to chatroom.teams (replaces one with the same name). */
  | { type: 'saveTeam'; team: TeamConfig }
  | { type: 'deleteTeam'; name: string }
  /** Clear an agent's unavailable mark and check it again. */
  | { type: 'agentRetry'; id: string }
  /** The room's combined worktree changes: open the diff, apply them to the workspace, keep them as a branch, discard them, or remove leftover worktrees. */
  | { type: 'worktree'; action: 'review' | 'apply' | 'keep' | 'discard' | 'cleanup'; name?: string }
  /** Sandbox: run a command or a script (every run asks the user first), cancel or repeat a run, or start Docker Desktop. */
  | { type: 'sandbox'; action: 'run' | 'rerun' | 'cancel' | 'startDocker'; id?: string; command?: string; code?: string; language?: SandboxLanguage; profile?: SandboxProfile; network?: boolean };
/** Host → webview messages other than state. */
export type HostMessage = { type: 'error' | 'notice'; text: string } | { type: 'openTeam' };
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0, estimated: false });
export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite,
    requests: a.requests + b.requests, estimated: a.estimated || b.estimated,
    ...((a.cost !== undefined || b.cost !== undefined) ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
    ...((b.quota ?? a.quota) ? { quota: b.quota ?? a.quota } : {}) };
}
