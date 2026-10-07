import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalDecision, ApprovalRequest, Room, SandboxResult } from '../src/types';
import { DEFAULT_SANDBOX_IMAGES, DockerOptions, DockerResult, DockerRunner, SANDBOX_OFF, SandboxService, SandboxSettings, containerCommand, dockerRunArgs, dockerStatus,
  globMatcher, requestFromResult, sandboxApproval, sandboxOn, sandboxRequest, sandboxSettings, sourceFiles } from '../src/sandbox';
import { message, migrateRoom, renderEntry, sandboxReport, sandboxSummary, unseenEntries } from '../src/core';
import { testAgent, testRoom, waitFor } from './helpers';

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
const settings = (patch: Partial<SandboxSettings> = {}): SandboxSettings => ({ ...sandboxSettings({}), ...patch });
const mountOf = (args: string[]) => args[args.indexOf('-v') + 1]!.replace(/:\/work(:ro)?$/, '');
/** A docker CLI double: version, image inspect/pull, run (scripted), kill, ps and rm. */
function fakeDocker(opts: { images?: string[]; run?: (args: string[], options: DockerOptions, docker: ReturnType<typeof fakeDocker>) => Promise<DockerResult>; ps?: string; version?: DockerResult } = {}) {
  const images = new Set(opts.images ?? []), calls: string[][] = [], killed: string[] = [], removed: string[] = [];
  let onKill: (() => void) | undefined;
  const state = {
    calls, killed, removed, images,
    /** Resolves the pending run as killed (exit 137) when `docker kill` arrives. */
    untilKilled: () => new Promise<DockerResult>(resolve => { onKill = () => resolve({ code: 137, stdout: '', stderr: '' }); }),
    runner: (async (args, options = {}) => {
      calls.push(args);
      switch (args[0]) {
        case 'version': return opts.version ?? ok('29.5.3\n');
        case 'image': return images.has(args.at(-1)!) ? ok('sha256:1\n') : { code: 1, stdout: '', stderr: `Error: No such image: ${args.at(-1)}` };
        case 'pull':
          options.onOutput?.('stdout', `bookworm-slim: Pulling from library/debian\n\x1b[1Aabc123: Pulling fs layer\r`);
          options.onOutput?.('stdout', `abc123: Pull complete\nStatus: Downloaded newer image for ${args[1]}\n`);
          images.add(args[1]!); return ok();
        case 'run': return opts.run ? opts.run(args, options, state) : ok();
        case 'kill': killed.push(args[1]!); onKill?.(); onKill = undefined; return ok();
        case 'ps': return ok(opts.ps ?? '');
        case 'rm': removed.push(...args.slice(2)); return ok();
      }
      return { code: 1, stdout: '', stderr: 'unknown' };
    }) as DockerRunner
  };
  return state;
}
function service(docker: ReturnType<typeof fakeDocker>, patch: { decide?: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>; settings?: Partial<SandboxSettings>; pid?: number; alive?: (pid: number) => boolean } = {}) {
  const storage = mkdtempSync(join(tmpdir(), 'chatroom sbx store ')), approvals: { agentId?: string; request: ApprovalRequest }[] = [];
  let changes = 0, last = 0;
  const sandbox = new SandboxService({
    now: () => last = Math.max(Date.now(), last + 1),
    settings: () => settings(patch.settings), storageDir: () => storage,
    approve: async (_room, agentId, request) => { approvals.push({ agentId, request }); return patch.decide ? patch.decide(request) : { decision: 'allow' }; },
    changed: () => { changes++; }, docker: docker.runner, pid: patch.pid ?? 4242, alive: patch.alive ?? (() => false)
  });
  return { sandbox, storage, approvals, changes: () => changes };
}
function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'chatroom sbx src '));
  for (const [rel, text] of Object.entries(files)) { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); }
  return dir;
}
const room = (): Room => testRoom([testAgent('codex'), testAgent('claude', { id: 'claude-1' })]);

test('settings are bounded, bad images fall back, and the room switch overrides an enabled setting only to turn it off', () => {
  assert.deepEqual(sandboxSettings({}), { enabled: true, images: DEFAULT_SANDBOX_IMAGES, cpus: 2, memoryMb: 2048, timeoutSeconds: 120, maxCopyMb: 200 });
  const s = sandboxSettings({ enabled: false, images: { python: 'python:3.11-slim', node: '-v /:/host', bash: 'has space' }, cpus: 99, memoryMb: 1, timeoutSeconds: 99999, maxCopyMb: 'x' });
  assert.deepEqual(s.images, { ...DEFAULT_SANDBOX_IMAGES, python: 'python:3.11-slim' });
  assert.deepEqual([s.enabled, s.cpus, s.memoryMb, s.timeoutSeconds, s.maxCopyMb], [false, 16, 256, 1800, 200]);
  const r = room();
  assert.equal(sandboxOn({ enabled: true }, r), true);
  r.sandbox = false; assert.equal(sandboxOn({ enabled: true }, r), false);
  r.sandbox = true; assert.equal(sandboxOn({ enabled: false }, r), false);
});
test('requests: a command or code with its language, bounded options, and clear errors', () => {
  const d = { timeoutSeconds: 120, workdirFrom: 'agent' as const };
  assert.deepEqual(sandboxRequest({ command: '  npm test  ' }, d), { command: 'npm test', profile: 'test', network: false, timeoutSeconds: 120, workdirFrom: 'agent' });
  assert.deepEqual(sandboxRequest({ code: '\nprint(1)\n\n', language: 'py', profile: 'security', network: true, timeoutSeconds: 5000, outputs: ['./out.txt', '../x', '/etc/passwd', '/work/r.json', 3], purpose: ' check ', copyFiles: false }, d),
    { code: 'print(1)', language: 'python', profile: 'security', network: true, timeoutSeconds: 1800, outputs: ['out.txt', 'r.json'], purpose: 'check', workdirFrom: 'none' });
  assert.deepEqual(sandboxRequest({ command: 'pytest', language: 'python', network: 'yes' }, d), { command: 'pytest', language: 'python', profile: 'test', network: false, timeoutSeconds: 120, workdirFrom: 'agent' });
  assert.throws(() => sandboxRequest({}, d), /Give a command to run, or code and its language/);
  assert.throws(() => sandboxRequest({ command: 'a', code: 'b', language: 'bash' }, d), /either a command or code, not both/);
  assert.throws(() => sandboxRequest({ code: 'x' }, d), /Say which language/);
  assert.throws(() => sandboxRequest({ code: 'x', language: 'ruby' }, d), /language must be bash, python or node/);
  assert.throws(() => sandboxRequest({ command: 'x'.repeat(8001) }, d), /longer than 8,000 characters/);
  const result = { id: 'a', status: 'done', image: 'python:3.12-slim', profile: 'security', network: true, command: 'pytest -q', limits: { cpus: 2, memoryMb: 2048, timeoutSeconds: 60 }, stdout: '', stderr: '', requestedBy: 'You', createdAt: 1 } as SandboxResult;
  assert.deepEqual(requestFromResult(result, DEFAULT_SANDBOX_IMAGES, 'workspace'), { command: 'pytest -q', language: 'python', profile: 'security', network: true, timeoutSeconds: 60, workdirFrom: 'workspace' });
  assert.deepEqual(requestFromResult({ ...result, language: 'node', command: 'console.log(1)' }, DEFAULT_SANDBOX_IMAGES, 'agent'), { code: 'console.log(1)', language: 'node', profile: 'security', network: true, timeoutSeconds: 60, workdirFrom: 'agent' });
});
test('docker run arguments: no network, limits, no capabilities, read-only root, the copy at /work; security adds nobody and a read-only copy', () => {
  const mount = 'C:\\Users\\Some One\\AppData\\sandbox\\abc\\work';
  const test = dockerRunArgs({ id: 'abc', image: 'debian:bookworm-slim', request: { command: 'echo "hi there" && ls', profile: 'test', network: false, timeoutSeconds: 10, workdirFrom: 'workspace' }, settings: { cpus: 2, memoryMb: 2048 }, mount, pid: 77 });
  assert.deepEqual(test, ['run', '--rm', '--name', 'chatroom-sbx-abc', '--label', 'chatroom.sandbox=1', '--label', 'chatroom.pid=77', '--network', 'none',
    '--cpus', '2', '--memory', '2048m', '--memory-swap', '2048m', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,size=256m',
    '-e', 'HOME=/tmp', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PYTHONUNBUFFERED=1', '-v', `${mount}:/work`, '-w', '/work', 'debian:bookworm-slim', 'sh', '-lc', 'echo "hi there" && ls']);
  const security = dockerRunArgs({ id: 'abc', image: 'python:3.12-slim', request: { code: 'print(1)', language: 'python', profile: 'security', network: true, timeoutSeconds: 10, workdirFrom: 'none' }, settings: { cpus: 1.5, memoryMb: 512 }, mount, pid: 77 });
  assert.equal(security.includes('--network'), false, 'an approved network uses the default bridge');
  assert.deepEqual(security.slice(security.indexOf('--user'), security.indexOf('--user') + 2), ['--user', '65534:65534']);
  assert.equal(security[security.indexOf('-v') + 1], `${mount}:/work:ro`);
  assert.deepEqual(security.slice(-3), ['python:3.12-slim', 'python', '/work/.chatroom-run.py']);
  assert.deepEqual(containerCommand({ code: 'x', language: 'node', profile: 'test', network: false, timeoutSeconds: 1, workdirFrom: 'none' }), ['node', '/work/.chatroom-run.js']);
  assert.deepEqual(containerCommand({ code: 'x', language: 'bash', profile: 'test', network: false, timeoutSeconds: 1, workdirFrom: 'none' }), ['bash', '/work/.chatroom-run.sh']);
});
test('docker status: the server version, or install / start Docker Desktop', async () => {
  assert.deepEqual(await dockerStatus(async () => ok('29.5.3\n')), { available: true, detail: 'Docker 29.5.3', version: '29.5.3' });
  assert.deepEqual(await dockerStatus(async () => ({ code: -1, stdout: '', stderr: '', error: 'missing' })), { available: false, detail: 'Docker is not installed. Install Docker Desktop to use the sandbox.', action: 'installDocker' });
  const down = await dockerStatus(async () => ({ code: 1, stdout: '\n', stderr: 'error during connect: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.' }));
  assert.deepEqual(down, { available: false, detail: 'Docker Desktop is not running. Start it to use the sandbox.', action: 'startDocker' });
  assert.equal((await dockerStatus(async () => ({ code: -1, stdout: '', stderr: '', error: 'timeout' }))).action, 'startDocker');
  let args: string[] = [], timeout: number | undefined;
  await dockerStatus(async (a, o) => { args = a; timeout = o?.timeoutMs; return ok('1'); });
  assert.deepEqual(args, ['version', '--format', '{{.Server.Version}}']); assert.equal(timeout, 5000);
});
test('the approval card says what runs, where, the image, profile, network and limits, and never offers "allow for session"', () => {
  const card = sandboxApproval({ code: 'import os\nprint(os.getcwd())', language: 'python', profile: 'security', network: true, timeoutSeconds: 30, outputs: ['out.txt'], purpose: 'Check the parser', workdirFrom: 'agent' },
    'python:3.12-slim', { cpus: 2, memoryMb: 2048 }, 'C:\\repo');
  assert.equal(card.kind, 'sandbox'); assert.equal(card.tool, 'sandbox'); assert.equal(card.canAllowSession, false);
  assert.equal(card.title, 'Run Python code in the sandbox (2 lines)');
  assert.equal(card.detail, ['Why: Check the parser', 'Image: python:3.12-slim', 'Profile: security · no root user, read-only copy', 'Network: ON · the container can reach the internet',
    'Files: a copy of C:\\repo', 'Limits: 2 CPUs · 2048 MB memory · 30 s · 512 processes', 'Returns the text of: out.txt', '', 'Python code:', 'import os\nprint(os.getcwd())'].join('\n'));
  const command = sandboxApproval({ command: 'npm test\nnpm run lint', profile: 'test', network: false, timeoutSeconds: 120, workdirFrom: 'none' }, 'debian:bookworm-slim', { cpus: 2, memoryMb: 2048 }, undefined);
  assert.equal(command.title, 'npm test');
  assert.match(command.detail!, /^Image: debian:bookworm-slim\nProfile: test · a writable copy\nNetwork: off\nFiles: none \(an empty \/work\)\n/);
});
test('output globs: names at any depth, folders, ** and ?', () => {
  const match = globMatcher(['out.txt', 'reports/*.json', '**/*.csv', 'log?.txt']);
  for (const yes of ['out.txt', 'deep/out.txt', 'reports/a.json', 'a.csv', 'x/y/z.csv', 'log1.txt']) assert.equal(match(yes), true, yes);
  for (const no of ['out.txt.bak', 'reports/deep/a.json', 'other/a.json', 'log12.txt', 'a.csvx']) assert.equal(match(no), false, no);
  assert.equal(globMatcher([])('anything'), false);
});
test('the copy: git-tracked and untracked files without ignored or credential files; a plain folder skips dependency and build folders', async () => {
  const repo = folder({ 'src/a.py': 'print(1)', 'README.md': '# r', '.gitignore': 'ignored.txt\nlogs/\n', 'ignored.txt': 'x', 'logs/x.log': 'x', '.env': 'SECRET=1', 'notes/new.txt': 'untracked', 'id_rsa.pem': 'k' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  git('init', '-q'); git('add', 'src/a.py', 'README.md', '.gitignore');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'init');
  const listed = await sourceFiles(repo);
  assert.equal(listed.git, true);
  assert.deepEqual(listed.files.map(f => f.rel).sort(), ['.gitignore', 'README.md', 'notes/new.txt', 'src/a.py']);
  assert.equal(listed.files.find(f => f.rel === 'src/a.py')!.size, 8);
  const plain = folder({ 'main.js': 'x', 'node_modules/p/index.js': 'x', 'dist/out.js': 'x', 'build/b': 'x', '.venv/v': 'x', 'target/t': 'x', 'lib/util.js': 'xy', '.ssh/id': 'k', 'secrets.json': '{}' });
  const walked = await sourceFiles(plain);
  assert.equal(walked.git, false);
  assert.deepEqual(walked.files.map(f => f.rel).sort(), ['lib/util.js', 'main.js']);
});
test('a run: the card after Allow, a copy (never the real folder), a pull with progress, streamed output, changed files with requested text', async () => {
  const src = folder({ 'data/in.txt': 'hello', 'keep.txt': 'same' });
  let mounted = '', seenCopy: string[] = [];
  const docker = fakeDocker({ run: async (args, options) => {
    mounted = mountOf(args); seenCopy = readdirSync(mounted).sort();
    writeFileSync(join(mounted, 'out.txt'), 'result: 42\n'); mkdirSync(join(mounted, 'out'), { recursive: true }); writeFileSync(join(mounted, 'out', 'bin.dat'), Buffer.from([0, 1, 2]));
    writeFileSync(join(mounted, 'data', 'in.txt'), 'changed!');
    options.onOutput?.('stdout', 'line 1\n\x1b[32mgreen\x1b[0m\n'); options.onOutput?.('stderr', 'warning: x\n');
    return { code: 3, stdout: '', stderr: '' };
  } });
  const { sandbox, approvals, storage } = service(docker);
  const r = room(), statuses: string[] = [];
  const result = await sandbox.run({ room: r, request: { code: 'print(1)', language: 'python', profile: 'test', network: false, timeoutSeconds: 30, outputs: ['out.txt', 'out/*', 'data/in.txt'], workdirFrom: 'agent' },
    requestedBy: 'Codex', agentId: 'codex-1', folder: src, onStatus: x => statuses.push(x.status) });
  assert.equal(approvals.length, 1); assert.equal(approvals[0]!.agentId, 'codex-1'); assert.equal(approvals[0]!.request.kind, 'sandbox');
  assert.equal(result.status, 'done'); assert.equal(result.exitCode, 3); assert.equal(result.image, 'python:3.12-slim'); assert.equal(result.language, 'python');
  assert.equal(result.command, 'print(1)'); assert.equal(result.requestedBy, 'Codex'); assert.equal(result.agentId, 'codex-1');
  assert.deepEqual(result.limits, { cpus: 2, memoryMb: 2048, timeoutSeconds: 30 });
  assert.equal(result.stdout, 'line 1\ngreen\n'); assert.equal(result.stderr, 'warning: x\n');
  assert.ok(result.startedAt! >= result.createdAt && result.finishedAt! >= result.startedAt! && typeof result.durationMs === 'number');
  assert.deepEqual(statuses, ['pulling', 'running', 'done']);
  assert.deepEqual(result.files, [{ path: 'data/in.txt', size: 8, text: 'changed!' }, { path: 'out.txt', size: 11, text: 'result: 42\n' }, { path: 'out/bin.dat', size: 3 }]);
  // The copy lives in storage, holds the files and the script, and the real folder is untouched.
  assert.ok(mounted.startsWith(storage) || mounted.toLowerCase().includes('chatroom sbx store'), mounted);
  assert.deepEqual(seenCopy, ['.chatroom-run.py', 'data', 'keep.txt']);
  assert.equal(readFileSync(join(src, 'data', 'in.txt'), 'utf8'), 'hello');
  assert.deepEqual(docker.calls.map(c => c[0]), ['version', 'image', 'pull', 'run']);
  assert.deepEqual(docker.calls[2], ['pull', 'python:3.12-slim']);
  // One card in the room, updated in place.
  const cards = r.messages.filter(m => m.sandbox);
  assert.equal(cards.length, 1); assert.equal(cards[0]!.kind, 'notice'); assert.equal(cards[0]!.author, 'Sandbox'); assert.equal(cards[0]!.agentId, undefined);
  assert.equal(cards[0]!.sandbox, result); assert.equal(cards[0]!.text, 'Sandbox · Python code: print(1) · exit code 3 · ' + `${(result.durationMs! / 1000).toFixed(1)} s`);
});
test('the pull shows its progress on the card while it downloads', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const docker = fakeDocker();
  const inner = docker.runner;
  docker.runner = (async (args: string[], options?: DockerOptions) => { if (args[0] === 'pull') { const r = await inner(args, options); await gate; return r; } return inner(args, options); }) as DockerRunner;
  const { sandbox } = service(docker);
  const r = room();
  const run = sandbox.run({ room: r, request: { command: 'true', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'You' });
  const card = await waitFor(() => r.messages.find(m => m.sandbox?.status === 'pulling'));
  await waitFor(() => card.sandbox!.stdout.includes('Status: Downloaded newer image'));
  assert.equal(card.sandbox!.stdout, 'bookworm-slim: Pulling from library/debian\nabc123: Pulling fs layer\nabc123: Pull complete\nStatus: Downloaded newer image for debian:bookworm-slim');
  assert.equal(card.text, 'Sandbox · true · downloading debian:bookworm-slim');
  release();
  const result = await run;
  assert.equal(result.status, 'done'); assert.equal(result.stdout, '', 'the pull log is replaced by the run\'s output');
});
test('declined or expired: no card, status denied; off or Docker unavailable: an error before any card', async () => {
  const docker = fakeDocker({ images: ['debian:bookworm-slim'] });
  const denied = service(docker, { decide: () => ({ decision: 'deny', message: 'No response from the user in time.' }) });
  const r = room();
  const result = await denied.sandbox.run({ room: r, request: { command: 'rm -rf /', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'Claude', agentId: 'claude-1' });
  assert.equal(result.status, 'denied'); assert.equal(result.error, 'No response from the user in time.');
  assert.equal(r.messages.length, 0); assert.equal(docker.calls.some(c => c[0] === 'run'), false);
  r.sandbox = false;
  await assert.rejects(denied.sandbox.run({ room: r, request: { command: 'x', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'You' }), { message: SANDBOX_OFF });
  const off = service(fakeDocker({ version: { code: 1, stdout: '', stderr: 'error during connect' } }));
  await assert.rejects(off.sandbox.run({ room: room(), request: { command: 'x', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'You' }), /Docker Desktop is not running/);
  assert.equal(off.approvals.length, 0);
});
test('a run that passes its time limit is killed and marked timed out', async () => {
  const docker = fakeDocker({ images: ['debian:bookworm-slim'], run: (_args, _o, d) => d.untilKilled() });
  const { sandbox } = service(docker);
  const started = Date.now();
  const result = await sandbox.run({ room: room(), request: { command: 'sleep 100', profile: 'test', network: false, timeoutSeconds: 1, workdirFrom: 'none' }, requestedBy: 'You' });
  assert.equal(result.status, 'timeout'); assert.equal(result.exitCode, 137);
  assert.deepEqual(docker.killed, [`chatroom-sbx-${result.id}`]);
  assert.ok(Date.now() - started >= 900);
  assert.equal(sandboxSummary(result), 'Sandbox · sleep 100 · timed out after 1 s and was stopped');
});
test('cancel (the card, Stop for the room, or the agent\'s turn ending) kills the container', async () => {
  const docker = fakeDocker({ images: ['debian:bookworm-slim'], run: (_args, _o, d) => d.untilKilled() });
  const { sandbox } = service(docker);
  const r = room(), request = { command: 'sleep 100', profile: 'test' as const, network: false, timeoutSeconds: 60, workdirFrom: 'none' as const };
  const first = sandbox.run({ room: r, request, requestedBy: 'You' });
  const card = await waitFor(() => r.messages.find(m => m.sandbox?.status === 'running'));
  assert.equal(sandbox.cancel(card.sandbox!.id), true);
  assert.equal((await first).status, 'cancelled');
  const second = sandbox.run({ room: r, request, requestedBy: 'You' });
  await waitFor(() => r.messages.filter(m => m.sandbox?.status === 'running').length === 1 && r.messages.length === 2);
  assert.equal(sandbox.cancelRoom(r.id), 1);
  assert.equal((await second).status, 'cancelled');
  const turn = new AbortController();
  const third = sandbox.run({ room: r, request, requestedBy: 'Codex', agentId: 'codex-1', signal: turn.signal });
  await waitFor(() => r.messages.filter(m => m.sandbox?.status === 'running').length === 1 && r.messages.length === 3);
  turn.abort(new Error('Stopped by you.'));
  assert.equal((await third).status, 'cancelled');
  assert.equal(docker.killed.length, 3); assert.equal(sandbox.running.length, 0);
  // A card still waiting for approval is cancelled too, before anything runs.
  let pending!: (d: ApprovalDecision) => void;
  const waiting = service(docker, { decide: () => new Promise<ApprovalDecision>(resolve => pending = resolve) });
  const fourth = waiting.sandbox.run({ room: r, request, requestedBy: 'You' });
  await waitFor(() => waiting.approvals.length === 1);
  assert.equal(waiting.sandbox.cancelRoom(r.id), 1);
  pending({ decision: 'deny', message: 'The request was cancelled.' });
  assert.equal((await fourth).status, 'cancelled');
});
test('failures: a folder over the copy limit, and docker refusing to start the container', async () => {
  const big = folder({ 'a.bin': 'x'.repeat(1024 * 1024 + 10) });
  const docker = fakeDocker({ images: ['debian:bookworm-slim'], run: async () => ({ code: 125, stdout: '', stderr: 'docker: Error response from daemon: invalid mount config.\nRun \'docker run --help\' for more information\n' }) });
  const { sandbox } = service(docker, { settings: { maxCopyMb: 1 } });
  const r = room();
  const tooBig = await sandbox.run({ room: r, request: { command: 'ls', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'workspace' }, requestedBy: 'You', folder: big });
  assert.equal(tooBig.status, 'failed');
  assert.equal(tooBig.error, 'The folder is larger than the sandbox copy limit (1 MB): 1.0 MB in 1 files. Raise chatroom.sandbox.maxCopyMb, or run without files.');
  assert.equal(docker.calls.some(c => c[0] === 'run'), false);
  const refused = await sandbox.run({ room: r, request: { command: 'ls', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'You' });
  assert.equal(refused.status, 'failed'); assert.equal(refused.error, 'Error response from daemon: invalid mount config.');
  // Too much output: the docker CLI is stopped, and so is its container.
  const noisy = fakeDocker({ images: ['debian:bookworm-slim'], run: async () => ({ code: -1, stdout: '', stderr: '', error: 'overflow' }) });
  const loud = await service(noisy).sandbox.run({ room: r, request: { command: 'yes', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'You' });
  assert.equal(loud.status, 'failed'); assert.equal(loud.error, 'The run printed more than 32.0 MB; it was stopped.');
  assert.deepEqual(noisy.removed, [`chatroom-sbx-${loud.id}`]);
});
test('copies: the latest three stay for inspection; copies of another open window are left alone', async () => {
  const docker = fakeDocker({ images: ['debian:bookworm-slim'] });
  const { sandbox, storage } = service(docker, { alive: pid => pid === 999 });
  const other = join(storage, 'sandbox', 'otherwindow');
  mkdirSync(other, { recursive: true }); writeFileSync(join(other, 'owner.json'), JSON.stringify({ pid: 999, createdAt: 0 }));
  const r = room(), ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await sandbox.run({ room: r, request: { command: 'true', profile: 'test', network: false, timeoutSeconds: 5, workdirFrom: 'none' }, requestedBy: 'You' })).id);
  const left = readdirSync(join(storage, 'sandbox')).sort();
  assert.deepEqual(left, [...ids.slice(2), 'otherwindow'].sort());
});
test('sweep removes leftover chatroom-sbx containers whose window is gone, and keeps those of open windows', async () => {
  const docker = fakeDocker({ ps: ['chatroom-sbx-aaa\t111', 'chatroom-sbx-bbb\t222', 'chatroom-sbx-ccc\t', 'my-chatroom-sbx-x\t1', 'chatroom-sbx-ddd\t4242', ''].join('\n') });
  const { sandbox } = service(docker, { alive: pid => pid === 222 || pid === 4242 });
  const swept = await sandbox.sweep();
  assert.deepEqual(swept.containers, ['chatroom-sbx-aaa', 'chatroom-sbx-ccc', 'chatroom-sbx-ddd']);
  assert.deepEqual(docker.calls[0], ['ps', '-a', '--filter', 'name=chatroom-sbx-', '--format', '{{.Names}}\t{{.Label "chatroom.pid"}}']);
  assert.deepEqual(docker.removed, ['chatroom-sbx-aaa', 'chatroom-sbx-ccc', 'chatroom-sbx-ddd']);
});
test('reports: the tool result has the tails and requested texts; the room entry echoes the command; delivery waits until the run ends', () => {
  const r = room(), codex = r.agents[0]!, claude = r.agents[1]!;
  const result: SandboxResult = { id: 'x1', status: 'running', image: 'debian:bookworm-slim', profile: 'test', network: false, command: 'npm test', limits: { cpus: 2, memoryMb: 2048, timeoutSeconds: 120 },
    stdout: 'a'.repeat(9000), stderr: '', requestedBy: 'Codex', agentId: codex.id, createdAt: 1 };
  const card = message('notice', sandboxSummary(result), 'Sandbox'); card.sandbox = result; delete card.agentId;
  const user = message('user', 'go');
  r.messages.push(user, card);
  claude.session = { id: 's', seen: user.id }; codex.session = { id: 's2', seen: user.id };
  assert.deepEqual(unseenEntries(r, claude, { kind: 'discussion' }).map(m => m.id), [], 'a running card is not delivered');
  Object.assign(result, { status: 'done', exitCode: 1, durationMs: 2500, files: [{ path: 'out.txt', size: 5, text: 'hello' }] });
  assert.deepEqual(unseenEntries(r, claude, { kind: 'discussion' }).map(m => m.id), [card.id], 'a finished card reaches the other agents');
  assert.deepEqual(unseenEntries(r, codex, { kind: 'discussion' }).map(m => m.id), [], 'the agent that asked already has the result');
  const tool = sandboxReport(result, { tail: 8000, texts: true });
  assert.match(tool, /^Sandbox run requested by Codex · debian:bookworm-slim · test profile · network off · limits 2 CPUs, 2048 MB, 120 s\nResult: exit code 1 · 2\.5 s\nstdout:\n\[… 1,000 earlier characters\]\na{8000}\nstderr: \(empty\)\nFiles created or changed in \/work \(1\): out\.txt \(5 B\)\n--- out\.txt ---\nhello$/);
  const entry = renderEntry(card, r);
  assert.ok(entry.startsWith('<room from="Sandbox">\nSandbox run requested by Codex'));
  assert.match(entry, /\nCommand: npm test\nResult: exit code 1 · 2\.5 s\nstdout:\n\[… 5,000 earlier characters\]\na{4000}\n/);
  assert.ok(!entry.includes('--- out.txt ---'), 'other agents get file names, not their text');
  assert.ok(entry.endsWith('\n</room>'));
  // A card still running when the window closed is marked when the room is restored.
  const saved = JSON.parse(JSON.stringify({ ...r, sandbox: 'yes', messages: [{ ...card, sandbox: { ...result, status: 'running' } }] }));
  const restored = migrateRoom(saved, { attachEditor: true, shareSkills: true, permission: 'ask' });
  assert.equal(restored.sandbox, undefined);
  assert.equal(restored.messages[0]!.sandbox!.status, 'cancelled'); assert.equal(restored.messages[0]!.sandbox!.error, 'Interrupted when the window closed.');
  assert.equal(restored.messages[0]!.text, 'Sandbox · npm test · cancelled');
});
