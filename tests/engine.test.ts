import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomEngine, EngineOptions, Clock } from '../src/engine';
import { createRoom, roomFraming, DEFAULT_LOOP, patchLoop } from '../src/core';
import { parseLoop } from '../src/commands';
import { Agent, AgentCapabilities, ApprovalDecision, LoopConfig, NativeDriver, NativeTurnRequest, NativeTurnResult, Provider, ProviderError, ProviderRequest, Room, emptyUsage } from '../src/types';
import { waitFor } from './helpers';

const usage = { ...emptyUsage(), input: 30, output: 10, requests: 1 };
type Reply = string | Partial<NativeTurnResult>;
/** Records every native turn; `script` answers it. New sessions get an id, as real drivers report. */
class FakeDriver implements NativeDriver {
  readonly provider = 'claude' as const;
  calls: NativeTurnRequest[] = [];
  released: string[] = [];
  constructor(private readonly script: (req: NativeTurnRequest, n: number) => Reply | Promise<Reply>) {}
  async turn(req: NativeTurnRequest): Promise<NativeTurnResult> {
    this.calls.push(req);
    if (!req.command && !req.agent.session?.id) req.sink.session({ id: `${req.agent.name}-${this.calls.length}` });
    const out = await this.script(req, this.calls.length), reply = typeof out === 'string' ? { text: out } : out;
    return { text: reply.text ?? '', usage: reply.usage ?? usage, status: reply.status ?? 'complete', ...(reply.delivered !== undefined ? { delivered: reply.delivered } : {}) };
  }
  async capabilities(): Promise<AgentCapabilities> { throw new Error('not used'); }
  async release(roomId: string, agentId?: string): Promise<void> { this.released.push(`${roomId}/${agentId ?? '*'}`); }
  async dispose(): Promise<void> {}
  of(name: string) { return this.calls.filter(c => c.agent.name === name); }
}
function fakeClock(): Clock & { advance(ms: number): void; pending(): number } {
  let now = 1_000_000, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { timers.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimeout: handle => { timers.delete(handle as number); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size
  };
}
function nativeEngine(script: (req: NativeTurnRequest, n: number) => Reply | Promise<Reply>, extra: Partial<EngineOptions> = {}, room: Room = createRoom()) {
  const driver = new FakeDriver(script);
  const engine = new RoomEngine(room, { providers: {}, native: () => driver, tools: async () => '', framing: (agent, target, legacy) => roomFraming(agent, target, { connections: [], caps: {}, legacy }),
    contextTokens: () => 12000, timeoutMs: () => 5000, approvalTimeoutMs: () => 60000, maxHandoffs: () => 6, changed: () => {}, ...extra });
  return { engine, driver, room, agents: room.agents as [Agent, Agent, Agent] };
}
function legacyEngine(provider: Provider, tools = async () => 'Tool content', extra: Partial<EngineOptions> = {}) {
  return new RoomEngine(createRoom(), { providers: { codex: provider, claude: provider, copilot: provider, ollama: provider }, native: () => undefined, tools,
    framing: (agent, target, legacy) => roomFraming(agent, target, { connections: [], caps: {}, legacy }),
    contextTokens: () => 12000, timeoutMs: () => 5000, approvalTimeoutMs: () => 60000, maxHandoffs: () => 6, changed: () => {}, ...extra });
}
const loop = (patch: Partial<LoopConfig>): LoopConfig => ({ ...DEFAULT_LOOP, ...patch });
const seenBy = (req: NativeTurnRequest) => req.context + '\n' + req.ask;
const count = (text: string, part: string) => text.split(part).length - 1;
const plan = (steps: { id: string; agent: string; task: string; after?: string[] }[], intro = 'Splitting this up.') =>
  `${intro}\n<chatroom-plan>${JSON.stringify({ steps: steps.map(s => ({ after: [], ...s })) })}</chatroom-plan>`;

test('relay delivers only unseen messages: the trigger in the ask, other replies once, never the agent\'s own', async () => {
  const { engine, driver, agents } = nativeEngine((req, n) => `${req.agent.name} reply ${n}`);
  await engine.start('First');
  const [codex1, claude1, copilot1] = driver.calls;
  assert.equal(codex1!.context, '');
  assert.equal(codex1!.ask, '<room from="User">\nFirst\n</room>\n\nIt\'s your turn (relay): respond to the latest request and build on the replies above.');
  assert.match(claude1!.context, /^<room from="Codex">\nCodex reply 1\n<\/room>$/);
  assert.match(copilot1!.context, /Codex reply 1[\s\S]*Claude reply 2/);
  assert.match(codex1!.framing, /^You are Codex, one of the AI agents in Chatroom/);
  await engine.start('Second');
  const [codex2, claude2, copilot2] = driver.calls.slice(3);
  assert.match(codex2!.ask, /^<room from="User">\nSecond\n<\/room>/);
  assert.match(codex2!.context, /Claude reply 2[\s\S]*Copilot reply 3/); assert.doesNotMatch(codex2!.context, /First|Codex reply/);
  assert.match(claude2!.context, /Copilot reply 3[\s\S]*Codex reply 4/); assert.doesNotMatch(claude2!.context, /Codex reply 1|Claude reply/);
  assert.match(copilot2!.context, /Codex reply 4[\s\S]*Claude reply 5/);
  for (const name of ['Codex', 'Claude', 'Copilot']) {
    const received = driver.of(name).map(seenBy).join('\n');
    assert.equal(count(received, `${name} reply`), 0, `${name} never receives its own replies`);
    for (const m of engine.room.messages.filter(m => m.kind === 'agent' && m.author !== name)) assert.ok(count(received, m.text) <= 1, `${name} receives "${m.text}" at most once`);
    assert.equal(count(received, 'First'), 1); assert.equal(count(received, 'Second'), 1);
  }
  const lastCodex = engine.room.messages.filter(m => m.agentId === agents[0].id).at(-1)!;
  assert.equal(agents[0].session!.seen, engine.room.messages[engine.room.messages.indexOf(lastCodex) - 1]!.id);
  assert.equal(agents[0].session!.id, 'Codex-1'); assert.equal(agents[0].session!.provider, 'codex');
  assert.equal(engine.room.status, 'idle'); assert.equal(engine.room.completedTurns, 6);
});
test('a new session gets the bounded history once; /clear (forget) delivers nothing older; fresh starts over', async () => {
  const { engine, driver, agents, room } = nativeEngine((req, n) => `${req.agent.name} reply ${n}`);
  agents[1].enabled = false; agents[2].enabled = false;
  await engine.start('Old question');
  await engine.start('Follow-up');
  assert.doesNotMatch(driver.calls[1]!.context, /Old question/);
  await engine.resetSession([agents[0].id], 'forget');
  assert.equal(agents[0].session!.id, undefined); assert.deepEqual(driver.released, [`${room.id}/${agents[0].id}`]);
  await engine.start('After clear');
  assert.equal(driver.calls[2]!.context, ''); assert.doesNotMatch(driver.calls[2]!.ask, /Old question|Follow-up/);
  assert.match(driver.calls[2]!.ask, /After clear/);
  await engine.resetSession([agents[0].id], 'fresh');
  assert.equal(agents[0].session, undefined);
  await engine.start('Fresh start');
  assert.match(driver.calls[3]!.context, /Old question[\s\S]*Follow-up[\s\S]*After clear/);
  assert.match(driver.calls[3]!.fullContext(), /Old question/);
});
test('a framing change reaches an existing session as a room update', async () => {
  const { engine, driver, agents } = nativeEngine(req => `${req.agent.name} ok`);
  agents[2].enabled = false;
  await engine.start('One');
  agents[1].role = 'Security review';
  await engine.start('Two');
  const claude = driver.of('Claude').at(-1)!;
  assert.match(claude.context, /^<room from="Chatroom">Room update:\nIn the room:[\s\S]*Your focus in this room: Security review<\/room>/);
  assert.doesNotMatch(driver.of('Codex').at(-1)!.context, /Room update/);
});
test('direct targets run in mention order whatever the mode, with the trigger as the whole ask', async () => {
  const { engine, driver, agents } = nativeEngine(req => `${req.agent.name} here`);
  engine.room.mode = 'orchestrated'; engine.room.loop = loop({ kind: 'rounds', rounds: 3 });
  await engine.start({ text: 'Hello', targets: [agents[2].id, agents[0].id], flags: { think: true } });
  assert.deepEqual(driver.calls.map(c => [c.agent.name, c.kind]), [['Copilot', 'direct'], ['Codex', 'direct']]);
  assert.equal(driver.calls[0]!.ask, '<room from="User" to="Copilot, Codex">\nHello\n</room>');
  assert.deepEqual(driver.calls[0]!.flags, { think: true });
  assert.equal(engine.room.messages[0]!.targets!.length, 2);
  await assert.rejects(engine.start({ text: 'x', targets: ['nobody'] }), /disabled/);
});
test('the editor snapshot and flags go only to agents that have not seen the trigger', async () => {
  const editor = { path: '/w/a.ts', relPath: 'a.ts', label: 'a.ts', kind: 'text' as const, openTabs: [], key: '/w/a.ts#' };
  const { engine, driver, agents } = nativeEngine(req => req.agent.name === 'Codex' && driver.calls.length === 1 ? '@Claude please look' : 'ok');
  agents[2].enabled = false;
  engine.room.loop = loop({ kind: 'rounds', rounds: 2 });
  await engine.start({ text: 'Check', editor, flags: { ultra: true } });
  assert.deepEqual(driver.calls.map(c => [c.agent.name, c.kind, !!c.editor, !!c.flags.ultra]), [['Codex', 'discussion', true, true], ['Claude', 'handoff', true, false], ['Codex', 'discussion', false, false], ['Claude', 'discussion', false, false]]);
});
test('an @mention hands the next turn to that agent, merging its pending turn, with the exact ask', async () => {
  const { engine, driver, agents } = nativeEngine((req, n) => n === 1 ? 'Looks fine.\n@Claude check this' : `${req.agent.name} done`);
  await engine.start('Review');
  assert.deepEqual(driver.calls.map(c => [c.agent.name, c.kind]), [['Codex', 'discussion'], ['Claude', 'handoff'], ['Copilot', 'discussion']]);
  assert.equal(driver.calls[1]!.ask, '<room from="User">\nReview\n</room>\n\nCodex mentioned you: "check this"');
  const codexAnswer = engine.room.messages.find(m => m.agentId === agents[0].id)!;
  assert.deepEqual(codexAnswer.handoff, { from: agents[0].id, to: [agents[1].id] });
  const claudeAnswer = engine.room.messages.find(m => m.agentId === agents[1].id)!;
  assert.equal(claudeAnswer.turn, 'handoff'); assert.deepEqual(claudeAnswer.handoff, { from: agents[0].id, to: [agents[1].id] });
});
test('hand-offs stop at the hop cap, and self-mentions and mentions in code are ignored', async () => {
  const { engine, driver } = nativeEngine((req, n) => req.agent.name === 'Codex' ? `@Claude your turn ${n}\n@Codex note to self` : req.agent.name === 'Claude' ? `@Codex back to you ${n}\n\`\`\`\n@Copilot not this\n\`\`\`` : 'ok', { maxHandoffs: () => 3 });
  await engine.start('Ping pong');
  assert.deepEqual(driver.calls.map(c => [c.agent.name, c.kind]), [['Codex', 'discussion'], ['Claude', 'handoff'], ['Codex', 'handoff'], ['Claude', 'handoff'], ['Copilot', 'discussion']]);
  assert.ok(engine.room.activity.some(a => a.text === 'Hand-off limit reached'));
  assert.equal(engine.room.activity.filter(a => a.text === 'Hand-off limit reached').length, 1);
});
test('parallel hand-offs wait until the round has finished', async () => {
  const { engine, driver } = nativeEngine(async req => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return req.agent.name === 'Codex' && req.kind === 'discussion' ? '@Copilot verify this' : `${req.agent.name} ok`;
  });
  engine.room.mode = 'parallel'; engine.room.concurrency = 3;
  await engine.start('Compare');
  assert.deepEqual(driver.calls.map(c => [c.agent.name, c.kind]), [['Codex', 'discussion'], ['Claude', 'discussion'], ['Copilot', 'discussion'], ['Copilot', 'handoff']]);
  for (const call of driver.calls.slice(0, 3)) assert.doesNotMatch(call.context, /ok|verify/);
  assert.match(driver.calls[3]!.context, /Codex[\s\S]*verify this|Claude ok/);
});
test('team: mention lines become parallel steps with exact asks, steps stay isolated, and the next turn still gets sibling outputs', async () => {
  const { engine, driver, agents } = nativeEngine(async req => {
    if (req.kind === 'plan') return 'I will split this.\n@Claude find risks\n@Copilot list APIs';
    if (req.kind === 'synthesis') return 'Final answer';
    if (req.kind === 'step') { await new Promise(resolve => setTimeout(resolve, 5)); return `${req.agent.name} output${req.agent.name === 'Claude' ? '\n@Copilot can you help' : ''}`; }
    return `${req.agent.name} relay`;
  });
  engine.room.mode = 'orchestrated'; engine.room.leadId = agents[0].id;
  await engine.start('Build a feature');
  assert.deepEqual(driver.calls.map(c => c.kind), ['plan', 'step', 'step', 'synthesis']);
  assert.match(driver.calls[0]!.ask, /You're leading this request/);
  const claudeStep = driver.of('Claude')[0]!, copilotStep = driver.of('Copilot')[0]!;
  assert.equal(claudeStep.ask, '<room from="User">\nBuild a feature\n</room>\n\nCodex asked you (step s1): find risks Do just this part; Codex will combine the results.');
  assert.match(claudeStep.context, /<room from="Codex" kind="plan">\nI will split this\.\n@Claude find risks\n@Copilot list APIs\n\[Plan\]\ns1 · Claude: find risks\ns2 · Copilot: list APIs\n<\/room>/);
  assert.doesNotMatch(claudeStep.context, /Copilot output/); assert.doesNotMatch(copilotStep.context, /Claude output/);
  const synthesis = driver.calls[3]!;
  assert.match(synthesis.context, /Claude output[\s\S]*Copilot output/); assert.doesNotMatch(synthesis.context, /I will split this/);
  assert.equal(engine.room.messages.at(-1)!.turn, 'synthesis');
  assert.ok(engine.room.activity.some(a => a.text === 'Claude mentioned Copilot; in Team mode the lead coordinates.'));
  const planMessage = engine.room.messages.find(m => m.turn === 'plan')!;
  assert.equal(agents[1].session!.seen, planMessage.id, 'step agents keep their place at the plan');
  engine.room.mode = 'sequential';
  await engine.start('Next');
  const claudeNext = driver.of('Claude').at(-1)!;
  assert.match(claudeNext.context, /Copilot output[\s\S]*Final answer[\s\S]*Codex relay/);
  assert.doesNotMatch(claudeNext.context, /Claude output|I will split this/);
  assert.equal(count(driver.of('Copilot').map(seenBy).join('\n'), 'Claude output'), 1);
});
test('a <chatroom-plan> still works: dependent steps see only their inputs, the lead answers last', async () => {
  let active = 0, peak = 0;
  const { engine, driver } = nativeEngine(async req => {
    peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (req.kind === 'plan') return plan([{ id: 's1', agent: 'Claude', task: 'Find the risks' }, { id: 's2', agent: 'copilot', task: 'List the APIs' }, { id: 's3', agent: 'Codex', task: 'Design using both', after: ['s1', 's2'] }]);
    if (req.kind === 'synthesis') return 'Final combined answer';
    return `${req.agent.name} output for ${/step (s\d)/.exec(req.ask)?.[1]}`;
  });
  engine.room.mode = 'orchestrated'; engine.room.leadId = engine.room.agents[0]!.id;
  await engine.start('Build a feature');
  assert.equal(driver.calls.length, 5); assert.equal(peak, 2);
  const step = (id: string) => driver.calls.find(c => c.kind === 'step' && c.ask.includes(`(step ${id})`))!;
  assert.doesNotMatch(step('s1').context, /output for s2/); assert.doesNotMatch(step('s2').context, /output for s1/);
  assert.match(step('s3').context, /Claude output for s1[\s\S]*Copilot output for s2/);
  assert.match(step('s3').ask, /Codex asked you \(step s3\): Design using both It builds on step s1, s2 above\./);
  const planMessage = engine.room.messages.find(m => m.turn === 'plan')!;
  assert.equal(planMessage.text, 'Splitting this up.'); assert.deepEqual(planMessage.plan!.map(s => s.status), ['complete', 'complete', 'complete']);
  assert.equal(engine.room.messages.at(-1)!.text, 'Final combined answer'); assert.equal(engine.room.flow, undefined); assert.equal(engine.room.queuedTurns, 0);
});
test('a lead answers simple messages itself; a failed step skips its dependents', async () => {
  const simple = nativeEngine(() => 'Just the answer');
  simple.engine.room.mode = 'orchestrated'; simple.engine.room.leadId = simple.agents[1].id;
  await simple.engine.start('Hi there');
  assert.deepEqual(simple.driver.calls.map(c => c.agent.name), ['Claude']); assert.equal(simple.engine.room.messages.at(-1)!.turn, 'synthesis');
  const { engine, driver } = nativeEngine(req => {
    if (req.kind === 'plan') return plan([{ id: 's1', agent: 'Claude', task: 'A' }, { id: 's2', agent: 'Copilot', task: 'B', after: ['s1'] }, { id: 's3', agent: 'Codex', task: 'C' }]);
    if (req.ask.includes('(step s1)')) throw new Error('Login required');
    return 'ok';
  });
  engine.room.mode = 'orchestrated';
  await engine.start('Work');
  assert.equal(driver.calls.length, 4);
  assert.deepEqual(engine.room.messages.find(m => m.plan)!.plan!.map(s => s.status), ['error', 'skipped', 'complete']);
});
test('the lead can delegate another wave only while loop rounds remain', async () => {
  for (const rounds of [1, 2]) {
    let syntheses = 0;
    const { engine, driver } = nativeEngine(req => {
      if (req.kind === 'plan') return plan([{ id: 's1', agent: 'Claude', task: 'A' }]);
      if (req.kind === 'synthesis') return ++syntheses === 1 ? '@Copilot check A' : 'Done';
      return 'ok';
    });
    engine.room.mode = 'orchestrated'; engine.room.loop = loop({ kind: rounds > 1 ? 'rounds' : 'once', rounds });
    await engine.start('Work');
    assert.equal(syntheses, rounds); assert.equal(driver.calls.filter(c => c.kind === 'step').length, rounds);
    if (rounds === 2) assert.match(driver.calls.find(c => c.kind === 'synthesis')!.ask, /\(1 more round allowed\)/);
  }
});
test('approvals: a pending card that Allow resolves, and a second decision is refused', async () => {
  let decision: ApprovalDecision | undefined;
  const { engine, agents } = nativeEngine(async req => {
    decision = await req.sink.approval({ kind: 'command', tool: 'Bash', title: 'npm test', detail: 'in /w', canAllowSession: true }, req.signal);
    return 'Tests pass';
  });
  agents[1].enabled = false; agents[2].enabled = false;
  const run = engine.start('Run the tests');
  const card = await waitFor(() => engine.room.messages.find(m => m.kind === 'approval'));
  assert.equal(card.approval!.status, 'pending'); assert.equal(card.approval!.agentId, agents[0].id); assert.equal(card.text, 'npm test');
  assert.equal(engine.room.agentStates![agents[0].id]!.status, 'approval');
  assert.equal(engine.decide(card.approval!.id, { decision: 'allow-session' }), true);
  await run;
  assert.deepEqual(decision, { decision: 'allow-session' }); assert.equal(card.approval!.status, 'allowed-session');
  assert.equal(engine.decide(card.approval!.id, { decision: 'deny' }), false);
  assert.ok(engine.room.activity.some(a => a.text === 'Codex: npm test → Allowed'));
  assert.equal(engine.room.messages.find(m => m.kind === 'agent')!.text, 'Tests pass');
});
test('approvals time out to deny, and the inactivity timer waits while one is pending', async () => {
  const clock = fakeClock();
  let decision: ApprovalDecision | undefined, aborted = false;
  const { engine, agents } = nativeEngine(async req => {
    req.signal.addEventListener('abort', () => aborted = true);
    decision = await req.sink.approval({ kind: 'edit', tool: 'Edit', title: 'Edit a.ts', canAllowSession: false }, req.signal);
    return 'Gave up';
  }, { clock, timeoutMs: () => 5000, approvalTimeoutMs: () => 60000 });
  agents[1].enabled = false; agents[2].enabled = false;
  const run = engine.start('Edit it');
  const card = await waitFor(() => engine.room.messages.find(m => m.kind === 'approval'));
  assert.equal(card.approval!.expiresAt - card.approval!.createdAt, 60000);
  clock.advance(30000);
  assert.equal(aborted, false, 'waiting for the user does not count as inactivity');
  clock.advance(30000);
  await run;
  assert.deepEqual(decision, { decision: 'deny', message: 'No response from the user in time.' });
  assert.equal(card.approval!.status, 'expired'); assert.equal(aborted, false);
  assert.equal(engine.room.messages.at(-1)!.status, 'complete');
});
test('stop cancels a pending approval and the turn', async () => {
  let decision: ApprovalDecision | undefined;
  const { engine, agents } = nativeEngine(async req => {
    decision = await req.sink.approval({ kind: 'network', tool: 'WebFetch', title: 'Fetch example.com', canAllowSession: false }, req.signal);
    return { text: 'partial', status: 'interrupted' };
  });
  agents[1].enabled = false; agents[2].enabled = false;
  const run = engine.start('Fetch');
  const card = await waitFor(() => engine.room.messages.find(m => m.kind === 'approval'));
  engine.stop(); await run;
  assert.equal(card.approval!.status, 'cancelled'); assert.equal(decision!.decision, 'deny');
  const answer = engine.room.messages.find(m => m.kind === 'agent')!;
  assert.equal(answer.status, 'cancelled'); assert.match(answer.text, /^partial\n\nStopped by you\.$/);
  assert.equal(engine.room.status, 'idle');
});
test('an inactivity timeout interrupts the turn and cancels its message', async () => {
  const clock = fakeClock();
  const { engine, agents } = nativeEngine(req => new Promise(resolve => {
    req.sink.text('Working on it');
    req.signal.addEventListener('abort', () => resolve({ text: 'Working on it', status: 'interrupted' }));
  }), { clock, timeoutMs: () => 5000 });
  agents[1].enabled = false; agents[2].enabled = false;
  const run = engine.start('Slow task');
  await waitFor(() => engine.room.messages.find(m => m.kind === 'agent' && m.text));
  clock.advance(4000);
  assert.equal(engine.room.messages.at(-1)!.status, 'streaming');
  clock.advance(1000);
  await run;
  const answer = engine.room.messages.at(-1)!;
  assert.equal(answer.status, 'cancelled');
  assert.match(answer.text, /No activity from Codex for 5 s\. Increase chatroom\.turnTimeoutSeconds if needed\./);
  assert.equal(agents[0].session!.seen, engine.room.messages.find(m => m.kind === 'user')!.id, 'the CLI answered, so its session holds the input: seen advances');
});
test('a stopped turn advances seen only when the CLI received its input, so a stopped request is never sent again', async () => {
  for (const delivered of [true, false]) {
    const { engine, driver, agents } = nativeEngine((req, n) => n === 1
      ? new Promise(resolve => req.signal.addEventListener('abort', () => resolve({ text: '', status: 'interrupted', delivered })))
      : `${req.agent.name} reply ${n}`);
    agents[1].enabled = false; agents[2].enabled = false;
    const run = engine.start('Count slowly to 200'); await waitFor(() => driver.calls.length === 1); engine.stop(); await run;
    await engine.start('What is 2+2?');
    const next = seenBy(driver.calls[1]!);
    assert.equal(count(next, 'Count slowly to 200'), delivered ? 0 : 1, `delivered=${delivered}`);
    assert.match(next, /What is 2\+2\?/);
  }
});
test('a provider error with an action posts a notice; other agents continue', async () => {
  const { engine } = nativeEngine(req => {
    if (req.agent.name === 'Copilot') throw new ProviderError('Sign in to the GitHub Copilot CLI: run "copilot login" in a terminal, then try again.', 'signed-out', { action: 'copilotLogin' });
    return 'Answer';
  });
  await engine.start('Help');
  assert.equal(engine.room.completedTurns, 2);
  const notice = engine.room.messages.find(m => m.kind === 'notice')!;
  assert.match(notice.text, /copilot login/); assert.equal(notice.author, 'Chatroom');
  assert.equal(engine.room.messages.find(m => m.author === 'Copilot')!.status, 'error');
});
test('loops: N rounds use the round ask; consensus stops on [AGREE]; lead-done stops on [DONE]', async () => {
  const rounds = nativeEngine(req => `${req.agent.name} idea`);
  rounds.engine.room.loop = loop({ kind: 'rounds', rounds: 3 });
  await rounds.engine.start('Brainstorm');
  assert.equal(rounds.driver.calls.length, 9);
  assert.equal(rounds.driver.calls[3]!.ask, 'Round 2 of 3: keep going — respond to what\'s new above. It\'s your turn (relay, round 2 of 3): respond to the latest request and build on the replies above.');
  assert.match(rounds.driver.calls[3]!.context, /Claude idea[\s\S]*Copilot idea/);
  assert.equal(rounds.engine.room.loopState, undefined);

  const consensus = nativeEngine((req, n) => n > 3 ? 'Nothing to add. [AGREE]' : `${req.agent.name} view`);
  consensus.engine.room.loop = loop({ kind: 'consensus', maxIterations: 5 });
  await consensus.engine.start('Agree on a name');
  assert.equal(consensus.driver.calls.length, 6);
  assert.match(consensus.driver.calls[0]!.ask, /end your reply with \[AGREE\]\.$/);
  assert.equal(consensus.engine.room.messages.at(-1)!.marker, 'agree');

  const done = nativeEngine((req, n) => req.agent.name === 'Claude' && n > 3 ? 'Shipped. [DONE]' : 'working');
  done.engine.room.leadId = done.agents[1].id; done.engine.room.loop = loop({ kind: 'lead-done', maxIterations: 5 });
  await done.engine.start('Ship it');
  assert.equal(done.driver.calls.length, 6);
  assert.match(done.driver.of('Claude')[0]!.ask, /\[DONE\]\.$/); assert.doesNotMatch(done.driver.of('Codex')[0]!.ask, /\[DONE\]/);
});
test('loops: the iteration, time and token caps stop the loop with a logged reason', async () => {
  const iterations = nativeEngine(() => 'still thinking');
  iterations.engine.room.loop = loop({ kind: 'consensus', maxIterations: 2 });
  await iterations.engine.start('Debate');
  assert.equal(iterations.driver.calls.length, 6);
  assert.equal(iterations.engine.room.loopState!.stoppedReason, 'reached 2 runs');
  assert.ok(iterations.engine.room.activity.some(a => a.text === 'Loop stopped: reached 2 runs'));

  const clock = fakeClock();
  const minutes = nativeEngine(() => { clock.advance(25_000); return 'more'; }, { clock });
  minutes.engine.room.loop = loop({ kind: 'consensus', maxIterations: 50, maxMinutes: 1 });
  await minutes.engine.start('Debate');
  assert.equal(minutes.driver.calls.length, 3);
  assert.match(minutes.engine.room.loopState!.stoppedReason!, /1-minute limit/);

  const tokens = nativeEngine(() => 'more');
  tokens.engine.room.loop = loop({ kind: 'consensus', maxIterations: 50, maxTokens: 100 });
  await tokens.engine.start('Debate');
  assert.equal(tokens.driver.calls.length, 3);
  assert.ok(tokens.engine.room.activity.some(a => a.text === 'Loop stopped: reached the 100-token limit'));
});
test('loops: an interval loop posts a Loop message on schedule until its cap, and stop clears the timer', async () => {
  const clock = fakeClock();
  const { engine, driver } = nativeEngine(req => `${req.agent.name} status`, { clock });
  engine.room.agents.slice(1).forEach(a => a.enabled = false);
  engine.room.loop = loop({ kind: 'interval', everyMinutes: 10, maxIterations: 2 });
  await engine.start('Check the build');
  assert.equal(driver.calls.length, 1); assert.equal(engine.room.status, 'idle');
  assert.equal(engine.room.loopState!.nextAt, clock.now() + 600000);
  clock.advance(600000);
  await waitFor(() => driver.calls.length === 2); await engine.whenIdle();
  const tick = engine.room.messages.filter(m => m.kind === 'user').at(-1)!;
  assert.equal(tick.author, 'Loop'); assert.equal(tick.text, 'Check the build');
  assert.match(driver.calls[1]!.ask, /^<room from="User">\nCheck the build\n<\/room>/);
  assert.equal(engine.room.loopState!.stoppedReason, 'reached 2 runs'); assert.equal(clock.pending(), 0);

  const second = nativeEngine(() => 'ok', { clock });
  second.engine.room.loop = loop({ kind: 'interval', everyMinutes: 5, maxIterations: 9, prompt: 'Any news?' });
  await second.engine.start('Watch');
  assert.ok(clock.pending() > 0);
  second.engine.stop();
  assert.equal(second.engine.room.loopState, undefined); assert.equal(clock.pending(), 0);
  clock.advance(3_600_000);
  assert.equal(second.driver.calls.length, 3);
});
test('loops: "/loop every 1h" and "every 30m" run to their iteration cap instead of stopping at the default time cap', async () => {
  for (const [every, runs] of [['1h', 2], ['30m', 5]] as const) {
    const clock = fakeClock();
    const { engine, driver, agents } = nativeEngine(() => { clock.advance(20_000); return 'checked'; }, { clock });
    agents[1].enabled = false; agents[2].enabled = false;
    const parsed = parseLoop(`every ${every} check CI`);
    engine.room.loop = patchLoop(engine.room.loop, { ...parsed.loop!, prompt: parsed.prompt ?? '' });
    if (every === '1h') engine.room.loop = patchLoop(engine.room.loop, { maxIterations: 2 });
    assert.equal(engine.room.loop.maxMinutes, 0, every);
    await engine.start({ text: 'check CI' });
    for (let i = 0; i < 6; i++) { clock.advance(engine.room.loop.everyMinutes * 60_000); await engine.whenIdle(); await new Promise(resolve => setImmediate(resolve)); await engine.whenIdle(); }
    assert.equal(driver.calls.length, runs, every);
  }
  // An explicit cap is kept, and caps that leave room for every run are not touched.
  assert.equal(patchLoop(DEFAULT_LOOP, { kind: 'interval', everyMinutes: 60, maxMinutes: 60 }).maxMinutes, 60);
  assert.equal(patchLoop(DEFAULT_LOOP, { kind: 'interval', everyMinutes: 10 }).maxMinutes, 60);
  assert.equal(patchLoop(DEFAULT_LOOP, { kind: 'consensus' }).maxMinutes, 60);
});
test('one writer at a time: auto-edit agents never overlap, ask agents do', async () => {
  for (const permission of ['auto-edit', 'ask'] as const) {
    let active = 0, peak = 0;
    const { engine } = nativeEngine(async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return 'ok'; });
    engine.room.mode = 'parallel'; engine.room.concurrency = 3;
    engine.room.agents.forEach(a => a.options.permission = permission);
    await engine.start('Edit files');
    assert.equal(peak, permission === 'ask' ? 3 : 1, permission);
    assert.equal(engine.room.completedTurns, 3);
  }
});
test('native commands post the command line, run per agent, and do not advance seen', async () => {
  const { engine, driver, agents } = nativeEngine(req => req.command ? `Compacted ${req.agent.name}` : 'ok');
  agents[2].enabled = false;
  await engine.start('Hello');
  const seen = agents[0].session!.seen;
  await engine.runAgentCommand([agents[0].id, agents[1].id], 'compact', 'keep the API notes', '/compact keep the API notes');
  const commands = driver.calls.filter(c => c.command);
  assert.deepEqual(commands.map(c => [c.agent.name, c.command!.name, c.command!.args, c.context, c.ask, c.fullContext()]), [['Codex', 'compact', 'keep the API notes', '', '', ''], ['Claude', 'compact', 'keep the API notes', '', '', '']]);
  const line = engine.room.messages.find(m => m.text === '/compact keep the API notes')!;
  assert.equal(line.kind, 'user'); assert.equal(line.turn, 'command');
  assert.deepEqual(engine.room.messages.filter(m => m.turn === 'command' && m.kind === 'agent').map(m => m.text), ['Compacted Codex', 'Compacted Claude']);
  assert.equal(agents[0].session!.seen, seen);
  await engine.start('Next');
  assert.doesNotMatch(driver.of('Codex').at(-1)!.context, /Compacted|\/compact/);
  engine.room.agents[2]!.provider = 'ollama';
  const legacy = new RoomEngine(engine.room, { providers: {}, native: a => a.provider === 'ollama' ? undefined : driver, tools: async () => '', framing: () => '', contextTokens: () => 12000, timeoutMs: () => 5000, approvalTimeoutMs: () => 1000, maxHandoffs: () => 6, changed: () => {} });
  await legacy.runAgentCommand([agents[2].id], 'compact', '');
  assert.equal(engine.room.messages.at(-1)!.text, 'Copilot uses a chat model without native commands.');
});
test('pause finishes the current turn and resume runs the rest; concurrent starts are rejected', async () => {
  const { engine, driver } = nativeEngine(() => { if (driver.calls.length === 1) engine.pause(); return 'Answer'; });
  await engine.start('Discuss'); assert.equal(engine.room.status, 'paused'); assert.equal(driver.calls.length, 1);
  await engine.start(); assert.deepEqual(driver.calls.map(c => c.agent.name), ['Codex', 'Claude', 'Copilot']);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => finish = resolve);
  const busy = nativeEngine(async () => { await gate; return 'Answer'; });
  const first = busy.engine.start('One'); await assert.rejects(busy.engine.start('Two'), /Pause or stop/);
  await assert.rejects(busy.engine.runAgentCommand([busy.agents[0].id], 'compact', ''), /Wait for the agents/);
  finish(); await first;
});
test('stop interrupts the active turn and does not start queued agents', async () => {
  const { engine, driver } = nativeEngine(req => new Promise(resolve => req.signal.addEventListener('abort', () => resolve({ text: '', status: 'interrupted' }))));
  const run = engine.start('Work'); await waitFor(() => driver.calls.length === 1); engine.stop(); await run;
  assert.equal(engine.room.status, 'idle'); assert.equal(driver.calls.length, 1);
  assert.equal(engine.room.messages[1]!.status, 'cancelled'); assert.equal(engine.room.messages[1]!.text, 'Stopped by you.');
});
test('stopping one parallel agent leaves the others running', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const { engine, driver, agents } = nativeEngine(async req => {
    if (req.agent.name === 'Codex') return new Promise(resolve => req.signal.addEventListener('abort', () => resolve({ text: '', status: 'interrupted' })));
    await gate; return 'Answer';
  });
  engine.room.mode = 'parallel'; engine.room.concurrency = 2;
  const run = engine.start('Work'); await waitFor(() => driver.calls.length === 2);
  engine.stopAgent(agents[0].id); release(); await run;
  assert.equal(engine.room.completedTurns, 2); assert.equal(agents[0].enabled, false);
  assert.equal(engine.room.agentStates![agents[0].id]!.status, 'stopped');
});
test('the per-message token limit pauses scheduling and Resume continues', async () => {
  const { engine, driver } = nativeEngine(() => 'Answer');
  engine.room.tokenBudget = 75;
  await engine.start('First'); assert.equal(driver.calls.length, 2); assert.equal(engine.room.status, 'paused');
  assert.match(engine.room.activity.at(-1)!.text, /Paused at your limit of 75 new tokens/);
  await engine.start(); assert.equal(engine.room.completedTurns, 3); assert.equal(engine.room.status, 'idle');
});
test('document context is retrieved once per message and added to each agent\'s ask', async () => {
  let briefings = 0;
  const { engine, driver } = nativeEngine(() => 'ok', { briefing: async () => { briefings++; return '[Room documents · full text]\nThe launch date is May 4.'; } });
  engine.room.documents = [{ id: 'd', name: 'launch.md', hash: 'h', kind: 'text', source: 'attached', status: 'ready', chars: 30, chunks: 1, addedAt: 0 }];
  await engine.start('When do we launch?');
  assert.equal(briefings, 1); assert.equal(driver.calls.length, 3);
  for (const call of driver.calls) assert.match(call.ask, /When do we launch\?[\s\S]*It's your turn[\s\S]*launch date is May 4/);
});
test('parallel rounds share a stable snapshot; the next round sees every reply once', async () => {
  let active = 0, peak = 0;
  const { engine, driver } = nativeEngine(async req => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return `${req.agent.name} contribution`; });
  engine.room.mode = 'parallel'; engine.room.concurrency = 2; engine.room.loop = loop({ kind: 'rounds', rounds: 2 });
  await engine.start('Compare');
  assert.equal(peak, 2); assert.equal(driver.calls.length, 6);
  for (const call of driver.calls.slice(0, 3)) { assert.equal(call.context, ''); assert.match(call.ask, /parallel, round 1 of 2/); }
  for (const call of driver.calls.slice(3)) {
    for (const name of ['Codex', 'Claude', 'Copilot'].filter(n => n !== call.agent.name)) assert.equal(count(call.context, `${name} contribution`), 1);
    assert.doesNotMatch(call.context, new RegExp(`${call.agent.name} contribution`));
  }
  assert.deepEqual(engine.room.activeAgents, []); assert.equal(engine.room.queuedTurns, 0);
});
test('activity, thinking and session patches from the sink update the answer and the agent', async () => {
  const { engine, agents } = nativeEngine(req => {
    req.sink.thinking('Let me look');
    req.sink.activity({ id: 't1', kind: 'command', title: 'npm test', status: 'running', at: 1 });
    req.sink.activity({ id: 't1', kind: 'command', title: 'npm test', detail: 'exit 0', status: 'done', at: 2 });
    req.sink.session({ context: { percent: 12, tokens: 24000, window: 200000 } });
    req.sink.options({ permission: 'full' }); req.sink.options({ permission: 'auto-edit' }); req.sink.options({ permission: 'ask' });
    levels.push(req.agent.options.permission);
    req.sink.options({ permission: 'ask', exitPlan: true });
    levels.push(req.agent.options.permission);
    req.sink.text('Streaming <chatroom-plan>{}');
    return 'All good';
  });
  const levels: string[] = [];
  agents[0].options.permission = 'plan'; agents[1].enabled = false; agents[2].enabled = false;
  await engine.start('Check');
  const answer = engine.room.messages.at(-1)!;
  assert.equal(answer.thinking, 'Let me look'); assert.deepEqual(answer.activity!.map(a => [a.id, a.status, a.detail]), [['t1', 'done', 'exit 0']]);
  assert.equal(agents[0].session!.context!.percent, 12);
  assert.deepEqual(levels, ['plan', 'ask'], 'a CLI never raises its own permission; an approved plan moves plan to ask');
  assert.ok(engine.room.activity.some(a => a.text === 'Codex switched to Ask'));
  // A session allowance that put the CLI in acceptEdits does not raise an Ask agent; a lower mode is kept.
  const asked = nativeEngine(req => { req.sink.options({ permission: 'auto-edit' }); levels.push(req.agent.options.permission); req.sink.options({ permission: 'plan' }); return 'ok'; });
  asked.agents[1].enabled = false; asked.agents[2].enabled = false;
  await asked.engine.start('Edit');
  assert.deepEqual(levels.slice(2), ['ask']); assert.equal(asked.agents[0].options.permission, 'plan');
});
test('team: a lead that cannot run hands the message to the next enabled agent for this pass', async () => {
  const { engine, driver } = nativeEngine(req => {
    if (req.agent.name === 'Codex') throw new ProviderError('Codex usage limit reached. Other agents can continue.', 'usage-limit');
    return req.kind === 'plan' ? 'Claude answers: 4' : 'ok';
  });
  engine.room.mode = 'orchestrated';
  await engine.start('What is 2+2?');
  assert.deepEqual(driver.calls.map(c => `${c.agent.name}:${c.kind}`), ['Codex:plan', 'Claude:plan']);
  assert.equal(engine.room.messages.at(-1)!.text, 'Claude answers: 4'); assert.equal(engine.room.messages.at(-1)!.turn, 'synthesis');
  assert.ok(engine.room.activity.some(a => a.text === 'Codex could not lead this message · Claude takes over'));
  assert.equal(engine.room.leadId, undefined, 'the room keeps its lead');
  const all = nativeEngine(() => { throw new ProviderError('down', 'crashed'); });
  all.engine.room.mode = 'orchestrated';
  await all.engine.start('Hi');
  assert.equal(all.driver.calls.length, 3); assert.equal(all.engine.room.flow, undefined); assert.equal(all.engine.room.status, 'idle');
});
test('a native delta is delivered whole, even beyond the history budget', async () => {
  const body = (tag: string) => `${tag} ` + 'x'.repeat(15_000);
  const { engine, driver, agents } = nativeEngine(req => {
    if (req.kind === 'plan') return plan([{ id: 's1', agent: 'Claude', task: 'a' }, { id: 's2', agent: 'Copilot', task: 'b' }, { id: 's3', agent: 'Claude', task: 'c' }]);
    if (req.kind === 'step') return body(`STEP-${/step (s\d)/.exec(req.ask)![1]}`);
    return 'Final.';
  });
  engine.room.mode = 'orchestrated'; engine.room.leadId = agents[0].id;
  await engine.start('Audit the repo');
  const synthesis = driver.of('Codex').find(c => c.kind === 'synthesis')!;
  for (const tag of ['STEP-s1', 'STEP-s2', 'STEP-s3']) assert.equal(count(synthesis.context, tag), 1, tag);
  assert.doesNotMatch(synthesis.context, /omitted/);
});
test('team: step outputs given to a dependent step are not delivered again', async () => {
  const { engine, driver, agents } = nativeEngine(req => {
    if (req.kind === 'plan') return plan([{ id: 's1', agent: 'Claude', task: 'research' }, { id: 's2', agent: 'Copilot', task: 'build on it', after: ['s1'] }, { id: 's3', agent: 'Codex', task: 'implement', after: ['s1'] }]);
    if (req.kind === 'step') return `${req.agent.name} OUTPUT-${/step (s\d)/.exec(req.ask)![1]}`;
    return req.kind === 'synthesis' ? 'Final.' : `${req.agent.name} relay`;
  });
  engine.room.mode = 'orchestrated'; engine.room.leadId = agents[0].id;
  await engine.start('Build it');
  assert.equal(count(driver.of('Codex').map(seenBy).join('\n'), 'Claude OUTPUT-s1'), 1, 'the lead got s1 in its step, not again in the synthesis');
  assert.match(driver.of('Codex').find(c => c.kind === 'synthesis')!.context, /Copilot OUTPUT-s2/);
  engine.room.mode = 'sequential';
  await engine.start('Next question');
  assert.equal(count(driver.of('Copilot').map(seenBy).join('\n'), 'Claude OUTPUT-s1'), 1, 'Copilot got s1 as its input only');
});
test('one writer at a time also covers a Codex agent whose sandbox override can write', async () => {
  let active = 0, peak = 0;
  const { engine, agents } = nativeEngine(async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return 'edited'; });
  agents[0].options.permission = 'ask'; agents[0].options.sandbox = 'workspace-write';
  agents[1].options.permission = 'auto-edit'; agents[2].enabled = false;
  engine.room.mode = 'parallel';
  await engine.start('Fix both modules');
  assert.equal(peak, 1);
});
test('a new message ends a paused plan; a loop with no agent turned on stops instead of failing', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const { engine, agents } = nativeEngine(async req => {
    if (req.kind === 'plan' && req.ask.includes('First')) return plan([{ id: 's1', agent: 'Claude', task: 'a' }, { id: 's2', agent: 'Copilot', task: 'b', after: ['s1'] }]);
    if (req.kind === 'step') { await gate; return 'step'; }
    return 'answer';
  });
  engine.room.mode = 'orchestrated'; engine.room.leadId = agents[0].id;
  const run = engine.start('First');
  await waitFor(() => engine.room.flow?.phase === 'steps'); engine.pause(); release(); await run;
  assert.equal(engine.room.status, 'paused');
  await engine.start('Second question');
  const old = engine.room.messages.find(m => m.turn === 'plan')!;
  assert.deepEqual(old.plan!.map(s => [s.status, s.detail]), [['complete', undefined], ['skipped', 'Replaced by a new message.']]);
  for (const mode of ['orchestrated', 'sequential'] as const) {
    const clock = fakeClock();
    const looped = nativeEngine(req => `${req.agent.name} ok`, { clock });
    looped.engine.room.mode = mode; looped.engine.room.loop = loop({ kind: 'interval', everyMinutes: 10, maxMinutes: 0 });
    await looped.engine.start('Watch the build');
    for (const agent of looped.agents) agent.enabled = false;
    clock.advance(10 * 60_000); await looped.engine.whenIdle();
    assert.equal(looped.engine.room.messages.filter(m => m.author === 'Loop').length, 0, mode);
    assert.equal(looped.engine.room.loopState!.stoppedReason, 'no agent is turned on', mode);
  }
});

// Legacy providers (Ollama, Copilot through vscode.lm) keep the <chatroom-tool> loop and the bounded transcript.
test('legacy: XML tool results are routed back to the requesting agent and all requests count', async () => {
  let calls = 0, tools = 0;
  const engine = legacyEngine({ run: async req => {
    if (++calls === 1) { assert.match(req.system, /The conversation so far is included below/); assert.match(req.prompt, /<room from="User">\nRead documentation\n<\/room>/); return { text: '<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>', usage }; }
    assert.match(req.prompt, /Tool content/); return { text: 'Done', usage };
  } }, async () => { tools++; return 'Tool content'; });
  engine.room.agents.slice(1).forEach(a => a.enabled = false);
  await engine.start('Read documentation'); assert.equal(calls, 2); assert.equal(tools, 1);
  assert.equal(engine.room.usage[engine.room.agents[0]!.id]!.requests, 2);
  assert.deepEqual(engine.room.messages.map(m => m.kind), ['user', 'tool', 'agent']);
});
test('legacy: native tool calls keep call IDs and continuation; disabled tools return an error', async () => {
  let calls = 0, executed = 0;
  const continuation = [{ role: 'assistant', parts: ['native calls'] }];
  const engine = legacyEngine({ run: async (req: ProviderRequest) => {
    if (++calls === 1) return { text: 'Inspecting', usage, continuation, toolCalls: [{ id: 'call-a', name: 'list_files', arguments: { glob: '**' } }, { id: 'call-b', name: 'read_file', arguments: { path: 'README.md' } }] };
    assert.equal(req.continuation, continuation);
    assert.deepEqual(req.toolResults?.map(t => t.call.id), ['call-a', 'call-b']);
    assert.match(req.toolResults![1]!.output, /disabled for this agent/);
    return { text: 'Verified answer', usage };
  } }, async () => { executed++; return 'Verified files'; });
  engine.room.agents[0]!.tools = ['list_files'];
  await engine.start('Inspect', engine.room.agents[0]!.id);
  assert.equal(calls, 2); assert.equal(executed, 1); assert.equal(engine.room.messages.at(-1)?.text, 'Verified answer');
});
test('legacy: an agent over the limit mid-turn finishes its answer without tools', async () => {
  const requests: ProviderRequest[] = [];
  const engine = legacyEngine({ run: async req => {
    requests.push(req);
    if (requests.length === 1) return { text: '<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>', usage: { ...usage, input: 1000 } };
    return { text: 'Answer from what I read', usage };
  } });
  engine.room.tokenBudget = 500;
  await engine.start('Review');
  assert.equal(requests.length, 2); assert.equal(requests[1]!.allowTools, false); assert.match(requests[1]!.prompt, /Do not request any more tools/);
  assert.equal(engine.room.messages.find(m => m.kind === 'agent')!.text, 'Answer from what I read'); assert.equal(engine.room.status, 'paused');
});
