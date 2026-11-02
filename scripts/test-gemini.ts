// Runs the Gemini driver against the real Gemini CLI with a scripted model: no account, no tokens, and nothing in your ~/.gemini is read or changed.
// Usage: node --import tsx scripts/test-gemini.ts <path to gemini-cli bundle/gemini.js>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiDriver } from '../src/gemini-native';
import { RoomToolHost } from '../src/room-tools';
import { ApprovalRequest, DriverHost, NativeTurnRequest, ProviderError, Runtime } from '../src/types';
import { recordingSink, testAgent, testRoom } from '../tests/helpers';

const entry = process.argv[2];
if (!entry || !existsSync(entry)) { console.error('Usage: node --import tsx scripts/test-gemini.ts <path to gemini-cli bundle/gemini.js>'); process.exit(2); }
const version = JSON.parse(readFileSync(join(entry, '..', '..', 'package.json'), 'utf8')).version as string;
// Spaces in every path, as in a Windows home folder.
const root = mkdtempSync(join(tmpdir(), 'chatroom gemini ')), workspace = join(root, 'my workspace'), home = join(root, 'my home'), storage = join(root, 'my storage');
for (const dir of [workspace, home, join(home, '.gemini'), storage]) mkdirSync(dir, { recursive: true });
// An empty home: the CLI sees no settings and no login of yours, only the API-key sign-in it saves after "gemini" asks.
process.env.GEMINI_CLI_HOME = home; process.env.GEMINI_API_KEY = 'scripted-model-needs-no-key';
// One step selects a Google login with none saved: nothing here may open a sign-in page.
process.env.NO_BROWSER = 'true'; process.env.BROWSER = 'www-browser';
const settingsFile = join(home, '.gemini', 'settings.json'), apiKeySettings = JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } });
writeFileSync(settingsFile, apiKeySettings);

const chunk = (parts: object[], usage = { promptTokenCount: 100, candidatesTokenCount: 7, cachedContentTokenCount: 40, totalTokenCount: 107 }) =>
  ({ candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: usage });
const reply = (text: string) => ({ method: 'generateContentStream', response: [chunk([{ text }])] });
const call = (name: string, args: object) => ({ method: 'generateContentStream', response: [chunk([{ functionCall: { name, args } }])] });
let script = '';
function respond(...responses: object[]): void {
  script = join(root, `model-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(script, responses.map(r => JSON.stringify(r)).join('\n') + '\n');
}
const spawnWithModel = ((command: string, args: string[], options: object) => spawn(command, [...args, '--fake-responses-non-strict', script], options as any)) as unknown as typeof spawn;

const roomCalls: { name: string; args: unknown }[] = [];
const roomTools = new RoomToolHost(async (_agent, name, args) => { roomCalls.push({ name, args }); return `${name} result`; });
const runtime: Runtime = { executable: { command: process.execPath, prefix: [entry] }, version, source: 'test', modern: true };
const host: DriverHost = { version: '0.0.0-test', cwd: () => workspace, storageDir: () => storage, runtime: async () => runtime, roomTools, skillWiring: () => undefined, log: text => console.log(`  log: ${text}`),
  settings: () => ({ allowFullAccess: true, idleSessionMs: 60_000, copilotUseEnvToken: false, sharedMcpServers: {} }) };
const permissive = () => ({ decision: 'allow' as const });
function request(room: ReturnType<typeof testRoom>, agent: ReturnType<typeof testAgent>, patch: Partial<NativeTurnRequest> = {}, decide: (r: ApprovalRequest) => { decision: 'allow' | 'deny' } = permissive) {
  const sink = recordingSink(decide);
  return { sink, req: { room, agent, kind: 'direct', framing: 'You are in a test room.', context: '', fullContext: () => 'ROOM HISTORY', ask: 'Do it', flags: {}, signal: new AbortController().signal, sink, ...patch } as NativeTurnRequest };
}
const adopt = (agent: ReturnType<typeof testAgent>, sink: ReturnType<typeof recordingSink>) => { for (const patch of sink.sessions) agent.session = { ...agent.session, ...patch }; };
let failures = 0;
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); console.log(`ok  ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`); }
}

const driver = new GeminiDriver(host, spawnWithModel);
const agent = testAgent('gemini', { model: 'gemini-2.5-flash' }), room = testRoom([agent]);
async function main(): Promise<void> {
  await step('capabilities: version, models, modes and commands, without inference', async () => {
    respond();
    const caps = await driver.capabilities(room, agent);
    assert.equal(caps.status, 'ready', caps.detail); assert.equal(caps.version, version);
    assert.ok(caps.models.length > 1, 'lists models'); assert.ok(caps.models.some(m => m.isDefault), 'marks the default model');
    assert.ok(caps.mcpServers.some(s => s.name === 'chatroom'), 'lists the room server');
    assert.ok(caps.commands.some(c => c.name === 'memory'), 'lists its commands on the first call');
    assert.ok(!caps.commands.some(c => /\s/.test(c.name) || c.name === 'help'), 'without subcommands or help');
  });
  await step('turn: answer, real usage, session reported, no [MODE_UPDATE] in the text', async () => {
    await driver.release(room.id); respond(reply('Hello from the scripted model.'));
    agent.options.permission = 'auto-edit';
    const { sink, req } = request(room, agent), result = await driver.turn(req);
    assert.equal(result.status, 'complete'); assert.equal(result.text, 'Hello from the scripted model.');
    assert.equal(result.usage.input, 100); assert.equal(result.usage.output, 7); assert.equal(result.usage.cached, 40); assert.equal(result.usage.estimated, false);
    assert.ok(sink.sessions[0]?.id, 'reports the session id'); assert.ok(!sink.texts.some(t => t.includes('MODE_UPDATE')));
    adopt(agent, sink);
  });
  await step('a native command runs in the CLI and returns its text', async () => {
    const { req } = request(room, agent, { command: { name: 'about', args: '' } }), result = await driver.turn(req);
    assert.equal(result.status, 'complete'); assert.ok(result.text.includes(version), `about output: ${result.text.slice(0, 200)}`);
  });
  await step('Ask: a file edit shows an approval card with the diff and really happens when allowed', async () => {
    const target = join(workspace, 'hello.txt'), asker = testAgent('gemini', { id: 'asker', model: 'gemini-2.5-flash' }), askRoom = testRoom([asker]);
    respond(call('write_file', { file_path: target, content: 'written by gemini\n' }), reply('Done.'));
    const { sink, req } = request(askRoom, asker), result = await driver.turn(req);
    assert.equal(result.status, 'complete'); assert.equal(sink.approvals.length, 1, 'one approval card');
    assert.equal(sink.approvals[0]!.kind, 'edit'); assert.ok(sink.approvals[0]!.diff?.includes('written by gemini'), 'the card shows the diff'); assert.equal(sink.approvals[0]!.canAllowSession, true);
    assert.equal(readFileSync(target, 'utf8').trim(), 'written by gemini'); assert.ok(result.text.includes('Done.'));
    await driver.release(askRoom.id);
  });
  await step('Ask: a denied edit never reaches the disk', async () => {
    const target = join(workspace, 'denied.txt'), asker = testAgent('gemini', { id: 'denier', model: 'gemini-2.5-flash' }), askRoom = testRoom([asker]);
    respond(call('write_file', { file_path: target, content: 'nope\n' }), reply('Understood.'));
    const { sink, req } = request(askRoom, asker, {}, () => ({ decision: 'deny' }));
    await driver.turn(req);
    assert.equal(sink.approvals.length, 1); assert.equal(existsSync(target), false);
    await driver.release(askRoom.id);
  });
  await step('Plan: edits are refused without a card', async () => {
    const target = join(workspace, 'plan.txt'), planner = testAgent('gemini', { id: 'planner', model: 'gemini-2.5-flash', options: { permission: 'plan' } as any }), planRoom = testRoom([planner]);
    respond(call('write_file', { file_path: target, content: 'nope\n' }), reply('Planned.'));
    const { req } = request(planRoom, planner);
    await driver.turn(req);
    assert.equal(existsSync(target), false, 'plan mode wrote a file');
    await driver.release(planRoom.id);
  });
  await step('a turned-off tool cannot run, and the same tool runs when it is on', async () => {
    const off = join(workspace, 'off.txt'), on = join(workspace, 'on.txt');
    const blocked = testAgent('gemini', { id: 'blocked', model: 'gemini-2.5-flash', options: { permission: 'full', disabled: { tools: ['write_file'] } } as any }), blockedRoom = testRoom([blocked]);
    respond(call('write_file', { file_path: off, content: 'nope\n' }), reply('It was refused.'));
    const first = request(blockedRoom, blocked), result = await driver.turn(first.req);
    assert.equal(result.status, 'complete'); assert.equal(existsSync(off), false, 'the turned-off tool wrote a file');
    // Turning it back on takes effect at the next turn: the policy changes, so the process restarts.
    delete blocked.options.disabled; adopt(blocked, first.sink);
    respond(call('write_file', { file_path: on, content: 'yes\n' }), reply('Written.'));
    await driver.turn(request(blockedRoom, blocked).req);
    assert.equal(readFileSync(on, 'utf8').trim(), 'yes', 'turned back on, the tool works');
    await driver.release(blockedRoom.id);
  });
  await step('a skill: it runs when it is on, and is refused when it is turned off', async () => {
    const dir = join(home, '.gemini', 'skills', 'demo-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill.\n---\nSKILL BODY\n');
    const use = async (disabled?: object) => {
      const user = testAgent('gemini', { id: disabled ? 'skill-off' : 'skill-on', model: 'gemini-2.5-flash', options: { permission: 'full', ...(disabled ? { disabled } : {}) } as any }), userRoom = testRoom([user]);
      respond(call('activate_skill', { name: 'demo-skill' }), reply('Used.'));
      const { sink, req } = request(userRoom, user);
      await driver.turn(req);
      await driver.release(userRoom.id);
      return sink.activities.filter(a => a.status === 'done' || a.status === 'failed').map(a => a.status);
    };
    assert.deepEqual(await use(), ['done'], 'the skill runs when on');
    assert.ok(!(await use({ skills: ['demo-skill'] })).includes('done'), 'refused when turned off');
    assert.deepEqual(await use({ skills: ['another-skill'] }), ['done'], 'a rule for another skill leaves it alone');
    rmSync(dir, { recursive: true, force: true });
  });
  await step('a server from the user\'s own settings: its tools run when it is on, and are refused when it is turned off', async () => {
    const { url, headers } = await roomTools.httpEndpoint('settings-user');
    writeFileSync(settingsFile, JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, mcpServers: { myserver: { httpUrl: url, headers }, 'my server': { httpUrl: url, headers } } }));
    try {
      const use = async (tool: string, label: string, disabled?: object) => {
        const before = roomCalls.length, user = testAgent('gemini', { id: `settings-${label}`, model: 'gemini-2.5-flash', options: { permission: 'full', ...(disabled ? { disabled } : {}) } as any }), userRoom = testRoom([user]);
        respond(call(tool, { query: 'hello' }), reply('Done.'));
        const { req } = request(userRoom, user);
        const caps = await driver.capabilities(userRoom, user);
        assert.ok(caps.mcpServers.some(s => s.name === 'myserver') && caps.mcpServers.some(s => s.name === 'my server'), 'listed from the settings file');
        await driver.turn(req);
        await driver.release(userRoom.id);
        return roomCalls.length - before;
      };
      assert.equal(await use('mcp_myserver_search_documents', 'on'), 1, 'it runs when on');
      assert.equal(await use('mcp_myserver_search_documents', 'off', { mcpServers: ['myserver'] }), 0, 'refused when turned off');
      assert.equal(await use('mcp_my_server_search_documents', 'on-spaced'), 1, 'a name with a space runs when on');
      assert.equal(await use('mcp_my_server_search_documents', 'off-spaced', { mcpServers: ['my server'] }), 0, 'and is refused when turned off');
      assert.equal(await use('mcp_myserver_search_documents', 'other-stays', { mcpServers: ['my server'] }), 1, 'its neighbour keeps running');
    } finally { writeFileSync(settingsFile, apiKeySettings); }
  });
  await step('room tools run over real MCP without a card; a turned-off room server does not', async () => {
    const user = testAgent('gemini', { id: 'mcp-user', model: 'gemini-2.5-flash' }), userRoom = testRoom([user]);
    respond(call('mcp_chatroom_search_documents', { query: 'hello' }), reply('Found it.'));
    const { sink, req } = request(userRoom, user), result = await driver.turn(req);
    assert.equal(result.status, 'complete'); assert.equal(sink.approvals.length, 0, 'room tools show no card of their own');
    assert.equal(roomCalls.at(-1)?.name, 'search_documents', 'the room tool ran');
    await driver.release(userRoom.id);
    const before = roomCalls.length, off = testAgent('gemini', { id: 'mcp-off', model: 'gemini-2.5-flash', options: { disabled: { mcpServers: ['chatroom'] } } as any }), offRoom = testRoom([off]);
    respond(call('mcp_chatroom_search_documents', { query: 'hello' }), reply('No such tool.'));
    await driver.turn(request(offRoom, off).req);
    assert.equal(roomCalls.length, before, 'a turned-off server received a call');
    await driver.release(offRoom.id);
  });
  await step('resume: a new process loads the session and the replayed history stays out of the next turn', async () => {
    await driver.release(room.id); respond(reply('Fresh answer.'));
    const { sink, req } = request(room, agent), result = await driver.turn(req);
    assert.equal(result.text, 'Fresh answer.', `history leaked into the turn: ${result.text.slice(0, 200)}`);
    assert.ok(!sink.activities.some(a => a.id === 'resume'), 'the session resumed'); assert.deepEqual(sink.sessions.filter(s => s.id), [], 'kept the same session');
  });
  await step('an unknown stored session starts a new one with the room history', async () => {
    const lost = testAgent('gemini', { id: 'lost', model: 'gemini-2.5-flash', session: { id: 'no-such-session' } }), lostRoom = testRoom([lost]);
    respond(reply('Started over.'));
    const { sink, req } = request(lostRoom, lost), result = await driver.turn(req);
    assert.equal(result.text, 'Started over.'); assert.ok(sink.activities.some(a => a.id === 'resume'), 'says it could not resume');
    await driver.release(lostRoom.id);
  });
  await step('an API key with no saved auth type: session/load refuses it, so the turn starts a new session instead of failing', async () => {
    const keyOnly = testAgent('gemini', { id: 'key-only', model: 'gemini-2.5-flash' }), keyRoom = testRoom([keyOnly]);
    respond(reply('First.'));
    const first = request(keyRoom, keyOnly); await driver.turn(first.req); adopt(keyOnly, first.sink);
    await driver.release(keyRoom.id);
    rmSync(settingsFile);
    try {
      respond(reply('Second.'));
      const second = request(keyRoom, keyOnly), result = await driver.turn(second.req);
      assert.equal(result.status, 'complete'); assert.equal(result.text, 'Second.');
      assert.ok(second.sink.activities.some(a => a.id === 'resume'), 'says it started over');
      assert.equal((await driver.capabilities(keyRoom, keyOnly)).status, 'ready', 'capabilities still say ready');
    } finally { writeFileSync(settingsFile, apiKeySettings); await driver.release(keyRoom.id); }
  });
  await step('stop: the turn ends as interrupted', async () => {
    const stopper = testAgent('gemini', { id: 'stopper', model: 'gemini-2.5-flash' }), stopRoom = testRoom([stopper]), controller = new AbortController();
    // A command the CLI does not run on its own, so it stops at the card.
    respond(call('run_shell_command', { command: 'node -e "process.exit(0)"' }), reply('Never mind.'));
    const { req } = request(stopRoom, stopper, { signal: controller.signal }, () => { controller.abort(); return { decision: 'allow' }; });
    const result = await driver.turn(req);
    assert.equal(result.status, 'interrupted');
    await driver.release(stopRoom.id);
  });
  await step('a Google login with none saved: the CLI never answers, and the driver says why instead of hanging', async () => {
    const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
    writeFileSync(settingsFile, JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }));
    // Without the scripted model, which skips the sign-in. It never gets as far as opening a browser; it waits for an answer first.
    const quick = new GeminiDriver(host, spawn, 6000);
    try {
      const out = testAgent('gemini', { id: 'no-login' }), outRoom = testRoom([out]);
      respond();
      const caps = await quick.capabilities(outRoom, out);
      assert.equal(caps.status, 'signed-out', caps.detail); assert.equal(caps.action, 'geminiLogin'); assert.match(caps.detail!, /waiting for a sign-in/);
    } finally { process.env.GEMINI_API_KEY = saved; writeFileSync(settingsFile, apiKeySettings); await quick.dispose(); }
  });
  await step('signed out: capabilities and turns say so, and offer the sign-in', async () => {
    const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
    try {
      const out = testAgent('gemini', { id: 'signed-out' }), outRoom = testRoom([out]);
      respond();
      const caps = await driver.capabilities(outRoom, out);
      assert.equal(caps.status, 'signed-out', caps.detail); assert.equal(caps.action, 'geminiLogin');
      const { req } = request(outRoom, out);
      await assert.rejects(driver.turn(req), (error: unknown) => error instanceof ProviderError && error.code === 'signed-out');
    } finally { process.env.GEMINI_API_KEY = saved; }
  });
}
void main().finally(async () => {
  await driver.dispose();
  await roomTools.dispose().catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  console.log(failures ? `\n${failures} failed against Gemini CLI ${version}` : `\nAll passed against Gemini CLI ${version}`);
  process.exit(failures ? 1 : 0);
});
