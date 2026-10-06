import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EditorEvent, EditorState, MAX_SELECTION_CHARS, acpEditorBlocks, claudeEditorBlocks, codexEditorText, plainEditorText } from '../src/editor-context';
import { EditorSnapshot } from '../src/types';

const abs = join(tmpdir(), 'proj', 'src', 'core.ts');
const event = (name: string, patch: Partial<EditorEvent> = {}): EditorEvent => ({ path: join(tmpdir(), 'proj', 'src', name), relPath: 'src/' + name, label: name, kind: 'text', ...patch });
const withSelection: EditorSnapshot = { path: abs, relPath: 'src/core.ts', label: 'core.ts', kind: 'text', selection: { startLine: 10, endLine: 24, text: 'const a = 1;' },
  openTabs: [{ label: 'engine.ts', relPath: 'src/engine.ts' }], key: abs + '#10-24' };
const plain: EditorSnapshot = { path: abs, relPath: 'src/core.ts', label: 'core.ts', kind: 'text', openTabs: [], key: abs + '#' };

test('Claude gets its own ide_selection / ide_opened_file blocks with the absolute path', () => {
  assert.deepEqual(claudeEditorBlocks(withSelection), [`<ide_selection>The user selected the lines 10 to 24 from ${abs}:\nconst a = 1;\n\nThis may or may not be related to the current task.</ide_selection>`]);
  assert.deepEqual(claudeEditorBlocks(plain), [`<ide_opened_file>The user opened the file ${abs} in the IDE. This may or may not be related to the current task.</ide_opened_file>`]);
});
test('Codex gets the IDE context header before the request', () => {
  assert.equal(codexEditorText(withSelection, 'Fix it'), [
    '# Context from my IDE setup:', '', '## Active file: src/core.ts', '',
    '## Active selection of the file (lines 10-24):', 'const a = 1;',
    '## Open tabs:', '- engine.ts: src/engine.ts', '',
    '## My request:', 'Fix it'].join('\n'));
  assert.equal(codexEditorText(plain, 'Hi'), '# Context from my IDE setup:\n\n## Active file: src/core.ts\n\n## My request:\nHi');
});
test('ACP gets a resource link, the selection as an embedded resource and a note', () => {
  const url = pathToFileURL(abs).href;
  assert.deepEqual(acpEditorBlocks(withSelection), [
    { type: 'resource_link', uri: url, name: 'core.ts' },
    { type: 'resource', resource: { uri: url + '#L10-L24', mimeType: 'text/plain', text: 'const a = 1;' } },
    { type: 'text', text: 'The user is viewing src/core.ts (lines 10-24 selected) in the IDE. This may or may not be related to the task.' },
  ]);
  assert.deepEqual(acpEditorBlocks(plain), [
    { type: 'resource_link', uri: url, name: 'core.ts' },
    { type: 'text', text: 'The user is viewing src/core.ts in the IDE. This may or may not be related to the task.' },
  ]);
  assert.equal((acpEditorBlocks({ ...plain, path: 'untitled:Untitled-1' })[0] as any).uri, 'untitled:Untitled-1');
});
test('legacy providers get a short bracketed note with the selection', () => {
  assert.equal(plainEditorText(withSelection), '[The user has src/core.ts open in the editor, lines 10–24 selected.]\n```\nconst a = 1;\n```');
  assert.equal(plainEditorText(plain), '[The user has src/core.ts open in the editor.]');
  assert.equal(plainEditorText({ ...withSelection, selection: { startLine: 1, endLine: 2, text: 'x'.repeat(20000) } }).length, '[The user has src/core.ts open in the editor, lines 1–2 selected.]\n```\n\n```'.length + 12000);
});
test('selection lines are 1-based and a selection ending at column 0 of the next line ends on the line before', () => {
  const state = new EditorState();
  state.active(event('a.ts', { selection: { startLine0: 9, startChar: 0, endLine0: 24, endChar: 0, text: 'body' } }), 1, false);
  assert.deepEqual(state.snapshot()!.selection, { startLine: 10, endLine: 24, text: 'body' });
  assert.equal(state.snapshot()!.key, event('a.ts').path + '#10-24');
  state.selection(event('a.ts', { selection: { startLine0: 9, startChar: 2, endLine0: 9, endChar: 0 + 7, text: 'abcde' } }));
  assert.deepEqual(state.snapshot()!.selection, { startLine: 10, endLine: 10, text: 'abcde' });
  state.selection(event('a.ts', { selection: { startLine0: 3, startChar: 4, endLine0: 3, endChar: 4, text: '' } }));
  assert.equal(state.snapshot()!.selection, undefined);
  assert.equal(state.snapshot()!.key, event('a.ts').path + '#');
});
test('selection text is capped', () => {
  const state = new EditorState();
  state.active(event('big.ts', { selection: { startLine0: 0, startChar: 0, endLine0: 9000, endChar: 3, text: 'y'.repeat(MAX_SELECTION_CHARS + 50) } }), 1, false);
  assert.equal(state.snapshot()!.selection!.text.length, MAX_SELECTION_CHARS);
});
test('the last editor is kept while the Chatroom panel has focus and cleared when no editor is visible', () => {
  const state = new EditorState();
  state.active(event('a.ts', { dirty: true, languageId: 'typescript' }), 1, false);
  state.active(undefined, 0, true);
  assert.equal(state.snapshot()?.label, 'a.ts');
  assert.equal(state.snapshot()?.dirty, true); assert.equal(state.snapshot()?.languageId, 'typescript');
  state.active(undefined, 2, false);
  assert.equal(state.snapshot()?.label, 'a.ts', 'kept while text editors are still visible');
  state.active(undefined, 0, false);
  assert.equal(state.snapshot(), undefined);
});
test('open tabs: most recent first, deduplicated, without the active file, at most 5', () => {
  const state = new EditorState();
  for (const name of ['1.ts', '2.ts', '3.ts', '2.ts', '4.ts', '5.ts', '6.ts', '7.ts']) state.active(event(name), 1, false);
  assert.deepEqual(state.snapshot()!.openTabs.map(t => t.label), ['6.ts', '5.ts', '4.ts', '2.ts', '3.ts']);
  assert.deepEqual(state.snapshot()!.openTabs[0], { label: '6.ts', relPath: 'src/6.ts' });
  state.active(event('2.ts'), 1, false);
  assert.deepEqual(state.snapshot()!.openTabs.map(t => t.label), ['7.ts', '6.ts', '5.ts', '4.ts', '3.ts']);
  const small = new EditorState(2);
  for (const name of ['1.ts', '2.ts', '3.ts', '4.ts']) small.active(event(name), 1, false);
  assert.deepEqual(small.snapshot()!.openTabs.map(t => t.label), ['3.ts', '2.ts']);
});
