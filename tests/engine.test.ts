import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomEngine, EngineOptions } from '../src/engine';
import { createRoom } from '../src/core';
import { Provider, ProviderRequest, emptyUsage } from '../src/types';

const usage = { ...emptyUsage(), input: 30, output: 10, requests: 1 };
function engineWith(provider: Provider, tools = async () => 'Tool content', extra: Partial<EngineOptions> = {}) {
  const room = createRoom();
  return new RoomEngine(room, { providers: { codex: provider, claude: provider, copilot: provider, ollama: provider }, tools, contextTokens: () => 12000, timeoutMs: () => 5000, changed: () => {}, ...extra });
}
const plan = (steps: { id: string; agent: string; task: string; after?: string[] }[], intro = 'Splitting this up.') =>
  `${intro}\n<chatroom-plan>${JSON.stringify({ steps: steps.map(s => ({ after: [], ...s })) })}</chatroom-plan>`;
const isPlanning = (req: ProviderRequest) => /You are the lead for the user's latest message/.test(req.system);
const isSynthesis = (req: ProviderRequest) => /Your team has finished the steps/.test(req.system);
const stepOf = (req: ProviderRequest) => /\[Your assignment · step (\w+)\]/.exec(req.prompt)?.[1];
test('round robin passes earlier replies to later agents and honors round limits', async () => {
  const calls: ProviderRequest[] = [];
  const engine = engineWith({ run: async req => { calls.push(req); return { text: `${req.agent.name} contribution`, usage }; } });
  engine.room.rounds = 2;
  await engine.start('Design a system');
  assert.equal(calls.length, 6); assert.match(calls[1]!.prompt, /Codex contribution/);
  assert.match(calls[2]!.prompt, /Claude contribution/); assert.equal(engine.room.completedTurns, 6); assert.equal(engine.room.status, 'idle');
});
test('a user can target exactly one agent', async () => {
  const calls: string[] = [];
  const engine = engineWith({ run: async req => { calls.push(req.agent.name); return { text: 'Answer', usage }; } });
  await engine.start('Review this', engine.room.agents[1]!.id);
  assert.deepEqual(calls, ['Claude']);
});
test('pause finishes current turn and resume preserves the remaining queue', async () => {
  const calls: string[] = [];
  const engine = engineWith({ run: async req => { calls.push(req.agent.name); if (calls.length === 1) engine.pause(); return { text: 'Answer', usage }; } });
  await engine.start('Discuss'); assert.equal(engine.room.status, 'paused'); assert.equal(calls.length, 1);
  await engine.start(); assert.deepEqual(calls, ['Codex', 'Claude', 'Copilot']);
});
test('stop cancels an active request and does not start queued agents', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  const engine = engineWith({ run: req => new Promise((_, reject) => { started(); req.signal.addEventListener('abort', () => reject(req.signal.reason)); }) });
  const run = engine.start('Work'); await ready; engine.stop(); await run;
  assert.equal(engine.room.status, 'idle'); assert.equal(engine.room.messages.filter(m => m.kind === 'agent').length, 1);
  assert.equal(engine.room.messages[1]!.status, 'cancelled');
});
test('a token limit stops scheduling the next request while retaining accounted usage', async () => {
  const engine = engineWith({ run: async () => ({ text: 'Answer', usage }) }); engine.room.tokenBudget = 35;
  await engine.start('Work'); assert.equal(engine.room.completedTurns, 1); assert.equal(engine.room.status, 'paused');
  assert.equal(Object.values(engine.room.usage)[0]!.input, 30);
  assert.match(engine.room.activity.at(-1)!.text, /Paused at your limit of 35 new tokens/);
});
test('there is no token limit by default', async () => {
  const engine = engineWith({ run: async () => ({ text: 'Answer', usage: { ...usage, input: 400000 } }) });
  assert.equal(engine.room.tokenBudget, 0);
  await engine.start('Work'); assert.equal(engine.room.completedTurns, 3); assert.equal(engine.room.status, 'idle');
});
test('the limit applies per message and Resume allows another run of the same size', async () => {
  const engine = engineWith({ run: async () => ({ text: 'Answer', usage }) }); engine.room.tokenBudget = 75;
  await engine.start('First'); assert.equal(engine.room.completedTurns, 2); assert.equal(engine.room.status, 'paused');
  await engine.start(); assert.equal(engine.room.completedTurns, 3); assert.equal(engine.room.status, 'idle');
  await engine.start('Second'); assert.equal(engine.room.completedTurns, 5, 'Earlier messages do not use up the next one');
});
test('cached re-reads do not count toward the limit', async () => {
  const engine = engineWith({ run: async () => ({ text: 'Answer', usage: { ...emptyUsage(), input: 52500, cached: 37600, output: 300, requests: 1 } }) });
  engine.room.tokenBudget = 50000;
  await engine.start('Work'); assert.equal(engine.room.completedTurns, 3); assert.equal(engine.room.status, 'idle');
});
test('an agent over the limit mid-turn finishes its answer without tools instead of failing', async () => {
  const requests: ProviderRequest[] = [];
  const engine = engineWith({ run: async req => {
    requests.push(req);
    if (requests.length === 1) return { text: '<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>', usage: { ...usage, input: 1000 } };
    return { text: 'Answer from what I read', usage };
  } });
  engine.room.tokenBudget = 500;
  await engine.start('Review');
  assert.equal(requests.length, 2); assert.equal(requests[1]!.allowTools, false);
  assert.match(requests[1]!.prompt, /Do not request any more tools/);
  const answer = engine.room.messages.find(m => m.kind === 'agent')!;
  assert.equal(answer.status, 'complete'); assert.equal(answer.text, 'Answer from what I read');
  assert.equal(engine.room.status, 'paused'); assert.equal(engine.room.completedTurns, 1);
});
test('tool results are routed back to the requesting agent and all requests count', async () => {
  let calls = 0, tools = 0;
  const engine = engineWith({ run: async req => { calls++; if (calls === 1) return { text: '<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>', usage }; assert.match(req.prompt, /Tool content/); return { text: 'Done', usage }; } }, async () => { tools++; return 'Tool content'; });
  engine.room.agents.slice(1).forEach(a => a.enabled = false);
  await engine.start('Read documentation'); assert.equal(calls, 2); assert.equal(tools, 1);
  assert.equal(engine.room.usage[engine.room.agents[0]!.id]!.requests, 2);
  assert.deepEqual(engine.room.messages.map(m => m.kind), ['user', 'tool', 'agent']);
});
test('one provider failure does not prevent the other agents from answering', async () => {
  const engine = engineWith({ run: async req => { if (req.agent.provider === 'codex') throw new Error('Login required'); return { text: 'Answer', usage }; } });
  await engine.start('Help'); assert.equal(engine.room.completedTurns, 2);
  assert.ok(engine.room.activity.some(a => a.text.includes('Login required')));
});
test('consensus ends a multi-round run once all agents agree', async () => {
  const engine = engineWith({ run: async () => ({ text: 'Agreed. [CONSENSUS]', usage }) }); engine.room.rounds = 5;
  await engine.start('Agree'); assert.equal(engine.room.completedTurns, 3);
});
test('concurrent starts are rejected', async () => {
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => finish = resolve);
  const engine = engineWith({ run: async () => { await waiting; return { text: 'Answer', usage }; } });
  const first = engine.start('One'); await assert.rejects(engine.start('Two'), /Pause or stop/); finish(); await first;
});

test('parallel workers enforce the cap and share a stable context per round', async () => {
  const calls: ProviderRequest[] = []; let active = 0, peak = 0;
  const engine = engineWith({ run: async req => {
    calls.push(req); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return { text: `${req.agent.name} contribution`, usage };
  } });
  engine.room.mode = 'parallel'; engine.room.concurrency = 2; engine.room.rounds = 2;
  await engine.start('Compare');
  assert.equal(peak, 2); assert.equal(calls.length, 6);
  for (const req of calls.slice(0, 3)) assert.doesNotMatch(req.prompt, /contribution/);
  for (const req of calls.slice(3)) for (const name of ['Codex', 'Claude', 'Copilot']) assert.match(req.prompt, new RegExp(name + ' contribution'));
  assert.deepEqual(engine.room.activeAgents, []); assert.equal(engine.room.queuedTurns, 0);
});

test('parallel pause drains active turns and preserves queued work for resume', async () => {
  let started!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(r => started = r), gate = new Promise<void>(r => release = r);
  const engine = engineWith({ run: async () => { if (++calls === 2) started(); await gate; return { text: 'Answer', usage }; } });
  engine.room.mode = 'parallel'; engine.room.concurrency = 2;
  const run = engine.start('Work'); await ready;
  assert.equal(engine.room.activeAgents!.length, 2); assert.equal(engine.room.queuedTurns, 1);
  engine.pause(); release(); await run;
  assert.equal(calls, 2); assert.equal(engine.room.status, 'paused'); assert.equal(engine.room.queuedTurns, 1);
  await engine.start(); assert.equal(calls, 3); assert.equal(engine.room.status, 'idle');
});

test('parallel stop aborts every active request and clears the queue', async () => {
  let started!: () => void, calls = 0;
  const ready = new Promise<void>(r => started = r);
  const engine = engineWith({ run: req => new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => reject(req.signal.reason)); if (++calls === 2) started();
  }) });
  engine.room.mode = 'parallel'; engine.room.concurrency = 2;
  const run = engine.start('Work'); await ready; engine.stop(); await run;
  assert.equal(calls, 2); assert.equal(engine.room.queuedTurns, 0); assert.deepEqual(engine.room.activeAgents, []);
  assert.equal(engine.room.messages.filter(m => m.status === 'cancelled').length, 2);
});

test('stopping one parallel agent leaves the others running', async () => {
  let started!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(r => started = r), gate = new Promise<void>(r => release = r);
  const engine = engineWith({ run: async req => {
    calls++; if (calls === 2) started();
    if (req.agent.provider === 'codex') return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)));
    await gate; return { text: 'Answer', usage };
  } });
  engine.room.mode = 'parallel'; engine.room.concurrency = 2;
  const run = engine.start('Work'); await ready; engine.stopAgent(engine.room.agents[0]!.id); release(); await run;
  assert.equal(engine.room.completedTurns, 2); assert.equal(engine.room.agents[0]!.enabled, false);
  assert.equal(engine.room.agentStates![engine.room.agents[0]!.id]!.status, 'stopped');
});

test('native tool calls preserve call IDs, continuation and all results without repeating the prompt', async () => {
  let calls = 0, executed = 0;
  const continuation = [{ role: 'assistant', parts: ['native calls'] }];
  const engine = engineWith({ run: async req => {
    if (++calls === 1) return { text: 'Inspecting', usage, continuation, toolCalls: [
      { id: 'call-a', name: 'list_files', arguments: { glob: '**' } },
      { id: 'call-b', name: 'read_file', arguments: { path: 'README.md' } }
    ] };
    assert.equal(req.continuation, continuation);
    assert.deepEqual(req.toolResults?.map(t => t.call.id), ['call-a', 'call-b']);
    assert.equal(req.toolResults?.[1]?.output, 'Verified files'); assert.doesNotMatch(req.prompt, /Your tool request/);
    return { text: 'Verified answer', usage };
  } }, async () => { executed++; return 'Verified files'; });
  await engine.start('Inspect', engine.room.agents[0]!.id);
  assert.equal(calls, 2); assert.equal(executed, 2); assert.equal(engine.room.messages.at(-1)?.text, 'Verified answer');
});

test('XML tool action after a preamble executes; disabled tools return an error to the provider', async () => {
  let calls = 0, executed = 0;
  const engine = engineWith({ run: async req => {
    if (++calls === 1) return { text: 'I will inspect this.\n\n<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>', usage };
    assert.match(req.prompt, /disabled for this agent/); return { text: 'Read tool unavailable.', usage };
  } }, async () => { executed++; return ''; });
  engine.room.agents[0]!.tools = [];
  await engine.start('Read', engine.room.agents[0]!.id); assert.equal(calls, 2); assert.equal(executed, 0);
});

test('lead plans a step graph: independent steps run in parallel, dependent steps see only their inputs, the lead answers last', async () => {
  const calls: ProviderRequest[] = []; let active = 0, peak = 0;
  const engine = engineWith({ run: async req => {
    calls.push(req); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (isPlanning(req)) return { text: plan([{ id: 's1', agent: 'Claude', task: 'Find the risks' }, { id: 's2', agent: 'copilot', task: 'List the APIs' }, { id: 's3', agent: 'Codex', task: 'Design using both', after: ['s1', 's2'] }]), usage };
    if (isSynthesis(req)) return { text: 'Final combined answer', usage };
    return { text: `${req.agent.name} output for ${stepOf(req)}`, usage };
  } });
  engine.room.mode = 'orchestrated'; engine.room.leadId = engine.room.agents[0]!.id;
  await engine.start('Build a feature');
  assert.equal(calls.length, 5); assert.equal(peak, 2); assert.equal(calls[0]!.agent.name, 'Codex');
  const step = (id: string) => calls.find(c => stepOf(c) === id)!;
  assert.doesNotMatch(step('s1').prompt, /output for s2/); assert.doesNotMatch(step('s2').prompt, /output for s1/);
  assert.match(step('s3').prompt, /Claude output for s1/); assert.match(step('s3').prompt, /Copilot output for s2/);
  assert.match(step('s3').prompt, /\[Plan\]\ns1 · Claude: Find the risks/); assert.match(step('s3').system, /plan by Codex, the lead/);
  assert.ok(isSynthesis(calls[4]!)); assert.match(calls[4]!.prompt, /Codex output for s3/);
  const planMessage = engine.room.messages.find(m => m.turn === 'plan')!;
  assert.equal(planMessage.text, 'Splitting this up.'); assert.deepEqual(planMessage.plan!.map(s => s.status), ['complete', 'complete', 'complete']);
  assert.equal(engine.room.messages.at(-1)!.turn, 'synthesis'); assert.equal(engine.room.messages.at(-1)!.text, 'Final combined answer');
  assert.equal(engine.room.flow, undefined); assert.equal(engine.room.status, 'idle'); assert.equal(engine.room.queuedTurns, 0);
});

test('a lead answers simple messages itself without delegating', async () => {
  const calls: string[] = [];
  const engine = engineWith({ run: async req => { calls.push(req.agent.name); return { text: 'Just the answer', usage }; } });
  engine.room.mode = 'orchestrated'; engine.room.leadId = engine.room.agents[1]!.id;
  await engine.start('Hi there');
  assert.deepEqual(calls, ['Claude']); assert.equal(engine.room.messages.at(-1)!.turn, 'synthesis'); assert.equal(engine.room.flow, undefined);
});

test('a failed step skips the steps that build on it, and the lead still answers', async () => {
  const calls: string[] = [];
  const engine = engineWith({ run: async req => {
    calls.push(stepOf(req) ?? (isPlanning(req) ? 'plan' : 'final'));
    if (isPlanning(req)) return { text: plan([{ id: 's1', agent: 'Claude', task: 'A' }, { id: 's2', agent: 'Copilot', task: 'B', after: ['s1'] }, { id: 's3', agent: 'Codex', task: 'C' }]), usage };
    if (stepOf(req) === 's1') throw new Error('Login required');
    return { text: 'ok', usage };
  } });
  engine.room.mode = 'orchestrated';
  await engine.start('Work');
  assert.deepEqual(calls.sort(), ['final', 'plan', 's1', 's3']);
  assert.deepEqual(engine.room.messages.find(m => m.plan)!.plan!.map(s => s.status), ['error', 'skipped', 'complete']);
});

test('an agent with two independent steps runs them one at a time', async () => {
  const running = new Set<string>(); let overlap = false;
  const engine = engineWith({ run: async req => {
    if (isPlanning(req)) return { text: plan([{ id: 's1', agent: 'Claude', task: 'A' }, { id: 's2', agent: 'Claude', task: 'B' }, { id: 's3', agent: 'Copilot', task: 'C' }]), usage };
    if (running.has(req.agent.name)) overlap = true;
    running.add(req.agent.name); await new Promise(resolve => setTimeout(resolve, 10)); running.delete(req.agent.name);
    return { text: 'ok', usage };
  } });
  engine.room.mode = 'orchestrated';
  await engine.start('Work'); assert.equal(overlap, false); assert.equal(engine.room.completedTurns, 5);
});

test('pausing during a plan finishes active steps and resumes the remaining ones', async () => {
  const calls: string[] = [];
  const engine = engineWith({ run: async req => {
    calls.push(stepOf(req) ?? (isPlanning(req) ? 'plan' : 'final'));
    if (isPlanning(req)) return { text: plan([{ id: 's1', agent: 'Claude', task: 'A' }, { id: 's2', agent: 'Copilot', task: 'B', after: ['s1'] }]), usage };
    if (stepOf(req) === 's1') engine.pause();
    return { text: 'ok', usage };
  } });
  engine.room.mode = 'orchestrated';
  await engine.start('Work');
  assert.equal(engine.room.status, 'paused'); assert.deepEqual(calls, ['plan', 's1']); assert.equal(engine.room.queuedTurns, 1);
  await engine.start();
  assert.deepEqual(calls, ['plan', 's1', 's2', 'final']); assert.equal(engine.room.status, 'idle');
});

test('stopping during a plan cancels active steps and skips the rest', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  const engine = engineWith({ run: req => {
    if (isPlanning(req)) return Promise.resolve({ text: plan([{ id: 's1', agent: 'Claude', task: 'A' }, { id: 's2', agent: 'Copilot', task: 'B', after: ['s1'] }]), usage });
    return new Promise((_, reject) => { started(); req.signal.addEventListener('abort', () => reject(req.signal.reason)); });
  } });
  engine.room.mode = 'orchestrated';
  const run = engine.start('Work'); await ready; engine.stop(); await run;
  assert.deepEqual(engine.room.messages.find(m => m.plan)!.plan!.map(s => s.status), ['skipped', 'skipped']);
  assert.equal(engine.room.flow, undefined); assert.equal(engine.room.status, 'idle'); assert.deepEqual(engine.room.activeAgents, []);
});

test('the lead can plan another wave only while rounds remain', async () => {
  for (const rounds of [1, 2]) {
    let syntheses = 0, steps = 0;
    const engine = engineWith({ run: async req => {
      if (isPlanning(req)) return { text: plan([{ id: 's1', agent: 'Claude', task: 'A' }]), usage };
      if (isSynthesis(req)) return { text: ++syntheses === 1 ? plan([{ id: 's1', agent: 'Copilot', task: 'Check A' }], 'Need one check.') : 'Done', usage };
      steps++; return { text: 'ok', usage };
    } });
    engine.room.mode = 'orchestrated'; engine.room.rounds = rounds;
    await engine.start('Work');
    assert.equal(syntheses, rounds); assert.equal(steps, rounds);
    assert.equal(engine.room.messages.filter(m => m.turn === 'plan').length, rounds);
  }
});

test('1:1 chat sends exactly one direct turn whatever the room mode and rounds', async () => {
  const calls: ProviderRequest[] = [];
  const engine = engineWith({ run: async req => { calls.push(req); return { text: 'Hello back', usage }; } });
  engine.room.mode = 'orchestrated'; engine.room.rounds = 3;
  await engine.start('Hello', engine.room.agents[2]!.id);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.agent.name, 'Copilot');
  assert.match(calls[0]!.system, /one-on-one chat/); assert.doesNotMatch(calls[0]!.system, /CONSENSUS/);
  assert.equal(engine.room.messages.at(-1)!.turn, 'direct');
});

test('relay agents are told to build on earlier replies and see the roster', async () => {
  const calls: ProviderRequest[] = [];
  const engine = engineWith({ run: async req => { calls.push(req); return { text: `${req.agent.name} view`, usage }; } });
  await engine.start('Compare');
  assert.match(calls[1]!.system, /Do not restate what someone has already said/);
  assert.match(calls[1]!.system, /- Codex · Codex[\s\S]*- Claude \(you\)[\s\S]*- Copilot/);
  assert.match(calls[2]!.prompt, /Codex view[\s\S]*Claude view/);
});

test('document context is retrieved once per message and shared with every agent', async () => {
  const prompts: string[] = []; let briefings = 0;
  const engine = engineWith({ run: async req => { prompts.push(req.prompt); return { text: 'ok', usage }; } }, undefined, {
    briefing: async () => { briefings++; return '[Room documents · full text]\nThe launch date is May 4.'; } });
  engine.room.documents = [{ id: 'd', name: 'launch.md', hash: 'h', kind: 'text', source: 'attached', status: 'ready', chars: 30, chunks: 1, addedAt: 0 }];
  await engine.start('When do we launch?');
  assert.equal(briefings, 1); assert.equal(prompts.length, 3);
  for (const prompt of prompts) assert.match(prompt, /launch date is May 4/);
  await engine.start(); assert.equal(briefings, 1);
});
