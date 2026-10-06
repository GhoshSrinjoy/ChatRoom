import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { extractDocument, encodePng, flatten, unzipEntry, docxText, documentKind } from '../src/extract';
import { KnowledgeStore, chunkText, chunkDocument, embeddingPrefixes, keywordScore, pageAt } from '../src/knowledge';
import { cleanOcr } from '../src/ollama';
import { DocumentService, LocalModelClient } from '../src/documents';
import { createRoom } from '../src/core';
import { makePdf, docx, makeZip } from './fixtures';

const gradient = (width: number, height: number) => Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 7) % 251);
async function temp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-docs-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function fakeLocal(calls = { ocr: 0, embed: 0, texts: 0 }): LocalModelClient & { calls: typeof calls } {
  // Bag-of-letters vectors are enough to make related passages score higher.
  const vector = (text: string) => Array.from({ length: 26 }, (_, i) => (text.toLowerCase().match(new RegExp(String.fromCharCode(97 + i), 'g')) ?? []).length);
  return { calls,
    async ocr() { calls.ocr++; return { text: 'Scanned invoice total 42 EUR', input: 10, output: 5, partial: false }; },
    async embed(_model, input) { calls.embed++; calls.texts += input.length; return input.map(vector); } };
}

test('text PDFs keep page order and markers', async () => {
  const result = await extractDocument('spec.pdf', makePdf([{ text: ['Chatroom design', 'Agents share context'] }, { text: ['Second page text'] }]));
  assert.equal(result.kind, 'pdf'); assert.equal(result.pages, 2); assert.equal(result.ocrPages, 0);
  assert.match(result.text, /\[Page 1\]\nChatroom design\s+Agents share context/); assert.match(result.text, /\[Page 2\]\nSecond page text/);
});
test('scanned PDF pages are read by OCR from their embedded image', async () => {
  const seen: Buffer[] = [];
  const result = await extractDocument('scan.pdf', makePdf([{ text: ['Cover page with real text'] }, { image: { width: 300, height: 200, rgb: gradient(300, 200) } }]),
    { ocr: async image => { seen.push(Buffer.from(image)); return 'OCR text from the scan'; } });
  assert.equal(result.ocrPages, 1); assert.equal(seen.length, 1);
  assert.match(result.text, /\[Page 2\]\nOCR text from the scan/); assert.match(result.text, /Cover page/);
  assert.deepEqual([...seen[0]!.subarray(1, 4)].map(c => String.fromCharCode(c)).join(''), 'PNG');
  assert.equal(seen[0]!.readUInt32BE(16), 300); assert.equal(seen[0]!.readUInt32BE(20), 200);
});
test('scanned pages without an OCR model are reported, not silently dropped', async () => {
  const result = await extractDocument('scan.pdf', makePdf([{ image: { width: 300, height: 200, rgb: gradient(300, 200) } }]));
  assert.equal(result.unread, 1); assert.match(result.text, /choose a local vision\/OCR model/);
});
test('PNG encoder writes valid chunks and flatten composites alpha on white and downsamples', () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
  const flat = flatten({ data: rgba, width: 2, height: 2, channels: 4 });
  assert.deepEqual([...flat.data.subarray(0, 6)], [255, 0, 0, 255, 255, 255]);
  const png = encodePng(flat);
  const idat = png.indexOf('IDAT'), length = png.readUInt32BE(idat - 4), raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.equal(raw.length, (2 * 3 + 1) * 2); assert.deepEqual([...raw.subarray(1, 4)], [255, 0, 0]);
  const big = flatten({ data: new Uint8Array(5000 * 10 * 3), width: 5000, height: 10, channels: 3 });
  assert.equal(big.width, 1666); assert.equal(big.height, 3);
});
test('Word documents are unzipped and converted to paragraphs with entities decoded', async () => {
  const result = await extractDocument('notes.docx', docx(['First & foremost', 'Second <para>']));
  assert.equal(result.kind, 'docx'); assert.equal(result.text, 'First & foremost\nSecond <para>');
  assert.equal(unzipEntry(makeZip({ 'a.txt': 'alpha' }), 'missing'), undefined);
  assert.throws(() => unzipEntry(Buffer.from('not a zip'), 'a'), /not a valid/);
  assert.equal(docxText('<w:p><w:r><w:t>A</w:t></w:r><w:tab/><w:t>B&#233;</w:t></w:p>'), 'A\tBé');
});
test('document kinds, binaries and images without OCR are explained', async () => {
  assert.equal(documentKind('a.PNG'), 'image'); assert.equal(documentKind('x.bin', new Uint8Array([1, 0, 2])), undefined);
  await assert.rejects(extractDocument('x.bin', new Uint8Array([1, 0, 2])), /binary file/);
  await assert.rejects(extractDocument('photo.png', new Uint8Array([1, 2])), /vision\/OCR model/);
  assert.equal((await extractDocument('a.md', Buffer.from('﻿# Title'))).text, '# Title');
});
test('chunks overlap, prefer paragraph boundaries, and map back to pages', () => {
  const text = '[Page 1]\n' + 'alpha '.repeat(200) + '\n\n[Page 2]\n' + 'beta '.repeat(400);
  const chunks = chunkText(text, 1000, 100);
  assert.ok(chunks.length >= 3); assert.ok(chunks.every(c => c.text.length <= 1000));
  assert.equal(pageAt(text, chunks.at(-1)!.offset), 2); assert.equal(pageAt(text, 0), 1);
  assert.ok(keywordScore('beta release', 'beta beta notes') > keywordScore('beta release', 'alpha notes'));
});
test('GLM-OCR fenced repeats and empty fence loops are removed without dropping text', () => {
  const sample = 'INVOICE 2026-117\n\nTotal due: 4,250 EUR\n```markdown\n\nINVOICE 2026-117\n\nTotal due: 4,250 EUR\n```\n```\n```\n';
  assert.equal(cleanOcr(sample), 'INVOICE 2026-117\n\nTotal due: 4,250 EUR');
  assert.equal(cleanOcr('```markdown\nOnly fenced\n```'), 'Only fenced');
  assert.equal(cleanOcr('Line A\n```\ncode that differs\n```'), 'Line A\n```\ncode that differs');
  assert.equal(cleanOcr('Plain text'), 'Plain text');
});
test('PDF passages stay within a page and retrieval models get their prefixes', () => {
  const chunks = chunkDocument('[Page 1]\nSupport hours are 08:00 to 18:00 on weekdays.\n\n[Page 2]\n(no readable text)\n\n[Page 3]\nInvoice total is 4,250 EUR due in November.');
  assert.deepEqual(chunks.map(c => c.text.split('\n')[0]), ['[Page 1]', '[Page 3]']);
  assert.equal(embeddingPrefixes('embeddinggemma:latest').query, 'task: search result | query: ');
  assert.deepEqual(embeddingPrefixes('bge-m3'), { query: '', document: '' });
});
test('embeddings persist on disk and are only computed for new text', () => temp(async dir => {
  let computed = 0;
  const compute = async (batch: string[]) => { computed += batch.length; return batch.map(t => [t.length, 1, 0]); };
  const store = new KnowledgeStore(dir);
  const first = await store.embed('model-a', ['one', 'two', 'one'], compute);
  assert.equal(first.computed, 2); assert.equal(first.vectors.length, 3); assert.deepEqual([...first.vectors[2]!], [3, 1, 0]);
  await store.flush();
  const reloaded = new KnowledgeStore(dir), second = await reloaded.embed('model-a', ['two', 'three'], compute);
  assert.equal(second.computed, 1); assert.equal(computed, 3);
  assert.equal((await reloaded.embed('model-b', ['two'], compute)).computed, 1);
  assert.match(await readFile(join(dir, 'embeddings.json'), 'utf8'), /"entries"/);
}));
test('ingestion extracts, OCRs, embeds and reuses work for identical files', () => temp(async dir => {
  const local = fakeLocal(), changes: number[] = [];
  const service = new DocumentService(new KnowledgeStore(dir), local, { vision: 'glm-ocr', embedding: 'embed' }, () => {}, () => changes.push(1));
  const room = createRoom(), pdf = makePdf([{ text: ['Quarterly report', 'Revenue grew 12 percent'] }, { image: { width: 300, height: 200, rgb: gradient(300, 200) } }]);
  const doc = await service.ingest(room, 'report.pdf', pdf, { source: 'attached' });
  assert.equal(doc.status, 'ready'); assert.equal(doc.pages, 2); assert.equal(doc.ocrPages, 1); assert.equal(doc.embedded, 'embed');
  assert.equal(local.calls.ocr, 1); assert.ok(changes.length > 2);
  const again = await service.ingest(room, 'report.pdf', pdf, { source: 'attached' });
  assert.equal(again, doc); assert.equal(room.documents!.length, 1);
  const other = createRoom(), embedCalls = local.calls.embed;
  await service.ingest(other, 'copy.pdf', pdf, { source: 'attached' });
  assert.equal(local.calls.ocr, 1); assert.equal(local.calls.embed, embedCalls);
  const { hits, method } = await service.search(room, 'invoice total', 2, new AbortController().signal);
  assert.match(method, /embeddings/); assert.match(service.format(hits), /report\.pdf · page \d · passage/);
  assert.match(await service.briefing(room, 'revenue', new AbortController().signal), /Room documents · full text[\s\S]*Revenue grew 12 percent[\s\S]*Scanned invoice/);
}));
test('without an embedding model, search falls back to keywords; failures are visible on the document', () => temp(async dir => {
  const service = new DocumentService(new KnowledgeStore(dir), fakeLocal(), { vision: '', embedding: '' }, () => {}, () => {});
  const room = createRoom();
  await service.ingest(room, 'notes.md', Buffer.from('Deploy on Fridays is forbidden.\n\nTests run nightly.'), { source: 'attached' });
  const { hits, method } = await service.search(room, 'deploy friday', 3, new AbortController().signal);
  assert.equal(method, 'keywords'); assert.match(hits[0]!.chunk.text, /Deploy/);
  const failed = await service.ingest(room, 'scan.png', new Uint8Array([137, 80, 78, 71]), { source: 'attached' });
  assert.equal(failed.status, 'error'); assert.match(failed.detail!, /vision\/OCR model/);
  await assert.rejects(service.read(room, 'scan.png', new Uint8Array([137, 80, 78, 71]), new AbortController().signal), /vision\/OCR/);
}));
