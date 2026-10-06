export type ProviderId = 'codex' | 'claude' | 'copilot' | 'ollama';
export type ToolName = 'list_files' | 'read_file' | 'search_files' | 'search_documents' | 'ollama_ocr' | 'semantic_search';
export type TaskPreset = 'planning' | 'drafting' | 'review';
export type ModelDefaults = Record<TaskPreset, Partial<Record<ProviderId, string>>>;
/** orchestrated: a lead plans a step graph for the team; sequential: relay; parallel: independent rounds. */
export type RoomMode = 'orchestrated' | 'sequential' | 'parallel';
export type TurnKind = 'discussion' | 'direct' | 'plan' | 'step' | 'synthesis';
export interface Agent {
  id: string; name: string; provider: ProviderId; model: string; role: string;
  enabled: boolean; tools: ToolName[];
  reasoning?: string;
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
export interface Message {
  id: string; author: string; agentId?: string; kind: 'user' | 'agent' | 'tool' | 'notice';
  text: string; createdAt: number; status: 'complete' | 'streaming' | 'cancelled' | 'error'; usage?: Usage;
  turn?: TurnKind; plan?: PlanStep[]; step?: { id: string; plan?: string; task: string; after: string[] };
}
export interface RoomDocument {
  id: string; name: string; hash: string; kind: 'text' | 'pdf' | 'image' | 'docx'; source: 'attached' | 'workspace';
  status: 'extracting' | 'ocr' | 'embedding' | 'ready' | 'error'; detail?: string;
  chars: number; chunks: number; pages?: number; ocrPages?: number; embedded?: string; addedAt: number;
}
export interface Activity { id: string; text: string; time: number; kind: 'info' | 'tool' | 'error' }
export interface Room {
  id: string; title: string; createdAt: number; agents: Agent[]; messages: Message[];
  activity: Activity[]; rounds: number; tokenBudget: number; usage: Record<string, Usage>;
  status: 'idle' | 'running' | 'paused'; currentAgent?: string; completedTurns: number;
  agentStates?: Record<string, { status: 'queued' | 'thinking' | 'tool' | 'complete' | 'error' | 'stopped'; detail?: string }>;
  mode?: RoomMode; concurrency?: number; preset?: TaskPreset; activeAgents?: string[]; queuedTurns?: number;
  leadId?: string; flow?: Flow; documents?: RoomDocument[]; schema?: number;
  /** New-token total when the current run began; the optional `tokenBudget` (0 = no limit) applies per run. */
  runStartTokens?: number;
}
export interface ModelInfo { id: string; name: string; capabilities?: string[]; remote?: boolean; error?: string; reasoning?: string[]; defaultReasoning?: string; isDefault?: boolean }
export interface Connection {
  id: ProviderId; status: 'ready' | 'missing' | 'error' | 'unchecked'; detail: string; models: ModelInfo[];
  modelSource?: string; executable?: string; version?: string;
}
export interface ProviderRequest { agent: Agent; system: string; prompt: string; signal: AbortSignal; onText: (text: string) => void; onActivity: (text: string) => void; continuation?: unknown; toolResults?: { call: ToolCall; output: string }[]; allowTools?: boolean }
export interface ProviderResult { text: string; usage: Usage; toolCalls?: ToolCall[]; continuation?: unknown }
export interface Provider { run(request: ProviderRequest): Promise<ProviderResult> }
export interface ToolCall { name: ToolName; arguments: Record<string, unknown>; id?: string }
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0, estimated: false });
export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite,
    requests: a.requests + b.requests, estimated: a.estimated || b.estimated,
    ...((a.cost !== undefined || b.cost !== undefined) ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
    ...((b.quota ?? a.quota) ? { quota: b.quota ?? a.quota } : {}) };
}
