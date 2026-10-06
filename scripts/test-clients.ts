// Optional cloud smoke test of the native drivers using your existing Claude Code, Codex and Copilot CLI logins.
// Usage: node --import tsx scripts/test-clients.ts [claude|codex|copilot]
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRuntime, codexModels, claudeModels } from '../src/catalog';
import { ClaudeDriver } from '../src/claude-native';
import { CodexDriver } from '../src/codex-native';
import { CopilotDriver } from '../src/copilot-native';
import { RoomToolHost } from '../src/room-tools';
import { createRoom, roomFraming } from '../src/core';
import { DriverHost, NativeDriver, NativeProviderId, TurnSink } from '../src/types';

function smokeHost(cwd: string, storage: string): DriverHost {
  return { version: '0.4.0-smoke', cwd: () => cwd, storageDir: () => storage, runtime: provider => findRuntime(provider, provider),
    settings: () => ({ allowFullAccess: false, idleSessionMs: 60000, copilotUseEnvToken: false, sharedMcpServers: {} }),
    roomTools: new RoomToolHost(async () => 'Room tools are not available in this smoke test.'), skillWiring: () => undefined, log: text => console.log(`  · ${text}`) };
}
// Read-only: every approval request is denied.
const sink: TurnSink = { text() {}, thinking() {}, activity() {}, approval: async () => ({ decision: 'deny', message: 'Smoke test: no approvals.' }), session() {}, capabilities() {}, options() {} };

async function main() {
  const cwd = resolve('.conda/chatroom/client-smoke'); await mkdir(cwd, { recursive: true });
  const host = smokeHost(cwd, await mkdtemp(join(tmpdir(), 'chatroom-smoke-')));
  const drivers: Record<NativeProviderId, NativeDriver> = { claude: new ClaudeDriver(host), codex: new CodexDriver(host), copilot: new CopilotDriver(host) };
  const room = createRoom();
  const results = await Promise.all((['codex', 'claude', 'copilot'] as const).filter(id => !process.argv[2] || process.argv[2] === id).map(async id => {
    const runtime = await findRuntime(id, id);
    if (!runtime) return { id, passed: false, error: 'Runtime not found' };
    const catalog = id === 'copilot' ? { models: [] } : await (id === 'codex' ? codexModels(runtime) : claudeModels(runtime));
    console.log(`${id}: ${runtime.version}, ${runtime.source}, ${catalog.models.length} models`);
    const agent = room.agents.find(a => a.provider === id)!;
    agent.options.permission = 'plan'; agent.options.effort = id === 'codex' ? 'low' : '';
    agent.model = id === 'claude' ? 'haiku' : id === 'codex' ? (catalog.models.find(m => /luna|mini/.test(m.id)) ?? catalog.models[0])?.id ?? '' : '';
    try {
      const answer = await drivers[id].turn({ room, agent, kind: 'direct', framing: roomFraming(agent, room, { connections: [], caps: {} }), context: '', fullContext: () => '',
        ask: 'This is an extension integration smoke test. Answer briefly without using tools. Reply with exactly CHATROOM_OK.', flags: {}, signal: AbortSignal.timeout(120000), sink });
      console.log(`${id}: ${answer.text.slice(0, 100)}`);
      return { id, version: runtime.version, source: runtime.source, testedModel: agent.model, passed: answer.text.trim() === 'CHATROOM_OK', answer: answer.text.slice(0, 200), usage: answer.usage };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); console.log(`${id}: ${detail.slice(0, 700)}`);
      return { id, version: runtime.version, source: runtime.source, testedModel: agent.model, passed: false, error: detail.slice(0, 1500) };
    }
  }));
  await Promise.allSettled(Object.values(drivers).map(driver => driver.dispose()));
  const previous = process.argv[2] ? JSON.parse(await readFile('artifacts/client-smoke.json', 'utf8').catch(() => '[]')) as { id: string }[] : [];
  await writeFile('artifacts/client-smoke.json', JSON.stringify([...previous.filter(old => !results.some(r => r.id === old.id)), ...results], null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
