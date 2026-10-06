// Optional live Team run with real clients (uses your existing Claude Code and Codex logins and local Ollama).
// Usage: node --import tsx scripts/test-team.ts <scan.jpg> [ollama-model]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRuntime, codexModels } from '../src/catalog';
import { ClaudeDriver } from '../src/claude-native';
import { CodexDriver } from '../src/codex-native';
import { RoomToolHost } from '../src/room-tools';
import { OllamaClient } from '../src/ollama';
import { KnowledgeStore } from '../src/knowledge';
import { DocumentService } from '../src/documents';
import { RoomEngine } from '../src/engine';
import { createRoom, roomFraming } from '../src/core';
import { DriverHost } from '../src/types';
import { makePdf } from '../tests/fixtures';

async function main(): Promise<void> {
  const cwd = resolve('.conda/chatroom/client-smoke'); mkdirSync(cwd, { recursive: true });
  const [codex, claude] = await Promise.all([findRuntime('codex', 'codex'), findRuntime('claude', 'claude')]);
  if (!codex || !claude) throw new Error('Codex and Claude runtimes are required.');
  const ollama = new OllamaClient(() => 'http://127.0.0.1:11434', () => '5m');
  const store = new KnowledgeStore(join(cwd, 'knowledge'));
  const room = createRoom();
  const documents = new DocumentService(store, ollama, { vision: 'glm-ocr:latest', embedding: 'embeddinggemma:latest' }, text => console.log(`  · ${text}`), () => {});
  const jpeg = readFileSync(process.argv[2] ?? 'scan.jpg');
  await documents.ingest(room, 'northwind-agreement.pdf', makePdf([
    { text: ['Northwind Robotics - Service Agreement', 'Support hours are 08:00 to 18:00 CET on weekdays.', 'Late payments incur a 2% monthly fee after the deadline.'] },
    { image: { width: 1100, height: 520, jpeg } }]), { source: 'attached', checkBudget: false });
  const roomTools = new RoomToolHost(async (_agent, name, args, signal) => {
    if (name !== 'search_documents') return `${name} is not available in this script.`;
    const { hits, method } = await documents.search(room, String(args.query ?? ''), 4, signal);
    return `Searched using ${method}.\n\n${documents.format(hits)}`;
  });
  const storage = await mkdtemp(join(tmpdir(), 'chatroom-team-'));
  const host: DriverHost = { version: '0.4.0-smoke', cwd: () => cwd, storageDir: () => storage, runtime: provider => findRuntime(provider, provider),
    settings: () => ({ allowFullAccess: false, idleSessionMs: 600000, copilotUseEnvToken: false, sharedMcpServers: {} }), roomTools, skillWiring: () => undefined, log: text => console.log(`  · ${text}`) };
  const drivers = { claude: new ClaudeDriver(host), codex: new CodexDriver(host) };
  const [lead, engineer, third] = room.agents;
  Object.assign(lead!, { name: 'Claude', provider: 'claude', model: 'haiku', role: 'Coordinator. Plans the work and writes clear final answers.' });
  Object.assign(engineer!, { name: 'Codex', provider: 'codex', role: 'Analyst. Extracts exact facts and figures from documents and checks them.',
    model: (await codexModels(codex)).models.find(m => /mini|luna/i.test(m.id))?.id ?? '' });
  engineer!.options.effort = 'low';
  Object.assign(third!, { name: 'Gemma', provider: 'ollama', model: process.argv[3] ?? 'medgemma:4b', tools: [], role: 'Writer. Drafts short, friendly customer-facing text.' });
  // Read-only run: plan mode, and any approval request is denied after a second.
  for (const agent of room.agents) agent.options.permission = 'plan';
  room.mode = 'orchestrated'; room.leadId = lead!.id; room.tokenBudget = 120000;
  const engine = new RoomEngine(room, { providers: { ollama }, native: agent => agent.provider === 'claude' ? drivers.claude : agent.provider === 'codex' ? drivers.codex : undefined,
    tools: async () => 'Chatroom tools are disabled in this script.', briefing: (target, query, signal) => documents.briefing(target, query, signal),
    framing: (agent, target, legacy) => roomFraming(agent, target, { connections: [], caps: {}, legacy }),
    contextTokens: () => 12000, timeoutMs: () => 240000, approvalTimeoutMs: () => 1000, maxHandoffs: () => 4, changed: () => {} });
  const started = Date.now();
  await engine.start('Using the attached agreement: what exactly is owed, by when, and what happens if it is late? Then give me a short, polite payment reminder email I can send to Northwind Robotics.');
  console.log(`\nFinished in ${((Date.now() - started) / 1000).toFixed(0)} s · status ${room.status}\n`);
  for (const m of room.messages.filter(m => m.kind !== 'user')) {
    const label = m.turn === 'step' ? `step ${m.step?.id} · ${m.step?.task}` : m.turn ?? m.kind;
    console.log(`=== ${m.author} [${label}] (${m.status})\n${m.text.slice(0, 1400)}`);
    if (m.plan) console.log(m.plan.map(s => `  ${s.id} ${room.agents.find(a => a.id === s.agentId)?.name}: ${s.task} ${s.after.length ? `(after ${s.after})` : ''} → ${s.status}`).join('\n'));
    console.log();
  }
  console.log('Activity:\n' + room.activity.map(a => `  ${a.kind === 'error' ? '!' : '-'} ${a.text}`).join('\n'));
  writeFileSync('artifacts/team-smoke.json', JSON.stringify({ messages: room.messages, activity: room.activity, usage: room.usage }, null, 2));
  await Promise.allSettled([drivers.claude.dispose(), drivers.codex.dispose(), roomTools.dispose(), store.flush()]);
  if (room.messages.at(-1)?.turn !== 'synthesis' || room.messages.at(-1)?.status !== 'complete') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
