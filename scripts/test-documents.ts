// Optional real-model check of the document pipeline: PDF text + scanned page OCR, Word, embeddings, search.
// Usage: node --import tsx scripts/test-documents.ts <scan.jpg>   (a JPEG photo/scan containing text)
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaClient } from '../src/ollama';
import { KnowledgeStore } from '../src/knowledge';
import { DocumentService } from '../src/documents';
import { createRoom } from '../src/core';
import { makePdf, docx } from '../tests/fixtures';

async function main(): Promise<void> {
  const ollama = new OllamaClient(() => process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434', () => '5m');
  const models = await ollama.models();
  const vision = models.find(m => !m.remote && m.capabilities?.includes('vision') && /ocr/i.test(m.id)) ?? models.find(m => !m.remote && m.capabilities?.includes('vision'));
  const embedding = models.find(m => !m.remote && m.capabilities?.includes('embedding'));
  if (!vision || !embedding) throw new Error('Install a local vision/OCR model and an embedding model in Ollama.');
  console.log(`Models: OCR ${vision.id} · embeddings ${embedding.id}`);
  const dir = mkdtempSync(join(tmpdir(), 'chatroom-documents-')), logs: string[] = [];
  try {
    const store = new KnowledgeStore(dir);
    const service = new DocumentService(store, ollama, { vision: vision.id, embedding: embedding.id }, text => logs.push(text), () => {});
    const room = createRoom(), jpeg = readFileSync(process.argv[2] ?? 'scan.jpg');
    const width = jpeg.readUInt16BE(jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7), height = jpeg.readUInt16BE(jpeg.indexOf(Buffer.from([0xff, 0xc0])) + 5);
    const pdf = makePdf([
      { text: ['Northwind Robotics - Service Agreement', 'Support hours are 08:00 to 18:00 CET on weekdays.', 'Escalations go to the on-call engineer within 30 minutes.'] },
      { image: { width, height, jpeg } }
    ]);
    let started = Date.now();
    const doc = await service.ingest(room, 'agreement.pdf', pdf, { source: 'attached', checkBudget: false });
    console.log(`PDF: ${doc.status} ${doc.detail ?? ''} pages=${doc.pages} ocr=${doc.ocrPages} passages=${doc.chunks} embedded=${doc.embedded} · ${Date.now() - started} ms`);
    const word = await service.ingest(room, 'policy.docx', docx(['Refund policy', 'Customers may request a refund within 21 days of delivery.']), { source: 'attached' });
    console.log(`Word: ${word.status} ${word.detail ?? ''} passages=${word.chunks}`);
    for (const query of ['How much money is owed and when is it due?', 'When can I reach support?', 'refund window']) {
      const { hits, method } = await service.search(room, query, 2, AbortSignal.timeout(120000));
      console.log(`\nQ: ${query} [${method}]\n` + hits.map(h => `  ${h.document.name} ${h.score.toFixed(3)} :: ${h.chunk.text.replace(/\s+/g, ' ').slice(0, 170)}`).join('\n'));
    }
    started = Date.now();
    await service.ingest(createRoom(), 'copy.pdf', pdf, { source: 'attached' });
    console.log(`\nSame bytes in another room (cache): ${Date.now() - started} ms`);
    await store.flush();
    console.log('\nActivity:\n  ' + logs.join('\n  '));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
