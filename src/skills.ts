import { cp, copyFile, lstat, mkdir, readFile, readdir, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { NativeProviderId, SharedSkill, SkillSource, SkillWiring } from './types';

export const MAX_SKILLS = 500, COPY_LIMIT = 2_000_000;
export interface SkillRoot { dir: string; source: SkillSource; recursive: boolean; nativeTo: NativeProviderId[]; depth?: number; underSkills?: boolean }
export function skillRoots(workspace: string | undefined, home = homedir()): SkillRoot[] {
  const user: SkillRoot[] = [
    { dir: join(home, '.claude', 'skills'), source: 'claude-user', recursive: false, nativeTo: ['claude'] },
    { dir: join(home, '.claude', 'plugins'), source: 'claude-plugin', recursive: true, nativeTo: ['claude'], depth: 6, underSkills: true },
    { dir: join(home, '.agents', 'skills'), source: 'agents-user', recursive: true, nativeTo: ['codex', 'copilot'], depth: 3 },
    { dir: join(home, '.codex', 'skills'), source: 'codex-user', recursive: false, nativeTo: ['codex'] },
    { dir: join(home, '.copilot', 'skills'), source: 'copilot-user', recursive: false, nativeTo: ['copilot'] }
  ];
  if (!workspace) return user;
  const project: SkillRoot[] = [
    { dir: join(workspace, '.claude', 'skills'), source: 'claude-project', recursive: false, nativeTo: ['claude', 'copilot'] },
    { dir: join(workspace, '.agents', 'skills'), source: 'agents-project', recursive: false, nativeTo: ['codex', 'copilot'] },
    { dir: join(workspace, '.codex', 'skills'), source: 'codex-project', recursive: false, nativeTo: ['codex'] },
    { dir: join(workspace, '.github', 'skills'), source: 'github-project', recursive: false, nativeTo: ['copilot'] }
  ];
  // Spec table order: claude-user, claude-project, claude-plugin, agents-user, agents-project, codex-user, codex-project, github-project, copilot-user.
  return [user[0]!, project[0]!, user[1]!, user[2]!, project[1]!, user[3]!, project[2]!, project[3]!, user[4]!];
}
const unquote = (value: string) => /^(["']).*\1$/s.test(value) ? value.slice(1, -1).replace(/\\(["'])/g, '$1') : value;
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const result: { name?: string; description?: string } = {};
  for (let i = 1; i < lines.length && lines[i]!.trim() !== '---'; i++) {
    const match = /^(name|description)\s*:\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    let value = match[2]!.trim();
    const block = /^[>|][+-]?\d*$/.test(value) || value === '';
    const more: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && lines[i + 1]!.trim() !== '---') more.push(lines[++i]!.trim());
    value = block ? more.join(' ') : [value, ...more].join(' ');
    value = unquote(value.trim()).trim();
    if (value) result[match[1] as 'name' | 'description'] = value;
  }
  return result;
}
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function entries(dir: string) { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } }
/** Skill folders (each holds a SKILL.md) under a root. Hidden folders such as Codex's `.system` are skipped. */
async function skillDirs(root: SkillRoot): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    for (const entry of await entries(dir)) {
      if (found.length >= MAX_SKILLS * 2 || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if ((!root.underSkills || basename(dir) === 'skills') && await exists(join(path, 'SKILL.md'))) { found.push(path); continue; }
      if (root.recursive && entry.isDirectory() && level < (root.depth ?? 1)) await walk(path, level + 1);
    }
  };
  await walk(root.dir, 1);
  return found;
}
export async function discoverSkills(workspace: string | undefined, home?: string): Promise<SharedSkill[]> {
  const skills: SharedSkill[] = [], seen = new Set<string>();
  for (const root of skillRoots(workspace, home)) {
    for (const dir of await skillDirs(root)) {
      if (skills.length >= MAX_SKILLS) return skills;
      const path = join(dir, 'SKILL.md');
      let meta: { name?: string; description?: string } = {};
      try { meta = parseSkillFrontmatter((await readFile(path, 'utf8')).slice(0, 64_000)); } catch { continue; }
      const name = meta.name ?? basename(dir), key = name + '\0' + root.source;
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({ name, description: meta.description ?? '', path, dir, source: root.source, nativeTo: root.nativeTo });
    }
  }
  return skills;
}
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'skill';
async function folderSize(dir: string, limit: number): Promise<number> {
  let total = 0;
  for (const entry of await entries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(path, limit - total);
    else if (entry.isFile()) total += (await stat(path)).size;
    if (total > limit) return total;
  }
  return total;
}
/** Removes a generated folder. Links are unlinked first so the skills they point to are never touched. */
async function clearGenerated(dir: string): Promise<void> {
  for (const entry of await entries(dir)) {
    const path = join(dir, entry.name);
    try {
      if ((await lstat(path)).isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) { await unlink(path).catch(() => rmdir(path)); continue; }
    } catch { continue; }
    if (entry.isDirectory()) await clearGenerated(path);
  }
  await rm(dir, { recursive: true, force: true });
}
async function linkSkill(skill: SharedSkill, target: string): Promise<void> {
  try { await symlink(skill.dir, target, process.platform === 'win32' ? 'junction' : 'dir'); return; } catch { /* Fall back to a copy. */ }
  await rm(target, { recursive: true, force: true });
  if (await folderSize(skill.dir, COPY_LIMIT) < COPY_LIMIT) { await cp(skill.dir, target, { recursive: true, dereference: true }); return; }
  await mkdir(target, { recursive: true }); await copyFile(skill.path, join(target, 'SKILL.md'));
}
async function linkAll(skills: SharedSkill[], dir: string): Promise<number> {
  const used = new Set<string>(); let linked = 0;
  for (const skill of skills) {
    const base = safeName(skill.name); let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    used.add(name.toLowerCase());
    try { await mkdir(dir, { recursive: true }); await linkSkill(skill, join(dir, name)); linked++; } catch { /* Skip a skill that cannot be shared. */ }
  }
  return linked;
}
const oneLine = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? flat.slice(0, max - 1) + '…' : flat; };
export function skillsIndex(skills: SharedSkill[]): string {
  return ['# Skills shared in this room', '', 'Each skill is a folder with a SKILL.md. Read the SKILL.md and follow it when a skill fits the task.', '',
    ...skills.map(s => `- ${s.name} (${s.source}): ${oneLine(s.description, 300) || 'No description.'} — ${s.path}`)].join('\n') + '\n';
}
/** Wires the discovered skills into each CLI's own loading mechanism, under `<storageDir>/shared-skills`. */
export async function prepareSkillWiring(skills: SharedSkill[], storageDir: string, _workspace: string | undefined): Promise<SkillWiring> {
  const root = join(storageDir, 'shared-skills'), pluginDir = join(root, 'claude', 'chatroom-shared'), copilotDir = join(root, 'copilot');
  await clearGenerated(join(root, 'claude')); await clearGenerated(copilotDir);
  const missing = (provider: NativeProviderId) => skills.filter(s => !s.nativeTo.includes(provider));
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
  await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'chatroom-shared', version: '1.0.0', description: 'Skills shared from the other agents in Chatroom' }, null, 2));
  const claudeLinked = await linkAll(missing('claude'), join(pluginDir, 'skills'));
  const copilotLinked = await linkAll(missing('copilot'), join(copilotDir, '.github', 'skills'));
  const indexPath = join(root, 'INDEX.md');
  await writeFile(indexPath, skillsIndex(skills));
  return {
    ...(claudeLinked ? { claudePluginDir: pluginDir } : {}),
    ...(copilotLinked ? { copilotAddDir: copilotDir } : {}),
    codexExtraRoots: [...new Set(missing('codex').map(s => dirname(s.dir)))],
    indexPath, indexDir: root, skills
  };
}
