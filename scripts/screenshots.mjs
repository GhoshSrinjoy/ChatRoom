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
  { id: 'a3', name: 'Copilot', provider: 'copilot', model: '', role: '', enabled: true, tools: ['list_files', 'read_file', 'search_files', 'search_documents'], options: { ...options, copilotRuntime: 'auto' } },
  { id: 'a4', name: 'Gemini', provider: 'gemini', model: '', role: '', enabled: true, tools: ['list_files', 'read_file', 'search_files', 'search_documents'], options }
];
const tasks = {
  s1: 'Read src/process.ts and list every way a stopped or timed-out CLI could keep a turn waiting.',
  s2: 'Check tests/process.test.ts and list the cancellation cases it does not cover.',
  s3: 'Read docs/process-design.pdf and list what it promises about stopping a turn that the code may not do.',
  s4: 'Verify the hang paths from s1 against the code and propose fixes that also close the gaps from s2 and s3.'
};
const steps = status => [
  { id: 's1', agentId: 'a1', task: tasks.s1, after: [], status: status[0] },
  { id: 's2', agentId: 'a3', task: tasks.s2, after: [], status: status[1] },
  { id: 's3', agentId: 'a4', task: tasks.s3, after: [], status: status[2] },
  { id: 's4', agentId: 'a2', task: tasks.s4, after: ['s1', 's2', 's3'], status: status[3] }];
const say = (id, agentId, author, text, extra = {}) => ({ id, kind: 'agent', agentId, author, text, status: 'complete', createdAt: now, ...extra });
const step = (id, agentId, author, text, extra = {}) => say(`m-${id}`, agentId, author, text, { turn: 'step', step: { id, plan: 'plan', task: tasks[id], after: id === 's4' ? ['s1', 's2', 's3'] : [] }, ...extra });
const user = { id: 'u', kind: 'user', author: 'You', status: 'complete', createdAt: now, text: 'Review the subprocess handling for reliability issues. Split the work, read the code, and challenge each other\'s findings.' };
const plan = status => say('plan', 'a2', 'Claude', 'Codex audits how turns are stopped, Copilot checks what the tests cover, and Gemini compares the design document with the code. Then I verify all three and propose fixes.', { turn: 'plan', plan: steps(status) });
const tool = { id: 't1', kind: 'tool', author: 'read_file', agentId: 'a1', status: 'complete', createdAt: now, text: 'export function runJsonLines(executable, args, input, cwd, signal, onEvent) { … }' };
const s1 = step('s1', 'a1', 'Codex', 'Two hang paths.\n\n1. On macOS and Linux, stop sends a single SIGTERM and then waits for the process to close. A CLI that ignores it never closes, so the turn never ends.\n2. The close event also waits for any helper process that still holds stdout, even after the CLI itself has exited.\n\nThe turn timeout uses the same path, so it hangs the same way.');
const s2 = step('s2', 'a3', 'Copilot', 'The only cancellation test uses a child that exits on the first signal. Missing: a CLI that ignores SIGTERM, a helper that keeps the output pipe open, and a CLI that prints a plain-text error and exits 0.');
const s3 = step('s3', 'a4', 'Gemini', 'The design document makes two promises the code does not keep. Page 4: a stopped turn ends within 5 seconds, but nothing limits how long a stop takes. Page 5: a CLI\'s own error message reaches the user, but plain-text output is dropped when the CLI exits 0.');
const s4 = step('s4', 'a2', 'Claude', 'All three check out. Both paths from Codex are real; I confirmed them in `runJsonLines`. Copilot\'s third gap is the same bug as the promise Gemini found on page 5: an empty answer is already rejected, but the CLI\'s own message is thrown away, so the error should include it. [CONSENSUS]');
const final = say('final', 'a2', 'Claude', '**Three fixes, in priority order.**\n\n1. **Bounded stop.** Stop the CLI\'s whole process group, force-kill after 2 seconds, and release its pipes 2 seconds later, so a stuck process can never freeze the room.\n2. **Leftover helpers.** After the CLI exits, wait at most 2 seconds for its output to close.\n3. **Useful errors.** When a CLI prints plain text instead of an answer, show that text.\n\nCodex found both hang paths, Copilot\'s test gaps become the regression tests for each fix, and Gemini\'s reading of the design document sets the time limit.', { turn: 'synthesis' });
const documents = ocr => [
  { id: 'd1', name: 'docs/process-design.pdf', hash: 'h1', kind: 'pdf', source: 'attached', status: 'ready', chars: 18250, chunks: 14, pages: 6, ocrPages: 2, embedded: 'embeddings', addedAt: now },
  ocr ? { id: 'd2', name: 'whiteboard.png', hash: 'h2', kind: 'image', source: 'attached', status: 'ocr', detail: 'OCR · whiteboard.png', chars: 0, chunks: 0, addedAt: now }
    : { id: 'd2', name: 'whiteboard.png', hash: 'h2', kind: 'image', source: 'attached', status: 'ready', chars: 940, chunks: 1, ocrPages: 1, embedded: 'embeddings', addedAt: now }];
const usage = {
  a1: { input: 144000, cached: 77700, output: 2100, cacheWrite: 0, requests: 4, estimated: false },
  a2: { input: 26300, cached: 18100, output: 1900, cacheWrite: 2400, requests: 3, estimated: false, cost: 0.0412 },
  a3: { input: 9200, cached: 0, output: 600, cacheWrite: 0, requests: 1, estimated: true },
  a4: { input: 31000, cached: 12400, output: 1500, cacheWrite: 0, requests: 2, estimated: false },
  'local-tools': { input: 3400, cached: 0, output: 170, cacheWrite: 0, requests: 3, estimated: false }
};
const connections = [
  { id: 'codex', status: 'ready', detail: 'VS Code extension runtime', models: [] },
  { id: 'claude', status: 'ready', detail: 'VS Code extension runtime', models: [{ id: 'sonnet', name: 'sonnet' }] },
  { id: 'copilot', status: 'ready', runtime: 'cli', detail: 'Copilot CLI 1.0.92 · sign-in is checked when an agent connects', modelSource: 'Copilot CLI (models load when the agent connects)', version: '1.0.92', models: [] },
  { id: 'gemini', status: 'ready', runtime: 'cli', detail: 'Gemini CLI 0.66.0 · sign-in is checked when an agent connects', modelSource: 'Gemini CLI (models load when the agent connects)', version: '0.66.0', models: [] },
  { id: 'ollama', status: 'ready', detail: 'Installed models · loopback endpoint', models: [{ id: 'glm-ocr:latest', name: 'glm-ocr:latest', capabilities: ['vision'] }, { id: 'embeddinggemma:latest', name: 'embeddinggemma:latest', capabilities: ['embedding'] }] }];
// What the CLIs report about themselves (sample data in the shapes the drivers produce), keyed by agent id.
const NO = { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: false, useSkills: false, useProjectSettings: false, extraDirs: false, ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: false, customAgent: false };
const command = (name, description, argumentHint, source = 'builtin') => ({ name, description, ...(argumentHint ? { argumentHint } : {}), source });
const roomTools = ['mcp__chatroom__search_documents', 'mcp__chatroom__read_document', 'mcp__chatroom__semantic_search', 'mcp__chatroom__ollama_ocr'];
const canDisable = { tools: true, toolsByName: true, skills: true, mcpServers: true, commands: true };
const capabilities = {
  a1: { provider: 'codex', runtime: 'cli', status: 'ready', version: '0.164.0', models: [], efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', tools: ['docs.search', 'docs.read', 'docs.list'], canDisable: { ...canDisable, toolsByName: false },
    skills: ['pdf', 'doc', 'spreadsheet', 'playwright', 'security-best-practices'].map(name => ({ name })),
    commands: [command('review', 'Review uncommitted changes, or follow your review instructions', '[instructions]', 'mapped'), command('goal', 'Set, show or clear a long-running goal for this agent', '[objective | clear]', 'mapped'),
      command('init', 'Create an AGENTS.md file with instructions for this repository', '', 'mapped'), command('mcp', 'List MCP servers and their tools', '', 'mapped')],
    mcpServers: [{ name: 'docs', status: 'ready', tools: 3 }, { name: 'codex_apps', status: 'ready', tools: 205 }],
    supports: { ...NO, summary: true, sandbox: true, webSearch: true, useMcp: true, useProjectSettings: true, extraDirs: true, ultraSession: true, ultraTurn: true, thinkHard: true }, context: { percent: 31, tokens: 79000, window: 258000 }, updatedAt: now },
  a2: { provider: 'claude', runtime: 'cli', status: 'ready', version: '2.1.314', models: [{ id: 'sonnet', name: 'sonnet' }], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], canDisable,
    tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill', 'ToolSearch', 'Workflow', 'Monitor', 'SendMessage', 'TaskStop', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', ...roomTools, 'mcp__docs__search', 'mcp__docs__read', 'mcp__docs__list'],
    skills: ['frontend-design', 'pdf', 'code-review', 'security-review'].map(name => ({ name })),
    commands: [command('review', 'Review a pull request'), command('security-review', 'Complete a security review of the pending changes on the current branch'), command('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
      command('context', 'Show current context usage'), command('frontend-design', 'Create distinctive, production-grade frontend interfaces', '', 'skill'), command('code-review', 'Review the current diff', '', 'skill'), command('pdf', 'Read, merge and split PDF files', '', 'skill'),
      ...[['pr-comments', 'Get comments from a pull request'], ['memory', 'Edit memory files'], ['agents', 'Manage agent configurations'], ['mcp', 'Manage MCP servers'], ['hooks', 'Manage hook configurations'], ['plugin', 'Manage plugins'], ['skills', 'List available skills'], ['todos', 'List current todos'], ['usage', 'Show plan usage limits'], ['cost', 'Show the session cost'], ['stats', 'Show usage statistics'], ['insights', 'Report on your sessions'], ['simplify', 'Clean up changed code'], ['batch', 'Run changes across many files'], ['loop', 'Run a prompt on an interval'], ['schedule', 'Schedule a recurring task'], ['tasks', 'List background tasks'], ['output-style', 'Set the output style'], ['release-notes', 'Show the release notes'], ['fast', 'Toggle fast mode'], ['btw', 'Ask a quick side question'], ['recap', 'Summarize the session']].map(([name, description]) => command(name, description))],
    mcpServers: [{ name: 'chatroom', status: 'connected', tools: 4 }, { name: 'docs', status: 'connected', tools: 3 }], plugins: ['chatroom-shared'], agents: ['general-purpose', 'Explore', 'Plan'],
    supports: { ...NO, thinking: true, webSearch: true, useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: true, ultraSession: true, ultraTurn: true, thinkHard: true, customAgent: true }, context: { percent: 14, tokens: 28000, window: 200000 }, updatedAt: now },
  a3: { provider: 'copilot', runtime: 'cli', status: 'ready', version: '1.0.92', models: [{ id: 'auto', name: 'Auto', isDefault: true }], efforts: [], tools: [], canDisable: { ...canDisable, skills: false },
    skills: ['pdf', 'doc'].map(name => ({ name })), commands: [command('fleet', 'Run sub-agents in parallel on this request', '<prompt>'), command('review', 'Review the changes on this branch'), command('plan', 'Create a plan before coding'), command('skills', 'Manage skills')],
    mcpServers: [{ name: 'chatroom', status: 'configured' }, { name: 'docs', status: 'configured' }],
    supports: { ...NO, useMcp: true, useProjectSettings: true, extraDirs: true, ultraTurn: true, fullAccess: true, customAgent: true }, context: { percent: 8, tokens: 10000, window: 128000 }, updatedAt: now },
  a4: { provider: 'gemini', runtime: 'cli', status: 'ready', version: '0.66.0', efforts: [], tools: [], canDisable,
    models: [{ id: 'auto', name: 'Auto', description: 'Let Gemini CLI decide the best model for the task', isDefault: true }, { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro-preview' }, { id: 'gemini-3-flash-preview', name: 'gemini-3-flash-preview' }, { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro' }],
    skills: ['pdf', 'doc'].map(name => ({ name, source: 'agents-user' })), commands: [command('memory', 'Manage memory'), command('extensions', 'Manage extensions'), command('init', 'Analyze the project and create a GEMINI.md file'), command('restore', 'Restore a tool call checkpoint'), command('about', 'Show version and environment details')],
    mcpServers: [{ name: 'chatroom', status: 'configured' }, { name: 'docs', status: 'configured' }],
    supports: { ...NO, webSearch: true, useMcp: true, useSkills: true, extraDirs: true, fullAccess: true }, context: { percent: 9, tokens: 94000, window: 1048576 }, updatedAt: now }
};
const sharedSkills = [
  { name: 'frontend-design', description: 'Create distinctive, production-grade frontend interfaces with high design quality.', path: '/skills/frontend-design/SKILL.md', dir: '/skills/frontend-design', source: 'claude-plugin', nativeTo: ['claude'] },
  { name: 'pdf', description: 'Read, merge and split PDF files; fill forms and extract tables.', path: '/skills/pdf/SKILL.md', dir: '/skills/pdf', source: 'agents-user', nativeTo: ['codex', 'copilot', 'gemini'] },
  { name: 'security-best-practices', description: 'Language-specific security reviews for Python, JS/TS and Go.', path: '/skills/security/SKILL.md', dir: '/skills/security', source: 'codex-user', nativeTo: ['codex'] }];
const roomCommands = [
  ['help', 'Show Chatroom commands'], ['clear', 'Start fresh native sessions; agents forget earlier messages', '', true], ['compact', "Summarize each agent's native session to free context", '[instructions]', true],
  ['new', 'Open a new room'], ['export', 'Export this conversation as Markdown'], ['loop', "Repeat the room's work until a condition or limit", '[N | consensus | done | every 10m <prompt> | off]'],
  ['mode', 'Choose how agents collaborate', 'team | relay | parallel | custom'], ['lead', 'Choose the lead for Team mode', '<agent>'],
  ['team', 'Set up your own team: stages such as lead, drafting, review, testing', '[name | Lead: Claude > Draft: Codex > … | save <name> | edit | off]'], ['model', 'Set the model of the mentioned agent', '<model>', true],
  ['effort', 'Set reasoning effort for the mentioned agents (or all)', '<level>', true], ['permissions', 'Set what agents may do without asking', 'plan | ask | auto | full', true],
  ['status', 'Show sessions, models and context use', '', true], ['stop', 'Stop all running agents'],
  ['worktrees', 'Give agents their own git worktrees so parallel edits never collide', 'off | auto | always | status | apply | keep [name] | discard | cleanup'], ['sandbox', 'Run a command or code in a throwaway Docker container on a copy of the folder (you approve each run)', '<command> | python|node|bash <code> | on | off | status']
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
const otherChats = [{ id: 'r2', title: 'Add a CSV export to the report page, with tests', messages: 12, changes: true }, { id: 'r3', title: 'Explain how loops stop', messages: 4, changes: false }, { id: 'r4', title: 'Check the parser in isolation', messages: 9, changes: false }, { id: 'r5', title: 'New conversation', messages: 0, changes: false }];
const state = room => ({ type: 'state', workspace: 'chatroom', trusted: true, discovering: false, modelDefaults: { planning: {}, drafting: {}, review: {} }, defaultPreset: 'planning', executionMode: 'orchestrated', maxParallelAgents: 3,
  rooms: [{ id: 'demo', title: room.title, messages: room.messages.length, changes: false }, ...otherChats], connections, capabilities, editor, sharedSkills, roomCommands, teams,
  settings: { allowFullAccess: false, attachOpenFile: true, approvalTimeoutSeconds: 300 }, localModels: { vision: 'glm-ocr:latest', embedding: 'embeddinggemma:latest' }, room });
const running = room({ status: 'running', activeAgents: ['a3', 'a4'], currentAgent: 'a3', queuedTurns: 1, completedTurns: 2, documents: documents(true),
  agentStates: { a1: { status: 'complete' }, a2: { status: 'queued' }, a3: { status: 'thinking' }, a4: { status: 'thinking' } },
  messages: [user, plan(['complete', 'running', 'running', 'pending']), tool, s1, { ...s2, status: 'streaming', text: 'The only cancellation test uses a child that exits on the first signal. Missing:' }, { ...s3, status: 'streaming', text: 'The design document makes two promises the code does not keep. Page 4: a stopped turn ends within 5 seconds, but' }] });
const fixing = room({ title: 'Run the tests and fix what fails', mode: 'parallel', status: 'running', activeAgents: ['a1', 'a2'], completedTurns: 1,
  agentStates: { a1: { status: 'approval', detail: 'apply_patch' }, a2: { status: 'approval', detail: 'Bash' }, a3: { status: 'complete' }, a4: { status: 'complete' } },
  messages: [{ ...user, text: 'Run the tests and fix what fails.' },
    approvalRequest('ap1', 'a2', 'claude', 'command', 'Bash', 'npm test -- tests/process.test.ts', { detail: 'Run the process tests', status: 'pending' }),
    approvalRequest('ap2', 'a1', 'codex', 'edit', 'apply_patch', 'src/process.ts', { status: 'pending',
      diff: '--- a/src/process.ts\n+++ b/src/process.ts\n@@ -456,4 +456,6 @@ export function runJsonLines(\n-    later(STOP_GRACE_MS, () => signalTree(true));\n+    later(STOP_GRACE_MS, () => {\n+      if (closed) return; signalTree(true);\n+      later(RELEASE_GRACE_MS, release);\n+    });' })] });
// A custom team run: Codex is out of usage, so Claude stands in for the Drafting stage.
const back = Date.now() + 2 * 86400000, backText = new Date(back).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const { builtIn: _, ...template } = teams[0];
const ownTeam = { ...template, stages: template.stages.map(s => s.name === 'Review' ? { ...s, agents: ['Claude', 'Gemini'] } : s) };
const teamRun = room({ title: 'Add a CSV export to the report page', mode: 'pipeline', team: ownTeam, status: 'running', activeAgents: ['a2'], currentAgent: 'a2', completedTurns: 1,
  progress: { stage: 2, total: 3, name: 'Drafting' },
  agents: agents.map(a => a.id === 'a1' ? { ...a, unavailable: { reason: 'usage-limit', detail: 'Codex usage limit reached.', at: now, until: back } } : a),
  agentStates: { a1: { status: 'unavailable', detail: `out of usage until ${backText}` }, a2: { status: 'thinking' }, a4: { status: 'queued' } },
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
// Claude asks to run the tests in the sandbox; you allowed it; the run card shows the result.
const sbxDetail = 'Why: Run the parser tests after the tokenizer change\nImage: python:3.12-slim\nProfile: test · a writable copy\nNetwork: off\nFiles: a copy of the workspace\nLimits: 2 CPUs · 2048 MB memory · 120 s · 512 processes\n\nCommand:\npython -m pytest -q tests/test_parser.py';
const sbxApproval = { id: 'sbx-ap', kind: 'approval', agentId: 'a2', author: 'Claude', status: 'complete', createdAt: now, text: 'python -m pytest -q tests/test_parser.py',
  approval: { id: 'ap-sbx', agentId: 'a2', provider: 'claude', kind: 'sandbox', tool: 'sandbox', title: 'python -m pytest -q tests/test_parser.py', detail: sbxDetail, canAllowSession: false, status: 'pending', createdAt: now, expiresAt: Date.now() + 285000 } };
const sbxRun = { id: 'sbx-run', kind: 'notice', author: 'Sandbox', status: 'complete', createdAt: now, text: 'Sandbox · python -m pytest · exit code 0',
  sandbox: { id: 'r1', status: 'done', image: 'python:3.12-slim', profile: 'test', network: false, command: 'python -m pytest -q tests/test_parser.py', purpose: 'Run the parser tests after the tokenizer change',
    limits: { cpus: 2, memoryMb: 2048, timeoutSeconds: 120 }, exitCode: 0, durationMs: 4200, stdout: '............                                                             [100%]\n12 passed in 0.41s\n', stderr: '',
    files: [{ path: 'reports/junit.xml', size: 3380, text: '<?xml version="1.0"?>\n<testsuite name="pytest" tests="12" failures="0"/>' }], requestedBy: 'Claude', agentId: 'a2', createdAt: now, startedAt: now, finishedAt: now + 4200 } };
const sbxRoom = room({ title: 'Check the parser in isolation', mode: 'sequential', completedTurns: 1,
  messages: [{ ...user, text: 'Change the tokenizer to keep comments, and check the parser tests still pass. Run the tests in the sandbox.' },
    say('t1', 'a2', 'Claude', 'Tokenizer updated. I want to run the parser tests in an isolated container first.'),
    { ...sbxApproval, approval: { ...sbxApproval.approval, status: 'allowed', decidedAt: now } }, sbxRun,
    say('t2', 'a2', 'Claude', 'All 12 parser tests pass in the sandbox. Here is the quick check I used, if you want to run it yourself:\n\n```python\nfrom parser import parse\nprint(parse("a = 1  # keep me"))\n```'),
    { ...sbxApproval, id: 'sbx-ap2', approval: { ...sbxApproval.approval, id: 'ap-sbx2', title: 'Run Python code in the sandbox (2 lines)', detail: sbxDetail.replace('Run the parser tests after the tokenizer change', 'Check that comments survive parsing').replace('Command:\npython -m pytest -q tests/test_parser.py', 'Python code:\nfrom parser import parse\nprint(parse("a = 1  # keep me"))') } }] });
const done = room({ documents: documents(false), messages: [user, plan(['complete', 'complete', 'complete', 'complete']), tool, s1, s2, s3, s4, final] });
// Items turned off: in the Tools tab they stay listed, struck through.
const withOff = (id, disabled) => ({ ...state({ ...done, agents: agents.map(a => a.id === id ? { ...a, options: { ...a.options, disabled } } : a) }) });
const switches = withOff('a2', { tools: ['WebFetch', 'WebSearch'], skills: ['security-review'], mcpServers: ['docs'], commands: ['init', 'batch'] });
const geminiOff = withOff('a4', { tools: ['web_fetch', 'run_shell_command'], skills: ['doc'] });
// Gemini CLI too old: found, explained, and not started.
const tooOld = 'Gemini CLI 0.1.18 is too old: Chatroom needs 0.38.0 or newer. Update it: npm i -g @google/gemini-cli@latest';
const outdated = { ...state(done), capabilities: { ...capabilities, a4: { provider: 'gemini', runtime: 'cli', status: 'missing', detail: tooOld, action: 'updateGemini', version: '0.1.18', models: [], efforts: [], tools: [], skills: [], commands: [], mcpServers: [], supports: { ...NO }, updatedAt: now } } };

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
  // click: selectors to click in order before the screenshot (an agent pill opens its settings, a chip opens its popover).
  // only: capture just this element instead of the page.
  const shoot = async (file, data, { width, height, tab, scrollTo, collapseAgents, slash, section, openTeam, click, only }) => {
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
    for (const selector of [click ?? []].flat()) { await page.locator(selector).first().click(); await page.waitForTimeout(250); }
    if (openTeam) { await page.evaluate(() => window.postMessage({ type: 'openTeam' }, '*')); await page.locator('.dialog').waitFor(); }
    if (slash) { await page.locator('#prompt').click(); await page.locator('#prompt').pressSequentially(slash); await page.locator('#menu:not([hidden])').waitFor(); }
    // A click leaves the pointer over whatever moved under it; no hover state in the picture.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    await (only ? page.locator(only).first() : tab ? page.locator('#inspector') : page).screenshot({ path: `${out}/${file}` });
    await page.close();
    console.log(`Saved ${out}/${file}`);
  };
  await shoot('lead-team.png', state(running), { width: 1100, height: 1300, scrollTo: '.message.user' });
  await shoot('final-answer.png', state(done), { width: 1100, height: 1180 });
  await shoot('sidebar.png', state(running), { width: 420, height: 1000, scrollTo: '.message.turn-plan', collapseAgents: true });
  await shoot('tools.png', state(done), { width: 1100, height: 1580, tab: 'tools' });
  await shoot('documents.png', state(done), { width: 1100, height: 1220, tab: 'tools', section: 'SHARED WITH THE ROOM' });
  await shoot('usage.png', state(done), { width: 1100, height: 1480, tab: 'usage' });
  await shoot('approvals.png', state(fixing), { width: 420, height: 1000 });
  await shoot('commands.png', state(done), { width: 420, height: 1000, slash: '/' });
  await shoot('team-run.png', state(teamRun), { width: 420, height: 1000 });
  await shoot('sandbox.png', { ...state(sbxRoom), settings: { ...state(sbxRoom).settings, sandbox: { enabled: true, available: true, detail: 'Docker 29.5.3' } } }, { width: 420, height: 1500 });
  await shoot('changes.png', { ...state(isolated), settings: { ...state(isolated).settings, worktrees: 'auto', worktreesAvailable: true } }, { width: 420, height: 1000 });
  await shoot('team.png', state(room({ ...done, mode: 'pipeline', team: ownTeam })), { width: 1100, height: 1300, openTeam: true });
  await shoot('agent-settings.png', state(done), { width: 1100, height: 1300, click: '[data-agent="a2"]' });
  await shoot('unavailable.png', state(teamRun), { width: 1100, height: 1000, click: '[data-agent="a1"]' });
  await shoot('loop.png', state(done), { width: 420, height: 1000, click: '#chip-loop' });
  await shoot('team-popover.png', state(room({ ...done, mode: 'pipeline', team: ownTeam })), { width: 420, height: 1000, click: '#chip-team' });
  const card = id => `.caps-card:has([data-caps-refresh="${id}"])`;
  await shoot('chats.png', state(done), { width: 420, height: 380, click: ['#rooms', '[data-room-delete="r2"]'] });
  await shoot('add-agent.png', state(done), { width: 1100, height: 1000, click: 'nav [data-action="add"]', only: '.dialog' });
  await shoot('tool-switches.png', switches, { width: 1100, height: 1500, tab: 'tools', click: '[data-caps-more="a2:commands"]', only: card('a2') });
  await shoot('gemini-tools.png', geminiOff, { width: 1100, height: 1500, tab: 'tools', only: card('a4') });
  await shoot('gemini-settings.png', state(done), { width: 1100, height: 1500, click: ['[data-agent="a4"]', '#agent-advanced summary'], only: '.dialog' });
  await shoot('gemini-update.png', outdated, { width: 1100, height: 1500, tab: 'tools', only: card('a4') });
} finally { await browser.close(); await new Promise(r => server.close(r)); }
