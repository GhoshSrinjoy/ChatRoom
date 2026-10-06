import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DocumentKind } from './extract';

export interface Chunk { text: string; offset: number }
export interface StoredDocument { version: 1; hash: string; name: string; kind: DocumentKind; text: string; pages?: number; ocrPages?: number; unread?: number; chunks: Chunk[] }
export const sha256 = (...parts: (string | Uint8Array)[]) => { const hash = createHash('sha256'); for (const part of parts) hash.update(part).update('\0'); return hash.digest('hex'); };
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
/** Splits text into overlapping passages, preferring paragraph and sentence boundaries. */
export function chunkText(text: string, size = 1600, overlap = 200): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n\n', end), sentence = text.lastIndexOf('. ', end);
      if (paragraph > start + size / 2) end = paragraph; else if (sentence > start + size / 2) end = sentence + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push({ text: piece, offset: start });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
/** Chunks each `[Page N]` section separately so passages never straddle pages. */
export function chunkDocument(text: string): Chunk[] {
  const starts = [...text.matchAll(/^\[Page \d+\]$/gm)].map(m => m.index!);
  if (!starts.length) return chunkText(text);
  return starts.flatMap((start, i) => chunkText(text.slice(start, starts[i + 1] ?? text.length)).map(c => ({ text: c.text, offset: c.offset + start })))
    .filter(c => c.text.replace(/^\[Page \d+\]|\(no readable text\)/g, '').trim().length >= 20);
}
/** Instruction prefixes that retrieval-tuned embedding models expect for queries and passages. */
export function embeddingPrefixes(model: string): { query: string; document: string } {
  if (/embeddinggemma/i.test(model)) return { query: 'task: search result | query: ', document: 'title: none | text: ' };
  if (/nomic-embed/i.test(model)) return { query: 'search_query: ', document: 'search_document: ' };
  if (/mxbai-embed|snowflake-arctic-embed/i.test(model)) return { query: 'Represent this sentence for searching relevant passages: ', document: '' };
  return { query: '', document: '' };
}
const terms = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])];
/** Term-frequency score used when no embedding model is available. */
export function keywordScore(query: string, text: string): number {
  const words = terms(query), lower = text.toLowerCase();
  if (!words.length) return 0;
  let score = 0;
  for (const word of words) { let count = 0; for (let i = lower.indexOf(word); i >= 0 && count < 6; i = lower.indexOf(word, i + word.length)) count++; if (count) score += 1 + Math.log(count); }
  return score / words.length;
}
export function pageAt(text: string, offset: number): number | undefined {
  const marker = text.lastIndexOf('[Page ', offset + 6);
  return marker < 0 ? undefined : Number(/^\[Page (\d+)\]/.exec(text.slice(marker))?.[1]) || undefined;
}
const encode = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
const decode = (value: string) => { const bytes = Buffer.from(value, 'base64'); return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); };
/**
 * Local, content-addressed store for extracted documents, OCR results and embeddings.
 * Nothing leaves the machine; entries are keyed by a hash of the model and input.
 */
export class KnowledgeStore {
  private vectors?: Promise<Map<string, Float32Array>>;
  private documents = new Map<string, StoredDocument>();
  private saveTimer?: NodeJS.Timeout;
  private dirty = false;
  private saving: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string, private readonly maxVectors = 6000) {}
  private async write(file: string, data: string): Promise<void> {
    const path = join(this.dir, file), temp = `${path}.${process.pid}.tmp`;
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(temp, data); await rename(temp, path);
  }
  private async read(file: string): Promise<string | undefined> {
    try { return await readFile(join(this.dir, file), 'utf8'); } catch { return undefined; }
  }
  async getDocument(hash: string): Promise<StoredDocument | undefined> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    const cached = this.documents.get(hash); if (cached) return cached;
    const raw = await this.read(`documents/${hash}.json`);
    if (!raw) return;
    try { const document = JSON.parse(raw) as StoredDocument; this.remember(document); return document; } catch { return undefined; }
  }
  async putDocument(document: StoredDocument): Promise<void> { this.remember(document); await this.write(`documents/${document.hash}.json`, JSON.stringify(document)); }
  private remember(document: StoredDocument): void {
    this.documents.delete(document.hash); this.documents.set(document.hash, document);
    if (this.documents.size > 24) this.documents.delete(this.documents.keys().next().value!);
  }
  async getText(kind: 'ocr', key: string): Promise<string | undefined> { return /^[0-9a-f]{64}$/.test(key) ? this.read(`${kind}/${key}.txt`) : undefined; }
  async putText(kind: 'ocr', key: string, text: string): Promise<void> { await this.write(`${kind}/${key}.txt`, text); }
  private load(): Promise<Map<string, Float32Array>> {
    return this.vectors ??= this.read('embeddings.json').then(raw => {
      const map = new Map<string, Float32Array>();
      try { for (const [key, value] of Object.entries((JSON.parse(raw ?? '{}') as { entries?: Record<string, string> }).entries ?? {})) map.set(key, decode(value)); } catch { /* Start a fresh cache. */ }
      return map;
    });
  }
  /** Returns one vector per text, computing only the ones not already cached for this model. */
  async embed(model: string, texts: string[], compute: (batch: string[]) => Promise<number[][]>, signal?: AbortSignal): Promise<{ vectors: Float32Array[]; computed: number }> {
    const map = await this.load(), keys = texts.map(text => sha256(model, text));
    const missing = [...new Set(keys.map((key, index) => map.has(key) ? -1 : index).filter(index => index >= 0).map(index => texts[index]!))];
    for (let i = 0; i < missing.length; i += 16) {
      signal?.throwIfAborted();
      const batch = missing.slice(i, i + 16), vectors = await compute(batch);
      if (vectors.length !== batch.length) throw new Error('Invalid embedding response.');
      batch.forEach((text, index) => map.set(sha256(model, text), Float32Array.from(vectors[index]!)));
    }
    const vectors = keys.map(key => { const vector = map.get(key)!; map.delete(key); map.set(key, vector); return vector; });
    while (map.size > this.maxVectors) map.delete(map.keys().next().value!);
    if (missing.length) this.scheduleSave();
    return { vectors, computed: missing.length };
  }
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 1500);
  }
  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (!this.dirty || !this.vectors) return;
    this.dirty = false;
    const map = await this.vectors;
    this.saving = this.saving.then(() => this.write('embeddings.json', JSON.stringify({ version: 1, entries: Object.fromEntries([...map].map(([key, vector]) => [key, encode(vector)])) }))).catch(() => {});
    await this.saving;
  }
}
