import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { codexSwitchConfig } from '../src/codex-native';
import { StoredToolList, ToolListRequest, ToolLists, isListedProvider, readToolList, readTools, toolNames } from '../src/tool-lists';
import { FakeChild, fakeSpawn, rpcPeer, waitFor } from './helpers';

const EXE = { command: 'fake-cli', prefix: [] };
const post = (url: string, body: object) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
const GEMINI_BODY = { tools: [{ functionDeclarations: [{ name: 'read_file' }, { name: 'web_fetch' }] }] };
const COPILOT_BODY = { tools: [{ type: 'function', function: { name: 'view' } }, { type: 'function', function: { name: 'skill' } }] };
const CODEX_BODY = { input: [{ type: 'additional_tools', role: 'developer', tools: [
  { type: 'namespace', name: 'functions', description: '', tools: [{ type: 'custom', name: 'exec', description: 'Run code.\n\n### `apply_patch`\nEdits.\n\n### `exec_command`\nRuns.\n\n### `write_stdin`\nWrites.\nNot a heading: `nope`' }, { type: 'function', name: 'request_user_input' }] },
  { type: 'namespace', name: 'clock', description: 'Time.', tools: [{ type: 'function', name: 'sleep' }] }] }] };
/** A CLI that speaks ACP and sends `body` to its model service when prompted. */
function acpCli(baseUrl: (child: FakeChild) => string, body: object, onStart?: (child: FakeChild, params: any) => void | Promise<void>) {
  return fakeSpawn(child => {
    rpcPeer(child, 'jsonrpc2', {
      initialize: () => ({ protocolVersion: 1 }),
      'session/new': async params => { await onStart?.(child, params); return { sessionId: 's1' }; },
      'session/prompt': async () => { await post(baseUrl(child), body); return { stopReason: 'end_turn' }; },
    });
  });
}
const geminiUrl = (child: FakeChild) => `${child.env.GOOGLE_GEMINI_BASE_URL}/v1beta/models/x:streamGenerateContent`;
const copilotUrl = (child: FakeChild) => `${child.env.COPILOT_PROVIDER_BASE_URL}/chat/completions`;
const baseUrlOf = (child: FakeChild) => /base_url = "([^"]+)"/.exec(readFileSync(join(child.env.CODEX_HOME!, 'config.toml'), 'utf8'))![1]!;
/** A Codex app server: `body` may depend on the thread's config. */
function codexCli(body: (config: any) => object, seen: any[] = []) {
  return fakeSpawn(child => {
    let config: any;
    rpcPeer(child, 'codex', {
      initialize: () => ({ userAgent: 'codex/9' }),
      initialized: () => undefined,
      'thread/start': params => { config = params.config; seen.push(params); return { thread: { id: 't1' } }; },
      'turn/start': async () => { await post(`${baseUrlOf(child)}/responses`, body(config)); return { turn: { id: 'u1' } }; },
    });
  });
}
const withEnv = async <T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
};
const connectThrough = (proxy: string) => new Promise<number | undefined>((resolve, reject) => {
  const { hostname, port } = new URL(proxy), req = httpRequest({ host: hostname, port, method: 'CONNECT', path: 'example.com:443' });
  req.on('connect', res => { resolve(res.statusCode); res.destroy(); }); req.on('error', reject); req.end();
});

test('toolNames: each CLI\'s request shape, with exec\'s nested tools and namespaces', () => {
  assert.deepEqual(toolNames('gemini', GEMINI_BODY), ['read_file', 'web_fetch']);
  assert.deepEqual(toolNames('copilot', COPILOT_BODY), ['view', 'skill']);
  assert.deepEqual(toolNames('codex', CODEX_BODY), ['exec', 'apply_patch', 'exec_command', 'write_stdin', 'request_user_input', 'clock.sleep']);
  assert.deepEqual(toolNames('codex', { tools: [{ type: 'function', name: 'exec_command' }, { type: 'web_search' }, { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent' }] }] }), ['exec_command', 'web_search', 'multi_agent_v1.spawn_agent']);
  assert.deepEqual(toolNames('gemini', { contents: [] }), [], 'a request with no tools, such as a routing call');
  assert.deepEqual(toolNames('copilot', null), []);
  assert.ok(isListedProvider('gemini') && isListedProvider('codex') && isListedProvider('copilot'));
  assert.ok(!isListedProvider('claude') && !isListedProvider('ollama'));
});

test('a read keeps the CLI away from your logins, your folders and the internet', async () => {
  let env: NodeJS.ProcessEnv = {}, cwd = '', settings: any, refused: number | undefined, listing: string[] = [];
  const fake = acpCli(geminiUrl, GEMINI_BODY, async (child, params) => {
    env = child.env; cwd = child.cwd;
    settings = JSON.parse(readFileSync(join(child.env.GEMINI_CLI_HOME!, '.gemini', 'settings.json'), 'utf8'));
    refused = await connectThrough(child.env.HTTPS_PROXY!);
    listing = readdirSync(params.cwd);
  });
  const names = await withEnv({ GOOGLE_API_KEY: 'real-key', GEMINI_API_KEY: 'real-key', GH_TOKEN: 'real-token', OPENAI_API_KEY: 'real-key', HTTPS_PROXY: 'http://corporate:8080', no_proxy: 'corporate', GOOGLE_CLOUD_PROJECT: 'real' },
    () => readToolList('gemini', EXE, { spawnProcess: fake.spawn }));
  assert.deepEqual(names, ['read_file', 'web_fetch']);
  assert.equal(env.GEMINI_API_KEY, 'chatroom-tool-list');
  for (const key of ['GOOGLE_API_KEY', 'GH_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_CLOUD_PROJECT']) assert.equal(env[key], undefined, key);
  assert.match(env.HTTPS_PROXY!, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(env.GOOGLE_GEMINI_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(env.no_proxy, '127.0.0.1,localhost');
  assert.equal(refused, 502, 'other traffic is refused');
  assert.equal(settings.telemetry.enabled, false); assert.equal(settings.privacy.usageStatisticsEnabled, false);
  assert.equal(settings.security.auth.selectedType, 'gemini-api-key', 'never a Google login, so never a sign-in page');
  assert.equal(env.NO_BROWSER, 'true');
  assert.deepEqual(listing, [], 'it runs in an empty folder');
  assert.equal(env.HOME, env.GEMINI_CLI_HOME); assert.equal(env.USERPROFILE, env.GEMINI_CLI_HOME);
  assert.notEqual(env.HOME, process.env.HOME);
  assert.ok(fake.children[0]!.killed || fake.children[0]!.exited, 'the process is stopped');
  assert.ok(!existsSync(cwd) && !existsSync(env.HOME!), 'its folders are removed');
});

test('a read of Copilot sets its own home, a stand-in provider and no update checks', async () => {
  let env: NodeJS.ProcessEnv = {};
  const fake = acpCli(copilotUrl, COPILOT_BODY, child => { env = child.env; });
  assert.deepEqual(await readToolList('copilot', EXE, { spawnProcess: fake.spawn }), ['view', 'skill']);
  assert.deepEqual(fake.children[0]!.args, ['--acp', '--no-auto-update', '--no-color', '--log-level', 'warning']);
  assert.match(env.COPILOT_PROVIDER_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(env.COPILOT_AUTO_UPDATE, 'false');
  assert.ok(env.COPILOT_HOME && env.COPILOT_HOME === env.HOME);
});

test('a read waits past a model request with no tools', async () => {
  const fake = fakeSpawn(child => {
    rpcPeer(child, 'jsonrpc2', { initialize: () => ({}), 'session/new': () => ({ sessionId: 's' }),
      'session/prompt': async () => { await post(geminiUrl(child), { contents: [] }); await post(geminiUrl(child), 'not json' as any); await post(geminiUrl(child), GEMINI_BODY); return {}; } });
  });
  assert.deepEqual(await readToolList('gemini', EXE, { spawnProcess: fake.spawn }), ['read_file', 'web_fetch']);
});

test('readTools on Codex: a tool only gets a switch once a real run shows the switch removing it', async () => {
  const seen: any[] = [];
  // As with a key the CLI no longer knows: goals stay even with their switch on.
  const fake = codexCli(config => config ? { tools: [{ type: 'function', name: 'create_goal' }, { type: 'function', name: 'apply_patch' }] }
    : { tools: [{ type: 'function', name: 'exec_command' }, { type: 'function', name: 'write_stdin' }, { type: 'function', name: 'create_goal' }, { type: 'function', name: 'apply_patch' }] }, seen);
  const list = await readTools('codex', EXE, { model: 'gpt-sol', spawnProcess: fake.spawn });
  assert.deepEqual(list.tools, ['exec_command', 'write_stdin', 'create_goal', 'apply_patch']);
  assert.deepEqual(list.fixed, ['create_goal', 'apply_patch']);
  assert.equal(seen[0].config, undefined);
  assert.deepEqual(seen[1].config, codexSwitchConfig());
  assert.equal(fake.children.length, 2);
});

test('a read of Codex writes a config for its model and the stand-in, and asks for no login', async () => {
  let toml = '';
  const fake = fakeSpawn(child => {
    rpcPeer(child, 'codex', { initialize: () => ({}), initialized: () => undefined,
      'thread/start': () => { toml = readFileSync(join(child.env.CODEX_HOME!, 'config.toml'), 'utf8'); return { thread: { id: 't' } }; },
      'turn/start': async () => { await post(`${baseUrlOf(child)}/responses`, CODEX_BODY); return {}; } });
  });
  await readToolList('codex', EXE, { model: 'gpt-"6"', spawnProcess: fake.spawn });
  assert.match(toml, /^model = "gpt-\\"6\\""$/m);
  assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"$/m);
  assert.match(toml, /^requires_openai_auth = false$/m);
  assert.deepEqual(fake.children[0]!.args, ['app-server']);
  await readToolList('codex', EXE, { spawnProcess: fake.spawn });
  assert.doesNotMatch(toml, /^model = /m, 'with no model, the CLI uses its own default');
});

test('a read that can\'t finish fails, and cleans up', async () => {
  const exits = fakeSpawn(child => { child.stderr('it broke'); child.exit(3); });
  await assert.rejects(readToolList('gemini', EXE, { spawnProcess: exits.spawn }), /exited \(code 3\)/);
  assert.ok(!existsSync(exits.children[0]!.cwd));
  const silent = fakeSpawn(() => undefined);
  await assert.rejects(readToolList('copilot', EXE, { spawnProcess: silent.spawn, timeoutMs: 30 }), /no tool list after/);
  assert.ok(silent.children[0]!.killed); assert.ok(!existsSync(silent.children[0]!.cwd));
  const refused = fakeSpawn(child => { rpcPeer(child, 'jsonrpc2', { initialize: () => { throw { code: -32000, message: 'nope' }; } }); });
  await assert.rejects(readToolList('copilot', EXE, { spawnProcess: refused.spawn }), /nope/);
  const stop = new AbortController(), waiting = fakeSpawn(() => { stop.abort(); });
  await assert.rejects(readToolList('copilot', EXE, { spawnProcess: waiting.spawn, signal: stop.signal }), /stopped/);
  const never = fakeSpawn(() => undefined), stopped = new AbortController();
  stopped.abort();
  await assert.rejects(readToolList('copilot', EXE, { spawnProcess: never.spawn, signal: stopped.signal }), /stopped/);
  assert.equal(never.children.length, 0, 'an aborted read starts nothing');
});

const memory = () => { let lists: Record<string, StoredToolList> = {}; return { get: () => lists, set: (value: Record<string, StoredToolList>) => { lists = value; } }; };
const GEMINI: ToolListRequest = { provider: 'gemini', version: '1.0.0' };

test('ToolLists: one read per version, nobody waits for it, and the list is remembered', async () => {
  const store = memory(), read: ToolListRequest[] = [];
  let changed = 0;
  const lists = new ToolLists(store, async request => { read.push(request); return { tools: ['read_file'] }; }, { changed: () => changed++, log: () => undefined });
  assert.equal(lists.get(GEMINI), undefined, 'not known yet');
  assert.equal(lists.get(GEMINI), undefined);
  await waitFor(() => changed === 1);
  assert.deepEqual(lists.get(GEMINI)?.tools, ['read_file']);
  assert.equal(read.length, 1);
  assert.equal(new ToolLists(store, async () => { throw new Error('not again'); }, { changed: () => undefined, log: () => undefined }).get(GEMINI)?.tools[0], 'read_file', 'a later window has it too');
  lists.get({ ...GEMINI, version: '2.0.0' }); lists.get({ provider: 'codex', version: '1.0.0', model: 'a' }); lists.get({ provider: 'codex', version: '1.0.0', model: 'b' });
  await waitFor(() => changed === 4);
  assert.equal(read.length, 4, 'another version or model is another read');
});

test('ToolLists: reads run one at a time', async () => {
  let running = 0, most = 0, changed = 0;
  const lists = new ToolLists(memory(), async () => { most = Math.max(most, ++running); await new Promise(r => setTimeout(r, 5)); running--; return { tools: ['x'] }; }, { changed: () => changed++, log: () => undefined });
  for (const version of ['1', '2', '3']) lists.get({ provider: 'copilot', version });
  await waitFor(() => changed === 3);
  assert.equal(most, 1);
});

test('ToolLists: a failed read is logged, tried again later or on Refresh, and doesn\'t repeat on every update', async () => {
  let now = 1000, reads = 0, changed = 0, fail = true;
  const logs: string[] = [], store = memory();
  const lists = new ToolLists(store, async () => { reads++; if (fail) throw new Error('no list'); return { tools: ['ok'] }; }, { changed: () => changed++, log: text => logs.push(text), now: () => now });
  lists.get(GEMINI);
  await waitFor(() => changed === 1);
  assert.deepEqual(logs, ['Could not read the tool list of gemini 1.0.0: no list']);
  assert.equal(lists.get(GEMINI), undefined);
  assert.equal(reads, 1, 'no new read straight away');
  now += 3_600_001;
  lists.get(GEMINI);
  await waitFor(() => changed === 2);
  assert.equal(reads, 2, 'tried again an hour later');
  lists.retry();
  fail = false;
  assert.equal(lists.get(GEMINI), undefined);
  await waitFor(() => changed === 3);
  assert.equal(reads, 3, 'Refresh tries again at once');
  assert.deepEqual(lists.get(GEMINI)?.tools, ['ok']);
  const before = store.get();
  lists.retry();
  assert.equal(store.get(), before, 'nothing to forget, nothing written');
});

test('ToolLists: old versions drop out', async () => {
  const store = memory();
  let changed = 0, now = 0;
  const lists = new ToolLists(store, async () => ({ tools: ['x'] }), { changed: () => changed++, log: () => undefined, now: () => ++now });
  for (let i = 0; i < 20; i++) lists.get({ provider: 'copilot', version: String(i) });
  await waitFor(() => changed === 20);
  const keys = Object.keys(store.get());
  assert.equal(keys.length, 16);
  assert.ok(keys.includes('copilot@19') && !keys.includes('copilot@0'));
});
