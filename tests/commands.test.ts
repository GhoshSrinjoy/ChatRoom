import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_SCOPED, NATIVE_COMMAND_DENYLIST, ROOM_COMMANDS, extractHandoffs, filterNativeCommands, markerOf, parseComposer, parseDuration, parseLoop, parseTeam, resolveMention, stripCode } from '../src/commands';
import { Agent, AgentCapabilities, NativeCommand, ProviderId } from '../src/types';

const agent = (id: string, name: string, provider: ProviderId, enabled = true): Agent => ({ id, name, provider, model: '', role: '', enabled, tools: [],
  options: { effort: '', thinking: 'on', summary: 'auto', permission: 'ask', useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false } });
const caps = (provider: ProviderId, commands: NativeCommand[], runtime: AgentCapabilities['runtime'] = 'cli'): AgentCapabilities => ({ provider, runtime, status: 'ready', models: [], efforts: [], tools: [], skills: [],
  commands, mcpServers: [], updatedAt: 0, supports: { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: false, useSkills: false, useProjectSettings: false,
    extraDirs: false, ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: false, customAgent: false } });
const cmd = (name: string, extra: Partial<NativeCommand> = {}): NativeCommand => ({ name, source: 'builtin', ...extra });
const claude = agent('a1', 'Claude', 'claude'), codex = agent('a2', 'Codex', 'codex'), copilot = agent('a3', 'Copilot', 'copilot'), ollama = agent('a4', 'Llama', 'ollama');
const claude2 = agent('a5', 'Claude 2', 'claude');
const agents = [claude, codex, copilot, ollama];
const capsMap: Record<string, AgentCapabilities> = {
  a1: caps('claude', [cmd('review'), cmd('pr-comments', { aliases: ['prc'] }), cmd('Deploy', { source: 'skill' }), cmd('login'), cmd('compact')]),
  a2: caps('codex', [cmd('review', { source: 'mapped' }), cmd('goal', { source: 'mapped' }), cmd('pdf-tools', { source: 'skill' })]),
  a3: caps('copilot', [cmd('fleet'), cmd('review')]),
  a4: caps('ollama', [cmd('fleet')], 'ollama'),
};

test('room commands table is exact and agent-scoped names are derived from it', () => {
  assert.deepEqual(ROOM_COMMANDS.map(c => c.name), ['help', 'clear', 'compact', 'new', 'export', 'loop', 'mode', 'lead', 'team', 'model', 'effort', 'permissions', 'status', 'stop']);
  assert.deepEqual(AGENT_SCOPED, ['clear', 'compact', 'model', 'effort', 'permissions', 'status']);
  assert.equal(ROOM_COMMANDS.find(c => c.name === 'loop')?.args, '[N | consensus | done | every 10m <prompt> | off]');
  assert.equal(ROOM_COMMANDS.find(c => c.name === 'compact')?.description, "Summarize each agent's native session to free context");
  assert.equal(NATIVE_COMMAND_DENYLIST.codex.length, 0);
  assert.deepEqual(ROOM_COMMANDS.find(c => c.name === 'team'), { name: 'team', args: '[name | Lead: Claude > Draft: Codex > … | save <name> | edit | off]', description: 'Set up your own team: stages such as lead, drafting, review, testing', agentScoped: false });
});

test('stripCode blanks fences and inline code but keeps offsets and lines', () => {
  const text = 'a `@Codex x` b\n```\n@Claude go\n```\nc';
  const out = stripCode(text);
  assert.equal(out.length, text.length);
  assert.equal(out.split('\n').length, text.split('\n').length);
  assert.ok(!out.includes('@'));
  assert.ok(out.startsWith('a ') && out.endsWith('c'));
  assert.ok(!stripCode('x\n```\n@Codex unclosed').includes('@'));
});

test('resolveMention: names, quotes, all, lead, provider aliases and plain text', () => {
  assert.deepEqual(resolveMention('claude', agents), [claude]);
  assert.deepEqual(resolveMention('CODEX', agents), [codex]);
  assert.equal(resolveMention('everyone', agents), 'all');
  assert.equal(resolveMention('room', agents), 'all');
  assert.deepEqual(resolveMention('lead', agents, 'a2'), [codex]);
  assert.deepEqual(resolveMention('lead', agents), [claude]);
  assert.deepEqual(resolveMention('github copilot', agents), [copilot]);
  assert.deepEqual(resolveMention('ollama', agents), [ollama]);
  assert.deepEqual(resolveMention('Claude 2', [...agents, claude2]), [claude2]);
  // Two enabled Claude agents: the provider alias is ambiguous, but the exact name still wins.
  const two = [agent('x1', 'Opus', 'claude'), agent('x2', 'Sonnet', 'claude')];
  assert.equal(resolveMention('claude', two), undefined);
  assert.equal(resolveMention('claude code', two), undefined);
  assert.equal(resolveMention('src', agents), undefined);
});

test('parseComposer: plain messages, mentions, quotes, all and lead', () => {
  assert.deepEqual(parseComposer('  hello room  ', agents, capsMap), { text: 'hello room', targets: [], all: false });
  assert.deepEqual(parseComposer('@Claude hi', agents, capsMap).targets, ['a1']);
  assert.deepEqual(parseComposer('@claude @Codex compare notes', agents, capsMap).targets, ['a1', 'a2']);
  assert.deepEqual(parseComposer('@Codex then @claude, and @codex again', agents, capsMap).targets, ['a2', 'a1']);
  assert.deepEqual(parseComposer('Can you look, @Copilot?', agents, capsMap).targets, ['a3']);
  const all = parseComposer('@all @Claude what do you think?', agents, capsMap);
  assert.equal(all.all, true); assert.deepEqual(all.targets, []);
  assert.deepEqual(parseComposer('@lead plan this', agents, capsMap, 'a3').targets, ['a3']);
  assert.deepEqual(parseComposer('@"Claude 2" review this', [...agents, claude2], capsMap).targets, ['a5']);
  assert.equal(parseComposer('', agents, capsMap).error, 'Write a message first.');
});

test('parseComposer: file-like tokens, emails and code stay text', () => {
  assert.deepEqual(parseComposer('look at @src/a.ts please', agents, capsMap).targets, []);
  assert.deepEqual(parseComposer('fix @claude/settings.json', agents, capsMap).targets, []);
  assert.deepEqual(parseComposer('mail me@claude.ai now', agents, capsMap).targets, []);
  assert.deepEqual(parseComposer('run `@Codex` literally\n```\n@Claude\n```', agents, capsMap).targets, []);
  const literal = parseComposer('//compact is a word', agents, capsMap);
  assert.deepEqual(literal, { text: '/compact is a word', targets: [], all: false });
});

test('parseComposer: room commands with and without targets', () => {
  assert.deepEqual(parseComposer('/help', agents, capsMap).command, { name: 'help', args: '', scope: 'room', agentIds: [] });
  assert.deepEqual(parseComposer('/LOOP every 10m check CI', agents, capsMap).command, { name: 'loop', args: 'every 10m check CI', scope: 'room', agentIds: [] });
  assert.deepEqual(parseComposer('/compact keep the API notes', agents, capsMap).command, { name: 'compact', args: 'keep the API notes', scope: 'room', agentIds: [] });
  // Agent-scoped commands take the leading mentions; mentions in the arguments are not targets.
  assert.deepEqual(parseComposer('@Claude, @Codex /compact focus', agents, capsMap).command, { name: 'compact', args: 'focus', scope: 'room', agentIds: ['a1', 'a2'] });
  assert.deepEqual(parseComposer('/compact keep what @Codex found', agents, capsMap).command, { name: 'compact', args: 'keep what @Codex found', scope: 'room', agentIds: [] });
  assert.deepEqual(parseComposer('@Codex /model gpt-6', agents, capsMap).command, { name: 'model', args: 'gpt-6', scope: 'room', agentIds: ['a2'] });
  // A non-scoped room command with a target applies room-wide.
  assert.deepEqual(parseComposer('@Codex /mode team', agents, capsMap).command, { name: 'mode', args: 'team', scope: 'room', agentIds: ['a2'] });
  assert.deepEqual(parseComposer('/team Lead: Claude > Review: Codex', agents, capsMap).command, { name: 'team', args: 'Lead: Claude > Review: Codex', scope: 'room', agentIds: [] });
  assert.deepEqual(parseComposer('@all /compact', agents, capsMap).command, { name: 'compact', args: '', scope: 'room', agentIds: [] });
  // Native commands that share a room command name are filtered out of the agent's list (the room command wins).
  assert.deepEqual(parseComposer('@Claude /compact', agents, capsMap).command?.scope, 'room');
});

test('parseComposer: native commands route to their owner, ambiguity and unknown names are errors', () => {
  assert.deepEqual(parseComposer('/goal ship it', agents, capsMap).command, { name: 'goal', args: 'ship it', scope: 'native', agentIds: ['a2'] });
  assert.deepEqual(parseComposer('/prc 12', agents, capsMap).command, { name: 'prc', args: '12', scope: 'native', agentIds: ['a1'] });
  assert.deepEqual(parseComposer('/deploy', agents, capsMap).command, { name: 'Deploy', args: '', scope: 'native', agentIds: ['a1'] });
  assert.equal(parseComposer('/review', agents, capsMap).error, 'Several agents have /review: mention one, e.g. @Claude /review.');
  assert.deepEqual(parseComposer('@Codex /review the parser', agents, capsMap).command, { name: 'review', args: 'the parser', scope: 'native', agentIds: ['a2'] });
  assert.deepEqual(parseComposer('@Claude @Copilot /review', agents, capsMap).command, { name: 'review', args: '', scope: 'native', agentIds: ['a1', 'a3'] });
  assert.equal(parseComposer('/frobnicate', agents, capsMap).error, 'Unknown command /frobnicate. Type / to see the commands.');
  assert.equal(parseComposer('/login', agents, capsMap).error, 'Unknown command /login. Type / to see the commands.');
  assert.equal(parseComposer('@Codex /fleet', agents, capsMap).error, 'Codex has no /fleet command.');
  assert.equal(parseComposer('@Claude @Codex /goal x', agents, capsMap).error, 'Claude has no /goal command.');
  // Legacy agents (Ollama, Copilot through vscode.lm) are never native targets.
  assert.equal(parseComposer('@Llama /fleet', agents, capsMap).error, 'Llama has no /fleet command.');
  const lm = { ...capsMap, a3: caps('copilot', [cmd('fleet')], 'vscode-lm') };
  assert.equal(parseComposer('/fleet', agents, lm).error, 'Unknown command /fleet. Type / to see the commands.');
  assert.equal(parseComposer('@Clade /compact', agents, capsMap).error, 'No agent named @Clade in this room.');
  const off = [agent('a1', 'Claude', 'claude', false), codex];
  assert.equal(parseComposer('@Claude /compact', off, capsMap).error, 'Claude is turned off. Turn it on first.');
  assert.equal(parseComposer('@Claude hi', off, capsMap).error, 'Claude is turned off. Turn it on first.');
  assert.deepEqual(parseComposer('/usr/bin is broken', agents, capsMap), { text: '/usr/bin is broken', targets: [], all: false });
});

test('filterNativeCommands applies the denylist, prefixes and room-routed names', () => {
  const list = [cmd('/review'), cmd('login'), cmd('login-sso'), cmd('compact'), cmd('model'), cmd('init'), cmd('review'), cmd('Help')];
  assert.deepEqual(filterNativeCommands('claude', list).map(c => c.name), ['review', 'init']);
  assert.deepEqual(filterNativeCommands('copilot', [cmd('fleet'), cmd('yolo'), cmd('allow-all'), cmd('status'), cmd('plan')]).map(c => c.name), ['fleet', 'plan']);
  assert.deepEqual(filterNativeCommands('codex', [cmd('review'), cmd('clear'), cmd('goal')]).map(c => c.name), ['review', 'goal']);
});

test('extractHandoffs: line-start mentions only, list markers, several agents, self and @all ignored', () => {
  const text = [
    'I looked at the parser.',
    'Maybe @Codex knows, but this is mid-line.',
    '- @Codex can you check the failing test?',
    '@Claude, @Copilot: review src/a.ts',
    '@all please weigh in',
    '@Claude I mention myself',
    '**@Copilot** bold works too',
    '@Codex',
    '',
    'run the benchmarks',
    '```',
    '@Copilot inside code',
    '```',
    '> @User thanks',
  ].join('\n');
  assert.deepEqual(extractHandoffs(text, claude, agents), [
    { agentId: 'a2', line: 'can you check the failing test?' },
    { agentId: 'a3', line: 'review src/a.ts' },
    { agentId: 'a3', line: 'bold works too' },
    { agentId: 'a2', line: 'run the benchmarks' },
  ]);
  assert.deepEqual(extractHandoffs('1. @Claude run `npm test` please', codex, agents), [{ agentId: 'a1', line: 'run `npm test` please' }]);
  assert.deepEqual(extractHandoffs('@lead done here', codex, agents, 'a3'), [{ agentId: 'a3', line: 'done here' }]);
  assert.deepEqual(extractHandoffs('@Claude x', codex, [agent('a1', 'Claude', 'claude', false), codex]), []);
  assert.equal(extractHandoffs('@Claude ' + 'x'.repeat(900), codex, agents)[0]?.line.length, 500);
});

test('parseLoop covers every form and rejects the rest', () => {
  assert.deepEqual(parseLoop(''), { show: true });
  assert.deepEqual(parseLoop('off'), { loop: { kind: 'once' } });
  assert.deepEqual(parseLoop('ONCE'), { loop: { kind: 'once' } });
  assert.deepEqual(parseLoop('3'), { loop: { kind: 'rounds', rounds: 3 } });
  assert.deepEqual(parseLoop('rounds 50'), { loop: { kind: 'rounds', rounds: 50 } });
  assert.deepEqual(parseLoop('consensus'), { loop: { kind: 'consensus' } });
  assert.deepEqual(parseLoop('consensus max 4'), { loop: { kind: 'consensus', maxIterations: 4 } });
  assert.deepEqual(parseLoop('Done MAX 7'), { loop: { kind: 'lead-done', maxIterations: 7 } });
  assert.deepEqual(parseLoop('every 10m'), { loop: { kind: 'interval', everyMinutes: 10 } });
  assert.deepEqual(parseLoop('every 30s Check  the CI'), { loop: { kind: 'interval', everyMinutes: 1 }, prompt: 'Check  the CI' });
  assert.deepEqual(parseLoop('every 1h30m max 3 Re-run The tests'), { loop: { kind: 'interval', everyMinutes: 90, maxIterations: 3 }, prompt: 'Re-run The tests' });
  const usage = { error: 'Usage: /loop [N | consensus | done | every 10m <prompt> | off]' };
  for (const bad of ['0', '51', 'rounds', 'rounds x', '3 4', 'consensus max', 'consensus max 0', 'done now', 'every', 'every soon', 'every 10m max 99', 'every 25h', 'forever', 'off now'])
    assert.deepEqual(parseLoop(bad), usage, bad);
});

test('parseDuration', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('90m'), 5_400_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2H'), 7_200_000);
  for (const bad of ['', '10', 'm', '0m', '1.5h', '-5m', '5 m', '30m1h']) assert.equal(parseDuration(bad), undefined, bad);
});

test('markerOf', () => {
  assert.equal(markerOf('Looks right to me. [AGREE]'), 'agree');
  assert.equal(markerOf('Nothing to add.\n[CONSENSUS]'), 'agree');
  assert.equal(markerOf('All done. [DONE]  '), 'done');
  assert.equal(markerOf('Shipped **[DONE]**'), 'done');
  assert.equal(markerOf('[AGREE] but one more thing'), undefined);
  assert.equal(markerOf('plain'), undefined);
});

test('parseTeam: show, off, edit, save, delete, a saved name and inline teams', () => {
  const usage = 'Usage: /team · /team <saved name> · /team Lead: Claude > Draft: Codex > Review: Claude, Copilot · /team save <name> · /team edit · /team off';
  assert.deepEqual(parseTeam(''), { show: true });
  assert.deepEqual(parseTeam(' OFF '), { off: true });
  assert.deepEqual(parseTeam('edit'), { edit: true });
  assert.deepEqual(parseTeam('save My crew'), { save: 'My crew' });
  assert.deepEqual(parseTeam('save'), { save: '' });
  assert.deepEqual(parseTeam('delete Old team'), { remove: 'Old team' });
  assert.deepEqual(parseTeam('Remove x'), { remove: 'x' });
  assert.deepEqual(parseTeam('delete'), { error: usage });
  assert.deepEqual(parseTeam('Build and test'), { use: 'Build and test' });
  assert.deepEqual(parseTeam('saved team'), { use: 'saved team' });
  assert.deepEqual(parseTeam('Lead: Claude > Draft: Codex (a first pass) > Review: Claude, Copilot'), { team: { name: 'Custom team', wrapUp: true, stages: [
    { name: 'Lead', agents: ['Claude'], run: 'parallel', lead: true },
    { name: 'Draft', agents: ['Codex'], run: 'parallel', lead: false, task: 'a first pass' },
    { name: 'Review', agents: ['Claude', 'Copilot'], run: 'parallel', lead: false }] } });
  for (const sep of ['->', '→', '|', ';', '\n', ' > '])
    assert.deepEqual(parseTeam(`Draft: Codex ${sep} Test: Copilot + Claude (write and run the tests)`).team!.stages.map(s => [s.name, s.agents, s.task]), [['Draft', ['Codex'], undefined], ['Test', ['Copilot', 'Claude'], 'write and run the tests']], sep);
  assert.deepEqual(parseTeam('Review: Claude and Copilot & Codex, claude').team!.stages[0]!.agents, ['Claude', 'Copilot', 'Codex']);
  assert.deepEqual(parseTeam('Draft: Codex > Codex').team!.stages.map(s => s.name), ['Draft', 'Stage 2']);
  assert.equal(parseTeam('Draft: Codex > Review: Claude').team!.wrapUp, false);
  assert.deepEqual(parseTeam('Lead: > Review: (just look)'), { error: `That team has no stage with an agent. ${usage}` });
});
