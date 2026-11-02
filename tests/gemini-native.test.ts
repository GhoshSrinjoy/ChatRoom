import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiDriver, geminiArgs, geminiPolicy } from '../src/gemini-native';
import { Agent, ApprovalDecision, ApprovalRequest, DriverHost, NativeTurnRequest, ProviderError, Room, SharedSkill } from '../src/types';
import { FakeChild, fakeHost, fakeSpawn, recordingSink, RecordingSink, rpcPeer, testAgent, testRoom, waitFor } from './helpers';

// Shapes below are from Gemini CLI 0.66.0 over ACP; scripts/test-gemini.ts checks them against the real CLI.
const MODES = (current = 'default') => ({ currentModeId: current, availableModes: [{ id: 'default', name: 'Default' }, { id: 'autoEdit', name: 'Auto Edit' }, { id: 'yolo', name: 'YOLO' }, { id: 'plan', name: 'Plan' }] });
const MODELS = () => ({ currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'Auto', description: 'Let Gemini CLI decide' }, { modelId: 'gemini-2.5-pro', name: 'gemini-2.5-pro' }] });
const OPTIONS = [{ optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' }, { optionId: 'proceed_always_and_save', name: 'Allow in all future sessions', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' }, { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }];
type Handlers = Record<string, (params: any) => unknown>;
interface Peer { child: FakeChild; index: number; calls: { method: string; params: any }[]; rpc: ReturnType<typeof rpcPeer>; update(update: object): void }
function fakeGemini(custom: (peer: Peer) => Handlers = () => ({})) {
  const peers: Peer[] = [];
  const fake = fakeSpawn((child, index) => {
    const peer = { child, index, calls: [] } as unknown as Peer;
    child.onLine(m => { if (m && typeof m === 'object' && typeof m.method === 'string') peer.calls.push({ method: m.method, params: m.params }); });
    peer.update = update => peer.rpc.notify('session/update', { sessionId: `sess-${index}`, update });
    peer.rpc = rpcPeer(child, 'jsonrpc2', {
      initialize: () => ({ protocolVersion: 1, agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.66.0' }, agentCapabilities: { loadSession: true }, authMethods: [] }),
      'session/new': () => { setImmediate(() => peer.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'memory', description: 'Manage memory.' }, { name: 'memory show', description: 'Show it.' }, { name: 'about', description: 'Version.' }, { name: 'help', description: 'Help.' }] })); return { sessionId: `sess-${index}`, modes: MODES(), models: MODELS() }; },
      'session/load': () => ({ modes: MODES(), models: MODELS() }),
      'session/set_mode': () => ({}),
      'session/set_model': () => ({}),
      'session/prompt': () => { peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }); return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 40, totalTokens: 107 } }; },
      ...custom(peer)
    });
    peers.push(peer);
  });
  return { ...fake, peers };
}
function request(room: Room, agent: Agent, sink: RecordingSink, patch: Partial<NativeTurnRequest> = {}): NativeTurnRequest {
  return { room, agent, kind: 'direct', framing: 'FRAMING', context: '', fullContext: () => 'FULL HISTORY', ask: 'Do it', flags: {}, signal: new AbortController().signal, sink, ...patch };
}
function setup(custom?: (peer: Peer) => Handlers, options: { host?: Partial<DriverHost>; agent?: Partial<Agent> } = {}) {
  const fake = fakeGemini(custom), host = fakeHost(options.host), driver = new GeminiDriver(host, fake.spawn);
  const agent = testAgent('gemini', options.agent), room = testRoom([agent]);
  return { ...fake, host, driver, agent, room };
}
const method = (peer: Peer, name: string) => peer.calls.filter(c => c.method === name);
const promptOf = (peer: Peer, n = 0) => method(peer, 'session/prompt')[n]?.params.prompt;
const adopt = (agent: Agent, sink: RecordingSink) => { for (const patch of sink.sessions) agent.session = { ...agent.session, ...patch }; };
/** A turn that asks for permission once with `call` and reports what was chosen. */
function asking(call: object, options: object[] = OPTIONS) {
  const chosen: any[] = [];
  return { chosen, custom: (peer: Peer): Handlers => ({ 'session/prompt': async () => { chosen.push(await peer.rpc.request('session/request_permission', { sessionId: `sess-${peer.index}`, options, toolCall: { toolCallId: 't1', status: 'pending', title: 'Do something', ...call } })); return { stopReason: 'end_turn' }; } }) };
}
const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } });

test('geminiArgs: ACP, the policy, shared skill folders, extra folders and the MCP switch', () => {
  assert.deepEqual(geminiArgs(testAgent('gemini'), undefined, undefined), ['--acp']);
  assert.deepEqual(geminiArgs(testAgent('gemini'), undefined, undefined, ['chatroom', 'other']), ['--acp', '--allowed-mcp-server-names', 'chatroom', '--allowed-mcp-server-names', 'other']);
  const agent = testAgent('gemini', { options: { extraDirs: ['/x'], useMcp: false } as any });
  assert.deepEqual(geminiArgs(agent, { indexDir: '/s', geminiDirs: ['/home/.claude/skills'], codexExtraRoots: [], skills: [] }, '/p/policy.toml'),
    ['--acp', '--include-directories', '/s', '--include-directories', '/home/.claude/skills', '--include-directories', '/x', '--policy', '/p/policy.toml', '--allowed-mcp-server-names', 'chatroom']);
});

test('geminiPolicy: room tools run without a card, and what is turned off is denied', () => {
  const plain = geminiPolicy(testAgent('gemini'));
  for (const tool of ['search_documents', 'read_document', 'semantic_search', 'ollama_ocr', 'sandbox_run']) assert.ok(plain.includes(`mcpName = "chatroom"\ntoolName = "${tool}"\ndecision = "allow"`), tool);
  assert.ok(!plain.includes('isolate_workspace'), 'isolate_workspace still asks'); assert.ok(!plain.includes('"deny"'));
  const off = geminiPolicy(testAgent('gemini', { options: { webSearch: false, useSkills: false, disabled: { tools: ['run_shell_command', 'web_fetch'], mcpServers: ['pathview'], skills: ['my.skill'] } } as any }));
  for (const tool of ['run_shell_command', 'web_fetch', 'google_web_search', 'activate_skill']) assert.ok(off.includes(`[[rule]]\ntoolName = "${tool}"\ndecision = "deny"`), tool);
  assert.equal(off.split('toolName = "web_fetch"').length, 2, 'a tool is denied once');
  assert.ok(off.includes('[[rule]]\nmcpName = "pathview"\ntoolName = "*"\ndecision = "deny"'), 'with the wildcard: the CLI ignores a server rule without it');
  assert.ok(!geminiPolicy(testAgent('gemini', { options: { disabled: { mcpServers: ['my server', 'x'.repeat(26)] } } as any })).includes('"deny"'), 'no rule can reach these names');
  // The skill name is a regular expression over the tool's arguments, inside a TOML string.
  assert.ok(off.includes(String.raw`argsPattern = "\"name\":\"my\\.skill\""`), off);
  assert.ok(geminiPolicy(testAgent('gemini', { options: { disabled: { tools: ['a"b'] } } as any })).includes(String.raw`toolName = "a\"b"`), 'names are escaped');
});

test('first turn: session with the room MCP endpoint, framing, context and ask; usage from the CLI; second turn reuses the session', async () => {
  const { driver, agent, room, peers, children, host } = setup();
  const sink = recordingSink();
  const result = await driver.turn(request(room, agent, sink, { context: '<room from="User">hi</room>' }));
  assert.equal(result.status, 'complete'); assert.equal(result.text, 'Hello');
  assert.deepEqual({ input: result.usage.input, output: result.usage.output, cached: result.usage.cached, estimated: result.usage.estimated }, { input: 100, output: 7, cached: 40, estimated: false });
  const peer = peers[0]!;
  assert.equal(children[0]!.args[0], '--acp'); assert.equal(children[0]!.cwd, host.cwd());
  assert.equal(children[0]!.env.GEMINI_CLI_NO_RELAUNCH, 'true', 'one process to stop'); assert.equal(children[0]!.env.GEMINI_CLI_TRUST_WORKSPACE, 'true', 'trusted in VS Code');
  assert.deepEqual(method(peer, 'session/new')[0]!.params, { cwd: host.cwd(), mcpServers: [{ type: 'http', name: 'chatroom', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer test' }] }] });
  assert.deepEqual(promptOf(peer), [{ type: 'text', text: 'FRAMING' }, { type: 'text', text: '<room from="User">hi</room>' }, { type: 'text', text: 'Do it' }]);
  assert.deepEqual(sink.sessions[0], { id: 'sess-0', provider: 'gemini', startedAt: sink.sessions[0]!.startedAt });
  // The policy really is on disk, where the flag says.
  assert.ok(readFileSync(children[0]!.args[children[0]!.args.indexOf('--policy') + 1]!, 'utf8').includes('mcpName = "chatroom"'));
  adopt(agent, sink);
  await driver.turn(request(room, agent, recordingSink(), { ask: 'Again' }));
  assert.equal(children.length, 1, 'same process'); assert.equal(method(peer, 'session/new').length, 1); assert.equal(method(peer, 'session/load').length, 0);
  assert.deepEqual(promptOf(peer, 1), [{ type: 'text', text: 'Again' }], 'framing goes once');
  await driver.dispose();
});

test('permission levels map to the CLI modes; a mode the CLI lacks falls back to default; the model is set once', async () => {
  for (const [permission, mode] of [['plan', 'plan'], ['auto-edit', 'autoEdit'], ['full', 'yolo']] as const) {
    const { driver, agent, room, peers } = setup(undefined, { host: { settings: () => ({ allowFullAccess: true, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} }) }, agent: { model: 'gemini-2.5-pro', options: { permission } as any } });
    const sink = recordingSink();
    await driver.turn(request(room, agent, sink)); adopt(agent, sink);
    await driver.turn(request(room, agent, recordingSink()));
    assert.deepEqual(method(peers[0]!, 'session/set_mode').map(c => c.params.modeId), [mode], permission);
    assert.deepEqual(method(peers[0]!, 'session/set_model').map(c => c.params.modelId), ['gemini-2.5-pro']);
    await driver.dispose();
  }
  const ask = setup();
  await ask.driver.turn(request(ask.room, ask.agent, recordingSink()));
  assert.equal(method(ask.peers[0]!, 'session/set_mode').length, 0, 'Ask is the default mode');
  await ask.driver.dispose();
  const noPlan = setup(() => ({ 'session/new': () => ({ sessionId: 'sess-0', modes: { currentModeId: 'autoEdit', availableModes: [{ id: 'default' }, { id: 'autoEdit' }] } }) }), { agent: { options: { permission: 'plan' } as any } });
  await noPlan.driver.turn(request(noPlan.room, noPlan.agent, recordingSink()));
  assert.deepEqual(method(noPlan.peers[0]!, 'session/set_mode').map(c => c.params.modeId), ['default']);
  await noPlan.driver.dispose();
  // Without chatroom.allowFullAccess, Full access asks.
  const denied = setup(undefined, { agent: { options: { permission: 'full' } as any } });
  await denied.driver.turn(request(denied.room, denied.agent, recordingSink()));
  assert.equal(method(denied.peers[0]!, 'session/set_mode').length, 0);
  await denied.driver.dispose();
});

test('the CLI reports a changed mode as message text; it never reaches the answer', async () => {
  const { driver, agent, room } = setup(peer => ({ 'session/prompt': () => {
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before ' } });
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[MODE_UPDATE] default' } });
    peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } });
    return { stopReason: 'end_turn' };
  } }));
  const result = await driver.turn(request(room, agent, recordingSink()));
  assert.equal(result.text, 'Before after');
  await driver.dispose();
});

test('resume: history the CLI replays after answering session/load stays out of the next turn', async () => {
  const { driver, agent, room, peers, children } = setup(peer => ({ 'session/load': () => {
    peer.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
    // The CLI keeps replaying after its answer, and a slow machine can take a moment.
    setTimeout(() => { peer.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'old thought' } }); peer.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD ANSWER' } }); }, 40);
    return { modes: MODES(), models: MODELS() };
  } }), { agent: { session: { id: 'stored-1' } } });
  const sink = recordingSink();
  const result = await driver.turn(request(room, agent, sink, { context: 'new room messages' }));
  assert.equal(result.text, 'Hello'); assert.deepEqual(sink.texts, ['Hello']); assert.deepEqual(sink.thinkings, []);
  assert.equal(children.length, 1); assert.deepEqual(method(peers[0]!, 'session/load')[0]!.params.sessionId, 'stored-1'); assert.equal(method(peers[0]!, 'session/new').length, 0);
  assert.deepEqual(promptOf(peers[0]!), [{ type: 'text', text: 'new room messages' }, { type: 'text', text: 'Do it' }], 'no framing, no full history');
  assert.deepEqual(sink.sessions, [], 'the session id did not change');
  await driver.dispose();
});

test('a session that cannot be resumed starts over with the room history; an API key without a saved auth type too', async () => {
  for (const load of [{ code: -32603, message: 'Internal error' }, { code: -32000, message: 'Authentication required' }]) {
    const { driver, agent, room, peers } = setup(() => ({ 'session/load': () => { throw load; } }), { agent: { session: { id: 'gone' } } });
    const sink = recordingSink();
    const result = await driver.turn(request(room, agent, sink, { context: 'only new' }));
    assert.equal(result.status, 'complete', load.message);
    assert.deepEqual(promptOf(peers[0]!), [{ type: 'text', text: 'FRAMING' }, { type: 'text', text: 'FULL HISTORY' }, { type: 'text', text: 'Do it' }]);
    assert.equal(sink.sessions[0]!.id, 'sess-0'); assert.ok(sink.activities.some(a => a.id === 'resume'));
    await driver.dispose();
  }
});

test('capabilities: models, commands without subcommands or help, skills from its folders, and every MCP server', async () => {
  const home = mkdtempSync(join(tmpdir(), 'chatroom-gemini-home-')), saved = process.env.GEMINI_CLI_HOME;
  mkdirSync(join(home, '.gemini'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'settings.json'), '// a comment\n{ "mcpServers": { "pathview": {}, "structlens": {} } }');
  process.env.GEMINI_CLI_HOME = home;
  const skill = (name: string, nativeTo: SharedSkill['nativeTo']): SharedSkill => ({ name, description: `${name} skill`, path: `/s/${name}/SKILL.md`, dir: `/s/${name}`, source: 'agents-user', nativeTo });
  const { driver, agent, room, peers } = setup(undefined, { host: { skillWiring: () => ({ codexExtraRoots: [], skills: [skill('mine', ['gemini']), skill('other', ['claude'])] }) } });
  try {
    const first = await driver.capabilities(room, agent);
    assert.equal(first.status, 'ready'); assert.equal(first.version, '0.66.0');
    assert.deepEqual(first.models.map(m => [m.id, !!m.isDefault]), [['auto', true], ['gemini-2.5-pro', false]]);
    assert.deepEqual(first.mcpServers.map(s => s.name), ['chatroom', 'pathview', 'structlens']);
    assert.deepEqual(first.skills.map(s => s.name), ['mine']); assert.deepEqual(first.tools, []);
    assert.equal(first.supports.fullAccess, true); assert.equal(first.supports.thinkHard, false); assert.equal(first.supports.useProjectSettings, false);
    assert.deepEqual(first.canDisable, { tools: true, toolsByName: true, skills: true, mcpServers: true, commands: true });
    assert.equal(method(peers[0]!, 'session/prompt').length, 0, 'never starts inference');
    // On the first call: the CLI lists them just after answering session/new.
    assert.deepEqual(first.commands.map(c => c.name), ['memory', 'about'], 'no subcommands, no help');
  } finally { await driver.dispose(); if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved; }
});

test('what is turned off: omitted from the session, denied by the policy, and a change restarts the process at the next turn', async () => {
  const shared = { docs: { type: 'stdio' as const, command: 'docs-mcp', args: [] }, wiki: { type: 'stdio' as const, command: 'wiki-mcp', args: [] } };
  const { driver, agent, room, peers, children } = setup(undefined, { host: { settings: () => ({ allowFullAccess: false, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: shared }) }, agent: { options: { disabled: { mcpServers: ['chatroom', 'docs'] } } as any } });
  const sink = recordingSink();
  await driver.turn(request(room, agent, sink)); adopt(agent, sink);
  assert.deepEqual(method(peers[0]!, 'session/new')[0]!.params.mcpServers.map((s: any) => s.name), ['wiki']);
  await driver.turn(request(room, agent, recordingSink()));
  assert.equal(children.length, 1, 'no change, same process');
  agent.options.disabled = { tools: ['web_fetch'] };
  await driver.turn(request(room, agent, recordingSink()));
  assert.equal(children.length, 2, 'the policy changed, so a new process');
  assert.ok(readFileSync(children[1]!.args[children[1]!.args.indexOf('--policy') + 1]!, 'utf8').includes('toolName = "web_fetch"'));
  assert.deepEqual(method(peers[1]!, 'session/load')[0]!.params.mcpServers.map((s: any) => s.name), ['chatroom', 'docs', 'wiki'], 'servers turned back on return');
  await driver.dispose();
});

test('a turned-off server no rule can reach is left out of an allow-list; ordinary names keep extension servers running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'chatroom-gemini-home-')), saved = process.env.GEMINI_CLI_HOME;
  mkdirSync(join(home, '.gemini'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { 'my server': {}, keep: {} } }));
  process.env.GEMINI_CLI_HOME = home;
  try {
    const spaced = setup(undefined, { agent: { options: { disabled: { mcpServers: ['my server'] } } as any } });
    await spaced.driver.turn(request(spaced.room, spaced.agent, recordingSink()));
    const args = spaced.children[0]!.args, allowed = args.flatMap((a, i) => a === '--allowed-mcp-server-names' ? [args[i + 1]] : []);
    assert.deepEqual(allowed, ['chatroom', 'keep']);
    await spaced.driver.dispose();
    const plain = setup(undefined, { agent: { options: { disabled: { mcpServers: ['keep'] } } as any } });
    await plain.driver.turn(request(plain.room, plain.agent, recordingSink()));
    assert.ok(!plain.children[0]!.args.includes('--allowed-mcp-server-names'), 'a rule is enough: no allow-list');
    await plain.driver.dispose();
  } finally { if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved; }
});

test('the same rules share one policy file', async () => {
  const { driver, agent, room, children } = setup();
  const other = testAgent('gemini', { id: 'gemini-2' }), withOff = testAgent('gemini', { id: 'gemini-3', options: { disabled: { tools: ['web_fetch'] } } as any });
  for (const a of [agent, other, withOff]) await driver.turn(request(room, a, recordingSink()));
  const policy = (i: number) => children[i]!.args[children[i]!.args.indexOf('--policy') + 1];
  assert.equal(policy(0), policy(1)); assert.notEqual(policy(0), policy(2));
  await driver.dispose();
});

test('permissions: Ask shows a card with the diff; Allow, Allow for session and Deny pick the right option, and never one that saves for all sessions', async () => {
  const edit = { kind: 'edit', locations: [{ path: 'a.txt' }], content: [{ type: 'diff', path: 'a.txt', oldText: 'old', newText: 'new' }] };
  for (const [decision, optionId] of [['allow', 'proceed_once'], ['allow-session', 'proceed_always'], ['deny', 'cancel']] as const) {
    const { chosen, custom } = asking(edit), { driver, agent, room } = setup(custom);
    const sink = recordingSink(() => ({ decision } as ApprovalDecision));
    await driver.turn(request(room, agent, sink));
    assert.deepEqual(chosen[0], selected(optionId), decision);
    assert.equal(sink.approvals[0]!.kind, 'edit'); assert.equal(sink.approvals[0]!.canAllowSession, true); assert.match(sink.approvals[0]!.diff!, /-old\n\+new/);
    await driver.dispose();
  }
  // An MCP tool: for this session means this tool, not the whole server.
  const mcp = [{ optionId: 'proceed_always_server', name: 'All', kind: 'allow_always' }, { optionId: 'proceed_always_tool', name: 'Tool', kind: 'allow_always' }, ...OPTIONS.slice(2)];
  const server = asking({ kind: 'other' }, mcp), one = setup(server.custom);
  await one.driver.turn(request(one.room, one.agent, recordingSink(() => ({ decision: 'allow-session' }))));
  assert.deepEqual(server.chosen[0], selected('proceed_always_tool'));
  await one.driver.dispose();
  // Only the saving option: the card does not offer Allow for session.
  const saving = asking({ kind: 'edit' }, [OPTIONS[1]!, ...OPTIONS.slice(2)]), two = setup(saving.custom), sink = recordingSink();
  await two.driver.turn(request(two.room, two.agent, sink));
  assert.equal(sink.approvals[0]!.canAllowSession, false);
  await two.driver.dispose();
});

test('permissions by level: Plan refuses edits and commands, Full access allows, Auto-edit allows what is inside the folder', async () => {
  const run = async (permission: string, call: object, settings?: DriverHost['settings']) => {
    const { chosen, custom } = asking(call), { driver, agent, room } = setup(custom, { ...(settings ? { host: { settings } } : {}), agent: { options: { permission } as any } });
    const approvals: ApprovalRequest[] = [], sink = recordingSink(request => { approvals.push(request); return { decision: 'allow' }; });
    await driver.turn(request(room, agent, sink));
    await driver.dispose();
    return { choice: chosen[0], approvals };
  };
  for (const kind of ['edit', 'delete', 'move', 'execute']) {
    const plan = await run('plan', { kind }); assert.deepEqual(plan.choice, selected('cancel'), kind); assert.equal(plan.approvals.length, 0);
  }
  const allowed = () => ({ allowFullAccess: true, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} });
  const full = await run('full', { kind: 'execute' }, allowed);
  assert.deepEqual(full.choice, selected('proceed_once')); assert.equal(full.approvals.length, 0);
  const notAllowed = await run('full', { kind: 'execute' });
  assert.equal(notAllowed.approvals.length, 1, 'Full access without the setting asks');
  const inside = await run('auto-edit', { kind: 'edit', locations: [{ path: join(tmpdir(), 'a.txt') }] });
  assert.deepEqual(inside.choice, selected('proceed_once')); assert.equal(inside.approvals.length, 0);
  const outside = await run('auto-edit', { kind: 'edit', locations: [{ path: join(tmpdir(), '..', 'elsewhere', 'a.txt') }] });
  assert.equal(outside.approvals.length, 1, 'outside the folder it asks');
  const command = await run('auto-edit', { kind: 'execute' });
  assert.equal(command.approvals[0]!.kind, 'command');
  const fetch = await run('ask', { kind: 'fetch' });
  assert.equal(fetch.approvals[0]!.kind, 'network');
});

test('leaving plan mode is a plan approval, and approving it moves the agent to Ask', async () => {
  const { chosen, custom } = asking({ kind: 'switch_mode', title: 'Exit plan mode' }), { driver, agent, room } = setup(custom, { agent: { options: { permission: 'plan' } as any } });
  const sink = recordingSink();
  await driver.turn(request(room, agent, sink));
  assert.equal(sink.approvals[0]!.kind, 'plan'); assert.deepEqual(chosen[0], selected('proceed_once'));
  assert.deepEqual(sink.optionPatches[0], { permission: 'ask', exitPlan: true });
  await driver.dispose();
});

test('the CLI missing, too old, signed out, or no longer serving this login: said plainly, with the right fix', async () => {
  const missing = setup(undefined, { host: { runtime: async () => undefined } });
  const absent = await missing.driver.capabilities(missing.room, missing.agent);
  assert.equal(absent.status, 'missing'); assert.equal(absent.action, 'installGemini'); assert.match(absent.detail!, /npm i -g @google\/gemini-cli/);
  await assert.rejects(missing.driver.turn(request(missing.room, missing.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'missing' && e.extra.action === 'installGemini');
  assert.equal(missing.children.length, 0);

  const runtime = { executable: { command: 'node', prefix: ['/g/dist/index.js'] }, version: '0.1.18', source: 'PATH executable', modern: false };
  const old = setup(undefined, { host: { runtime: async () => runtime } });
  const tooOld = await old.driver.capabilities(old.room, old.agent);
  assert.equal(tooOld.status, 'missing'); assert.equal(tooOld.action, 'updateGemini'); assert.equal(tooOld.version, '0.1.18'); assert.match(tooOld.detail!, /0\.1\.18 is too old.*0\.38\.0.*@latest/);
  await assert.rejects(old.driver.turn(request(old.room, old.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'missing' && e.extra.action === 'updateGemini');
  assert.equal(old.children.length, 0, 'an old CLI is never started: it speaks another protocol');

  for (const [text, pattern] of [['Authentication required.', /Sign in to the Gemini CLI/], ['Gemini API key is missing or not configured.', /GEMINI_API_KEY/],
    ['Please migrate to Antigravity CLI', /June 18, 2026.*paid Gemini API key.*Antigravity/], ['This account is not eligible for Gemini CLI', /June 18, 2026/], ['An account restriction we did not foresee', /Sign in to the Gemini CLI.*restriction/]] as const) {
    const out = setup(() => ({ 'session/new': () => { throw { code: -32000, message: text }; } }));
    const caps = await out.driver.capabilities(out.room, out.agent);
    assert.equal(caps.status, 'signed-out', text); assert.equal(caps.action, 'geminiLogin'); assert.match(caps.detail!, pattern); assert.ok(caps.detail!.includes(text), 'keeps what the CLI said');
    await assert.rejects(out.driver.turn(request(out.room, out.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'signed-out');
    await out.driver.dispose();
  }
});

test('a CLI waiting for a sign-in it cannot ask for never answers: said plainly, without waiting long', async () => {
  const fake = fakeGemini(() => ({ 'session/new': () => undefined, 'session/load': () => undefined })), host = fakeHost(), driver = new GeminiDriver(host, fake.spawn, 30);
  const agent = testAgent('gemini'), room = testRoom([agent]);
  const caps = await driver.capabilities(room, agent);
  assert.equal(caps.status, 'signed-out'); assert.equal(caps.action, 'geminiLogin'); assert.match(caps.detail!, /waiting for a sign-in.*Sign in to the Gemini CLI/);
  await assert.rejects(driver.turn(request(room, agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'signed-out');
  // The real case: the CLI takes the first message as the console's reply, so initialize is never answered.
  const silent = fakeGemini(() => ({ initialize: () => undefined })), quiet = new GeminiDriver(fakeHost(), silent.spawn, 30);
  const unanswered = await quiet.capabilities(room, agent);
  assert.equal(unanswered.status, 'signed-out'); assert.equal(unanswered.action, 'geminiLogin'); assert.match(unanswered.detail!, /waiting for a sign-in/);
  await quiet.dispose();
  // The same for a stored session: capabilities do not claim it is ready.
  const stored = testAgent('gemini', { id: 'stored', session: { id: 'old' } });
  assert.equal((await driver.capabilities(room, stored)).status, 'signed-out');
  await driver.dispose();
});

test('errors during a turn: rate limit, model, crash', async () => {
  const fail = (error: object) => setup(() => ({ 'session/prompt': () => { throw error; } }));
  const limit = fail({ code: 429, message: 'Rate limit exceeded. Try again later.' });
  await assert.rejects(limit.driver.turn(request(limit.room, limit.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'usage-limit');
  await limit.driver.dispose();
  const model = fail({ code: 404, message: 'models/gemini-x is not found' });
  await assert.rejects(model.driver.turn(request(model.room, model.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'model-unavailable');
  await model.driver.dispose();
  const auth = fail({ code: 401, message: 'Request had invalid credentials' });
  await assert.rejects(auth.driver.turn(request(auth.room, auth.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'signed-out');
  await auth.driver.dispose();
  // A refusal from the service, with its own words kept.
  const refused = fail({ code: 403, message: 'The caller does not have permission' });
  await assert.rejects(refused.driver.turn(request(refused.room, refused.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'signed-out' && /June 18, 2026/.test(e.message) && /does not have permission/.test(e.message));
  await refused.driver.dispose();
  // The CLI gives up on signing in at startup.
  const failedLogin = setup(peer => { peer.child.stderr('Error authenticating: login failed'); peer.child.exit(41); return {}; });
  const out = await failedLogin.driver.capabilities(failedLogin.room, failedLogin.agent);
  assert.equal(out.status, 'signed-out'); assert.equal(out.action, 'geminiLogin'); assert.match(out.detail!, /Error authenticating/);
  await failedLogin.driver.dispose();
  const crash = setup(peer => ({ 'session/prompt': () => { peer.child.stderr('boom'); peer.child.exit(3); return undefined; } }));
  await assert.rejects(crash.driver.turn(request(crash.room, crash.agent, recordingSink())), (e: unknown) => e instanceof ProviderError && e.code === 'crashed');
});

test('commands: /compact explains itself, others run in the CLI, unknown ones are refused, and no session means nothing to do', async () => {
  const { driver, agent, room, peers } = setup();
  const empty = await driver.turn(request(room, agent, recordingSink(), { command: { name: 'memory', args: '' } }));
  assert.match(empty.text, /No session yet/); assert.equal(peers.length, 0);
  const sink = recordingSink();
  await driver.turn(request(room, agent, sink)); adopt(agent, sink);
  const compact = await driver.turn(request(room, agent, recordingSink(), { command: { name: 'compact', args: '' } }));
  assert.match(compact.text, /compresses its own session/); assert.equal(compact.status, 'complete');
  assert.equal(method(peers[0]!, 'session/prompt').length, 1, '/compact sends nothing: the CLI would pass it to the model');
  await driver.turn(request(room, agent, recordingSink(), { command: { name: 'memory', args: 'show' } }));
  assert.deepEqual(promptOf(peers[0]!, 1), [{ type: 'text', text: '/memory show' }]);
  await assert.rejects(driver.turn(request(room, agent, recordingSink(), { command: { name: 'nope', args: '' } })), (e: unknown) => e instanceof ProviderError && e.code === 'unsupported');
  await driver.dispose();
});

test('stop: cancels natively, and the turn ends as interrupted', async () => {
  const controller = new AbortController();
  const { driver, agent, room, peers } = setup(() => ({ 'session/prompt': () => undefined, 'session/cancel': () => undefined }));
  const running = driver.turn(request(room, agent, recordingSink(), { signal: controller.signal }));
  await waitFor(() => peers[0] && method(peers[0], 'session/prompt').length, 2000, 'the prompt');
  controller.abort();
  await waitFor(() => method(peers[0]!, 'session/cancel').length, 2000, 'the cancel');
  peers[0]!.rpc.notify('session/update', { sessionId: 'sess-0', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } });
  // The CLI answers the cancelled prompt: fake it by answering the pending request.
  const prompt = peers[0]!.child.received.find(m => m?.method === 'session/prompt');
  peers[0]!.child.emit({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
  const result = await running;
  assert.equal(result.status, 'interrupted'); assert.equal(result.delivered, true);
  await driver.dispose();
});

test('release ends the room\'s process and keeps the stored session; the next turn resumes it', async () => {
  const { driver, agent, room, peers, children } = setup();
  const sink = recordingSink();
  await driver.turn(request(room, agent, sink)); adopt(agent, sink);
  await driver.release(room.id);
  assert.equal(children[0]!.exited, true);
  await driver.turn(request(room, agent, recordingSink()));
  assert.equal(children.length, 2); assert.equal(method(peers[1]!, 'session/load')[0]!.params.sessionId, 'sess-0');
  await driver.dispose();
});
