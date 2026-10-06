import * as vscode from 'vscode';
import { basename } from 'node:path';
import { EditorEvent, EditorState, MAX_SELECTION_CHARS } from './editor-context';
import { EditorSnapshot } from './types';

const SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell']);
const supported = (editor: vscode.TextEditor) => SCHEMES.has(editor.document.uri.scheme);
function toEvent(editor: vscode.TextEditor): EditorEvent | undefined {
  const { document, selection } = editor, uri = document.uri;
  if (!SCHEMES.has(uri.scheme)) return;
  const path = uri.scheme === 'file' ? uri.fsPath : uri.toString();
  return {
    path, relPath: uri.scheme === 'file' ? vscode.workspace.asRelativePath(uri, false) : path,
    label: uri.scheme === 'file' ? basename(uri.fsPath) : basename(document.fileName) || path,
    languageId: document.languageId, kind: uri.scheme === 'vscode-notebook-cell' ? 'notebook' : 'text', dirty: document.isDirty,
    ...(selection.isEmpty ? {} : { selection: { startLine0: selection.start.line, startChar: selection.start.character, endLine0: selection.end.line, endChar: selection.end.character,
      text: document.getText(selection).slice(0, MAX_SELECTION_CHARS) } }),
  };
}
/** Follows the last non-Chatroom text editor, its selection and recent tabs (Claude Code's rules, see EditorState). */
export class EditorTracker implements vscode.Disposable {
  private readonly state = new EditorState();
  private readonly subscriptions: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private sent = '';
  constructor(private readonly onChange: (snapshot: EditorSnapshot | undefined) => void) {
    const w = vscode.window;
    this.subscriptions.push(
      w.onDidChangeActiveTextEditor(editor => this.active(editor)),
      w.onDidChangeTextEditorSelection(event => {
        const e = toEvent(event.textEditor);
        if (!e) return;
        this.state.selection(e);
        clearTimeout(this.timer); this.timer = setTimeout(() => this.emit(), 300);
      }),
      w.onDidChangeVisibleTextEditors(() => { if (!w.activeTextEditor) this.active(undefined); }),
    );
    const seed = w.activeTextEditor ?? w.visibleTextEditors[0];
    const e = seed && toEvent(seed);
    if (e) this.state.active(e, w.visibleTextEditors.length, false);
    this.sent = JSON.stringify(this.state.snapshot() ?? null);
  }
  snapshot(): EditorSnapshot | undefined { return this.state.snapshot(); }
  async reveal(): Promise<void> {
    const e = this.state.current();
    if (!e) return;
    const uri = /^[a-z][\w+.-]+:/i.test(e.path) ? vscode.Uri.parse(e.path) : vscode.Uri.file(e.path);
    const s = e.selection, selection = s ? new vscode.Range(s.startLine0, s.startChar, s.endLine0, s.endChar) : undefined;
    await vscode.window.showTextDocument(uri, { ...(selection ? { selection } : {}), preview: false, viewColumn: vscode.ViewColumn.One });
  }
  dispose(): void {
    clearTimeout(this.timer);
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
  private active(editor: vscode.TextEditor | undefined) {
    const e = editor && toEvent(editor);
    if (editor && !e) return; // Output panels and other internal editors leave the context unchanged.
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const focused = input instanceof vscode.TabInputWebview && input.viewType.includes('chatroom');
    this.state.active(e, vscode.window.visibleTextEditors.filter(supported).length, focused);
    clearTimeout(this.timer);
    this.emit();
  }
  private emit() {
    const snapshot = this.state.snapshot(), text = JSON.stringify(snapshot ?? null);
    if (text === this.sent) return;
    this.sent = text;
    this.onChange(snapshot);
  }
}
