// Renders the real webview with sample data and saves the README screenshots to docs/images.
// Usage: node scripts/screenshots.mjs   (uses an existing Google Chrome installation)
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const out = 'docs/images';
await mkdir(out, { recursive: true });
const now = new Date('2026-10-06T09:41:00').getTime();
const options = { effort: '', thinking: 'on', summary: 'auto', permission: 'ask', useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false };
const agents = [
  { id: 'a1', name: 'Codex', provider: 'codex', model: '', role: '', enabled: true, tools: ['list_files', 'read_file', 'search_files', 'search_documents'], options },
  { id: 'a2', name: 'Claude', provider: 'claude', model: 'sonnet', role: '', enabled: true, tools: ['list_files', 'read_file', 'search_files', 'search_documents'], options },
  { id: 'a3', name: 'Copilot', provider: 'copilot', model: '', role: '', enabled: true, tools: ['list_files', 'read_file', 'search_files', 'search_documents'], options: { ...options, copilotRuntime: 'auto' } }
];
const tasks = {
  s1: 'Read src/process.ts and list every way a stopped or timed-out CLI could keep a turn waiting.',
  s2: 'Check tests/process.test.ts and list the cancellation cases it does not cover.',
  s3: 'Verify the hang paths from s1 against the code and propose fixes that also close the test gaps from s2.'
};
const steps = status => [
  { id: 's1', agentId: 'a1', task: tasks.s1, after: [], status: status[0] },
  { id: 's2', agentId: 'a3', task: tasks.s2, after: [], status: status[1] },
  { id: 's3', agentId: 'a2', task: tasks.s3, after: ['s1', 's2'], status: status[2] }];
const say = (id, agentId, author, text, extra = {}) => ({ id, kind: 'agent', agentId, author, text, status: 'complete', createdAt: now, ...extra });
const step = (id, agentId, author, text, extra = {}) => say(`m-${id}`, agentId, author, text, { turn: 'step', step: { id, plan: 'plan', task: tasks[id], after: id === 's3' ? ['s1', 's2'] : [] }, ...extra });
const user = { id: 'u', kind: 'user', author: 'You', status: 'complete', createdAt: now, text: 'Review the subprocess handling for reliability issues. Split the work, read the code, and challenge each other\'s findings.' };
const plan = status => say('plan', 'a2', 'Claude', 'Codex audits how turns are stopped while Copilot checks what the tests cover. Then I verify both against the code and propose fixes.', { turn: 'plan', plan: steps(status) });
const tool = { id: 't1', kind: 'tool', author: 'read_file', agentId: 'a1', status: 'complete', createdAt: now, text: 'export function runJsonLines(executable, args, input, cwd, signal, onEvent) { … }' };
const s1 = step('s1', 'a1', 'Codex', 'Two hang paths.\n\n1. On macOS and Linux, stop sends a single SIGTERM and then waits for the process to close. A CLI that ignores it never closes, so the turn never ends.\n2. The close event also waits for any helper process that still holds stdout, even after the CLI itself has exited.\n\nThe turn timeout uses the same path, so it hangs the same way.');
const s2 = step('s2', 'a3', 'Copilot', 'The only cancellation test uses a child that exits on the first signal. Missing: a CLI that ignores SIGTERM, a helper that keeps the output pipe open, and a CLI that prints a plain-text error and exits 0.');
const s3 = step('s3', 'a2', 'Claude', 'Both paths from Codex are real; I confirmed them in `runJsonLines`. Copilot\'s third gap is milder than it looks: an empty answer is already rejected, but the CLI\'s own message is thrown away, so the error should include it. [CONSENSUS]');
const final = say('final', 'a2', 'Claude', '**Three fixes, in priority order.**\n\n1. **Bounded stop.** Stop the CLI\'s whole process group, force-kill after 2 seconds, and release its pipes 2 seconds later, so a stuck process can never freeze the room.\n2. **Leftover helpers.** After the CLI exits, wait at most 2 seconds for its output to close.\n3. **Useful errors.** When a CLI prints plain text instead of an answer, show that text.\n\nCodex found both hang paths, and Copilot\'s test gaps become the regression tests for each fix.', { turn: 'synthesis' });
const documents = ocr => [
  { id: 'd1', name: 'docs/process-design.pdf', hash: 'h1', kind: 'pdf', source: 'attached', status: 'ready', chars: 18250, chunks: 14, pages: 6, ocrPages: 2, embedded: 'embeddings', addedAt: now },
  ocr ? { id: 'd2', name: 'whiteboard.png', hash: 'h2', kind: 'image', source: 'attached', status: 'ocr', detail: 'OCR · whiteboard.png', chars: 0, chunks: 0, addedAt: now }
    : { id: 'd2', name: 'whiteboard.png', hash: 'h2', kind: 'image', source: 'attached', status: 'ready', chars: 940, chunks: 1, ocrPages: 1, embedded: 'embeddings', addedAt: now }];
const usage = {
  a1: { input: 144000, cached: 77700, output: 2100, cacheWrite: 0, requests: 4, estimated: false },
  a2: { input: 26300, cached: 18100, output: 1900, cacheWrite: 2400, requests: 3, estimated: false, cost: 0.0412 },
  a3: { input: 9200, cached: 0, output: 600, cacheWrite: 0, requests: 1, estimated: true },
  'local-tools': { input: 3400, cached: 0, output: 170, cacheWrite: 0, requests: 3, estimated: false }
};
const connections = [
  { id: 'codex', status: 'ready', detail: 'VS Code extension runtime', models: [] },
  { id: 'claude', status: 'ready', detail: 'VS Code extension runtime', models: [{ id: 'sonnet', name: 'sonnet' }] },
  { id: 'copilot', status: 'ready', detail: 'Models available through VS Code', models: [] },
  { id: 'ollama', status: 'ready', detail: 'Installed models · loopback endpoint', models: [{ id: 'glm-ocr:latest', name: 'glm-ocr:latest', capabilities: ['vision'] }, { id: 'embeddinggemma:latest', name: 'embeddinggemma:latest', capabilities: ['embedding'] }] }];
const room = overrides => ({ id: 'demo', title: 'Review the subprocess handling for reliability issues', createdAt: now, status: 'idle', mode: 'orchestrated', leadId: 'a2', concurrency: 3,
  activeAgents: [], queuedTurns: 0, loop: { kind: 'once', rounds: 2, everyMinutes: 10, maxIterations: 5, maxMinutes: 60, maxTokens: 0 }, attachEditor: true, shareSkills: true, tokenBudget: 0, runStartTokens: 0, completedTurns: 5, activity: [], usage, agents, ...overrides });
const state = room => ({ type: 'state', workspace: 'chatroom', trusted: true, discovering: false, modelDefaults: { planning: {}, drafting: {}, review: {} }, defaultPreset: 'planning', executionMode: 'orchestrated', maxParallelAgents: 3,
  rooms: [{ id: 'demo', title: room.title }], connections, capabilities: {}, editor: null, sharedSkills: [], roomCommands: [],
  settings: { allowFullAccess: false, attachOpenFile: true, approvalTimeoutSeconds: 300 }, localModels: { vision: 'glm-ocr:latest', embedding: 'embeddinggemma:latest' }, room });
const running = room({ status: 'running', activeAgents: ['a3'], currentAgent: 'a3', queuedTurns: 1, completedTurns: 2, documents: documents(true),
  agentStates: { a1: { status: 'complete' }, a2: { status: 'queued' }, a3: { status: 'thinking' } },
  messages: [user, plan(['complete', 'running', 'pending']), tool, s1, { ...s2, status: 'streaming', text: 'The only cancellation test uses a child that exits on the first signal. Missing:' }] });
const done = room({ documents: documents(false), messages: [user, plan(['complete', 'complete', 'complete']), tool, s1, s2, s3, final] });

const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Chatroom</title><div id="app"></div><script src="/app.js"></script></html>'); return; }
  if (!['/app.css', '/app.js'].includes(req.url)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
  res.end(await readFile(resolve('media', req.url.slice(1))));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // scrollTo: a message to bring to the top (default: the end). tab: capture only that inspector panel.
  const shoot = async (file, data, { width, height, tab, scrollTo, collapseAgents }) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} }); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => { document.body.className = 'vscode-dark'; document.documentElement.style.setProperty('--vscode-sideBar-background', '#181818'); });
    await page.evaluate(data => window.postMessage(data, '*'), data);
    await page.locator('.message.user').waitFor();
    if (collapseAgents) await page.evaluate(() => { const roster = document.querySelector('.roster'); if (roster) roster.open = false; });
    if (tab) { await page.locator('.inspector-toggle').click(); await page.locator(`[data-tab="${tab}"]`).click(); }
    await page.evaluate(selector => {
      const list = document.getElementById('messages'), target = selector && list.querySelector(selector);
      list.scrollTop = target ? target.offsetTop - list.offsetTop - 8 : list.scrollHeight;
    }, scrollTo);
    await page.waitForTimeout(150);
    await (tab ? page.locator('#inspector') : page).screenshot({ path: `${out}/${file}` });
    await page.close();
    console.log(`Saved ${out}/${file}`);
  };
  await shoot('lead-team.png', state(running), { width: 1100, height: 1300, scrollTo: '.message.user' });
  await shoot('final-answer.png', state(done), { width: 1100, height: 1180 });
  await shoot('sidebar.png', state(running), { width: 420, height: 1000, scrollTo: '.message.turn-plan', collapseAgents: true });
  await shoot('documents.png', state(done), { width: 1100, height: 1220, tab: 'tools' });
  await shoot('usage.png', state(done), { width: 1100, height: 1220, tab: 'usage' });
} finally { await browser.close(); await new Promise(r => server.close(r)); }
