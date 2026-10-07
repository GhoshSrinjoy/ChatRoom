import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CodexDriver, EFFORT_ORDER, bumpEffort, codexPolicy, commandTitle } from '../src/codex-native';
import { codexEditorText } from '../src/editor-context';
import { Agent, ApprovalDecision, ApprovalRequest, DriverHost, EditorSnapshot, NativeTurnRequest, ProviderError, Room } from '../src/types';
import { FakeChild, RecordingSink, fakeHost, fakeSpawn, recordingSink, rpcPeer, testAgent, testRoom, waitFor } from './helpers';

type Peer = ReturnType<typeof rpcPeer>;
type Handlers = Record<string, (params: any, id: string | number, peer: Peer, child: FakeChild) => unknown>;
const later = (run: () => void, ms = 5) => { setTimeout(run, ms); };
const MODELS = [
  { id: 'gpt-luna', model: 'gpt-luna', displayName: 'Luna', description: 'Fast', hidden: false, isDefault: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] },
  { id: 'gpt-hidden', model: 'gpt-hidden', displayName: 'Hidden', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
  { id: 'gpt-sol', model: 'gpt-sol', displayName: 'Sol', description: 'Frontier', hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) },
];
/** The default turn: one agent message streamed in two deltas, token usage, then completion. */
function finishTurn(peer: Peer, threadId: string, turnId: string, text = 'Done.') {
  later(() => {
    peer.notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    peer.notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: `${turnId}-m`, text: '' } });
    peer.notify('item/agentMessage/delta', { threadId, turnId, itemId: `${turnId}-m`, delta: text.slice(0, 2) });
    peer.notify('item/agentMessage/delta', { threadId, turnId, itemId: `${turnId}-m`, delta: text.slice(2) });
    peer.notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `${turnId}-m`, text, phase: 'final_answer' } });
    peer.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } });
  });
}
function setup(overrides: Handlers = {}, hostPatch: Partial<DriverHost> = {}) {
  const peers: Peer[] = [];
  let threads = 0, turns = 0;
  const defaults: Handlers = {
    initialize: () => ({ userAgent: 'codex/0.160.1', codexHome: '/home/.codex', platformFamily: 'windows', platformOs: 'windows' }),
    'model/list': params => params?.cursor ? { data: MODELS.slice(1), nextCursor: null } : { data: MODELS.slice(0, 1), nextCursor: 'page-2' },
    // Like codex 0.160.1: the status list includes the built-in apps server, config/read lists only config.toml servers,
    // and a config that names codex_apps (it has no transport) fails to load.
    'mcpServerStatus/list': () => ({ data: [{ name: 'mem', runtimeStatus: null, authStatus: 'unknown', tools: { recall: {}, remember: {} }, toolsError: null },
      { name: 'codex_apps', runtimeStatus: null, authStatus: 'unknown', tools: { apps: {} }, toolsError: null }], nextCursor: null }),
    'config/read': () => ({ config: { mcp_servers: { mem: { command: 'mem.exe' } } }, origins: {}, layers: null }),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/start': params => {
      if (Object.keys(params?.config ?? {}).some(k => k.startsWith('mcp_servers.codex_apps'))) throw { code: -32600, message: 'failed to load configuration: invalid transport\nin `mcp_servers.codex_apps`' };
      return { thread: { id: `thread-${++threads}` }, model: 'gpt-sol' };
    },
    'thread/resume': params => ({ thread: { id: params.threadId }, model: 'gpt-sol' }),
    'thread/inject_items': () => ({}),
    'turn/start': (params, _id, peer) => { const turnId = `turn-${++turns}`; finishTurn(peer, params.threadId, turnId); return { turn: { id: turnId, status: 'inProgress', items: [] } }; },
    'turn/interrupt': () => ({}),
    'skills/list': params => ({ data: [{ cwd: params.cwds?.[0], errors: [], skills: [
      { name: 'pdf-tools', description: 'Work with PDFs', path: '/skills/pdf-tools/SKILL.md', scope: 'user', enabled: true, pluginId: null },
      { name: 'off-skill', description: 'Disabled', path: '/skills/off/SKILL.md', scope: 'user', enabled: false, pluginId: null }] }] }),
    'skills/extraRoots/set': () => ({}),
    'account/read': () => ({ account: { type: 'chatgpt', email: 'dev@example.com', planType: 'plus' }, requiresOpenaiAuth: true }),
    'account/rateLimits/read': () => ({ rateLimits: { primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1791307481 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791580982 } } }),
  };
  const handlers = { ...defaults, ...overrides };
  const fake = fakeSpawn(child => {
    child.exitOnEnd = true;
    const peer = rpcPeer(child, 'codex', Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, (params: any, id: string | number) => handler(params, id, peer, child)])));
    peers.push(peer);
  });
  const host = fakeHost(hostPatch);
  const driver = new CodexDriver(host, fake.spawn);
  const sent = (method: string, child = 0) => (fake.children[child]?.received ?? []).filter(m => m?.method === method);
  return { driver, host, children: fake.children, peers, sent };
}
/** A sink that also stores session patches on the agent, as the engine does. */
function sinkFor(agent: Agent, decide?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>): RecordingSink {
  const sink = recordingSink(decide);
  const record = sink.session;
  sink.session = patch => { record(patch); agent.session = { ...agent.session, ...patch }; };
  return sink;
}
function request(agent: Agent, room: Room, sink: RecordingSink, patch: Partial<NativeTurnRequest> = {}): NativeTurnRequest {
  return { room, agent, kind: 'direct', framing: 'You are Codex in the room.', context: '', fullContext: () => '<room from="User">FULL HISTORY</room>', ask: 'Fix the bug.',
    flags: {}, signal: new AbortController().signal, sink, ...patch };
}

test('bumpEffort and EFFORT_ORDER follow the think-hard rule', () => {
  assert.deepEqual(EFFORT_ORDER, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(bumpEffort('medium', ['low', 'medium', 'high', 'xhigh']), 'high');
  assert.equal(bumpEffort('low', ['low', 'medium', 'high']), 'high');
  assert.equal(bumpEffort('high', ['low', 'medium', 'high', 'xhigh', 'ultra']), 'xhigh');
  assert.equal(bumpEffort('max', ['low', 'max', 'ultra']), 'max');
  assert.equal(bumpEffort('low', ['low', 'medium']), 'medium');
  assert.equal(bumpEffort('medium', []), 'medium');
});

test('codexPolicy maps the four permission levels and the sandbox override', () => {
  const options = testAgent('codex').options;
  assert.deepEqual(codexPolicy({ ...options, permission: 'plan' }, []), { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false }, plan: true });
  assert.deepEqual(codexPolicy({ ...options, permission: 'ask' }, []), { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false }, plan: false });
  assert.deepEqual(codexPolicy({ ...options, permission: 'auto-edit' }, ['/extra']), { approvalPolicy: 'on-request', sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, plan: false });
  assert.deepEqual(codexPolicy({ ...options, permission: 'full' }, []), { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, plan: false });
  assert.equal(codexPolicy({ ...options, permission: 'ask', sandbox: 'workspace-write' }, []).sandbox, 'read-only', 'an override never loosens Ask');
  assert.equal(codexPolicy({ ...options, permission: 'auto-edit', sandbox: 'danger-full-access' }, []).sandbox, 'workspace-write', 'an override never loosens Auto-edit');
  assert.equal(codexPolicy({ ...options, permission: 'auto-edit', sandbox: 'read-only' }, []).sandbox, 'read-only', 'an override may tighten');
  assert.equal(codexPolicy({ ...options, permission: 'plan', sandbox: 'danger-full-access' }, []).sandbox, 'read-only');
});

test('commandTitle strips the PowerShell wrapper', () => {
  assert.equal(commandTitle('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command \'Get-ChildItem -Force\''), 'Get-ChildItem -Force');
  assert.equal(commandTitle('pwsh.exe -Command "npm test"'), 'npm test');
  assert.equal(commandTitle('pwsh -Command \'echo \'\'hi\'\'\''), "echo 'hi'");
  assert.equal(commandTitle(['git', 'status']), 'git status');
  assert.equal(commandTitle('npm run build'), 'npm run build');
  // pwsh joins every argument after -Command: with more than one quoted part nothing is unwrapped.
  const two = "pwsh.exe -Command 'Remove-Item -Recurse $HOME\\Documents;' 'Write-Output ''listing files'''";
  assert.equal(commandTitle(two), two);
  const long = commandTitle(`pwsh -Command '${'a'.repeat(400)}'`);
  assert.equal(long.length, 300); assert.ok(long.endsWith('…'));
});

test('startup: initialize with experimentalApi, initialized, paged model/list; scrubbed env and codex-path on PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bin-')); mkdirSync(join(dir, 'codex-path'));
  const previous = process.env.CLAUDECODE; process.env.CLAUDECODE = '1';
  try {
    const { driver, children, sent } = setup({}, { runtime: async () => ({ executable: { command: join(dir, 'codex.exe'), prefix: [] }, version: '0.160.1', source: 'test', modern: true }) });
    const agent = testAgent('codex'), room = testRoom([agent]);
    const result = await driver.turn(request(agent, room, sinkFor(agent)));
    assert.equal(result.text, 'Done.');
    const child = children[0]!;
    assert.deepEqual(child.args, ['app-server']);
    assert.equal(child.env.CLAUDECODE, undefined);
    assert.equal(child.env.RUST_LOG, 'warn');
    const pathKey = Object.keys(child.env).find(k => k.toUpperCase() === 'PATH')!;
    assert.equal(child.env[pathKey]!.split(delimiter)[0], join(dir, 'codex-path'));
    const methods = child.received.map(m => m.method);
    assert.deepEqual(methods.slice(0, 4), ['initialize', 'initialized', 'model/list', 'model/list']);
    const init = child.received[0];
    assert.deepEqual(init.params.clientInfo, { name: 'chatroom', title: 'Chatroom', version: '0.4.0-test' });
    assert.equal(init.params.capabilities.experimentalApi, true);
    assert.equal('jsonrpc' in init, false);
    assert.deepEqual(sent('model/list')[1].params, { limit: 100, includeHidden: false, cursor: 'page-2' });
    await driver.dispose();
  } finally { if (previous === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = previous; }
});

test('thread/start carries the framing, policy, dynamic tools and config; context is injected; editor, effort and plan mode go on turn/start', async () => {
  const { driver, host, sent } = setup();
  const agent = testAgent('codex', { options: { ...testAgent('codex').options, permission: 'plan', webSearch: false, useMcp: false, summary: 'concise' } });
  const room = testRoom([agent]);
  const sink = sinkFor(agent);
  const editor: EditorSnapshot = { path: '/w/src/a.ts', relPath: 'src/a.ts', label: 'a.ts', kind: 'text', selection: { startLine: 3, endLine: 4, text: 'let x = 1;' }, openTabs: [{ label: 'b.ts', relPath: 'src/b.ts' }], key: 'k' };
  await driver.turn(request(agent, room, sink, { context: '<room from="Claude">I found it.</room>', editor }));
  const start = sent('thread/start')[0].params;
  assert.equal(start.developerInstructions, 'You are Codex in the room.');
  assert.equal('baseInstructions' in start, false);
  assert.equal('ephemeral' in start, false);
  assert.equal(start.approvalPolicy, 'never'); assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalsReviewer, 'user');
  assert.equal(start.model, null);
  assert.deepEqual(start.dynamicTools, host.roomTools.definitions().map(d => ({ type: 'function', name: d.name, description: d.description, inputSchema: d.inputSchema })));
  assert.deepEqual(start.config, { model_reasoning_summary: 'concise', web_search: 'disabled', 'mcp_servers.mem.enabled': false, 'features.apps': false, project_doc_fallback_filenames: ['CLAUDE.md'] });
  assert.deepEqual(sink.sessions[0], { id: 'thread-1', provider: 'codex', startedAt: sink.sessions[0]!.startedAt });
  assert.deepEqual(sent('thread/inject_items')[0].params, { threadId: 'thread-1', items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<room from="Claude">I found it.</room>' }] }] });
  const turn = sent('turn/start')[0].params;
  assert.deepEqual(turn.input, [{ type: 'text', text: codexEditorText(editor, 'Fix the bug.'), text_elements: [] }]);
  assert.equal(turn.model, 'gpt-sol'); assert.equal(turn.effort, 'low'); assert.equal(turn.summary, 'concise');
  assert.equal(turn.approvalPolicy, 'never'); assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.collaborationMode, { mode: 'plan', settings: { model: 'gpt-sol', reasoning_effort: 'low', developer_instructions: null } });
  // Second turn: same thread, no context means no inject, default mode.
  agent.options.permission = 'ask';
  await driver.turn(request(agent, room, sink, { ask: '' }));
  assert.equal(sent('thread/start').length, 1); assert.equal(sent('thread/resume').length, 0);
  assert.equal(sent('thread/inject_items').length, 1);
  const second = sent('turn/start')[1].params;
  assert.equal(second.input[0].text, 'Continue.');
  assert.equal(second.collaborationMode.mode, 'default'); assert.equal(second.approvalPolicy, 'on-request');
  await driver.dispose();
});

test('think bumps effort one level; ultra uses ultra or falls back to the highest effort', async () => {
  const { driver, sent } = setup();
  const luna = testAgent('codex', { model: 'gpt-luna' }), sol = testAgent('codex', { id: 'codex-2', model: 'gpt-sol' });
  const room = testRoom([luna, sol]);
  await driver.turn(request(luna, room, sinkFor(luna), { flags: { think: true } }));
  assert.equal(sent('turn/start')[0].params.effort, 'high');
  await driver.turn(request(sol, room, sinkFor(sol), { flags: { ultra: true } }));
  assert.equal(sent('turn/start')[1].params.effort, 'ultra');
  assert.equal(sent('turn/start')[1].params.collaborationMode.settings.reasoning_effort, 'ultra');
  const sink = sinkFor(luna);
  luna.options.ultra = true;
  await driver.turn(request(luna, room, sink));
  assert.equal(sent('turn/start')[2].params.effort, 'xhigh');
  assert.match(sink.activities.find(a => a.id === 'ultra')!.title, /Ultra is not available for gpt-luna/);
  await driver.dispose();
});

test('streaming: text deltas, reasoning summaries, command and plan activity, token usage and context', async () => {
  const { driver } = setup({
    'turn/start': (params, _id, peer) => {
      const t = { threadId: params.threadId, turnId: 'turn-s' };
      later(() => {
        peer.notify('thread/tokenUsage/updated', { ...t, tokenUsage: { total: { totalTokens: 1100, inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
          last: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }, modelContextWindow: 10000 } });
        peer.notify('item/reasoning/summaryTextDelta', { ...t, itemId: 'r1', delta: 'Looking ', summaryIndex: 0 });
        peer.notify('item/reasoning/summaryTextDelta', { ...t, itemId: 'r1', delta: 'closer.', summaryIndex: 0 });
        peer.notify('item/reasoning/summaryPartAdded', { ...t, itemId: 'r1', summaryIndex: 1 });
        peer.notify('item/reasoning/summaryTextDelta', { ...t, itemId: 'r1', delta: 'Found it.', summaryIndex: 1 });
        peer.notify('item/started', { ...t, item: { type: 'commandExecution', id: 'c1', command: 'pwsh.exe -Command \'npm test\'', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null } });
        peer.notify('item/commandExecution/outputDelta', { ...t, itemId: 'c1', delta: 'ok 1\n' });
        peer.notify('item/completed', { ...t, item: { type: 'commandExecution', id: 'c1', command: 'pwsh.exe -Command \'npm test\'', cwd: '/w', status: 'completed', aggregatedOutput: 'ok 1\nok 2\n', exitCode: 0 } });
        peer.notify('turn/plan/updated', { ...t, explanation: null, plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'inProgress' }, { step: 'Test', status: 'pending' }] });
        peer.notify('item/agentMessage/delta', { ...t, itemId: 'm1', delta: 'I will fix it.' });
        peer.notify('item/agentMessage/delta', { ...t, itemId: 'm2', delta: 'Fixed' });
        peer.notify('item/agentMessage/delta', { ...t, itemId: 'm2', delta: ' the bug.' });
        peer.notify('thread/tokenUsage/updated', { ...t, tokenUsage: { total: { totalTokens: 1600, inputTokens: 1400, cachedInputTokens: 900, cacheWriteInputTokens: 10, outputTokens: 200, reasoningOutputTokens: 20 },
          last: { totalTokens: 500, inputTokens: 400, cachedInputTokens: 300, cacheWriteInputTokens: 10, outputTokens: 100, reasoningOutputTokens: 20 }, modelContextWindow: 10000 } });
        peer.notify('item/unknownThing', { ...t });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-s', status: 'completed', error: null } });
      });
      return { turn: { id: 'turn-s', status: 'inProgress' } };
    },
  });
  const agent = testAgent('codex'), room = testRoom([agent]), sink = sinkFor(agent);
  const result = await driver.turn(request(agent, room, sink));
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'I will fix it.\n\nFixed the bug.');
  assert.equal(sink.texts.at(-1), 'I will fix it.\n\nFixed the bug.');
  assert.equal(sink.thinkings.at(-1), 'Looking closer.\n\nFound it.');
  const command = sink.activities.filter(a => a.id === 'c1');
  assert.deepEqual(command.map(a => a.status), ['running', 'running', 'done']);
  assert.equal(command[0]!.title, 'npm test'); assert.equal(command[0]!.kind, 'command');
  assert.equal(command[1]!.detail, 'ok 1\n');
  assert.equal(command[2]!.detail, 'exit 0\nok 1\nok 2\n');
  const plan = sink.activities.filter(a => a.id === 'plan').at(-1)!;
  assert.equal(plan.detail, '✓ Read\n→ Fix\n· Test'); assert.equal(plan.status, 'running');
  // Baseline = first total - last; usage = final total - baseline.
  assert.deepEqual(result.usage, { input: 650, output: 150, cached: 400, cacheWrite: 10, requests: 1, estimated: false });
  assert.deepEqual(sink.sessions.at(-1), { context: { tokens: 500, window: 10000, percent: 5 } });
  await driver.dispose();
});

test('approvals: command accept/acceptForSession/decline, file change with cached diff, permissions, legacy and unknown requests', async () => {
  const replies: Record<string, any> = {};
  const { driver } = setup({
    'turn/start': (params, _id, peer) => {
      const t = { threadId: params.threadId, turnId: 'turn-a' };
      later(async () => {
        peer.notify('turn/started', { threadId: params.threadId, turn: { id: 'turn-a' } });
        replies.allow = await peer.request('item/commandExecution/requestApproval', { ...t, itemId: 'c1', kind: 'command', command: 'npm install', cwd: '/w', reason: 'needs network', startedAtMs: 0, environmentId: null });
        replies.session = await peer.request('item/commandExecution/requestApproval', { ...t, itemId: 'c2', command: 'npm test', cwd: '/w', startedAtMs: 0, environmentId: null });
        replies.deny = await peer.request('item/commandExecution/requestApproval', { ...t, itemId: 'c3', command: 'rm -rf build', startedAtMs: 0, environmentId: null });
        peer.notify('item/started', { ...t, item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+b' }] } });
        replies.edit = await peer.request('item/fileChange/requestApproval', { ...t, itemId: 'f1', reason: 'apply fix', grantRoot: null, startedAtMs: 0 });
        replies.perm = await peer.request('item/permissions/requestApproval', { ...t, itemId: 'p1', cwd: '/w', reason: 'fetch docs', environmentId: null, startedAtMs: 0, permissions: { network: { enabled: true }, fileSystem: null } });
        replies.legacy = await peer.request('execCommandApproval', { conversationId: params.threadId, callId: 'x', approvalId: null, command: ['git', 'push'], cwd: '/w', reason: null, parsedCmd: [] });
        replies.input = await peer.request('item/tool/requestUserInput', { ...t, questions: [] });
        replies.elicit = await peer.request('mcpServer/elicitation/request', { ...t });
        replies.unknown = await peer.request('attestation/generate', {}).catch((error: any) => ({ code: error.code }));
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-a', status: 'completed' } });
      });
      return { turn: { id: 'turn-a', status: 'inProgress' } };
    },
  });
  const agent = testAgent('codex'), room = testRoom([agent]);
  const decisions: Record<string, ApprovalDecision['decision']> = { 'npm install': 'allow', 'npm test': 'allow-session', 'src/a.ts': 'allow', 'fetch docs': 'allow-session' };
  const sink = sinkFor(agent, request => ({ decision: decisions[request.title] ?? 'deny', message: 'Not now.' }));
  await driver.turn(request(agent, room, sink));
  assert.deepEqual(replies.allow, { decision: 'accept' });
  assert.deepEqual(replies.session, { decision: 'acceptForSession' });
  assert.deepEqual(replies.deny, { decision: 'decline' });
  assert.deepEqual(replies.edit, { decision: 'accept' });
  assert.deepEqual(replies.perm, { permissions: { network: { enabled: true } }, scope: 'session' });
  assert.deepEqual(replies.legacy, { decision: { denied: { rejection: 'Not now.' } } });
  assert.deepEqual(replies.input, { answers: {} });
  assert.deepEqual(replies.elicit, { action: 'decline', content: null, _meta: null });
  assert.deepEqual(replies.unknown, { code: -32601 });
  const [install, , , edit, perm] = sink.approvals;
  assert.deepEqual(install, { kind: 'command', tool: 'shell', title: 'npm install', detail: 'npm install\n\nin /w\nneeds network', canAllowSession: true });
  assert.deepEqual(edit, { kind: 'edit', tool: 'apply_patch', title: 'src/a.ts', diff: '-a\n+b', detail: 'apply fix', canAllowSession: true });
  assert.equal(perm!.kind, 'network'); assert.equal(perm!.tool, 'permissions');
  await driver.dispose();
});

test('approvals: a denied permissions request grants nothing; an aborted turn declines pending approvals', async () => {
  const replies: any[] = [];
  const { driver } = setup({
    'turn/start': (params, _id, peer) => {
      const t = { threadId: params.threadId, turnId: 'turn-d' };
      later(async () => {
        replies.push(await peer.request('item/permissions/requestApproval', { ...t, itemId: 'p', cwd: '/w', reason: null, environmentId: null, startedAtMs: 0, permissions: { network: { enabled: true }, fileSystem: null } }));
        replies.push(await peer.request('item/commandExecution/requestApproval', { ...t, itemId: 'c', command: 'make', startedAtMs: 0, environmentId: null }));
      });
      return { turn: { id: 'turn-d', status: 'inProgress' } };
    },
    'turn/interrupt': (params, _id, peer) => { later(() => peer.notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } })); return {}; },
  });
  const agent = testAgent('codex'), room = testRoom([agent]), controller = new AbortController();
  const sink = sinkFor(agent, request => request.tool === 'permissions' ? { decision: 'deny' } : new Promise(() => { setTimeout(() => controller.abort(), 5); }));
  const result = await driver.turn(request(agent, room, sink, { signal: controller.signal }));
  assert.equal(result.status, 'interrupted');
  await waitFor(() => replies.length === 2, 2000, 'approval replies');
  assert.deepEqual(replies[0], { permissions: {}, scope: 'turn' });
  assert.deepEqual(replies[1], { decision: 'decline' });
  await driver.dispose();
});

test('a command approval always shows the exact command, however long or wrapped', async () => {
  const command = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command '${'Get-ChildItem -Recurse -Filter *.ts; '.repeat(10)}Remove-Item -Recurse -Force $HOME\\Documents'`;
  let reply: any;
  const { driver } = setup({
    'turn/start': (params, _id, peer) => {
      later(async () => {
        reply = await peer.request('item/commandExecution/requestApproval', { threadId: params.threadId, turnId: 'turn-l', itemId: 'c', command, cwd: 'C:\\w', reason: 'List the TypeScript files', startedAtMs: 0, environmentId: null });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-l', status: 'completed' } });
      });
      return { turn: { id: 'turn-l', status: 'inProgress' } };
    },
  });
  const agent = testAgent('codex'), room = testRoom([agent]), sink = sinkFor(agent, () => ({ decision: 'deny' }));
  await driver.turn(request(agent, room, sink));
  const card = sink.approvals[0]!;
  assert.ok(card.title.endsWith('…')); assert.equal(card.title.length, 300);
  assert.ok(card.detail!.startsWith(command), 'the full command comes first'); assert.match(card.detail!, /Remove-Item -Recurse -Force/);
  assert.match(card.detail!, /in C:\\w\nList the TypeScript files$/);
  assert.deepEqual(reply, { decision: 'decline' });
  await driver.dispose();
});

test('an option change on a loaded thread unloads it first, so the resume applies the new config; release unloads too', async () => {
  const loaded = new Map<string, any>();
  let threads = 0;
  const { driver, sent } = setup({
    'thread/start': params => { const id = `thread-${++threads}`; loaded.set(id, params.config); return { thread: { id }, model: 'gpt-sol' }; },
    // Like the real server: a loaded thread ignores resume overrides.
    'thread/resume': params => { if (!loaded.has(params.threadId)) loaded.set(params.threadId, params.config); return { thread: { id: params.threadId }, model: 'gpt-sol' }; },
    'thread/unsubscribe': params => ({ status: loaded.delete(params.threadId) ? 'unsubscribed' : 'notLoaded' }),
  });
  const agent = testAgent('codex', { options: { ...testAgent('codex').options, webSearch: true } }), other = testAgent('codex', { id: 'codex-2' }), room = testRoom([agent, other]);
  await driver.turn(request(agent, room, sinkFor(agent)));
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(sent('thread/unsubscribe').length, 0, 'unchanged options keep the loaded thread');
  assert.equal(loaded.get('thread-1').web_search, 'live');
  agent.options.webSearch = false;
  await driver.turn(request(agent, room, sinkFor(agent)));
  assert.deepEqual(sent('thread/unsubscribe')[0].params, { threadId: 'thread-1' });
  assert.equal(sent('thread/resume')[0].params.threadId, 'thread-1');
  assert.equal(loaded.get('thread-1').web_search, 'disabled');
  await driver.turn(request(other, room, sinkFor(other)));
  await driver.release(room.id, agent.id);
  assert.equal(sent('thread/unsubscribe').length, 2); assert.equal(loaded.has('thread-1'), false);
  await driver.dispose();
});

test('"Default" model and effort follow the user\'s Codex config, then the thread, never the catalog default', async () => {
  const configured = setup({ 'config/read': () => ({ config: { model: 'gpt-luna', model_reasoning_effort: 'xhigh', mcp_servers: {} } }) });
  const agent = testAgent('codex'), room = testRoom([agent]);
  assert.equal((await configured.driver.capabilities(room, agent)).defaultEffort, 'xhigh');
  await configured.driver.turn(request(agent, room, sinkFor(agent)));
  const turn = configured.sent('turn/start')[0].params;
  assert.equal(turn.model, 'gpt-luna'); assert.equal(turn.effort, 'xhigh'); assert.equal(turn.collaborationMode.settings.reasoning_effort, 'xhigh');
  agent.options.effort = 'medium';
  await configured.driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(configured.sent('turn/start')[1].params.effort, 'medium', 'an explicit effort wins');
  await configured.driver.dispose();
  const thread = setup({ 'thread/start': () => ({ thread: { id: 'thread-1' }, model: 'gpt-sol', reasoningEffort: 'high' }) });
  const plain = testAgent('codex');
  await thread.driver.turn(request(plain, testRoom([plain]), sinkFor(plain)));
  assert.equal(thread.sent('turn/start')[0].params.effort, 'high');
  await thread.driver.dispose();
});

test('a sub-agent thread\'s approvals and room-tool calls reach the parent turn', async () => {
  let approval: any, tool: any;
  const { driver, host } = setup({
    'turn/start': (params, _id, peer) => {
      later(async () => {
        peer.notify('turn/started', { threadId: params.threadId, turn: { id: 'turn-p', status: 'inProgress', items: [] } });
        peer.notify('thread/started', { thread: { id: 'child-1', parentThreadId: params.threadId, source: { subAgent: { thread_spawn: { parent_thread_id: params.threadId, depth: 1 } } } } });
        peer.notify('item/completed', { threadId: params.threadId, turnId: 'turn-p', item: { type: 'collabAgentToolCall', id: 'cb', tool: 'spawn_agent', status: 'completed', receiverThreadIds: ['child-2'] } });
        approval = await peer.request('item/commandExecution/requestApproval', { threadId: 'child-1', turnId: 'ct-1', itemId: 'i1', command: 'npm test', cwd: '/w', startedAtMs: 0, environmentId: null });
        tool = await peer.request('item/tool/call', { threadId: 'child-2', turnId: 'ct-2', callId: 'call', namespace: null, tool: 'search_documents', arguments: { query: 'q' } });
        peer.notify('item/agentMessage/delta', { threadId: 'child-1', turnId: 'ct-1', itemId: 'cm', delta: 'child text' });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-p', status: 'completed', items: [], error: null } });
      });
      return { turn: { id: 'turn-p', status: 'inProgress', items: [] } };
    },
  });
  const agent = testAgent('codex', { options: { ...testAgent('codex').options, ultra: true } }), sink = sinkFor(agent);
  const result = await driver.turn(request(agent, testRoom([agent]), sink));
  assert.equal(sink.approvals.length, 1); assert.equal(sink.approvals[0]!.title, 'npm test');
  assert.deepEqual(approval, { decision: 'accept' });
  assert.equal(tool.success, true); assert.equal(host.tools.calls[0]!.agentId, 'codex-1');
  assert.doesNotMatch(result.text, /child text/, 'a sub-agent\'s text stays out of the parent\'s message');
  await driver.dispose();
});

test('item/tool/call runs the room tool for the right agent', async () => {
  let reply: any, unknown: any;
  const { driver, host } = setup({
    'turn/start': (params, _id, peer) => {
      later(async () => {
        reply = await peer.request('item/tool/call', { threadId: params.threadId, turnId: 'turn-t', callId: 'call-1', namespace: null, tool: 'search_documents', arguments: { query: 'budget' } });
        unknown = await peer.request('item/tool/call', { threadId: params.threadId, turnId: 'turn-t', callId: 'call-2', namespace: null, tool: 'nope', arguments: {} });
        peer.notify('item/completed', { threadId: params.threadId, turnId: 'turn-t', item: { type: 'dynamicToolCall', id: 'd1', tool: 'search_documents', status: 'completed' } });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-t', status: 'completed' } });
      });
      return { turn: { id: 'turn-t', status: 'inProgress' } };
    },
  });
  const agent = testAgent('codex'), room = testRoom([agent]), sink = sinkFor(agent);
  await driver.turn(request(agent, room, sink));
  assert.deepEqual(reply, { contentItems: [{ type: 'inputText', text: 'search_documents result' }], success: true });
  assert.equal(unknown.success, false);
  assert.deepEqual(host.tools.calls[0], { agentId: 'codex-1', name: 'search_documents', args: { query: 'budget' } });
  assert.deepEqual(sink.activities.find(a => a.id === 'd1'), { id: 'd1', kind: 'tool', title: 'chatroom.search_documents', status: 'done', at: sink.activities.find(a => a.id === 'd1')!.at });
  await driver.dispose();
});

test('usage limit: a failed turn becomes ProviderError usage-limit with resetsAt from account/rateLimits/read', async () => {
  const { driver, sent } = setup({
    'turn/start': (params, _id, peer) => {
      const error = { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null };
      later(() => {
        peer.notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2 } } });
        peer.notify('error', { error, willRetry: false, threadId: params.threadId, turnId: 'turn-u' });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-u', status: 'failed', error } });
      });
      return { turn: { id: 'turn-u', status: 'inProgress' } };
    },
  });
  const agent = testAgent('codex'), room = testRoom([agent]), sink = sinkFor(agent);
  await assert.rejects(driver.turn(request(agent, room, sink)), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'usage-limit');
    assert.equal(error.extra.resetsAt, 1791580982000);
    assert.match(error.message, /^Codex usage limit reached\. It resets .+\. Other agents can continue\.$/);
    return true;
  });
  assert.equal(sent('account/rateLimits/read').length, 1);
  assert.deepEqual(sink.sessions.find(s => s.quota)?.quota && { ...sink.sessions.find(s => s.quota)!.quota, observedAt: 0 },
    { primaryUsedPercent: 38, secondaryUsedPercent: 100, primaryWindowMinutes: 300, secondaryWindowMinutes: 10080, observedAt: 0 });
  await driver.dispose();
});

test('other turn failures map to signed-out and compact advice', async () => {
  let info = 'unauthorized';
  const { driver } = setup({
    'turn/start': (params, _id, peer) => {
      later(() => peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-f', status: 'failed', error: { message: 'Context is full.', codexErrorInfo: info } } }));
      return { turn: { id: 'turn-f', status: 'inProgress' } };
    },
  });
  const agent = testAgent('codex'), room = testRoom([agent]);
  await assert.rejects(driver.turn(request(agent, room, sinkFor(agent))), (e: any) => e.code === 'signed-out' && /codex login/.test(e.message));
  info = 'contextWindowExceeded';
  await assert.rejects(driver.turn(request(agent, room, sinkFor(agent))), (e: any) => e.code === 'failed' && e.message === 'Context is full. Run /compact for this agent.');
  await driver.dispose();
});

test('abort sends turn/interrupt with the thread and turn ids and resolves interrupted with the partial text', async () => {
  const { driver, sent } = setup({
    'turn/start': (params, _id, peer) => {
      later(() => peer.notify('item/agentMessage/delta', { threadId: params.threadId, turnId: 'turn-x', itemId: 'm', delta: 'Partial' }));
      return { turn: { id: 'turn-x', status: 'inProgress' } };
    },
    'turn/interrupt': (params, _id, peer) => { later(() => peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-x', status: 'interrupted' } })); return {}; },
  });
  const agent = testAgent('codex'), room = testRoom([agent]), sink = sinkFor(agent), controller = new AbortController();
  const running = driver.turn(request(agent, room, sink, { signal: controller.signal }));
  await waitFor(() => sink.texts.includes('Partial'), 2000, 'partial text');
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'interrupted'); assert.equal(result.text, 'Partial'); assert.equal(result.delivered, true, 'the turn had started');
  assert.deepEqual(sent('turn/interrupt')[0].params, { threadId: 'thread-1', turnId: 'turn-x' });
  // An already aborted request never spawns.
  const done = await driver.turn(request(agent, room, sink, { signal: AbortSignal.abort() }));
  assert.equal(done.status, 'interrupted');
  await driver.dispose();
});

test('a stored thread is resumed; a failed resume starts a new thread with the full room history', async () => {
  const { driver, sent } = setup({ 'thread/resume': params => { if (params.threadId === 'gone') throw { code: -32600, message: 'no rollout found for thread id gone' }; return { thread: { id: params.threadId }, model: 'gpt-sol' }; } });
  const kept = testAgent('codex', { session: { id: 'kept', seen: 'm1' } });
  const lost = testAgent('codex', { id: 'codex-2', session: { id: 'gone' } });
  const room = testRoom([kept, lost]);
  await driver.turn(request(kept, room, sinkFor(kept), { context: 'NEW ONLY' }));
  const resume = sent('thread/resume')[0].params;
  assert.equal(resume.threadId, 'kept'); assert.equal(resume.developerInstructions, 'You are Codex in the room.'); assert.equal(resume.approvalPolicy, 'on-request');
  assert.equal(sent('thread/start').length, 0);
  assert.equal(sent('thread/inject_items')[0].params.items[0].content[0].text, 'NEW ONLY');
  const sink = sinkFor(lost);
  await driver.turn(request(lost, room, sink, { context: 'NEW ONLY' }));
  assert.equal(sent('thread/start').length, 1);
  assert.equal(sent('thread/inject_items')[1].params.items[0].content[0].text, '<room from="User">FULL HISTORY</room>');
  assert.equal(sink.sessions[0]!.id, 'thread-1'); assert.equal(lost.session?.id, 'thread-1');
  assert.match(sink.activities.find(a => a.id === 'resume')!.title, /could not be resumed/);
  await driver.dispose();
});

test('commands: compact, review, goal, mcp, skills, a skill, init, unknown, and no session yet', async () => {
  const { driver, children, sent } = setup({
    'thread/compact/start': (params, _id, peer) => {
      later(() => {
        peer.notify('turn/started', { threadId: params.threadId, turn: { id: 'turn-c' } });
        peer.notify('item/started', { threadId: params.threadId, turnId: 'turn-c', item: { type: 'contextCompaction', id: 'cc' } });
        peer.notify('item/completed', { threadId: params.threadId, turnId: 'turn-c', item: { type: 'contextCompaction', id: 'cc' } });
        peer.notify('thread/compacted', { threadId: params.threadId, turnId: 'turn-c' });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-c', status: 'completed' } });
      });
      return {};
    },
    'review/start': (params, _id, peer) => {
      later(() => {
        peer.notify('item/completed', { threadId: params.threadId, turnId: 'turn-r', item: { type: 'exitedReviewMode', id: 'x', review: 'No issues found.' } });
        peer.notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn-r', status: 'completed' } });
      });
      return { turn: { id: 'turn-r', status: 'inProgress' }, reviewThreadId: params.threadId };
    },
    'thread/goal/set': params => ({ goal: { threadId: params.threadId, objective: params.objective, status: 'active', tokenBudget: null, tokensUsed: 0 } }),
    'thread/goal/get': () => ({ goal: { objective: 'Ship it', status: 'active', tokenBudget: 1000, tokensUsed: 250 } }),
    'thread/goal/clear': () => ({ cleared: true }),
  });
  const agent = testAgent('codex'), room = testRoom([agent]);
  const command = (name: string, args = '') => driver.turn(request(agent, room, sinkFor(agent), { command: { name, args }, context: '', ask: '' }));
  assert.deepEqual(await command('compact'), { text: 'No session yet: nothing to compact.', usage: { input: 0, output: 0, cached: 0, cacheWrite: 0, requests: 0, estimated: false }, status: 'complete' });
  assert.equal(children.length, 0);
  agent.session = { id: 'th-9' };
  const compact = await command('compact');
  assert.equal(compact.text, 'Context compacted.');
  assert.deepEqual(sent('thread/compact/start')[0].params, { threadId: 'th-9' });
  assert.equal(sent('thread/resume').length, 1);
  assert.equal(sent('thread/inject_items').length, 0);
  assert.equal((await command('review')).text, 'No issues found.');
  assert.deepEqual(sent('review/start')[0].params, { threadId: 'th-9', target: { type: 'uncommittedChanges' }, delivery: 'inline' });
  await command('review', 'check the parser');
  assert.deepEqual(sent('review/start')[1].params.target, { type: 'custom', instructions: 'check the parser' });
  assert.equal((await command('goal', 'Ship it')).text, 'Goal set: Ship it');
  assert.deepEqual(sent('thread/goal/set')[0].params, { threadId: 'th-9', objective: 'Ship it', status: 'active' });
  assert.equal((await command('goal')).text, 'Goal: Ship it (active, 250 of 1000 tokens used)');
  assert.equal((await command('goal', 'clear')).text, 'Goal cleared.');
  assert.equal((await command('mcp')).text, 'MCP servers:\n- mem · configured · 2 tools\n- codex_apps · configured · 1 tools');
  assert.equal(sent('mcpServerStatus/list').at(-1).params.threadId, 'th-9');
  assert.equal((await command('skills')).text, 'Skills:\n- pdf-tools (user): Work with PDFs');
  await command('pdf-tools');
  assert.deepEqual(sent('turn/start').at(-1).params.input, [{ type: 'skill', name: 'pdf-tools', path: '/skills/pdf-tools/SKILL.md' }, { type: 'text', text: 'Use the pdf-tools skill.', text_elements: [] }]);
  await command('init');
  assert.equal(sent('turn/start').at(-1).params.input[0].text, 'Create an AGENTS.md file with instructions for working in this repository.');
  await assert.rejects(command('frobnicate'), (e: any) => e instanceof ProviderError && e.code === 'unsupported' && e.message === 'Codex has no /frobnicate command.');
  assert.equal(children.length, 1);
  await driver.dispose();
});

test('one app-server serves two agents; a crash rejects the turn and the next turn respawns and resumes', async () => {
  let crash = false;
  const { driver, children, sent } = setup({
    'turn/start': (params, _id, peer, child) => {
      if (crash) { later(() => { child.stderr('fatal: boom\n'); later(() => child.exit(3)); }); return { turn: { id: 'turn-crash', status: 'inProgress' } }; }
      finishTurn(peer, params.threadId, `turn-${params.threadId}`, `Reply from ${params.threadId}`);
      return { turn: { id: `turn-${params.threadId}`, status: 'inProgress' } };
    },
  });
  const a = testAgent('codex'), b = testAgent('codex', { id: 'codex-2', name: 'Codex 2' }), room = testRoom([a, b]);
  const [ra, rb] = await Promise.all([driver.turn(request(a, room, sinkFor(a))), driver.turn(request(b, room, sinkFor(b)))]);
  assert.equal(children.length, 1);
  assert.deepEqual(new Set([ra.text, rb.text]), new Set(['Reply from thread-1', 'Reply from thread-2']));
  assert.notEqual(a.session?.id, b.session?.id);
  crash = true;
  await assert.rejects(driver.turn(request(a, room, sinkFor(a))), (e: any) => e instanceof ProviderError && e.code === 'crashed' && /code 3/.test(e.message) && /boom/.test(e.message));
  crash = false;
  const again = await driver.turn(request(a, room, sinkFor(a)));
  assert.equal(children.length, 2);
  assert.equal(sent('thread/resume', 1)[0].params.threadId, a.session?.id);
  assert.match(again.text, /^Reply from /);
  await driver.release(room.id);
  await waitFor(() => children[1]!.exited, 2000, 'app-server exit after release');
  await driver.dispose();
});

test('capabilities: models, efforts, mapped commands plus skills, MCP servers and support flags without inference', async () => {
  const { driver, sent } = setup({ 'skills/extraRoots/set': () => ({}) }, { skillWiring: () => ({ codexExtraRoots: ['/home/.claude/skills'], skills: [] }) });
  const agent = testAgent('codex'), room = testRoom([agent]);
  const caps = await driver.capabilities(room, agent);
  assert.equal(caps.status, 'ready'); assert.equal(caps.runtime, 'cli'); assert.equal(caps.version, '9.9.9');
  assert.equal(caps.account, 'dev@example.com · plus');
  assert.deepEqual(caps.models.map(m => m.id), ['gpt-luna', 'gpt-sol']);
  assert.equal(caps.models[1]!.ultra, true); assert.equal(caps.models[0]!.ultra, false);
  assert.deepEqual(caps.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']); assert.equal(caps.defaultEffort, 'low');
  assert.deepEqual(caps.commands.map(c => `${c.name}:${c.source}`), ['review:mapped', 'goal:mapped', 'mcp:mapped', 'skills:mapped', 'init:mapped', 'pdf-tools:skill']);
  assert.deepEqual(caps.skills, [{ name: 'pdf-tools', description: 'Work with PDFs', source: 'user' }]);
  assert.deepEqual(caps.mcpServers, [{ name: 'mem', status: 'configured', tools: 2 }, { name: 'codex_apps', status: 'configured', tools: 1 }]);
  assert.equal(caps.supports.useSkills, false); assert.equal(caps.supports.summary, true); assert.equal(caps.supports.ultraTurn, true); assert.equal(caps.supports.thinking, false);
  assert.deepEqual(sent('skills/extraRoots/set')[0].params, { extraRoots: ['/home/.claude/skills'] });
  assert.equal(sent('turn/start').length, 0); assert.equal(sent('thread/start').length, 0);
  await driver.dispose();
});

test('capabilities report signed-out and missing runtimes without throwing; full access needs the setting', async () => {
  const signed = setup({ 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) });
  const agent = testAgent('codex', { options: { ...testAgent('codex').options, permission: 'full' } }), room = testRoom([agent]);
  const caps = await signed.driver.capabilities(room, agent);
  assert.equal(caps.status, 'signed-out'); assert.match(caps.detail ?? '', /codex login/);
  // Without chatroom.allowFullAccess a stored "full" permission runs as Ask.
  await signed.driver.turn(request(agent, room, sinkFor(agent)));
  assert.equal(signed.sent('thread/start')[0].params.approvalPolicy, 'on-request');
  assert.equal(signed.sent('turn/start')[0].params.sandboxPolicy.type, 'readOnly');
  await signed.driver.dispose();
  const missing = setup({}, { runtime: async () => undefined });
  assert.equal((await missing.driver.capabilities(room, agent)).status, 'missing');
  await assert.rejects(missing.driver.turn(request(agent, room, sinkFor(agent))), (e: any) => e instanceof ProviderError && e.code === 'missing');
  const allowed = setup({}, { settings: () => ({ allowFullAccess: true, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: { docs: { type: 'http', url: 'http://127.0.0.1:7/mcp', headers: { A: 'b' } } } }) });
  agent.session = undefined;
  await allowed.driver.turn(request(agent, room, sinkFor(agent)));
  const start = allowed.sent('thread/start')[0].params;
  assert.equal(start.approvalPolicy, 'never'); assert.equal(start.sandbox, 'danger-full-access');
  assert.deepEqual(start.config['mcp_servers.docs'], { url: 'http://127.0.0.1:7/mcp', http_headers: { A: 'b' } });
  assert.deepEqual(allowed.sent('turn/start')[0].params.sandboxPolicy, { type: 'dangerFullAccess' });
  await allowed.driver.dispose();
});
test('threads start and resume in the agent\'s folder from host.cwdFor; the app-server stays in the workspace; a loaded thread never moves folders', async () => {
  let folder = join(tmpdir(), 'wt', 'roomaa-codex');
  const { driver, host, children, sent } = setup({}, { cwdFor: () => folder });
  const agent = testAgent('codex'), room = testRoom([agent]);
  try {
    await driver.turn(request(agent, room, sinkFor(agent)));
    assert.equal(children[0]!.cwd, host.cwd(), 'process-wide calls keep the workspace');
    assert.equal(sent('config/read')[0].params.cwd, host.cwd());
    assert.equal(sent('thread/start')[0].params.cwd, folder);
    await driver.turn(request(agent, room, sinkFor(agent)));
    assert.equal(sent('thread/resume').length, 0, 'the same folder reuses the loaded thread');
    folder = join(tmpdir(), 'wt', 'roomaa-codex-2');
    await driver.turn(request(agent, room, sinkFor(agent)));
    assert.equal(sent('thread/unsubscribe').length, 1);
    assert.equal(sent('thread/resume')[0].params.cwd, folder);
  } finally { await driver.dispose(); }
});
