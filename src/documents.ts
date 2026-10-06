import { randomUUID } from 'node:crypto';
import { Room, RoomDocument } from './types';
import { Chunk, KnowledgeStore, StoredDocument, chunkDocument, cosine, embeddingPrefixes, keywordScore, pageAt, sha256 } from './knowledge';
import { documentKind, extractDocument } from './extract';

export interface LocalModels { vision: string; embedding: string }
export interface LocalModelClient {
  ocr(model: string, image: string, signal: AbortSignal, checkBudget?: boolean): Promise<{ text: string; input: number; output: number; partial: boolean }>;
  embed(model: string, input: string[], signal: AbortSignal, checkBudget?: boolean): Promise<number[][]>;
}
interface Hit { document: RoomDocument; stored: StoredDocument; chunk: Chunk; score: number }
const READ_LIMIT = 24000;
/**
 * Turns attached or workspace documents into searchable room knowledge: extraction (with local OCR for
 * images and scanned PDF pages), chunking, and embeddings, all cached on disk by content hash.
 */
export class DocumentService {
  private pending = new Map<string, Promise<RoomDocument>>();
  constructor(private readonly store: KnowledgeStore, private readonly local: LocalModelClient, readonly models: LocalModels,
    private readonly log: (text: string, kind?: 'info' | 'tool' | 'error') => void, private readonly changed: () => void) {}
  async ocr(image: Uint8Array, signal: AbortSignal, checkBudget = true): Promise<string> {
    const model = this.models.vision;
    if (!model) throw new Error('Choose a local vision/OCR model in the Tools tab.');
    const key = sha256(model, image), cached = await this.store.getText('ocr', key);
    if (cached !== undefined) { this.log('OCR result cache hit · no model request', 'tool'); return cached; }
    const result = await this.local.ocr(model, Buffer.from(image).toString('base64'), signal, checkBudget);
    this.log(`Local OCR · ${result.input} input / ${result.output} output tokens`, 'tool');
    if (result.partial) this.log('OCR stopped repetitive or truncated output · result is partial and was not cached', 'tool');
    else await this.store.putText('ocr', key, result.text);
    return result.text;
  }
  async embed(texts: string[], signal: AbortSignal, options: { role?: 'query' | 'document'; checkBudget?: boolean } = {}): Promise<{ vectors: Float32Array[]; computed: number }> {
    const model = this.models.embedding;
    if (!model) throw new Error('Choose a local embedding model in the Tools tab.');
    const prefix = embeddingPrefixes(model)[options.role ?? 'document'];
    return this.store.embed(model, texts.map(text => prefix + text), batch => this.local.embed(model, batch, signal, options.checkBudget ?? true), signal);
  }
  /** Adds a document to a room. The same bytes are extracted and embedded once, even across rooms. */
  ingest(room: Room, name: string, bytes: Uint8Array, options: { source: RoomDocument['source']; signal?: AbortSignal; checkBudget?: boolean }): Promise<RoomDocument> {
    const hash = sha256(bytes), key = `${room.id}:${hash}`;
    const existing = (room.documents ??= []).find(d => d.hash === hash);
    if (existing?.status === 'ready') return Promise.resolve(existing);
    const running = this.pending.get(key); if (running) return running;
    const promise = this.process(room, name, hash, bytes, options).finally(() => this.pending.delete(key));
    this.pending.set(key, promise); return promise;
  }
  private async process(room: Room, name: string, hash: string, bytes: Uint8Array, options: { source: RoomDocument['source']; signal?: AbortSignal; checkBudget?: boolean }): Promise<RoomDocument> {
    const kind = documentKind(name, bytes) ?? 'text', signal = options.signal ?? new AbortController().signal, checkBudget = options.checkBudget ?? true;
    const documents = room.documents ??= [];
    let document = documents.find(d => d.hash === hash);
    if (!document) { document = { id: randomUUID(), name, hash, kind, source: options.source, status: 'extracting', chars: 0, chunks: 0, addedAt: Date.now() }; documents.push(document); }
    const doc = document;
    Object.assign(doc, { status: 'extracting', detail: 'Extracting text' }); this.changed();
    try {
      let stored = await this.store.getDocument(hash);
      if (!stored || (stored.unread && this.models.vision)) {
        const extracted = await extractDocument(name, bytes, { signal,
          ocr: this.models.vision ? (image, label) => { doc.status = 'ocr'; doc.detail = `OCR · ${label}`; this.changed(); return this.ocr(image, signal, checkBudget); } : undefined,
          progress: detail => { doc.detail = detail; this.changed(); } });
        if (!extracted.text.replace(/\[Page \d+\]|\(no readable text\)/g, '').trim()) throw new Error(this.models.vision ? 'No readable text was found.' : 'No text layer found. Choose a local vision/OCR model in the Tools tab to read scanned pages.');
        stored = { version: 1, hash, name, kind: extracted.kind, text: extracted.text, pages: extracted.pages, ocrPages: extracted.ocrPages, unread: extracted.unread || undefined, chunks: chunkDocument(extracted.text) };
        await this.store.putDocument(stored);
      }
      Object.assign(doc, { kind: stored.kind, chars: stored.text.length, chunks: stored.chunks.length, pages: stored.pages, ocrPages: stored.ocrPages });
      if (this.models.embedding) {
        doc.status = 'embedding'; doc.detail = `Embedding ${stored.chunks.length} passage${stored.chunks.length === 1 ? '' : 's'}`; this.changed();
        try {
          const { computed } = await this.embed(stored.chunks.map(c => c.text), signal, { checkBudget });
          doc.embedded = this.models.embedding;
          this.log(`${name} · ${computed ? `${computed} new embeddings` : 'embeddings reused from cache'}`, 'tool');
        } catch (error) {
          signal.throwIfAborted(); doc.embedded = undefined;
          this.log(`${name}: embeddings unavailable, keyword search will be used · ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      }
      Object.assign(doc, { status: 'ready', detail: undefined });
      this.log(`${name} ready · ${stored.pages ? `${stored.pages} pages · ` : ''}${stored.ocrPages ? `${stored.ocrPages} read with OCR · ` : ''}${stored.chunks.length} passages`, 'tool');
    } catch (error) {
      Object.assign(doc, { status: 'error', detail: error instanceof Error ? error.message : String(error) });
      this.log(`${name}: ${doc.detail}`, 'error');
    }
    this.changed(); return doc;
  }
  /** Reads a workspace PDF, Word file or image for an agent and attaches it to the room. */
  async read(room: Room, path: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    const doc = await this.ingest(room, path, bytes, { source: 'workspace', signal });
    if (doc.status !== 'ready') throw new Error(doc.detail ?? 'The document could not be read.');
    const text = (await this.store.getDocument(doc.hash))?.text ?? '';
    return text.slice(0, READ_LIMIT) + (text.length > READ_LIMIT
      ? `\n\n[Showing the first ${READ_LIMIT.toLocaleString('en')} of ${text.length.toLocaleString('en')} characters. The document is attached to this room: use search_documents to find the rest.]`
      : '\n\n[This document is now attached to the room for search_documents.]');
  }
  async search(room: Room, query: string, limit: number, signal: AbortSignal): Promise<{ hits: Hit[]; method: string }> {
    const candidates: Omit<Hit, 'score'>[] = [];
    for (const document of (room.documents ?? []).filter(d => d.status === 'ready')) {
      const stored = await this.store.getDocument(document.hash);
      for (const chunk of stored?.chunks ?? []) candidates.push({ document, stored: stored!, chunk });
    }
    if (!candidates.length) return { hits: [], method: 'none' };
    let scored: Hit[] | undefined, method = 'keywords';
    if (this.models.embedding) {
      try {
        const chunks = await this.embed(candidates.map(c => c.chunk.text), signal), question = (await this.embed([query], signal, { role: 'query' })).vectors[0]!;
        scored = candidates.map((c, index) => ({ ...c, score: cosine(question, chunks.vectors[index]!) }));
        method = `embeddings · ${this.models.embedding}`;
      } catch (error) { signal.throwIfAborted(); this.log(`Semantic document search unavailable · ${error instanceof Error ? error.message : String(error)}`, 'error'); }
    }
    scored ??= candidates.map(c => ({ ...c, score: keywordScore(query, c.chunk.text) }));
    return { hits: scored.filter(h => h.score > 0).sort((a, b) => b.score - a.score).slice(0, limit), method };
  }
  format(hits: Hit[], max = 1800): string {
    return hits.map(h => {
      const page = h.stored.kind === 'pdf' ? pageAt(h.stored.text, h.chunk.offset) : undefined;
      return `--- ${h.document.name}${page ? ` · page ${page}` : ''} · passage ${h.stored.chunks.indexOf(h.chunk) + 1}/${h.stored.chunks.length} · score ${h.score.toFixed(3)}\n${h.chunk.text.slice(0, max)}`;
    }).join('\n\n');
  }
  /** Context shared with every agent for the latest message: full text for small sets, else the best passages. */
  async briefing(room: Room, query: string, signal: AbortSignal): Promise<string> {
    const ready = (room.documents ?? []).filter(d => d.status === 'ready');
    if (!ready.length) return '';
    if (ready.reduce((sum, d) => sum + d.chars, 0) <= 5000) {
      const texts = await Promise.all(ready.map(async d => `--- ${d.name}\n${(await this.store.getDocument(d.hash))?.text ?? ''}`));
      return `[Room documents · full text]\n${texts.join('\n\n')}`;
    }
    const { hits, method } = await this.search(room, query, 5, signal);
    return hits.length ? `[Room documents · passages retrieved for the latest user message (${method}); use search_documents for more]\n${this.format(hits, 1100)}` : '';
  }
}
