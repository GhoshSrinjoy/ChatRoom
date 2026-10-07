import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

await mkdir('artifacts', { recursive: true });
const now = Date.now();
const tools = ['list_files', 'read_file', 'search_files'];
const options = (extra = {}) => ({ effort: '', thinking: 'on', summary: 'auto', permission: 'ask', useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false, ...extra });
const supports = patch => ({ thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: true, useSkills: false, useProjectSettings: true, extraDirs: true, ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: true, customAgent: false, ...patch });
const roomCommands = [
  ['help', '', 'Show Chatroom commands', false], ['clear', '', 'Start fresh native sessions; agents forget earlier messages', true],
  ['compact', '[instructions]', 'Summarize each agent\'s native session to free context', true], ['new', '', 'Open a new room', false],
  ['export', '', 'Export this conversation as Markdown', false], ['loop', '[N | consensus | done | every 10m <prompt> | off]', 'Repeat the room\'s work until a condition or limit', false],
  ['mode', 'team | relay | parallel', 'Choose how agents collaborate', false], ['lead', '<agent>', 'Choose the lead for Team mode', false],
  ['team', '[name | Lead: Claude > Draft: Codex > … | save <name> | edit | off]', 'Set up your own team: stages such as lead, drafting, review, testing', false],
  ['model', '<model>', 'Set the model of the mentioned agent', true], ['effort', '<level>', 'Set reasoning effort for the mentioned agents (or all)', true],
  ['permissions', 'plan | ask | auto | full', 'Set what agents may do without asking', true], ['status', '', 'Show sessions, models and context use', true],
  ['stop', '', 'Stop all running agents', false],
  ['worktrees', 'off | auto | always | status | apply | keep [name] | discard | cleanup', 'Give agents their own git worktrees so parallel edits never collide', false],
  ['sandbox', 'on | off | status | <command> | python|node|bash <code>', 'Run a command or script in a throwaway Docker container (asks you first)', false]].map(([name, args, description, agentScoped]) => ({ name, ...(args ? { args } : {}), description, agentScoped }));
const capabilities = {
  a1: { provider: 'codex', runtime: 'cli', status: 'ready', version: '0.160.1', models: [], efforts: ['low', 'medium', 'high', 'xhigh'], tools: [], skills: [{ name: 'pdf', description: 'Work with PDF files' }],
    commands: [{ name: 'review', description: 'Review your changes with a subagent', source: 'mapped' }, { name: 'goal', argumentHint: '<objective> | clear', description: 'Set a goal to keep pursuing', source: 'mapped' }, { name: 'pdf', description: 'Work with PDF files', source: 'skill' }],
    mcpServers: [{ name: 'github', status: 'ready', tools: 12 }], supports: supports({ summary: true, sandbox: true, webSearch: true, ultraSession: true, ultraTurn: true, thinkHard: true }), updatedAt: now },
  a2: { provider: 'claude', runtime: 'cli', status: 'ready', version: '2.1.289', account: 'dev@example.com · max',
    models: [{ id: 'default', name: 'Default (recommended)', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, ultra: true, isDefault: true }, { id: 'sonnet', name: 'Sonnet', reasoning: ['low', 'medium', 'high'], thinking: true }],
    efforts: ['low', 'medium', 'high'], tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'Task'], skills: [{ name: 'frontend-design', description: 'Create distinctive frontend interfaces' }],
    commands: [{ name: 'review', description: 'Review a pull request', source: 'builtin' }, { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces', source: 'skill' }, { name: 'security-review', description: 'Complete a security review of the pending changes', source: 'builtin' }],
    mcpServers: [{ name: 'chatroom', status: 'connected', tools: 4 }, { name: 'sentry', status: 'failed' }], plugins: ['chatroom-shared'],
    supports: supports({ thinking: true, webSearch: true, useSkills: true, ultraSession: true, ultraTurn: true, thinkHard: true, customAgent: true }), updatedAt: now },
  a3: { provider: 'copilot', runtime: 'cli', status: 'signed-out', detail: 'Sign in to the GitHub Copilot CLI: run "copilot login" in a terminal, then try again.', action: 'copilotLogin',
    models: [], efforts: [], tools: [], skills: [], commands: [], mcpServers: [], supports: supports({ ultraTurn: true, customAgent: true }), updatedAt: now - 600000 }
};
// The built-in templates, as the host sends them (BUILTIN_TEAMS in src/core.ts).
const stage = (name, agents, extra = {}) => ({ name, agents, run: 'parallel', lead: false, ...extra });
const teams = [
  { name: 'Lead, draft, review', builtIn: true, wrapUp: true, stages: [stage('Leads', ['Claude'], { lead: true }), stage('Drafting', ['Codex'], { preset: 'drafting' }), stage('Review', ['Claude', 'Copilot'], { preset: 'review' })] },
  { name: 'Build and test', builtIn: true, wrapUp: true, stages: [stage('Leads', ['Claude'], { lead: true }), stage('Coding', ['Codex']), stage('Testing', ['Copilot'], { task: 'Write and run tests for the change' }), stage('Review', ['Claude'], { preset: 'review' })] },
  { name: 'Draft and review', builtIn: true, wrapUp: false, stages: [stage('Drafting', ['Codex'], { preset: 'drafting' }), stage('Review', ['Claude'])] }];
const outOfUsage = { reason: 'usage-limit', detail: 'You have hit your usage limit. Try again later.', at: now, until: now + 3 * 3600000 };
const state = {
  type: 'state', workspace: 'chatroom', teams, trusted: true, discovering: false, defaultPreset: 'planning', executionMode: 'parallel', maxParallelAgents: 2,
  modelDefaults: { planning: { codex: 'test-large' }, drafting: { codex: 'test-small' }, review: {} },
  room: { id: 'preview', title: 'New conversation', createdAt: now, status: 'idle', mode: 'parallel', concurrency: 2, activeAgents: [], queuedTurns: 0, tokenBudget: 50000, completedTurns: 0, messages: [], activity: [], usage: {},
    loop: { kind: 'once', rounds: 2, everyMinutes: 10, maxIterations: 5, maxMinutes: 60, maxTokens: 0 }, attachEditor: true, shareSkills: true,
    agents: [
      { id: 'a1', name: 'Codex', provider: 'codex', model: '', role: '', enabled: true, tools, options: options(), session: { id: 'thread-1234567890', context: { percent: 41, tokens: 105000, window: 258000 } }, unavailable: outOfUsage },
      { id: 'a2', name: 'Claude', provider: 'claude', model: 'sonnet', role: '', enabled: true, tools, options: options({ effort: 'high' }), session: { id: 'abcdef12-3456-7890', context: { percent: 23, tokens: 46000, window: 200000 } } },
      { id: 'a3', name: 'Copilot', provider: 'copilot', model: '', role: '', enabled: true, tools, options: options({ copilotRuntime: 'auto' }) }
    ] },
  rooms: [{ id: 'preview', title: 'New conversation' }],
  connections: ['codex', 'claude', 'copilot', 'ollama'].map(id => ({ id, status: 'ready', detail: 'Preview fixture', ...(id === 'ollama' ? { runtime: 'http' } : { runtime: 'cli', version: '1.0.0' }),
    models: id === 'ollama' ? [{ id: 'glm-ocr:latest', name: 'glm-ocr:latest', capabilities: ['vision'] }, { id: 'embeddinggemma:latest', name: 'embeddinggemma:latest', capabilities: ['embedding'] }] : [{ id: 'test-large', name: 'Large model', reasoning: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'medium' }, { id: 'test-small', name: 'Small model' }] })),
  capabilities,
  editor: { path: 'C:\\ws\\chatroom\\README.md', relPath: 'README.md', label: 'README.md', kind: 'text', selection: { startLine: 10, endLine: 24, text: '## Install' }, openTabs: [], key: 'C:\\ws\\chatroom\\README.md#10-24' },
  sharedSkills: [
    { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces with high design quality.', path: '/skills/frontend-design/SKILL.md', dir: '/skills/frontend-design', source: 'claude-plugin', nativeTo: ['claude'] },
    { name: 'pdf', description: 'Read, merge and split PDF files.', path: '/skills/pdf/SKILL.md', dir: '/skills/pdf', source: 'agents-user', nativeTo: ['codex', 'copilot'] }],
  roomCommands,
  localModels: { vision: 'glm-ocr:latest', embedding: 'embeddinggemma:latest' },
  settings: { allowFullAccess: false, attachOpenFile: true, approvalTimeoutSeconds: 300, worktrees: 'off', worktreesAvailable: true, sandbox: { enabled: true, available: true, detail: 'Docker 29.5.3' } }
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
  // Resolves after the webview has handled the message: listeners run in order, and this one is added after the app's.
  const deliver = async data => page.evaluate(data => new Promise(resolve => { window.addEventListener('message', () => resolve(), { once: true }); window.postMessage(data, '*'); }), data);
  const outbox = () => page.evaluate(() => window.__outbox);
  const sent = async test => (await outbox()).filter(test);
  const lastSend = async () => (await sent(m => m.type === 'send')).at(-1);
  const prompt = page.locator('#prompt');
  await deliver(state);
  await page.getByText('Chat with your agents', { exact: true }).waitFor();
  await page.evaluate(() => { document.body.className = 'vscode-dark'; document.documentElement.style.setProperty('--vscode-sideBar-background', '#181818'); });
  await page.screenshot({ path: 'artifacts/preview-desktop.png' });

  // 1-3. Composer layout, team strip and glyphs.
  for (const id of ['chip-team', 'chip-loop', 'chip-perm', 'chip-effort', 'chip-think', 'chip-ultra', 'context-chips', 'send']) assert.equal(await page.locator(`#composer #${id}`).count(), 1, `#${id} in composer`);
  for (const id of ['target', 'mode', 'lead', 'preset', 'agents', 'agent-count']) assert.equal(await page.locator('#' + id).count(), 0, `#${id} removed`);
  assert.equal(await page.locator('.roster, [data-action="attach"]').count(), 0);
  assert.equal(await page.locator('#team-strip .agent-pill').count(), 3);
  assert.equal(await page.locator('#team-strip .agent-pill.is-lead').count(), 1);
  assert.equal(await page.locator('.agent-pill.is-lead').getAttribute('data-agent'), 'a1');
  assert.equal(await page.locator('.agent-pill[data-agent="a3"].status-setup').count(), 1, 'Signed-out Copilot shows setup state');
  assert.match(await page.locator('.agent-pill[data-agent="a2"] .pill-meta').textContent(), /Sonnet · High/);
  assert.ok(await page.locator('.agent-pill[data-agent="a3"] .avatar.copilot svg path').count() > 0, 'Copilot avatar is the octicon');
  assert.equal(await page.evaluate(() => /[⌥⌘✳◎]/.test(document.body.textContent)), false, 'No keyboard glyphs as avatars');
  assert.match(await page.locator('#chip-team').textContent(), /Parallel/);
  assert.match(await page.locator('#chip-loop').textContent(), /Once/); assert.equal(await page.locator('#chip-loop.muted').count(), 1);
  assert.match(await page.locator('#chip-perm').textContent(), /Ask/);
  assert.match(await page.locator('#chip-effort').textContent(), /Effort/);
  assert.equal(await page.locator('#context-ring').isVisible(), true);
  assert.match(await page.locator('#context-ring').getAttribute('title'), /Codex 41% · Claude 23%/);
  assert.match(await page.locator('.agent-pill[data-agent="a1"]').getAttribute('title'), /Ask \(sandbox read-only\)/, 'Codex pill shows the effective sandbox');
  // An agent out of usage is dimmed and skipped; its pill says when it is back.
  assert.equal(await page.locator('.agent-pill[data-agent="a1"].status-unavailable').count(), 1, 'Out-of-usage Codex is marked unavailable');
  assert.match(await page.locator('.agent-pill[data-agent="a1"] .pill-meta').textContent(), /^back (\w{3} )?\d\d:\d\d$/);
  assert.match(await page.locator('.agent-pill[data-agent="a1"]').getAttribute('title'), /Out of usage · back \w{3} \d\d:\d\d · lead · You have hit your usage limit\. Try again later\. · Skipped until then · click for settings$/);
  assert.equal(await page.locator('.agent-pill[data-agent="a1"] .pill-icon svg').count(), 1, 'A clock replaces the status dot');
  assert.equal(await page.locator('.agent-pill[data-agent="a1"] .pill-dot').count(), 0);
  assert.equal(await page.locator('.agent-pill.status-unavailable').count(), 1, 'Live status (signed-out Copilot) keeps the setup state');
  await page.locator('.agent-pill[data-agent="a2"]').focus();
  state.room.agentStates = { a2: { status: 'thinking' } }; await deliver(state);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.agent), 'a2', 'Pill keeps focus when the strip re-renders');
  state.room.agentStates = {}; await deliver(state);

  // 12. Agent settings dialog from a pill.
  await page.locator('.agent-pill[data-agent="a1"]').click();
  await page.locator('#agent-form').waitFor();
  assert.match(await page.locator('#dialog-layer .unavailable-banner').textContent(), /^Out of usage · back \w{3} \d\d:\d\d\. Chatroom skips Codex and continues with the others\.You have hit your usage limit/);
  await page.locator('.unavailable-banner').getByRole('button', { name: 'Try again now' }).click();
  assert.deepEqual((await sent(m => m.type === 'agentRetry')).at(-1), { type: 'agentRetry', id: 'a1' });
  delete state.room.agents[0].unavailable; await deliver(state);
  assert.equal(await page.locator('.unavailable-banner').count(), 0, 'The banner goes once the host clears the mark');
  assert.equal(await page.locator('.agent-pill[data-agent="a1"].status-unavailable').count(), 0);
  assert.equal(await page.locator('#agent-form').count(), 1, 'Try again keeps the dialog open');
  assert.deepEqual(await page.locator('#agent-effort option').allTextContents(), ['Default', 'Low', 'Medium', 'High', 'Extra high']);
  for (const id of ['agent-permission', 'agent-summary', 'agent-sandbox', 'agent-websearch', 'agent-use-mcp', 'agent-dirs', 'agent-role', 'agent-enabled']) assert.equal(await page.locator('#' + id).count(), 1, `#${id}`);
  assert.equal(await page.locator('#agent-thinking').count(), 0);
  assert.equal(await page.locator('#agent-permission option[value="full"]').evaluate(el => el.disabled), true, 'Full access needs the setting');
  assert.equal(await page.locator('#agent-use-skills').isDisabled(), true, 'Codex cannot switch native skills off');
  assert.equal(await page.locator('input[name="tool"]').count(), 0, 'Native agents have no Chatroom tool switches');
  assert.deepEqual(await page.locator('#agent-sandbox option').evaluateAll(list => list.map(o => o.value)), [''], 'Ask: no sandbox looser than read-only');
  await page.locator('#agent-model').selectOption('test-large');
  await page.locator('#agent-effort').selectOption('high');
  await page.locator('#agent-permission').selectOption('auto-edit');
  assert.deepEqual(await page.locator('#agent-sandbox option').evaluateAll(list => list.map(o => o.value)), ['', 'read-only'], 'Auto-edit: the sandbox can only tighten');
  await page.locator('#agent-role').fill('Review correctness and edge cases.');
  await page.getByRole('button', { name: 'Save agent' }).click();
  const edit = (await sent(m => m.type === 'agent' && m.id === 'a1')).at(-1);
  assert.equal(edit.role, 'Review correctness and edge cases.'); assert.equal(edit.model, 'test-large'); assert.equal(edit.enabled, true);
  assert.equal(edit.options.effort, 'high'); assert.equal(edit.options.permission, 'auto-edit'); assert.equal(edit.options.summary, 'auto'); assert.equal(edit.tools, undefined);
  assert.equal(edit.options.sandbox, '', '"From permissions" clears the sandbox override'); assert.equal(edit.options.webSearch, null, 'Default web search');
  await page.locator('.agent-pill[data-agent="a2"]').click();
  assert.equal(await page.locator('#agent-thinking').count(), 1); assert.equal(await page.locator('#agent-summary').count(), 0);
  assert.match(await page.locator('.session-line').textContent(), /Session abcdef12 · 23% context/);
  await page.locator('[data-make-lead="a2"]').click();
  assert.ok((await sent(m => m.type === 'options' && m.leadId === 'a2')).length, 'Make lead from the agent dialog');
  await page.locator('[data-session="copyResume"]').click();
  assert.ok((await sent(m => m.type === 'agentSession' && m.id === 'a2' && m.action === 'copyResume')).length);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#dialog-layer').isHidden(), true);
  await page.locator('.agent-pill[data-agent="a3"]').click();
  assert.ok((await sent(m => m.type === 'capabilities' && m.id === 'a3')).length, 'Stale caps are refreshed when the dialog opens');
  assert.equal(await page.locator('#agent-copilot-runtime').count(), 1);
  await page.keyboard.press('Escape');

  // Room setup: roster, lead and enable switches.
  await page.locator('[data-action="room-setup"]').click();
  await page.getByRole('heading', { name: 'Room setup' }).waitFor();
  assert.equal(await page.locator('.setup-agent').count(), 3);
  await page.locator('input[name="setup-lead"][value="a2"]').check();
  assert.ok((await sent(m => m.type === 'options' && m.leadId === 'a2')).length);
  await page.locator('[data-enable-agent="a3"]').uncheck();
  assert.ok((await sent(m => m.type === 'agent' && m.id === 'a3' && m.enabled === false)).length);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('[data-default-preset="drafting"][data-default-provider="codex"]').selectOption('test-small');
  await page.locator('#default-mode').selectOption('parallel');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  assert.ok((await sent(m => m.type === 'saveDefaults' && m.modelDefaults.drafting.codex === 'test-small' && m.executionMode === 'parallel')).length);

  // 8. Team popover: mode, lead, model routing.
  await page.locator('#chip-team').click();
  assert.equal(await page.locator('#popover').isVisible(), true);
  await page.locator('#popover input[name="mode"][value="orchestrated"]').check();
  assert.ok((await sent(m => m.type === 'options' && m.mode === 'orchestrated')).length);
  state.room.mode = 'orchestrated'; await deliver(state);
  await page.locator('#lead-select').selectOption('a2');
  assert.ok((await sent(m => m.type === 'options' && m.leadId === 'a2')).length >= 3);
  await page.locator('#preset-select').selectOption('drafting');
  assert.ok((await sent(m => m.type === 'options' && m.preset === 'drafting')).length);
  assert.match(await page.locator('#chip-team').textContent(), /Team · Codex leads/);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#popover').isHidden(), true);
  state.room.mode = 'parallel'; await deliver(state);
  await page.locator('#chip-team').click();
  assert.equal(await page.locator('#popover #lead-select').count(), 1, 'The lead can be chosen in every mode');
  await page.keyboard.press('Escape');

  // 9. Loop popover: every change applies at once; Done closes.
  await page.locator('#chip-loop').click();
  assert.match(await page.locator('#popover').textContent(), /Until Codex \(the lead\) ends with \[DONE\]/);
  await page.locator('#popover input[name="loop-kind"][value="consensus"]').check();
  await page.locator('#messages').click({ position: { x: 20, y: 20 } });
  assert.equal(await page.locator('#popover').isHidden(), true);
  assert.equal((await sent(m => m.type === 'options' && m.loop)).at(-1).loop.kind, 'consensus', 'A loop choice applies without Done');
  await page.locator('#chip-loop').click();
  await page.locator('#popover input[name="loop-kind"][value="rounds"]').check();
  assert.equal(await page.locator('#loop-rounds').isVisible(), true); assert.equal(await page.locator('#loop-every').isVisible(), false);
  assert.match(await page.locator('#popover').textContent(), /Caps always apply\. Stop ends any loop\./);
  await page.locator('#loop-rounds').fill('3');
  await page.locator('#loop-form button[type="submit"]').click();
  const loop = (await sent(m => m.type === 'options' && m.loop)).at(-1).loop;
  assert.equal(loop.kind, 'rounds'); assert.equal(loop.rounds, 3); assert.equal(await page.locator('#popover').isHidden(), true);

  // 10. Permission popover: Full needs the setting and a confirmation.
  await page.locator('#chip-perm').click();
  assert.equal(await page.locator('[data-perm="full"]').isDisabled(), true);
  await page.locator('[data-perm="ask"]').click();
  assert.ok((await sent(m => m.type === 'options' && m.permission === 'ask')).length);
  state.settings.allowFullAccess = true; await deliver(state);
  await page.locator('#chip-perm').click(); await page.locator('[data-perm="full"]').click();
  await page.getByText('Allow agents to edit files and run commands without asking?').waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await sent(m => m.type === 'options' && m.permission === 'full')).length, 0);
  await page.locator('#chip-perm').click(); await page.locator('[data-perm="full"]').click();
  await page.getByRole('button', { name: 'Allow full access' }).click();
  assert.equal((await sent(m => m.type === 'options' && m.permission === 'full')).length, 1);
  state.settings.allowFullAccess = false; await deliver(state);

  // Effort popover and the context ring.
  await page.locator('#chip-effort').click();
  assert.equal(await page.locator('[data-effort-agent="a3"]').count(), 0);
  await page.locator('[data-effort-agent="a2"]').selectOption('low');
  assert.ok((await sent(m => m.type === 'agent' && m.id === 'a2' && m.options?.effort === 'low')).length);
  await page.locator('[data-thinking-agent="a2"]').uncheck();
  assert.ok((await sent(m => m.type === 'agent' && m.id === 'a2' && m.options?.thinking === 'off')).length);
  await page.keyboard.press('Escape');
  await page.locator('#context-ring').click();
  await page.locator('#popover [data-compact="a2"]').click();
  assert.deepEqual(await lastSend(), { type: 'send', text: '@Claude /compact', editor: false, think: false, ultra: false });

  await page.locator('[data-action="add"]').first().click();
  await page.getByRole('button', { name: /Ollama Local/ }).click();
  assert.ok((await sent(m => m.type === 'addAgent' && m.provider === 'ollama')).length);
  await page.locator('.inspector-toggle').click();
  await page.locator('[data-tab="tools"]').click();
  await page.locator('#vision-model').selectOption('glm-ocr:latest');
  assert.ok((await sent(m => m.type === 'localModels' && m.vision === 'glm-ocr:latest')).length);
  await page.locator('[data-tab="usage"]').click();
  await page.locator('.inspector-close').click();

  // 6-7. Editor chip, think and ultra.
  assert.match(await page.locator('#editor-chip').textContent(), /README\.md/);
  assert.match(await page.locator('#editor-chip .ctx-range').textContent(), /L10–24/);
  assert.match(await page.locator('#editor-chip .ctx-open').getAttribute('title'), /click to open/);
  assert.match(await page.locator('#editor-chip .ctx-eye').getAttribute('title'), /^Shared with every message/);
  assert.match(await page.locator('#editor-chip .ctx-x').getAttribute('title'), /^Don't send README\.md/);
  await prompt.fill('Compare approaches'); await prompt.press('Enter');
  assert.deepEqual(await lastSend(), { type: 'send', text: 'Compare approaches', editor: true, think: false, ultra: false });
  assert.equal(await prompt.inputValue(), '');
  await page.locator('#editor-chip .ctx-eye').click();
  assert.ok((await sent(m => m.type === 'options' && m.attachEditor === false)).length);
  await page.locator('#editor-chip .ctx-open').click();
  assert.ok((await sent(m => m.type === 'editor' && m.action === 'reveal')).length);
  await page.locator('#editor-chip .ctx-x').click();
  assert.equal(await page.locator('#editor-chip').count(), 0);
  await page.locator('#chip-think').click(); assert.equal(await page.locator('#chip-think').getAttribute('aria-pressed'), 'true');
  await page.locator('#chip-ultra').click();
  await page.getByText(/Ultra lets each agent orchestrate its own sub-agents/).waitFor();
  await page.getByRole('button', { name: 'Turn on Ultra' }).click();
  assert.equal(await page.locator('#chip-ultra').getAttribute('aria-pressed'), 'true');
  await prompt.fill('Go deeper'); await prompt.press('Enter');
  assert.deepEqual(await lastSend(), { type: 'send', text: 'Go deeper', editor: false, think: true, ultra: true });
  assert.equal(await page.locator('#chip-think').getAttribute('aria-pressed'), 'false'); assert.equal(await page.locator('#chip-ultra').getAttribute('aria-pressed'), 'false');
  await page.locator('#chip-ultra').click();
  assert.equal(await page.locator('.confirm-layer').count(), 0, 'Ultra is confirmed once per room');
  assert.equal(await page.locator('#chip-ultra').getAttribute('aria-pressed'), 'true');
  await page.locator('#chip-ultra').click();

  // 4. Slash menu.
  await prompt.fill(''); await prompt.pressSequentially('/');
  await page.locator('#menu').waitFor();
  const groups = await page.locator('#menu .menu-group').allTextContents();
  assert.ok(groups.includes('Chatroom') && groups.includes('Claude · Claude Code') && groups.includes('Codex · Codex CLI'), groups.join(', '));
  assert.equal(await prompt.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: 'artifacts/preview-composer-menus.png' });
  await prompt.press('ArrowDown'); await prompt.press('Enter');
  assert.equal(await prompt.inputValue(), '/clear '); assert.equal(await page.locator('#menu').isHidden(), true);
  assert.equal((await sent(m => m.type === 'send')).length, 3, 'Enter in the menu never submits');
  await prompt.fill(''); await prompt.pressSequentially('/frontend'); await prompt.press('Enter');
  assert.equal(await prompt.inputValue(), '@Claude /frontend-design ');
  // A partial name selects a command whose name matches, never one that only matches its description (/clear: "Start fresh…").
  for (const [typed, want] of [['/st', '/status '], ['/sta', '/status '], ['/ex', '/export '], ['/pe', '/permissions '], ['/co', '/compact '], ['/re', '@Codex /review ']]) {
    await prompt.fill(''); await prompt.pressSequentially(typed); await prompt.press('Enter');
    assert.equal(await prompt.inputValue(), want, typed);
  }
  // The menu keeps its scroll position while state streams in.
  await prompt.fill(''); await prompt.pressSequentially('/');
  const scrolled = await page.evaluate(() => { const m = document.getElementById('menu'); m.scrollTop = m.scrollHeight; return m.scrollTop; });
  assert.ok(scrolled > 0, 'The menu scrolls');
  state.room.completedTurns = 1; await deliver(state); state.room.completedTurns = 0;
  assert.equal(await page.evaluate(() => document.getElementById('menu').scrollTop), scrolled, 'A broadcast keeps the menu scroll');
  assert.equal(await page.evaluate(() => document.getElementById('menu').scrollWidth <= document.getElementById('menu').clientWidth), true, 'No sideways scroll in the menu');
  // Long command lists are capped per agent, so later agents still show.
  const codexCommands = capabilities.a1.commands;
  capabilities.a1.commands = Array.from({ length: 70 }, (_, i) => ({ name: 'cmd-' + i, description: 'Command ' + i, source: 'builtin' }));
  await deliver(state); await prompt.fill(''); await prompt.pressSequentially('/');
  const capped = await page.locator('#menu .menu-group').allTextContents();
  assert.ok(capped.includes('Codex · Codex CLI · 12 of 70, type to filter') && capped.includes('Claude · Claude Code'), capped.join(', '));
  await prompt.pressSequentially('cmd-6'); assert.equal(await page.locator('#menu .menu-item').count(), 11, 'Typing searches the whole list');
  capabilities.a1.commands = codexCommands; await deliver(state);
  await prompt.fill(''); await prompt.pressSequentially('@Codex /');
  const scoped = await page.locator('#menu .menu-group').allTextContents();
  assert.deepEqual(scoped, ['Chatroom', 'Codex · Codex CLI']);
  assert.doesNotMatch(await page.locator('#menu').textContent(), /\/help/);
  await prompt.press('Escape'); assert.equal(await page.locator('#menu').isHidden(), true);
  // 5. Mention menu.
  await prompt.fill(''); await prompt.pressSequentially('@Co');
  const names = await page.locator('#menu .menu-item .menu-name').allTextContents();
  assert.ok(names.includes('Codex') && names.includes('Copilot') && !names.includes('Claude'), names.join(', '));
  await prompt.press('Enter'); assert.equal(await prompt.inputValue(), '@Codex ');
  await prompt.fill('');
  await page.locator('#open-slash').click(); assert.equal(await prompt.inputValue(), '/'); assert.equal(await page.locator('#menu').isVisible(), true);
  await prompt.press('Escape'); await prompt.fill('');

  // 11, 13, 16. A running room: streaming blocks, approvals, hand-offs, notices, Stop.
  Object.assign(state.room, { status: 'running', currentAgent: 'a1', activeAgents: ['a1', 'a2'], queuedTurns: 1, agentStates: { a1: { status: 'thinking' }, a2: { status: 'approval', detail: 'npm test' } } });
  state.room.messages = [
    { id: 'u', kind: 'user', text: '@Claude Compare approaches', author: 'You', status: 'complete', createdAt: now, targets: ['a2'], editor: state.editor, flags: { think: true } },
    { id: 'm', kind: 'agent', agentId: 'a1', author: 'Codex', text: '**Start with a bounded queue.**\n\nKeep cancellation and provider adapters separate.\n\n```ts\nconst room = new RoomEngine(options);\nawait room.start(prompt);\n```\n\n<img src=x onerror="window.HACKED=true">', status: 'streaming', createdAt: now },
    { id: 'h', kind: 'agent', agentId: 'a1', author: 'Codex', text: '@Claude can you check the failing test?', status: 'complete', handoff: { from: 'a1', to: ['a2'] }, createdAt: now },
    { id: 'm2', kind: 'agent', agentId: 'a2', author: 'Claude', turn: 'handoff', handoff: { from: 'a1', to: ['a2'] }, text: 'Checking the scheduler.', status: 'streaming', createdAt: now, thinking: 'Let me look at <b>the scheduler</b> first.',
      activity: [{ id: 't1', kind: 'read', title: 'Read', detail: 'src/engine.ts', status: 'done', at: now }, { id: 't2', kind: 'edit', title: 'Edit', detail: 'src/engine.ts', diff: '--- a/src/engine.ts\n+++ b/src/engine.ts\n@@ -1 +1 @@\n-const retries = Infinity;\n+const retries = 2;', status: 'running', at: now }] },
    { id: 'ap', kind: 'approval', agentId: 'a2', author: 'Claude', text: 'npm test', status: 'complete', createdAt: now,
      approval: { id: 'appr-1', agentId: 'a2', provider: 'claude', kind: 'command', tool: 'Bash', title: 'npm test', detail: 'Run the unit tests <script>window.HACKED=true</script>', canAllowSession: true, status: 'pending', createdAt: now, expiresAt: now + 300000 } },
    { id: 'ap0', kind: 'approval', agentId: 'a1', author: 'Codex', text: 'apply_patch', status: 'complete', createdAt: now,
      approval: { id: 'appr-0', agentId: 'a1', provider: 'codex', kind: 'edit', tool: 'apply_patch', title: 'src/a.ts', diff: '+one', canAllowSession: true, status: 'allowed', createdAt: now, expiresAt: now, decidedAt: now } },
    { id: 'n', kind: 'notice', author: 'Chatroom', text: 'Sign in to the GitHub Copilot CLI: run "copilot login" in a terminal, then try again.', status: 'complete', createdAt: now }];
  await deliver(state);
  await page.locator('.message.agent').first().waitFor();
  assert.equal(await page.locator('#send').getAttribute('aria-label'), 'Stop');
  assert.equal(await page.evaluate(() => window.HACKED), undefined);
  assert.equal(await page.locator('.message-content img, .approval-card script, .thinking-text b').count(), 0);
  assert.match(await page.locator('#runtime-status').textContent(), /Parallel \(max 2\) · 2 running · 1 queued/);
  assert.equal(await page.locator('.thinking-block').count(), 1); assert.equal(await page.locator('.thinking-block[open]').count(), 1);
  assert.equal(await page.locator('.activity-block').count(), 1); assert.equal(await page.locator('.act').count(), 2);
  assert.equal(await page.locator('.act-diff .add').count(), 1); assert.equal(await page.locator('.act-diff .del').count(), 1);
  assert.match(await page.locator('.activity-block summary').textContent(), /2 steps · Edit/);
  assert.match(await page.locator('.message[data-id="h"] .handoff-chip').textContent(), /→ @Claude/);
  assert.match(await page.locator('.message.user .ctx-chip').textContent(), /README\.md/);
  assert.match(await page.locator('.message.user .msg-targets').textContent(), /to @Claude/);
  assert.equal(await page.locator('.agent-pill[data-agent="a2"].status-approval').count(), 1);
  const card = page.locator('.message.approval.pending');
  assert.deepEqual(await card.locator('.approval-actions button').allTextContents(), ['Allow', 'Allow for session', 'Deny']);
  assert.match(await card.locator('.approval-head').textContent(), /Claude wants to run a command/);
  assert.match(await card.locator('.approval-expiry').textContent(), /^0[45]:\d\d left$/);
  assert.match(await page.locator('.message.approval.allowed .approval-result').textContent(), /^Allowed · /);
  assert.match(await page.locator('#run-controls').textContent(), /1 waiting for you/);
  await page.locator('.notice-line [data-copilot="login"]').click();
  assert.ok((await sent(m => m.type === 'copilot' && m.action === 'login')).length);
  await card.locator('[data-decision="allow"]').click();
  assert.ok((await sent(m => m.type === 'approval' && m.id === 'appr-1' && m.decision === 'allow')).length);
  assert.equal(await card.locator('[data-decision="deny"]').isDisabled(), true, 'Buttons disable optimistically');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt', 'Focus moves on after a decision');
  await page.locator('.thinking-block summary').click();
  state.room.messages[3].text += ' More.'; await deliver(state);
  assert.equal(await page.locator('.thinking-block[open]').count(), 0, 'A collapsed block stays collapsed while streaming');
  await prompt.fill('Another idea'); await prompt.press('Enter');
  assert.equal(await page.locator('#toast').textContent(), 'Agents are working. Wait or press Stop.'); assert.equal(await prompt.inputValue(), 'Another idea');
  await prompt.fill('@Claude /status'); await prompt.press('Enter');
  assert.equal(await prompt.inputValue(), '@Claude /status ', 'Enter in the menu completes the command');
  await prompt.press('Enter');
  assert.equal((await lastSend()).text, '@Claude /status', 'Commands still go through while agents work');
  const stops = (await sent(m => m.type === 'stop')).length;
  await page.locator('#send').click();
  assert.equal((await sent(m => m.type === 'stop')).length, stops + 1);
  await page.locator('#run-controls [data-action="stop"]').focus();
  state.room.activeAgents = ['a1']; await deliver(state);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'stop', 'Stop keeps focus when run controls re-render');
  state.room.activeAgents = ['a1', 'a2']; await deliver(state);
  await page.locator('#run-controls').getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('#run-controls').getByRole('button', { name: 'Stop', exact: true }).click();
  assert.ok((await sent(m => m.type === 'pause')).length && (await sent(m => m.type === 'stop')).length === stops + 2);
  await prompt.fill('');
  await page.screenshot({ path: 'artifacts/preview-conversation.png' });

  // Team mode: a live plan with parallel and dependent steps, step messages, and attached documents.
  const steps = [
    { id: 's1', agentId: 'a2', task: 'Read src/engine.ts and list the failure modes of the scheduler.', after: [], status: 'complete' },
    { id: 's2', agentId: 'a3', task: 'Check the spec PDF for the required retry behaviour.', after: [], status: 'running' },
    { id: 's3', agentId: 'a1', task: 'Propose a fix that covers the risks from s1 and the requirements from s2.', after: ['s1', 's2'], status: 'pending' }];
  Object.assign(state.room, { mode: 'orchestrated', leadId: 'a1', status: 'running', activeAgents: ['a3'], currentAgent: 'a3', queuedTurns: 1, completedTurns: 2, agentStates: { a3: { status: 'thinking' } },
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
  assert.equal(await page.locator('.agent-pill.is-lead').count(), 1); assert.equal(await page.locator('.agent-pill.is-lead').getAttribute('data-agent'), 'a1');
  assert.match(await page.locator('#chip-team').textContent(), /Team · Codex leads/);
  assert.match(await page.locator('#runtime-status').textContent(), /Lead \+ team/);
  assert.match(await page.locator('#documents').textContent(), /retry-spec\.pdf.*6 p\. · 2 OCR · indexed/);
  assert.match(await page.locator('.message.user').textContent(), /\[CONSENSUS\]/, 'User text is never rewritten');
  await page.screenshot({ path: 'artifacts/preview-team.png' });
  state.room.status = 'idle'; state.room.activeAgents = []; state.room.queuedTurns = 0; state.room.agentStates = {}; steps.forEach(s => s.status = 'complete');
  state.room.messages.push({ id: 's3m', kind: 'agent', agentId: 'a1', author: 'Codex', turn: 'step', step: { id: 's3', plan: 'p', task: steps[2].task, after: ['s1', 's2'] }, text: 'Wrap each provider call in a deadline. Agreed with Claude. [CONSENSUS]', status: 'complete', createdAt: now },
    { id: 'f', kind: 'agent', agentId: 'a1', author: 'Codex', turn: 'synthesis', text: '**Final plan.** Bounded retries, per-step deadlines, and a skipped state for dependents. [DONE]', marker: 'done', status: 'complete', createdAt: now });
  state.room.messages[3].status = 'complete'; state.room.messages[3].text = 'The spec requires at most 2 retries with backoff. [AGREE]'; state.room.messages[3].marker = 'agree';
  await deliver(state);
  await page.locator('.turn-chip.synthesis').waitFor();
  assert.match(await page.locator('.message.turn-step').last().textContent(), /builds on Claude \(s1\), Copilot \(s2\)/);
  assert.match(await page.locator('.message.turn-step').last().textContent(), /agrees · nothing to add/);
  assert.doesNotMatch(await page.locator('.message.turn-step').last().locator('.message-content').textContent(), /CONSENSUS/);
  assert.doesNotMatch(await page.locator('.message[data-id="s2m"] .message-content').textContent(), /AGREE/);
  assert.match(await page.locator('.message[data-id="f"] .message-footer').textContent(), /marked done/);
  assert.doesNotMatch(await page.locator('.message[data-id="f"] .message-content').textContent(), /DONE/);
  await page.locator('[data-remove-doc="d2"]').first().click();
  assert.ok((await sent(m => m.type === 'removeDocument' && m.id === 'd2')).length);
  await page.locator('[data-action="attachDocuments"]').first().click();
  assert.ok((await sent(m => m.type === 'attachDocuments')).length);
  await page.screenshot({ path: 'artifacts/preview-team-done.png' });

  // 14. Tools tab.
  await page.locator('.inspector-toggle').click(); await page.locator('[data-tab="tools"]').click();
  assert.equal(await page.locator('.caps-card').count(), 3); assert.equal(await page.locator('#share-skills').count(), 1);
  assert.equal(await page.locator('.tool-row').count(), 4); assert.equal(await page.locator('.doc-row').count(), 2);
  assert.equal(await page.locator('.skill-row').count(), 2);
  assert.match(await page.locator('.caps-card').nth(1).textContent(), /Tools \(8\).*Skills \(1\).*MCP servers \(2\).*Commands \(3\)/);
  assert.equal(await page.locator('.caps-card [data-copilot="login"]').count(), 1);
  await page.locator('#share-skills').click();
  assert.ok((await sent(m => m.type === 'options' && m.shareSkills === false)).length);
  await page.screenshot({ path: 'artifacts/preview-tools.png' });
  state.room.usage = { a1: { input: 52500, output: 300, cached: 37600, cacheWrite: 0, requests: 3, estimated: false } }; state.room.tokenBudget = 0; state.room.runStartTokens = 0;
  await deliver(state); await page.locator('[data-tab="usage"]').click();
  assert.equal(await page.locator('#budget').inputValue(), '0'); assert.equal(await page.locator('.budget-progress').count(), 0);
  assert.equal(await page.locator('#rounds').count(), 0);
  assert.match(await page.locator('.inspector-section').first().textContent(), /15\.2K new.*37\.6K cached re-reads/);
  assert.match(await page.locator('.usage-agent').first().textContent(), /Context 41% of 258K/);
  await page.locator('#budget').selectOption('100000');
  assert.ok((await sent(m => m.type === 'options' && m.tokenBudget === 100000)).length);
  state.room.tokenBudget = 100000; await deliver(state);
  await page.locator('.budget-progress').waitFor();
  await page.screenshot({ path: 'artifacts/preview-usage.png' });
  state.room.usage = {}; state.room.tokenBudget = 0;
  await page.locator('.inspector-close').click();

  // Availability in the Tools tab: a model that is not available.
  state.room.agents[1].unavailable = { reason: 'model', model: 'sonnet', detail: 'Model "sonnet" was not found.', at: now };
  await deliver(state);
  assert.equal(await page.locator('.agent-pill[data-agent="a2"] .pill-meta').textContent(), 'no model');
  await page.locator('.inspector-toggle').click(); await page.locator('[data-tab="tools"]').click();
  const claudeCard = page.locator('.caps-card').nth(1);
  assert.match(await claudeCard.locator('.unavail-line').textContent(), /^Model sonnet unavailable\. Chatroom skips Claude and continues with the others\. Choose another model in its settings\./);
  await claudeCard.getByRole('button', { name: 'Try again now' }).click();
  assert.deepEqual((await sent(m => m.type === 'agentRetry')).at(-1), { type: 'agentRetry', id: 'a2' });
  await page.locator('[data-tab="usage"]').click(); await page.locator('.inspector-close').click();
  delete state.room.agents[1].unavailable;

  // Custom team: the chip, stage chips on messages and the progress footer.
  const plainTeam = ({ builtIn, ...team }) => structuredClone(team);
  Object.assign(state.room, { mode: 'pipeline', team: plainTeam(teams[0]), status: 'running', activeAgents: ['a1'], currentAgent: 'a1', queuedTurns: 0, progress: { stage: 2, total: 3, name: 'Drafting' }, agentStates: { a1: { status: 'thinking' } }, documents: [],
    messages: [
      { id: 'u3', kind: 'user', text: 'Add a CSV export to the report page.', author: 'You', status: 'complete', createdAt: now },
      { id: 'st1', kind: 'agent', agentId: 'a2', author: 'Claude', turn: 'stage', stage: { index: 0, total: 3, name: 'Leads', lead: true }, text: 'Codex drafts the exporter in src/report.ts; the review checks quoting and large files.', status: 'complete', createdAt: now },
      { id: 'st2', kind: 'agent', agentId: 'a1', author: 'Codex', turn: 'stage', stage: { index: 1, total: 3, name: 'Drafting' }, text: '', status: 'streaming', createdAt: now }] });
  await deliver(state);
  await page.locator('.message[data-id="st1"]').waitFor();
  assert.equal(await page.locator('#chip-team .chip-label').textContent(), 'Team · Lead, draft, review');
  assert.match(await page.locator('#chip-team').getAttribute('title'), /Leads \(Claude\) → Drafting \(Codex\) → Review \(Claude, Copilot\)/);
  assert.match(await page.locator('#runtime-status').textContent(), /^Custom team · stage 2\/3: Drafting · 1 running/);
  assert.equal(await page.locator('.message[data-id="st1"] .turn-chip.stage.lead').textContent(), 'Leads · 1/3');
  assert.equal(await page.locator('.message[data-id="st2"] .turn-chip.stage:not(.lead)').textContent(), 'Drafting · 2/3');
  await page.screenshot({ path: 'artifacts/preview-custom-team.png' });
  Object.assign(state.room, { status: 'idle', activeAgents: [], currentAgent: undefined, progress: undefined, agentStates: {} });
  state.room.messages[2] = { ...state.room.messages[2], text: 'Added exportCsv() with RFC 4180 quoting.', status: 'complete' };
  await deliver(state);
  assert.match(await page.locator('#runtime-status').textContent(), /^Custom team · Lead, draft, review · 0 running/);

  // Team popover: Custom team in the mode list, and the team select.
  await page.locator('#chip-team').click();
  assert.equal(await page.locator('#popover input[name="mode"][value="pipeline"]').isChecked(), true);
  assert.deepEqual(await page.locator('#team-select option').allTextContents(), ['Lead, draft, review · template', 'Build and test · template', 'Draft and review · template']);
  assert.equal(await page.locator('#popover .team-plan').textContent(), 'Leads (Claude) → Drafting (Codex) → Review (Claude, Copilot)');
  await page.locator('#team-select').selectOption({ label: 'Build and test · template' });
  const chosen = (await sent(m => m.type === 'team')).at(-1).team;
  assert.equal(chosen.name, 'Build and test'); assert.equal('builtIn' in chosen, false, 'Templates are sent without builtIn');
  assert.deepEqual(chosen.stages.map(s => s.name), ['Leads', 'Coding', 'Testing', 'Review']);

  // Team builder: Edit team… opens the room's team.
  await page.locator('#popover').getByRole('button', { name: 'Edit team…' }).click();
  await page.getByRole('heading', { name: 'Your team' }).waitFor();
  assert.equal(await page.locator('#popover').isHidden(), true);
  assert.equal(await page.locator('#team-name').inputValue(), 'Lead, draft, review');
  assert.equal(await page.locator('#team-from').inputValue(), 'Lead, draft, review');
  assert.equal(await page.locator('.stage-card').count(), 3);
  assert.deepEqual(await page.locator('.stage-card').nth(2).locator('.agent-toggle[aria-pressed="true"]').allTextContents(), ['Claude', 'Copilot']);
  assert.equal(await page.locator('#ts-0-lead').isChecked(), true); assert.equal(await page.locator('#team-wrapup').isChecked(), true);
  assert.equal(await page.locator('#ts-2-run').count(), 1, 'Run shows for a stage with two agents'); assert.equal(await page.locator('#ts-1-run').count(), 0);
  assert.equal(await page.locator('#ts-1-preset').inputValue(), 'drafting');
  assert.equal(await page.locator('#team-delete').count(), 0, 'Templates have no Delete');
  // A broadcast while typing keeps the field, its value and the caret.
  await page.locator('#team-name').fill('My review team'); await page.locator('#team-name').press('Home');
  await deliver(state);
  assert.equal(await page.evaluate(() => [document.activeElement.id, document.activeElement.value, document.activeElement.selectionStart].join('|')), 'team-name|My review team|0');
  // A new stage needs an agent before the team can be used.
  await page.getByRole('button', { name: 'Add stage' }).click();
  assert.equal(await page.locator('.stage-card').count(), 4);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ts-3-name', 'Focus moves to the new stage');
  await page.keyboard.type('Testing');
  const teamsSent = (await sent(m => m.type === 'team')).length;
  await page.getByRole('button', { name: 'Use in this room' }).click();
  assert.match(await page.locator('#team-error').textContent(), /^Stage 4 \(Testing\) needs at least one agent/);
  assert.equal(await page.locator('.stage-card.invalid').count(), 1);
  assert.equal((await sent(m => m.type === 'team')).length, teamsSent, 'An invalid team is not sent');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ts-3-a-a1', 'Focus moves to the stage that needs an agent');
  await page.locator('#ts-3-a-a3').click();
  assert.equal(await page.locator('#ts-3-a-a3').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ts-3-a-a3', 'Toggling keeps focus');
  assert.equal(await page.locator('#team-error').count(), 0, 'The error clears once fixed');
  await page.locator('#ts-3-task').fill('Write and run the tests');
  await page.locator('#ts-3-up').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ts-2-up', 'Focus follows the moved stage');
  assert.equal(await page.locator('#ts-2-name').inputValue(), 'Testing');
  await page.locator('#ts-1-preset').selectOption('');
  await page.getByRole('button', { name: 'Save to my teams' }).click();
  const savedTeam = (await sent(m => m.type === 'saveTeam')).at(-1).team;
  assert.deepEqual(savedTeam, { name: 'My review team', wrapUp: true, stages: [
    { name: 'Leads', agents: ['Claude'], run: 'parallel', lead: true },
    { name: 'Drafting', agents: ['Codex'], run: 'parallel', lead: false },
    { name: 'Testing', agents: ['Copilot'], run: 'parallel', lead: false, task: 'Write and run the tests' },
    { name: 'Review', agents: ['Claude', 'Copilot'], run: 'parallel', lead: false, preset: 'review' }] }, 'Stages carry agent names');
  assert.equal(await page.locator('#dialog-layer').isVisible(), true, 'Saving keeps the builder open');
  await page.getByRole('button', { name: 'Use in this room' }).click();
  assert.deepEqual((await sent(m => m.type === 'team')).at(-1), { type: 'team', team: savedTeam });
  assert.equal(await page.locator('#dialog-layer').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'chip-team', 'Focus returns to the Team chip');
  state.teams = [structuredClone(savedTeam), ...teams]; state.room.team = structuredClone(savedTeam); await deliver(state);
  assert.equal(await page.locator('#chip-team .chip-label').textContent(), 'Team · My review team');

  // Models and defaults: saved teams with Edit and Delete; Custom team as a default.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.deepEqual(await page.locator('#default-mode option').allTextContents(), ['Lead + team', 'Relay', 'Parallel', 'Custom team']);
  assert.equal(await page.locator('#defaults-teams .team-row').count(), 1);
  assert.match(await page.locator('#defaults-teams .team-row').textContent(), /My review team.*Leads \(Claude\) → Drafting \(Codex\) → Testing \(Copilot\) → Review \(Claude, Copilot\)/);
  await page.getByRole('button', { name: 'Edit My review team' }).click();
  await page.getByRole('heading', { name: 'Your team' }).waitFor();
  assert.equal(await page.locator('#team-delete').count(), 1, 'A saved team can be deleted from the builder');
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Models and defaults' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Edit My review team', 'Closing the builder returns to the defaults');
  await page.getByRole('button', { name: 'Delete My review team' }).click();
  await page.getByRole('button', { name: 'Delete team' }).click();
  assert.deepEqual((await sent(m => m.type === 'deleteTeam')).at(-1), { type: 'deleteTeam', name: 'My review team' });
  state.teams = teams; await deliver(state);
  assert.equal(await page.locator('#defaults-teams .team-row').count(), 0, 'The list updates in place');
  await page.keyboard.press('Escape');

  // Room setup: choosing Custom team without a team opens the builder instead of switching.
  delete state.room.team; state.room.mode = 'orchestrated'; await deliver(state);
  await page.locator('[data-action="room-setup"]').click();
  await page.getByRole('heading', { name: 'Room setup' }).waitFor();
  assert.equal(await page.locator('#dialog-layer').getByRole('button', { name: 'Edit team…' }).count(), 1);
  const pipelineOptions = (await sent(m => m.type === 'options' && m.mode === 'pipeline')).length;
  await page.locator('input[name="setup-mode"][value="pipeline"]').click();
  await page.getByRole('heading', { name: 'Your team' }).waitFor();
  assert.equal((await sent(m => m.type === 'options' && m.mode === 'pipeline')).length, pipelineOptions, 'No mode change without a team');
  assert.equal(await page.locator('#team-name').inputValue(), 'Lead, draft, review', 'It starts from the first template');
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Room setup' }).waitFor();
  assert.equal(await page.locator('input[name="setup-mode"][value="orchestrated"]').isChecked(), true);
  await page.keyboard.press('Escape');

  // The host's openTeam message (/team edit), and New team… from the popover.
  await deliver({ type: 'openTeam' });
  await page.getByRole('heading', { name: 'Your team' }).waitFor();
  assert.equal(await page.locator('.stage-card').count(), 3);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#dialog-layer').isHidden(), true);
  await page.locator('#chip-team').click();
  await page.locator('#popover').getByRole('button', { name: 'New team…' }).click();
  assert.equal(await page.locator('#team-name').inputValue(), '');
  assert.equal(await page.locator('.stage-card').count(), 1);
  assert.equal(await page.locator('.stage-card .agent-toggle[aria-pressed="true"]').count(), 0);
  assert.equal(await page.locator('#team-wrapup').isDisabled(), true, 'The wrap-up needs a lead stage');
  await page.locator('#ts-0-lead').click();
  assert.equal(await page.locator('#ts-0-lead').isChecked(), true); assert.equal(await page.locator('#team-wrapup').isDisabled(), false);
  await page.keyboard.press('Escape');

  // /team in the slash menu.
  await prompt.fill(''); await prompt.pressSequentially('/tea');
  assert.ok((await page.locator('#menu .menu-name').allTextContents()).includes('/team'));
  await prompt.press('Escape'); await prompt.fill('');

  // Worktrees: the pill, the changes card and its buttons, the Worktrees select, the agent's own-worktree switch, the Tools section and /worktrees.
  const lastWorktree = async () => (await sent(m => m.type === 'worktree')).at(-1);
  const releaseCard = async () => { await deliver({ type: 'notice', text: 'Done.' }); await page.evaluate(() => { document.getElementById('toast').hidden = true; }); };
  Object.assign(state.room.agents[1], { isolate: true, worktree: { path: 'C:\\storage\\wt\\3f2a1c\\previe-claude', branch: 'chatroom/previe/claude', createdAt: now, checkpoints: 2 } });
  const changedFiles = Array.from({ length: 11 }, (_, i) => ({ path: i ? `src/report/export-part-${i}.ts` : 'src/report/<b>csv</b>.ts', added: 6, removed: i % 2, status: i ? 'M' : 'A' }));
  const changes = { base: '4f1c2d3e5a6b7c8d9e0f11223344556677889900', branch: 'chatroom/previe/integration', path: 'C:\\storage\\wt\\3f2a1c\\previe-integration', files: changedFiles, added: 66, removed: 5, status: 'ready', updatedAt: now };
  const cardMessage = (id, extra = {}) => ({ id, kind: 'notice', author: 'Chatroom', text: 'Agents changed 11 file(s) in their worktrees (+66 −5). Review them, then apply them to your folder or keep them as a branch.', status: 'complete', createdAt: now, changes: { ...structuredClone(changes), ...extra } });
  Object.assign(state.room, { mode: 'parallel', changes: structuredClone(changes), messages: [
    { id: 'u4', kind: 'user', text: 'Add a CSV export, with tests.', author: 'You', status: 'complete', createdAt: now },
    { id: 'r4', kind: 'agent', agentId: 'a2', author: 'Claude', text: 'Added exportCsv() and its tests.', status: 'complete', createdAt: now },
    cardMessage('wt1')] });
  await deliver(state);
  assert.equal(await page.locator('.agent-pill[data-agent="a2"] .pill-branch svg').count(), 1, 'An isolated agent\'s pill shows a branch');
  assert.equal(await page.locator('.agent-pill[data-agent="a1"] .pill-branch, .agent-pill[data-agent="a3"] .pill-branch').count(), 0);
  assert.match(await page.locator('.agent-pill[data-agent="a2"]').getAttribute('title'), / · own worktree · chatroom\/previe\/claude · click for settings$/);
  assert.equal(await page.locator('.agent-pill[data-agent="a2"]').getAttribute('aria-label'), 'Claude settings, own worktree');
  const wcard = page.locator('.changes-card');
  assert.equal(await wcard.count(), 1); assert.equal(await page.locator('.notice-line[data-id="wt1"]').count(), 0, 'A card, not a notice line');
  assert.equal(await wcard.locator('.changes-head').textContent(), 'Changes from the agentsReady');
  assert.equal(await wcard.locator('.changes-totals').textContent(), '11 files · +66 −5');
  assert.equal(await wcard.locator('.cf:visible').count(), 8, 'The first 8 files');
  assert.equal(await wcard.locator('.cf').first().textContent(), 'AAdded: src/report/<b>csv</b>.ts+6 −0', 'File paths are escaped');
  assert.equal(await wcard.locator('.cf b').count(), 0);
  await wcard.getByRole('button', { name: '+3 more' }).click();
  assert.equal(await wcard.locator('.cf:visible').count(), 11);
  assert.equal(await wcard.locator('[data-changes-more]').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Show fewer', 'The toggle keeps focus');
  await wcard.locator('.changes-files summary').click();
  assert.equal(await wcard.locator('.cf:visible').count(), 0, 'The file list collapses');
  await wcard.locator('.changes-files summary').click();
  assert.deepEqual(await wcard.locator('.changes-actions button').allTextContents(), ['Review diff', 'Apply to my folder', 'Keep as branch…', 'Discard']);
  await wcard.getByRole('button', { name: 'Review diff' }).click();
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'review' });
  await wcard.getByRole('button', { name: 'Apply to my folder' }).click();
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'apply' });
  assert.equal(await wcard.getByRole('button', { name: 'Discard' }).isDisabled(), true, 'The buttons wait for the host');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.id), 'wt1', 'Focus stays on the card');
  await releaseCard();
  assert.equal(await wcard.getByRole('button', { name: 'Discard' }).isDisabled(), false, 'A toast from the host releases them');
  // Keep as branch: an inline, optional name. A rebuilt card keeps the typed name, the focus and the caret.
  await wcard.getByRole('button', { name: 'Keep as branch…' }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keep-name', 'The name field opens with focus');
  assert.equal(await wcard.getByRole('button', { name: 'Keep as branch…' }).getAttribute('aria-expanded'), 'true');
  await page.keyboard.type('csv export');
  state.room.messages[2].changes.updatedAt = now + 1; await deliver(state);
  assert.equal(await page.evaluate(() => [document.activeElement.id, document.activeElement.value, document.activeElement.selectionStart].join('|')), 'keep-name|csv export|10');
  for (const width of [300, 360]) {
    await page.setViewportSize({ width, height: 900 }); await deliver(state);
    assert.ok(await page.evaluate(() => { const c = document.querySelector('.changes-card'), box = c.getBoundingClientRect(); return document.documentElement.scrollWidth <= window.innerWidth && c.scrollWidth <= c.clientWidth
      && [...c.querySelectorAll('button, input')].every(el => { const r = el.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right + 0.5; }); }), `The changes card fits at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#keep-name').press('Enter');
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'keep', name: 'csv export' });
  assert.equal(await page.locator('#keep-form').count(), 0);
  await releaseCard();
  await wcard.getByRole('button', { name: 'Keep as branch…' }).click();
  assert.equal(await page.locator('#keep-name').inputValue(), '', 'The form starts empty');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#keep-form').count(), 0, 'Escape closes the form');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.worktree), 'keep');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keep-name');
  await wcard.getByRole('button', { name: 'Keep', exact: true }).click();
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'keep' }, 'No name: the host picks one');
  await releaseCard();
  // Discard asks first.
  await wcard.getByRole('button', { name: 'Discard' }).click();
  await page.getByText(/^Discard the agents' changes\? Their worktrees and branches are deleted\./).waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await sent(m => m.type === 'worktree' && m.action === 'discard')).length, 0);
  await wcard.getByRole('button', { name: 'Discard' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'discard' });
  // A conflict updates the same card: Apply is disabled and the conflict is named.
  Object.assign(state.room.messages[2].changes, { status: 'conflict', conflicts: [{ agentId: 'a1', files: ['src/report/export-part-1.ts', 'src/report/export-part-2.ts'] }] });
  await deliver(state);
  assert.equal(await wcard.count(), 1, 'The card updates in place');
  assert.equal(await page.locator('#messages > *').nth(2).getAttribute('data-id'), 'wt1');
  assert.equal(await wcard.locator('.changes-chip').textContent(), 'Conflict');
  assert.equal(await wcard.getByRole('button', { name: 'Apply to my folder' }).isDisabled(), true, 'No Apply while the changes conflict');
  assert.equal(await wcard.getByRole('button', { name: 'Review diff' }).isDisabled(), false);
  assert.equal(await wcard.locator('.changes-conflict').textContent(), 'Couldn\'t combine Codex\'s changes in src/report/export-part-1.ts, src/report/export-part-2.ts');
  assert.equal(await wcard.locator('.cf:visible').count(), 11, 'Show more stays open across updates');
  await wcard.getByRole('button', { name: 'Keep as branch…' }).click(); await page.keyboard.press('Enter');
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'keep' }, 'A conflict can still be kept as a branch');
  // Only the latest card has buttons; final states have none.
  state.room.messages.push(cardMessage('wt2'));
  await deliver(state);
  assert.equal(await wcard.count(), 2);
  assert.equal(await wcard.first().locator('.changes-actions').count(), 0); assert.match(await wcard.first().textContent(), /A newer update is below\./);
  assert.equal(await wcard.last().locator('.changes-actions button').count(), 4);
  for (const [status, chip, extra] of [['applied', 'Applied'], ['kept', 'Kept as chatroom/kept/csv-export', { kept: 'chatroom/kept/csv-export' }], ['discarded', 'Discarded']]) {
    Object.assign(state.room.messages[3].changes, { status, ...extra }); await deliver(state);
    assert.equal(await wcard.last().locator('.changes-chip').textContent(), chip);
    assert.equal(await wcard.last().locator('button[data-worktree]').count(), 0, `No buttons once ${status}`);
  }
  // No card while nothing changed.
  state.room.messages = [state.room.messages[0], cardMessage('wt3', { files: [], added: 0, removed: 0 })];
  await deliver(state);
  assert.equal(await wcard.count(), 0, 'No card without files');
  // The Worktrees select in the Team popover and in Room setup.
  await page.locator('#chip-team').click();
  assert.deepEqual(await page.locator('#worktrees-select option').allTextContents(), ['Off — agents share the folder', 'Auto — isolate agents that edit without asking when others could edit too', 'Always — every agent that edits gets its own worktree']);
  assert.equal(await page.locator('#worktrees-select').inputValue(), 'off', 'The setting applies until the room has its own');
  await page.locator('#worktrees-select').selectOption('auto');
  assert.deepEqual((await sent(m => m.type === 'options' && 'worktrees' in m)).at(-1), { type: 'options', worktrees: 'auto' });
  await page.keyboard.press('Escape');
  state.room.worktrees = 'auto'; await deliver(state);
  await page.locator('[data-action="room-setup"]').click();
  assert.equal(await page.locator('#setup-worktrees').inputValue(), 'auto');
  await page.locator('#setup-worktrees').selectOption('always');
  assert.deepEqual((await sent(m => m.type === 'options' && 'worktrees' in m)).at(-1), { type: 'options', worktrees: 'always' });
  state.settings.worktreesAvailable = false; await deliver(state);
  assert.equal(await page.locator('#setup-worktrees').isDisabled(), true, 'Disabled outside a git repository');
  assert.match(await page.locator('#dialog-layer label:has(#setup-worktrees)').textContent(), /^Worktrees Needs a git repository/);
  await page.keyboard.press('Escape');
  await page.locator('#chip-team').click();
  assert.equal(await page.locator('#worktrees-select').isDisabled(), true);
  assert.match(await page.locator('#popover label:has(#worktrees-select)').textContent(), /^Worktrees Needs a git repository/);
  await page.keyboard.press('Escape');
  state.settings.worktreesAvailable = true; await deliver(state);
  // The agent's own worktree: shown for native agents, sent only when changed.
  await page.locator('.agent-pill[data-agent="a2"]').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Work in its own worktree' }).isChecked(), true);
  assert.equal(await page.locator('#agent-isolate-help').textContent(), 'Its edits stay on its own branch until you apply them. In Full access the agent can also turn this on itself. Now on chatroom/previe/claude · 2 checkpoints.');
  await page.getByRole('button', { name: 'Save agent' }).click();
  assert.equal('isolate' in (await sent(m => m.type === 'agent' && m.id === 'a2')).at(-1), false, 'Unchanged: not sent');
  await page.locator('.agent-pill[data-agent="a3"]').click();
  await page.getByRole('checkbox', { name: 'Work in its own worktree' }).check();
  await page.getByRole('button', { name: 'Save agent' }).click();
  assert.equal((await sent(m => m.type === 'agent' && m.id === 'a3')).at(-1).isolate, true);
  state.room.agents.push({ id: 'a4', name: 'Llama', provider: 'ollama', model: '', role: '', enabled: false, tools, options: options() }); await deliver(state);
  await page.locator('.agent-pill[data-agent="a4"]').click();
  assert.equal(await page.locator('#agent-form').count(), 1); assert.equal(await page.locator('#agent-isolate').count(), 0, 'Chat models have no worktree');
  await page.keyboard.press('Escape');
  state.room.agents.pop(); await deliver(state);
  // The Tools tab: isolated agents, the base and Clean up.
  await page.locator('.inspector-toggle').click(); await page.locator('[data-tab="tools"]').click();
  const wtSection = page.locator('.inspector-section', { has: page.locator('.section-heading', { hasText: 'WORKTREES' }) });
  assert.match(await wtSection.locator('.muted').textContent(), /^Auto in this room\./);
  assert.equal(await wtSection.locator('.wt-row').count(), 1);
  assert.equal(await wtSection.locator('.wt-row').textContent(), 'Claudechatroom/previe/claude2 checkpoints');
  assert.match(await wtSection.locator('.wt-base').textContent(), /^Base 4f1c2d3 · /);
  await wtSection.getByRole('button', { name: 'Clean up old worktrees' }).click();
  assert.deepEqual(await lastWorktree(), { type: 'worktree', action: 'cleanup' });
  await page.locator('[data-tab="usage"]').click(); await page.locator('.inspector-close').click();
  // /worktrees in the slash menu.
  await prompt.fill(''); await prompt.pressSequentially('/wor');
  const wtCommand = page.locator('#menu .menu-item', { hasText: '/worktrees' });
  assert.equal(await wtCommand.count(), 1);
  assert.equal(await wtCommand.locator('.menu-hint').textContent(), 'off | auto | always | status | apply | keep [name] | discard | cleanup');
  await prompt.press('Enter'); assert.equal(await prompt.inputValue(), '/worktrees ');
  await prompt.fill('');

  // Sandbox: run cards (live updates, escaping, Cancel, Run again), Run in sandbox on code blocks, sandbox approvals,
  // the Room setup switch, Start Docker Desktop, Install Docker Desktop, the Tools section and /sandbox.
  const lastSandbox = async () => (await sent(m => m.type === 'sandbox')).at(-1);
  const lastSandboxOption = async () => (await sent(m => m.type === 'options' && 'sandbox' in m)).at(-1);
  const sbxLimits = { cpus: 2, memoryMb: 2048, timeoutSeconds: 120 };
  const sbxRun = (id, extra = {}) => ({ id: 'run-' + id, status: 'done', image: 'python:3.12-slim', profile: 'test', network: false, command: 'python -m pytest -q', limits: sbxLimits, stdout: '', stderr: '', requestedBy: 'Claude', agentId: 'a2', createdAt: now, startedAt: now, ...extra });
  const sbxMessage = (id, extra) => ({ id, kind: 'notice', author: 'Sandbox', text: 'Sandbox run', status: 'complete', createdAt: now, sandbox: sbxRun(id, extra) });
  const sbxScript = Array.from({ length: 9 }, (_, i) => `print(${i})`).join('\n');
  const sbxCard = id => page.locator(`.sandbox-card[data-id="${id}"]`);
  const trimmed = async locator => (await locator.allTextContents()).map(s => s.trim());
  Object.assign(state.room, { status: 'idle', activeAgents: [], currentAgent: undefined, agentStates: {}, messages: [
    { id: 'u6', kind: 'user', author: 'You', text: 'Try this:\n\n```python\nprint("<b>hi</b>")\n```', status: 'complete', createdAt: now },
    { id: 'r6', kind: 'agent', agentId: 'a2', author: 'Claude', text: 'Run the checks:\n\n```sh\nnpm test\n```\n\nThe types:\n\n```ts\nconst x: number = 1;\n```\n\n```javascript\nconsole.log(1)\n```', status: 'complete', createdAt: now },
    sbxMessage('sb1', { status: 'running', startedAt: Date.now() - 5000, stdout: 'collecting <b>tests</b>\n', purpose: 'Check the <em>parser</em> tests' }),
    sbxMessage('sb2', { exitCode: 0, durationMs: 1400, finishedAt: now, stdout: '3 passed <script>window.HACKED=true</script>\n', files: [{ path: 'reports/<i>out</i>.txt', size: 2048, text: 'ok <img src=x onerror="window.HACKED=true">' }, { path: 'out.bin', size: 5 }] }),
    sbxMessage('sb3', { exitCode: 1, durationMs: 2100, finishedAt: now, language: 'python', command: sbxScript, profile: 'security', network: true, stdout: 'starting\n', stderr: 'AssertionError: <img src=x onerror="window.HACKED=true">\n' }),
    sbxMessage('sb4', { status: 'timeout', durationMs: 120000, finishedAt: now, error: 'Stopped after 2 min <b>limit</b>' }),
    sbxMessage('sb5', { status: 'denied', requestedBy: 'You', agentId: undefined, command: 'ls -la' }),
    { id: 'r7', kind: 'agent', agentId: 'a1', author: 'Codex', text: 'Writing it:\n\n```python\nprint(1)', status: 'streaming', createdAt: now }] });
  await deliver(state);
  const sbxCards = page.locator('.sandbox-card');
  assert.equal(await sbxCards.count(), 5, 'Sandbox notices render as cards');
  assert.equal(await page.locator('.notice-line').count(), 0);
  assert.equal(await page.evaluate(() => window.HACKED), undefined);
  assert.equal(await page.locator('.sandbox-card script, .sandbox-card img, .sandbox-card i, .sandbox-card em, .sandbox-card b, .message-content b').count(), 0, 'Output, file names, file text and purposes are escaped');
  // Running: elapsed time, the purpose, the badges and Cancel.
  assert.match(await sbxCard('sb1').locator('.sbx-chip').textContent(), /^Running… 00:0\d$/);
  const elapsed = await sbxCard('sb1').locator('.sbx-elapsed').textContent();
  await page.waitForFunction(before => document.querySelector('.sandbox-card[data-id="sb1"] .sbx-elapsed').textContent !== before, elapsed, { timeout: 3000 });
  assert.equal(await sbxCard('sb1').locator('.sbx-chip.run').count(), 1);
  assert.equal(await sbxCard('sb1').getAttribute('aria-label'), 'Sandbox run by Claude: Running…');
  assert.equal(await sbxCard('sb1').locator('.sbx-by').textContent(), 'by Claude');
  assert.equal(await sbxCard('sb1').locator('.sbx-purpose').textContent(), 'Check the <em>parser</em> tests');
  assert.equal(await sbxCard('sb1').locator('.sbx-command').textContent(), 'python -m pytest -q');
  assert.deepEqual(await sbxCard('sb1').locator('.sbx-badge').allTextContents(), ['python:3.12-slim', 'Test', 'No network', '2 CPUs · 2 GB · 2 min']);
  assert.equal(await sbxCard('sb1').locator('.sbx-out.stdout pre').textContent(), 'collecting <b>tests</b>\n');
  assert.equal(await sbxCard('sb1').locator('.sbx-out.stdout pre').isVisible(), true, 'Live output is open');
  assert.deepEqual(await trimmed(sbxCard('sb1').locator('.sbx-actions button')), ['Cancel'], 'Cancel while running, no Run again');
  await sbxCard('sb1').getByRole('button', { name: 'Cancel' }).click();
  assert.deepEqual(await lastSandbox(), { type: 'sandbox', action: 'cancel', id: 'run-sb1' });
  await sbxCard('sb1').getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await sent(m => m.type === 'sandbox' && m.action === 'cancel')).length, 1, 'A double click cancels once');
  // The host updates the same card in place; focus stays on the card's button.
  Object.assign(state.room.messages[2].sandbox, { status: 'cancelled', durationMs: 5200, finishedAt: Date.now() });
  await deliver(state);
  assert.equal(await sbxCards.count(), 5); assert.equal(await page.locator('#messages > *').nth(2).getAttribute('data-id'), 'sb1', 'The card updates in place');
  assert.equal(await sbxCard('sb1').locator('.sbx-chip').textContent(), 'Cancelled');
  assert.equal(await sbxCard('sb1').getByRole('button', { name: 'Cancel' }).count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.sandbox), 'rerun', 'Focus moves to Run again on the same card');
  Object.assign(state.room.messages[2].sandbox, { status: 'done', exitCode: 0 }); await deliver(state);
  // Done, exit 0: green chip, stdout, files with sizes and text, duration, Run again.
  assert.equal(await sbxCard('sb2').locator('.sbx-chip').textContent(), 'Exit 0');
  assert.equal(await sbxCard('sb2').locator('.sbx-chip.ok').count(), 1); assert.equal(await sbxCard('sb2').locator('.sbx-chip.bad').count(), 0);
  assert.equal(await sbxCard('sb2').locator('.sbx-out.stdout pre').textContent(), '3 passed <script>window.HACKED=true</script>\n');
  assert.equal(await sbxCard('sb2').locator('.sbx-out.stderr').count(), 0, 'No stderr section without stderr');
  assert.match(await sbxCard('sb2').locator('.sbx-out.stdout summary').textContent(), /^stdout · 1 line$/);
  assert.match(await sbxCard('sb2').locator('.sbx-meta').textContent(), /^Took 1\.4 s · /);
  const sbxFiles = sbxCard('sb2').locator('.sbx-files');
  assert.equal(await sbxFiles.locator(':scope > summary').textContent(), '2 files created or changed');
  assert.equal(await sbxFiles.getAttribute('open'), null, 'The file list starts closed');
  await sbxFiles.locator(':scope > summary').click();
  assert.deepEqual(await sbxFiles.locator('.sbx-file-path').allTextContents(), ['reports/<i>out</i>.txt', 'out.bin']);
  assert.deepEqual(await sbxFiles.locator('.sbx-file-size').allTextContents(), ['2 KB', '5 B']);
  await sbxFiles.locator('.sbx-file > summary').click();
  assert.equal(await sbxFiles.locator('.sbx-file pre').textContent(), 'ok <img src=x onerror="window.HACKED=true">', 'File text is shown as text');
  assert.equal(await sbxFiles.locator('.sbx-file pre').isVisible(), true);
  await sbxCard('sb2').getByRole('button', { name: 'Run again' }).click();
  assert.deepEqual(await lastSandbox(), { type: 'sandbox', action: 'rerun', id: 'run-sb2' });
  // Done, exit 1: red chip, stderr open, a long script collapsed, the security profile and network on.
  assert.equal(await sbxCard('sb3').locator('.sbx-chip').textContent(), 'Exit 1');
  assert.equal(await sbxCard('sb3').locator('.sbx-chip.bad').count(), 1);
  assert.equal(await sbxCard('sb3').locator('.sbx-out.stderr[open]').count(), 1, 'stderr opens when the run failed');
  assert.equal(await sbxCard('sb3').locator('.sbx-out.stderr pre').textContent(), 'AssertionError: <img src=x onerror="window.HACKED=true">\n');
  assert.deepEqual(await sbxCard('sb3').locator('.sbx-badge').allTextContents(), ['python:3.12-slim', 'Security', 'Network on', '2 CPUs · 2 GB · 2 min']);
  assert.equal(await sbxCard('sb3').locator('.sbx-badge.net-on').count(), 1);
  const sbxCode = sbxCard('sb3').locator('.sbx-code');
  assert.equal(await sbxCode.getAttribute('open'), null, 'A long script starts collapsed');
  assert.equal(await sbxCode.locator('summary').textContent(), 'python script · 9 lines print(0) …');
  await sbxCode.locator('summary').click();
  assert.equal(await sbxCode.locator('pre').textContent(), sbxScript);
  // Timed out, and denied (the user's own run).
  assert.equal(await sbxCard('sb4').locator('.sbx-chip').textContent(), 'Timed out');
  assert.equal(await sbxCard('sb4').locator('.sbx-error').textContent(), 'Stopped after 2 min <b>limit</b>');
  assert.equal(await sbxCard('sb4').locator('.sbx-chip.bad').count(), 1);
  assert.equal(await sbxCard('sb5').locator('.sbx-chip').textContent(), 'Denied');
  assert.equal(await sbxCard('sb5').locator('.sbx-by').textContent(), 'by you');
  assert.equal(await sbxCard('sb5').locator('.sbx-empty').count(), 0, 'A denied run has no "No output"');
  assert.equal(await sbxCard('sb5').getByRole('button', { name: 'Run again' }).count(), 1);
  // Run in sandbox on closed bash, python and node blocks, in the user's and the agents' messages.
  assert.deepEqual(await page.locator('.code-lang').allTextContents(), ['python', 'sh', 'javascript'], 'Not ts, and not a block still being written');
  assert.equal(await page.locator('.message[data-id="r7"] .code-run').count(), 0);
  await page.locator('.message[data-id="u6"]').getByRole('button', { name: 'Run in sandbox: python code' }).click();
  assert.deepEqual(await lastSandbox(), { type: 'sandbox', action: 'run', code: 'print("<b>hi</b>")', language: 'python' });
  await page.locator('.message[data-id="r6"]').getByRole('button', { name: 'Run in sandbox: sh code' }).click();
  assert.deepEqual(await lastSandbox(), { type: 'sandbox', action: 'run', code: 'npm test', language: 'bash' });
  await page.locator('.message[data-id="r6"]').getByRole('button', { name: 'Run in sandbox: javascript code' }).click();
  assert.deepEqual(await lastSandbox(), { type: 'sandbox', action: 'run', code: 'console.log(1)', language: 'node' });
  // Off in Settings, off in this room, or Docker not answering: no run buttons anywhere.
  for (const [settings, room, why] of [[{ enabled: false }, undefined, 'the setting is off'], [{}, false, 'the room switch is off'], [{ available: false, detail: 'Docker Desktop is not running.', action: 'startDocker' }, undefined, 'Docker is not available']]) {
    state.settings.sandbox = { enabled: true, available: true, detail: 'Docker 29.5.3', ...settings }; state.room.sandbox = room; await deliver(state);
    assert.equal(await page.locator('.code-run, .code-block').count(), 0, `No Run in sandbox when ${why}`);
    assert.equal(await page.getByRole('button', { name: 'Run again' }).count(), 0, `No Run again when ${why}`);
    assert.equal(await sbxCards.count(), 5, `The cards stay when ${why}`);
  }
  state.settings.sandbox = { enabled: true, available: true, detail: 'Docker 29.5.3' }; delete state.room.sandbox; await deliver(state);
  assert.equal(await page.locator('.code-run').count(), 3, 'The buttons come back');
  // Sandbox approvals: Allow and Deny only, from an agent or from You. The host's detail ("Why: …", "Image: …", … then the code)
  // becomes the purpose, a labelled code block, badges and notes; any other detail is shown as text.
  const apAt = Date.now(), apBase = { canAllowSession: false, status: 'pending', createdAt: apAt, expiresAt: apAt + 300000 };
  state.room.messages.push(
    sbxMessage('sb6', { status: 'pending', requestedBy: 'You', agentId: undefined, command: 'ls', createdAt: apAt }),
    { id: 'ap6', kind: 'approval', author: 'You', text: 'Run Python code in the sandbox (1 line)', status: 'complete', createdAt: apAt,
      approval: { ...apBase, id: 'appr-6', kind: 'sandbox', tool: 'sandbox', title: 'Run Python code in the sandbox (1 line)',
        detail: 'Why: Try the snippet\nImage: python:3.12-slim\nProfile: test · a writable copy\nNetwork: off\nFiles: a copy of C:\\ws\\chatroom\nLimits: 2 CPUs · 2048 MB memory · 120 s · 512 processes\n\nPython code:\nprint("<b>hi</b>")' } },
    { id: 'ap7', kind: 'approval', agentId: 'a2', author: 'Claude', text: 'npm audit', status: 'complete', createdAt: apAt,
      approval: { ...apBase, id: 'appr-7', agentId: 'a2', provider: 'claude', kind: 'sandbox', tool: 'sandbox', title: 'npm audit --json > audit.json', canAllowSession: true,
        detail: 'Why: Check the <em>dependencies</em>\nImage: node:22-bookworm-slim\nProfile: security · no root user, read-only copy\nNetwork: ON · the container can reach the internet\nFiles: a copy of C:\\ws\\chatroom\nLimits: 2 CPUs · 2048 MB memory · 300 s · 512 processes\nReturns the text of: audit.json\n\nCommand:\nnpm audit --json > audit.json <script>window.HACKED=true</script>' } },
    { id: 'ap8', kind: 'approval', agentId: 'a1', author: 'Codex', text: 'curl example.com', status: 'complete', createdAt: apAt,
      approval: { ...apBase, id: 'appr-8', agentId: 'a1', provider: 'codex', kind: 'sandbox', tool: 'sandbox', title: 'curl example.com', detail: 'Free text <b>from</b> an older host' } });
  await deliver(state);
  const userApproval = page.locator('.message.approval[data-id="ap6"]'), agentApproval = page.locator('.message.approval[data-id="ap7"]'), plainApproval = page.locator('.message.approval[data-id="ap8"]');
  for (const card of [userApproval, agentApproval, plainApproval]) assert.deepEqual(await card.locator('.approval-actions button').allTextContents(), ['Allow', 'Deny'], 'Sandbox runs: Allow or Deny, never Allow for session');
  assert.equal(await userApproval.locator('.approval-head').textContent(), 'You want to run this in the sandbox');
  assert.equal(await userApproval.locator('.message-avatar .user-avatar').textContent(), 'Y', 'The user\'s own request has the user\'s avatar');
  assert.equal(await agentApproval.locator('.approval-head').textContent(), 'Claude wants to run this in the sandbox');
  assert.equal(await userApproval.locator('.sbx-purpose').textContent(), 'Try the snippet');
  assert.equal(await userApproval.locator('.sbx-label').textContent(), 'Python code');
  assert.equal(await userApproval.locator('.approval-code').textContent(), 'print("<b>hi</b>")');
  assert.equal(await userApproval.locator('.approval-title, .approval-detail').count(), 0, 'The parsed request replaces the title and the raw detail');
  assert.deepEqual(await userApproval.locator('.sbx-badge').allTextContents(), ['python:3.12-slim', 'Test', 'No network', '2 CPUs · 2 GB · 2 min']);
  assert.deepEqual(await userApproval.locator('.sbx-note').allTextContents(), ['Files: a copy of C:\\ws\\chatroom']);
  assert.equal(await agentApproval.locator('.sbx-purpose').textContent(), 'Check the <em>dependencies</em>');
  assert.equal(await agentApproval.locator('.sbx-label').textContent(), 'Command');
  assert.equal(await agentApproval.locator('.approval-code').textContent(), 'npm audit --json > audit.json <script>window.HACKED=true</script>');
  assert.deepEqual(await agentApproval.locator('.sbx-badge').allTextContents(), ['node:22-bookworm-slim', 'Security', 'Network on', '2 CPUs · 2 GB · 5 min']);
  assert.equal(await agentApproval.locator('.sbx-badge.net-on').count(), 1, 'Network on stands out');
  assert.deepEqual(await agentApproval.locator('.sbx-note').allTextContents(), ['Files: a copy of C:\\ws\\chatroom', 'Returns the text of: audit.json']);
  assert.equal(await plainApproval.locator('.approval-title').textContent(), 'curl example.com');
  assert.equal(await plainApproval.locator('.approval-detail').textContent(), 'Free text <b>from</b> an older host');
  assert.equal(await page.locator('.approval-card em, .approval-card script, .approval-card b').count(), 0);
  assert.equal(await page.evaluate(() => window.HACKED), undefined);
  assert.equal(await sbxCard('sb6').locator('.sbx-chip').textContent(), 'Waiting for you');
  assert.equal(await sbxCard('sb6').locator('.sbx-chip.wait').count(), 1);
  assert.match(await page.locator('#run-controls').textContent(), /3 waiting for you/);
  await userApproval.getByRole('button', { name: 'Allow' }).click();
  assert.deepEqual((await sent(m => m.type === 'approval')).at(-1), { type: 'approval', id: 'appr-6', decision: 'allow' });
  await agentApproval.getByRole('button', { name: 'Deny' }).click();
  assert.deepEqual((await sent(m => m.type === 'approval')).at(-1), { type: 'approval', id: 'appr-7', decision: 'deny' });
  // Once decided, the result card has the details: the code folds away and the badges go.
  Object.assign(state.room.messages.find(m => m.id === 'ap6').approval, { status: 'allowed', decidedAt: Date.now() });
  state.room.messages = state.room.messages.filter(m => m.id !== 'ap8'); await deliver(state);
  assert.match(await userApproval.locator('.approval-result').textContent(), /^Allowed · /);
  assert.equal(await userApproval.locator('.sbx-badge, .sbx-note, .approval-actions').count(), 0);
  assert.equal(await userApproval.locator('.sbx-code summary').textContent(), 'Python code · 1 line print("<b>hi</b>")');
  assert.equal(await userApproval.locator('.sbx-code').getAttribute('open'), null);
  // Room setup: the switch, its status line, Start Docker Desktop and Install Docker Desktop.
  await page.locator('[data-action="room-setup"]').click();
  const setupSandbox = page.locator('#setup-sandbox');
  assert.equal(await setupSandbox.isChecked(), true, 'On: the setting applies until the room has its own');
  assert.equal(await page.getByRole('switch', { name: 'Sandbox runs in this room' }).count(), 1);
  assert.equal(await page.locator('#setup-sandbox-status').textContent(), 'Docker 29.5.3 · every run asks you first');
  await setupSandbox.click();
  assert.deepEqual(await lastSandboxOption(), { type: 'options', sandbox: false });
  state.room.sandbox = false; await deliver(state);
  assert.equal(await setupSandbox.isChecked(), false);
  assert.match(await page.locator('#setup-sandbox-status').textContent(), /^Off in this room\./);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'setup-sandbox', 'The switch keeps focus');
  await setupSandbox.click();
  assert.deepEqual(await lastSandboxOption(), { type: 'options', sandbox: true });
  delete state.room.sandbox;
  state.settings.sandbox = { enabled: true, available: false, detail: 'Docker Desktop is not running.', action: 'startDocker' }; await deliver(state);
  assert.equal(await setupSandbox.isChecked(), true);
  assert.equal(await page.locator('#setup-sandbox-status').textContent(), 'Docker Desktop is not running.');
  const startDocker = page.locator('#dialog-layer [data-sandbox="startDocker"]');
  assert.equal((await startDocker.textContent()).trim(), 'Start Docker Desktop');
  await startDocker.click();
  assert.deepEqual(await lastSandbox(), { type: 'sandbox', action: 'startDocker' });
  assert.equal((await startDocker.textContent()).trim(), 'Starting Docker Desktop…');
  assert.equal(await startDocker.getAttribute('aria-disabled'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.sandbox), 'startDocker', 'The button keeps focus');
  await page.keyboard.press('Enter');
  assert.equal((await sent(m => m.type === 'sandbox' && m.action === 'startDocker')).length, 1, 'Pressed once while Docker starts');
  await deliver({ type: 'error', text: 'Docker Desktop did not start.' });
  await page.evaluate(() => { document.getElementById('toast').hidden = true; }); await prompt.fill('');
  assert.equal((await startDocker.textContent()).trim(), 'Start Docker Desktop', 'An error offers the button again');
  state.settings.sandbox = { enabled: true, available: false, detail: 'Docker is not installed.', action: 'installDocker' }; await deliver(state);
  assert.equal(await startDocker.count(), 0);
  const installDocker = page.locator('#dialog-layer a', { hasText: 'Install Docker Desktop' });
  assert.equal(await installDocker.getAttribute('href'), 'https://www.docker.com/products/docker-desktop/');
  assert.equal(await page.locator('#dialog-layer .sbx-url').textContent(), 'https://www.docker.com/products/docker-desktop/', 'The address is shown as text');
  state.settings.sandbox = { enabled: false, available: true, detail: 'Docker 29.5.3' }; await deliver(state);
  assert.equal(await setupSandbox.isDisabled(), true, 'Off in Settings: the room switch cannot turn it on');
  assert.equal(await page.locator('#setup-sandbox-status').textContent(), 'Off in Settings (chatroom.sandbox.enabled)');
  assert.equal(await page.locator('#dialog-layer .sbx-setting [data-action="settings"]').count(), 1);
  await page.keyboard.press('Escape');
  state.settings.sandbox = { enabled: true, available: true, detail: 'Docker 29.5.3' }; await deliver(state);
  // The Tools tab: status, the switch and the last 5 runs, newest first.
  await page.locator('.inspector-toggle').click(); await page.locator('[data-tab="tools"]').click();
  const sbxSection = page.locator('.inspector-section', { has: page.locator('.section-heading', { hasText: 'SANDBOX' }) });
  assert.equal(await sbxSection.locator('.section-heading').first().textContent(), 'SANDBOX 6');
  assert.equal(await sbxSection.locator('#tools-sandbox').isChecked(), true);
  assert.equal(await sbxSection.locator('#tools-sandbox-status').textContent(), 'Docker 29.5.3 · every run asks you first');
  assert.deepEqual(await sbxSection.locator('.sbx-run-cmd').allTextContents(), ['ls', 'ls -la', 'python -m pytest -q', 'print(0) …', 'python -m pytest -q']);
  assert.deepEqual(await sbxSection.locator('.sbx-run-status').allTextContents(), ['Waiting for you', 'Denied', 'Timed out', 'Exit 1 · 2.1 s', 'Exit 0 · 1.4 s']);
  await sbxSection.locator('#tools-sandbox').click();
  assert.deepEqual(await lastSandboxOption(), { type: 'options', sandbox: false });
  await page.locator('[data-tab="usage"]').click(); await page.locator('.inspector-close').click();
  // /sandbox in the slash menu.
  await prompt.fill(''); await prompt.pressSequentially('/sand');
  const sbxCommand = page.locator('#menu .menu-item', { hasText: '/sandbox' });
  assert.equal(await sbxCommand.count(), 1);
  assert.equal(await sbxCommand.locator('.menu-hint').textContent(), 'on | off | status | <command> | python|node|bash <code>');
  await prompt.press('Enter'); assert.equal(await prompt.inputValue(), '/sandbox ');
  await prompt.fill('');
  // 300 and 360 px: the cards, the approvals and the code blocks fit; so do Room setup and the Tools section.
  state.room.messages[2].sandbox = { ...state.room.messages[2].sandbox, status: 'running', startedAt: Date.now() };
  for (const width of [300, 360]) {
    state.settings.sandbox = { enabled: true, available: true, detail: 'Docker 29.5.3' };
    await page.setViewportSize({ width, height: 900 }); await deliver(state);
    assert.equal(await page.locator('.code-run').count(), 3);
    const outside = await page.evaluate(() => {
      const list = document.getElementById('messages'), box = list.getBoundingClientRect(), out = [];
      for (const el of list.querySelectorAll('.sandbox-card, .approval-card, .code-block, .sandbox-card button, .approval-card button, .code-run, .sbx-badge')) {
        const r = el.getBoundingClientRect();
        if (r.width && (r.left < box.left - 0.5 || r.right > box.right + 0.5)) out.push(el.className);
      }
      for (const el of list.querySelectorAll('.sandbox-card, .approval-card')) if (el.scrollWidth > el.clientWidth) out.push('scroll ' + el.className);
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('page');
      return out;
    });
    assert.deepEqual(outside, [], `Sandbox cards fit at ${width}px`);
    state.settings.sandbox = { enabled: true, available: false, detail: 'Docker Desktop is not running. Start it, then try again.', action: 'startDocker' }; await deliver(state);
    await page.locator('[data-action="room-setup"]').click();
    assert.ok(await page.evaluate(() => { const d = document.querySelector('#dialog-layer .dialog'), b = d.querySelector('[data-sandbox="startDocker"]').getBoundingClientRect(), r = d.getBoundingClientRect(); return d.scrollWidth <= d.clientWidth && b.right <= r.right; }), `Room setup fits at ${width}px`);
    await page.keyboard.press('Escape');
    await page.locator('.inspector-toggle').click(); await page.locator('[data-tab="tools"]').click();
    assert.ok(await page.evaluate(() => { const c = document.getElementById('inspector-content'); return c.scrollWidth <= c.clientWidth; }), `The Tools tab fits at ${width}px`);
    await page.locator('[data-tab="usage"]').click(); await page.locator('.inspector-close').click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  state.settings.sandbox = { enabled: true, available: true, detail: 'Docker 29.5.3' };
  assert.equal(await page.evaluate(() => window.HACKED), undefined);

  state.room.mode = 'parallel'; state.room.documents = [];
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    state.room.status = 'idle'; state.room.currentAgent = undefined; state.room.activeAgents = []; state.room.queuedTurns = 0; state.room.messages = [];
    await deliver(state); await page.locator('.empty-state').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `No horizontal overflow at ${width}px`);
    for (const id of ['send', 'context-ring', 'chip-team']) {
      const box = await page.locator('#' + id).boundingBox();
      assert.ok(box && box.y + box.height < 900 && box.x >= 0 && box.x + box.width <= width, `#${id} visible at ${width}px`);
    }
    assert.equal(await page.locator('.agent-pill .pill-meta').first().isVisible(), width > 480, `pill meta at ${width}px`);
    const hidden = await page.evaluate(() => {
      const send = document.getElementById('send').getBoundingClientRect(), strip = document.querySelector('.team-pills').getBoundingClientRect(), out = [];
      for (const el of document.querySelectorAll('.bar-chips .chip, .agent-pill')) {
        const r = el.getBoundingClientRect(), box = el.classList.contains('chip') ? el.closest('.composer').getBoundingClientRect() : strip;
        const label = el.querySelector('.chip-label, .pill-name');
        if (r.left < box.left || r.right > box.right + 0.5 || (r.right > send.left && r.left < send.right && r.bottom > send.top && r.top < send.bottom) || (label && label.scrollWidth > label.clientWidth + 1)) out.push(el.id || el.dataset.agent);
      }
      return out;
    });
    assert.deepEqual(hidden, [], `Every chip and agent is fully visible at ${width}px`);
    await page.locator('#chip-loop').click();
    const pop = await page.locator('#popover').boundingBox();
    assert.ok(pop.x >= 0 && pop.x + pop.width <= width, `Popover fits at ${width}px`);
    await page.keyboard.press('Escape');
    await deliver({ type: 'openTeam' });
    await page.getByRole('heading', { name: 'Your team' }).waitFor();
    assert.ok(await page.evaluate(() => { const d = document.querySelector('#dialog-layer .dialog'); return d.scrollWidth <= d.clientWidth && document.documentElement.scrollWidth <= window.innerWidth; }), `The team builder fits at ${width}px`);
    await page.keyboard.press('Escape');
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
  console.log('UI checks passed: team strip, unavailable agents, composer chips and popovers, / and @ menus, editor chip, think/ultra, approvals, activity, agent settings, tools, custom teams and the team builder, worktrees (pill, changes card, select, agent switch, Tools section, /worktrees), sandbox (run cards, Run in sandbox, approvals, switch, Docker actions, Tools section, /sandbox), 360px/320px sidebar, escaping and logo rendering.');
} finally { await browser.close(); await new Promise(r => server.close(r)); }
