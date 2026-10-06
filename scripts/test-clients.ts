import { findRuntime, codexModels, claudeModels } from '../src/catalog';
import { CliProvider } from '../src/cli-provider';
import { createRoom } from '../src/core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function main() {
  const cwd = resolve('.conda/chatroom/client-smoke'); await mkdir(cwd, { recursive: true });
  const results = await Promise.all((['codex', 'claude'] as const).filter(id => !process.argv[2] || process.argv[2] === id).map(async id => {
    const runtime = await findRuntime(id, id);
    if (!runtime) return { id, error: 'Runtime not found' };
    const catalog = await (id === 'codex' ? codexModels(runtime) : claudeModels(runtime));
    console.log(`${id}: ${runtime.version}, ${runtime.source}, ${catalog.models.length} models`);
    const agent = createRoom().agents.find(a => a.provider === id)!;
    agent.tools = []; agent.model = id === 'claude' ? 'haiku' : (catalog.models.find(m => /luna|mini/.test(m.id)) ?? catalog.models[0])?.id ?? '';
    agent.reasoning = 'low';
    try {
      const answer = await new CliProvider(id, () => cwd, async () => runtime).run({ agent, system: 'This is an extension integration smoke test. Answer briefly without using tools.', prompt: 'Reply with exactly CHATROOM_OK.', signal: AbortSignal.timeout(90000), onText: () => {}, onActivity: () => {} });
      console.log(`${id}: ${answer.text.slice(0, 100)}`);
      return { id, version: runtime.version, source: runtime.source, models: catalog.models, testedModel: agent.model, passed: answer.text.trim() === 'CHATROOM_OK', answer: answer.text.slice(0, 200), usage: answer.usage };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error); console.log(`${id}: ${detail.slice(0, 700)}`);
      return { id, version: runtime.version, source: runtime.source, modelCount: catalog.models.length, testedModel: agent.model, passed: false, error: detail.slice(0, 1500) };
    }
  }));
  const previous = process.argv[2] ? JSON.parse(await readFile('artifacts/client-smoke.json', 'utf8').catch(() => '[]')) as { id: string }[] : [];
  await writeFile('artifacts/client-smoke.json', JSON.stringify([...previous.filter(old => !results.some(r => r.id === old.id)), ...results], null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
