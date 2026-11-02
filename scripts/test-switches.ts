// Runs Chatroom's tool lists and switches against the real CLIs, with a local stand-in for the model service: no account, no tokens, and nothing in your own CLI folders is read or changed.
// Usage: node --import tsx scripts/test-switches.ts [codex|copilot|gemini] [--gemini <path to gemini-cli bundle/gemini.js>] [--copilot <path>] [--codex <path>]
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDriver } from '../src/codex-native';
import { CopilotDriver, canSwitchSkills } from '../src/copilot-native';
import { findRuntime } from '../src/catalog';
import { GeminiDriver } from '../src/gemini-native';
import { ListedProvider, readToolList, readTools } from '../src/tool-lists';
import { Agent, AgentOptions, DriverHost, NativeProviderId, NativeTurnRequest, Runtime } from '../src/types';
import { recordingSink, testAgent, testRoom, waitFor } from '../tests/helpers';

const args = process.argv.slice(2), only = args.find(a => /^(codex|copilot|gemini)$/.test(a));
const pathOf = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const base = mkdtempSync(join(tmpdir(), 'chatroom-switches-'));
// Nothing here may open a sign-in page.
process.env.NO_BROWSER = 'true'; process.env.BROWSER = 'www-browser';
let failures = 0;
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); console.log(`ok    ${name}`); }
  catch (error) { failures++; console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n      ') : error}`); }
};

/** The stand-in: records each model request and answers from a script of steps. */
function modelService(answer: (body: any, res: ServerResponse, count: number) => void) {
  const bodies: { raw: string; body: any }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      if (req.method !== 'POST') { res.setHeader('content-type', 'application/json'); res.end('{"data":[],"models":[]}'); return; }
      let body: any = {}; try { body = JSON.parse(raw); } catch { /* Not JSON. */ }
      bodies.push({ raw, body }); answer(body, res, bodies.length);
    });
  });
  return new Promise<{ url: string; bodies: typeof bodies; close(): void }>(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, bodies, close: () => { server.closeAllConnections(); server.close(); } })));
}
function host(runtime: Runtime, storage: string, cwd: string, allowFullAccess = false): DriverHost {
  return { version: 'test', cwd: () => cwd, storageDir: () => storage, runtime: async () => runtime, settings: () => ({ allowFullAccess, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} }),
    roomTools: { definitions: () => [], call: async () => ({ text: '', isError: false }), mcp: async () => undefined, httpEndpoint: async () => ({ url: 'http://127.0.0.1:9/mcp', headers: {} }) }, skillWiring: () => undefined, log: () => undefined };
}
const request = (agent: Agent, sink = recordingSink(() => ({ decision: 'allow' }))): NativeTurnRequest => ({ room: testRoom([agent]), agent, kind: 'direct', framing: 'FRAMING', context: '', fullContext: () => '', ask: 'Do it', flags: {}, signal: new AbortController().signal, sink });
const withEnv = async <T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const skillFolder = (dir: string, name: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} test skill.\n---\n${name.toUpperCase()} BODY MARKER\n`); };
const dirs = () => { const dir = mkdtempSync(join(base, 'x-')), home = join(dir, 'home'), work = join(dir, 'work'), storage = join(dir, 'storage'); for (const d of [home, work, storage]) mkdirSync(d); return { home, work, storage }; };

async function runtimeOf(provider: NativeProviderId): Promise<Runtime | undefined> {
  return findRuntime(provider, pathOf('--' + provider) ?? provider);
}

async function lists(provider: ListedProvider, runtime: Runtime) {
  await check(`${provider}: reads its tool list`, async () => {
    const started = Date.now(), list = await readTools(provider, runtime.executable, { version: 'test', ...(provider === 'codex' ? { model: 'gpt-6.1-sol' } : {}) });
    assert.ok(list.tools.length > 5, `only ${list.tools.length} tools`);
    console.log(`      ${list.tools.length} tools in ${Date.now() - started} ms: ${list.tools.join(' ')}`);
    if (list.fixed) console.log(`      no switch: ${list.fixed.join(' ')}`);
  });
}

async function gemini(runtime: Runtime) {
  await lists('gemini', runtime);
  await check('gemini: every listed tool can be turned off by name', async () => {
    const tools = await readToolList('gemini', runtime.executable), { home, work, storage } = dirs();
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false } }));
    const service = await modelService((_b, res) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end('{"error":{"code":400,"message":"stand-in","status":"INVALID_ARGUMENT"}}'); });
    await withEnv({ GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'x', GOOGLE_GEMINI_BASE_URL: service.url }, async () => {
      const driver = new GeminiDriver(host(runtime, storage, work)), agent = testAgent('gemini', { options: { disabled: { tools } } as Partial<AgentOptions> as AgentOptions });
      await driver.turn(request(agent)).catch(() => undefined);
      await waitFor(() => service.bodies.some(b => b.body.tools), 20000, 'a model request').catch(() => undefined);
      const left = (service.bodies.find(b => b.body.tools?.length)?.body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((f: any) => f.name));
      await driver.dispose();
      assert.deepEqual(left.filter((n: string) => tools.includes(n)), [], `still sent: ${left.join(' ')}`);
    });
    service.close();
  });
}

async function copilot(runtime: Runtime) {
  await lists('copilot', runtime);
  const sse = (res: ServerResponse, chunks: object[]) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`); res.end('data: [DONE]\n\n'); };
  const frame = (delta: object, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'stand-in', choices: [{ index: 0, delta, finish_reason: finish }] });
  const call = (name: string, input: object, n: number) => [frame({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }), frame({}, 'tool_calls')];
  const run = async (off: Partial<NonNullable<AgentOptions['disabled']>>, calls: { name: string; input: object }[]) => {
    const { home, work, storage } = dirs();
    skillFolder(join(home, 'skills'), 'demo'); skillFolder(join(home, 'skills'), 'other');
    let step = 0;
    const service = await modelService((body, res) => {
      if (!body.tools?.length) return sse(res, [frame({ role: 'assistant', content: 'ok' }), frame({}, 'stop')]);
      const next = calls[step++];
      return next ? sse(res, call(next.name, next.input, step)) : sse(res, [frame({ role: 'assistant', content: 'done' }), frame({}, 'stop')]);
    });
    try {
      return await withEnv({ COPILOT_HOME: home, COPILOT_PROVIDER_BASE_URL: `${service.url}/v1`, COPILOT_PROVIDER_API_KEY: 'x', COPILOT_MODEL: 'stand-in' }, async () => {
        const driver = new CopilotDriver(host(runtime, storage, work)), agent = testAgent('copilot', { options: { disabled: off } as Partial<AgentOptions> as AgentOptions });
        const sink = recordingSink(() => ({ decision: 'allow' }));
        const result = await driver.turn(request(agent, sink));
        await driver.dispose();
        const last = service.bodies.at(-1)?.body ?? {};
        const outputs = (last.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
        return { result, sink, outputs, all: service.bodies.map(b => b.raw).join('\n'), storage, first: service.bodies.find(b => b.body.tools?.length)?.body };
      });
    } finally { service.close(); }
  };
  const skills = [{ name: 'skill', input: { skill: 'demo' } }, { name: 'skill', input: { skill: 'other' } }];
  await check('copilot: this version has the switch for one skill', async () => assert.ok(canSwitchSkills(runtime.version), `version ${runtime.version}`));
  await check('copilot: with nothing off, skills load', async () => {
    const r = await run({}, skills);
    assert.match(r.all, /DEMO BODY MARKER/); assert.match(r.all, /OTHER BODY MARKER/); assert.equal(r.result.text, 'done');
  });
  await check('copilot: one skill turned off is refused, and another still loads', async () => {
    const r = await run({ skills: ['demo'] }, skills);
    assert.doesNotMatch(r.all, /DEMO BODY MARKER/, 'the skill reached the model');
    assert.match(r.all, /OTHER BODY MARKER/, 'the other skill stopped working');
    assert.ok(r.outputs.some((o: string) => /turned this skill off/.test(o)), r.outputs.join(' | '));
    assert.ok(existsSync(join(r.storage, 'copilot-skill-switch')), 'no plugin written');
  });
  await check('copilot: a built-in skill turned off as a command is refused too', async () => {
    const r = await run({ commands: ['demo'] }, skills);
    assert.doesNotMatch(r.all, /DEMO BODY MARKER/);
    assert.match(r.all, /OTHER BODY MARKER/);
  });
  await check('copilot: other tools are not held up by the hook', async () => {
    const r = await run({ skills: ['demo'] }, [{ name: 'view', input: { path: '.' } }]);
    assert.equal(r.result.text, 'done');
  });
  await check('copilot: a tool turned off is gone, and its notice is not in the reply', async () => {
    const r = await run({ tools: ['web_fetch', 'glob'] }, []);
    const names = (r.first?.tools ?? []).map((t: any) => t.function?.name);
    assert.ok(!names.includes('web_fetch') && !names.includes('glob'), names.join(' '));
    assert.equal(r.result.text, 'done');
    assert.deepEqual(r.sink.texts.filter(t => /Info: Disabled/.test(t)), []);
  });
  await check('copilot: every listed tool can be turned off by name', async () => {
    const tools = await readToolList('copilot', runtime.executable), r = await run({ tools }, []);
    const names = (r.first?.tools ?? []).map((t: any) => t.function?.name);
    assert.deepEqual(names.filter((n: string) => tools.includes(n)), []);
  });
}

async function codex(runtime: Runtime) {
  await lists('codex', runtime);
  const sse = (res: ServerResponse, events: { type: string }[]) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
  const done = (id: string) => ({ type: 'response.completed', response: { id, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  const say = (res: ServerResponse) => sse(res, [{ type: 'response.created', response: { id: 'r' } } as any, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm', content: [{ type: 'output_text', text: 'done' }] } } as any, done('r')]);
  const exec = (input: string) => ({ type: 'custom_tool_call', id: 'ct', call_id: 'c1', name: 'exec', input });
  const direct = () => ({ type: 'function_call', id: 'fc', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo hi > pwned.txt' }) });
  const configure = (home: string, url: string) => writeFileSync(join(home, 'config.toml'), `model = "gpt-6.1-sol"\nmodel_provider = "stub"\n[model_providers.stub]\nname = "stub"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nstream_max_retries = 0\nrequest_max_retries = 0\n`);
  // What the model is offered now: older lists stay in the history, so only the newest counts.
  const describes = (body: any, name: string) => {
    const newest = (body?.input ?? []).filter((item: any) => item.type === 'additional_tools').at(-1);
    return JSON.stringify(newest ?? body?.tools ?? []).includes(newest ? `\`${name}\`` : `"${name}"`);
  };
  const run = async (off: string[], item: () => object) => {
    const { home, work, storage } = dirs();
    let step = 0;
    const service = await modelService((_b, res) => { if (step++ === 0) return sse(res, [{ type: 'response.created', response: { id: 'r1' } } as any, { type: 'response.output_item.done', item: item() } as any, done('r1')]); say(res); });
    configure(home, service.url);
    try {
      return await withEnv({ CODEX_HOME: home }, async () => {
        const driver = new CodexDriver(host(runtime, storage, work, true)), agent = testAgent('codex', { options: { permission: 'full', disabled: { tools: off } } as Partial<AgentOptions> as AgentOptions });
        const result = await driver.turn(request(agent));
        await driver.dispose();
        return { result, wrote: existsSync(join(work, 'pwned.txt')), first: service.bodies[0]?.body, outputs: JSON.stringify(service.bodies[1]?.body?.input ?? []).slice(-1500) };
      });
    } finally { service.close(); }
  };
  await check('codex: with nothing off, a command runs (so the checks below can fail)', async () => {
    const r = await run([], direct);
    assert.ok(r.wrote, 'the command did not run'); assert.ok(describes(r.first, 'exec_command'));
  });
  await check('codex: with exec_command off, the model is not told about it and a call is refused', async () => {
    const r = await run(['exec_command', 'write_stdin'], direct);
    assert.ok(!r.wrote, 'the command ran'); assert.ok(!describes(r.first, 'exec_command') && !describes(r.first, 'write_stdin'));
    assert.match(r.outputs, /unsupported call/);
  });
  await check('codex: with exec_command off, the exec runner cannot reach it either', async () => {
    const r = await run(['exec_command'], () => exec('await tools.exec_command({cmd:"echo hi > pwned.txt"}); text("ran");'));
    assert.ok(!r.wrote, 'the command ran');
  });
  await check('codex: turning a tool off mid-session takes effect at the next turn', async () => {
    const { home, work, storage } = dirs();
    const service = await modelService((_b, res) => say(res));
    configure(home, service.url);
    try {
      await withEnv({ CODEX_HOME: home }, async () => {
        const driver = new CodexDriver(host(runtime, storage, work)), agent = testAgent('codex');
        const room = testRoom([agent]), turn = (sink = recordingSink()) => driver.turn({ ...request(agent, sink), room });
        const first = recordingSink();
        await turn(first);
        for (const patch of first.sessions) agent.session = { ...agent.session, ...patch };
        assert.ok(describes(service.bodies.at(-1)?.body, 'view_image'), 'view_image missing before');
        agent.options = { ...agent.options, disabled: { tools: ['view_image'] } };
        await turn();
        assert.ok(!describes(service.bodies.at(-1)?.body, 'view_image'), 'view_image still sent after');
        assert.ok(describes(service.bodies.at(-1)?.body, 'exec_command'), 'another tool went away');
        await driver.dispose();
      });
    } finally { service.close(); }
  });
}

async function main() {
const want = (name: string) => !only || only === name;
if (want('codex')) { const r = await runtimeOf('codex'); if (r) { console.log(`Codex ${r.version}`); await codex(r); } else console.log('Codex CLI not found: skipped.'); }
if (want('copilot')) { const r = await runtimeOf('copilot'); if (r) { console.log(`Copilot CLI ${r.version}`); await copilot(r); } else console.log('Copilot CLI not found: skipped.'); }
if (want('gemini')) { const r = await runtimeOf('gemini'); if (r?.modern) { console.log(`Gemini CLI ${r.version}`); await gemini(r); } else console.log('Gemini CLI 0.38 or newer not found: skipped. Pass --gemini <bundle/gemini.js>.'); }
try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* A temp folder. */ }
const existing = readdirSync(tmpdir()).filter(name => name.startsWith('chatroom-tools-'));
if (existing.length) console.log(`note: ${existing.length} read folder(s) left in the temp folder`);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
}
void main();
