import { pathToFileURL } from 'node:url';
import { EditorSnapshot } from './types';

export const MAX_SELECTION_CHARS = 100_000;
export interface EditorEvent {
  path: string; relPath: string; label: string; languageId?: string; kind: EditorSnapshot['kind'];
  /** 0-based positions, as VS Code reports them. */
  selection?: { startLine0: number; startChar: number; endLine0: number; endChar: number; text: string };
  dirty?: boolean;
}
/** Pure reducer for "the last non-Chatroom editor", following Claude Code's extension. */
export class EditorState {
  private last?: EditorEvent;
  private recent: { path: string; label: string; relPath: string }[] = [];
  constructor(private readonly maxTabs = 5) {}
  active(e: EditorEvent | undefined, visibleTextEditors: number, chatroomPanelFocused: boolean): void {
    if (e) { this.update(e); return; }
    if (chatroomPanelFocused) return;
    if (visibleTextEditors === 0) this.last = undefined;
  }
  selection(e: EditorEvent): void { this.update(e); }
  /** The raw event behind the snapshot (for revealing the exact selection). */
  current(): EditorEvent | undefined { return this.last; }
  snapshot(): EditorSnapshot | undefined {
    const e = this.last;
    if (!e) return;
    const selection = mapSelection(e.selection);
    return {
      path: e.path, relPath: e.relPath, label: e.label, ...(e.languageId ? { languageId: e.languageId } : {}), kind: e.kind,
      ...(selection ? { selection } : {}), ...(e.dirty !== undefined ? { dirty: e.dirty } : {}),
      openTabs: this.recent.filter(t => t.path !== e.path).slice(0, this.maxTabs).map(t => ({ label: t.label, relPath: t.relPath })),
      key: e.path + '#' + (selection ? `${selection.startLine}-${selection.endLine}` : ''),
    };
  }
  private update(e: EditorEvent) {
    this.last = e;
    this.recent = [{ path: e.path, label: e.label, relPath: e.relPath }, ...this.recent.filter(t => t.path !== e.path)].slice(0, this.maxTabs + 1);
  }
}
function mapSelection(s: EditorEvent['selection']): EditorSnapshot['selection'] {
  if (!s || !s.text || (s.startLine0 === s.endLine0 && s.startChar === s.endChar)) return;
  const endLine = s.endChar === 0 && s.endLine0 > s.startLine0 ? s.endLine0 : s.endLine0 + 1;
  return { startLine: s.startLine0 + 1, endLine, text: s.text.slice(0, MAX_SELECTION_CHARS) };
}
/** Absolute paths become file URLs; untitled and notebook-cell URIs are kept as they are. */
function fileUrl(path: string): string { return /^[a-z][\w+.-]+:/i.test(path) ? path : pathToFileURL(path).href; }

export function claudeEditorBlocks(s: EditorSnapshot): string[] {
  const sel = s.selection;
  return [sel
    ? `<ide_selection>The user selected the lines ${sel.startLine} to ${sel.endLine} from ${s.path}:\n${sel.text}\n\nThis may or may not be related to the current task.</ide_selection>`
    : `<ide_opened_file>The user opened the file ${s.path} in the IDE. This may or may not be related to the current task.</ide_opened_file>`];
}
export function codexEditorText(s: EditorSnapshot, request: string): string {
  const sel = s.selection, lines = ['# Context from my IDE setup:', '', '## Active file: ' + s.relPath, ''];
  if (sel) lines.push(`## Active selection of the file (lines ${sel.startLine}-${sel.endLine}):`, sel.text);
  if (s.openTabs.length) lines.push('## Open tabs:', ...s.openTabs.map(t => '- ' + t.label + ': ' + t.relPath), '');
  lines.push('## My request:', request);
  return lines.join('\n');
}
export function acpEditorBlocks(s: EditorSnapshot): object[] {
  const sel = s.selection, url = fileUrl(s.path);
  return [
    { type: 'resource_link', uri: url, name: s.label },
    ...(sel ? [{ type: 'resource', resource: { uri: `${url}#L${sel.startLine}-L${sel.endLine}`, mimeType: 'text/plain', text: sel.text } }] : []),
    { type: 'text', text: 'The user is viewing ' + s.relPath + (sel ? ` (lines ${sel.startLine}-${sel.endLine} selected)` : '') + ' in the IDE. This may or may not be related to the task.' },
  ];
}
export function plainEditorText(s: EditorSnapshot): string {
  const sel = s.selection;
  return '[The user has ' + s.relPath + ' open in the editor' + (sel ? `, lines ${sel.startLine}–${sel.endLine} selected` : '') + '.]'
    + (sel ? '\n```\n' + sel.text.slice(0, 12000) + '\n```' : '');
}
