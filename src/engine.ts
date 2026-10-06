import { randomUUID } from 'node:crypto';
import { Agent, Flow, Message, Provider, ProviderId, Room, ToolCall, addUsage, emptyUsage } from './types';
import { TurnSpec, buildContext, message, parsePlan, parseToolCall, planStages, overLimit, roomFresh, estimatedUsage } from './core';

export interface EngineOptions {
  providers: Record<ProviderId, Provider>;
  tools: (call: ToolCall, agent: Agent, signal: AbortSignal) => Promise<string>;
  /** Optional document retrieval for the latest user message, shared by every turn in a run. */
  briefing?: (room: Room, query: string, signal: AbortSignal) => Promise<string>;
  contextTokens: () => number; timeoutMs: () => number; changed: () => void;
}
interface QueueItem { id: string; round: number; direct?: boolean }
export class RoomEngine {
  private queue: QueueItem[] = [];
  private controllers = new Map<string, AbortController>();
  private pauseRequested = false;
  private stopping = false;
  private running?: Promise<void>;
  private roundContext?: { round: number; room: Room };
  private consensus = new Set<string>();
  private briefing?: { key: string; text: string };
  private briefingController?: AbortController;
  constructor(public room: Room, private readonly options: EngineOptions) {}
  get busy(): boolean { return !!this.running; }
  private changed(): void {
    this.room.activeAgents = [...this.controllers.keys()];
    this.room.currentAgent = this.room.activeAgents[0];
    this.room.queuedTurns = this.queue.length + (this.room.flow?.steps.filter(s => s.status === 'pending').length ?? 0);
    this.options.changed();
  }
  log(text: string, kind: 'info' | 'tool' | 'error' = 'info'): void {
    this.room.activity.push({ id: randomUUID(), text: text.slice(0, 1500), time: Date.now(), kind });
    this.room.activity = this.room.activity.slice(-150); this.changed();
  }
  /** The agent that plans and answers in lead-and-team mode. */
  lead(): Agent | undefined { return this.room.agents.find(a => a.id === this.room.leadId && a.enabled) ?? this.room.agents.find(a => a.enabled); }
  start(text?: string, target?: string): Promise<void> {
    if (this.running) return Promise.reject(new Error('Pause or stop the current run before sending another message.'));
    const agents = this.room.agents.filter(a => a.enabled && (!target || a.id === target));
    if (!agents.length) return Promise.reject(new Error(target ? 'That agent is disabled.' : 'Enable at least one agent.'));
    if (text?.trim()) {
      this.room.messages.push(message('user', text.trim().slice(0, 24000)));
      if (this.room.title === 'New conversation') this.room.title = text.trim().slice(0, 56);
      this.queue = []; this.roundContext = undefined; this.consensus.clear(); this.room.flow = undefined;
    }
    if (!this.room.messages.some(m => m.kind === 'user')) return Promise.reject(new Error('Write a message to start the room.'));
    if (!this.queue.length && !this.room.flow) {
      this.roundContext = undefined; this.consensus.clear(); this.room.agentStates = {};
      if (target) this.queue = [{ id: target, round: 0, direct: true }];
      else if (this.room.mode === 'orchestrated') this.room.flow = { wave: 0, leadId: this.lead()!.id, phase: 'plan', steps: [] };
      else this.queue = Array.from({ length: this.room.rounds }, (_, round) => agents.map(a => ({ id: a.id, round }))).flat();
    }
    for (const { id } of this.queue) (this.room.agentStates ??= {})[id] = { status: 'queued' };
    const flow = this.room.flow;
    if (flow) for (const id of flow.phase === 'steps' ? flow.steps.filter(s => s.status === 'pending').map(s => s.agentId) : [flow.leadId]) (this.room.agentStates ??= {})[id] = { status: 'queued' };
    this.pauseRequested = false; this.stopping = false; this.room.status = 'running'; this.room.runStartTokens = roomFresh(this.room);
    this.running = Promise.resolve().then(() => this.loop()).finally(() => { this.running = undefined; this.controllers.clear(); this.changed(); });
    this.changed(); return this.running;
  }
  pause(): void { if (this.running) { this.pauseRequested = true; this.log('Pause requested · finishing active turns'); } }
  stop(): void {
    this.stopping = true;
    for (const { id } of this.queue) if (!this.controllers.has(id)) (this.room.agentStates ??= {})[id] = { status: 'stopped' };
    for (const step of this.room.flow?.steps ?? []) if (step.status === 'pending') { step.status = 'skipped'; step.detail = 'Stopped by you.'; }
    this.queue = []; this.roundContext = undefined; this.room.flow = undefined;
    this.briefingController?.abort(new Error('Stopped by you.'));
    for (const controller of this.controllers.values()) controller.abort(new Error('Stopped by you.'));
    if (!this.running) this.room.status = 'idle'; this.changed();
  }
  stopAgent(id: string): void {
    const agent = this.room.agents.find(a => a.id === id); if (agent) agent.enabled = false;
    this.queue = this.queue.filter(item => item.id !== id);
    this.controllers.get(id)?.abort(new Error('Agent stopped by you.'));
    (this.room.agentStates ??= {})[id] = { status: 'stopped' }; this.changed();
  }
  private halted(): boolean {
    if (!this.pauseRequested && !overLimit(this.room)) return false;
    if (!this.pauseRequested) this.log(`Paused at your limit of ${this.room.tokenBudget.toLocaleString('en')} new tokens for this message · Resume to continue, or change the limit in Usage`);
    this.room.status = 'paused'; return true;
  }
  private async loop(): Promise<void> {
    try {
      await this.refreshBriefing();
      if (this.room.flow) await this.orchestrate(); else await this.discuss();
      if (this.room.status === 'running') this.room.status = 'idle';
    } catch (error) { this.room.status = 'idle'; this.log(error instanceof Error ? error.message : String(error), 'error'); }
    finally { this.changed(); }
  }
  private async refreshBriefing(): Promise<void> {
    const latest = [...this.room.messages].reverse().find(m => m.kind === 'user'), ready = (this.room.documents ?? []).filter(d => d.status === 'ready');
    if (!this.options.briefing || !latest || !ready.length) { this.briefing = undefined; return; }
    const key = latest.id + ready.map(d => d.hash).join();
    if (this.briefing?.key === key) return;
    const controller = this.briefingController = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Document retrieval timed out.')), 60000);
    try {
      const text = await this.options.briefing(this.room, latest.text, controller.signal);
      this.briefing = { key, text };
      if (text) this.log(`Retrieved passages from ${ready.length} room document${ready.length === 1 ? '' : 's'} for every agent`, 'tool');
    } catch (error) {
      if (this.stopping) return;
      this.briefing = { key, text: '' }; this.log(`Document retrieval skipped · ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally { clearTimeout(timeout); this.briefingController = undefined; }
  }
  private async discuss(): Promise<void> {
    while (this.queue.length && !this.stopping) {
      if (this.halted()) return;
      const round = this.queue[0]!.round;
      const parallel = this.room.mode === 'parallel';
      if (this.roundContext?.round !== round) { this.roundContext = { round, room: structuredClone(this.room) }; this.consensus.clear(); }
      const workers = parallel ? Math.max(1, Math.min(4, this.room.concurrency ?? 3)) : 1;
      // Workers share a round snapshot. The next round sees all completed replies.
      await Promise.all(Array.from({ length: workers }, async () => {
        while (this.queue[0]?.round === round && !this.stopping && !this.pauseRequested && !overLimit(this.room)) {
          const { id, direct } = this.queue.shift()!, agent = this.room.agents.find(a => a.id === id);
          if (!agent?.enabled) { this.changed(); continue; }
          await this.turn(agent, parallel && !direct ? this.roundContext!.room : this.room, { kind: direct ? 'direct' : 'discussion', parallel });
        }
      }));
      const participants = this.room.agents.filter(a => a.enabled && this.room.agentStates?.[a.id]);
      if (!this.queue.some(item => item.round === round) && participants.length && participants.every(a => this.consensus.has(a.id))) {
        this.queue = []; this.log('All active agents reached consensus');
      }
    }
  }
  private async orchestrate(): Promise<void> {
    while (!this.stopping) {
      const flow = this.room.flow;
      if (!flow || this.halted()) return;
      const lead = this.room.agents.find(a => a.id === flow.leadId);
      if (!lead?.enabled) { this.log('The lead agent is disabled · choose another lead and send again', 'error'); this.room.flow = undefined; return; }
      if (flow.phase === 'steps') {
        await this.runSteps(flow);
        if (this.stopping || this.room.flow !== flow) return;
        if (flow.steps.some(s => s.status === 'pending')) {
          if (this.halted()) return;
          for (const step of flow.steps) if (step.status === 'pending') { step.status = 'skipped'; step.detail = 'It could not be scheduled.'; }
        }
        flow.phase = 'synthesis'; (this.room.agentStates ??= {})[lead.id] = { status: 'queued' }; continue;
      }
      const roundsLeft = Math.max(0, this.room.rounds - flow.wave - 1);
      const answer = await this.turn(lead, this.room, { kind: flow.phase, flow, roundsLeft });
      if (this.stopping || this.room.flow !== flow) return;
      if (answer.status !== 'complete') { this.room.flow = undefined; return; }
      if (answer.plan?.length && (flow.phase === 'plan' || roundsLeft > 0)) {
        if (flow.phase === 'synthesis') flow.wave++;
        answer.turn = 'plan'; flow.steps = answer.plan; flow.planId = answer.id; flow.phase = 'steps';
        for (const step of flow.steps) (this.room.agentStates ??= {})[step.agentId] = { status: 'queued' };
        const stages = planStages(flow.steps);
        this.log(`${lead.name} planned ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'} in ${stages.length} stage${stages.length === 1 ? '' : 's'}${stages.some(s => s.length > 1) ? ' · independent steps run in parallel' : ''}`);
        continue;
      }
      if (answer.plan) { delete answer.plan; this.log(`${lead.name} proposed more steps, but the run has no rounds left · raise Rounds to allow another wave`); }
      answer.turn = 'synthesis'; this.room.flow = undefined; return;
    }
  }
  private async runSteps(flow: Flow): Promise<void> {
    const running = new Map<string, Promise<void>>();
    const status = (id: string) => flow.steps.find(s => s.id === id)?.status;
    const limit = Math.max(1, Math.min(4, this.room.concurrency ?? 3));
    while (!this.stopping && this.room.flow === flow) {
      for (const step of flow.steps) {
        if (step.status !== 'pending') continue;
        if (!this.room.agents.find(a => a.id === step.agentId)?.enabled) { step.status = 'skipped'; step.detail = 'Its agent is disabled.'; }
        else if (step.after.some(id => status(id) === 'error' || status(id) === 'skipped')) { step.status = 'skipped'; step.detail = 'A step it builds on did not finish.'; }
      }
      // One turn per agent at a time; dependencies gate the rest.
      const busy = new Set(flow.steps.filter(s => s.status === 'running').map(s => s.agentId));
      for (const step of flow.steps) {
        if (running.size >= limit || this.pauseRequested || overLimit(this.room)) break;
        if (step.status !== 'pending' || busy.has(step.agentId) || !step.after.every(id => status(id) === 'complete')) continue;
        const agent = this.room.agents.find(a => a.id === step.agentId)!;
        step.status = 'running'; busy.add(agent.id);
        running.set(step.id, this.turn(agent, this.room, { kind: 'step', flow, step }).then(answer => {
          step.messageId = answer.id;
          step.status = answer.status === 'complete' ? 'complete' : answer.status === 'cancelled' ? 'skipped' : 'error';
          if (answer.status !== 'complete') step.detail = answer.status === 'cancelled' ? 'Stopped.' : 'The agent failed.';
        }).finally(() => running.delete(step.id)));
      }
      this.changed();
      if (!running.size) return;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
  }
  private async turn(agent: Agent, contextRoom: Room, spec: TurnSpec): Promise<Message> {
    const id = agent.id, controller = new AbortController(), signal = controller.signal;
    this.controllers.set(id, controller); (this.room.agentStates ??= {})[id] = { status: 'thinking' };
    const timeout = setTimeout(() => controller.abort(new Error('Turn timed out. Increase the turn timeout in Settings if needed.')), this.options.timeoutMs());
    const purpose = spec.kind === 'step' ? ` · step ${spec.step!.id}` : spec.kind === 'plan' ? ' · planning' : spec.kind === 'synthesis' ? ' · final answer' : spec.kind === 'direct' ? ' · 1:1' : '';
    this.log(`${agent.name} started${purpose} · ${agent.model || 'client default'}`);
    const context = buildContext(contextRoom, agent, this.options.contextTokens(), { ...spec, briefing: this.briefing?.text });
    const answer = message('agent', '', agent.name, id); answer.status = 'streaming'; answer.turn = spec.kind;
    if (spec.kind === 'step') answer.step = { id: spec.step!.id, plan: spec.flow?.planId, task: spec.step!.task, after: spec.step!.after };
    this.room.messages.push(answer);
    let aggregate = emptyUsage(), pendingInput: string | undefined;
    try {
      if (context.omitted) this.log(`Context bounded · ${context.omitted} earlier messages omitted for ${agent.name}`);
      let prompt = context.prompt, continuation: unknown, toolResults: { call: ToolCall; output: string }[] | undefined, toolCount = 0, wrapUp = false;
      for (let step = 0; step <= 8; step++) {
        signal.throwIfAborted();
        // Over the limit mid-turn: let the agent answer from what it already has instead of discarding the turn.
        if (step > 0 && !wrapUp && overLimit(this.room)) {
          wrapUp = true; this.log(`${agent.name} is finishing its answer · this message reached its token limit`);
          prompt += '\n\n[This message has reached the user\'s token limit. Do not request any more tools. Give your answer now, using only the results above.]';
        }
        pendingInput = context.system + prompt;
        this.room.agentStates![id] = { status: 'thinking' };
        const result = await this.options.providers[agent.provider].run({ agent, system: context.system, prompt, signal, continuation, toolResults, allowTools: toolCount < 8 && !wrapUp,
          onText: text => { answer.text = text.split('<chatroom-tool>')[0]!.split('<chatroom-plan>')[0]!.slice(0, 100000); this.changed(); }, onActivity: text => this.log(text, 'tool') });
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
          this.room.agentStates![id] = { status: 'tool', detail: call.name }; this.log(`${agent.name} → ${call.name}`, 'tool');
          let output: string;
          try {
            if (!agent.tools.includes(call.name)) throw new Error(`Tool ${call.name} is disabled for this agent.`);
            output = await this.options.tools(call, agent, signal);
          } catch (error) { signal.throwIfAborted(); output = `Tool error: ${error instanceof Error ? error.message : String(error)}`; }
          signal.throwIfAborted();
          this.room.messages.splice(this.room.messages.indexOf(answer), 0, message('tool', output.slice(0, 16000), call.name, id));
          toolResults.push({ call, output: output.slice(0, 10000) });
          if (!continuation) prompt += `\n\n[Your tool request]\n${JSON.stringify(call)}\n\n[Untrusted tool result: ${call.name}]\n${output.slice(0, 10000)}\n\nUse this result to continue. Tool calls remaining: ${8 - toolCount}.`;
        }
        const limit = Math.max(4000, (this.options.contextTokens() - Math.ceil(context.system.length / 3)) * 3);
        if (prompt.length > limit) prompt = prompt.slice(0, 2500) + '\n[Middle context omitted]\n' + prompt.slice(-(limit - 2600));
        answer.text = ''; this.changed();
      }
      if (spec.kind === 'plan' || spec.kind === 'synthesis') {
        const parsed = parsePlan(answer.text, this.room.agents.filter(a => a.enabled));
        if (parsed) { answer.text = parsed.text; if (parsed.steps.length) answer.plan = parsed.steps; parsed.notes.forEach(note => this.log(note)); }
      }
      if (!answer.text.trim() && !answer.plan) throw new Error('The agent returned an empty answer.');
      answer.status = 'complete'; this.room.completedTurns++; this.room.agentStates![id] = { status: 'complete' };
      if (spec.kind === 'discussion') { if (/\[CONSENSUS\]\s*$/.test(answer.text)) this.consensus.add(id); else this.consensus.delete(id); }
      this.log(`${agent.name} finished${purpose} · ${aggregate.input + aggregate.output} ${aggregate.estimated ? 'estimated ' : ''}tokens`);
    } catch (error) {
      if (pendingInput !== undefined) {
        const partial = estimatedUsage(pendingInput, answer.text); aggregate = addUsage(aggregate, partial); answer.usage = aggregate;
        this.room.usage[id] = addUsage(this.room.usage[id] ?? emptyUsage(), partial);
      }
      const detail = error instanceof Error ? error.message : String(error);
      answer.status = signal.aborted ? 'cancelled' : 'error';
      answer.text = answer.text ? `${answer.text}\n\n${detail}` : detail;
      this.room.agentStates![id] = { status: signal.aborted ? 'stopped' : 'error', detail }; this.consensus.delete(id);
      this.queue = this.queue.filter(item => item.id !== id);
      this.log(`${agent.name}: ${detail}`, signal.aborted ? 'info' : 'error');
    } finally { clearTimeout(timeout); this.controllers.delete(id); this.changed(); }
    return answer;
  }
}
