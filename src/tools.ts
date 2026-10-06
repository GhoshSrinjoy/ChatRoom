import * as vscode from 'vscode';
import { readFile, stat } from 'node:fs/promises';
import { relative, isAbsolute, extname } from 'node:path';
import { ToolCall, Agent, Room } from './types';
import { safePath, DENIED } from './paths';
import { DocumentService } from './documents';
import { IMAGE_EXTENSIONS, MAX_DOCUMENT_BYTES, documentKind } from './extract';
import { cosine } from './knowledge';

export { cosine };
const EXCLUDES = '**/{node_modules,.git,.conda,.env,.aws,.ssh,.codex,.agents,dist,build}/**';
export class ToolService {
  constructor(private readonly root: () => string, private readonly documents: DocumentService, private readonly room: () => Room, private readonly log: (text: string) => void) {}
  private async files(glob = '**/*'): Promise<string[]> {
    if (glob.length > 300 || glob.includes('..') || isAbsolute(glob)) throw new Error('Invalid file glob.');
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root(), glob), EXCLUDES, 160);
    return uris.map(uri => relative(this.root(), uri.fsPath)).filter(p => !DENIED.test(p));
  }
  private async text(path: string): Promise<string> {
    const full = await safePath(this.root(), path);
    if ((await stat(full)).size > 256_000) throw new Error('File is too large (256 KB maximum).');
    const bytes = await readFile(full);
    if (bytes.includes(0)) throw new Error('Binary file is not readable as text.');
    return bytes.toString('utf8').slice(0, 24000);
  }
  async execute(call: ToolCall, agent: Agent, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!vscode.workspace.isTrusted) throw new Error('Tools require a trusted workspace.');
    if (!agent.tools.includes(call.name)) throw new Error(`${call.name} is disabled for ${agent.name}.`);
    const arg = (key: string, fallback = '') => typeof call.arguments[key] === 'string' ? String(call.arguments[key]).slice(0, 2000) : fallback;
    if (call.name === 'list_files') return (await this.files(arg('glob', '**/*'))).join('\n') || 'No matching files.';
    if (call.name === 'read_file') {
      const path = arg('path');
      if (['pdf', 'docx', 'image'].includes(documentKind(path) ?? '')) {
        // Documents are extracted (with OCR for images and scans) and attached to the room.
        const full = await safePath(this.root(), path);
        if ((await stat(full)).size > MAX_DOCUMENT_BYTES) throw new Error('Documents must be smaller than 40 MB.');
        return this.documents.read(this.room(), path.replace(/\\/g, '/'), await readFile(full), signal);
      }
      return this.text(path);
    }
    if (call.name === 'search_files') {
      const query = arg('query'); if (!query) throw new Error('Search query cannot be empty.');
      const found: string[] = [];
      for (const file of await this.files(arg('glob', '**/*'))) {
        signal.throwIfAborted();
        try { const lines = (await this.text(file)).split('\n'); for (let i = 0; i < lines.length; i++) if (lines[i]!.toLowerCase().includes(query.toLowerCase())) found.push(`${file}:${i + 1}: ${lines[i]!.slice(0, 400)}`); } catch { /* Skip binary, large and denied files. */ }
        if (found.length >= 60) break;
      }
      return found.slice(0, 60).join('\n') || 'No matches in the first 160 candidate files.';
    }
    if (call.name === 'search_documents') {
      const query = arg('query'); if (!query) throw new Error('Search query cannot be empty.');
      const room = this.room(), ready = (room.documents ?? []).filter(d => d.status === 'ready');
      if (!ready.length) return 'No documents are attached to this room. Ask the user to attach files, or read a workspace PDF, Word file or image with read_file to attach it.';
      const { hits, method } = await this.documents.search(room, query, 6, signal);
      this.log(`Document search · ${hits.length} passages · ${method}`);
      return hits.length ? `Searched ${ready.length} document(s) using ${method}.\n\n${this.documents.format(hits)}` : `No passages in ${ready.map(d => d.name).join(', ')} matched. Try different words.`;
    }
    if (call.name === 'ollama_ocr') {
      const path = await safePath(this.root(), arg('path'));
      if (!IMAGE_EXTENSIONS.includes(extname(path).toLowerCase())) throw new Error('OCR accepts PNG, JPEG and WebP images. Use read_file for PDFs.');
      if ((await stat(path)).size > 8_000_000) throw new Error('OCR image must be smaller than 8 MB.');
      return (await this.documents.ocr(await readFile(path), signal)).slice(0, 24000);
    }
    const query = arg('query'); if (!query) throw new Error('Semantic query cannot be empty.');
    const snippets: { path: string; text: string }[] = [];
    for (const path of (await this.files(arg('glob', '**/*'))).slice(0, 40)) {
      signal.throwIfAborted();
      try {
        const content = (await this.text(path)).slice(0, 6000);
        for (let offset = 0; offset < content.length; offset += 1800) snippets.push({ path: `${path} (character ${offset})`, text: content.slice(offset, offset + 2000) });
      } catch { /* Not a usable source file. */ }
    }
    if (!snippets.length) return 'No readable source files found.';
    const { vectors, computed } = await this.documents.embed(snippets.map(s => s.text), signal);
    const question = (await this.documents.embed([query], signal, { role: 'query' })).vectors[0]!;
    const result = snippets.map((s, index) => ({ ...s, score: cosine(question, vectors[index]!) })).sort((a, b) => b.score - a.score).slice(0, 5);
    this.log(`Semantic search · ${snippets.length - computed}/${snippets.length} cached snippets · ${computed} new embeddings`);
    return result.map(s => `${s.path} · similarity ${s.score.toFixed(3)}\n${s.text}`).join('\n\n');
  }
}
