import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { ApprovalDecision, ApprovalRequest, Room, SandboxLanguage, SandboxProfile, SandboxRequest, SandboxResult } from './types';
import { SANDBOX_LANGUAGE_NAMES, boundedNumber, formatBytes, message, sandboxFinished, sandboxLanguage, sandboxSummary } from './core';
import { DENIED } from './paths';
import { GitRunner, gitEnv, runGit } from './worktrees';

/**
 * On-demand sandbox runs (optional): a command or a script in a throwaway Docker container, on a copy of a folder, after the user
 * approves it. No vscode here: the host supplies settings, storage, approvals and the room; docker and git are injectable for tests.
 */
export const SANDBOX_LANGUAGES: SandboxLanguage[] = ['bash', 'python', 'node'];
export const DEFAULT_SANDBOX_IMAGES: Record<SandboxLanguage, string> = { bash: 'debian:bookworm-slim', python: 'python:3.12-slim', node: 'node:22-bookworm-slim' };
export const CONTAINER_PREFIX = 'chatroom-sbx-';
export const SANDBOX_OFF = 'The sandbox is turned off in this room.';
export const SANDBOX_DECLINED = 'The user declined this sandbox run.';
/** Output tails kept on the card, per stream. */
export const SANDBOX_TAIL = 16_000;
const MAX_LISTED = 50, MAX_TEXT = 64 * 1024, KEEP_COPIES = 3, MAX_COMMAND = 8000, MAX_CODE = 200_000, MAX_ENTRIES = 50_000, MAX_ACTIVE = 3;
const PIDS = 512, TMPFS = '/tmp:rw,size=256m', MAX_OUTPUT_BYTES = 32 * 1024 * 1024, PULL_MS = 15 * 60_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'target']);
const EXTENSIONS: Record<SandboxLanguage, string> = { bash: 'sh', python: 'py', node: 'js' };
const INTERPRETERS: Record<SandboxLanguage, string> = { bash: 'bash', python: 'python', node: 'node' };
/** An image reference: no spaces, never starting with "-" (it would read as a docker flag). */
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-\/:@]{0,254}$/;
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

// ── Settings and requests ───────────────────────────────────────────────────
export interface SandboxSettings {
  /** chatroom.sandbox.enabled: off turns the feature off everywhere. */
  enabled: boolean;
  images: Record<SandboxLanguage, string>;
  cpus: number; memoryMb: number;
  /** The default time limit of a run. */
  timeoutSeconds: number;
  /** Folders larger than this are not copied. */
  maxCopyMb: number;
}
/** Settings from configuration values, bounded; unusable images fall back to the defaults. */
export function sandboxSettings(raw: { enabled?: unknown; images?: unknown; cpus?: unknown; memoryMb?: unknown; timeoutSeconds?: unknown; maxCopyMb?: unknown }): SandboxSettings {
  const images = { ...DEFAULT_SANDBOX_IMAGES }, given = raw.images && typeof raw.images === 'object' ? raw.images as Record<string, unknown> : {};
  for (const language of SANDBOX_LANGUAGES) { const value = typeof given[language] === 'string' ? (given[language] as string).trim() : ''; if (IMAGE.test(value)) images[language] = value; }
  const cpus = typeof raw.cpus === 'number' && Number.isFinite(raw.cpus) ? Math.max(0.5, Math.min(16, Math.round(raw.cpus * 10) / 10)) : 2;
  return { enabled: raw.enabled !== false, images, cpus, memoryMb: boundedNumber(raw.memoryMb, 256, 65536, 2048),
    timeoutSeconds: boundedNumber(raw.timeoutSeconds, 5, 1800, 120), maxCopyMb: boundedNumber(raw.maxCopyMb, 1, 10_000, 200) };
}
/** The setting, then the room's own switch (undefined = the setting). */
export const sandboxOn = (settings: Pick<SandboxSettings, 'enabled'>, room: Room | undefined) => settings.enabled && room?.sandbox !== false;
/**
 * A request from a room tool call or the webview, validated. Either `command` (run with sh -lc; `language` then only picks the image)
 * or `code` with its `language`. `copyFiles: false` runs in an empty /work.
 */
export function sandboxRequest(raw: Record<string, unknown>, defaults: { timeoutSeconds: number; workdirFrom: 'agent' | 'workspace' }): SandboxRequest {
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  const code = typeof raw.code === 'string' ? raw.code.replace(/^\s*\n/, '').replace(/\s+$/, '') : '';
  const language = sandboxLanguage(raw.language);
  if (raw.language !== undefined && raw.language !== null && raw.language !== '' && !language) throw new Error('language must be bash, python or node.');
  if (command && code) throw new Error('Give either a command or code, not both.');
  if (!command && !code) throw new Error('Give a command to run, or code and its language (bash, python or node).');
  if (code && !language) throw new Error('Say which language the code is in: bash, python or node.');
  if (command.length > MAX_COMMAND) throw new Error(`The command is longer than ${MAX_COMMAND.toLocaleString('en')} characters; send it as code instead.`);
  if (code.length > MAX_CODE) throw new Error(`The code is longer than ${MAX_CODE.toLocaleString('en')} characters.`);
  const outputs = (Array.isArray(raw.outputs) ? raw.outputs : typeof raw.outputs === 'string' ? [raw.outputs] : [])
    .filter((g): g is string => typeof g === 'string').map(g => g.trim().replace(/\\/g, '/').replace(/^(\.\/|\/work\/)/, '')).filter(g => g && g.length <= 200 && !g.split('/').includes('..') && !g.startsWith('/')).slice(0, 20);
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim().slice(0, 500) : '';
  return {
    ...(command ? { command } : { code }), ...(language ? { language } : {}),
    profile: raw.profile === 'security' ? 'security' : 'test', network: raw.network === true,
    timeoutSeconds: boundedNumber(raw.timeoutSeconds, 1, 1800, defaults.timeoutSeconds),
    ...(outputs.length ? { outputs } : {}), ...(purpose ? { purpose } : {}),
    workdirFrom: raw.copyFiles === false ? 'none' : defaults.workdirFrom
  };
}
/** A request that repeats a run from its card (when the original request is no longer known). */
export function requestFromResult(r: SandboxResult, images: Record<SandboxLanguage, string>, workdirFrom: 'agent' | 'workspace'): SandboxRequest {
  const imageLanguage = SANDBOX_LANGUAGES.find(l => images[l] === r.image);
  return { ...(r.language ? { code: r.command, language: r.language } : { command: r.command, ...(imageLanguage && imageLanguage !== 'bash' ? { language: imageLanguage } : {}) }),
    profile: r.profile === 'security' ? 'security' : 'test', network: !!r.network, timeoutSeconds: boundedNumber(r.limits?.timeoutSeconds, 1, 1800, 120),
    ...(r.purpose ? { purpose: r.purpose } : {}), workdirFrom };
}
const PROFILE_TEXT: Record<SandboxProfile, string> = { test: 'test · a writable copy', security: 'security · no root user, read-only copy' };
/** The approval card for a run: what runs, where, with which image, profile, network and limits. Never "allow for session". */
export function sandboxApproval(request: SandboxRequest, image: string, settings: Pick<SandboxSettings, 'cpus' | 'memoryMb'>, folder: string | undefined): ApprovalRequest {
  const language = request.language ?? 'bash', name = SANDBOX_LANGUAGE_NAMES[language];
  const firstLine = (request.command ?? '').split('\n')[0]!.trim();
  const lines = (request.code ?? '').split('\n').length;
  const title = request.code ? `Run ${name} code in the sandbox (${lines} line${lines === 1 ? '' : 's'})` : firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine || 'Run a command in the sandbox';
  const body = request.code ?? request.command ?? '';
  const detail = [
    request.purpose ? `Why: ${request.purpose}` : '',
    `Image: ${image}`,
    `Profile: ${PROFILE_TEXT[request.profile]}`,
    `Network: ${request.network ? 'ON · the container can reach the internet' : 'off'}`,
    `Files: ${request.workdirFrom === 'none' || !folder ? 'none (an empty /work)' : `a copy of ${folder}`}`,
    `Limits: ${settings.cpus} CPUs · ${settings.memoryMb} MB memory · ${request.timeoutSeconds} s · ${PIDS} processes`,
    request.outputs?.length ? `Returns the text of: ${request.outputs.join(', ')}` : '',
    '',
    request.code ? `${name} code:` : 'Command:',
    body.length > 6000 ? `${body.slice(0, 6000)}\n[… ${(body.length - 6000).toLocaleString('en')} more characters]` : body
  ].filter((line, i, all) => line || (i > 0 && all[i - 1])).join('\n');
  return { kind: 'sandbox', tool: 'sandbox', title, detail, canAllowSession: false };
}

// ── Docker ──────────────────────────────────────────────────────────────────
export interface DockerOptions {
  /** Called with output as it arrives (decoded text). */
  onOutput?(stream: 'stdout' | 'stderr', text: string): void;
  /** Kills the docker CLI process after this long; 0 = never. */
  timeoutMs?: number;
  /** Aborts (kills) the docker CLI process. A container keeps running until `docker kill`. */
  signal?: AbortSignal;
}
/** error: 'missing' (no docker CLI), 'timeout', 'overflow' (more output than the buffer), 'aborted', or another spawn error. */
export interface DockerResult { code: number; stdout: string; stderr: string; error?: string }
export type DockerRunner = (args: string[], options?: DockerOptions) => Promise<DockerResult>;
let dockerCommand: string | undefined;
/** `docker` from PATH, else Docker Desktop's default install folder on Windows. */
export function dockerPath(): string {
  if (dockerCommand) return dockerCommand;
  const names = process.platform === 'win32' ? ['docker.exe'] : ['docker'];
  const onPath = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).some(dir => names.some(n => existsSync(join(dir, n))));
  const desktop = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe') : '';
  return dockerCommand = !onPath && desktop && existsSync(desktop) ? desktop : 'docker';
}
/** Runs the docker CLI through execFile (no shell), hidden, with English messages and no CLI hints. */
export const runDocker: DockerRunner = (args, options = {}) => new Promise(done => {
  const env = { ...process.env, DOCKER_CLI_HINTS: 'false', LC_ALL: 'C', NO_COLOR: '1' };
  let child: ReturnType<typeof execFile>;
  try {
    child = execFile(dockerPath(), args, { windowsHide: true, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: options.timeoutMs ?? 0, env, ...(options.signal ? { signal: options.signal } : {}) },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        const code = !e ? 0 : typeof e.code === 'number' ? e.code : -1;
        const why = !e || typeof e.code === 'number' ? undefined : e.code === 'ENOENT' ? 'missing' : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'overflow'
          : e.name === 'AbortError' || options.signal?.aborted ? 'aborted' : e.killed ? 'timeout' : e.message;
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(why ? { error: why } : {}) });
      });
  } catch (error) { done({ code: -1, stdout: '', stderr: '', error: errorText(error) }); return; }
  if (options.onOutput) {
    child.stdout?.on('data', (text: string) => options.onOutput!('stdout', String(text)));
    child.stderr?.on('data', (text: string) => options.onOutput!('stderr', String(text)));
  }
});
export interface DockerStatus { available: boolean; detail: string; action?: 'installDocker' | 'startDocker'; version?: string }
/** `docker version` with a 5 s limit: the server version, or why Docker can't be used (and what would fix it). */
export async function dockerStatus(docker: DockerRunner = runDocker): Promise<DockerStatus> {
  const result = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
  const version = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (result.code === 0 && version && !/[<\s]/.test(version)) return { available: true, detail: `Docker ${version}`, version };
  if (result.error === 'missing') return { available: false, detail: 'Docker is not installed. Install Docker Desktop to use the sandbox.', action: 'installDocker' };
  if (result.error === 'timeout') return { available: false, detail: 'Docker did not answer within 5 s. Start Docker Desktop, or wait until it has started.', action: 'startDocker' };
  return { available: false, detail: 'Docker Desktop is not running. Start it to use the sandbox.', action: 'startDocker' };
}
/** Starts Docker Desktop (detached). Returns an error text when this platform has nothing to start. */
export function startDockerDesktop(): string | undefined {
  try {
    if (process.platform === 'win32') {
      const exe = join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
      if (!existsSync(exe)) return 'Docker Desktop was not found in its default folder. Start it from the Start menu.';
      spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return undefined;
    }
    if (process.platform === 'darwin') { spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' }).unref(); return undefined; }
    return 'Start the Docker service, for example with: sudo systemctl start docker';
  } catch (error) { return `Docker Desktop could not be started: ${errorText(error)}`; }
}
export const containerName = (id: string) => `${CONTAINER_PREFIX}${id}`;
/** What runs inside: `sh -lc <command>`, or the script file with its interpreter. */
export function containerCommand(request: SandboxRequest): string[] {
  if (request.code !== undefined) { const language = request.language ?? 'bash'; return [INTERPRETERS[language], `/work/.chatroom-run.${EXTENSIONS[language]}`]; }
  return ['sh', '-lc', request.command ?? 'true'];
}
/** `docker run` arguments: a throwaway, limited container with no capabilities, a read-only root, and the copy mounted at /work. */
export function dockerRunArgs(opts: { id: string; image: string; request: SandboxRequest; settings: Pick<SandboxSettings, 'cpus' | 'memoryMb'>; mount: string; pid: number }): string[] {
  const { request, settings } = opts, security = request.profile === 'security';
  return ['run', '--rm', '--name', containerName(opts.id), '--label', 'chatroom.sandbox=1', '--label', `chatroom.pid=${opts.pid}`,
    ...(request.network ? [] : ['--network', 'none']),
    '--cpus', String(settings.cpus), '--memory', `${settings.memoryMb}m`, '--memory-swap', `${settings.memoryMb}m`, '--pids-limit', String(PIDS),
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', TMPFS,
    '-e', 'HOME=/tmp', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-e', 'PYTHONUNBUFFERED=1',
    ...(security ? ['--user', '65534:65534'] : []),
    '-v', `${opts.mount}:/work${security ? ':ro' : ''}`, '-w', '/work',
    opts.image, ...containerCommand(request)];
}

// ── The copy ────────────────────────────────────────────────────────────────
/** Credential files never go into a copy (the same rule as Chatroom's file tools), nor do dependency and build folders when walking. */
const secret = (rel: string) => DENIED.test(rel);
export interface SourceFile { rel: string; size: number }
/**
 * The files of `folder` to copy: in a git repository `git ls-files -co --exclude-standard` (tracked plus untracked, not ignored),
 * otherwise a walk that skips node_modules, .git, dist, build, .venv and target. Links are never followed; credential files are left out.
 */
export async function sourceFiles(folder: string, git: GitRunner = runGit): Promise<{ files: SourceFile[]; git: boolean }> {
  const root = resolve(folder), files: SourceFile[] = [];
  const inside = await git(['rev-parse', '--is-inside-work-tree'], root, gitEnv()).catch(() => ({ code: -1, stdout: '', stderr: '' }));
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    const listed = await git(['-c', 'core.quotePath=false', 'ls-files', '-co', '--exclude-standard', '-z'], root, gitEnv());
    if (listed.code !== 0) throw new Error(`git ls-files failed: ${(listed.stderr || listed.stdout).trim().split('\n').slice(-2).join(' ')}`);
    const names = [...new Set(listed.stdout.split('\0').filter(Boolean))];
    if (names.length > MAX_ENTRIES) throw new Error(`The folder has more than ${MAX_ENTRIES.toLocaleString('en')} files; run without files, or in a smaller folder.`);
    for (const rel of names) {
      if (secret(rel) || rel.split('/').includes('..')) continue;
      const info = await lstat(join(root, rel)).catch(() => undefined);
      if (info?.isFile()) files.push({ rel, size: info.size });
    }
    return { files, git: true };
  }
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || secret(rel)) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), rel); continue; }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_ENTRIES) throw new Error(`The folder has more than ${MAX_ENTRIES.toLocaleString('en')} files; run without files, or in a smaller folder.`);
      const info = await lstat(join(dir, entry.name)).catch(() => undefined);
      if (info?.isFile()) files.push({ rel, size: info.size });
    }
  };
  await walk(root, '');
  return { files, git: false };
}
/** Copies `files` from `from` into `to` (16 at a time). */
export async function copyFiles(from: string, to: string, files: SourceFile[], signal?: AbortSignal): Promise<void> {
  const dirs = new Set(files.map(f => dirname(join(to, f.rel))));
  for (const dir of [...dirs].sort((a, b) => a.length - b.length)) await mkdir(dir, { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    while (next < files.length) {
      signal?.throwIfAborted();
      const file = files[next++]!;
      await copyFile(join(from, file.rel), join(to, file.rel)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }));
}
/** Every regular file under `root` (relative path → size and modification time); links are not followed. */
async function listing(root: string): Promise<Map<string, { size: number; mtime: number }>> {
  const out = new Map<string, { size: number; mtime: number }>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.size >= MAX_ENTRIES * 2) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(full, rel); continue; }
      const info = await lstat(full).catch(() => undefined);
      if (info?.isFile()) out.set(rel, { size: info.size, mtime: info.mtimeMs });
    }
  };
  await walk(root, '');
  return out;
}
/** A matcher for output globs relative to /work: `*` within a name, `**` across folders, `?` one character; a glob without "/" also matches a file name at any depth. */
export function globMatcher(globs: string[]): (rel: string) => boolean {
  const toRegex = (glob: string) => new RegExp(`^${glob.split('**').map(part => part.split('*').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '[^/]')).join('[^/]*')).join('.*').replace(/\.\*\//g, '(?:.*/)?')}$`);
  const tests = globs.map(glob => ({ re: toRegex(glob), name: !glob.includes('/') }));
  return rel => tests.some(t => t.re.test(rel) || (t.name && t.re.test(rel.split('/').pop() ?? '')));
}
/** Deletes a folder tree; links are removed, never followed. */
export async function removeTree(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch { return; }
  if (info.isSymbolicLink()) { await unlink(path).catch(() => rmdir(path).catch(() => undefined)); return; }
  if (!info.isDirectory()) {
    try { await unlink(path); } catch { await chmod(path, 0o666).catch(() => undefined); await unlink(path); }
    return;
  }
  for (const name of await readdir(path)) await removeTree(join(path, name));
  await rmdir(path);
}
const insideDir = (child: string, parent: string) => { const rel = relative(parent, child); return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)); };
/** The long form of a path (Windows 8.3 names expanded), which Docker Desktop's file sharing needs. */
function longPath(path: string): string { try { return realpathSync.native(path); } catch { return path; } }

// ── The service ─────────────────────────────────────────────────────────────
export interface SandboxHost {
  settings(): SandboxSettings;
  /** Copies go to `<storageDir>/sandbox/<id>/work`. */
  storageDir(): string;
  /** Shows the approval card (author: the agent, or You) and resolves with the user's decision. */
  approve(room: Room, agentId: string | undefined, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /** The room changed (the card); called at most every 200 ms while output streams. */
  changed(): void;
  log?(text: string, kind?: 'info' | 'tool' | 'error'): void;
  docker?: DockerRunner;
  git?: GitRunner;
  now?(): number;
  /** This window's process id, written on its containers and copies so another window's cleanup leaves them alone. */
  pid?: number;
  /** Whether a process still runs (default: signal 0). */
  alive?(pid: number): boolean;
}
export interface SandboxStart {
  room: Room; request: SandboxRequest;
  /** Agent name, or 'You'. */
  requestedBy: string;
  /** The agent that asked (none for the user's own runs). */
  agentId?: string;
  /** The folder copied into /work (unless workdirFrom is 'none'). */
  folder?: string;
  /** Stops the run (the agent's turn ended, or Stop). */
  signal?: AbortSignal;
  /** Status changes of the run (pending → pulling → running → …). */
  onStatus?(result: SandboxResult): void;
}
interface ActiveRun { roomId: string; result: SandboxResult; cancel(): void }
const defaultAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

export class SandboxService {
  private readonly active = new Map<string, ActiveRun>();
  /** The original request of each run in this window, for Run again. */
  private readonly requests = new Map<string, { request: SandboxRequest; agentId?: string }>();
  private cached?: { at: number; status: DockerStatus };
  constructor(private readonly host: SandboxHost) {}
  private get docker(): DockerRunner { return this.host.docker ?? runDocker; }
  private now(): number { return this.host.now?.() ?? Date.now(); }
  private get pid(): number { return this.host.pid ?? process.pid; }
  /** Runs in progress. */
  get running(): SandboxResult[] { return [...this.active.values()].map(a => a.result); }
  /** Whether Docker answers; cached for `maxAgeMs` (0 = check now). */
  async status(maxAgeMs = 0): Promise<DockerStatus> {
    if (this.cached && this.now() - this.cached.at <= maxAgeMs) return this.cached.status;
    const status = await dockerStatus(this.docker);
    this.cached = { at: this.now(), status };
    return status;
  }
  get lastStatus(): DockerStatus | undefined { return this.cached?.status; }
  /** The original request of a run in this window (for Run again), if known. */
  original(id: string): { request: SandboxRequest; agentId?: string } | undefined { return this.requests.get(id); }

  /**
   * One run: the approval card first; then, when allowed, the result card in the room (updated in place), the copy, the image
   * (pulled when missing), the container and the files it changed. Resolves with the result (status 'denied' when declined, with
   * no card); throws before the approval when the sandbox is off, Docker is unavailable, or too many runs are going.
   */
  async run(start: SandboxStart): Promise<SandboxResult> {
    const settings = this.host.settings(), { room, request } = start;
    if (!sandboxOn(settings, room)) throw new Error(SANDBOX_OFF);
    if (this.active.size >= MAX_ACTIVE) throw new Error(`${MAX_ACTIVE} sandbox runs are already going; wait for one to finish.`);
    const status = await this.status(10_000);
    if (!status.available) throw new Error(status.detail);
    const language = request.language ?? 'bash', image = settings.images[language] ?? DEFAULT_SANDBOX_IMAGES[language];
    const id = randomBytes(6).toString('hex'), folder = request.workdirFrom === 'none' || !start.folder ? undefined : longPath(start.folder);
    const result: SandboxResult = { id, status: 'pending', image, profile: request.profile, network: request.network,
      command: request.code ?? request.command ?? '', ...(request.code !== undefined ? { language } : {}), ...(request.purpose ? { purpose: request.purpose } : {}),
      limits: { cpus: settings.cpus, memoryMb: settings.memoryMb, timeoutSeconds: request.timeoutSeconds },
      stdout: '', stderr: '', requestedBy: start.requestedBy, ...(start.agentId ? { agentId: start.agentId } : {}), createdAt: this.now() };
    const controller = new AbortController(), stop = () => controller.abort(start.signal?.reason ?? new Error('Stopped.'));
    if (start.signal?.aborted) stop(); else start.signal?.addEventListener('abort', stop, { once: true });
    // Registered from the approval on, so Stop (cancelRoom) also cancels a card that is still waiting.
    this.active.set(id, { roomId: room.id, result, cancel: () => controller.abort(new Error('Cancelled.')) });
    let executed = false;
    try {
      const decision = await this.host.approve(room, start.agentId, sandboxApproval(request, image, settings, folder), controller.signal);
      if (controller.signal.aborted || decision.decision === 'deny') {
        Object.assign(result, { status: controller.signal.aborted ? 'cancelled' : 'denied', finishedAt: this.now() }, decision.message ? { error: decision.message } : {});
        return result;
      }
      this.requests.set(id, { request, ...(start.agentId ? { agentId: start.agentId } : {}) });
      while (this.requests.size > 50) this.requests.delete(this.requests.keys().next().value!);
      executed = true;
      return await this.execute(start, result, request, settings, folder, controller);
    } finally {
      start.signal?.removeEventListener('abort', stop);
      if (this.active.get(id)?.result === result) this.active.delete(id);
      // The copy is removed after the run; the latest few stay for inspection.
      if (executed) await this.prune().catch(() => undefined);
    }
  }
  private async execute(start: SandboxStart, result: SandboxResult, request: SandboxRequest, settings: SandboxSettings, folder: string | undefined, controller: AbortController): Promise<SandboxResult> {
    const { room } = start, id = result.id, signal = controller.signal, docker = this.docker;
    const card = message('notice', sandboxSummary(result), 'Sandbox');
    card.createdAt = this.now(); card.sandbox = result; delete card.agentId;
    room.messages.push(card);
    let timer: NodeJS.Timeout | undefined;
    const flush = () => { if (timer) { clearTimeout(timer); timer = undefined; } card.text = sandboxSummary(result); this.host.changed(); };
    const soon = () => { timer ??= setTimeout(flush, 200); timer.unref?.(); };
    const phase = (status: SandboxResult['status']) => { result.status = status; flush(); start.onStatus?.(result); };
    let reason: 'timeout' | 'cancel' | undefined, exited = true, runAbort: AbortController | undefined;
    const kill = async (why: 'timeout' | 'cancel') => {
      if (reason) return;
      reason = why;
      // The attached `docker run` ends when its container is killed; the container may not exist yet, so this tries again for a while.
      for (let attempt = 0; attempt < 10 && !exited; attempt++) {
        await docker(['kill', containerName(id)], { timeoutMs: 15_000 });
        if (exited) return;
        await sleep(1000);
      }
      runAbort?.abort();
    };
    const onCancel = () => { if (exited) return; void kill('cancel'); };
    const dir = join(this.host.storageDir(), 'sandbox', id), work = join(dir, 'work');
    try {
      await mkdir(work, { recursive: true });
      await writeFile(join(dir, 'owner.json'), JSON.stringify({ pid: this.pid, createdAt: result.createdAt }));
      // The copy: never the real folder.
      if (folder) {
        const { files } = await sourceFiles(folder, this.host.git ?? runGit);
        const total = files.reduce((n, f) => n + f.size, 0), limit = settings.maxCopyMb * 1024 * 1024;
        if (total > limit) throw new Error(`The folder is larger than the sandbox copy limit (${settings.maxCopyMb} MB): ${formatBytes(total)} in ${files.length.toLocaleString('en')} files. Raise chatroom.sandbox.maxCopyMb, or run without files.`);
        signal.throwIfAborted();
        await copyFiles(folder, work, files, signal);
      }
      const script = request.code !== undefined ? `.chatroom-run.${EXTENSIONS[request.language ?? 'bash']}` : undefined;
      if (script) await writeFile(join(work, script), request.code!.endsWith('\n') ? request.code! : `${request.code}\n`);
      const before = await listing(work);
      signal.throwIfAborted();
      // The image: pulled with progress when it is not there yet (the pull uses the host's network; the container stays offline).
      const present = await docker(['image', 'inspect', '--format', '{{.Id}}', result.image], { timeoutMs: 30_000, signal });
      signal.throwIfAborted();
      if (present.code !== 0) {
        if (present.error === 'missing') throw new Error('Docker is not installed.');
        phase('pulling');
        let partial = '';
        const lines: string[] = [];
        const pulled = await docker(['pull', result.image], { timeoutMs: PULL_MS, signal, onOutput: (_stream, text) => {
          const all = (partial + text.replace(ANSI, '')).split(/\r?\n|\r/); partial = all.pop() ?? '';
          for (const line of all) if (line.trim()) lines.push(line.trim());
          lines.splice(0, Math.max(0, lines.length - 30));
          result.stdout = lines.join('\n'); soon();
        } });
        signal.throwIfAborted();
        if (pulled.code !== 0) throw new Error(`Couldn't download ${result.image}: ${(pulled.stderr || pulled.stdout || pulled.error || '').trim().split(/\r?\n/).slice(-2).join(' ') || `exit code ${pulled.code}`}`);
        result.stdout = '';
      }
      // The run.
      result.startedAt = this.now(); exited = false;
      phase('running');
      runAbort = new AbortController();
      signal.addEventListener('abort', onCancel, { once: true });
      const limit = setTimeout(() => void kill('timeout'), request.timeoutSeconds * 1000);
      const add = (stream: 'stdout' | 'stderr', text: string) => { result[stream] = (result[stream] + text.replace(ANSI, '')).slice(-SANDBOX_TAIL); soon(); };
      const args = dockerRunArgs({ id, image: result.image, request, settings, mount: longPath(work), pid: this.pid });
      const ran = await docker(args, { onOutput: add, signal: runAbort.signal });
      exited = true; clearTimeout(limit); signal.removeEventListener('abort', onCancel);
      result.finishedAt = this.now(); result.durationMs = Math.max(0, result.finishedAt - result.startedAt);
      // The docker CLI ended abnormally (too much output, or killed): its container may still be running.
      if (ran.error) await docker(['rm', '-f', containerName(id)], { timeoutMs: 15_000 });
      if (ran.code >= 0) result.exitCode = ran.code;
      if (reason === 'timeout') result.status = 'timeout';
      else if (reason === 'cancel' || signal.aborted) result.status = 'cancelled';
      else if (ran.error === 'overflow') { result.status = 'failed'; result.error = `The run printed more than ${formatBytes(MAX_OUTPUT_BYTES)}; it was stopped.`; }
      else if (ran.error) { result.status = 'failed'; result.error = ran.error === 'missing' ? 'Docker is not installed.' : ran.error; }
      else if (ran.code === 125 && /^docker: /m.test(ran.stderr)) { result.status = 'failed'; result.error = ran.stderr.trim().split(/\r?\n/).find(l => l.startsWith('docker: '))!.slice(8).slice(0, 500); }
      else result.status = 'done';
      // What the run made: files created or changed in the copy, with the text of requested outputs.
      if (result.status !== 'failed') {
        const after = await listing(work), wanted = request.outputs?.length ? globMatcher(request.outputs) : () => false;
        const changed = [...after.entries()].filter(([rel, f]) => rel !== script && (!before.has(rel) || before.get(rel)!.size !== f.size || before.get(rel)!.mtime !== f.mtime))
          .map(([rel, f]) => ({ path: rel, size: f.size })).sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_LISTED);
        const realWork = await realpath(work).catch(() => work);
        for (const file of changed as { path: string; size: number; text?: string }[]) {
          if (!wanted(file.path) || file.size > MAX_TEXT) continue;
          const full = join(work, file.path), info = await lstat(full).catch(() => undefined);
          if (!info?.isFile() || !insideDir(await realpath(full).catch(() => full), realWork)) continue;
          const bytes = await readFile(full).catch(() => undefined);
          if (bytes && !bytes.includes(0)) file.text = bytes.toString('utf8');
        }
        if (changed.length) result.files = changed;
      }
    } catch (error) {
      if (!result.finishedAt) result.finishedAt = this.now();
      if (result.startedAt && result.durationMs === undefined) result.durationMs = Math.max(0, result.finishedAt - result.startedAt);
      if (!exited) { exited = true; runAbort?.abort(); void docker(['rm', '-f', containerName(id)], { timeoutMs: 15_000 }); }
      if (signal.aborted || reason === 'cancel') result.status = 'cancelled';
      else { result.status = 'failed'; result.error = errorText(error).slice(0, 1000); }
    } finally {
      signal.removeEventListener('abort', onCancel);
      flush(); start.onStatus?.(result);
      this.host.log?.(`Sandbox: ${sandboxSummary(result)}`, result.status === 'failed' ? 'error' : 'tool');
    }
    return result;
  }
  /** Cancels a run in progress (its card's Cancel); false when it is not running here. */
  cancel(id: string): boolean { const run = this.active.get(id); run?.cancel(); return !!run; }
  /** Cancels every run of a room (Stop); returns how many. */
  cancelRoom(roomId: string): number {
    let n = 0;
    for (const run of [...this.active.values()]) if (run.roomId === roomId) { run.cancel(); n++; }
    return n;
  }
  /** Keeps the latest copies for inspection and removes the others (never a copy another window is still using). */
  async prune(keep = KEEP_COPIES): Promise<number> {
    const root = join(this.host.storageDir(), 'sandbox'), alive = this.host.alive ?? defaultAlive;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const copies: { path: string; createdAt: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || this.active.has(entry.name)) continue;
      const path = join(root, entry.name);
      let owner: { pid?: unknown; createdAt?: unknown } = {};
      try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')); } catch { /* No owner: an interrupted copy. */ }
      const pid = typeof owner.pid === 'number' ? owner.pid : undefined;
      if (pid !== undefined && pid !== this.pid && alive(pid)) continue;
      copies.push({ path, createdAt: typeof owner.createdAt === 'number' ? owner.createdAt : 0 });
    }
    copies.sort((a, b) => b.createdAt - a.createdAt);
    let removed = 0;
    for (const copy of copies.slice(keep)) { try { await removeTree(copy.path); removed++; } catch { /* In use: the next prune tries again. */ } }
    return removed;
  }
  /**
   * Removes `chatroom-sbx-*` containers left by a window that closed during a run (their `chatroom.pid` is not running) and
   * prunes old copies. Containers of other open windows and of this window's own runs are left alone.
   */
  async sweep(): Promise<{ containers: string[]; copies: number }> {
    const alive = this.host.alive ?? defaultAlive, docker = this.docker;
    const listed = await docker(['ps', '-a', '--filter', `name=${CONTAINER_PREFIX}`, '--format', '{{.Names}}\t{{.Label "chatroom.pid"}}'], { timeoutMs: 15_000 });
    const orphans: string[] = [];
    if (listed.code === 0) for (const line of listed.stdout.split(/\r?\n/)) {
      const [name = '', pidText = ''] = line.trim().split('\t'), pid = Number(pidText);
      if (!name.startsWith(CONTAINER_PREFIX) || this.active.has(name.slice(CONTAINER_PREFIX.length))) continue;
      if (Number.isInteger(pid) && pid > 0 && pid !== this.pid && alive(pid)) continue;
      orphans.push(name);
    }
    const removed: string[] = [];
    if (orphans.length) {
      const result = await docker(['rm', '-f', ...orphans], { timeoutMs: 60_000 });
      if (result.code === 0) removed.push(...orphans);
      else for (const name of orphans) if ((await docker(['rm', '-f', name], { timeoutMs: 30_000 })).code === 0) removed.push(name);
    }
    return { containers: removed, copies: await this.prune().catch(() => 0) };
  }
  /** Ends every run (window closing): kills their containers without waiting long. */
  dispose(): void {
    const names = [...this.active.keys()].map(containerName);
    for (const run of this.active.values()) run.cancel();
    if (names.length) void this.docker(['rm', '-f', ...names], { timeoutMs: 10_000 }).catch(() => undefined);
  }
}
/** Re-exported for callers that only import the sandbox. */
export { sandboxFinished, sandboxLanguage };
