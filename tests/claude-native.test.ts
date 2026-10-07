import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDriver, claudeArgs, claudeUsage } from '../src/claude-native';
import { Agent, DriverSettings, NativeTurnRequest, ProviderError, Room, SkillWiring } from '../src/types';
import { FakeChild, RecordingSink, fakeHost, fakeSpawn, recordingSink, testAgent, testRoom, waitFor } from './helpers';

const SID = '16032f18-d3bb-443b-81b6-6b5d08f60562';
const FRAMING = 'You are Claude, one of the AI agents in Chatroom.';
const settings: DriverSettings = { allowFullAccess: false, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} };
// Shapes below are trimmed from lines captured from Claude Code 2.1.289 (stream-json, --include-partial-messages).
const INIT = {
  commands: [
    { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', builtin: true },
    { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
    { name: 'exit', description: 'Exit the REPL', builtin: true },
    { name: 'loop', description: 'Run a prompt or slash command on a recurring interval', argumentHint: '[interval] [prompt]', aliases: ['proactive'], builtin: true },
    { name: 'cowork-plugin-management:create-cowork-plugin', description: '(cowork-plugin-management) Create a plugin', argumentHint: '', aliases: ['create-cowork-plugin'] },
    { name: 'pdf', description: 'Work with PDF files', argumentHint: '' },
  ],
  agents: [{ name: 'Explore', description: 'Fast agent', model: 'inherit' }, { name: 'general-purpose', description: 'General' }],
  models: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
  ],
  account: { email: 'dev@example.com', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
  current_permission_mode: 'default',
};
/** The session id the CLI was started with, as its init event reports it. */
const sidOf = (child: FakeChild) => child.args[child.args.indexOf(child.args.includes('--resume') ? '--resume' : '--session-id') + 1]!;
const systemInit = (sid = SID) => ({ type: 'system', subtype: 'init', session_id: sid, tools: ['Bash', 'Read', 'Write', 'Skill', 'mcp__chatroom__search_documents'],
  mcp_servers: [{ name: 'chatroom', status: 'connected', source: 'sdk' }, { name: 'mem', status: 'pending', source: 'user' }], model: 'claude-haiku-4-5-20251001', permissionMode: 'default',
  slash_commands: ['compact', 'context', 'loop', 'pdf', 'review-local'], skills: ['loop', 'pdf'], plugins: [{ name: 'cowork-plugin-management', path: '/p', source: 'cowork-plugin-management@synced' }] });
const event = (e: object) => ({ type: 'stream_event', event: e, session_id: SID, parent_tool_use_id: null });
const textDelta = (text: string) => event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });
const result = (patch: object = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: SID, total_cost_usd: 0.05,
  usage: { input_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 70, output_tokens: 5, output_tokens_details: { thinking_tokens: 3 } }, ...patch });
const CONTROLS: Record<string, unknown> = {
  initialize: INIT, get_context_usage: { totalTokens: 50000, maxTokens: 200000, percentage: 25 }, mcp_status: { mcpServers: [{ name: 'chatroom', status: 'connected', scope: 'dynamic', tools: [{ name: 'a' }, { name: 'b' }] }] },
  interrupt: { still_queued: [] }, set_model: {}, apply_flag_settings: {}, set_permission_mode: { mode: 'default' },
};
interface Script { onUser?: (message: any, child: FakeChild, turn: number) => void; onSpawn?: (child: FakeChild, index: number) => void; controls?: Record<string, (request: any, child: FakeChild) => unknown> }
function claudeFake(script: Script = {}) {
  return fakeSpawn((child, index) => {
    let turns = 0;
    script.onSpawn?.(child, index);
    child.onLine(m => {
      if (m.type === 'control_request') {
        const subtype = m.request?.subtype, custom = script.controls?.[subtype];
        const response = custom ? custom(m.request, child) : subtype in CONTROLS ? CONTROLS[subtype] : {};
        if (response !== undefined) child.emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
      } else if (m.type === 'user') script.onUser?.(m, child, turns++);
    });
  });
}
/** A plain turn: init, one streamed text block, the result. */
const answer = (text: string, patch: object = {}) => (_m: any, child: FakeChild) => {
  child.emit(systemInit(sidOf(child)));
  child.emit(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
  child.emit(textDelta(text));
  child.emit({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: SID });
  child.emit(result({ result: text, ...patch }));
};
/** Like the engine: applies session patches to the agent. */
function sinkFor(agent: Agent, decide?: Parameters<typeof recordingSink>[0]): RecordingSink {
  const sink = recordingSink(decide), record = sink.session;
  sink.session = patch => { record(patch); agent.session = { ...agent.session, ...patch }; };
  return sink;
}
function request(agent: Agent, room: Room, sink: RecordingSink, patch: Partial<NativeTurnRequest> = {}): NativeTurnRequest {
  return { room, agent, kind: 'direct', framing: FRAMING, context: '<room from="User">\nhello\n</room>', fullContext: () => 'FULL HISTORY', ask: 'Answer the user.', flags: {},
    signal: new AbortController().signal, sink, ...patch };
}
function setup(script: Script = {}, agentPatch: Partial<Agent> = {}) {
  const fake = claudeFake(script), host = fakeHost(), driver = new ClaudeDriver(host, fake.spawn);
  const agent = testAgent('claude', agentPatch), room = testRoom([agent]);
  return { fake, host, driver, agent, room };
}
const userMessages = (child: FakeChild) => child.received.filter(m => m.type === 'user');
const controls = (child: FakeChild, subtype?: string) => child.received.filter(m => m.type === 'control_request' && (!subtype || m.request.subtype === subtype));
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('claudeArgs keeps Claude Code fully native and maps options to flags', () => {
  const agent = testAgent('claude'), room = testRoom([agent]);
  const args = claudeArgs(agent, room, undefined, { id: 'abc', resume: false }, undefined, settings, '/storage');
  assert.deepEqual(args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--thinking-display', 'summarized', '--session-id', 'abc']);
  for (const crippling of ['--tools', '--system-prompt', '--setting-sources', '--disable-slash-commands', '--no-session-persistence', 'dontAsk', '--strict-mcp-config', '--allow-dangerously-skip-permissions'])
    assert.ok(!args.includes(crippling), crippling);
  assert.deepEqual(claudeArgs(agent, room, undefined, { id: 'abc', resume: true }, undefined, settings, '/s').slice(-2), ['--resume', 'abc']);
  const mode = (permission: Agent['options']['permission'], allowFullAccess = false) =>
    claudeArgs(testAgent('claude', { options: { permission } as any }), room, undefined, { id: 'x', resume: false }, undefined, { ...settings, allowFullAccess }, '/s');
  assert.equal(argAfter(mode('plan'), '--permission-mode'), 'plan');
  assert.equal(argAfter(mode('auto-edit'), '--permission-mode'), 'acceptEdits');
  assert.equal(argAfter(mode('full', true), '--permission-mode'), 'bypassPermissions');
  assert.ok(mode('full', true).includes('--allow-dangerously-skip-permissions'));
  assert.equal(argAfter(mode('full'), '--permission-mode'), 'default', 'full access needs chatroom.allowFullAccess');
  assert.ok(!mode('full').includes('--allow-dangerously-skip-permissions'));
  const wiring: SkillWiring = { claudePluginDir: '/skills/claude/chatroom-shared', indexDir: '/skills', codexExtraRoots: [], skills: [] };
  const custom = testAgent('claude', { model: 'opus', options: { effort: 'high', thinking: 'off', useMcp: false, useProjectSettings: false, useSkills: false, webSearch: false, customAgent: 'reviewer', extraDirs: ['/extra'] } as any });
  const full = claudeArgs(custom, room, { id: 'opus', name: 'Opus', reasoning: ['low', 'high'] }, { id: 'x', resume: false }, wiring, { ...settings, sharedMcpServers: { docs: { command: 'docs-mcp' } } }, '/s');
  assert.equal(argAfter(full, '--model'), 'opus'); assert.equal(argAfter(full, '--effort'), 'high'); assert.equal(argAfter(full, '--thinking'), 'disabled');
  assert.equal(argAfter(full, '--plugin-dir'), '/skills/claude/chatroom-shared');
  assert.deepEqual(full.filter((_, i) => full[i - 1] === '--add-dir'), ['/skills', '/extra']);
  assert.deepEqual(JSON.parse(argAfter(full, '--mcp-config')!), { mcpServers: { docs: { command: 'docs-mcp' } } });
  assert.ok(full.includes('--strict-mcp-config')); assert.equal(argAfter(full, '--setting-sources'), 'user'); assert.ok(full.includes('--disable-slash-commands'));
  assert.equal(argAfter(full, '--disallowedTools'), 'WebSearch,WebFetch'); assert.equal(argAfter(full, '--agent'), 'reviewer');
  assert.ok(!claudeArgs(custom, room, { id: 'haiku', name: 'Haiku', reasoning: [] }, { id: 'x', resume: false }, wiring, settings, '/s').includes('--effort'), 'unsupported effort is not passed');
  assert.ok(!claudeArgs(custom, { ...room, shareSkills: false }, undefined, { id: 'x', resume: false }, wiring, settings, '/s').includes('--plugin-dir'));
});
test('claudeUsage counts cache reads and writes as input', () => {
  assert.deepEqual(claudeUsage({ input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, output_tokens: 5 }),
    { input: 100, output: 5, cached: 70, cacheWrite: 10, requests: 1, estimated: false });
  assert.deepEqual(claudeUsage(undefined), { input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 1, estimated: false });
});
test('a turn initializes with the room framing, reports the new session and sends editor, context and ask blocks', async () => {
  const { fake, driver, agent, room } = setup({ onUser: answer('Hello from Claude') });
  const sink = sinkFor(agent);
  const editor = { path: '/w/src/a.ts', relPath: 'src/a.ts', label: 'a.ts', kind: 'text' as const, selection: { startLine: 2, endLine: 3, text: 'x()' }, openTabs: [], key: '/w/src/a.ts#2-3' };
  const out = await driver.turn(request(agent, room, sink, { editor, flags: { think: true, ultra: true } }));
  assert.equal(out.status, 'complete'); assert.equal(out.text, 'Hello from Claude');
  const child = fake.children[0]!;
  assert.deepEqual(child.received[0], { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', hooks: {}, appendSystemPrompt: FRAMING, sdkMcpServers: ['chatroom'] } });
  const sid = argAfter(child.args, '--session-id')!;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal(sink.sessions[0]!.id, sid); assert.equal(sink.sessions[0]!.provider, 'claude'); assert.ok(sink.sessions[0]!.startedAt);
  const [message] = userMessages(child);
  assert.deepEqual(message.message.content.map((b: any) => b.text), [
    '<ide_selection>The user selected the lines 2 to 3 from /w/src/a.ts:\nx()\n\nThis may or may not be related to the current task.</ide_selection>',
    '<room from="User">\nhello\n</room>',
    'Answer the user.\n\nultrathink\n\nultracode']);
  assert.equal(message.parent_tool_use_id, null); assert.equal(message.session_id, '');
  assert.equal(child.env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');
  await driver.dispose();
});
test('empty context and ask still send a prompt, and ultra is skipped for a model without it', async () => {
  const { fake, driver, agent, room } = setup({ onUser: answer('ok') }, { model: 'haiku' });
  await driver.capabilities(room, agent);
  const sink = sinkFor(agent);
  await driver.turn(request(agent, room, sink, { context: '', ask: '', flags: { ultra: true } }));
  assert.deepEqual(userMessages(fake.children.at(-1)!)[0].message.content, [{ type: 'text', text: 'Continue.' }]);
  assert.ok(sink.activities.some(a => a.id === 'ultra'));
  await driver.dispose();
});
test('streaming maps text, thinking, tool activity, quota, permission mode and the result', async () => {
  const { driver, agent, room } = setup({ onUser: (_m, child) => {
    child.emit(systemInit(sidOf(child)));
    child.emit(event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    child.emit(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user is asking' } }));
    child.emit(event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' me to write.' } }));
    child.emit(event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
    child.emit(textDelta('Let me '));
    child.emit(textDelta('write it.'));
    child.emit(event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Edit', input: {} } }));
    child.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }] }, parent_tool_use_id: null });
    child.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1791320400, unifiedWindows: { five_hour: { utilization: 0.06 }, seven_day: { utilization: 0.34 } } } });
    child.emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'The file /w/a.ts has been updated.' }] }, parent_tool_use_id: null,
      tool_use_result: { filePath: '/w/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } });
    child.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
    child.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
    child.emit(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    child.emit(textDelta('Done.'));
    child.emit(result({ result: 'Done.' }));
  } });
  const sink = sinkFor(agent);
  const out = await driver.turn(request(agent, room, sink));
  assert.equal(out.text, 'Let me write it.\n\nDone.', 'the streamed text is kept when the result is its last block');
  assert.deepEqual(sink.texts, ['Let me ', 'Let me write it.', 'Let me write it.\n\nDone.']);
  assert.deepEqual(sink.thinkings, ['The user is asking', 'The user is asking me to write.']);
  const tool = sink.activities.filter(a => a.id === 'toolu_01');
  assert.deepEqual(tool.map(a => a.status), ['running', 'running', 'done']);
  assert.equal(tool[0]!.kind, 'edit'); assert.equal(tool[0]!.title, 'Edit'); assert.equal(tool[1]!.detail, '/w/a.ts');
  assert.equal(tool[2]!.detail, 'The file /w/a.ts has been updated.'); assert.equal(tool[2]!.diff, '@@ -1,1 +1,1 @@\n-a\n+b');
  assert.deepEqual(sink.sessions.find(s => s.quota)!.quota!.primaryUsedPercent, 6);
  assert.equal(sink.sessions.find(s => s.quota)!.quota!.secondaryUsedPercent, 34);
  assert.deepEqual(sink.optionPatches, [{ permission: 'plan' }], 'a raised mode stays in the process; only a lowered one is reported');
  assert.ok(sink.caps.some(c => c.tools.includes('mcp__chatroom__search_documents')));
  assert.deepEqual(out.usage, { input: 100, output: 5, cached: 70, cacheWrite: 10, requests: 1, estimated: false, cost: 0.05 });
  await waitFor(() => sink.sessions.find(s => s.context), 2000, 'context usage');
  assert.deepEqual(sink.sessions.find(s => s.context)!.context, { percent: 25, tokens: 50000, window: 200000 });
  await driver.dispose();
});
function permissionTurn(permission: object, decide: Parameters<typeof recordingSink>[0], agentPatch: Partial<Agent> = {}) {
  const setupResult = setup({ onUser: (_m, child) => {
    child.emit(systemInit(sidOf(child)));
    child.emit({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_use_id: 'toolu_01', ...permission } });
    child.onLine(m => { if (m.type === 'control_response' && m.response?.request_id === 'perm-1') child.emit(result()); });
  } }, agentPatch);
  const sink = sinkFor(setupResult.agent, decide);
  return { ...setupResult, sink, run: () => setupResult.driver.turn(request(setupResult.agent, setupResult.room, sink)) };
}
const reply = (child: FakeChild) => child.received.find(m => m.type === 'control_response' && m.response.request_id === 'perm-1')!.response;
const WRITE = { tool_name: 'Write', display_name: 'Write', input: { file_path: '/w/probe.txt', content: 'hi' }, description: 'probe.txt', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
const SESSION_RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' };
const BASH = { tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [SESSION_RULE, { ...SESSION_RULE, destination: 'localSettings' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
test('can_use_tool: allow returns the input, allow-session adds only session rules, deny returns the message', async () => {
  const allow = permissionTurn(WRITE, () => ({ decision: 'allow' }));
  await allow.run();
  assert.deepEqual(reply(allow.fake.children[0]!), { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow', updatedInput: WRITE.input, toolUseID: 'toolu_01' } });
  assert.deepEqual(allow.sink.approvals, [{ kind: 'edit', tool: 'Write', title: '/w/probe.txt', detail: 'hi', canAllowSession: false }], 'a setMode suggestion would raise the whole session to acceptEdits');
  await allow.driver.dispose();
  const session = permissionTurn(BASH, () => ({ decision: 'allow-session' }));
  await session.run();
  assert.equal(session.sink.approvals[0]!.canAllowSession, true);
  assert.deepEqual(reply(session.fake.children[0]!).response.updatedPermissions, [SESSION_RULE], 'no setMode, no settings-file destinations');
  await session.driver.dispose();
  const forced = permissionTurn(WRITE, () => ({ decision: 'allow-session' }));
  await forced.run();
  assert.equal(reply(forced.fake.children[0]!).response.updatedPermissions, undefined);
  await forced.driver.dispose();
  const deny = permissionTurn({ tool_name: 'Bash', input: { command: 'rm -rf build' }, decision_reason: 'Not pre-approved' }, () => ({ decision: 'deny', message: 'Not now' }));
  await deny.run();
  assert.deepEqual(reply(deny.fake.children[0]!).response, { behavior: 'deny', message: 'Not now', toolUseID: 'toolu_01' });
  assert.equal(deny.sink.approvals[0]!.kind, 'command'); assert.equal(deny.sink.approvals[0]!.title, 'rm -rf build');
  assert.match(deny.sink.approvals[0]!.detail!, /"command": "rm -rf build"[\s\S]*Not pre-approved/);
  assert.equal(deny.sink.approvals[0]!.canAllowSession, false);
  await deny.driver.dispose();
  const plain = permissionTurn({ tool_name: 'Bash', input: { command: 'ls' } }, () => ({ decision: 'deny' }));
  await plain.run();
  assert.equal(reply(plain.fake.children[0]!).response.message, 'The user denied this in Chatroom.');
  await plain.driver.dispose();
});
test('can_use_tool: room tools are allowed and AskUserQuestion denied without asking the user', async () => {
  const room = permissionTurn({ tool_name: 'mcp__chatroom__search_documents', input: { query: 'x' } }, () => { throw new Error('should not ask'); });
  await room.run();
  assert.equal(reply(room.fake.children[0]!).response.behavior, 'allow'); assert.equal(room.sink.approvals.length, 0);
  await room.driver.dispose();
  // Another server whose name starts with "chatroom__" is not the room server, in any mode.
  const other = permissionTurn({ tool_name: 'mcp__chatroom__ops__delete_branch', input: { branch: 'main' } }, () => ({ decision: 'deny' }), { options: { permission: 'plan' } as any });
  await other.run();
  assert.equal(other.sink.approvals.length, 1); assert.equal(reply(other.fake.children[0]!).response.behavior, 'deny');
  await other.driver.dispose();
  const ask = permissionTurn({ tool_name: 'AskUserQuestion', input: { questions: [] } }, () => { throw new Error('should not ask'); });
  await ask.run();
  assert.deepEqual(reply(ask.fake.children[0]!).response, { behavior: 'deny', message: "Chatroom can't show interactive questions. Ask the user in your reply instead.", toolUseID: 'toolu_01' });
  assert.equal(ask.sink.approvals.length, 0);
  await ask.driver.dispose();
});
test('an allowed ExitPlanMode switches the agent to ask', async () => {
  const plan = permissionTurn({ tool_name: 'ExitPlanMode', input: { plan: '1. Edit a.ts' } }, () => ({ decision: 'allow' }), { options: { permission: 'plan' } as any });
  await plan.run();
  assert.equal(plan.sink.approvals[0]!.kind, 'plan'); assert.equal(plan.sink.approvals[0]!.detail, '1. Edit a.ts');
  assert.deepEqual(plan.sink.optionPatches, [{ permission: 'ask', exitPlan: true }]);
  assert.equal(argAfter(plan.fake.children[0]!.args, '--permission-mode'), 'plan');
  await plan.driver.dispose();
});
test('mcp_message is answered by the room tools, including notifications', async () => {
  const { fake, driver, agent, room, host } = setup({ onSpawn: child => {
    child.emit({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'mcp_message', server_name: 'chatroom', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } });
    child.emit({ type: 'control_request', request_id: 'mcp-2', request: { subtype: 'mcp_message', server_name: 'chatroom', message: { jsonrpc: '2.0', method: 'notifications/initialized' } } });
    child.emit({ type: 'control_request', request_id: 'odd-1', request: { subtype: 'request_user_dialog' } });
  } });
  await driver.capabilities(room, agent);
  const child = fake.children[0]!;
  await waitFor(() => child.received.filter(m => m.type === 'control_response').length === 3, 2000, 'replies');
  const byId = (id: string) => child.received.find(m => m.type === 'control_response' && m.response.request_id === id).response;
  assert.equal(byId('mcp-1').response.mcp_response.id, 1);
  assert.deepEqual(byId('mcp-1').response.mcp_response.result.tools.map((t: any) => t.name), host.tools.definitions().map(t => t.name));
  assert.deepEqual(byId('mcp-2').response, { mcp_response: { jsonrpc: '2.0', result: {} } });
  assert.deepEqual(byId('odd-1'), { subtype: 'error', request_id: 'odd-1', error: 'Unsupported by Chatroom' });
  await driver.dispose();
});
test('cost is a delta of the cumulative total across turns in one process; usage is per turn', async () => {
  const { fake, driver, agent, room } = setup({ onUser: (m, child, turn) => answer('ok', { total_cost_usd: turn === 0 ? 0.05 : 0.08 })(m, child) });
  const first = await driver.turn(request(agent, room, sinkFor(agent)));
  const second = await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(fake.children.length, 1, 'one process serves both turns');
  assert.equal(first.usage.cost, 0.05); assert.ok(Math.abs(second.usage.cost! - 0.03) < 1e-9);
  assert.equal(agent.session?.cost, 0.08);
  await driver.dispose();
});
test('a resumed process measures cost from the stored session cost', async () => {
  const { driver, agent, room } = setup({ onUser: answer('ok', { total_cost_usd: 0.5 }) }, { session: { id: SID, cost: 0.4 } });
  const out = await driver.turn(request(agent, room, sinkFor(agent)));
  assert.ok(Math.abs(out.usage.cost! - 0.1) < 1e-9);
  await driver.dispose();
});
test('an error result becomes a ProviderError with a precise code', async () => {
  const failing = (text: string) => setup({ onUser: (_m, child) => { child.emit(systemInit(sidOf(child))); child.emit(result({ subtype: 'success', is_error: true, result: text })); } });
  const limit = failing('Claude AI usage limit reached|1791320400');
  await assert.rejects(limit.driver.turn(request(limit.agent, limit.room, sinkFor(limit.agent))), (e: unknown) => e instanceof ProviderError && e.code === 'usage-limit' && /usage limit/.test(e.message));
  await limit.driver.dispose();
  const login = failing('Invalid API key · Please run /login');
  await assert.rejects(login.driver.turn(request(login.agent, login.room, sinkFor(login.agent))), (e: unknown) => e instanceof ProviderError && e.code === 'signed-out');
  await login.driver.dispose();
  const other = setup({ onUser: (_m, child) => child.emit(result({ subtype: 'error_max_turns', is_error: true, result: '', errors: ['Reached max turns'] })) });
  await assert.rejects(other.driver.turn(request(other.agent, other.room, sinkFor(other.agent))), (e: unknown) => e instanceof ProviderError && e.code === 'failed' && /Reached max turns/.test(e.message));
  await other.driver.dispose();
});
test('a process that dies mid-turn is reported as crashed with its stderr', async () => {
  const { driver, agent, room } = setup({ onUser: (_m, child) => { child.emit(systemInit(sidOf(child))); child.stderr('panic: something broke'); child.exit(3); } });
  await assert.rejects(driver.turn(request(agent, room, sinkFor(agent))), (e: unknown) => e instanceof ProviderError && e.code === 'crashed' && /code 3/.test(e.message) && /something broke/.test(e.message));
  await driver.dispose();
});
test('abort sends an interrupt control request and resolves interrupted with the partial text', async () => {
  const { fake, driver, agent, room } = setup({
    onUser: (_m, child) => { child.emit(systemInit(sidOf(child))); child.emit(textDelta('partial')); },
    controls: { interrupt: (_r, child) => { child.emit(result({ subtype: 'error_during_execution', is_error: true, result: '' })); return { still_queued: [] }; } },
  });
  const controller = new AbortController(), sink = sinkFor(agent);
  const run = driver.turn(request(agent, room, sink, { signal: controller.signal }));
  await waitFor(() => sink.texts.includes('partial'), 2000, 'partial text');
  controller.abort();
  const out = await run;
  assert.equal(out.status, 'interrupted'); assert.equal(out.text, 'partial'); assert.equal(out.delivered, true, 'the CLI already had the message');
  assert.equal(controls(fake.children[0]!, 'interrupt').length, 1);
  assert.equal(fake.children[0]!.killed, false, 'the session process stays alive');
  await driver.dispose();
});
test('a session that cannot be resumed starts fresh with the bounded room history', async () => {
  const { fake, driver, agent, room } = setup({
    onSpawn: (child, index) => {
      if (index > 0) return;
      child.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: 'old', errors: ['No conversation found with session ID: old-session'] });
      child.stderr('No conversation found with session ID: old-session\n'); child.exit(1);
    },
    onUser: answer('fresh start'),
  }, { session: { id: 'old-session', seen: 'm1' } });
  const sink = sinkFor(agent);
  const out = await driver.turn(request(agent, room, sink));
  assert.equal(out.text, 'fresh start');
  assert.equal(fake.children.length, 2);
  assert.equal(argAfter(fake.children[0]!.args, '--resume'), 'old-session');
  const fresh = argAfter(fake.children[1]!.args, '--session-id')!;
  assert.ok(fresh && fresh !== 'old-session' && !fake.children[1]!.args.includes('--resume'));
  assert.deepEqual(sink.sessions[0]!.id, fresh); assert.equal(agent.session?.id, fresh);
  assert.ok(sink.activities.some(a => a.title === 'Previous session could not be resumed · started a new one with recent room history'));
  const texts = userMessages(fake.children[1]!)[0].message.content.map((b: any) => b.text);
  assert.deepEqual(texts, ['FULL HISTORY', 'Answer the user.']);
  await driver.dispose();
});
test('live controls change model and effort in place; a thinking change respawns with --resume', async () => {
  const { fake, driver, agent, room } = setup({ onUser: answer('ok') });
  await driver.turn(request(agent, room, sinkFor(agent)));
  const sid = agent.session!.id!;
  agent.model = 'opus'; agent.options.effort = 'high'; agent.options.permission = 'plan'; agent.options.ultra = true;
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(fake.children.length, 1);
  const first = fake.children[0]!;
  const sent = first.received.filter(m => m.type === 'user' || (m.type === 'control_request' && !['initialize', 'get_context_usage', 'mcp_status'].includes(m.request.subtype)));
  assert.deepEqual(sent.map(m => m.type === 'user' ? 'user' : m.request), ['user',
    { subtype: 'set_model', model: 'opus' }, { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
    { subtype: 'apply_flag_settings', settings: { ultracode: true } }, { subtype: 'set_permission_mode', mode: 'plan' }, 'user']);
  agent.options.thinking = 'off';
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(fake.children.length, 2);
  assert.equal(first.stdinEnded, true, 'the old process was closed');
  const second = fake.children[1]!;
  assert.equal(argAfter(second.args, '--resume'), sid); assert.equal(argAfter(second.args, '--thinking'), 'disabled');
  assert.equal(argAfter(second.args, '--model'), 'opus'); assert.equal(argAfter(second.args, '--permission-mode'), 'plan');
  assert.equal(controls(second, 'set_model').length, 0, 'spawn flags already carry the options');
  await driver.dispose();
});
test('a full-access change respawns; full access auto-allows tools when enabled', async () => {
  const fake = claudeFake({ onUser: (_m, child) => {
    child.emit({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make' }, tool_use_id: 't' } });
    child.onLine(m => { if (m.type === 'control_response' && m.response?.request_id === 'perm-1') child.emit(result()); });
  } });
  const host = fakeHost({ settings: () => ({ ...settings, allowFullAccess: true }) }), driver = new ClaudeDriver(host, fake.spawn);
  const agent = testAgent('claude'), room = testRoom([agent]);
  await driver.turn(request(agent, room, sinkFor(agent, () => ({ decision: 'allow' }))));
  agent.options.permission = 'full';
  const sink = sinkFor(agent, () => { throw new Error('should not ask'); });
  await driver.turn(request(agent, room, sink));
  assert.equal(fake.children.length, 2);
  assert.ok(fake.children[1]!.args.includes('--allow-dangerously-skip-permissions'));
  assert.equal(sink.approvals.length, 0);
  await driver.dispose();
});
test('commands: compact sends /compact; unknown commands are refused; no session means nothing to do', async () => {
  const { fake, driver, agent, room } = setup({ onUser: (m, child) => {
    if (m.message.content === '/compact focus on tests') {
      child.emit({ type: 'system', subtype: 'status', status: 'compacting' });
      child.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
      child.emit(systemInit(sidOf(child)));
      child.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 29045, post_tokens: 3075 } });
      child.emit(result({ num_turns: 0, result: '', local_command: 'compact', usage: {} }));
    } else child.emit(result({ num_turns: 0, result: '## Context Usage' }));
  } });
  const none = await driver.turn(request(agent, room, sinkFor(agent), { command: { name: 'compact', args: '' } }));
  assert.deepEqual(none, { text: 'No session yet: nothing to compact.', usage: { input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0, estimated: false }, status: 'complete' });
  assert.equal(fake.children.length, 0);
  agent.session = { id: SID };
  const sink = sinkFor(agent);
  const compact = await driver.turn(request(agent, room, sink, { command: { name: 'compact', args: 'focus on tests' } }));
  assert.equal(compact.text, 'Compacted 29k → 3.1k tokens');
  assert.deepEqual([compact.usage.input, compact.usage.output, compact.usage.estimated], [29045, 3075, true], 'no usage in the result: estimated from the compaction');
  assert.equal(userMessages(fake.children[0]!)[0].message.content, '/compact focus on tests');
  assert.deepEqual(sink.activities.filter(a => a.id === 'compact').map(a => a.status), ['running', 'done']);
  const context = await driver.turn(request(agent, room, sinkFor(agent), { command: { name: 'context', args: '' } }));
  assert.equal(context.text, '## Context Usage');
  await assert.rejects(driver.turn(request(agent, room, sinkFor(agent), { command: { name: 'nope', args: '' } })), (e: unknown) => e instanceof ProviderError && e.code === 'unsupported' && /no \/nope command/.test(e.message));
  const alias = await driver.turn(request(agent, room, sinkFor(agent), { command: { name: 'proactive', args: '5m check' } }));
  assert.equal(alias.status, 'complete');
  assert.deepEqual(userMessages(fake.children[0]!).map(m => m.message.content), ['/compact focus on tests', '/context', '/proactive 5m check']);
  await driver.dispose();
});
test('capabilities come from initialize, mcp_status and init without starting inference', async () => {
  const { fake, driver, agent, room } = setup({ onUser: answer('ok') });
  const caps = await driver.capabilities(room, agent);
  assert.equal(userMessages(fake.children[0]!).length, 0);
  assert.equal(caps.status, 'ready'); assert.equal(caps.version, '9.9.9'); assert.equal(caps.account, 'dev@example.com · Claude Max');
  assert.deepEqual(caps.models.map(m => m.id), ['default', 'opus', 'haiku']);
  assert.deepEqual(caps.models[0], { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, ultra: true, isDefault: true });
  assert.deepEqual(caps.models[2]!.reasoning, []); assert.equal(caps.models[2]!.ultra, false);
  assert.deepEqual(caps.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(caps.agents, ['Explore', 'general-purpose']);
  assert.deepEqual(caps.mcpServers, [{ name: 'chatroom', status: 'connected', tools: 2 }]);
  const names = caps.commands.map(c => c.name);
  assert.ok(names.includes('loop') && names.includes('pdf') && names.includes('cowork-plugin-management:create-cowork-plugin'));
  assert.ok(!names.includes('exit'), 'denylisted commands are filtered');
  assert.equal(caps.commands.find(c => c.name === 'cowork-plugin-management:create-cowork-plugin')!.source, 'plugin');
  assert.equal(caps.commands.find(c => c.name === 'pdf')!.source, 'skill');
  assert.equal(caps.supports.ultraTurn, true); assert.equal(caps.supports.thinking, true);
  const sink = sinkFor(agent);
  await driver.turn(request(agent, room, sink));
  assert.equal(fake.children.length, 2, 'the discovery process had no room framing, so the first turn respawns');
  assert.equal(argAfter(fake.children[1]!.args, '--session-id'), argAfter(fake.children[0]!.args, '--session-id'), 'the new session id is kept');
  assert.equal(fake.children[1]!.received[0].request.appendSystemPrompt, FRAMING);
  const turnCaps = sink.caps.at(-1)!;
  assert.deepEqual(turnCaps.skills.map(s => s.name), ['loop', 'pdf']);
  assert.ok(turnCaps.commands.some(c => c.name === 'review-local'), 'slash_commands from init are merged');
  assert.deepEqual(turnCaps.plugins, ['cowork-plugin-management']);
  const again = await driver.capabilities(room, agent);
  assert.equal(fake.children.length, 2, 'a live process answers later capability requests');
  assert.equal(again.tools.length, 5);
  await driver.dispose();
});
test('a capabilities process started with the host framing serves the first turn', async () => {
  const fake = claudeFake({ onUser: answer('ok') });
  const driver = new ClaudeDriver(fakeHost({ framing: () => FRAMING }), fake.spawn);
  const agent = testAgent('claude'), room = testRoom([agent]);
  await driver.capabilities(room, agent);
  assert.equal(fake.children[0]!.received[0].request.appendSystemPrompt, FRAMING);
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(fake.children.length, 1, 'no respawn on the first turn');
  assert.equal(userMessages(fake.children[0]!).length, 1);
  await driver.dispose();
});
test('/compact usage is the growth of the cumulative modelUsage when the process has a baseline', async () => {
  const models = (input: number, output: number, read: number, write: number) => ({ 'claude-x': { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write } });
  const { driver, agent, room } = setup({ onUser: (m, child) => {
    if (m.message.content === '/compact') child.emit(result({ num_turns: 0, result: '', usage: {}, modelUsage: models(400, 60, 250, 20) }));
    else answer('ok', { modelUsage: models(100, 10, 50, 0) })(m, child);
  } });
  await driver.turn(request(agent, room, sinkFor(agent)));
  const compact = await driver.turn(request(agent, room, sinkFor(agent), { command: { name: 'compact', args: '' } }));
  assert.deepEqual(compact.usage, { input: 520, output: 50, cached: 200, cacheWrite: 20, requests: 1, estimated: false, cost: 0 });
  await driver.dispose();
});
test('a command on a session that cannot be resumed fails; the next message starts the new session with the room history', async () => {
  const { fake, driver, agent, room } = setup({
    onSpawn: (child, index) => { if (index === 0) { child.stderr('No conversation found with session ID: old-session\n'); child.exit(1); } },
    onUser: answer('fresh'),
  }, { session: { id: 'old-session', seen: 'm9' } });
  await assert.rejects(driver.turn(request(agent, room, sinkFor(agent), { command: { name: 'compact', args: '' }, context: '', ask: '', fullContext: () => '' })),
    (e: unknown) => e instanceof ProviderError && e.code === 'session-lost');
  assert.equal(agent.session!.id, 'old-session', 'the agent is not switched to an empty session');
  await driver.turn(request(agent, room, sinkFor(agent), { context: 'DELTA ONLY' }));
  assert.equal(fake.children.length, 2, 'the fresh process is reused');
  assert.deepEqual(userMessages(fake.children[1]!).map(m => m.message.content.map((b: any) => b.text)), [['FULL HISTORY', 'Answer the user.']]);
  assert.notEqual(agent.session!.id, 'old-session');
  await driver.dispose();
});
test('capabilities report a missing runtime and startup failures without throwing', async () => {
  const missing = new ClaudeDriver(fakeHost({ runtime: async () => undefined }), claudeFake().spawn);
  const agent = testAgent('claude'), room = testRoom([agent]);
  assert.equal((await missing.capabilities(room, agent)).status, 'missing');
  await assert.rejects(missing.turn(request(agent, room, sinkFor(agent))), (e: unknown) => e instanceof ProviderError && e.code === 'missing');
  const broken = setup({ onSpawn: child => { child.stderr('Not logged in · Please run /login'); child.exit(1); } });
  const caps = await broken.driver.capabilities(broken.room, broken.agent);
  assert.equal(caps.status, 'signed-out'); assert.match(caps.detail!, /login/);
});
test('release closes the processes of a room; the next turn resumes the stored session', async () => {
  const { fake, driver, agent, room } = setup({ onUser: answer('ok') });
  await driver.turn(request(agent, room, sinkFor(agent)));
  await driver.release('other-room');
  assert.equal(fake.children[0]!.stdinEnded, false);
  await driver.release(room.id, agent.id);
  assert.equal(fake.children[0]!.stdinEnded, true);
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(argAfter(fake.children[1]!.args, '--resume'), agent.session!.id);
  await driver.dispose();
});
test('the process starts in the agent\'s folder from host.cwdFor; another folder never reuses the live process', async () => {
  let folder = '/work/wt/roomaa-claude';
  const fake = claudeFake({ onUser: answer('ok') }), host = fakeHost({ cwdFor: () => folder }), driver = new ClaudeDriver(host, fake.spawn);
  const agent = testAgent('claude'), room = testRoom([agent]);
  await driver.turn(request(agent, room, sinkFor(agent)));
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(fake.children.length, 1); assert.equal(fake.children[0]!.cwd, '/work/wt/roomaa-claude');
  folder = host.cwd();
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(fake.children.length, 2, 'a new folder means a new process'); assert.equal(fake.children[1]!.cwd, host.cwd());
  assert.equal(fake.children[0]!.stdinEnded, true);
  await driver.dispose();
});
