import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { OllamaClient } from '../src/ollama';
import { resolveCli, runJsonLines } from '../src/process';

async function main() {
  const client = new OllamaClient(() => 'http://127.0.0.1:11434', () => '1m');
  const models = await client.models();
  const checks: Record<string, unknown> = { models: models.length };
  for (const name of ['codex', 'claude'] as const) {
    const executable = resolveCli(name, name); assert.ok(executable, `${name} CLI resolves without a shell`);
    await runJsonLines(executable, ['--version'], '', process.cwd(), AbortSignal.timeout(15000), () => {});
    checks[`${name}Executable`] = 'launch verified; no inference requested';
  }
  const embedding = models.find(m => !m.remote && m.capabilities?.includes('embedding'));
  if (embedding) {
    const vectors = await client.embed(embedding.id, ['Chatroom coordinates agents.', 'Agents share a conversation.'], AbortSignal.timeout(120000));
    assert.equal(vectors.length, 2); assert.ok(vectors[0]!.length > 0);
    checks.embeddings = { model: embedding.id, dimensions: vectors[0]!.length };
  }
  const vision = models.find(m => !m.remote && m.id.startsWith('glm-ocr'));
  if (vision) {
    const image = await readFile('artifacts/ocr-fixture.png');
    const result = await client.ocr(vision.id, image.toString('base64'), AbortSignal.timeout(120000));
    assert.match(result.text, /CHATROOM/i);
    assert.ok(result.text.length < 500, 'OCR must terminate promptly instead of repeating to the token limit');
    checks.ocr = { model: vision.id, result: result.text, partial: result.partial, inputTokens: result.input, outputTokens: result.output };
  }
  await writeFile('artifacts/local-smoke.json', JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
