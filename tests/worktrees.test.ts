import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RoomWorktrees, WorktreeManager, cleanCodexTrust, gitEnv, removeCodexTrust, worktreeRoot } from '../src/worktrees';
import { Agent, Room, WorktreeMode } from '../src/types';
import { testAgent, testRoom } from './helpers';

const skip = spawnSync('git', ['--version'], { windowsHide: true }).status === 0 ? false : 'git is not installed';
const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }) }).trim();
const fails = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, windowsHide: true, env: gitEnv() }).status !== 0;
const write = (root: string, rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const lines = (tag: string) => Array.from({ length: 9 }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';
const edit = (root: string, rel: string, from: string, to: string) => write(root, rel, read(root, rel).replace(from, to));
/** A committed repository in a temp folder whose path has a space, like most Windows profiles. */
function repo(files: Record<string, string> = { 'a.txt': lines('a'), 'b.txt': lines('b') }, now?: () => number) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'chatroom wt '))), path = join(dir, 'my repo');
  mkdirSync(path);
  git(path, 'init', '-q');
  git(path, 'config', 'commit.gpgSign', 'false');
  for (const [name, text] of Object.entries(files)) write(path, name, text);
  git(path, 'add', '-A'); git(path, 'commit', '-q', '-m', 'init');
  const manager = new WorktreeManager({ repo: path, root: join(dir, 'wt'), ...(now ? { now } : {}) });
  return { dir, path, manager, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
}
const ROOM = 'room-aaaa-1111';

test('snapshot: HEAD plus uncommitted and untracked (not ignored) files; the user\'s index and status stay as they were', { skip }, async () => {
  const { path, manager, done } = repo({ 'a.txt': 'one\n', '.gitignore': 'secret.txt\n' });
  try {
    write(path, 'a.txt', 'one changed\n'); write(path, 'staged.txt', 'staged\n'); write(path, 'untracked.txt', 'loose\n'); write(path, 'secret.txt', 'hidden\n');
    git(path, 'add', 'staged.txt');
    const index = readFileSync(join(path, '.git', 'index')), status = git(path, 'status', '--porcelain');
    const base = await manager.snapshot();
    assert.equal(git(path, 'show', `${base}:a.txt`), 'one changed');
    assert.equal(git(path, 'show', `${base}:staged.txt`), 'staged');
    assert.equal(git(path, 'show', `${base}:untracked.txt`), 'loose');
    assert.ok(fails(path, 'cat-file', '-e', `${base}:secret.txt`), 'ignored files stay out');
    assert.equal(git(path, 'rev-parse', `${base}^`), git(path, 'rev-parse', 'HEAD'));
    assert.equal(git(path, 'log', '-1', '--format=%s|%an <%ae>', base), 'Chatroom base|Chatroom <chatroom@localhost>');
    assert.deepEqual(readFileSync(join(path, '.git', 'index')), index, 'the user\'s index is untouched');
    assert.equal(git(path, 'status', '--porcelain'), status);
    assert.equal(read(path, 'a.txt'), 'one changed\n');
  } finally { done(); }
});

test('ensure, checkpoint and changes: a reusable worktree on its own branch, commits as Chatroom, never the user\'s hooks', { skip }, async () => {
  const { dir, path, manager, done } = repo();
  try {
    const marker = join(dir, 'hook-ran').replace(/\\/g, '/');
    for (const hook of ['post-checkout', 'post-commit', 'pre-commit']) writeFileSync(join(path, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    const base = await manager.snapshot();
    const made = await manager.ensure(ROOM, 'Claude 1', base);
    assert.deepEqual(made, { path: join(dir, 'wt', 'roomaa-claude-1'), branch: 'chatroom/roomaa/claude-1', created: true });
    assert.equal((await manager.ensure(ROOM, 'Claude 1', base)).created, false, 'an existing worktree is reused');
    assert.match(git(path, 'worktree', 'list', '--porcelain'), /locked chatroom room-aaaa-1111 claude-1/);
    edit(made.path, 'a.txt', 'a2\n', 'a2 changed\n'); unlinkSync(join(made.path, 'b.txt')); write(made.path, 'c.txt', 'new\nfile\n');
    const sha = await manager.checkpoint(made.path, 'turn 1 · step s1');
    assert.match(sha!, /^[0-9a-f]{40}$/);
    assert.equal(await manager.checkpoint(made.path, 'turn 2'), undefined, 'nothing changed');
    assert.equal(git(made.path, 'log', '-1', '--format=%s|%an <%ae>'), 'turn 1 · step s1|Chatroom <chatroom@localhost>');
    const changes = await manager.changes(base, made.branch);
    assert.deepEqual(changes.files.sort((x, y) => x.path.localeCompare(y.path)), [
      { path: 'a.txt', added: 1, removed: 1, status: 'M' }, { path: 'b.txt', added: 0, removed: 9, status: 'D' }, { path: 'c.txt', added: 2, removed: 0, status: 'A' }]);
    assert.deepEqual([changes.added, changes.removed], [3, 10]);
    assert.match(await manager.diff(base, made.branch), /^-a2\n\+a2 changed$/m);
    assert.equal(existsSync(marker), false, 'no hook ran');
    assert.equal(read(path, 'a.txt'), lines('a'), 'the user\'s folder is untouched');
    assert.deepEqual((await manager.list()).map(w => [w.roomId, w.key, w.branch]), [[ROOM, 'claude-1', 'chatroom/roomaa/claude-1']]);
    assert.match(worktreeRoot('/storage', path), /[\\/]wt[\\/][0-9a-f]{6}$/);
    if (process.platform === 'win32') assert.equal(worktreeRoot('/storage', path.toUpperCase()), worktreeRoot('/storage', path), 'Windows paths compare without case');
  } finally { done(); }
});

test('integrate: two clean branches combine, then a clean worktree fast-forwards to the combined work', { skip }, async () => {
  const { path, manager, done } = repo();
  try {
    const base = await manager.snapshot();
    const alpha = await manager.ensure(ROOM, 'alpha', base), beta = await manager.ensure(ROOM, 'beta', base);
    edit(alpha.path, 'a.txt', 'a1\n', 'alpha1\n'); await manager.checkpoint(alpha.path, 'alpha');
    edit(beta.path, 'b.txt', 'b1\n', 'beta1\n'); await manager.checkpoint(beta.path, 'beta');
    const branches = [{ key: 'alpha', branch: alpha.branch }, { key: 'beta', branch: beta.branch }];
    const result = await manager.integrate(ROOM, base, branches);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.branch, 'chatroom/roomaa/integration');
    assert.match(read(result.path, 'a.txt'), /^alpha1$/m); assert.match(read(result.path, 'b.txt'), /^beta1$/m);
    assert.deepEqual((await manager.changes(base, result.branch)).files.map(f => f.path).sort(), ['a.txt', 'b.txt']);
    const tip = git(path, 'rev-parse', result.branch);
    await manager.integrate(ROOM, base, branches);
    assert.equal(git(path, 'rev-parse', result.branch), tip, 'branches without new commits are skipped');
    await manager.sync(alpha.path, result.branch);
    assert.match(read(alpha.path, 'b.txt'), /^beta1$/m, 'other agents\' work reaches a worktree when the room combines it');
    write(path, 'later.txt', 'new base\n');
    const next = await manager.snapshot();
    await manager.integrate(ROOM, next, []);
    assert.equal(git(path, 'rev-parse', result.branch), next, 'an integration left from an earlier base starts again from the new one');
  } finally { done(); }
});

test('integrate reports a conflicting branch and never leaves the integration mid-merge; mergeInto, resolve, finishMerge, then it combines', { skip }, async () => {
  const { path, manager, done } = repo();
  try {
    const base = await manager.snapshot();
    const alpha = await manager.ensure(ROOM, 'alpha', base), beta = await manager.ensure(ROOM, 'beta', base);
    edit(alpha.path, 'a.txt', 'a5\n', 'alpha5\n'); await manager.checkpoint(alpha.path, 'alpha');
    edit(beta.path, 'a.txt', 'a5\n', 'beta5\n'); edit(beta.path, 'b.txt', 'b9\n', 'beta9\n'); await manager.checkpoint(beta.path, 'beta');
    const branches = [{ key: 'alpha', branch: alpha.branch }, { key: 'beta', branch: beta.branch }];
    const first = await manager.integrate(ROOM, base, branches);
    assert.deepEqual(first.conflicts, [{ key: 'beta', files: ['a.txt'] }]);
    assert.ok(fails(first.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'no merge in progress');
    assert.equal(git(first.path, 'status', '--porcelain'), '');
    assert.match(read(first.path, 'a.txt'), /^alpha5$/m); assert.doesNotMatch(read(first.path, 'a.txt'), /<<<<<<<|beta/);

    assert.deepEqual(await manager.mergeInto(beta.path, first.branch), ['a.txt']);
    assert.match(read(beta.path, 'a.txt'), /^<<<<<<< /m);
    assert.equal(await manager.finishMerge(beta.path), false, 'markers are still there');
    await manager.abortMerge(beta.path);
    assert.ok(fails(beta.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')); assert.match(read(beta.path, 'a.txt'), /^beta5$/m);

    assert.deepEqual(await manager.mergeInto(beta.path, first.branch), ['a.txt']);
    write(beta.path, 'a.txt', read(beta.path, 'a.txt').replace(/<<<<<<< [^\n]*\n[\s\S]*?>>>>>>> [^\n]*\n/, 'alpha5 beta5\n'));
    assert.equal(await manager.finishMerge(beta.path), true);
    assert.ok(fails(beta.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
    const again = await manager.integrate(ROOM, base, branches);
    assert.deepEqual(again.conflicts, []);
    assert.match(read(again.path, 'a.txt'), /^alpha5 beta5$/m); assert.match(read(again.path, 'b.txt'), /^beta9$/m);
    assert.equal(git(path, 'status', '--porcelain'), '', 'the user\'s folder never changed');
  } finally { done(); }
});

test('apply keeps the user\'s own edit made after the snapshot, writes the working tree only, and leaves a conflicting file alone', { skip }, async () => {
  const { path, manager, done } = repo();
  try {
    write(path, 'notes.txt', 'mine\n');
    const base = await manager.snapshot();
    const agent = await manager.ensure(ROOM, 'codex', base);
    edit(agent.path, 'a.txt', 'a8\n', 'agent8\n'); write(agent.path, 'src/new file.txt', 'added\n'); edit(agent.path, 'notes.txt', 'mine\n', 'mine\nagent note\n');
    await manager.checkpoint(agent.path, 'work');
    const { branch } = await manager.integrate(ROOM, base, [{ key: 'codex', branch: agent.branch }]);
    edit(path, 'a.txt', 'a2\n', 'user2\n');
    const index = readFileSync(join(path, '.git', 'index'));
    const result = await manager.apply(base, branch);
    assert.deepEqual(result, { ok: true, conflicts: [], output: '' });
    assert.match(read(path, 'a.txt'), /^user2$/m); assert.match(read(path, 'a.txt'), /^agent8$/m);
    assert.equal(read(path, 'src/new file.txt'), 'added\n'); assert.equal(read(path, 'notes.txt'), 'mine\nagent note\n');
    assert.deepEqual(readFileSync(join(path, '.git', 'index')), index, 'nothing is staged');
    assert.equal(git(path, 'diff', '--cached', '--name-only'), '');

    // A second round where the user changed the same line as the agent: that file is reported and left as the user has it.
    const base2 = await manager.snapshot();
    const second = await manager.ensure('room-bbbb', 'codex', base2);
    edit(second.path, 'b.txt', 'b3\n', 'agent3\n'); edit(second.path, 'a.txt', 'a9\n', 'agent9\n');
    await manager.checkpoint(second.path, 'more');
    const combined = await manager.integrate('room-bbbb', base2, [{ key: 'codex', branch: second.branch }]);
    edit(path, 'b.txt', 'b3\n', 'user3\n');
    const clash = await manager.apply(base2, combined.branch);
    assert.equal(clash.ok, false); assert.deepEqual(clash.conflicts, ['b.txt']);
    assert.match(read(path, 'b.txt'), /^user3$/m); assert.doesNotMatch(read(path, 'b.txt'), /agent3|<<<<<<</);
    assert.match(read(path, 'a.txt'), /^agent9$/m, 'the parts that merge cleanly are applied');
  } finally { done(); }
});

test('remove unlinks linked folders first: the shared target and its files survive, even a link the agent made itself', { skip }, async () => {
  // node_modules is not ignored here, so only Chatroom's exclusion keeps the linked folder out of commits; .env is ignored.
  const { dir, path, manager, done } = repo({ 'a.txt': 'a\n', '.gitignore': '.env\n' });
  try {
    write(path, '.env', 'KEY=1\n'); write(dir, 'outside/keep.txt', 'precious\n');
    const base = await manager.snapshot();
    // Made after the snapshot, so the worktree has no such folder and gets the link.
    write(path, 'node_modules/pkg/index.js', 'shared\n');
    const made = await manager.ensure(ROOM, 'claude', base, { links: ['node_modules', '../escape', 'missing'], copy: ['.env', 'C:/abs', 'nope.txt'] });
    assert.equal(lstatSync(join(made.path, 'node_modules')).isSymbolicLink(), true);
    assert.equal(read(made.path, 'node_modules/pkg/index.js'), 'shared\n');
    assert.equal(read(made.path, '.env'), 'KEY=1\n');
    assert.equal(existsSync(join(dirname(made.path), 'escape')), false);
    write(made.path, 'b.txt', 'work\n');
    await manager.checkpoint(made.path, 'work');
    assert.deepEqual(git(made.path, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['b.txt'], 'links and copies are never committed');
    symlinkSync(join(dir, 'outside'), join(made.path, 'agent-link'), LINK);
    await manager.remove(ROOM);
    assert.equal(existsSync(made.path), false);
    assert.equal(read(path, 'node_modules/pkg/index.js'), 'shared\n');
    assert.equal(read(dir, 'outside/keep.txt'), 'precious\n');
    assert.ok(fails(path, 'rev-parse', '--verify', '-q', made.branch), 'the branch is deleted');
    assert.deepEqual(await manager.list(), []);
    assert.doesNotMatch(git(path, 'worktree', 'list'), /roomaa/);
  } finally { done(); }
});

test('keep: the combined work becomes chatroom/kept/<name> and survives removal; a used name gets a suffix', { skip }, async () => {
  const { path, manager, done } = repo();
  try {
    const base = await manager.snapshot();
    const agent = await manager.ensure(ROOM, 'codex', base);
    edit(agent.path, 'a.txt', 'a1\n', 'kept1\n'); await manager.checkpoint(agent.path, 'work');
    const { branch } = await manager.integrate(ROOM, base, [{ key: 'codex', branch: agent.branch }]);
    const tip = git(path, 'rev-parse', branch);
    assert.equal(await manager.keep(ROOM, 'Login fix: v2!', ['codex']), 'chatroom/kept/Login-fix-v2');
    assert.equal(git(path, 'rev-parse', 'chatroom/kept/Login-fix-v2'), tip);
    assert.equal(git(path, 'rev-parse', 'chatroom/kept/Login-fix-v2-codex'), git(path, 'rev-parse', agent.branch));
    assert.equal(await manager.keep(ROOM, 'Login fix: v2!'), 'chatroom/kept/Login-fix-v2-2');
    await manager.remove(ROOM);
    assert.equal(git(path, 'rev-parse', 'chatroom/kept/Login-fix-v2'), tip);
    assert.ok(fails(path, 'rev-parse', '--verify', '-q', branch));
    await assert.rejects(manager.keep('room-none', 'x'), /no combined changes to keep/);
  } finally { done(); }
});

test('sweep removes the worktrees of rooms that no longer exist, keeps branches with work, and leaves live rooms alone', { skip }, async () => {
  const at = new Date(2026, 9, 7, 9, 30).getTime();
  const { path, manager, done } = repo(undefined, () => at);
  try {
    const base = await manager.snapshot();
    const dead = await manager.ensure('deadroom-1', 'codex', base), solo = await manager.ensure('deadroom-1', 'solo', base), idle = await manager.ensure('deadroom-1', 'idle', base);
    edit(dead.path, 'a.txt', 'a1\n', 'dead1\n'); await manager.checkpoint(dead.path, 'work');
    edit(solo.path, 'b.txt', 'b1\n', 'solo1\n'); await manager.checkpoint(solo.path, 'never combined');
    const combined = await manager.integrate('deadroom-1', base, [{ key: 'codex', branch: dead.branch }]);
    const live = await manager.ensure('liveroom-1', 'codex', base);
    mkdirSync(join(manager.root, 'zzzzzz-stray'));
    const tips = [git(path, 'rev-parse', combined.branch), git(path, 'rev-parse', solo.branch)];
    const result = await manager.sweep(new Set(['liveroom-1']));
    assert.deepEqual(result.keptBranches, ['chatroom/orphaned/deadro-20261007-0930', 'chatroom/orphaned/deadro-20261007-0930-solo']);
    assert.deepEqual(result.keptBranches.map(b => git(path, 'rev-parse', b)), tips, 'the combined work and the work never combined are kept');
    for (const gone of [dead.path, solo.path, idle.path, combined.path, join(manager.root, 'zzzzzz-stray')]) assert.equal(existsSync(gone), false, gone);
    assert.ok(result.removed.length >= 4);
    for (const branch of [dead.branch, solo.branch, idle.branch, combined.branch]) assert.ok(fails(path, 'rev-parse', '--verify', '-q', branch), branch);
    assert.equal(existsSync(live.path), true);
    assert.deepEqual((await manager.list()).map(w => w.roomId), ['liveroom-1']);
  } finally { done(); }
});

test('removeCodexTrust removes only trust-only sections inside the root, in any case, slash or quoting, and keeps line endings', () => {
  const root = 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\chatroom-local.chatroom\\wt\\abc123';
  const text = ['model = "gpt-5"', '',
    '[projects.\'C:\\Users\\me\\src\\app\']', 'trust_level = "trusted"', '',
    '[projects.\'c:/users/me/appdata/roaming/code/user/globalstorage/chatroom-local.chatroom/wt/abc123/roomaa-claude-1\']', 'trust_level = "trusted"', '',
    `[projects."${root.replace(/\\/g, '\\\\')}\\\\roomaa-integration"]`, 'trust_level = "trusted"', '',
    `[projects.'${root}\\roomaa-codex-1']`, 'trust_level = "trusted"', '# keep me', '',
    `[projects.'${root}\\roomaa-x']`, 'trust_level = "trusted"', 'other = 1', '',
    `[projects.'${root}2\\roomaa-y']`, 'trust_level = "trusted"', '',
    '[mcp_servers.mem]', 'command = "mem.exe"', ''].join('\n');
  const out = removeCodexTrust(text, root);
  assert.doesNotMatch(out, /roomaa-claude-1|roomaa-integration/);
  for (const kept of ['src\\app', 'roomaa-codex-1\']\ntrust_level = "trusted"\n# keep me', 'roomaa-x', 'abc1232\\roomaa-y', '[mcp_servers.mem]\ncommand = "mem.exe"\n']) assert.ok(out.includes(kept), kept);
  assert.equal(out.split('[projects.').length, 5);
  assert.ok(out.endsWith('\n'));
  assert.equal(removeCodexTrust(text.replace(/\n/g, '\r\n'), root), out.replace(/\n/g, '\r\n'), 'CRLF files keep CRLF');
  assert.equal(removeCodexTrust('[projects.\'D:\\x\']\ntrust_level = "trusted"\n', root), '[projects.\'D:\\x\']\ntrust_level = "trusted"\n');
  assert.equal(removeCodexTrust(text, ''), text);
});

test('cleanCodexTrust writes the user\'s config only when it changed', async () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'chatroom codex '))), root = join(home, 'wt', 'abc123');
  try {
    writeFileSync(join(home, 'config.toml'), `model = "x"\n\n[projects.'${join(root, 'roomaa-codex-1')}']\ntrust_level = "trusted"\n`);
    assert.equal(await cleanCodexTrust(root, home), true);
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'model = "x"\n');
    assert.equal(await cleanCodexTrust(root, home), false);
    assert.equal(await cleanCodexTrust(root, join(home, 'missing')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── The host's isolation ──────────────────────────────────────────────────────
function isolation(manager: WorktreeManager | undefined, mode: () => WorktreeMode = () => 'auto') {
  const toasts: string[] = [], logs: string[] = [], released: string[] = [];
  const host = new RoomWorktrees({ manager: () => manager, mode: room => room.worktrees ?? mode(), native: agent => agent.provider !== 'ollama', copy: () => [], links: () => [], autoApply: () => false,
    log: text => { logs.push(text); }, toast: (type, text) => { toasts.push(`${type}: ${text}`); }, release: async roomId => { released.push(roomId); }, changed: () => {} });
  return { host, toasts, logs, released };
}
function team(): Room & { agents: [Agent, Agent, Agent] } {
  const room = testRoom([testAgent('codex', { id: '1a2b3c4d-codex', options: { permission: 'auto-edit' } as Agent['options'] }), testAgent('claude', { id: '5e6f7a8b-claude', options: { permission: 'full' } as Agent['options'] }),
    testAgent('copilot', { id: '9c0d1e2f-copilot', options: { permission: 'plan' } as Agent['options'] })]);
  room.mode = 'parallel';
  return room as Room & { agents: [Agent, Agent, Agent] };
}

test('wants: off, auto (an agent that edits without asking, with another editor, in a parallel, team or custom room), always, and agent.isolate', () => {
  let mode: WorktreeMode = 'auto';
  const manager = new WorktreeManager({ repo: tmpdir(), root: join(tmpdir(), 'unused') });
  const { host } = isolation(manager, () => mode), room = team(), [codex, claude, copilot] = room.agents;
  assert.deepEqual(room.agents.map(a => host.wants(a, room)), [true, true, false]);
  assert.equal(host.wants(codex, room, 'direct'), false, 'a 1:1 turn runs alone');
  room.mode = 'sequential'; assert.equal(host.wants(codex, room), false, 'relay runs one agent at a time');
  room.mode = 'orchestrated'; assert.equal(host.wants(codex, room), true);
  claude.options.permission = 'plan'; assert.equal(host.wants(codex, room), false, 'nobody else can edit');
  claude.options.permission = 'ask'; assert.equal(host.wants(codex, room), true);
  codex.options.permission = 'ask'; assert.equal(host.wants(codex, room), false, 'an agent that asks first is not isolated in auto');
  mode = 'always'; assert.deepEqual(room.agents.map(a => host.wants(a, room)), [true, true, false]);
  mode = 'off'; assert.deepEqual(room.agents.map(a => host.wants(a, room)), [false, false, false]);
  copilot.isolate = true; assert.equal(host.wants(copilot, room), true, 'the user (or the agent) asked for it');
  room.worktrees = 'always'; assert.equal(host.wants(codex, room), true, 'the room overrides the setting');
  assert.equal(isolation(undefined).host.wants(copilot, room), false, 'not a git repository');
  assert.equal(isolation(manager).host.wants(testAgent('ollama', { isolate: true }), room), false, 'chat models never isolate');
  assert.equal(host.keyOf(codex), 'codex-1a2b3'); assert.equal(host.branchFor(room, codex), 'chatroom/room1/codex-1a2b3');
});

test('RoomWorktrees: prepare stores the base, checkpoints count, integrate fills room.changes, apply updates the card and drops every worktree', { skip }, async () => {
  const { path, manager, done } = repo();
  try {
    const { host, toasts, released } = isolation(manager), room = team(), [codex, claude] = room.agents;
    const codexPath = await host.prepare(room, codex), claudePath = await host.prepare(room, claude);
    assert.equal(room.changes!.status, 'ready'); assert.equal(room.changes!.branch, 'chatroom/room1/integration'); assert.equal(room.changes!.files.length, 0);
    assert.equal(git(path, 'rev-parse', `${room.changes!.base}^`), git(path, 'rev-parse', 'HEAD'));
    assert.deepEqual(codex.worktree, { path: codexPath, branch: 'chatroom/room1/codex-1a2b3', createdAt: codex.worktree!.createdAt, checkpoints: 0 });
    assert.equal(host.cwdFor(room, codex), codexPath); assert.equal(host.cwdFor({ ...room, id: 'other-room' }, codex), undefined, 'only in its own room');
    edit(codexPath, 'a.txt', 'a1\n', 'codex1\n'); edit(claudePath, 'b.txt', 'b1\n', 'claude1\n');
    await host.checkpoint(room, codex, 'turn 1'); await host.checkpoint(room, claude, 'turn 2'); await host.checkpoint(room, claude, 'turn 3');
    assert.deepEqual([codex.worktree!.checkpoints, claude.worktree!.checkpoints], [1, 1]);
    assert.deepEqual(await host.integrate(room), { conflicts: [] });
    assert.deepEqual(room.changes!.files.map(f => f.path).sort(), ['a.txt', 'b.txt']); assert.equal(room.changes!.status, 'ready');
    assert.match(read(codexPath, 'b.txt'), /^claude1$/m, 'clean agents catch up with the combined work');
    assert.match(await host.review(room, true), /\+codex1[\s\S]*\+claude1|\+claude1[\s\S]*\+codex1/);
    room.messages.push({ id: 'card', kind: 'notice', author: 'Chatroom', text: '', createdAt: 0, status: 'complete', changes: { ...room.changes! } });
    edit(path, 'a.txt', 'a5\n', 'user5\n');
    assert.equal(await host.apply(room), true);
    assert.deepEqual(toasts, ['notice: Applied 2 files to your folder. They are not committed.']);
    assert.match(read(path, 'a.txt'), /^codex1$/m); assert.match(read(path, 'a.txt'), /^user5$/m); assert.match(read(path, 'b.txt'), /^claude1$/m);
    assert.equal(room.messages[0]!.changes!.status, 'applied'); assert.match(room.messages[0]!.text, /^Applied 2 files \(\+2 −2\) to your folder\. They are not committed\.$/);
    assert.equal(room.changes, undefined); assert.equal(codex.worktree, undefined); assert.equal(claude.worktree, undefined);
    assert.deepEqual(released, [room.id]);
    assert.equal(existsSync(codexPath), false); assert.deepEqual(await manager.list(), []);
    await assert.rejects(host.apply(room), /no changes from the agents to apply/);
  } finally { done(); }
});

test('RoomWorktrees: a conflict blocks apply; keep saves the combined work and the conflicting branch; discard removes everything', { skip }, async () => {
  const { path, manager, done } = repo();
  try {
    const { host, toasts } = isolation(manager), room = team(), [codex, claude] = room.agents;
    const codexPath = await host.prepare(room, codex), claudePath = await host.prepare(room, claude);
    edit(codexPath, 'a.txt', 'a3\n', 'codex3\n'); edit(claudePath, 'a.txt', 'a3\n', 'claude3\n');
    await host.checkpoint(room, codex, 'turn 1'); await host.checkpoint(room, claude, 'turn 2');
    assert.deepEqual(await host.integrate(room), { conflicts: [{ agentId: claude.id, files: ['a.txt'] }] });
    assert.equal(room.changes!.status, 'conflict');
    await assert.rejects(host.apply(room), /could not be combined yet/);
    assert.deepEqual(await host.mergeInto(room, claude), ['a.txt']);
    assert.equal(await host.finishMerge(room, claude), false, 'markers left: the merge is undone');
    assert.match(read(claudePath, 'a.txt'), /^claude3$/m);
    room.title = 'Fix the login';
    const branch = await host.keep(room);
    assert.match(branch, /^chatroom\/kept\/fix-the-login-\d{8}-\d{4}$/);
    assert.match(git(path, 'show', `${branch}:a.txt`), /^codex3$/m); assert.match(git(path, 'show', `${branch}-claude-5e6f7:a.txt`), /^claude3$/m);
    assert.deepEqual(toasts, [`notice: Kept as branch ${branch}.`]);
    assert.equal(room.changes, undefined); assert.equal(claude.worktree, undefined);
    await host.prepare(room, codex);
    assert.notEqual(room.changes, undefined);
    await host.discard(room);
    assert.equal(room.changes, undefined); assert.equal(codex.worktree, undefined); assert.deepEqual(await manager.list(), []);
    assert.equal(git(path, 'status', '--porcelain'), '');
  } finally { done(); }
});
