import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, buildContext, parseToolCall, parsePlan, planStages, systemPrompt, message, estimateTokens, boundedNumber, roomFraming, renderEntry, renderContext,
  unseenEntries, boundedHistory, turnAsk, migrateRoom, defaultOptions, framingHash, DEFAULT_LOOP, FramingContext, SCHEMA,
  BUILTIN_TEAMS, classifyUnavailable, normalizeTeam, pipelineLead, stageAgents, teamPlan, unavailableText, sandboxLanguage, sandboxStatusText, sandboxSummary, sandboxWhat } from '../src/core';
import { Connection, Message, ProviderError, SandboxResult, TeamStage, Unavailable, addUsage, emptyUsage } from '../src/types';

const copilotCli: Connection = { id: 'copilot', status: 'ready', runtime: 'cli', detail: '', models: [] };
const ctx = (patch: Partial<FramingContext> = {}): FramingContext => ({ connections: [copilotCli], caps: {}, ...patch });
function teamRoom() {
  const room = createRoom(), [codex, claude, copilot] = room.agents as [typeof room.agents[0], typeof room.agents[0], typeof room.agents[0]];
  codex.model = 'gpt-5'; claude.model = 'sonnet'; claude.options.permission = 'auto-edit'; copilot.model = ''; copilot.options.permission = 'plan';
  return { room, codex, claude, copilot };
}

test('room framing lists the roster, marks the agent, and adds lead, role and skills lines only when they apply', () => {
  const { room, codex, claude, copilot } = teamRoom();
  room.mode = 'orchestrated'; room.leadId = claude.id; copilot.role = 'Testing';
  const framing = roomFraming(codex, room, ctx({ skillsIndex: '/tmp/INDEX.md' }));
  assert.equal(framing, [
    'You are Codex, one of the AI agents in Chatroom: a shared chat room in VS Code where the user works with several agents together.',
    'In the room:',
    '- The user',
    '- Codex (you) · Codex CLI (gpt-5) · own tools, skills and MCP; edits files and runs commands with the user\'s approval',
    '- Claude · Claude Code (sonnet) · own tools, skills and MCP; edits files directly, asks before other actions',
    '- Copilot · GitHub Copilot CLI · own tools, skills and MCP; read-only (planning)',
    'Messages from the user and the other agents reach you as <room from="Name">…</room> blocks. Your own earlier replies are already in your history, so you only receive what is new.',
    'Work as a team: build on what others found, correct mistakes with evidence, share findings that help, and don\'t redo work someone already did. Help teammates when they ask, but the user\'s requests come first.',
    'To ask a teammate for help or hand off a task, start a line with @Name and say what you need, for example "@Claude can you check the failing test?". Mention someone only when you need them.',
    'Claude leads this room and may ask you for help.',
    'Skills from the other agents are listed in /tmp/INDEX.md; open a SKILL.md from there when one fits the task.'
  ].join('\n'));
  const lead = roomFraming(claude, room, ctx());
  assert.match(lead, /- Claude \(you\) · Claude Code/);
  assert.match(lead, /\nYou lead this room: the user's requests come to you first, and you decide whether to answer yourself or bring in teammates\.$/);
  assert.match(roomFraming(copilot, room, ctx()), /\nYour focus in this room: Testing$/);
  assert.doesNotMatch(framing, /Your focus|Engineer|Reviewer|Integrator|Specialist/);
  room.mode = 'sequential';
  assert.doesNotMatch(roomFraming(codex, room, ctx()), /leads this room|You lead/);
  room.shareSkills = false;
  assert.doesNotMatch(roomFraming(codex, room, ctx({ skillsIndex: '/tmp/INDEX.md' })), /Skills from/);
});
test('legacy framing describes chat-model agents and the transcript, and a lone agent gets no hand-off line', () => {
  const { room, codex, claude, copilot } = teamRoom();
  const legacy = roomFraming(copilot, room, { connections: [{ ...copilotCli, runtime: 'vscode-lm' }], caps: {}, legacy: true, skillsIndex: '/tmp/INDEX.md' });
  assert.match(legacy, /- Copilot \(you\) · GitHub Copilot \(VS Code chat model\) · chat model with Chatroom's read-only file tools/);
  assert.match(legacy, /\nThe conversation so far is included below as <room from="Name">…<\/room> blocks\.\n/);
  assert.doesNotMatch(legacy, /Skills from/);
  claude.enabled = false; copilot.enabled = false;
  const alone = roomFraming(codex, room, ctx());
  assert.doesNotMatch(alone, /start a line with @Name/); assert.doesNotMatch(alone, /- Claude/);
  assert.equal(framingHash(alone).length, 16); assert.notEqual(framingHash(alone), framingHash(legacy));
});
test('room entries carry author, targets, step and kind attributes and escape the closing tag', () => {
  const { room, codex, claude } = teamRoom();
  const user = message('user', 'Fix </room> now'); user.targets = [claude.id, codex.id];
  assert.equal(renderEntry(user, room), `<room from="User" to="Claude, Codex">\nFix <\\/room> now\n</room>`);
  const step = message('agent', 'Found 2 risks', 'Claude', claude.id); step.step = { id: 's1', task: 'Find "risky" code ' + 'x'.repeat(200), after: [] };
  assert.equal(renderEntry(step, room), `<room from="Claude" step="s1: Find 'risky' code ${'x'.repeat(102)}">\nFound 2 risks\n</room>`);
  const plan = message('agent', 'Splitting up.', 'Codex', codex.id); plan.turn = 'plan'; plan.plan = [{ id: 's1', agentId: claude.id, task: 'Review', after: [], status: 'pending' }];
  assert.equal(renderEntry(plan, room), '<room from="Codex" kind="plan">\nSplitting up.\n[Plan]\ns1 · Claude: Review\n</room>');
  const final = message('agent', 'Done.', 'Codex', codex.id); final.turn = 'synthesis';
  assert.match(renderEntry(final, room), /^<room from="Codex" kind="final answer">/);
  const many = Array.from({ length: 10 }, (_, i) => message('user', `Message ${i} ` + 'x'.repeat(300)));
  const bounded = renderContext(many, room, 1000);
  assert.match(bounded, /^\[\d+ earlier room messages omitted\]/); assert.match(bounded, /Message 9/); assert.doesNotMatch(bounded, /Message 0 /);
});
test('unseen entries skip own, tool, approval, notice and command messages and start after the seen marker', () => {
  const { room, codex, claude } = teamRoom();
  const first = message('user', 'First');
  const mine = message('agent', 'Codex reply', 'Codex', codex.id);
  const tool = message('tool', 'tool output', 'read_file', claude.id);
  const theirs = message('agent', 'Claude reply', 'Claude', claude.id);
  const card = message('approval', 'npm test', 'Claude', claude.id);
  const notice = message('notice', 'Context cleared', 'Chatroom');
  const update = message('notice', 'Room update: new roster', 'Chatroom');
  const streaming = message('agent', 'partial', 'Claude', claude.id); streaming.status = 'streaming';
  const command = message('agent', 'Compacted', 'Claude', claude.id); command.turn = 'command';
  const second = message('user', 'Second');
  room.messages = [first, mine, tool, theirs, card, notice, update, streaming, command, second];
  codex.session = { id: 'thread-1', seen: first.id };
  assert.deepEqual(unseenEntries(room, codex, { kind: 'discussion' }).map(m => m.text), ['Claude reply', 'Room update: new roster', 'Second']);
  codex.session.seen = theirs.id;
  assert.deepEqual(unseenEntries(room, codex, { kind: 'discussion' }).map(m => m.text), ['Room update: new roster', 'Second']);
  codex.session = { id: 'thread-1', seen: 'missing' };
  room.messages = [...Array.from({ length: 30 }, (_, i) => message('user', `old ${i}`)), second];
  const bounded = unseenEntries(room, codex, { kind: 'discussion' });
  assert.equal(bounded.length, 20); assert.equal(bounded[0]!.text, 'old 11');
  codex.session = undefined;
  assert.equal(unseenEntries(room, codex, { kind: 'discussion' })[0]!.text, 'old 0', 'a new session gets the bounded history, objective first');
});
test('sandbox cards: one-line summaries per status, language aliases, and boundedHistory gives a new session every finished run', () => {
  const r: SandboxResult = { id: 'a', status: 'pending', image: 'python:3.12-slim', profile: 'test', network: false, command: '\n  import json\nprint(json.dumps({}))', language: 'python',
    limits: { cpus: 2, memoryMb: 2048, timeoutSeconds: 120 }, stdout: '', stderr: '', requestedBy: 'Codex', agentId: 'codex', createdAt: 1 };
  assert.equal(sandboxWhat(r), 'Python code: import json');
  assert.equal(sandboxWhat({ ...r, language: undefined, command: 'npm test\nnpm run lint' }), 'npm test …');
  assert.equal(sandboxWhat({ ...r, language: undefined, command: 'x'.repeat(150) }), 'x'.repeat(99) + '…');
  const texts = (['pending', 'pulling', 'running', 'done', 'failed', 'denied', 'timeout', 'cancelled'] as const).map(status => sandboxStatusText({ ...r, status, exitCode: 0, durationMs: 12_400, error: 'boom' }));
  assert.deepEqual(texts, ['preparing', 'downloading python:3.12-slim', 'running', 'exit code 0 · 12 s', 'failed: boom', 'declined', 'timed out after 120 s and was stopped', 'cancelled']);
  assert.equal(sandboxSummary({ ...r, status: 'done', exitCode: 1, durationMs: 830 }), 'Sandbox · Python code: import json · exit code 1 · 0.8 s');
  assert.deepEqual(['sh', 'Shell', 'py', 'python3', 'js', 'JavaScript', 'node', 'ruby', '', 'constructor'].map(sandboxLanguage), ['bash', 'bash', 'python', 'python', 'node', 'node', 'node', undefined, undefined, undefined]);
  const { room, codex } = teamRoom();
  const card = message('notice', 'Sandbox', 'Sandbox'); card.sandbox = { ...r, status: 'done', exitCode: 0 }; delete card.agentId;
  const running = message('notice', 'Sandbox', 'Sandbox'); running.sandbox = { ...r, id: 'b', status: 'running', agentId: undefined };
  room.messages = [message('user', 'First'), card, running];
  assert.deepEqual(boundedHistory(room, codex, 12000, { kind: 'discussion' }).map(m => m.id), [room.messages[0]!.id, card.id], 'a new session also gets its own finished runs, not running ones');
});
test('steps see the history, the plan and only the outputs they build on; the synthesis sees every output', () => {
  const { room, codex, claude, copilot } = teamRoom();
  const user = message('user', 'Build it');
  const plan = message('agent', 'Plan', 'Codex', codex.id); plan.turn = 'plan';
  const s1 = message('agent', 'out s1', 'Claude', claude.id); s1.step = { id: 's1', plan: plan.id, task: 'A', after: [] };
  const s2 = message('agent', 'out s2', 'Copilot', copilot.id); s2.step = { id: 's2', plan: plan.id, task: 'B', after: [] };
  const other = message('agent', 'chatter', 'Claude', claude.id);
  room.messages = [user, plan, s1, s2, other];
  const flow = { wave: 0, leadId: codex.id, phase: 'steps' as const, steps: [], planId: plan.id };
  const step3 = { id: 's3', agentId: copilot.id, task: 'C', after: ['s1'], status: 'pending' as const };
  assert.deepEqual(boundedHistory(room, copilot, 12000, { kind: 'step', flow, step: step3 }).map(m => m.text), ['Build it', 'Plan', 'out s1']);
  const s4 = { id: 's4', agentId: claude.id, task: 'D', after: [], status: 'pending' as const };
  claude.session = { id: 'c', seen: user.id };
  assert.deepEqual(unseenEntries(room, claude, { kind: 'step', flow, step: s4 }).map(m => m.text), ['Plan']);
  codex.session = { id: 'x', seen: user.id };
  assert.deepEqual(unseenEntries(room, codex, { kind: 'synthesis', flow }).map(m => m.text), ['out s1', 'out s2']);
});
test('asks are exact per turn kind, with round prefixes and loop suffixes', () => {
  const { room, codex, claude } = teamRoom();
  room.leadId = codex.id;
  assert.equal(turnAsk(codex, room, { kind: 'discussion' }), 'It\'s your turn (relay): respond to the latest request and build on the replies above.');
  assert.equal(turnAsk(codex, room, { kind: 'discussion', parallel: true, round: 2, rounds: 3 }), 'It\'s your turn (parallel, round 2 of 3): the others are answering at the same time; you\'ll see their replies next round.');
  assert.equal(turnAsk(codex, room, { kind: 'direct' }), '');
  assert.equal(turnAsk(codex, room, { kind: 'plan' }), 'You\'re leading this request. If you can answer it well yourself, just answer. To bring in teammates, end your reply with one line per teammate: "@Name <their task>"; they work in parallel and you\'ll get their results to write the final answer. If some tasks depend on others, end instead with <chatroom-plan>{"steps":[{"id":"s1","agent":"Name","task":"…","after":[]},{"id":"s2","agent":"Name","task":"…","after":["s1"]}]}</chatroom-plan>.');
  const flow = { wave: 0, leadId: codex.id, phase: 'steps' as const, steps: [] };
  assert.equal(turnAsk(claude, room, { kind: 'step', flow, step: { id: 's2', agentId: claude.id, task: 'Review the parser.', after: ['s1'], status: 'pending' } }),
    'Codex asked you (step s2): Review the parser. It builds on step s1 above. Do just this part; Codex will combine the results.');
  assert.equal(turnAsk(codex, room, { kind: 'synthesis', wavesLeft: 0 }), 'Your teammates have replied above. Write the final answer for the user: combine their work, resolve disagreements, and fix mistakes you notice.');
  assert.match(turnAsk(codex, room, { kind: 'synthesis', wavesLeft: 1 }), / If essential work is still missing, you can delegate again the same way \(1 more round allowed\)\.$/);
  assert.equal(turnAsk(claude, room, { kind: 'handoff', handoff: { from: 'Codex', line: 'check the failing test' } }), 'Codex mentioned you: "check the failing test"');
  const rounds = { ...DEFAULT_LOOP, kind: 'rounds' as const, rounds: 3 };
  assert.equal(turnAsk(claude, room, { kind: 'discussion', loop: rounds, iteration: 2, round: 2, rounds: 3 }),
    'Round 2 of 3: keep going — respond to what\'s new above. It\'s your turn (relay, round 2 of 3): respond to the latest request and build on the replies above.');
  const consensus = { ...DEFAULT_LOOP, kind: 'consensus' as const };
  assert.equal(turnAsk(claude, room, { kind: 'direct', loop: consensus }), 'When you have nothing to add, say so briefly and end your reply with [AGREE].');
  assert.match(turnAsk(claude, room, { kind: 'discussion', loop: consensus, iteration: 3 }), /^Round 3: keep going — .* end your reply with \[AGREE\]\.$/);
  const done = { ...DEFAULT_LOOP, kind: 'lead-done' as const };
  assert.match(turnAsk(codex, room, { kind: 'discussion', loop: done }), / When the task is complete, end your reply with \[DONE\]\.$/);
  assert.doesNotMatch(turnAsk(claude, room, { kind: 'discussion', loop: done }), /\[DONE\]/);
  room.agents.slice(1).forEach(a => a.enabled = false);
  assert.equal(turnAsk(codex, room, { kind: 'plan' }), '');
});
test('legacy context retains the original objective and recent contributions within a bounded prompt', () => {
  const room = createRoom(), agent = room.agents[0]!;
  room.messages = [message('user', 'Build a robust parser')];
  for (let i = 0; i < 60; i++) room.messages.push(message('agent', `Contribution ${i}: ` + 'reasoning '.repeat(100), 'Reviewer', room.agents[1]!.id));
  const context = buildContext(room, agent, 4000, { kind: 'discussion' }, ctx());
  assert.match(context.prompt, /^<room from="User">\nBuild a robust parser\n<\/room>/);
  assert.match(context.prompt, /Contribution 59/);
  assert.ok(context.omitted > 0); assert.match(context.prompt, /\[\d+ earlier messages omitted\]/);
  assert.ok(estimateTokens(context.system + context.prompt) < 4200);
  assert.match(context.prompt, /It's your turn \(relay\)/);
});
test('stable legacy prompt prefixes are unchanged as discussion grows', () => {
  const room = createRoom(), agent = room.agents[0]!;
  room.messages.push(message('user', 'Review architecture'));
  const before = buildContext(room, agent, 12000, { kind: 'discussion' }, ctx());
  room.messages.push(message('agent', 'Use a queue', 'Claude', room.agents[1]!.id));
  const after = buildContext(room, agent, 12000, { kind: 'discussion' }, ctx());
  assert.equal(before.system, after.system);
  assert.equal(before.prompt.split('\n\n')[0], after.prompt.split('\n\n')[0]);
  assert.match(after.prompt, /<room from="Claude">\nUse a queue\n<\/room>/);
});
test('large objectives cannot bypass a small legacy context budget', () => {
  const room = createRoom(); room.messages.push(message('user', 'large objective '.repeat(2000)));
  const context = buildContext(room, room.agents[0]!, 2000, { kind: 'discussion' }, ctx());
  assert.ok(estimateTokens(context.system + context.prompt) <= 2000);
  assert.match(context.prompt, /objective truncated/);
});
test('the legacy system prompt is the legacy framing, the documents, and the tool protocol last', () => {
  const room = createRoom(), [codex] = room.agents;
  room.documents = [{ id: 'd', name: 'spec.pdf', hash: 'h', kind: 'pdf', source: 'attached', status: 'ready', chars: 1200, chunks: 2, pages: 3, ocrPages: 1, addedAt: 0 }];
  const system = systemPrompt(codex!, room, ctx());
  assert.match(system, /^You are Codex, one of the AI agents in Chatroom/);
  assert.match(system, /The conversation so far is included below/);
  assert.match(system, /Documents attached to this room \(text already extracted; use search_documents to look up details\):\n- spec\.pdf · PDF, 3 pages, 1 read with OCR/);
  assert.match(system, /Read-only file tools are available\. Never invent filenames, file contents or tool results\.\n\nTo use a Chatroom tool, output ONLY <chatroom-tool>[\s\S]*"name":"search_documents"[\s\S]*$/);
  assert.equal(system.replace(/To use a Chatroom tool,[\s\S]*$/, 'NATIVE').endsWith('NATIVE'), true, 'CopilotProvider can still replace the tool paragraph');
  codex!.tools = [];
  assert.match(systemPrompt(codex!, room, ctx()), /\n\nNo Chatroom tools are enabled for you\.$/);
});
test('migrating a schema-4 room clears personas, moves rounds to loops and reasoning to effort, and is idempotent', () => {
  const raw: any = {
    id: 'r', title: 'Old', createdAt: 1, schema: 4, rounds: 3, tokenBudget: 0, usage: {}, activity: [], status: 'running', completedTurns: 2,
    agents: [
      { id: 'a', name: 'Codex', provider: 'codex', model: 'gpt-5', role: 'Engineer. Propose a concrete implementation and identify technical tradeoffs.', enabled: true, tools: ['read_file'], reasoning: 'high' },
      { id: 'b', name: 'Claude', provider: 'claude', model: 'sonnet', role: 'Security expert', enabled: true, tools: [] },
      { id: 'c', name: 'Copilot', provider: 'copilot', model: '', role: 'Specialist. Contribute your perspective and help resolve the user’s objective.', enabled: false, tools: [], reasoning: 'low', options: { effort: 'medium' } }
    ],
    messages: [
      { id: 'm1', kind: 'user', author: 'You', text: 'Hi', createdAt: 1, status: 'complete' },
      { id: 'm2', kind: 'agent', author: 'Codex', agentId: 'a', text: 'partial', createdAt: 2, status: 'streaming' },
      { id: 'm3', kind: 'approval', author: 'Claude', agentId: 'b', text: 'npm test', createdAt: 3, status: 'complete', approval: { id: 'x', status: 'pending' } }
    ],
    loopState: { iteration: 2, startedAt: 1, startTokens: 0, nextAt: 99 }
  };
  const room = migrateRoom(raw, { attachEditor: true, shareSkills: false, permission: 'ask' });
  assert.equal(room.schema, SCHEMA); assert.equal('rounds' in room, false);
  assert.deepEqual(room.loop, { ...DEFAULT_LOOP, kind: 'rounds', rounds: 3 });
  assert.equal(room.attachEditor, true); assert.equal(room.shareSkills, false); assert.equal(room.loopState!.nextAt, undefined);
  const [codex, claude, copilot] = room.agents;
  assert.equal(codex!.role, ''); assert.equal(claude!.role, 'Security expert'); assert.equal(copilot!.role, '');
  assert.deepEqual(codex!.options, { ...defaultOptions('codex'), effort: 'high' }); assert.equal('reasoning' in codex!, false);
  assert.equal(copilot!.options.effort, 'medium', 'an explicit effort wins over the old reasoning'); assert.equal(copilot!.options.copilotRuntime, 'auto');
  assert.deepEqual(codex!.tools, ['read_file']); assert.equal(codex!.session, undefined);
  assert.equal(room.messages[1]!.status, 'cancelled'); assert.equal(room.messages[2]!.approval!.status, 'expired');
  const again = migrateRoom(JSON.parse(JSON.stringify(room)), { attachEditor: false, shareSkills: true, permission: 'plan' });
  assert.deepEqual(again, JSON.parse(JSON.stringify(room)));
  const oneRound = migrateRoom({ id: 'o', agents: [], messages: [], rounds: 1, schema: 3, tokenBudget: 50000 }, { attachEditor: false, shareSkills: true, permission: 'plan' });
  assert.deepEqual(oneRound.loop, DEFAULT_LOOP); assert.equal(oneRound.tokenBudget, 0); assert.equal(oneRound.attachEditor, false);
});
test('new rooms have no personas, ask permission by default and a once loop', () => {
  const room = createRoom(undefined, 'planning');
  assert.ok(room.agents.every(a => a.role === '' && a.options.permission === 'ask' && a.options.effort === ''));
  assert.deepEqual(room.loop, DEFAULT_LOOP); assert.equal(room.schema, SCHEMA); assert.equal('rounds' in room, false);
  assert.equal(createRoom(undefined, 'planning', 'plan').agents[0]!.options.permission, 'plan');
  assert.deepEqual(defaultOptions('copilot', 'auto-edit'), { effort: '', thinking: 'on', summary: 'auto', permission: 'auto-edit', useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false, copilotRuntime: 'auto' });
});
test('tool parsing requires an isolated envelope and a known tool', () => {
  assert.equal(parseToolCall('Here is an example: <chatroom-tool>{}</chatroom-tool>'), undefined);
  assert.throws(() => parseToolCall('<chatroom-tool>{"name":"shell","arguments":{}}</chatroom-tool>'));
  assert.throws(() => parseToolCall('<chatroom-tool>invalid</chatroom-tool>'));
  assert.deepEqual(parseToolCall('<chatroom-tool>{"name":"read_file","arguments":{"path":"README.md"}}</chatroom-tool>'), { name: 'read_file', arguments: { path: 'README.md' } });
});
test('usage aggregation preserves reported cost, cache and estimate provenance', () => {
  const result = addUsage({ ...emptyUsage(), input: 100, cached: 50, cost: .01 }, { ...emptyUsage(), input: 50, output: 20, estimated: true });
  assert.equal(result.input + result.output, 170); assert.equal(result.cached, 50); assert.equal(result.cost, .01); assert.equal(result.estimated, true);
  assert.equal(addUsage(emptyUsage(), emptyUsage()).cost, undefined);
});
test('numeric controls reject NaN and clamp unsafe values', () => {
  assert.equal(boundedNumber(NaN, 1, 10, 3), 3); assert.equal(boundedNumber(Infinity, 1, 10, 3), 3);
  assert.equal(boundedNumber(100, 1, 10, 3), 10); assert.equal(boundedNumber(-20, 1, 10, 3), 1);
});
test('plans resolve agents by name or provider, drop unknown agents and forward dependencies', () => {
  const room = createRoom(), [codex, claude] = room.agents;
  const parsed = parsePlan('Approach.\n<chatroom-plan>```json\n{"steps":[{"id":"a","agent":"claude","task":"Review","after":["b"]},{"id":"b","agent":"Gemini","task":"X"},{"id":"c","agent":"codex","task":"Build","after":["a","zzz"]},{"id":"d","agent":"Codex","task":""}]}\n```</chatroom-plan>', room.agents)!;
  assert.equal(parsed.text, 'Approach.');
  assert.deepEqual(parsed.steps.map(s => [s.id, s.agentId, s.after]), [['a', claude!.id, []], ['c', codex!.id, ['a']]]);
  assert.equal(parsed.notes.length, 2); assert.match(parsed.notes.join(), /"Gemini" is not an enabled agent/);
  assert.equal(parsePlan('No plan here', room.agents), undefined);
  assert.deepEqual(parsePlan('Oops <chatroom-plan>{not json</chatroom-plan>', room.agents)!.steps, []);
  assert.deepEqual(planStages(parsed.steps).map(stage => stage.map(s => s.id)), [['a'], ['c']]);
});
test('bounded history never exceeds its budget', () => {
  const room = createRoom(), agent = room.agents[0]!;
  room.messages = [message('user', 'goal'), ...Array.from({ length: 40 }, (_, i) => message('agent', `step ${i} ` + 'y'.repeat(500), 'Claude', room.agents[1]!.id))] as Message[];
  const history = boundedHistory(room, agent, 1000, { kind: 'discussion' });
  assert.equal(history[0]!.text, 'goal'); assert.match(history[1]!.text, /^\[\d+ earlier messages omitted\]$/);
  assert.ok(renderContext(history, room, 100000).length <= 3200);
});

// ── Availability ─────────────────────────────────────────────────────────────
test('classifyUnavailable: provider error codes, then the message text; ordinary failures are not marks', () => {
  const { codex, claude } = teamRoom(), now = 1_000_000, ollama = { ...codex, id: 'o', name: 'Ollama', provider: 'ollama' as const, model: 'llama3' };
  assert.deepEqual(classifyUnavailable(new ProviderError('Codex usage limit reached.', 'usage-limit', { resetsAt: now + 5000 }), codex, now),
    { reason: 'usage-limit', detail: 'Codex usage limit reached.', at: now, until: now + 5000 });
  assert.equal(classifyUnavailable(new ProviderError('limit', 'usage-limit'), codex, now)!.until, now + 15 * 60000);
  assert.deepEqual(classifyUnavailable(new ProviderError('Claude Code was not found.', 'missing'), claude, now), { reason: 'missing', detail: 'Claude Code was not found.', at: now });
  assert.equal(classifyUnavailable(new ProviderError('Sign in', 'signed-out'), claude, now)!.reason, 'signed-out');
  assert.deepEqual(classifyUnavailable(new ProviderError('gone', 'model-unavailable'), codex, now), { reason: 'model', detail: 'gone', at: now, model: 'gpt-5' });
  for (const text of ['You have exceeded your monthly quota', '429 rate_limit_error', 'Your credit balance is too low', 'insufficient_quota', 'You are out of credits', 'premium requests used up', 'Claude usage limit reached'])
    assert.deepEqual(classifyUnavailable(new Error(text), claude, now), { reason: 'usage-limit', detail: text, at: now, until: now + 15 * 60000 }, text);
  for (const text of ['The model gpt-9 does not exist or you do not have access to it', 'model "x" not found', 'Unknown model: foo', 'invalid model id', 'The requested model isn\'t available on your plan', 'No matching Copilot model. Sign in to GitHub Copilot and refresh connections.'])
    assert.equal(classifyUnavailable(new Error(text), codex, now)?.reason, 'model', text);
  assert.equal(classifyUnavailable(new Error('model x not found'), { ...codex, model: '' }, now)!.model, undefined, 'the default model is not named');
  for (const text of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:11434', 'socket hang up'])
    assert.deepEqual(classifyUnavailable(new TypeError(text), ollama, now), { reason: 'offline', detail: text, at: now, until: now + 2 * 60000 }, text);
  assert.equal(classifyUnavailable(new Error('fetch failed'), codex, now), undefined, 'only Ollama is offline');
  assert.equal(classifyUnavailable(new Error('Something broke'), codex, now), undefined);
  assert.equal(classifyUnavailable(new ProviderError('down', 'crashed'), codex, now), undefined);
  assert.equal(classifyUnavailable('x'.repeat(400) + ' quota', codex, now)!.detail.length, 300);
});
test('unavailableText is a short phrase; usage times show the weekday, or the date when far away', () => {
  const until = new Date(2026, 9, 8, 23, 23).getTime(), u = (patch: Partial<Unavailable>): Unavailable => ({ reason: 'usage-limit', detail: '', at: 0, ...patch });
  assert.equal(unavailableText(u({ until }), until - 3_600_000), 'out of usage until Thu 23:23');
  assert.equal(unavailableText(u({ until: new Date(2026, 9, 20, 9, 5).getTime() }), until), 'out of usage until Oct 20, 09:05');
  assert.equal(unavailableText(u({}), 0), 'out of usage');
  assert.equal(unavailableText(u({ reason: 'missing' }), 0), 'not installed');
  assert.equal(unavailableText(u({ reason: 'signed-out' }), 0), 'signed out');
  assert.equal(unavailableText(u({ reason: 'model', model: 'opus' }), 0), 'model opus is not available');
  assert.equal(unavailableText(u({ reason: 'model' }), 0), 'model default is not available');
  assert.equal(unavailableText(u({ reason: 'offline' }), 0), 'not running');
});
test('room framing lists only agents that can run, says who is unavailable, and never drops the agent itself', () => {
  const { room, codex, claude, copilot } = teamRoom();
  room.mode = 'orchestrated'; room.leadId = claude.id;
  const unavailable = (a: { id: string }): Unavailable | undefined => a.id === claude.id ? { reason: 'signed-out', detail: '', at: 0 } : undefined;
  const framing = roomFraming(codex, room, ctx({ unavailable }));
  assert.doesNotMatch(framing, /- Claude ·/);
  assert.match(framing, /\n- Copilot · GitHub Copilot CLI/);
  assert.match(framing, /\nYou lead this room: [^\n]*\nUnavailable right now: Claude \(signed out\)\.$/, 'an unavailable lead is replaced by the first available agent, as the engine does');
  assert.match(roomFraming(copilot, room, ctx({ unavailable })), /\nCodex leads this room and may ask you for help\.\nUnavailable right now: Claude \(signed out\)\.$/);
  assert.match(roomFraming(claude, room, ctx({ unavailable })), /- Claude \(you\) · Claude Code/);
  assert.notEqual(framingHash(framing), framingHash(roomFraming(codex, room, ctx())));
  assert.doesNotMatch(roomFraming(copilot, room, ctx()), /Unavailable right now/);
});

// ── The user's own teams ─────────────────────────────────────────────────────
test('normalizeTeam bounds names, agents and stages, drops empty stages, infers leads and never copies builtIn', () => {
  for (const bad of [null, 'x', {}, { stages: [] }, { stages: [{ name: 'Empty', agents: [] }, { agents: ['', '  ', 5] }] }]) assert.equal(normalizeTeam(bad), undefined);
  const team = normalizeTeam({ name: '  ' + 'N'.repeat(50), builtIn: true, stages: [
    { name: 'Leaders', agents: [' Claude ', 'claude', '', 5, 'X'.repeat(50), ...Array.from({ length: 10 }, (_, i) => `A${i}`)] },
    { agents: ['Codex'], run: 'relay', task: '  Write it  ', preset: 'drafting' },
    { name: 'Empty', agents: [] },
    { name: 'Lead review', agents: ['Copilot'], lead: false, task: ' ', preset: 'bogus', run: 'weird' },
    { name: 'T'.repeat(60), agents: ['Codex'], task: 'y'.repeat(600) },
    ...Array.from({ length: 8 }, (_, i) => ({ name: `Extra ${i}`, agents: ['Codex'] }))
  ] })!;
  assert.equal(team.name, 'N'.repeat(40)); assert.equal('builtIn' in team, false); assert.equal(team.stages.length, 8); assert.equal(team.wrapUp, true);
  assert.deepEqual(team.stages[0], { name: 'Leaders', agents: ['Claude', 'X'.repeat(40), 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'], run: 'parallel', lead: true });
  assert.deepEqual(team.stages[1], { name: 'Stage 2', agents: ['Codex'], run: 'relay', lead: false, task: 'Write it', preset: 'drafting' });
  assert.deepEqual(team.stages[2], { name: 'Lead review', agents: ['Copilot'], run: 'parallel', lead: false });
  assert.equal(team.stages[3]!.name.length, 40); assert.equal(team.stages[3]!.task!.length, 500);
  assert.deepEqual(normalizeTeam(team), team, 'normalizing twice changes nothing');
  assert.deepEqual(normalizeTeam({ stages: [{ name: 'Draft', agents: ['Codex'] }] }), { name: 'My team', stages: [{ name: 'Draft', agents: ['Codex'], run: 'parallel', lead: false }], wrapUp: false });
  assert.equal(normalizeTeam({ wrapUp: false, stages: [{ name: 'Lead', agents: ['Claude'] }] })!.wrapUp, false);
  for (const [name, lead] of [['Lead', true], ['leads', true], ['Leader', true], ['Leaders: plan', true], ['Leading', false], ['Mislead', false]] as const)
    assert.equal(normalizeTeam({ stages: [{ name, agents: ['Claude'] }] })!.stages[0]!.lead, lead, name);
  for (const t of BUILTIN_TEAMS) { assert.equal(t.builtIn, true); assert.deepEqual({ ...normalizeTeam(t)!, builtIn: true }, t, t.name); }
});
test('stage agents resolve by name or a provider alias with one enabled agent; teamPlan names them', () => {
  const { room, codex, claude, copilot } = teamRoom();
  const s = (agents: string[]): TeamStage => ({ name: 'S', agents, run: 'parallel' });
  assert.deepEqual(stageAgents(s(['claude', 'CODEX', 'Claude', 'github copilot', 'Gemini']), room), [claude, codex, copilot]);
  claude.name = 'Sonnet';
  assert.deepEqual(stageAgents(s(['claude code', 'codex']), room), [claude, codex]);
  const opus = { ...claude, id: 'opus', name: 'Opus' };
  room.agents.push(opus);
  assert.deepEqual(stageAgents(s(['claude', 'opus', 'sonnet']), room), [opus, claude], 'two Claude agents: the alias is ambiguous, names still work');
  copilot.enabled = false;
  assert.deepEqual(stageAgents(s(['Copilot', 'copilot']), room), []);
  claude.name = 'Claude'; room.agents.pop(); copilot.enabled = true;
  assert.equal(teamPlan(BUILTIN_TEAMS[0]!, room), 'Leads (Claude) → Drafting (Codex) → Review (Claude, Copilot)');
  assert.equal(teamPlan({ name: 'x', wrapUp: false, stages: [s(['Gemini']), s(['codex'])] }, room), 'S (nobody) → S (Codex)');
  room.team = BUILTIN_TEAMS[1];
  assert.equal(pipelineLead(room), claude);
  claude.unavailable = { reason: 'usage-limit', detail: '', at: 0, until: Date.now() + 60000 };
  assert.equal(pipelineLead(room), undefined, 'the lead stage has no other agent');
  assert.equal(pipelineLead(room, () => true), claude);
  room.team = BUILTIN_TEAMS[2];
  assert.equal(pipelineLead(room, () => true), undefined, 'a team without a lead stage');
});
test('stage asks say the stage, the plan and the task; the lead may answer directly; the team wrap-up names the stages', () => {
  const { room, codex, claude, copilot } = teamRoom();
  const plan = 'Leads (Claude) → Drafting (Codex) → Review (Claude, Copilot)';
  const stage = (index: number, name: string, extra = {}) => ({ kind: 'stage' as const, stage: { index, total: 3, name, others: [], plan, ...extra } });
  assert.equal(turnAsk(claude, room, stage(0, 'Leads', { lead: true })),
    `Team stage 1 of 3: Leads. The team works in stages: ${plan}. You lead: if you can answer the request yourself, do it and end with [DONE]; otherwise set up the work for the next stages without doing their parts.`);
  assert.equal(turnAsk(codex, room, stage(1, 'Drafting', { task: 'Write a first draft.' })),
    `Team stage 2 of 3: Drafting. The team works in stages: ${plan}. Your part: Write a first draft. Build on the earlier stages' work above; the next stage picks up from yours.`);
  assert.equal(turnAsk(copilot, room, stage(2, 'Review', { others: ['Claude'] })),
    `Team stage 3 of 3: Review (with Claude). The team works in stages: ${plan}. Build on the earlier stages' work above.`);
  assert.equal(turnAsk(codex, room, stage(0, 'Drafting')), `Team stage 1 of 3: Drafting. The team works in stages: ${plan}. The next stage picks up from yours.`);
  const done = { ...DEFAULT_LOOP, kind: 'lead-done' as const };
  assert.match(turnAsk(claude, room, { ...stage(0, 'Leads', { lead: true }), loop: done }), / When the task is complete, end your reply with \[DONE\]\.$/);
  assert.doesNotMatch(turnAsk(codex, room, { ...stage(1, 'Drafting'), loop: done }), /When the task is complete/);
  assert.match(turnAsk(codex, room, { ...stage(0, 'Drafting'), loop: { ...DEFAULT_LOOP, kind: 'rounds', rounds: 2 }, iteration: 2 }), /^Round 2 of 2: keep going — respond to what's new above\. Team stage 1 of 3/);
  assert.equal(turnAsk(claude, room, { kind: 'synthesis', teamPlan: plan }),
    `The team has finished its stages (${plan}). Write the final answer for the user: combine their work, resolve disagreements, and fix mistakes you notice.`);
});
test('stage entries carry a stage attribute, and a pipeline room frames itself by its stages', () => {
  const { room, codex, claude } = teamRoom();
  const staged = message('agent', 'Draft', 'Codex', codex.id); staged.stage = { index: 1, total: 3, name: 'Drafting "v1"' };
  assert.equal(renderEntry(staged, room), `<room from="Codex" stage="Drafting 'v1' (2/3)">\nDraft\n</room>`);
  room.mode = 'pipeline'; room.leadId = claude.id; room.team = BUILTIN_TEAMS[0];
  const framing = roomFraming(codex, room, ctx());
  assert.match(framing, /\nThis room works as a team in stages: Leads \(Claude\) → Drafting \(Codex\) → Review \(Claude, Copilot\)\.(\n|$)/);
  assert.doesNotMatch(framing, /leads this room|You lead/);
  room.team = undefined;
  assert.match(roomFraming(codex, room, ctx()), /\nClaude leads this room and may ask you for help\./, 'a pipeline room without a team works like Team mode');
});
test('worktrees: an isolated agent gets one framing line; the merge ask names the files; migration drops malformed worktree fields', () => {
  const { room, codex, claude } = teamRoom();
  const plain = roomFraming(codex, room, ctx());
  assert.doesNotMatch(plain, /worktree/);
  codex.worktree = { path: '/wt/roomaa-codex', branch: 'chatroom/roomaa/codex', createdAt: 1, checkpoints: 0 };
  const isolated = roomFraming(codex, room, ctx());
  assert.equal(isolated.split('\n').length, plain.split('\n').length + 1);
  assert.match(isolated, /\nYou work in your own git worktree \(branch chatroom\/roomaa\/codex\); your edits reach the user's folder only after the room combines and reviews them\. Other agents' changes reach you when the room combines the work\./);
  assert.doesNotMatch(roomFraming(claude, room, ctx()), /own git worktree/, 'only the isolated agent');
  assert.doesNotMatch(roomFraming(codex, room, ctx({ legacy: true })), /own git worktree/);
  assert.equal(turnAsk(claude, room, { kind: 'merge', merge: { files: ['src/a.ts', 'b.md'] } }),
    'Your changes conflict with the team\'s combined work in: src/a.ts, b.md. The conflict markers are in your files now. Resolve them so both changes\' intent is kept, then reply with one line saying what you kept.');
  assert.match(turnAsk(claude, room, { kind: 'merge', merge: { files: Array.from({ length: 25 }, (_, i) => `f${i}.ts`) } }), /f19\.ts and 5 more\./);
  const saved = JSON.parse(JSON.stringify({ ...room, worktrees: 'sometimes', changes: { base: 'b' } }));
  saved.agents[0].isolate = 'yes'; saved.agents[0].worktree = { path: 1 };
  saved.agents[1].isolate = true; saved.agents[1].worktree = { path: '/wt/x', branch: 'chatroom/x/y', createdAt: 1, checkpoints: 2 };
  const migrated = migrateRoom(saved, { attachEditor: true, shareSkills: true, permission: 'ask' });
  assert.equal(migrated.worktrees, undefined); assert.equal(migrated.changes, undefined);
  assert.equal(migrated.agents[0]!.isolate, undefined); assert.equal(migrated.agents[0]!.worktree, undefined);
  assert.equal(migrated.agents[1]!.isolate, true); assert.equal(migrated.agents[1]!.worktree!.checkpoints, 2);
  const kept = migrateRoom(JSON.parse(JSON.stringify({ ...room, worktrees: 'auto', changes: { base: 'b', branch: 'c', path: 'p', files: [], added: 0, removed: 0, status: 'ready', updatedAt: 1 } })), { attachEditor: true, shareSkills: true, permission: 'ask' });
  assert.equal(kept.worktrees, 'auto'); assert.equal(kept.changes!.branch, 'c');
});
