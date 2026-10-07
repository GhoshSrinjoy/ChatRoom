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
// What the CLIs report about themselves (sample data in the shapes the drivers produce), keyed by agent id.
const NO = { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: false, useSkills: false, useProjectSettings: false, extraDirs: false, ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: false, customAgent: false };
const command = (name, description, argumentHint, source = 'builtin') => ({ name, description, ...(argumentHint ? { argumentHint } : {}), source });
const roomTools = ['mcp__chatroom__search_documents', 'mcp__chatroom__read_document', 'mcp__chatroom__semantic_search', 'mcp__chatroom__ollama_ocr'];
const capabilities = {
  a1: { provider: 'codex', runtime: 'cli', status: 'ready', version: '0.160.1', models: [], efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', tools: [],
    skills: ['pdf', 'doc', 'spreadsheet', 'playwright', 'security-best-practices'].map(name => ({ name })),
    commands: [command('review', 'Review uncommitted changes, or follow your review instructions', '[instructions]', 'mapped'), command('goal', 'Set, show or clear a long-running goal for this agent', '[objective | clear]', 'mapped'),
      command('init', 'Create an AGENTS.md file with instructions for this repository', '', 'mapped'), command('mcp', 'List MCP servers and their tools', '', 'mapped')],
    mcpServers: [{ name: 'chatroom', status: 'ready', tools: 4 }, { name: 'docs', status: 'ready', tools: 3 }],
    supports: { ...NO, summary: true, sandbox: true, webSearch: true, useMcp: true, useProjectSettings: true, extraDirs: true, ultraSession: true, ultraTurn: true, thinkHard: true }, context: { percent: 31, tokens: 79000, window: 258000 }, updatedAt: now },
  a2: { provider: 'claude', runtime: 'cli', status: 'ready', version: '2.1.289', models: [{ id: 'sonnet', name: 'sonnet' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', ...roomTools],
    skills: ['frontend-design', 'pdf', 'code-review', 'security-review'].map(name => ({ name })),
    commands: [command('review', 'Review a pull request'), command('security-review', 'Complete a security review of the pending changes on the current branch'), command('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
      command('context', 'Show current context usage'), command('frontend-design', 'Create distinctive, production-grade frontend interfaces', '', 'skill')],
    mcpServers: [{ name: 'chatroom', status: 'connected', tools: 4 }, { name: 'docs', status: 'connected', tools: 3 }], plugins: ['chatroom-shared'], agents: ['general-purpose', 'Explore', 'Plan'],
    supports: { ...NO, thinking: true, webSearch: true, useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: true, ultraSession: true, ultraTurn: true, thinkHard: true, customAgent: true }, context: { percent: 14, tokens: 28000, window: 200000 }, updatedAt: now },
  a3: { provider: 'copilot', runtime: 'vscode-lm', status: 'ready', detail: 'Models available through VS Code', models: [], efforts: [], tools: ['list_files', 'read_file', 'search_files', 'search_documents'], skills: [], commands: [], mcpServers: [],
    supports: { ...NO }, action: 'installCopilot', updatedAt: now }
};
const sharedSkills = [
  { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces with high design quality.', path: '/skills/frontend-design/SKILL.md', dir: '/skills/frontend-design', source: 'claude-plugin', nativeTo: ['claude'] },
  { name: 'pdf', description: 'Read, merge and split PDF files; fill forms and extract tables.', path: '/skills/pdf/SKILL.md', dir: '/skills/pdf', source: 'agents-user', nativeTo: ['codex', 'claude'] },
  { name: 'security-best-practices', description: 'Language-specific security reviews for Python, JS/TS and Go.', path: '/skills/security/SKILL.md', dir: '/skills/security', source: 'codex-user', nativeTo: ['codex'] }];
const roomCommands = [
  ['help', 'Show Chatroom commands'], ['clear', 'Start fresh native sessions; agents forget earlier messages', '', true], ['compact', "Summarize each agent's native session to free context", '[instructions]', true],
  ['new', 'Open a new room'], ['export', 'Export this conversation as Markdown'], ['loop', "Repeat the room's work until a condition or limit", '[N | consensus | done | every 10m <prompt> | off]'],
  ['mode', 'Choose how agents collaborate', 'team | relay | parallel | custom'], ['lead', 'Choose the lead for Team mode', '<agent>'],
  ['team', 'Set up your own team: stages such as lead, drafting, review, testing', '[name | Lead: Claude > Draft: Codex > … | save <name> | edit | off]'], ['model', 'Set the model of the mentioned agent', '<model>', true],
  ['effort', 'Set reasoning effort for the mentioned agents (or all)', '<level>', true], ['permissions', 'Set what agents may do without asking', 'plan | ask | auto | full', true],
  ['status', 'Show sessions, models and context use', '', true], ['stop', 'Stop all running agents']
].map(([name, description, args, agentScoped = false]) => ({ name, description, ...(args ? { args } : {}), agentScoped }));
// The built-in team templates, in the shape the host broadcasts.
const teams = [
  { name: 'Lead, draft, review', wrapUp: true, builtIn: true, stages: [{ name: 'Leads', agents: ['Claude'], run: 'parallel', lead: true }, { name: 'Drafting', agents: ['Codex'], run: 'parallel', lead: false, preset: 'drafting' }, { name: 'Review', agents: ['Claude', 'Copilot'], run: 'parallel', lead: false, preset: 'review' }] },
  { name: 'Build and test', wrapUp: true, builtIn: true, stages: [{ name: 'Leads', agents: ['Claude'], run: 'parallel', lead: true }, { name: 'Coding', agents: ['Codex'], run: 'parallel', lead: false }, { name: 'Testing', agents: ['Copilot'], run: 'parallel', lead: false, task: 'Write and run tests for the change' }, { name: 'Review', agents: ['Claude'], run: 'parallel', lead: false, preset: 'review' }] },
  { name: 'Draft and review', wrapUp: false, builtIn: true, stages: [{ name: 'Drafting', agents: ['Codex'], run: 'parallel', lead: false, preset: 'drafting' }, { name: 'Review', agents: ['Claude'], run: 'parallel', lead: false }] }];
const editor = { path: '/work/chatroom/src/process.ts', relPath: 'src/process.ts', label: 'process.ts', languageId: 'typescript', kind: 'text',
  selection: { startLine: 120, endLine: 164, text: 'export function runJsonLines(…) { … }' }, openTabs: [{ label: 'process.test.ts', relPath: 'tests/process.test.ts' }] };
const approvalRequest = (id, agentId, provider, kind, tool, title, extra) => ({ id: `m-${id}`, kind: 'approval', agentId, author: agentId === 'a2' ? 'Claude' : 'Codex', text: tool, status: 'complete', createdAt: now,
  approval: { id, agentId, provider, kind, tool, title, canAllowSession: true, createdAt: now, expiresAt: Date.now() + 272000, ...extra } });
const room = overrides => ({ id: 'demo', title: 'Review the subprocess handling for reliability issues', createdAt: now, status: 'idle', mode: 'orchestrated', leadId: 'a2', concurrency: 3,
  activeAgents: [], queuedTurns: 0, loop: { kind: 'once', rounds: 2, everyMinutes: 10, maxIterations: 5, maxMinutes: 60, maxTokens: 0 }, attachEditor: true, shareSkills: true, tokenBudget: 0, runStartTokens: 0, completedTurns: 5, activity: [], usage, agents, ...overrides });
const state = room => ({ type: 'state', workspace: 'chatroom', trusted: true, discovering: false, modelDefaults: { planning: {}, drafting: {}, review: {} }, defaultPreset: 'planning', executionMode: 'orchestrated', maxParallelAgents: 3,
  rooms: [{ id: 'demo', title: room.title }], connections, capabilities, editor, sharedSkills, roomCommands, teams,
  settings: { allowFullAccess: false, attachOpenFile: true, approvalTimeoutSeconds: 300 }, localModels: { vision: 'glm-ocr:latest', embedding: 'embeddinggemma:latest' }, room });
const running = room({ status: 'running', activeAgents: ['a3'], currentAgent: 'a3', queuedTurns: 1, completedTurns: 2, documents: documents(true),
  agentStates: { a1: { status: 'complete' }, a2: { status: 'queued' }, a3: { status: 'thinking' } },
  messages: [user, plan(['complete', 'running', 'pending']), tool, s1, { ...s2, status: 'streaming', text: 'The only cancellation test uses a child that exits on the first signal. Missing:' }] });
const fixing = room({ title: 'Run the tests and fix what fails', mode: 'parallel', status: 'running', activeAgents: ['a1', 'a2'], completedTurns: 1,
  agentStates: { a1: { status: 'approval', detail: 'apply_patch' }, a2: { status: 'approval', detail: 'Bash' }, a3: { status: 'complete' } },
  messages: [{ ...user, text: 'Run the tests and fix what fails.' },
    approvalRequest('ap1', 'a2', 'claude', 'command', 'Bash', 'npm test -- tests/process.test.ts', { detail: 'Run the process tests', status: 'pending' }),
    approvalRequest('ap2', 'a1', 'codex', 'edit', 'apply_patch', 'src/process.ts', { status: 'pending',
      diff: '--- a/src/process.ts\n+++ b/src/process.ts\n@@ -456,4 +456,6 @@ export function runJsonLines(\n-    later(STOP_GRACE_MS, () => signalTree(true));\n+    later(STOP_GRACE_MS, () => {\n+      if (closed) return; signalTree(true);\n+      later(RELEASE_GRACE_MS, release);\n+    });' })] });
// A custom team run: Codex is out of usage, so Claude stands in for the Drafting stage.
const back = Date.now() + 2 * 86400000, backText = new Date(back).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const { builtIn: _, ...ownTeam } = teams[0];
const teamRun = room({ title: 'Add a CSV export to the report page', mode: 'pipeline', team: ownTeam, status: 'running', activeAgents: ['a2'], currentAgent: 'a2', completedTurns: 1,
  progress: { stage: 2, total: 3, name: 'Drafting' },
  agents: agents.map(a => a.id === 'a1' ? { ...a, unavailable: { reason: 'usage-limit', detail: 'Codex usage limit reached.', at: now, until: back } } : a),
  agentStates: { a1: { status: 'unavailable', detail: `out of usage until ${backText}` }, a2: { status: 'thinking' }, a3: { status: 'queued' } },
  messages: [{ ...user, text: 'Add a CSV export to the report page.' },
    say('lead', 'a2', 'Claude', 'Drafting: add `exportCsv(rows)` in src/report.ts with a header row and proper quoting. Review: check commas, quotes and newlines in values.', { turn: 'stage', stage: { index: 0, total: 3, name: 'Leads', lead: true } }),
    { id: 'skip', kind: 'notice', author: 'Chatroom', status: 'complete', createdAt: now, text: `Drafting: Codex can't run right now (out of usage until ${backText}) · Claude takes this stage.` },
    say('draft', 'a2', 'Claude', 'Drafting `exportCsv` now: a header from the first row, values quoted when they contain a comma, quote or newline.', { turn: 'stage', status: 'streaming', stage: { index: 1, total: 3, name: 'Drafting' } })] });
// Two agents worked in their own git worktrees; the room combined their branches and waits for the user.
const wt = (key, n) => ({ path: `/storage/wt/d17cb5/demo-${key}`, branch: `chatroom/demo/${key}`, createdAt: now, checkpoints: n });
const combined = { base: '4f2a9c1e7b3d', branch: 'chatroom/demo/integration', path: '/storage/wt/d17cb5/demo-integration', status: 'ready', updatedAt: now, added: 141, removed: 9,
  files: [{ path: 'src/report/export.ts', added: 58, removed: 0, status: 'A' }, { path: 'src/report/page.tsx', added: 14, removed: 6, status: 'M' }, { path: 'tests/report/export.test.ts', added: 66, removed: 0, status: 'A' }, { path: 'src/report/index.ts', added: 3, removed: 3, status: 'M' }] };
const isolated = room({ title: 'CSV export with tests', mode: 'parallel', worktrees: 'auto', completedTurns: 2,
  agents: agents.map(a => a.id === 'a1' ? { ...a, worktree: wt('codex', 2) } : a.id === 'a2' ? { ...a, worktree: wt('claude', 1) } : a), changes: combined,
  messages: [{ ...user, text: 'Add a CSV export to the report page, with tests. Codex writes the exporter, Claude the tests.' },
    say('c1', 'a1', 'Codex', 'Added `exportCsv()` in src/report/export.ts with RFC 4180 quoting, and a Download CSV button on the report page.'),
    say('c2', 'a2', 'Claude', 'Wrote tests for quoting, empty reports and a 50,000-row report. All pass in my worktree.'),
    { id: 'card', kind: 'notice', author: 'Chatroom', status: 'complete', createdAt: now, changes: combined, text: 'Agents changed 4 files in their worktrees (+141 −9). Review them, then apply them to your folder or keep them as a branch.' }] });
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
  // slash: type this into the composer to open its menu. section: inspector heading text to scroll to the top.
  // openTeam: open the team builder as /team edit does.
  // click: a selector to click before the screenshot (an agent pill opens its settings, a chip opens its popover).
  const shoot = async (file, data, { width, height, tab, scrollTo, collapseAgents, slash, section, openTeam, click }) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => ({}), setState: () => {} }); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => { document.body.className = 'vscode-dark'; document.documentElement.style.setProperty('--vscode-sideBar-background', '#181818'); });
    await page.evaluate(data => window.postMessage(data, '*'), data);
    await page.locator('.message.user').waitFor();
    if (collapseAgents) await page.evaluate(() => { const roster = document.querySelector('.roster'); if (roster) roster.open = false; });
    if (tab) { await page.locator('.inspector-toggle').click(); await page.locator(`[data-tab="${tab}"]`).click(); }
    if (section) await page.evaluate(text => { const heading = [...document.querySelectorAll('#inspector .section-heading')].find(h => h.textContent.startsWith(text)); heading?.closest('.inspector-section')?.scrollIntoView({ block: 'start' }); }, section);
    await page.evaluate(selector => {
      const list = document.getElementById('messages'), target = selector && list.querySelector(selector);
      list.scrollTop = target ? target.offsetTop - list.offsetTop - 8 : list.scrollHeight;
    }, scrollTo);
    if (click) { await page.locator(click).first().click(); await page.waitForTimeout(250); }
    if (openTeam) { await page.evaluate(() => window.postMessage({ type: 'openTeam' }, '*')); await page.locator('.dialog').waitFor(); }
    if (slash) { await page.locator('#prompt').click(); await page.locator('#prompt').pressSequentially(slash); await page.locator('#menu:not([hidden])').waitFor(); }
    await page.waitForTimeout(150);
    await (tab ? page.locator('#inspector') : page).screenshot({ path: `${out}/${file}` });
    await page.close();
    console.log(`Saved ${out}/${file}`);
  };
  await shoot('lead-team.png', state(running), { width: 1100, height: 1300, scrollTo: '.message.user' });
  await shoot('final-answer.png', state(done), { width: 1100, height: 1180 });
  await shoot('sidebar.png', state(running), { width: 420, height: 1000, scrollTo: '.message.turn-plan', collapseAgents: true });
  await shoot('tools.png', state(done), { width: 1100, height: 1220, tab: 'tools' });
  await shoot('documents.png', state(done), { width: 1100, height: 1220, tab: 'tools', section: 'SHARED WITH THE ROOM' });
  await shoot('usage.png', state(done), { width: 1100, height: 1220, tab: 'usage' });
  await shoot('approvals.png', state(fixing), { width: 420, height: 1000 });
  await shoot('commands.png', state(done), { width: 420, height: 1000, slash: '/' });
  await shoot('team-run.png', state(teamRun), { width: 420, height: 1000 });
  await shoot('changes.png', { ...state(isolated), settings: { ...state(isolated).settings, worktrees: 'auto', worktreesAvailable: true } }, { width: 420, height: 1000 });
  await shoot('team.png', state(room({ ...done, mode: 'pipeline', team: ownTeam })), { width: 1100, height: 1300, openTeam: true });
  await shoot('agent-settings.png', state(done), { width: 1100, height: 1300, click: '[data-agent="a2"]' });
  await shoot('unavailable.png', state(teamRun), { width: 1100, height: 1000, click: '[data-agent="a1"]' });
  await shoot('loop.png', state(done), { width: 420, height: 1000, click: '#chip-loop' });
  await shoot('team-popover.png', state(room({ ...done, mode: 'pipeline', team: ownTeam })), { width: 420, height: 1000, click: '#chip-team' });
} finally { await browser.close(); await new Promise(r => server.close(r)); }
