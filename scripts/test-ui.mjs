import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const state = {
  type: 'state', workspace: 'chatroom', trusted: true, discovering: false,
  modelDefaults: { planning: { codex: 'test-large' }, drafting: { codex: 'test-small' }, review: {} },
  room: { id: 'preview', title: 'New conversation', createdAt: Date.now(), status: 'idle', mode: 'parallel', concurrency: 2, activeAgents: [], queuedTurns: 0, rounds: 1, tokenBudget: 50000, completedTurns: 0, messages: [], activity: [], usage: {},
    agents: [
      { id: 'a1', name: 'Codex', provider: 'codex', model: '', role: 'Engineer. Propose a concrete implementation and identify technical tradeoffs.', enabled: true, tools: ['list_files', 'read_file', 'search_files'] },
      { id: 'a2', name: 'Claude', provider: 'claude', model: 'sonnet', role: 'Reviewer. Challenge assumptions, catch edge cases, and improve the proposed solution.', enabled: true, tools: ['list_files', 'read_file', 'search_files'] },
      { id: 'a3', name: 'Copilot', provider: 'copilot', model: '', role: 'Integrator. Reconcile the discussion into practical next steps and a clear answer.', enabled: true, tools: ['list_files', 'read_file', 'search_files'] }
    ] },
  rooms: [{ id: 'preview', title: 'New conversation' }],
  connections: ['codex', 'claude', 'copilot', 'ollama'].map(id => ({ id, status: 'ready', detail: 'Preview fixture', models: id === 'ollama' ? [{ id: 'glm-ocr:latest', name: 'glm-ocr:latest', capabilities: ['vision'] }, { id: 'embeddinggemma:latest', name: 'embeddinggemma:latest', capabilities: ['embedding'] }] : [{ id: 'test-large', name: 'Large model', reasoning: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'medium' }, { id: 'test-small', name: 'Small model' }] })),
  localModels: { vision: 'glm-ocr:latest', embedding: 'embeddinggemma:latest' }
};
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="en"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Chatroom UI test</title><div id="app"></div><script src="/app.js"></script></html>'); return; }
  if (!['/app.css', '/app.js'].includes(req.url)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
  res.end(await readFile(resolve('media', req.url.slice(1))));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__outbox = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.__outbox.push(message), getState: () => ({}), setState: () => {} });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const deliver = async data => page.evaluate(data => window.postMessage(data, '*'), data);
  await deliver(state);
  await page.getByText('Chat with your agents', { exact: true }).waitFor();
  await page.evaluate(() => { document.body.className = 'vscode-dark'; document.documentElement.style.setProperty('--vscode-sideBar-background', '#181818'); });
  await page.screenshot({ path: 'artifacts/preview-desktop.png' });
  await page.getByRole('button', { name: 'Configure Codex' }).click();
  await page.locator('#agent-model').selectOption('test-large');
  await page.locator('#agent-reasoning').selectOption('high');
  await page.locator('#agent-role').fill('Review correctness and edge cases.');
  await page.getByRole('button', { name: 'Save agent' }).click();
  const edit = await page.evaluate(() => window.__outbox.find(m => m.type === 'agent'));
  assert.equal(edit.role, 'Review correctness and edge cases.');
  assert.equal(edit.model, 'test-large'); assert.equal(edit.reasoning, 'high');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('[data-default-preset="drafting"][data-default-provider="codex"]').selectOption('test-small');
  await page.locator('#default-mode').selectOption('parallel');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'saveDefaults' && m.modelDefaults.drafting.codex === 'test-small' && m.executionMode === 'parallel')));
  await page.locator('#preset').selectOption('drafting');
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'options' && m.preset === 'drafting')));
  await page.locator('[data-action="add"]').first().click();
  await page.getByRole('button', { name: /Ollama Local/ }).click();
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'addAgent' && m.provider === 'ollama')));
  await page.locator('.inspector-toggle').click();
  await page.locator('[data-tab="tools"]').click();
  await page.locator('#vision-model').selectOption('glm-ocr:latest');
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'localModels' && m.vision === 'glm-ocr:latest')));
  await page.locator('[data-tab="usage"]').click();
  await page.locator('.inspector-close').click();
  await page.locator('#prompt').fill('Compare approaches');
  await page.locator('#prompt').press('Enter');
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'send' && m.text === 'Compare approaches')));
  state.room.status = 'running'; state.room.currentAgent = 'a1'; state.room.activeAgents = ['a1', 'a2']; state.room.queuedTurns = 1;
  state.room.messages = [{ id: 'u', kind: 'user', text: 'Compare approaches', author: 'You', status: 'complete', createdAt: Date.now() }, { id: 'm', kind: 'agent', agentId: 'a1', author: 'Codex', text: '**Start with a bounded queue.**\n\nKeep cancellation and provider adapters separate.\n\n```ts\nconst room = new RoomEngine(options);\nawait room.start(prompt);\n```\n\n<img src=x onerror="window.HACKED=true">', status: 'streaming', createdAt: Date.now() }];
  await deliver(state);
  await page.locator('.message.agent').waitFor();
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.HACKED), undefined);
  assert.equal(await page.locator('.message-content img').count(), 0);
  assert.match(await page.locator('#runtime-status').textContent(), /Parallel \(max 2\) · 2 running · 1 queued/);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'pause') && window.__outbox.some(m => m.type === 'stop')));
  await page.screenshot({ path: 'artifacts/preview-conversation.png' });
  // Lead + team: a live plan with parallel and dependent steps, step messages, and attached documents.
  const now = Date.now(), steps = [
    { id: 's1', agentId: 'a2', task: 'Read src/engine.ts and list the failure modes of the scheduler.', after: [], status: 'complete' },
    { id: 's2', agentId: 'a3', task: 'Check the spec PDF for the required retry behaviour.', after: [], status: 'running' },
    { id: 's3', agentId: 'a1', task: 'Propose a fix that covers the risks from s1 and the requirements from s2.', after: ['s1', 's2'], status: 'pending' }];
  Object.assign(state.room, { mode: 'orchestrated', leadId: 'a1', status: 'running', activeAgents: ['a3'], currentAgent: 'a3', queuedTurns: 1, completedTurns: 2,
    documents: [
      { id: 'd1', name: 'docs/retry-spec.pdf', hash: 'h1', kind: 'pdf', source: 'attached', status: 'ready', chars: 18250, chunks: 14, pages: 6, ocrPages: 2, embedded: 'embeddinggemma:latest', addedAt: now },
      { id: 'd2', name: 'whiteboard.png', hash: 'h2', kind: 'image', source: 'attached', status: 'ocr', detail: 'OCR · whiteboard.png', chars: 0, chunks: 0, addedAt: now }],
    messages: [
      { id: 'u2', kind: 'user', text: 'Make the scheduler survive provider timeouts. [CONSENSUS]', author: 'You', status: 'complete', createdAt: now },
      { id: 'p', kind: 'agent', agentId: 'a1', author: 'Codex', turn: 'plan', text: 'Claude audits the scheduler while Copilot checks the spec; then I design the fix from both.', plan: steps, status: 'complete', createdAt: now },
      { id: 's1m', kind: 'agent', agentId: 'a2', author: 'Claude', turn: 'step', step: { id: 's1', plan: 'p', task: steps[0].task, after: [] }, text: 'Three failure modes: a hung CLI blocks its worker, retries are not bounded, and a timeout leaves the step marked running.', status: 'complete', createdAt: now },
      { id: 's2m', kind: 'agent', agentId: 'a3', author: 'Copilot', turn: 'step', step: { id: 's2', plan: 'p', task: steps[1].task, after: [] }, text: '', status: 'streaming', createdAt: now }] });
  await deliver(state);
  await page.locator('.plan-card').waitFor();
  assert.equal(await page.locator('.plan-stage').count(), 2);
  assert.match(await page.locator('.plan-stage').first().textContent(), /Stage 1 · in parallel/);
  assert.equal(await page.locator('.plan-step.running').count(), 1);
  assert.match(await page.locator('.message.turn-step .step-task').first().textContent(), /failure modes/);
  assert.equal(await page.locator('#lead').isVisible(), true); assert.equal(await page.locator('.lead-badge').count(), 1);
  assert.match(await page.locator('#runtime-status').textContent(), /Lead \+ team/);
  assert.match(await page.locator('#documents').textContent(), /retry-spec\.pdf.*6 p\. · 2 OCR · indexed/);
  assert.match(await page.locator('.message.user').textContent(), /\[CONSENSUS\]/, 'User text is never rewritten');
  await page.screenshot({ path: 'artifacts/preview-team.png' });
  state.room.status = 'idle'; state.room.activeAgents = []; state.room.queuedTurns = 0; steps.forEach(s => s.status = 'complete');
  state.room.messages.push({ id: 's3m', kind: 'agent', agentId: 'a1', author: 'Codex', turn: 'step', step: { id: 's3', plan: 'p', task: steps[2].task, after: ['s1', 's2'] }, text: 'Wrap each provider call in a deadline. Agreed with Claude. [CONSENSUS]', status: 'complete', createdAt: now },
    { id: 'f', kind: 'agent', agentId: 'a1', author: 'Codex', turn: 'synthesis', text: '**Final plan.** Bounded retries, per-step deadlines, and a skipped state for dependents.', status: 'complete', createdAt: now });
  state.room.messages[3].status = 'complete'; state.room.messages[3].text = 'The spec requires at most 2 retries with backoff.';
  await deliver(state);
  await page.locator('.turn-chip.synthesis').waitFor();
  assert.match(await page.locator('.message.turn-step').last().textContent(), /builds on Claude \(s1\), Copilot \(s2\)/);
  assert.match(await page.locator('.message.turn-step').last().textContent(), /agrees · nothing to add/);
  assert.doesNotMatch(await page.locator('.message.turn-step').last().locator('.message-content').textContent(), /CONSENSUS/);
  await page.locator('#lead').selectOption('a2');
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'options' && m.leadId === 'a2')));
  await page.locator('[data-remove-doc="d2"]').first().click();
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'removeDocument' && m.id === 'd2')));
  await page.locator('[data-action="attachDocuments"]').first().click();
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'attachDocuments')));
  await page.locator('#target').selectOption('a3');
  assert.equal(await page.locator('#mode').isDisabled(), true); assert.match(await page.locator('#prompt').getAttribute('placeholder'), /Message Copilot/);
  await page.locator('#prompt').fill('Just you'); await page.locator('#prompt').press('Enter');
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'send' && m.text === 'Just you' && m.target === 'a3')));
  await page.locator('#target').selectOption('');
  await page.screenshot({ path: 'artifacts/preview-team-done.png' });
  await page.locator('.inspector-toggle').click(); await page.locator('[data-tab="tools"]').click();
  assert.equal(await page.locator('.tool-row').count(), 6); assert.equal(await page.locator('.doc-row').count(), 2);
  await page.screenshot({ path: 'artifacts/preview-tools.png' });
  state.room.usage = { a1: { input: 52500, output: 300, cached: 37600, cacheWrite: 0, requests: 3, estimated: false } }; state.room.tokenBudget = 0; state.room.runStartTokens = 0;
  await deliver(state); await page.locator('[data-tab="usage"]').click();
  assert.equal(await page.locator('#budget').inputValue(), '0'); assert.equal(await page.locator('.budget-progress').count(), 0);
  assert.match(await page.locator('.inspector-section').first().textContent(), /15\.2K new.*37\.6K cached re-reads/);
  await page.locator('#budget').selectOption('100000');
  assert.ok(await page.evaluate(() => window.__outbox.some(m => m.type === 'options' && m.tokenBudget === 100000)));
  state.room.tokenBudget = 100000; await deliver(state);
  await page.locator('.budget-progress').waitFor();
  await page.screenshot({ path: 'artifacts/preview-usage.png' });
  state.room.usage = {}; state.room.tokenBudget = 0;
  await page.locator('.inspector-close').click();
  state.room.mode = 'parallel'; state.room.documents = [];
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    state.room.status = 'idle'; state.room.currentAgent = undefined; state.room.activeAgents = []; state.room.queuedTurns = 0; state.room.messages = [];
    await deliver(state); await page.locator('.empty-state').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `No horizontal overflow at ${width}px`);
    const sendBox = await page.locator('#send').boundingBox(); assert.ok(sendBox.y + sendBox.height < 900, `Composer remains visible at ${width}px`);
    await page.locator('.inspector-toggle').click();
    await page.locator('[data-tab="tools"]').click();
    assert.equal(await page.locator('#vision-model').isVisible(), true);
    await page.locator('.inspector-close').click();
    if (width === 360) await page.screenshot({ path: 'artifacts/preview-sidebar.png' });
  }
  await page.evaluate(() => {
    document.body.className = 'vscode-light';
    for (const [key, value] of Object.entries({ 'sideBar-background': '#f8f8f8', foreground: '#333333', descriptionForeground: '#666666', 'input-background': '#ffffff', 'input-foreground': '#333333', 'panel-border': '#e5e5e5', 'dropdown-background': '#ffffff', 'dropdown-foreground': '#333333', 'toolbar-hoverBackground': '#00000008' })) document.documentElement.style.setProperty('--vscode-' + key, value);
  });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(248, 248, 248)');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(51, 51, 51)');
  await page.screenshot({ path: 'artifacts/preview-light-sidebar.png' });
  assert.deepEqual(errors, []);
  // Rasterize the code-native logo for the VSIX listing icon.
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent('<html><style>*{box-sizing:border-box}body{margin:0;display:grid;place-items:center;width:128px;height:128px;background:#14251d;border-radius:26px}svg{width:86px;height:86px}</style>' + (await readFile('media/chatroom.svg', 'utf8')).replaceAll('#C5C5C5', '#A9E9CE') + '</html>');
  await page.screenshot({ path: 'media/icon.png', omitBackground: true });
  await page.setViewportSize({ width: 600, height: 180 });
  await page.setContent('<html><body style="margin:0;background:white;color:black;font:46px Arial;padding:38px">CHATROOM 123</body></html>');
  await page.screenshot({ path: 'artifacts/ocr-fixture.png' });
  console.log('UI checks passed: desktop, 360px/320px sidebar, controls, model settings, message escaping, and logo rendering.');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
