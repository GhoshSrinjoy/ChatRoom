import { randomUUID } from 'node:crypto';
import { ActivityItem, Agent, AgentCapabilities, ApprovalDecision, ApprovalInfo, ApprovalRequest, EditorSnapshot, Flow, Message, NativeDriver, PermissionLevel, PlanStep, Provider, ProviderError, ProviderId, Room, TaskPreset, TeamStage, ToolCall, TurnFlags, TurnKind, TurnSink, Unavailable, addUsage, emptyUsage } from './types';
import { MAX_PLAN_STEPS, PERMISSIONS, PERMISSION_LABELS, PROVIDER_LABELS, TurnSpec, boundedHistory, classifyUnavailable, estimatedUsage, framingHash, leadAgent, legacyContext, legacySystem, message, overLimit, parsePlan, parseToolCall, pipelineLead, planStages, renderContext, renderEntry, roomFresh, roomUpdate, stageAgents, teamPlan, turnAsk, unavailableText, unseenEntries, upsertChangesCard } from './core';
import { extractHandoffs, markerOf } from './commands';
import { plainEditorText } from './editor-context';

/** Per-agent git worktrees (optional): isolated agents edit their own branch, and the room combines the branches for review. */
export interface Isolation {
  /** Whether this agent should work in its own worktree for this turn (mode, permission, agent.isolate, and whether another agent could edit at the same time). */
  wants(agent: Agent, room: Room, kind?: TurnKind): boolean;
  /** Creates or reuses the agent's worktree (and the room base when needed); sets agent.worktree; returns its path. */
  prepare(room: Room, agent: Agent): Promise<string>;
  checkpoint(room: Room, agent: Agent, note: string): Promise<void>;
  /** Combines every isolated agent's branch into the room's integration branch, then fast-forwards clean agents to it; updates room.changes. */
  integrate(room: Room): Promise<{ conflicts: { agentId: string; files: string[] }[] }>;
  /** For a conflicting agent: merges the integration branch into its worktree and returns the conflicted files (markers left), or [] if it merged cleanly. */
  mergeInto(room: Room, agent: Agent): Promise<string[]>;
  finishMerge(room: Room, agent: Agent): Promise<boolean>;
}
export interface EngineOptions {
  /** Legacy providers (Ollama, Copilot through vscode.lm). */
  providers: Partial<Record<ProviderId, Provider>>;
  /** The native CLI driver for an agent, or undefined for the legacy path. */
  native: (agent: Agent) => NativeDriver | undefined;
  /** Legacy <chatroom-tool> calls. */
  tools: (call: ToolCall, agent: Agent, signal: AbortSignal) => Promise<string>;
  /** Optional document retrieval for the latest user message, shared by every turn in a run. */
  briefing?: (room: Room, query: string, signal: AbortSignal) => Promise<string>;
  framing: (agent: Agent, room: Room, legacy: boolean) => string;
  capabilities?: (agent: Agent, caps: AgentCapabilities) => void;
  contextTokens: () => number;
  /** Per-turn inactivity timeout: no sink event and no pending approval. */
  timeoutMs: () => number;
  approvalTimeoutMs: () => number;
  maxHandoffs: () => number;
  changed: () => void;
  clock?: Clock;
  /** Live status from the host (connections, capabilities); not stored on the agent. */
  availability?: (agent: Agent) => Unavailable | undefined;
  /** The model a team stage with this preset uses for the agent ('' = the agent's own model). */
  presetModel?: (agent: Agent, preset: TaskPreset) => string;
  isolation?: Isolation;
}
export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
export interface StartOptions { text?: string; targets?: string[]; all?: boolean; editor?: EditorSnapshot; flags?: TurnFlags; author?: string }
interface QueueItem { id: string; kind: 'discussion' | 'direct' | 'handoff'; handoff?: { fromId: string; from: string; line: string } }
interface Pass {
  trigger: Message; direct: boolean; parallel: boolean; snapshot?: Room;
  hops: number; keys: Set<string>; limitLogged: boolean;
  /** Last completed answer per agent in this pass, for loop conditions. */
  turns: Map<string, Message>;
  /** Parallel hand-offs wait until the round's turns finish. */
  deferred: QueueItem[];
  failed?: string;
  /** Team mode: agents that already failed to lead this pass. */
  leadTried?: Set<string>;
  /** The room's own team: the current stage and the agents that finished it. */
  pipeline?: { index: number; done: Set<string>; noticed?: boolean };
}
interface Watchdog { readonly done: boolean; arm(): void; suspend(): void; resume(): void; end(): void }
interface PendingApproval { agentId: string; finish: (status: ApprovalInfo['status'], decision: ApprovalDecision) => void }
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clearTimeout: handle => { if (handle !== undefined) clearTimeout(handle as NodeJS.Timeout); }
};
/** How long a driver may take to settle after an abort before the engine stops waiting for it. */
const ABORT_GRACE_MS = 10_000;
const MAX_ACTIVITY = 80;
/** A native delta is delivered whole (the CLI compacts on its own), up to this many characters. */
const MAX_DELTA_CHARS = 400_000;
const rank = (level: PermissionLevel) => PERMISSIONS.indexOf(level);
const display = (text: string) => text.split('<chatroom-tool>')[0]!.split('<chatroom-plan>')[0]!.slice(0, 100000);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** "A", "A and B", "A, B and C". */
const andList = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const skipKey = (agent: Agent, u: Unavailable) => `${agent.id}:${u.reason}:${u.until ?? ''}`;

export class RoomEngine {
  private queue: QueueItem[] = [];
  private pass?: Pass;
  private controllers = new Map<string, AbortController>();
  private approvals = new Map<string, PendingApproval>();
  private pauseRequested = false;
  private stopping = false;
  private running?: Promise<void>;
  private briefing?: { key: string; text: string };
  private briefingController?: AbortController;
  private writer: Promise<void> = Promise.resolve();
  private writers = 0;
  private loopTimer?: unknown;
  private readonly clock: Clock;
  /** The last pass-start skip notice, so an identical one is not posted again. */
  private lastSkipKey = '';
  /** Answers that failed because their agent cannot run for now (usage limit, model, sign-in…). */
  private blocked = new WeakSet<Message>();
  /** Team steps already handed to another agent once. */
  private moved = new WeakSet<PlanStep>();
  /** An isolated agent saved work since the room last combined the worktrees. */
  private integrationDue = false;
  constructor(public room: Room, private readonly options: EngineOptions) { this.clock = options.clock ?? realClock; }
  get busy(): boolean { return !!this.running; }
  /** Resolves when the current run (if any) has settled. */
  whenIdle(): Promise<void> { return this.running ?? Promise.resolve(); }
  private changed(): void {
    this.room.activeAgents = [...this.controllers.keys()];
    this.room.currentAgent = this.room.activeAgents[0];
    this.room.queuedTurns = this.queue.length + (this.pass?.deferred.length ?? 0) + (this.room.flow?.steps.filter(s => s.status === 'pending').length ?? 0);
    this.options.changed();
  }
  log(text: string, kind: 'info' | 'tool' | 'error' = 'info'): void {
    this.room.activity.push({ id: randomUUID(), text: text.slice(0, 1500), time: this.clock.now(), kind });
    this.room.activity = this.room.activity.slice(-150); this.changed();
  }
  private notice(text: string): void { this.room.messages.push(message('notice', text, 'Chatroom')); this.changed(); }
  private state(id: string, status: NonNullable<Room['agentStates']>[string]['status'], detail?: string): void {
    (this.room.agentStates ??= {})[id] = detail ? { status, detail } : { status };
  }
  lead(): Agent | undefined { return leadAgent(this.room); }
  /** Why an agent cannot run right now: its own mark until that runs out, else live status from the host. */
  private unavailable(agent: Agent): Unavailable | undefined {
    const mark = agent.unavailable;
    if (mark?.until !== undefined && mark.until <= this.clock.now()) delete agent.unavailable;
    else if (mark) return mark;
    return this.options.availability?.(agent);
  }
  private available(agent: Agent): boolean { return !this.unavailable(agent); }
  private why(agent: Agent): string { const u = this.unavailable(agent); return u ? unavailableText(u, this.clock.now()) : 'available'; }
  /** "Codex (out of usage until Thu 23:23) and Ollama (not running)". */
  private named(agents: Agent[]): string { return andList(agents.map(a => `${a.name} (${this.why(a)})`)); }

  // ── Runs and passes ───────────────────────────────────────────────────────
  start(input?: string | StartOptions, target?: string): Promise<void> {
    const opts: StartOptions = input && typeof input === 'object' ? input : { text: input, targets: target ? [target] : undefined };
    if (this.running) return Promise.reject(new Error('Pause or stop the current run before sending another message.'));
    const enabled = this.room.agents.filter(a => a.enabled);
    const targets = [...new Set(opts.targets ?? [])].filter(id => this.room.agents.some(a => a.id === id));
    if ((opts.targets?.length ?? 0) > 0 && !targets.some(id => enabled.some(a => a.id === id))) return Promise.reject(new Error(targets.length > 1 ? 'Those agents are disabled.' : 'That agent is disabled.'));
    if (!enabled.length) return Promise.reject(new Error('Enable at least one agent.'));
    const text = opts.text?.trim();
    if (text) {
      const user = message('user', text.slice(0, 24000), opts.author ?? 'You');
      user.createdAt = this.clock.now();
      if (targets.length && !opts.all) user.targets = targets;
      if (opts.editor) user.editor = opts.editor;
      if (opts.flags?.think || opts.flags?.ultra) user.flags = { ...(opts.flags.think ? { think: true } : {}), ...(opts.flags.ultra ? { ultra: true } : {}) };
      this.room.messages.push(user);
      if (this.room.title === 'New conversation') this.room.title = text.slice(0, 56);
      this.beginLoop(!opts.all && targets.length > 0);
      this.newPass(user, opts.all ? [] : targets);
    } else if (!this.pass) {
      const trigger = this.latestUser();
      if (!trigger) return Promise.reject(new Error('Write a message to start the room.'));
      const again = targets.length ? targets : trigger.targets ?? [];
      this.beginLoop(again.length > 0);
      this.newPass(trigger, again);
    }
    return this.launch();
  }
  private latestUser(): Message | undefined { return [...this.room.messages].reverse().find(m => m.kind === 'user' && m.turn !== 'command'); }
  private beginLoop(direct: boolean): void {
    this.clearLoopTimer();
    this.room.loopState = !direct && this.room.loop.kind !== 'once' ? { iteration: 1, startedAt: this.clock.now(), startTokens: roomFresh(this.room) } : undefined;
  }
  /** Starts a pass. Agents that cannot run right now are skipped with a notice; the others continue. */
  private newPass(trigger: Message, targets: string[]): void {
    const enabled = this.room.agents.filter(a => a.enabled), direct = targets.length > 0;
    // A paused plan that a new message replaces ends here, so its pending steps do not stay pending.
    if (this.room.flow) this.endFlow(this.room.flow, 'Replaced by a new message.');
    this.queue = []; this.room.agentStates = {}; delete this.room.progress;
    const pass: Pass = this.pass = { trigger, direct, parallel: !direct && this.room.mode === 'parallel', hops: 0, keys: new Set(), limitLogged: false, turns: new Map(), deferred: [] };
    const ready = enabled.filter(a => this.available(a)), away = enabled.filter(a => !ready.includes(a));
    for (const agent of away) this.state(agent.id, 'unavailable', this.why(agent));
    if (direct) {
      const asked = targets.map(id => enabled.find(a => a.id === id)).filter((a): a is Agent => !!a);
      const go = asked.filter(a => ready.includes(a)), blocked = asked.filter(a => !ready.includes(a));
      if (blocked.length) {
        this.log(`Skipping ${this.named(blocked)}`);
        this.notice(go.length ? `Skipping ${this.named(blocked)} · continuing with ${andList(go.map(a => a.name))}.`
          : `${blocked.length === 1 ? `${blocked[0]!.name} can't run right now (${this.why(blocked[0]!)})` : `${this.named(blocked)} can't run right now`}. Mention another agent, or press Try again in its settings.`);
      }
      this.queue = go.map(a => ({ id: a.id, kind: 'direct' }));
      return;
    }
    if (away.length) this.log(`Skipping ${this.named(away)}`);
    if (!ready.length) { this.notice(`No agent can run right now: ${away.map(a => `${a.name} (${this.why(a)})`).join(', ')}.`); this.lastSkipKey = ''; return; }
    // The room's own team: its stages post their own skip notices.
    if (this.room.mode === 'pipeline' && this.room.team?.stages.length) { pass.pipeline = { index: 0, done: new Set() }; return; }
    const key = away.map(a => skipKey(a, this.unavailable(a)!)).sort().join('|');
    if (key && key !== this.lastSkipKey) this.notice(`Skipping ${this.named(away)} · continuing with ${andList(ready.map(a => a.name))}.`);
    this.lastSkipKey = key;
    // A pipeline room without a team works like Team mode.
    if (this.room.mode === 'orchestrated' || this.room.mode === 'pipeline') {
      const lead = this.lead();
      if (!lead) return;
      const leader = ready.includes(lead) ? lead : ready[0]!;
      if (leader !== lead) this.log(`${lead.name} can't lead this message (${this.why(lead)}) · ${leader.name} leads instead`);
      this.room.flow = { wave: 0, leadId: leader.id, phase: 'plan', steps: [] };
      return;
    }
    this.queue = ready.map(a => ({ id: a.id, kind: 'discussion' }));
  }
  private launch(): Promise<void> {
    this.pauseRequested = false; this.stopping = false; this.room.status = 'running'; this.room.runStartTokens = roomFresh(this.room);
    for (const { id } of this.queue) this.state(id, 'queued');
    const flow = this.room.flow;
    if (flow) for (const id of flow.phase === 'steps' ? flow.steps.filter(s => s.status === 'pending').map(s => s.agentId) : [flow.leadId]) this.state(id, 'queued');
    this.running = Promise.resolve().then(() => this.run()).finally(() => { this.running = undefined; this.controllers.clear(); this.changed(); });
    this.changed(); return this.running;
  }
  pause(): void { if (this.running) { this.pauseRequested = true; this.log('Pause requested · finishing active turns'); } }
  stop(): void {
    this.stopping = true;
    for (const { id } of this.queue) if (!this.controllers.has(id)) this.state(id, 'stopped');
    for (const step of this.room.flow?.steps ?? []) if (step.status === 'pending') { step.status = 'skipped'; step.detail = 'Stopped by you.'; }
    this.queue = []; this.pass = undefined; this.room.flow = undefined; delete this.room.progress;
    this.room.loopState = undefined; this.clearLoopTimer();
    this.briefingController?.abort(new Error('Stopped by you.'));
    for (const controller of this.controllers.values()) controller.abort(new Error('Stopped by you.'));
    for (const pending of [...this.approvals.values()]) pending.finish('cancelled', { decision: 'deny', message: 'Stopped by you.' });
    if (!this.running) this.room.status = 'idle';
    this.changed();
  }
  stopAgent(id: string): void {
    const agent = this.room.agents.find(a => a.id === id); if (agent) agent.enabled = false;
    this.queue = this.queue.filter(item => item.id !== id);
    if (this.pass) this.pass.deferred = this.pass.deferred.filter(item => item.id !== id);
    this.controllers.get(id)?.abort(new Error('Agent stopped by you.'));
    for (const pending of [...this.approvals.values()]) if (pending.agentId === id) pending.finish('cancelled', { decision: 'deny', message: 'Stopped by you.' });
    this.state(id, 'stopped'); this.changed();
  }
  dispose(): void { this.stop(); this.clearLoopTimer(); }
  private halted(): boolean {
    if (!this.pauseRequested && !overLimit(this.room)) return false;
    if (!this.pauseRequested) this.log(`Paused at your limit of ${this.room.tokenBudget.toLocaleString('en')} new tokens for this message · Resume to continue, or change the limit in Usage`);
    this.room.status = 'paused'; return true;
  }
  private async run(): Promise<void> {
    try {
      await this.refreshBriefing();
      while (this.pass && !this.stopping) {
        if (this.halted()) return;
        const pass = this.pass;
        const done = pass.pipeline ? await this.pipeline(pass) : this.room.flow ? await this.orchestrate(pass) : await this.discuss(pass);
        if (!done || this.stopping || this.pass !== pass) break;
        await this.combine(pass);
        this.postChanges();
        if (this.stopping || this.pass !== pass) break;
        this.pass = undefined; this.queue = [];
        if (!this.nextIteration(pass)) break;
      }
      if (this.room.status === 'running') this.room.status = 'idle';
    } catch (error) { this.room.status = 'idle'; this.log(errorText(error), 'error'); }
    finally { if (this.room.status !== 'paused') delete this.room.progress; this.changed(); }
  }
  private async refreshBriefing(): Promise<void> {
    const latest = this.latestUser(), ready = (this.room.documents ?? []).filter(d => d.status === 'ready');
    if (!this.options.briefing || !latest || !ready.length) { this.briefing = undefined; return; }
    const key = latest.id + ready.map(d => d.hash).join();
    if (this.briefing?.key === key) return;
    const controller = this.briefingController = new AbortController();
    const timeout = this.clock.setTimeout(() => controller.abort(new Error('Document retrieval timed out.')), 60000);
    try {
      const text = await this.options.briefing(this.room, latest.text, controller.signal);
      this.briefing = { key, text };
      if (text) this.log(`Retrieved passages from ${ready.length} room document${ready.length === 1 ? '' : 's'} for every agent`, 'tool');
    } catch (error) {
      if (this.stopping) return;
      this.briefing = { key, text: '' }; this.log(`Document retrieval skipped · ${errorText(error)}`, 'error');
    } finally { this.clock.clearTimeout(timeout); this.briefingController = undefined; }
  }
  /** Relay, parallel and direct passes. Returns false when the run paused. */
  private async discuss(pass: Pass): Promise<boolean> {
    while (!this.stopping && this.pass === pass) {
      if (!this.queue.length && pass.deferred.length) { this.queue = pass.deferred; pass.deferred = []; pass.parallel = false; pass.snapshot = undefined; }
      if (!this.queue.length) return true;
      if (this.halted()) return false;
      if (this.capHit()) { this.queue = []; pass.deferred = []; return true; }
      if (!pass.parallel) { await this.runItem(this.queue.shift()!, pass, this.room); continue; }
      // Workers share a snapshot of the room taken when the round began; the next round sees every reply.
      const snapshot = pass.snapshot ??= { ...this.room, messages: this.room.messages.slice() };
      const workers = Math.max(1, Math.min(4, this.room.concurrency ?? 3));
      await Promise.all(Array.from({ length: workers }, async () => {
        while (this.queue.length && !this.stopping && !this.pauseRequested && !overLimit(this.room) && !this.capHit()) await this.runItem(this.queue.shift()!, pass, snapshot);
      }));
      if (!this.stopping) await this.combine(pass);
      if (this.loopStopped()) { this.queue = []; pass.deferred = []; }
    }
    return !this.stopping;
  }
  private loopSpec(pass: Pass): Partial<TurnSpec> {
    const state = pass.direct ? undefined : this.room.loopState, loop = this.room.loop, iteration = state?.iteration ?? 1;
    return { trigger: pass.trigger, ...(state ? { loop, iteration, round: iteration, rounds: loop.kind === 'rounds' ? loop.rounds : 1 } : {}) };
  }
  private async runItem(item: QueueItem, pass: Pass, contextRoom: Room): Promise<void> {
    const agent = this.room.agents.find(a => a.id === item.id);
    if (!agent?.enabled) { this.changed(); return; }
    if (!this.available(agent)) { this.state(agent.id, 'unavailable', this.why(agent)); this.changed(); return; }
    const spec: TurnSpec = { kind: item.kind, parallel: pass.parallel && item.kind === 'discussion', ...this.loopSpec(pass),
      ...(item.handoff ? { handoff: { from: item.handoff.from, line: item.handoff.line } } : {}) };
    const answer = await this.turn(agent, contextRoom, spec, item.handoff?.fromId);
    if (answer.status === 'complete') { pass.turns.set(agent.id, answer); this.handoffs(answer, agent, pass); }
    else if (answer.status === 'error' && !this.blocked.has(answer)) pass.failed ??= agent.name;
  }
  private handoffs(answer: Message, author: Agent, pass: Pass): void {
    const enabled = this.room.agents.filter(a => a.enabled);
    const found = extractHandoffs(answer.text, author, enabled, this.lead()?.id);
    const items: QueueItem[] = [];
    for (const { agentId, line } of found) {
      const target = enabled.find(a => a.id === agentId), key = `${author.id}>${agentId}>${line}`;
      if (!target || agentId === author.id || pass.keys.has(key)) continue;
      if (!this.available(target)) { pass.keys.add(key); this.notice(`${author.name} asked ${target.name}, but ${target.name} can't run right now (${this.why(target)}).`); continue; }
      if (pass.hops >= Math.max(0, this.options.maxHandoffs())) {
        if (!pass.limitLogged) { pass.limitLogged = true; this.log('Hand-off limit reached'); }
        continue;
      }
      pass.keys.add(key); pass.hops++;
      items.push({ id: agentId, kind: 'handoff', handoff: { fromId: author.id, from: author.name, line } });
    }
    if (!items.length) return;
    const to = [...new Set(items.map(i => i.id))];
    answer.handoff = { from: author.id, to };
    this.log(`${author.name} handed off to ${to.map(id => this.room.agents.find(a => a.id === id)!.name).join(', ')}`);
    if (pass.parallel) pass.deferred.push(...items);
    else {
      const targets = new Set(to);
      this.queue = [...items, ...this.queue.filter(q => q.kind === 'handoff' || !targets.has(q.id))];
    }
    for (const id of to) if (!this.controllers.has(id)) this.state(id, 'queued');
    this.changed();
  }
  /** Lead plan → steps → synthesis, with extra waves while the loop allows. Returns false when the run paused. */
  private async orchestrate(pass: Pass): Promise<boolean> {
    while (!this.stopping && this.pass === pass) {
      const flow = this.room.flow;
      if (!flow) return true;
      if (this.halted()) return false;
      if (this.capHit()) { this.endFlow(flow, 'The loop stopped.'); return true; }
      const lead = this.room.agents.find(a => a.id === flow.leadId);
      if (!lead?.enabled) { this.log('The lead agent is disabled · choose another lead and send again', 'error'); this.room.flow = undefined; return true; }
      if (flow.phase === 'steps') {
        await this.runSteps(flow, pass);
        if (this.stopping || this.room.flow !== flow) return !this.stopping;
        if (flow.steps.some(s => s.status === 'pending')) {
          if (this.halted()) return false;
          if (this.loopStopped()) { this.endFlow(flow, 'The loop stopped.'); return true; }
          for (const step of flow.steps) if (step.status === 'pending') { step.status = 'skipped'; step.detail = 'It could not be scheduled.'; }
        }
        // The lead writes the final answer on the combined work.
        await this.combine(pass);
        if (this.stopping || this.room.flow !== flow) return !this.stopping;
        flow.phase = 'synthesis'; this.state(lead.id, 'queued'); continue;
      }
      if (!this.available(lead)) {
        // A lead that can't run now (usage limit…) hands its plan or final answer to the next agent that can.
        (pass.leadTried ??= new Set()).add(lead.id);
        const next = this.room.agents.find(a => a.enabled && this.available(a) && !pass.leadTried!.has(a.id));
        if (next) { this.log(`${lead.name} can't run right now (${this.why(lead)}) · ${next.name} ${flow.phase === 'synthesis' ? 'writes the final answer' : 'leads this message'}`); flow.leadId = next.id; this.state(next.id, 'queued'); continue; }
        this.log(`${lead.name} can't run right now (${this.why(lead)}) · no other agent can take over`, 'error');
        this.endFlow(flow, 'No agent can run right now.'); return true;
      }
      const wavesLeft = Math.max(0, (this.room.loop.kind === 'rounds' ? this.room.loop.rounds : 1) - flow.wave - 1);
      const answer = await this.turn(lead, this.room, { kind: flow.phase, flow, wavesLeft, ...this.loopSpec(pass) });
      if (this.stopping || this.room.flow !== flow) return !this.stopping;
      if (answer.status !== 'complete') {
        // A lead that cannot run (missing CLI, usage limit) hands this message to the next enabled agent instead of failing it;
        // a final answer whose writer became unavailable goes to the next available agent.
        const blocked = this.blocked.has(answer);
        if (answer.status === 'error' && ((flow.phase === 'plan' && flow.wave === 0) || (blocked && flow.phase === 'synthesis'))) {
          (pass.leadTried ??= new Set()).add(lead.id);
          const next = this.room.agents.find(a => a.enabled && this.available(a) && !pass.leadTried!.has(a.id));
          if (next) { this.log(`${lead.name} could not ${flow.phase === 'plan' ? 'lead this message' : 'write the final answer'} · ${next.name} takes over`); flow.leadId = next.id; this.state(next.id, 'queued'); continue; }
        }
        if (answer.status === 'error' && !blocked) pass.failed ??= lead.name;
        this.room.flow = undefined; return true;
      }
      pass.turns.set(lead.id, answer);
      const delegate = flow.phase === 'plan' || wavesLeft > 0;
      if (delegate && !answer.plan?.length) {
        const found = extractHandoffs(answer.text, lead, this.room.agents.filter(a => a.enabled), lead.id).slice(0, MAX_PLAN_STEPS);
        if (found.length) answer.plan = found.map((h, i): PlanStep => ({ id: `s${i + 1}`, agentId: h.agentId, task: h.line || 'Help with the request above.', after: [], status: 'pending' }));
      }
      if (delegate && answer.plan?.length) {
        if (flow.phase === 'synthesis') flow.wave++;
        answer.turn = 'plan'; flow.steps = answer.plan; flow.planId = answer.id; flow.phase = 'steps';
        for (const step of flow.steps) this.state(step.agentId, 'queued');
        const stages = planStages(flow.steps);
        this.log(`${lead.name} planned ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'} in ${stages.length} stage${stages.length === 1 ? '' : 's'}${stages.some(s => s.length > 1) ? ' · independent steps run in parallel' : ''}`);
        continue;
      }
      if (answer.plan) { delete answer.plan; this.log(`${lead.name} proposed more steps, but no waves are left · use /loop N to allow more`); }
      answer.turn = 'synthesis'; this.room.flow = undefined; return true;
    }
    return !this.stopping;
  }
  private endFlow(flow: Flow, detail: string): void {
    for (const step of flow.steps) if (step.status === 'pending') { step.status = 'skipped'; step.detail = detail; }
    this.room.flow = undefined;
  }
  private async runSteps(flow: Flow, pass: Pass): Promise<void> {
    const running = new Map<string, Promise<void>>();
    const status = (id: string) => flow.steps.find(s => s.id === id)?.status;
    const limit = Math.max(1, Math.min(4, this.room.concurrency ?? 3));
    while (!this.stopping && this.room.flow === flow) {
      for (const step of flow.steps) {
        if (step.status !== 'pending') continue;
        const owner = this.room.agents.find(a => a.id === step.agentId);
        if (!owner?.enabled) { step.status = 'skipped'; step.detail = 'Its agent is disabled.'; }
        else if (step.after.some(id => status(id) === 'error' || status(id) === 'skipped')) { step.status = 'skipped'; step.detail = 'A step it builds on did not finish.'; }
        else if (!this.available(owner)) this.reassign(flow, step, owner);
      }
      // One turn per agent at a time; dependencies gate the rest.
      const busy = new Set(flow.steps.filter(s => s.status === 'running').map(s => s.agentId));
      for (const step of flow.steps) {
        if (running.size >= limit || this.pauseRequested || overLimit(this.room) || this.capHit()) break;
        if (step.status !== 'pending' || busy.has(step.agentId) || !step.after.every(id => status(id) === 'complete')) continue;
        const agent = this.room.agents.find(a => a.id === step.agentId)!;
        step.status = 'running'; busy.add(agent.id);
        running.set(step.id, this.turn(agent, this.room, { kind: 'step', flow, step, ...this.loopSpec(pass) }).then(answer => {
          step.messageId = answer.id;
          if (this.blocked.has(answer) && this.room.flow === flow) { step.status = 'pending'; this.reassign(flow, step, agent); return; }
          step.status = answer.status === 'complete' ? 'complete' : answer.status === 'cancelled' ? 'skipped' : 'error';
          if (answer.status !== 'complete') step.detail = answer.status === 'cancelled' ? 'Stopped.' : 'The agent failed.';
          if (answer.status === 'error' && !this.blocked.has(answer)) pass.failed ??= agent.name;
          if (answer.status === 'complete') {
            pass.turns.set(agent.id, answer);
            const mentioned = extractHandoffs(answer.text, agent, this.room.agents.filter(a => a.enabled), flow.leadId);
            if (mentioned.length) this.log(`${agent.name} mentioned ${[...new Set(mentioned.map(h => this.room.agents.find(a => a.id === h.agentId)?.name ?? h.agentId))].join(', ')}; in Team mode the lead coordinates.`);
          }
        }).finally(() => running.delete(step.id)));
      }
      this.changed();
      if (!running.size) return;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
  }
  /** Hands a Team step whose agent can't run to a free agent, preferring one not in the plan, else the lead; once per step, then it is skipped. */
  private reassign(flow: Flow, step: PlanStep, from: Agent): void {
    const why = this.why(from);
    this.state(from.id, 'unavailable', why);
    const busy = new Set(flow.steps.filter(s => s.status === 'running').map(s => s.agentId)), planned = new Set([flow.leadId, ...flow.steps.map(s => s.agentId)]);
    const free = this.moved.has(step) ? [] : this.room.agents.filter(a => a.enabled && a.id !== from.id && !busy.has(a.id) && this.available(a));
    const sub = free.find(a => !planned.has(a.id)) ?? free.find(a => a.id === flow.leadId) ?? free[0];
    if (!sub) { step.status = 'skipped'; step.detail = `${from.name} can't run (${why}).`; this.log(`Step ${step.id} skipped · ${from.name} can't run (${why})`); return; }
    this.moved.add(step);
    Object.assign(step, { agentId: sub.id, status: 'pending', detail: `${from.name} can't run (${why}) · ${sub.name} took this step` });
    this.state(sub.id, 'queued'); this.log(`Step ${step.id}: ${from.name} can't run (${why}) · ${sub.name} took this step`);
  }

  // ── The room's own team (pipeline) ─────────────────────────────────────────
  /** Runs the team's stages in order from the current one, then the final answer. Returns false when the run paused. */
  private async pipeline(pass: Pass): Promise<boolean> {
    const state = pass.pipeline!;
    for (;;) {
      const team = this.room.team;
      if (this.stopping || this.pass !== pass) return !this.stopping;
      if (!team || state.index >= team.stages.length) break;
      if (this.halted()) return false;
      if (this.capHit()) return true;
      const index = state.index, total = team.stages.length, stage = team.stages[index]!;
      this.room.progress = { stage: index + 1, total, name: stage.name }; this.changed();
      const result = await this.runStage(pass, stage, index, total, teamPlan(team, this.room));
      if (result === 'paused') return false;
      if (this.stopping || this.pass !== pass) return !this.stopping;
      if (result === 'end') return true;
      // The next stage builds on the combined work of this one.
      await this.combine(pass);
      if (this.stopping || this.pass !== pass) return !this.stopping;
      state.index++; state.done.clear(); state.noticed = false;
    }
    delete this.room.progress;
    const team = this.room.team;
    if (!team?.wrapUp) return true;
    if (this.halted()) return false;
    if (this.capHit()) return true;
    // The first lead writes the final answer; when it can't run, the next available agent tries once.
    const tried = new Set<string>(), ok = (a: Agent) => a.enabled && !tried.has(a.id) && this.available(a);
    for (let attempt = 0; attempt < 2; attempt++) {
      const writer = (attempt === 0 ? pipelineLead(this.room, ok) : undefined) ?? this.room.agents.find(ok);
      if (!writer) { this.log('No agent can write the final answer right now', 'error'); return true; }
      tried.add(writer.id);
      const answer = await this.turn(writer, this.room, { kind: 'synthesis', teamPlan: teamPlan(team, this.room), ...this.loopSpec(pass) });
      if (this.stopping || this.pass !== pass) return !this.stopping;
      if (answer.status === 'complete') { pass.turns.set(writer.id, answer); return true; }
      if (!this.blocked.has(answer)) { if (answer.status === 'error') pass.failed ??= writer.name; return true; }
    }
    return true;
  }
  /** One stage: its available agents together (on a shared snapshot) or one after another. 'end' = a lead answered directly or the loop stopped. */
  private async runStage(pass: Pass, stage: TeamStage, index: number, total: number, plan: string): Promise<'next' | 'end' | 'paused'> {
    const state = pass.pipeline!, agents = stageAgents(stage, this.room);
    const ready = agents.filter(a => this.available(a)), away = agents.filter(a => !ready.includes(a));
    const reasons = (list: Agent[]) => list.map(a => this.why(a)).join('; ');
    let runners = ready, substituted = false, standIn: string[] | undefined;
    if (!ready.length && !state.done.size) {
      const sub = this.stageSubstitute(state.done);
      const who = away.length ? `${andList(away.map(a => a.name))} can't run right now (${reasons(away)})` : 'nobody can run right now';
      if (!sub) { this.notice(`${stage.name}: no agent can run · skipped.`); return 'next'; }
      if (!state.noticed) this.notice(`${stage.name}: ${who} · ${sub.name} takes this stage.`);
      runners = [sub]; substituted = true; standIn = away.length ? away.map(a => a.name) : stage.agents;
    } else if (away.length && !state.noticed) this.notice(`${stage.name}: skipping ${andList(away.map(a => a.name))} (${reasons(away)}).`);
    state.noticed = true;
    const blocked: Agent[] = [];
    const runOne = async (agent: Agent, contextRoom: Room, others: string[], standIn?: string[]) => {
      const spec: TurnSpec = { kind: 'stage', stage: { index, total, name: stage.name, ...(stage.lead ? { lead: true } : {}), ...(stage.task ? { task: stage.task } : {}), others, plan, ...(standIn?.length ? { standIn } : {}) }, ...this.loopSpec(pass) };
      const answer = await this.turn(agent, contextRoom, spec, undefined, this.stageModel(agent, stage));
      if (answer.status === 'complete') {
        pass.turns.set(agent.id, answer); state.done.add(agent.id);
        const mentioned = extractHandoffs(answer.text, agent, this.room.agents.filter(a => a.enabled));
        if (mentioned.length) this.log(`${agent.name} mentioned ${[...new Set(mentioned.map(h => this.room.agents.find(a => a.id === h.agentId)?.name ?? h.agentId))].join(', ')}; in a team run the stages decide who works next.`);
      } else if (this.blocked.has(answer)) blocked.push(agent);
      else if (answer.status === 'error') pass.failed ??= agent.name;
    };
    const others = (agent: Agent) => runners.filter(a => a !== agent).map(a => a.name);
    const pending = runners.filter(a => !state.done.has(a.id));
    for (const agent of pending) this.state(agent.id, 'queued');
    if (stage.run === 'relay' || pending.length < 2) {
      for (const agent of pending) {
        if (this.stopping || this.pass !== pass) return 'next';
        if (this.halted()) return 'paused';
        if (this.capHit()) return 'end';
        await runOne(agent, this.room, others(agent), standIn);
      }
    } else {
      // Workers share a snapshot taken when the stage began: agents in the stage don't see each other's answers.
      const snapshot = { ...this.room, messages: this.room.messages.slice() }, queue = [...pending];
      const workers = Math.max(1, Math.min(4, this.room.concurrency ?? 3));
      await Promise.all(Array.from({ length: workers }, async () => {
        while (queue.length && !this.stopping && this.pass === pass && !this.pauseRequested && !overLimit(this.room) && !this.capHit()) { const agent = queue.shift()!; await runOne(agent, snapshot, others(agent)); }
      }));
      if (this.stopping || this.pass !== pass) return 'next';
      if (queue.length) { if (this.halted()) return 'paused'; if (this.capHit()) return 'end'; }
    }
    if (this.stopping || this.pass !== pass) return 'next';
    // Nobody in the stage finished because some could not run: one substitute does the stage.
    if (!substituted && blocked.length && !runners.some(a => state.done.has(a.id))) {
      const sub = this.stageSubstitute(state.done, blocked);
      if (sub) {
        this.notice(`${stage.name}: ${andList(blocked.map(a => a.name))} can't run right now (${reasons(blocked)}) · ${sub.name} takes this stage.`);
        if (this.halted()) return 'paused';
        if (this.capHit()) return 'end';
        await runOne(sub, this.room, [], blocked.map(a => a.name));
      }
    }
    if (stage.lead) {
      const direct = [...state.done].map(id => pass.turns.get(id)).find(m => m?.marker === 'done' && m.stage?.index === index);
      if (direct) { this.log(`${this.room.agents.find(a => a.id === direct.agentId)?.name ?? direct.author} answered directly · the remaining stages are skipped`); return 'end'; }
    }
    return 'next';
  }
  /** The agent that takes a stage nobody in it can run: the team's lead if it can, else the first available agent. */
  private stageSubstitute(skip: Set<string>, exclude: Agent[] = []): Agent | undefined {
    const ok = (a: Agent) => a.enabled && !skip.has(a.id) && !exclude.includes(a) && this.available(a);
    return pipelineLead(this.room, ok) ?? this.room.agents.find(ok);
  }
  /** A stage with a model preset runs the agent with that preset's model, without changing the agent's own model. */
  private stageModel(agent: Agent, stage: TeamStage): { model?: string } | undefined {
    const model = stage.preset ? this.options.presetModel?.(agent, stage.preset)?.trim() : '';
    return model && model !== agent.model ? { model } : undefined;
  }

  // ── Worktrees ─────────────────────────────────────────────────────────────
  /**
   * Combines the isolated agents' branches (after a stage, a parallel round, Team steps and every pass). An agent whose branch
   * conflicts gets one merge turn in its own worktree; what still conflicts after that is posted as a notice.
   */
  private async combine(pass?: Pass): Promise<void> {
    const isolation = this.options.isolation;
    if (!isolation || !this.integrationDue || !this.room.agents.some(a => a.worktree)) return;
    this.integrationDue = false;
    const integrate = async () => {
      try { return (await isolation.integrate(this.room)).conflicts; }
      catch (error) { this.log(`Couldn't combine the agents' worktrees · ${errorText(error)}`, 'error'); return undefined; }
    };
    let conflicts = await integrate();
    if (!conflicts) return;
    const tried = new Set<string>();
    for (;;) {
      const next = conflicts.find(c => !tried.has(c.agentId));
      if (!next || this.stopping || this.pauseRequested || overLimit(this.room)) break;
      tried.add(next.agentId);
      const agent = this.room.agents.find(a => a.id === next.agentId), driver = agent ? this.options.native(agent) : undefined;
      if (!agent?.worktree || !driver || !agent.enabled || !this.available(agent)) continue;
      let files: string[];
      try { files = await isolation.mergeInto(this.room, agent); }
      catch (error) { this.log(`${agent.name}: ${errorText(error)}`, 'error'); continue; }
      if (files.length) {
        this.log(`${agent.name}'s changes conflict with the combined work in ${files.join(', ')} · ${agent.name} merges them`);
        await this.nativeTurn(agent, driver, this.room, { kind: 'merge', merge: { files }, ...(pass ? { trigger: pass.trigger } : {}) });
        try { await isolation.finishMerge(this.room, agent); } catch (error) { this.log(`${agent.name}: ${errorText(error)}`, 'error'); }
      }
      conflicts = await integrate() ?? [];
    }
    if (this.stopping) return;
    // A pause leaves the remaining merges for the next combine.
    if (conflicts.some(c => !tried.has(c.agentId))) this.integrationDue = true;
    for (const conflict of conflicts.filter(c => tried.has(c.agentId))) {
      const name = this.room.agents.find(a => a.id === conflict.agentId)?.name ?? 'An agent';
      this.notice(`Couldn't combine ${name}'s changes in ${conflict.files.join(', ') || 'some files'} · review them or keep the branch.`);
    }
  }
  /** One live card for the room's changes, posted at the end of a pass and updated in place after that. */
  private postChanges(): void {
    const changes = this.room.changes;
    if (!this.options.isolation || !changes?.files.length || (changes.status !== 'ready' && changes.status !== 'conflict')) return;
    upsertChangesCard(this.room, this.clock.now());
    this.changed();
  }

  // ── Loops (§6.7) ──────────────────────────────────────────────────────────
  private loopStopped(): boolean { return !!this.room.loopState?.stoppedReason; }
  private capReason(iterations: boolean): string | undefined {
    const state = this.room.loopState, loop = this.room.loop;
    if (!state) return;
    if (iterations && ['consensus', 'lead-done', 'interval'].includes(loop.kind) && state.iteration >= loop.maxIterations) return `reached ${loop.maxIterations} run${loop.maxIterations === 1 ? '' : 's'}`;
    if (loop.maxMinutes > 0 && this.clock.now() - state.startedAt > loop.maxMinutes * 60000) return `reached the ${loop.maxMinutes}-minute limit`;
    if (loop.maxTokens > 0 && roomFresh(this.room) - state.startTokens >= loop.maxTokens) return `reached the ${loop.maxTokens.toLocaleString('en')}-token limit`;
  }
  /** Checks the time and token caps before a pass or a queued turn; stops the loop when one is hit. */
  private capHit(): boolean {
    const state = this.room.loopState;
    if (!state) return false;
    if (state.stoppedReason) return true;
    const reason = this.capReason(false);
    if (reason) this.stopLoop(reason);
    return !!reason;
  }
  private stopLoop(reason: string): void {
    if (this.room.loopState) { this.room.loopState.stoppedReason = reason; delete this.room.loopState.nextAt; }
    this.clearLoopTimer(); this.log(`Loop stopped: ${reason}`);
  }
  private finishLoop(note: string): false { this.room.loopState = undefined; if (note) this.log(note); return false; }
  /** After a completed pass: decides whether the loop runs another pass now (true), later (interval) or ends. */
  private nextIteration(pass: Pass): boolean {
    const state = this.room.loopState, loop = this.room.loop;
    if (!state || pass.direct || state.stoppedReason) return false;
    if (pass.failed) { this.stopLoop(`${pass.failed} failed`); return false; }
    if (loop.kind === 'once') return this.finishLoop('');
    if (!this.room.agents.some(a => a.enabled)) { this.stopLoop('no agent is turned on'); return false; }
    if (!this.room.agents.some(a => a.enabled && this.available(a))) { this.stopLoop('no agent is available'); return false; }
    // Team mode delegates the rounds as waves; a pipeline repeats every stage each round.
    const waves = !pass.pipeline && (this.room.mode === 'orchestrated' || this.room.mode === 'pipeline');
    if (loop.kind === 'rounds' && (waves || state.iteration >= loop.rounds)) return this.finishLoop(waves ? '' : `Loop finished · ${state.iteration} rounds`);
    if (loop.kind === 'consensus') {
      const turns = [...pass.turns.values()];
      if (turns.length && turns.every(m => m.marker === 'agree')) return this.finishLoop('Loop finished · every agent agrees');
    }
    if (loop.kind === 'lead-done') {
      const first = pass.pipeline ? this.room.team?.stages.find(s => s.lead) : undefined;
      const leads = pass.pipeline ? (first ? stageAgents(first, this.room) : []) : [this.lead()].filter((a): a is Agent => !!a);
      const lead = leads.find(a => pass.turns.get(a.id)?.marker === 'done');
      if (lead) return this.finishLoop(`Loop finished · ${lead.name} marked the task done`);
    }
    const cap = this.capReason(true);
    if (cap) { this.stopLoop(cap); return false; }
    if (loop.kind === 'interval') {
      state.nextAt = this.clock.now() + loop.everyMinutes * 60000;
      this.log(`Next loop run in ${loop.everyMinutes} minute${loop.everyMinutes === 1 ? '' : 's'}`);
      this.scheduleLoop(); return false;
    }
    state.iteration++;
    this.newPass(pass.trigger, []);
    for (const { id } of this.queue) this.state(id, 'queued');
    if (this.room.flow) this.state(this.room.flow.leadId, 'queued');
    return true;
  }
  private clearLoopTimer(): void { if (this.loopTimer !== undefined) { this.clock.clearTimeout(this.loopTimer); this.loopTimer = undefined; } }
  scheduleLoop(): void {
    this.clearLoopTimer();
    const state = this.room.loopState;
    if (this.room.loop.kind !== 'interval' || !state || state.stoppedReason || state.nextAt === undefined) return;
    this.loopTimer = this.clock.setTimeout(() => this.tick(), Math.max(0, state.nextAt - this.clock.now()));
  }
  private tick(): void {
    this.loopTimer = undefined;
    const state = this.room.loopState, loop = this.room.loop;
    if (!state || loop.kind !== 'interval' || state.stoppedReason) return;
    if (this.running || this.room.status !== 'idle') {
      this.log('Loop run skipped · the room is busy');
      state.nextAt = this.clock.now() + loop.everyMinutes * 60000; this.scheduleLoop(); return;
    }
    const cap = this.capReason(true);
    if (cap) { this.stopLoop(cap); return; }
    if (!this.room.agents.some(a => a.enabled)) { this.stopLoop('no agent is turned on'); return; }
    if (!this.room.agents.some(a => a.enabled && this.available(a))) { this.stopLoop('no agent is available'); return; }
    const text = loop.prompt?.trim() || this.latestUser()?.text;
    if (!text) { this.stopLoop('there is no message to repeat'); return; }
    state.iteration++; delete state.nextAt;
    const trigger = message('user', text.slice(0, 24000), 'Loop');
    trigger.createdAt = this.clock.now();
    this.room.messages.push(trigger);
    this.newPass(trigger, []);
    void this.launch().catch(() => {});
  }

  // ── Turns ─────────────────────────────────────────────────────────────────
  /** `override.model` runs this turn with another model (a team stage's preset); the agent's own model does not change. */
  private turn(agent: Agent, contextRoom: Room, spec: TurnSpec, handoffFrom?: string, override?: { model?: string }): Promise<Message> {
    const driver = this.options.native(agent);
    return driver ? this.nativeTurn(agent, driver, contextRoom, spec, handoffFrom, undefined, override) : this.legacyTurn(agent, contextRoom, spec, handoffFrom, override);
  }
  private purpose(spec: TurnSpec, command?: { name: string }): string {
    switch (spec.kind) {
      case 'step': return ` · step ${spec.step!.id}`;
      case 'plan': return ' · planning';
      case 'synthesis': return ' · final answer';
      case 'direct': return ' · 1:1';
      case 'handoff': return ` · asked by ${spec.handoff?.from ?? 'a teammate'}`;
      case 'command': return ` · /${command?.name ?? 'command'}`;
      case 'stage': return ` · ${spec.stage?.name ?? 'stage'}`;
      case 'merge': return ' · merging';
      default: return '';
    }
  }
  private answerFor(agent: Agent, spec: TurnSpec, handoffFrom?: string): Message {
    const answer = message('agent', '', agent.name, agent.id);
    answer.createdAt = this.clock.now(); answer.status = 'streaming'; answer.turn = spec.kind;
    if (spec.kind === 'step' && spec.step) answer.step = { id: spec.step.id, plan: spec.flow?.planId, task: spec.step.task, after: spec.step.after };
    if (spec.kind === 'stage' && spec.stage) answer.stage = { index: spec.stage.index, total: spec.stage.total, name: spec.stage.name, ...(spec.stage.lead ? { lead: true } : {}) };
    if (handoffFrom) answer.handoff = { from: handoffFrom, to: [agent.id] };
    return answer;
  }
  /** Inactivity timer: re-armed by every sink event, suspended while an approval is pending. */
  private watchdog(agent: Agent, controller: AbortController): Watchdog {
    let handle: unknown, suspended = 0, done = false;
    const seconds = () => Math.round(this.options.timeoutMs() / 1000);
    const arm = () => {
      this.clock.clearTimeout(handle); handle = undefined;
      if (!done && !suspended) handle = this.clock.setTimeout(() => controller.abort(new Error(`No activity from ${agent.name} for ${seconds()} s. Increase chatroom.turnTimeoutSeconds if needed.`)), this.options.timeoutMs());
    };
    return {
      arm, get done() { return done; },
      suspend: () => { suspended++; arm(); },
      resume: () => { suspended = Math.max(0, suspended - 1); arm(); },
      end: () => { done = true; this.clock.clearTimeout(handle); handle = undefined; }
    };
  }
  /** One writer at a time: agents that edit without asking (auto-edit, full access, a writable Codex sandbox) wait for each other. */
  private async writerLock(agent: Agent, signal: AbortSignal): Promise<(() => void) | undefined> {
    const permission = agent.options?.permission, sandbox = agent.provider === 'codex' && permission !== 'plan' ? agent.options?.sandbox : undefined;
    if (permission !== 'auto-edit' && permission !== 'full' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') return;
    const previous = this.writer;
    let release!: () => void;
    this.writer = new Promise<void>(resolve => release = resolve);
    if (this.writers++ > 0) { this.state(agent.id, 'queued', 'Waiting for another agent to finish editing'); this.changed(); }
    const done = () => { this.writers--; release(); };
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error('Stopped.'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        void previous.then(() => { signal.removeEventListener('abort', onAbort); resolve(); });
      });
    } catch (error) { void previous.then(done); throw error; }
    return done;
  }
  /** Waits for a driver, but never longer than a grace period after an abort. */
  private bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let grace: unknown;
      const onAbort = () => { grace = this.clock.setTimeout(() => reject(signal.reason ?? new Error('Stopped.')), ABORT_GRACE_MS); };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => { this.clock.clearTimeout(grace); signal.removeEventListener('abort', onAbort); });
    });
  }
  private approval(agent: Agent, request: ApprovalRequest, signals: AbortSignal[], timer: Watchdog): Promise<ApprovalDecision> {
    const now = this.clock.now(), timeoutMs = Math.max(1000, this.options.approvalTimeoutMs());
    const info: ApprovalInfo = { kind: request.kind, tool: String(request.tool ?? 'tool'), title: String(request.title ?? 'Permission request').slice(0, 500),
      ...(request.detail ? { detail: String(request.detail).slice(0, 8000) } : {}), ...(request.diff ? { diff: String(request.diff).slice(0, 8000) } : {}),
      canAllowSession: !!request.canAllowSession, id: randomUUID(), agentId: agent.id, provider: agent.provider, status: 'pending', createdAt: now, expiresAt: now + timeoutMs };
    const card = message('approval', info.title, agent.name, agent.id);
    card.createdAt = now; card.approval = info;
    this.room.messages.push(card);
    this.state(agent.id, 'approval', info.title); timer.suspend(); this.changed();
    return new Promise<ApprovalDecision>(resolve => {
      let settled = false, expiry: unknown;
      const finish = (status: ApprovalInfo['status'], decision: ApprovalDecision) => {
        if (settled) return;
        settled = true; info.status = status; info.decidedAt = this.clock.now();
        this.clock.clearTimeout(expiry); this.approvals.delete(info.id);
        for (const signal of signals) signal.removeEventListener('abort', onAbort);
        timer.resume();
        if (!timer.done && ![...this.approvals.values()].some(p => p.agentId === agent.id)) this.state(agent.id, 'thinking');
        this.log(`${agent.name}: ${info.title} → ${decision.decision === 'deny' ? 'Denied' : 'Allowed'}`);
        resolve(decision);
      };
      const onAbort = () => finish('cancelled', { decision: 'deny', message: 'The request was cancelled.' });
      this.approvals.set(info.id, { agentId: agent.id, finish });
      expiry = this.clock.setTimeout(() => finish('expired', { decision: 'deny', message: 'No response from the user in time.' }), timeoutMs);
      for (const signal of signals) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
  decide(approvalId: string, decision: ApprovalDecision): boolean {
    const pending = this.approvals.get(approvalId), kind = decision?.decision;
    if (!pending || (kind !== 'allow' && kind !== 'allow-session' && kind !== 'deny')) return false;
    const message = typeof decision.message === 'string' && decision.message.trim() ? decision.message.trim().slice(0, 2000) : undefined;
    pending.finish(kind === 'allow' ? 'allowed' : kind === 'allow-session' ? 'allowed-session' : 'denied', { decision: kind, ...(message ? { message } : {}) });
    return true;
  }
  private upsertActivity(answer: Message, item: ActivityItem): void {
    const list = answer.activity ??= [];
    const entry = { ...item, at: item.at ?? this.clock.now() }, index = list.findIndex(a => a.id === item.id);
    if (index >= 0) list[index] = { ...list[index]!, ...entry }; else list.push(entry);
    while (list.length > MAX_ACTIVITY) {
      const old = list.findIndex(a => a.status !== 'running');
      list.splice(old >= 0 ? old : 0, 1);
    }
  }
  private async nativeTurn(agent: Agent, driver: NativeDriver, contextRoom: Room, spec: TurnSpec, handoffFrom?: string, command?: { name: string; args: string }, override?: { model?: string }): Promise<Message> {
    const model = override?.model || agent.model;
    const id = agent.id, controller = new AbortController(), signal = controller.signal, timer = this.watchdog(agent, controller);
    this.controllers.set(id, controller); this.state(id, 'thinking');
    const answer = this.answerFor(agent, spec, handoffFrom), purpose = this.purpose(spec, command), isolation = this.options.isolation;
    let release: (() => void) | undefined, isolated = !!agent.worktree;
    try {
      // An isolated agent works in its own worktree (made on its first such turn) and edits without waiting for the others.
      if (isolation && !command && (agent.worktree || isolation.wants(agent, this.room, spec.kind))) {
        if (!agent.worktree) { this.state(id, 'thinking', 'Setting up its own worktree'); this.changed(); }
        try { await isolation.prepare(this.room, agent); isolated = !!agent.worktree; }
        catch (error) { isolated = false; this.log(`${agent.name} can't use its own worktree · it works in the shared folder (${errorText(error)})`, 'error'); }
      }
      const folder = isolated ? agent.worktree?.path : undefined;
      // The driver gets a shallow copy with the override model; sink, session, usage and state keep writing to the real agent.
      const runAgent = model !== agent.model ? { ...agent, model } : agent;
      release = isolated ? undefined : await this.writerLock(agent, signal);
      this.state(id, 'thinking');
      const framing = this.options.framing(agent, this.room, false), maxChars = this.options.contextTokens() * 3;
      let context = '', ask = '', fullContext = () => '', editor: EditorSnapshot | undefined, flags: TurnFlags = {}, seen: string | undefined;
      if (!command) {
        // A native session lives in the folder it started in: another folder means a new session with the room history.
        const moved = !!isolation && !!agent.session?.id && agent.session.cwd !== folder;
        if (moved) {
          this.log(folder ? `${agent.name} works in its own worktree from now on · new session with the room history` : `${agent.name} is back in the shared folder · new session with the room history`);
          const kept = { ...agent.session };
          for (const key of ['id', 'cost', 'context', 'startedAt'] as const) delete kept[key];
          agent.session = kept;
        }
        const session = agent.session, trigger = spec.trigger;
        const entries = session && !moved ? unseenEntries(contextRoom, agent, spec) : boundedHistory(contextRoom, agent, this.options.contextTokens(), spec);
        seen = contextRoom.messages.at(-1)?.id;
        const unseen = !!trigger && entries.some(m => m.id === trigger.id);
        const rest = unseen ? entries.filter(m => m.id !== trigger!.id) : entries;
        const update = session?.id && framingHash(framing) !== session.framingHash ? roomUpdate(framing) : '';
        // The delta goes whole: seen moves past it, so anything cut here would never reach the session.
        const deltaChars = rest.reduce((n, m) => n + renderEntry(m, this.room).length + 2, 0);
        context = [update, rest.length ? renderContext(rest, this.room, Math.min(MAX_DELTA_CHARS, Math.max(maxChars, deltaChars))) : ''].filter(Boolean).join('\n\n');
        fullContext = () => renderContext(boundedHistory(contextRoom, agent, this.options.contextTokens(), spec).filter(m => !(unseen && m.id === trigger!.id)), this.room, maxChars);
        const briefing = unseen && trigger!.kind === 'user' ? this.briefing?.text ?? '' : '';
        ask = [unseen ? renderEntry(trigger!, this.room) : '', turnAsk(agent, this.room, spec), briefing].filter(Boolean).join('\n\n');
        if (unseen) { editor = trigger!.editor; if (spec.kind !== 'handoff' && trigger!.flags) flags = { ...trigger!.flags }; }
      }
      this.room.messages.push(answer); timer.arm();
      this.log(`${agent.name} started${purpose} · ${model || 'default model'}`);
      const touch = () => timer.arm();
      const sink: TurnSink = {
        text: full => { if (timer.done) return; answer.text = display(String(full ?? '')); touch(); this.changed(); },
        thinking: full => { if (timer.done) return; answer.thinking = String(full ?? '').slice(-20000); touch(); this.changed(); },
        activity: item => {
          if (timer.done || !item || typeof item.id !== 'string') return;
          this.upsertActivity(answer, item);
          if (this.room.agentStates?.[id]?.status !== 'approval') this.state(id, item.status === 'running' ? 'tool' : 'thinking', item.status === 'running' ? item.title : undefined);
          touch(); this.changed();
        },
        approval: (request, driverSignal) => { touch(); return this.approval(agent, request, driverSignal && driverSignal !== signal ? [signal, driverSignal] : [signal], timer); },
        session: patch => { agent.session = { ...agent.session, ...patch, provider: agent.provider, lastUsedAt: this.clock.now() }; touch(); this.changed(); },
        capabilities: caps => { this.options.capabilities?.(agent, caps); touch(); },
        options: patch => {
          // A CLI may lower its own permission, or leave plan mode after an approved plan; it never raises itself.
          const { permission, exitPlan, ...rest } = patch ?? {};
          Object.assign(agent.options, rest);
          const allowed = !!permission && !!PERMISSION_LABELS[permission] && (rank(permission) < rank(agent.options.permission) || (!!exitPlan && agent.options.permission === 'plan' && permission === 'ask'));
          if (permission && allowed) {
            agent.options.permission = permission; this.log(`${agent.name} switched to ${PERMISSION_LABELS[permission]}`);
          }
          touch(); this.changed();
        }
      };
      const result = await this.bounded(driver.turn({ room: this.room, agent: runAgent, kind: spec.kind, framing, context, fullContext, ask, editor, flags, ...(command ? { command } : {}), signal, sink }), signal);
      timer.end();
      answer.text = String(result?.text || answer.text || '').slice(0, 100000);
      const usage = result?.usage ?? emptyUsage();
      answer.usage = usage; this.room.usage[id] = addUsage(this.room.usage[id] ?? emptyUsage(), usage);
      const delivered = () => {
        const seenId = spec.kind === 'step' && spec.flow?.planId ? spec.flow.planId : seen;
        agent.session = { ...agent.session, ...(seenId ? { seen: seenId } : {}), framingHash: framingHash(framing), provider: agent.provider, lastUsedAt: this.clock.now() };
        if (isolation) { if (folder) agent.session.cwd = folder; else delete agent.session.cwd; }
      };
      if (result?.status === 'interrupted') {
        // Stopped after the CLI received the input (it says so, or the model already answered): its session holds it, so later turns must not send it again.
        if (!command && (result.delivered || answer.text.trim() || answer.thinking)) delivered();
        return this.cancelled(agent, answer, signal);
      }
      if (command && !answer.text.trim()) answer.text = `/${command.name} finished.`;
      this.complete(agent, answer, spec, purpose);
      if (!command) delivered();
    } catch (error) {
      this.failed(agent, answer, signal, error);
    } finally {
      timer.end(); release?.();
      // A completed turn in a worktree becomes a commit on the agent's branch (finishMerge commits a merge turn).
      if (isolated && isolation && !command && spec.kind !== 'merge' && answer.status === 'complete' && agent.worktree) {
        try { await isolation.checkpoint(this.room, agent, `turn ${this.room.completedTurns}${purpose}`); this.integrationDue = true; }
        catch (error) { this.log(`${agent.name}'s work could not be saved in its worktree · ${errorText(error)}`, 'error'); }
      }
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      this.changed();
    }
    return answer;
  }
  private complete(agent: Agent, answer: Message, spec: TurnSpec, purpose: string): void {
    if (spec.kind === 'plan' || (spec.kind === 'synthesis' && !spec.teamPlan)) {
      const parsed = parsePlan(answer.text, this.room.agents.filter(a => a.enabled));
      if (parsed) { answer.text = parsed.text; if (parsed.steps.length) answer.plan = parsed.steps; parsed.notes.forEach(note => this.log(note)); }
    }
    if (!answer.text.trim() && !answer.plan && !answer.activity?.length) throw new Error('The agent returned an empty answer.');
    answer.status = 'complete'; this.room.completedTurns++; this.state(agent.id, 'complete'); delete agent.unavailable;
    const marker = spec.kind === 'command' ? undefined : markerOf(answer.text);
    if (marker) answer.marker = marker;
    const usage = answer.usage ?? emptyUsage();
    this.log(`${agent.name} finished${purpose} · ${usage.input + usage.output} ${usage.estimated ? 'estimated ' : ''}tokens`);
  }
  private cancelled(agent: Agent, answer: Message, signal: AbortSignal): Message {
    const reason = signal.aborted ? errorText(signal.reason ?? 'Stopped.') : 'Interrupted.';
    answer.status = 'cancelled'; answer.text = answer.text ? `${answer.text}\n\n${reason}` : reason;
    this.state(agent.id, 'stopped', reason);
    this.queue = this.queue.filter(item => item.id !== agent.id);
    this.log(`${agent.name}: ${reason}`, /No activity/.test(reason) ? 'error' : 'info');
    return answer;
  }
  private failed(agent: Agent, answer: Message, signal: AbortSignal, error: unknown): void {
    if (!this.room.messages.includes(answer)) {
      if (signal.aborted) { answer.status = 'cancelled'; this.state(agent.id, 'stopped'); return; }
      this.room.messages.push(answer);
    }
    if (signal.aborted) { this.cancelled(agent, answer, signal); return; }
    const detail = errorText(error);
    answer.status = 'error'; answer.text = answer.text ? `${answer.text}\n\n${detail}` : detail;
    this.state(agent.id, 'error', detail);
    this.queue = this.queue.filter(item => item.id !== agent.id);
    this.log(`${agent.name}: ${detail}`, 'error');
    if (error instanceof ProviderError && error.extra?.action) this.notice(error.message);
    // Out of usage, signed out, model not available, Ollama not running: mark the agent and continue without it (not a failed run).
    const mark = classifyUnavailable(error, agent, this.clock.now());
    if (!mark) return;
    agent.unavailable = mark; this.blocked.add(answer);
    const text = unavailableText(mark, this.clock.now());
    this.state(agent.id, 'unavailable', text);
    this.notice(`${agent.name} can't run right now (${text}) · continuing without it.`);
    // This notice already covers the next pass's skip.
    this.lastSkipKey = [...this.lastSkipKey.split('|').filter(k => k && !k.startsWith(`${agent.id}:`)), skipKey(agent, mark)].sort().join('|');
  }
  private async legacyTurn(agent: Agent, contextRoom: Room, spec: TurnSpec, handoffFrom?: string, override?: { model?: string }): Promise<Message> {
    const model = override?.model || agent.model, runAgent = model !== agent.model ? { ...agent, model } : agent;
    const id = agent.id, controller = new AbortController(), signal = controller.signal, timer = this.watchdog(agent, controller);
    this.controllers.set(id, controller); this.state(id, 'thinking');
    const answer = this.answerFor(agent, spec, handoffFrom), purpose = this.purpose(spec);
    let aggregate = emptyUsage(), pendingInput: string | undefined;
    try {
      const provider = this.options.providers[agent.provider];
      if (!provider) throw new Error(`${PROVIDER_LABELS[agent.provider]} is not available. Refresh connections and try again.`);
      const system = legacySystem(this.options.framing(agent, this.room, true), agent, this.room);
      const context = legacyContext(contextRoom, agent, this.options.contextTokens(), { ...spec, briefing: this.briefing?.text }, system);
      this.room.messages.push(answer); timer.arm();
      this.log(`${agent.name} started${purpose} · ${model || 'client default'}`);
      if (context.omitted) this.log(`Context bounded · ${context.omitted} earlier messages omitted for ${agent.name}`);
      const editor = spec.trigger?.editor ? `\n\n${plainEditorText(spec.trigger.editor)}` : '';
      let prompt = context.prompt + editor, continuation: unknown, toolResults: { call: ToolCall; output: string }[] | undefined, toolCount = 0, wrapUp = false;
      for (let step = 0; step <= 8; step++) {
        signal.throwIfAborted();
        // Over the limit mid-turn: let the agent answer from what it already has instead of discarding the turn.
        if (step > 0 && !wrapUp && overLimit(this.room)) {
          wrapUp = true; this.log(`${agent.name} is finishing its answer · this message reached its token limit`);
          prompt += '\n\n[This message has reached the user\'s token limit. Do not request any more tools. Give your answer now, using only the results above.]';
        }
        pendingInput = system + prompt;
        this.state(id, 'thinking'); timer.arm();
        const result = await this.bounded(provider.run({ agent: runAgent, system, prompt, signal, continuation, toolResults, allowTools: toolCount < 8 && !wrapUp,
          onText: text => { if (timer.done) return; answer.text = display(text); timer.arm(); this.changed(); }, onActivity: text => { timer.arm(); this.log(text, 'tool'); } }), signal);
        aggregate = addUsage(aggregate, result.usage); pendingInput = undefined; answer.usage = aggregate;
        this.room.usage[id] = addUsage(this.room.usage[id] ?? emptyUsage(), result.usage);
        signal.throwIfAborted();
        const legacyCall = result.toolCalls?.length ? undefined : parseToolCall(result.text);
        const calls = result.toolCalls?.length ? result.toolCalls : legacyCall ? [legacyCall] : [];
        if (!calls.length) { answer.text = result.text.slice(0, 100000); break; }
        if (wrapUp) throw new Error('This message reached its token limit and the agent still asked for tools. Resume or raise the limit in Usage to let it continue.');
        if (toolCount + calls.length > 8 || step === 8) throw new Error('Tool limit reached (8 calls per turn). Ask a more focused question.');
        continuation = result.toolCalls?.length ? result.continuation : undefined; toolResults = [];
        for (const call of calls) {
          signal.throwIfAborted(); toolCount++;
          this.state(id, 'tool', call.name); this.log(`${agent.name} → ${call.name}`, 'tool');
          let output: string;
          try {
            if (!agent.tools.includes(call.name)) throw new Error(`Tool ${call.name} is disabled for this agent.`);
            output = await this.options.tools(call, agent, signal);
            timer.arm();
          } catch (error) { signal.throwIfAborted(); output = `Tool error: ${errorText(error)}`; }
          signal.throwIfAborted();
          const tool = message('tool', output.slice(0, 16000), call.name, id); tool.createdAt = this.clock.now();
          this.room.messages.splice(this.room.messages.indexOf(answer), 0, tool);
          toolResults.push({ call, output: output.slice(0, 10000) });
          if (!continuation) prompt += `\n\n[Your tool request]\n${JSON.stringify(call)}\n\n[Untrusted tool result: ${call.name}]\n${output.slice(0, 10000)}\n\nUse this result to continue. Tool calls remaining: ${8 - toolCount}.`;
        }
        const limit = Math.max(4000, (this.options.contextTokens() - Math.ceil(system.length / 3)) * 3);
        if (prompt.length > limit) prompt = prompt.slice(0, 2500) + '\n[Middle context omitted]\n' + prompt.slice(-(limit - 2600));
        answer.text = ''; this.changed();
      }
      timer.end();
      this.complete(agent, answer, spec, purpose);
    } catch (error) {
      if (pendingInput !== undefined) {
        const partial = estimatedUsage(pendingInput, answer.text); aggregate = addUsage(aggregate, partial); answer.usage = aggregate;
        this.room.usage[id] = addUsage(this.room.usage[id] ?? emptyUsage(), partial);
      }
      this.failed(agent, answer, signal, error);
    } finally {
      timer.end();
      if (this.controllers.get(id) === controller) this.controllers.delete(id);
      this.changed();
    }
    return answer;
  }

  // ── Sessions and native commands ──────────────────────────────────────────
  async resetSession(agentIds: string[], mode: 'forget' | 'fresh'): Promise<void> {
    if (this.running) throw new Error('Wait for the agents to finish or press Stop.');
    const last = this.room.messages.at(-1)?.id;
    for (const id of agentIds) {
      const agent = this.room.agents.find(a => a.id === id);
      if (!agent) continue;
      // forget (/clear): a new native session that receives nothing from before this point.
      agent.session = mode === 'fresh' ? undefined : { provider: agent.provider, ...(last ? { seen: last } : agent.session?.seen ? { seen: agent.session.seen } : {}) };
      await this.options.native(agent)?.release(this.room.id, agent.id).catch(error => this.log(`${agent.name}: ${errorText(error)}`, 'error'));
    }
    this.changed();
  }
  runAgentCommand(agentIds: string[], name: string, args: string, text?: string): Promise<void> {
    if (this.running) return Promise.reject(new Error('Wait for the agents to finish or press Stop.'));
    const agents = [...new Set(agentIds)].map(id => this.room.agents.find(a => a.id === id)).filter((a): a is Agent => !!a);
    if (!agents.length) return Promise.reject(new Error(`No agent to run /${name}.`));
    if (text?.trim()) {
      const line = message('user', text.trim().slice(0, 24000)); line.createdAt = this.clock.now(); line.turn = 'command'; line.targets = agents.map(a => a.id);
      this.room.messages.push(line);
    }
    this.pauseRequested = false; this.stopping = false; this.room.status = 'running'; this.room.agentStates = {};
    for (const agent of agents) this.state(agent.id, 'queued');
    const pending = [...agents], workers = Math.max(1, Math.min(4, this.room.concurrency ?? 3));
    this.running = Promise.all(Array.from({ length: workers }, async () => {
      while (pending.length && !this.stopping) {
        const agent = pending.shift()!, driver = this.options.native(agent);
        if (!driver) { this.notice(`${agent.name} uses a chat model without native commands.`); this.state(agent.id, 'complete'); continue; }
        await this.nativeTurn(agent, driver, this.room, { kind: 'command' }, undefined, { name, args: args ?? '' });
      }
    })).then(() => { if (this.room.status === 'running') this.room.status = 'idle'; }, error => { this.room.status = 'idle'; this.log(errorText(error), 'error'); })
      .finally(() => { this.running = undefined; this.controllers.clear(); this.changed(); });
    this.changed(); return this.running;
  }
}
