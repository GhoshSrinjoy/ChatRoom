import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Isolation } from './engine';
import { Agent, Room, RoomChanges, TurnKind, WorktreeMode } from './types';
import { upsertChangesCard } from './core';

export interface GitRunner { (args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> }
const SCRUB = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];
/** The process environment without variables that would point git at another repository, with prompts off and English messages. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (SCRUB.includes(key.toUpperCase())) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: 'C', ...extra };
}
/** Runs git through execFile (no shell); resolves with the exit code, -1 when git could not run. */
export const runGit: GitRunner = (args, cwd, env) => new Promise(done => {
  execFile('git', args, { cwd, env: env ?? gitEnv(), windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
    const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? -1 : 0;
    done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (code === -1 && error ? `\n${error.message}` : ''), code });
  });
});

export const INTEGRATION = 'integration';
const IDENTITY = { GIT_AUTHOR_NAME: 'Chatroom', GIT_AUTHOR_EMAIL: 'chatroom@localhost', GIT_COMMITTER_NAME: 'Chatroom', GIT_COMMITTER_EMAIL: 'chatroom@localhost' };
/** Internal commands never run the user's hooks, signing, background gc, fsmonitor or rerere, and always write plain, machine-readable output. */
const SETTINGS = ['core.longpaths=true', 'core.quotePath=false', 'core.fsmonitor=false', 'core.splitIndex=false', 'gc.auto=0', 'maintenance.auto=false', 'commit.gpgSign=false',
  'merge.ff=true', 'merge.verifySignatures=false', 'rerere.enabled=false', 'submodule.recurse=false', 'diff.noprefix=false', 'diff.mnemonicPrefix=false', 'advice.detachedHead=false'];
const DIFF = ['--no-ext-diff', '--no-textconv', '--no-color'];
const MAX_FILES = 200, MAX_DIFF = 8_000_000;
const MARKER = /^(<<<<<<<|>>>>>>>)( |\r?$)/m;
const WIN = process.platform === 'win32';
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const pad = (n: number) => String(n).padStart(2, '0');
/** yyyymmdd-hhmm in local time. */
export const stamp = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };
/** Lowercase letters, digits and single dashes, at most `max` characters. */
export const slug = (text: string, max = 12) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');
const keyOf = (key: string) => slug(key) || 'agent';
/** The first 6 characters of a room id, as used in worktree folders and branches. */
export const room6 = (roomId: string) => (roomId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'room').slice(0, 6);
/** A path for comparisons: absolute, the long form of 8.3 names, case-insensitive on Windows. */
function canonical(path: string): string {
  let full = resolve(path);
  try { full = realpathSync.native(full); } catch { /* Not there (yet): compare as given. */ }
  return WIN ? full.toLowerCase() : full;
}
const samePath = (a: string, b: string) => canonical(a) === canonical(b);
const inside = (child: string, parent: string) => { const c = canonical(child), p = canonical(parent); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };
/** `<storageDir>/wt/<6-character hash of the repository path>`. */
export function worktreeRoot(storageDir: string, repo: string): string {
  const key = resolve(repo).replace(/\\/g, '/');
  return join(storageDir, 'wt', createHash('sha256').update(WIN ? key.toLowerCase() : key).digest('hex').slice(0, 6));
}
/** A repository-relative path from settings; absolute paths, `..`, `.git` and empty segments are refused. */
function relativePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!text || isAbsolute(text) || /^[a-zA-Z]:/.test(text) || text.startsWith('/')) return;
  const parts = text.split('/');
  return parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ? undefined : text;
}
/** Writes a temporary file next to `file`, then renames it over `file` (retried while Windows holds a lock). */
export async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, text);
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, file); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { await unlink(temp).catch(() => undefined); throw error; }
      await sleep(50 * (attempt + 1));
    }
  }
}
/** Removes a link (symlink or junction) itself, never what it points to. */
async function unlinkLink(path: string): Promise<void> {
  try { await unlink(path); } catch { await rmdir(path).catch(() => undefined); }
}
/** Removes every link inside `dir` without following any. Git for Windows follows junctions when it deletes a worktree. */
async function unlinkLinks(dir: string): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) await unlinkLink(full);
    else if (entry.isDirectory()) await unlinkLinks(full);
  }
}
/** Deletes a folder tree; links are unlinked, never followed. */
async function removeTree(path: string): Promise<void> {
  let info;
  try { info = await lstat(path); } catch { return; }
  if (info.isSymbolicLink()) return unlinkLink(path);
  if (!info.isDirectory()) {
    try { await unlink(path); } catch { await chmod(path, 0o666).catch(() => undefined); await unlink(path); }
    return;
  }
  for (const name of await readdir(path)) await removeTree(join(path, name));
  await rmdir(path);
}
const lexists = (path: string) => lstat(path).then(() => true, () => false);
/** Paths that `git apply` reports as not applying. */
function applyErrors(stderr: string): string[] {
  const paths = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    const hit = /^error: patch failed: (.+):\d+\s*$/.exec(line)
      ?? /^error: (.+?): (?:patch does not apply|already exists in working directory|does not exist in working directory|No such file or directory|wrong type|has type .+)\s*$/.exec(line);
    if (hit?.[1]) paths.add(hit[1]);
  }
  return [...paths];
}

interface Entry {
  roomId: string; key: string; path: string; branch: string; createdAt: number; lastUsed: number;
  /** The commit the worktree started from. */
  base?: string;
  /** The workspace folder that created it; sweep only removes its own. */
  owner?: string;
  /** Folders linked into the worktree (repository-relative), unlinked before removal. */
  links?: string[];
  /** Copied and linked paths that checkpoints never commit. */
  excludes?: string[];
}
export interface WorktreeInfo { roomId: string; key: string; path: string; branch: string; lastUsed: number }

/**
 * Per-agent git worktrees for one repository. Worktrees live in `root`, branches are `chatroom/<room6>/<key>`, and every
 * internal command runs without the user's hooks, as the Chatroom identity. Nothing here touches the user's index or files,
 * except `apply()`, which writes the combined changes to the working tree (never the index).
 */
export class WorktreeManager {
  readonly repo: string;
  readonly root: string;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly owner?: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(opts: { repo: string; root: string; git?: GitRunner; now?: () => number; owner?: string }) {
    this.repo = resolve(opts.repo); this.root = resolve(opts.root);
    this.git = opts.git ?? runGit; this.now = opts.now ?? Date.now;
    if (opts.owner) this.owner = resolve(opts.owner);
  }
  /** The repository top level for `dir`, or undefined (not a repository, or git is missing). */
  static async detect(dir: string, git: GitRunner = runGit): Promise<string | undefined> {
    try {
      const result = await git(['rev-parse', '--show-toplevel'], dir, gitEnv());
      const top = result.code === 0 ? result.stdout.trim() : '';
      return top ? resolve(top) : undefined;
    } catch { return undefined; }
  }
  branchName(roomId: string, key: string): string { return `chatroom/${room6(roomId)}/${keyOf(key)}`; }
  pathFor(roomId: string, key: string): string { return join(this.root, `${room6(roomId)}-${keyOf(key)}`); }
  /** The commit a local branch points at, or undefined. */
  head(branch: string): Promise<string | undefined> { return this.rev(`refs/heads/${branch}`); }

  // ── Snapshot and worktrees ──────────────────────────────────────────────────
  /** A commit of HEAD plus the user's uncommitted and untracked (not ignored) files, made with a temporary index. */
  snapshot(): Promise<string> { return this.exclusive(() => this.snapshotNow('Chatroom base')); }
  ensure(roomId: string, key: string, base: string, opts: { copy?: string[]; links?: string[] } = {}): Promise<{ path: string; branch: string; created: boolean }> {
    return this.exclusive(async () => { const { path, branch, created } = await this.ensureNow(roomId, key, base, opts); return { path, branch, created }; });
  }
  /** Commits every change in that worktree; undefined when nothing changed (or a merge is in progress). */
  checkpoint(path: string, message: string): Promise<string | undefined> { return this.exclusive(() => this.checkpointNow(path, message)); }

  // ── Combining ───────────────────────────────────────────────────────────────
  /** Merges each branch with new commits into the room's integration branch; a conflicting merge is aborted and reported. */
  integrate(roomId: string, base: string, branches: { key: string; branch: string }[]): Promise<{ branch: string; path: string; conflicts: { key: string; files: string[] }[] }> {
    return this.exclusive(async () => {
      const made = await this.ensureNow(roomId, INTEGRATION, base);
      // The combined branch is base + the agents' branches: one left over from an earlier base starts again from this one.
      if (made.previousBase && made.previousBase !== base) {
        await this.ok(['reset', '--hard', '-q', base], made.path);
        const entries = await this.load(), entry = entries.find(e => samePath(e.path, made.path));
        if (entry) { entry.base = base; await this.save(entries); }
      }
      const conflicts: { key: string; files: string[] }[] = [];
      for (const { key, branch } of branches) {
        if (!await this.head(branch)) continue;
        if (!Number((await this.ok(['rev-list', '--count', `HEAD..refs/heads/${branch}`], made.path)).trim())) continue;
        const merged = await this.run(['merge', '--no-ff', '--no-edit', '-m', `Chatroom: merge ${key}`, `refs/heads/${branch}`], made.path);
        if (merged.code === 0) continue;
        const files = await this.unmerged(made.path);
        await this.run(['merge', '--abort'], made.path);
        // The integration worktree is Chatroom's own: it never stays mid-merge.
        await this.run(['reset', '--hard', '-q', 'HEAD'], made.path);
        conflicts.push({ key, files });
      }
      return { branch: made.branch, path: made.path, conflicts };
    });
  }
  /** Merges `branch` into the worktree at `path`: the conflicted files (markers left in place), or [] when it merged and committed. */
  mergeInto(path: string, branch: string): Promise<string[]> {
    return this.exclusive(async () => {
      if (await this.rev('MERGE_HEAD', path)) return this.unmerged(path);
      const result = await this.run(['merge', '--no-edit', `refs/heads/${branch}`], path);
      if (result.code === 0) return [];
      const files = await this.unmerged(path);
      if (files.length) return files;
      await this.run(['merge', '--abort'], path);
      throw new Error(`git merge failed: ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
    });
  }
  /** After an agent resolved conflicts: true when no markers are left and the merge commit was made. */
  finishMerge(path: string): Promise<boolean> {
    return this.exclusive(async () => {
      const candidates = new Set([...await this.unmerged(path), ...(await this.ok(['diff', '--name-only', '-z', 'HEAD'], path)).split('\0').filter(Boolean)]);
      for (const rel of candidates) {
        try {
          const file = join(path, rel), info = await stat(file);
          if (info.isFile() && info.size < 20_000_000 && MARKER.test(await readFile(file, 'utf8'))) return false;
        } catch { /* Deleted or unreadable: no markers. */ }
      }
      await this.ok(['add', '-A', '--', '.', ...await this.excludes(path)], path);
      if (await this.rev('MERGE_HEAD', path)) return (await this.run(['commit', '-q', '--no-edit', '--no-verify'], path)).code === 0;
      if ((await this.run(['diff', '--cached', '--quiet', '--no-ext-diff'], path)).code === 1) await this.ok(['commit', '-q', '--no-verify', '-m', 'Chatroom: resolve conflicts'], path);
      return true;
    });
  }
  /** Leaves a merge that could not be finished, restoring the worktree's own commit. */
  abortMerge(path: string): Promise<void> {
    return this.exclusive(async () => {
      if (!await this.rev('MERGE_HEAD', path)) return;
      await this.run(['merge', '--abort'], path);
      if (await this.rev('MERGE_HEAD', path)) await this.run(['reset', '--merge'], path);
    });
  }
  /** Fast-forwards the worktree to `branch` (which contains its commits after integration). */
  sync(path: string, branch: string): Promise<void> { return this.exclusive(async () => { await this.ok(['merge', '--ff-only', '-q', `refs/heads/${branch}`], path); }); }

  // ── Review and apply ────────────────────────────────────────────────────────
  async changes(base: string, ref: string): Promise<Pick<RoomChanges, 'files' | 'added' | 'removed'>> {
    const target = await this.rev(ref) ?? ref;
    const numstat = (await this.ok(['diff', ...DIFF, '--numstat', '-z', '-M', base, target])).split('\0');
    const counts = new Map<string, { added: number; removed: number }>();
    for (let i = 0; i < numstat.length; i++) {
      const record = numstat[i]!;
      if (!record) continue;
      const [a = '0', r = '0', ...rest] = record.split('\t');
      let path = rest.join('\t');
      if (!path) { path = numstat[i + 2] ?? ''; i += 2; }
      counts.set(path, { added: Number(a) || 0, removed: Number(r) || 0 });
    }
    const names = (await this.ok(['diff', ...DIFF, '--name-status', '-z', '-M', base, target])).split('\0');
    const files: RoomChanges['files'] = [];
    let added = 0, removed = 0;
    for (let i = 0; i < names.length; ) {
      const code = names[i]?.[0];
      if (!code) break;
      const path = (code === 'R' || code === 'C' ? names[i + 2] : names[i + 1]) ?? '';
      i += code === 'R' || code === 'C' ? 3 : 2;
      const count = counts.get(path) ?? { added: 0, removed: 0 };
      added += count.added; removed += count.removed;
      if (files.length < MAX_FILES) files.push({ path, ...count, status: code === 'A' || code === 'C' ? 'A' : code === 'D' ? 'D' : code === 'R' ? 'R' : 'M' });
    }
    return { files, added, removed };
  }
  /** The patch between two commits, for review. */
  async diff(base: string, ref: string): Promise<string> {
    const text = await this.ok(['diff', ...DIFF, '-M', base, await this.rev(ref) ?? ref]);
    return text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n\n[The diff is longer than ${MAX_DIFF.toLocaleString('en')} characters; the rest is not shown.]\n` : text;
  }
  /**
   * Applies base..ref to the user's working tree (never the index), keeping their own uncommitted changes: a 3-way merge of their
   * current files with `ref` (in git's object store), then a plain `git apply` of the clean result. Files that conflict are left untouched.
   */
  apply(base: string, ref: string): Promise<{ ok: boolean; conflicts: string[]; output: string }> {
    return this.exclusive(async () => {
      const patch = join(this.root, `.apply-${process.pid}-${randomBytes(4).toString('hex')}.patch`);
      try {
        const target = await this.head(ref) ?? await this.rev(ref);
        if (!target) throw new Error(`There is no branch ${ref} to apply.`);
        const current = await this.snapshotNow('Chatroom: your folder', base);
        const merged = await this.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', current, target]);
        const conflicts: string[] = [];
        if (merged.code === 0 || merged.code === 1) {
          const [tree = '', ...rest] = merged.stdout.split('\n');
          if (merged.code === 1) for (const line of rest) { if (!line.trim()) break; if (!conflicts.includes(line.trim())) conflicts.push(line.trim()); }
          await this.ok(['diff', ...DIFF, '--binary', '--full-index', `--output=${patch}`, current, tree.trim(), '--', '.', ...conflicts.map(p => `:(exclude,literal,top)${p}`)]);
        } else if (merged.code === 129 || /usage: git merge-tree|unknown option/i.test(merged.stderr)) {
          // git before 2.38: no merge-tree --write-tree, so the patch applies whole or not at all.
          await this.ok(['diff', ...DIFF, '--binary', '--full-index', `--output=${patch}`, base, target]);
        } else throw new Error(`git merge-tree failed: ${merged.stderr.trim()}`);
        if ((await stat(patch)).size > 0) {
          const applied = await this.run(['apply', '--whitespace=nowarn', patch]);
          if (applied.code !== 0) {
            const failed = applyErrors(applied.stderr);
            return { ok: false, conflicts: [...new Set([...conflicts, ...(failed.length ? failed : ['(unknown file)'])])], output: applied.stderr.trim() };
          }
        }
        return { ok: !conflicts.length, conflicts, output: conflicts.length ? `Conflicts with your own changes: ${conflicts.join(', ')}` : '' };
      } finally { await unlink(patch).catch(() => undefined); }
    });
  }
  /** Keeps the integration branch as `chatroom/kept/<name>`; `keys` keep those agents' branches too (`<kept>-<key>`). */
  keep(roomId: string, name: string, keys: string[] = []): Promise<string> {
    return this.exclusive(async () => {
      const tip = await this.head(this.branchName(roomId, INTEGRATION));
      if (!tip) throw new Error('The agents have no combined changes to keep yet.');
      const label = name.trim().replace(/[^A-Za-z0-9._/-]+/g, '-').split('/').map(part => part.replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '').replace(/\.lock$/i, '')).filter(Boolean).join('/').slice(0, 80);
      const kept = await this.freeBranch(`chatroom/kept/${label || 'changes'}`);
      await this.ok(['branch', kept, tip]);
      for (const key of keys) {
        const own = await this.head(this.branchName(roomId, key));
        if (own) await this.ok(['branch', await this.freeBranch(`${kept}-${keyOf(key)}`), own]);
      }
      return kept;
    });
  }

  // ── Removal ─────────────────────────────────────────────────────────────────
  /** One worktree of a room, or all of them (integration included): links, lock, folder, branch and manifest entry. */
  remove(roomId: string, key?: string): Promise<void> {
    // No root: Chatroom never made a worktree for this repository, so there is nothing to remove (and git is not run).
    if (!existsSync(this.root)) return Promise.resolve();
    return this.exclusive(async () => { await this.removeNow(roomId, key); });
  }
  /** Removes the worktrees of rooms that no longer exist. Branches with work are kept as `chatroom/orphaned/<room6>-<date>`. */
  sweep(liveRooms: Set<string>): Promise<{ removed: string[]; keptBranches: string[] }> {
    if (!existsSync(this.root)) return Promise.resolve({ removed: [], keptBranches: [] });
    return this.exclusive(async () => {
      const entries = (await this.load()).filter(e => this.owns(e)), removed: string[] = [], keptBranches: string[] = [];
      for (const roomId of [...new Set(entries.filter(e => !liveRooms.has(e.roomId)).map(e => e.roomId))]) {
        const own = entries.filter(e => e.roomId === roomId), integration = own.find(e => e.key === INTEGRATION);
        const base = integration?.base ?? own.find(e => e.base)?.base;
        const combined = integration ? await this.head(integration.branch) : undefined, name = `chatroom/orphaned/${room6(roomId)}-${stamp(this.now())}`;
        if (combined && base && await this.ahead(base, combined)) { const kept = await this.freeBranch(name); await this.ok(['branch', kept, combined]); keptBranches.push(kept); }
        for (const entry of own.filter(e => e.key !== INTEGRATION)) {
          const tip = await this.head(entry.branch), since = combined ?? entry.base ?? base;
          if (tip && since && await this.ahead(since, tip)) { const kept = await this.freeBranch(`${name}-${entry.key}`); await this.ok(['branch', kept, tip]); keptBranches.push(kept); }
        }
        try { removed.push(...await this.removeNow(roomId)); } catch { /* Locked files: the next sweep tries again. */ }
      }
      // Folders in the root that neither the manifest nor git knows (an interrupted creation).
      const known = await this.load(), listed = await this.listed(), live = [...liveRooms].map(room6);
      for (const name of await readdir(this.root).catch(() => [] as string[])) {
        const full = join(this.root, name), prefix = /^([a-z0-9]{1,6})-[a-z0-9-]+$/.exec(name)?.[1];
        if (!prefix || live.includes(prefix) || known.some(e => samePath(e.path, full)) || listed.some(w => samePath(w.path, full))) continue;
        if ((await lstat(full).catch(() => undefined))?.isDirectory()) { try { await removeTree(full); removed.push(full); } catch { /* In use. */ } }
      }
      await this.pruneOwn();
      return { removed, keptBranches };
    });
  }
  async list(): Promise<WorktreeInfo[]> {
    return (await this.load()).map(e => ({ roomId: e.roomId, key: e.key, path: e.path, branch: e.branch, lastUsed: e.lastUsed }));
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  /** One git operation on this repository at a time: worktree, ref and manifest changes never race. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => mkdir(join(this.root, '.no-hooks'), { recursive: true })).then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private run(args: string[], cwd = this.repo, extra: NodeJS.ProcessEnv = {}) {
    return this.git(['-c', `core.hooksPath=${join(this.root, '.no-hooks').replace(/\\/g, '/')}`, ...SETTINGS.flatMap(s => ['-c', s]), ...args], cwd, gitEnv({ ...IDENTITY, ...extra }));
  }
  private async ok(args: string[], cwd = this.repo, extra?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.run(args, cwd, extra);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-4).join(' ') || `exit code ${result.code}`}`);
    return result.stdout;
  }
  private async rev(ref: string, cwd = this.repo): Promise<string | undefined> {
    const result = await this.run(['rev-parse', '-q', '--verify', `${ref}^{commit}`], cwd);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }
  private async ahead(from: string, to: string): Promise<boolean> { return Number((await this.ok(['rev-list', '--count', `${from}..${to}`])).trim()) > 0; }
  private async unmerged(cwd: string): Promise<string[]> { return (await this.ok(['diff', '--name-only', '-z', '--diff-filter=U'], cwd)).split('\0').filter(Boolean); }
  private async freeBranch(name: string): Promise<string> {
    for (let n = 1; ; n++) { const candidate = n === 1 ? name : `${name}-${n}`; if (!await this.head(candidate)) return candidate; }
  }
  private owns(entry: Entry): boolean { return !this.owner || !entry.owner || samePath(entry.owner, this.owner); }
  private async snapshotNow(message: string, parent?: string): Promise<string> {
    const index = join(this.root, `.index-${process.pid}-${randomBytes(4).toString('hex')}`), env = { GIT_INDEX_FILE: index };
    const head = await this.rev('HEAD');
    try {
      // Start from a copy of the user's index (fast, keeps sparse entries); without one, from HEAD. The real index is only read.
      const real = resolve(this.repo, (await this.ok(['rev-parse', '--git-path', 'index'])).trim());
      const seeded = await copyFile(real, index).then(() => true, () => false);
      if (!seeded && head) await this.ok(['read-tree', head], this.repo, env);
      await this.ok(['add', '-A', '--', '.'], this.repo, env);
      const tree = (await this.ok(['write-tree'], this.repo, env)).trim(), from = parent ?? head;
      return (await this.ok(['commit-tree', tree, ...(from ? ['-p', from] : []), '-m', message])).trim();
    } finally { await unlink(index).catch(() => undefined); await unlink(`${index}.lock`).catch(() => undefined); }
  }
  private async listed(): Promise<{ path: string; branch?: string }[]> {
    const list: { path: string; branch?: string }[] = [];
    for (const line of (await this.ok(['worktree', 'list', '--porcelain'])).split('\n')) {
      if (line.startsWith('worktree ')) list.push({ path: resolve(line.slice(9).trim()) });
      else if (line.startsWith('branch ') && list.length) list[list.length - 1]!.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    return list;
  }
  private async ensureNow(roomId: string, key: string, base: string, opts: { copy?: string[]; links?: string[] } = {}): Promise<{ path: string; branch: string; created: boolean; previousBase?: string }> {
    const path = this.pathFor(roomId, key), branch = this.branchName(roomId, key), name = keyOf(key);
    const registered = (await this.listed()).some(w => samePath(w.path, path));
    let created = false;
    if (!registered || !existsSync(path)) {
      // A folder git does not know (or a registration without its folder) is left over from an interrupted run.
      if (registered) { await this.run(['worktree', 'unlock', path]); await this.run(['worktree', 'prune']); }
      if (existsSync(path)) await removeTree(path);
      try {
        if (!await this.head(branch)) await this.ok(['worktree', 'add', '-b', branch, path, base]);
        // The branch is Chatroom's own: a stale registration elsewhere (locked, so not pruned) does not block it.
        else if ((await this.run(['worktree', 'add', path, branch])).code !== 0) await this.ok(['worktree', 'add', '--force', path, branch]);
      } catch (error) {
        // Git refuses a GIT_DIR longer than PATH_MAX - 40 (220 characters on Windows, whatever core.longpaths says): <repo>\.git\worktrees\<name>.
        if (/GIT_DIR' too big/.test(errorText(error))) throw new Error('This repository\'s path is too long for git worktrees on Windows (git allows 220 characters for <repository>\\.git\\worktrees\\<name>). Move it to a shorter path to give agents their own worktrees.');
        throw error;
      }
      await this.run(['worktree', 'lock', '--reason', `chatroom ${roomId} ${name}`, path]);
      created = true;
    }
    const entries = await this.load(), previous = entries.find(e => samePath(e.path, path));
    const links = new Set(previous?.links ?? []), excludes = new Set(previous?.excludes ?? []);
    for (const raw of opts.copy ?? []) {
      const rel = relativePath(raw), from = rel && join(this.repo, rel), to = rel && join(path, rel);
      if (!rel || !from || !to || !existsSync(from) || await lexists(to)) continue;
      try { await mkdir(dirname(to), { recursive: true }); await cp(from, to, { recursive: true, force: false, errorOnExist: false }); excludes.add(rel); } catch { /* Optional. */ }
    }
    for (const raw of opts.links ?? []) {
      const rel = relativePath(raw), target = rel && join(this.repo, rel), at = rel && join(path, rel);
      if (!rel || !target || !at || await lexists(at) || !(await stat(target).catch(() => undefined))?.isDirectory()) continue;
      try { await mkdir(dirname(at), { recursive: true }); await symlink(target, at, WIN ? 'junction' : 'dir'); links.add(rel); excludes.add(rel); } catch { /* Optional. */ }
    }
    const now = this.now();
    const entry: Entry = { roomId, key: name, path, branch, createdAt: previous?.createdAt ?? now, lastUsed: now, base: previous?.base ?? base,
      ...(this.owner ? { owner: this.owner } : {}), ...(links.size ? { links: [...links] } : {}), ...(excludes.size ? { excludes: [...excludes] } : {}) };
    await this.save([...entries.filter(e => e !== previous), entry]);
    return { path, branch, created, ...(previous?.base ? { previousBase: previous.base } : {}) };
  }
  /**
   * Pathspecs that keep copied files and linked folders out of commits (a linked worktree shares info/exclude with the user's
   * repository, so that file is never written). Paths git already ignores need none: `git add` refuses a pathspec naming one.
   */
  private async excludes(path: string): Promise<string[]> {
    const rels = (await this.load()).find(e => samePath(e.path, path))?.excludes ?? [];
    if (!rels.length) return [];
    const ignored = new Set((await this.run(['check-ignore', '--', ...rels], path)).stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    return rels.filter(rel => !ignored.has(rel)).map(rel => `:(exclude,literal,top)${rel}`);
  }
  private async checkpointNow(path: string, message: string): Promise<string | undefined> {
    if (await this.rev('MERGE_HEAD', path)) return undefined;
    await this.ok(['add', '-A', '--', '.', ...await this.excludes(path)], path);
    const staged = await this.run(['diff', '--cached', '--quiet', '--no-ext-diff'], path);
    if (staged.code === 0) return undefined;
    if (staged.code !== 1) throw new Error(`git diff failed: ${staged.stderr.trim()}`);
    await this.ok(['commit', '-q', '--no-verify', '-m', message], path);
    const entries = await this.load(), entry = entries.find(e => samePath(e.path, path));
    if (entry) { entry.lastUsed = this.now(); await this.save(entries); }
    return this.rev('HEAD', path);
  }
  private async removeNow(roomId: string, key?: string): Promise<string[]> {
    const prefix = `${room6(roomId)}-`, wanted = key === undefined ? undefined : `${prefix}${keyOf(key)}`;
    const entries = await this.load();
    const targets = entries.filter(e => e.roomId === roomId && (key === undefined || e.key === keyOf(key)));
    for (const w of await this.listed()) {
      const name = basename(w.path);
      if (inside(w.path, this.root) && name.startsWith(prefix) && (!wanted || name === wanted) && !targets.some(t => samePath(t.path, w.path)))
        targets.push({ roomId, key: name.slice(prefix.length), path: w.path, branch: w.branch ?? this.branchName(roomId, name.slice(prefix.length)), createdAt: 0, lastUsed: 0 });
    }
    const removed: string[] = [], failed: string[] = [];
    for (const entry of targets) {
      try { await this.removeOne(entry); removed.push(entry.path); }
      catch (error) { failed.push(`${basename(entry.path)} (${errorText(error)})`); }
    }
    if (removed.length) await this.save((await this.load()).filter(e => !removed.some(path => samePath(path, e.path))));
    if (failed.length) throw new Error(`Some worktrees could not be removed: ${failed.join('; ')}`);
    return removed;
  }
  private async removeOne(entry: Entry): Promise<void> {
    const path = entry.path;
    if (existsSync(path)) {
      for (const rel of entry.links ?? []) { const at = relativePath(rel) && join(path, rel); if (at && (await lstat(at).catch(() => undefined))?.isSymbolicLink()) await unlinkLink(at); }
      // Any other link inside (an agent's own pnpm install, say): git would delete through it.
      await unlinkLinks(path);
      await this.run(['fsmonitor--daemon', 'stop'], path);
    }
    await this.run(['worktree', 'unlock', path]);
    let removed = false;
    for (let attempt = 0; existsSync(path) && !removed && attempt < 3; attempt++) {
      if (attempt) await sleep(300 * attempt);
      removed = (await this.run(['worktree', 'remove', '--force', path])).code === 0;
    }
    // git could not do it (Windows file locks, or the folder was already gone): delete it ourselves, then drop the registration.
    if (!removed) {
      if (existsSync(path)) { await unlinkLinks(path); await removeTree(path); }
      await this.pruneOwn();
    }
    await this.run(['branch', '-D', entry.branch]);
  }
  /**
   * `git worktree prune`, only when one of Chatroom's own registrations has lost its folder. Prune is repository-wide, so it is
   * never run otherwise (it would also drop the user's own unlocked worktrees whose folders are missing, on an unplugged drive say).
   */
  private async pruneOwn(): Promise<void> {
    if ((await this.listed()).some(w => inside(w.path, this.root) && !existsSync(w.path))) await this.run(['worktree', 'prune']);
  }
  private async load(): Promise<Entry[]> {
    try {
      const data = JSON.parse(await readFile(join(this.root, 'manifest.json'), 'utf8'));
      return (Array.isArray(data?.worktrees) ? data.worktrees : []).filter((e: Partial<Entry>) => e && typeof e.roomId === 'string' && typeof e.key === 'string' && typeof e.path === 'string' && typeof e.branch === 'string');
    } catch { return []; }
  }
  private async save(entries: Entry[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await atomicWrite(join(this.root, 'manifest.json'), JSON.stringify({ worktrees: entries }, null, 2));
  }
}

// ── Codex trust entries ───────────────────────────────────────────────────────
const normalizeDir = (path: string) => path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/**
 * Removes `[projects.'<path>']` sections for folders inside `root` from a Codex config.toml, only when the section holds nothing
 * but a `trust_level = …` line and blank lines. Everything else is left exactly as it was.
 */
export function removeCodexTrust(configText: string, root: string): string {
  const base = normalizeDir(root);
  if (!base) return configText;
  const lines = configText.split('\n'), out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length;) {
    const header = /^\s*\[\s*projects\s*\.\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*\]\s*\r?$/.exec(lines[i]!);
    let end = i + 1;
    if (header) while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
    const body = lines.slice(i + 1, end), path = header ? normalizeDir(header[1] ?? header[2]!.replace(/\\(.)/g, '$1')) : '';
    const trustOnly = body.every(l => /^\s*(?:trust_level\s*=\s*\S[^\r\n]*)?\s*$/.test(l)) && body.filter(l => l.trim()).length === 1;
    if (header && trustOnly && (path === base || path.startsWith(`${base}/`))) { changed = true; i = end; continue; }
    out.push(...lines.slice(i, end)); i = end;
  }
  if (!changed) return configText;
  const text = out.join('\n');
  return configText.endsWith('\n') && !text.endsWith('\n') ? `${text}\n` : text;
}
/** Applies removeCodexTrust to the user's Codex config ($CODEX_HOME or ~/.codex), writing only when it changed. */
export async function cleanCodexTrust(root: string, home = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<boolean> {
  const file = join(home, 'config.toml');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return false; }
  const next = removeCodexTrust(text, root);
  if (next === text) return false;
  await atomicWrite(await realpath(file).catch(() => file), next);
  return true;
}

// ── The host's isolation (no vscode) ──────────────────────────────────────────
export interface RoomWorktreesHost {
  /** The repository's manager, or undefined when the workspace is not a git repository. */
  manager(): WorktreeManager | undefined;
  /** The room's mode, else the chatroom.worktrees setting. */
  mode(room: Room): WorktreeMode;
  /** Whether the agent runs as its own CLI. */
  native(agent: Agent): boolean;
  copy(): string[];
  links(): string[];
  autoApply(): boolean;
  log(text: string, kind?: 'info' | 'tool' | 'error'): void;
  toast(type: 'error' | 'notice', text: string): void;
  /** Ends the room's CLI processes, which hold their worktree folders open. */
  release(roomId: string): Promise<void>;
  changed(): void;
  now?(): number;
}
const live = (changes: RoomChanges | undefined): changes is RoomChanges => !!changes && (changes.status === 'ready' || changes.status === 'conflict');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (items: string[], max = 8) => items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');

/** Chatroom's isolation for the engine, plus the review actions, over a WorktreeManager. */
export class RoomWorktrees implements Isolation {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly host: RoomWorktreesHost) {}
  private now(): number { return this.host.now?.() ?? Date.now(); }
  /** Worktree work for the rooms runs one step at a time (two agents preparing at once share one base). */
  private serial<T>(run: () => Promise<T>): Promise<T> { const next = this.chain.then(run); this.chain = next.catch(() => undefined); return next; }
  private manager(): WorktreeManager {
    const manager = this.host.manager();
    if (!manager) throw new Error('Worktrees need a git repository.');
    return manager;
  }
  /** The agent's worktree key: its branch's last part once it has one, else its name and id. */
  keyOf(agent: Agent): string { return agent.worktree?.branch.split('/').pop() || `${slug(agent.name, 6) || 'agent'}-${slug(agent.id.replace(/[^a-z0-9]/gi, ''), 5) || 'x'}`; }
  branchFor(room: Room, agent: Agent): string { return agent.worktree?.branch ?? this.host.manager()?.branchName(room.id, this.keyOf(agent)) ?? `chatroom/${room6(room.id)}/${this.keyOf(agent)}`; }
  private belongs(room: Room, agent: Agent): agent is Agent & { worktree: NonNullable<Agent['worktree']> } {
    return !!agent.worktree && basename(agent.worktree.path).startsWith(`${room6(room.id)}-`);
  }
  private isolated(room: Room) { return room.agents.filter(a => this.belongs(room, a)) as (Agent & { worktree: NonNullable<Agent['worktree']> })[]; }
  /** The agent's folder while it is isolated in this room and the folder exists. */
  cwdFor(room: Room, agent: Agent): string | undefined { return this.belongs(room, agent) && existsSync(agent.worktree.path) ? agent.worktree.path : undefined; }

  wants(agent: Agent, room: Room, kind?: TurnKind): boolean {
    if (!this.host.manager() || !this.host.native(agent)) return false;
    if (agent.isolate) return true;
    const mode = this.host.mode(room), permission = agent.options?.permission;
    if (mode === 'always') return permission !== 'plan';
    if (mode !== 'auto' || (permission !== 'auto-edit' && permission !== 'full')) return false;
    // Relay and 1:1 turns run one agent at a time.
    if (kind === 'direct' || !['parallel', 'orchestrated', 'pipeline'].includes(room.mode ?? 'sequential')) return false;
    return room.agents.some(a => a !== agent && a.enabled && this.host.native(a) && a.options?.permission !== 'plan');
  }
  prepare(room: Room, agent: Agent): Promise<string> {
    return this.serial(async () => {
      const manager = this.manager();
      if (!live(room.changes)) {
        // Worktrees an earlier apply, keep or discard could not remove (a locked file, say) must not bring old work into the new changes.
        for (const entry of (await manager.list()).filter(e => e.roomId === room.id && !room.agents.some(a => a.worktree && samePath(a.worktree.path, e.path)))) {
          try { await manager.remove(room.id, entry.key); } catch (error) { this.host.log(`${errorText(error)} · use Clean up old worktrees`, 'error'); }
        }
        const base = await manager.snapshot();
        room.changes = { base, branch: manager.branchName(room.id, INTEGRATION), path: manager.pathFor(room.id, INTEGRATION), files: [], added: 0, removed: 0, status: 'ready', updatedAt: this.now() };
        this.host.changed();
      }
      // A new worktree starts from the combined work so far, when there is some.
      const changes = room.changes!, start = await manager.head(changes.branch) ?? changes.base;
      const made = await manager.ensure(room.id, this.keyOf(agent), start, { copy: this.host.copy(), links: this.host.links() });
      if (!agent.worktree || !samePath(agent.worktree.path, made.path) || agent.worktree.branch !== made.branch)
        agent.worktree = { path: made.path, branch: made.branch, createdAt: this.now(), checkpoints: agent.worktree?.checkpoints ?? 0 };
      if (made.created) this.host.log(`${agent.name} works in its own worktree · branch ${made.branch}`);
      this.host.changed();
      return made.path;
    });
  }
  checkpoint(room: Room, agent: Agent, note: string): Promise<void> { return this.serial(() => this.checkpointNow(room, agent, note)); }
  private async checkpointNow(room: Room, agent: Agent, note: string): Promise<void> {
    const manager = this.host.manager();
    if (!manager || !this.belongs(room, agent) || !existsSync(agent.worktree.path)) return;
    if (await manager.checkpoint(agent.worktree.path, `Chatroom: ${agent.name} · ${note}`)) { agent.worktree.checkpoints++; this.host.changed(); }
  }
  integrate(room: Room): Promise<{ conflicts: { agentId: string; files: string[] }[] }> { return this.serial(() => this.integrateNow(room, true)); }
  private async integrateNow(room: Room, auto: boolean): Promise<{ conflicts: { agentId: string; files: string[] }[] }> {
    const manager = this.host.manager(), changes = room.changes;
    if (!manager || !live(changes)) return { conflicts: [] };
    const agents = this.isolated(room);
    const result = await manager.integrate(room.id, changes.base, agents.map(a => ({ key: this.keyOf(a), branch: a.worktree.branch })));
    const conflicts = result.conflicts.map(c => ({ agentId: agents.find(a => this.keyOf(a) === c.key)?.id ?? c.key, files: c.files }));
    for (const agent of agents) {
      if (conflicts.some(c => c.agentId === agent.id) || !existsSync(agent.worktree.path)) continue;
      try { await manager.sync(agent.worktree.path, result.branch); }
      catch (error) { this.host.log(`${agent.name}'s worktree could not catch up with the combined work · ${errorText(error)}`, 'error'); }
    }
    const stats = await manager.changes(changes.base, result.branch);
    room.changes = { base: changes.base, branch: result.branch, path: result.path, ...stats, status: conflicts.length ? 'conflict' : 'ready', ...(conflicts.length ? { conflicts } : {}), updatedAt: this.now() };
    upsertChangesCard(room, this.now(), false);
    this.host.changed();
    if (auto && this.host.autoApply() && !conflicts.length && stats.files.length) await this.applyNow(room);
    return { conflicts };
  }
  mergeInto(room: Room, agent: Agent): Promise<string[]> {
    return this.serial(async () => {
      const manager = this.manager(), changes = room.changes;
      if (!this.belongs(room, agent) || !changes) return [];
      await this.checkpointNow(room, agent, 'before merging');
      return manager.mergeInto(agent.worktree.path, changes.branch);
    });
  }
  finishMerge(room: Room, agent: Agent): Promise<boolean> {
    return this.serial(async () => {
      const manager = this.manager();
      if (!this.belongs(room, agent)) return false;
      const done = await manager.finishMerge(agent.worktree.path);
      if (done) agent.worktree.checkpoints++; else await manager.abortMerge(agent.worktree.path);
      this.host.changed();
      return done;
    });
  }

  // ── The user's actions ──────────────────────────────────────────────────────
  /** Saves what agents left uncommitted and combines again, so a review or apply sees all of it. Only while the room is idle. */
  private async refresh(room: Room): Promise<void> {
    if (!live(room.changes)) return;
    for (const agent of this.isolated(room)) {
      try { await this.checkpointNow(room, agent, 'before review'); } catch (error) { this.host.log(`${agent.name}: ${errorText(error)}`, 'error'); }
    }
    await this.integrateNow(room, false);
  }
  /** The combined patch, followed by the patches that could not be combined. `idle` refreshes first. */
  review(room: Room, idle: boolean): Promise<string> {
    return this.serial(async () => {
      const manager = this.manager();
      if (idle) await this.refresh(room);
      const changes = room.changes;
      if (!changes) throw new Error('There are no changes from the agents to review.');
      let text = changes.files.length ? await manager.diff(changes.base, changes.branch).catch(() => '') : '';
      for (const conflict of changes.conflicts ?? []) {
        const agent = room.agents.find(a => a.id === conflict.agentId);
        if (!agent?.worktree) continue;
        text += `\n# ${agent.name}'s changes that could not be combined (branch ${agent.worktree.branch}; conflicts in ${conflict.files.join(', ')})\n`
          + await manager.diff(changes.base, agent.worktree.branch).catch(error => `# ${errorText(error)}\n`);
      }
      return text.trim() ? text : '# The agents have not changed any files yet.\n';
    });
  }
  /** Applies the combined changes to the user's folder; true when everything applied (the worktrees are then removed). */
  apply(room: Room): Promise<boolean> { return this.serial(async () => { await this.refresh(room); return this.applyNow(room); }); }
  private async applyNow(room: Room): Promise<boolean> {
    const manager = this.manager(), changes = room.changes;
    if (!live(changes) || !changes.files.length) throw new Error('There are no changes from the agents to apply.');
    if (changes.status === 'conflict') throw new Error('Some agents\' changes could not be combined yet. Review them, keep them as a branch, or discard them.');
    const result = await manager.apply(changes.base, changes.branch);
    if (!result.ok) {
      this.host.toast('error', `Some changes didn't apply cleanly: ${listed(result.conflicts)}. Your files were not changed for those parts; review the diff or keep the branch.`);
      this.host.log(`Applying the agents' changes: ${result.output || 'conflicts'}`, 'error');
      return false;
    }
    Object.assign(changes, { status: 'applied', updatedAt: this.now() });
    upsertChangesCard(room, this.now());
    this.host.toast('notice', `Applied ${plural(changes.files.length, 'file')} to your folder. They are not committed.`);
    await this.drop(room);
    return true;
  }
  /** Keeps the combined changes (and branches that could not be combined) as branches; returns the branch. */
  keep(room: Room, name?: string): Promise<string> {
    return this.serial(async () => {
      const manager = this.manager();
      await this.refresh(room);
      const changes = room.changes;
      if (!live(changes) || (!changes.files.length && !changes.conflicts?.length)) throw new Error('There are no changes from the agents to keep.');
      const label = name?.trim() || `${slug(room.title, 40) || 'chatroom'}-${stamp(this.now())}`;
      const keys = (changes.conflicts ?? []).map(c => room.agents.find(a => a.id === c.agentId)).filter((a): a is Agent => !!a?.worktree).map(a => this.keyOf(a));
      const branch = await manager.keep(room.id, label, keys);
      Object.assign(changes, { status: 'kept', kept: branch, updatedAt: this.now() });
      upsertChangesCard(room, this.now());
      this.host.toast('notice', `Kept as branch ${branch}.`);
      await this.drop(room);
      return branch;
    });
  }
  discard(room: Room): Promise<void> {
    return this.serial(async () => {
      this.manager();
      if (live(room.changes)) {
        Object.assign(room.changes, { status: 'discarded', updatedAt: this.now() });
        upsertChangesCard(room, this.now(), room.changes.files.length > 0);
      }
      await this.drop(room);
    });
  }
  /** Removes every worktree of the room and the isolation marks; agents work in the shared folder from their next turn. */
  private async drop(room: Room): Promise<void> {
    const manager = this.manager();
    await this.host.release(room.id).catch(() => undefined);
    try { await manager.remove(room.id); }
    catch (error) { this.host.log(`${errorText(error)} · use Clean up old worktrees later`, 'error'); }
    for (const agent of room.agents) delete agent.worktree;
    delete room.changes;
    this.host.changed();
  }
  /** Orphans of rooms that no longer exist, worktrees no agent of a live room uses, and Codex trust entries for removed folders. */
  cleanup(rooms: Room[]): Promise<{ removed: number; kept: string[] }> {
    return this.serial(async () => {
      const manager = this.manager(), swept = await manager.sweep(new Set(rooms.map(r => r.id)));
      let removed = swept.removed.length;
      for (const room of rooms) {
        if (live(room.changes)) continue;
        const used = room.agents.map(a => a.worktree?.path).filter((p): p is string => !!p);
        for (const entry of (await manager.list()).filter(e => e.roomId === room.id && !used.some(p => samePath(p, e.path)))) {
          try { await this.host.release(room.id); await manager.remove(room.id, entry.key); removed++; } catch (error) { this.host.log(errorText(error), 'error'); }
        }
      }
      await cleanCodexTrust(manager.root).catch(() => false);
      return { removed, kept: swept.keptBranches };
    });
  }
  /** /worktrees status. */
  describe(room: Room, available: boolean): string {
    const mode = this.host.mode(room), changes = room.changes;
    const lines = [`Worktrees: ${mode}${room.worktrees ? ' (this room)' : ' (setting)'}${available ? '' : ' · needs a git repository, so agents share the folder'}.`];
    for (const agent of room.agents) if (agent.worktree) lines.push(`- ${agent.name}: branch ${agent.worktree.branch} · ${plural(agent.worktree.checkpoints, 'checkpoint')}`);
    for (const agent of room.agents) if (agent.isolate && !agent.worktree) lines.push(`- ${agent.name}: works in its own worktree from its next turn`);
    if (live(changes)) lines.push(`Changes: ${plural(changes.files.length, 'file')} (+${changes.added} −${changes.removed}) · ${changes.status === 'conflict' ? 'some could not be combined' : 'ready to review'} · base ${changes.base.slice(0, 8)}.`);
    else if (!room.agents.some(a => a.worktree || a.isolate)) lines.push('No agent works in its own worktree in this room.');
    return lines.join('\n');
  }
}
