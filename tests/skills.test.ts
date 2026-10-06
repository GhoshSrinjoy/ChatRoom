import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { skillRoots, parseSkillFrontmatter, discoverSkills, prepareSkillWiring } from '../src/skills';

async function skill(dir: string, body: string) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), body); }
const fm = (name: string, description = `${name} helps`) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'chatroom-skills-')), home = join(base, 'home'), ws = join(base, 'ws');
  await skill(join(home, '.claude', 'skills', 'cu'), fm('claude-user-skill'));
  await skill(join(ws, '.claude', 'skills', 'cp'), fm('claude-project-skill'));
  await skill(join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'plugged'), fm('plugin-skill'));
  await skill(join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'notskills', 'ignored'), fm('not-a-plugin-skill'));
  await skill(join(home, '.agents', 'skills', 'group', 'nested'), fm('agents-nested'));
  await skill(join(ws, '.agents', 'skills', 'ap'), fm('agents-project-skill'));
  await skill(join(home, '.codex', 'skills', 'cx'), fm('codex-user-skill'));
  await skill(join(home, '.codex', 'skills', '.system', 'sys'), fm('system-skill'));
  await skill(join(home, '.codex', 'skills', '.system'), fm('system-root'));
  await skill(join(ws, '.codex', 'skills', 'cxp'), fm('codex-project-skill'));
  await skill(join(ws, '.github', 'skills', 'gh'), fm('github-skill'));
  await skill(join(home, '.copilot', 'skills', 'co'), fm('copilot-user-skill'));
  await mkdir(join(home, '.codex', 'skills', 'empty'), { recursive: true });
  return { base, home, ws };
}

test('skill roots follow the spec table, with workspace roots only when a workspace is open', () => {
  const roots = skillRoots('/w', '/h');
  assert.deepEqual(roots.map(r => r.source), ['claude-user', 'claude-project', 'claude-plugin', 'agents-user', 'agents-project', 'codex-user', 'codex-project', 'github-project', 'copilot-user']);
  assert.deepEqual(roots.find(r => r.source === 'claude-project')!.nativeTo, ['claude', 'copilot']);
  assert.equal(roots.find(r => r.source === 'agents-user')!.recursive, true);
  assert.equal(skillRoots(undefined, '/h').length, 5);
});
test('frontmatter: quoted values, folded and plain multi-line descriptions, missing values', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: "quoted name"\ndescription: \'single quoted\'\n---\nbody'), { name: 'quoted name', description: 'single quoted' });
  assert.deepEqual(parseSkillFrontmatter('---\r\nname: fold\r\ndescription: >\r\n  first line\r\n  second line\r\nlicense: MIT\r\n---'), { name: 'fold', description: 'first line second line' });
  assert.deepEqual(parseSkillFrontmatter('---\ndescription: starts here\n  and continues\nmetadata:\n  name: nested\n---'), { description: 'starts here and continues' });
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter\nname: x'), {});
  assert.deepEqual(parseSkillFrontmatter('﻿---\nname: bom\n---'), { name: 'bom' });
});
test('discovers skills across all roots with nativeTo, skipping .system, wrong plugin folders and empty folders', async () => {
  const { base, home, ws } = await fixture();
  try {
    await skill(join(ws, '.github', 'skills', 'noname'), '---\ndescription: no name given\n---');
    await skill(join(ws, '.github', 'skills', 'dup'), fm('github-skill', 'duplicate'));
    const skills = await discoverSkills(ws, home);
    const by = Object.fromEntries(skills.map(s => [s.name, s]));
    assert.deepEqual(Object.keys(by).sort(), ['agents-nested', 'agents-project-skill', 'claude-project-skill', 'claude-user-skill', 'codex-project-skill', 'codex-user-skill', 'copilot-user-skill', 'github-skill', 'noname', 'plugin-skill']);
    assert.equal(skills.filter(s => s.name === 'github-skill').length, 1);
    assert.equal(by['plugin-skill']!.source, 'claude-plugin'); assert.deepEqual(by['plugin-skill']!.nativeTo, ['claude']);
    assert.equal(by['agents-nested']!.source, 'agents-user'); assert.deepEqual(by['agents-nested']!.nativeTo, ['codex', 'copilot']);
    assert.equal(by['noname']!.description, 'no name given');
    assert.equal(by['claude-user-skill']!.path, join(home, '.claude', 'skills', 'cu', 'SKILL.md'));
    assert.equal(by['claude-user-skill']!.dir, join(home, '.claude', 'skills', 'cu'));
    assert.deepEqual(await discoverSkills(join(base, 'missing'), join(base, 'nohome')), []);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('skill wiring links non-native skills per CLI, writes the index and never touches the original skills', async () => {
  const { base, home, ws } = await fixture(), storage = join(base, 'storage');
  try {
    await skill(join(home, '.claude', 'skills', 'other'), fm('codex-user-skill', 'same name as the Codex one'));
    const skills = await discoverSkills(ws, home);
    const wiring = await prepareSkillWiring(skills, storage, ws);
    const root = join(storage, 'shared-skills');
    assert.equal(wiring.claudePluginDir, join(root, 'claude', 'chatroom-shared'));
    assert.deepEqual(JSON.parse(await readFile(join(wiring.claudePluginDir!, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'chatroom-shared', version: '1.0.0', description: 'Skills shared from the other agents in Chatroom' });
    const claudeLinks = (await readdir(join(wiring.claudePluginDir!, 'skills'))).sort();
    assert.deepEqual(claudeLinks, ['agents-nested', 'agents-project-skill', 'codex-project-skill', 'codex-user-skill', 'copilot-user-skill', 'github-skill']);
    assert.match(await readFile(join(wiring.claudePluginDir!, 'skills', 'github-skill', 'SKILL.md'), 'utf8'), /name: github-skill/);
    assert.equal(wiring.copilotAddDir, join(root, 'copilot'));
    const copilotLinks = (await readdir(join(root, 'copilot', '.github', 'skills'))).sort();
    assert.deepEqual(copilotLinks, ['claude-user-skill', 'codex-project-skill', 'codex-user-skill', 'codex-user-skill-2', 'plugin-skill']);
    const claudeUserLink = await readFile(join(root, 'copilot', '.github', 'skills', 'codex-user-skill-2', 'SKILL.md'), 'utf8').catch(() => '');
    const codexUserLink = await readFile(join(root, 'copilot', '.github', 'skills', 'codex-user-skill', 'SKILL.md'), 'utf8');
    assert.ok([claudeUserLink, codexUserLink].some(t => t.includes('same name as the Codex one')));
    assert.deepEqual([...wiring.codexExtraRoots].sort(), [join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills'), join(home, '.claude', 'skills'), join(home, '.copilot', 'skills'), join(ws, '.claude', 'skills'), join(ws, '.github', 'skills')].sort());
    assert.equal(wiring.indexDir, root); assert.equal(wiring.indexPath, join(root, 'INDEX.md'));
    const index = await readFile(wiring.indexPath!, 'utf8');
    assert.ok(index.startsWith('# Skills shared in this room\n\nEach skill is a folder with a SKILL.md. Read the SKILL.md and follow it when a skill fits the task.\n\n- '));
    assert.ok(index.includes(`- github-skill (github-project): github-skill helps — ${join(ws, '.github', 'skills', 'gh', 'SKILL.md')}`));
    assert.equal(wiring.skills, skills);
    // Re-wiring removes only the generated links; the linked skills stay intact.
    const again = await prepareSkillWiring(skills.filter(s => s.source === 'github-project'), storage, ws);
    assert.equal(again.copilotAddDir, undefined); assert.ok(again.claudePluginDir);
    assert.deepEqual(await readdir(join(again.claudePluginDir!, 'skills')), ['github-skill']);
    assert.deepEqual(await readdir(join(root, 'copilot')).catch(() => []), []);
    for (const s of skills) assert.ok((await stat(s.path)).isFile(), s.path);
    assert.ok(!(await lstat(join(ws, '.github', 'skills', 'gh'))).isSymbolicLink());
    const none = await prepareSkillWiring([], storage, ws);
    assert.equal(none.claudePluginDir, undefined); assert.deepEqual(none.codexExtraRoots, []);
    assert.equal(await readFile(none.indexPath!, 'utf8'), '# Skills shared in this room\n\nEach skill is a folder with a SKILL.md. Read the SKILL.md and follow it when a skill fits the task.\n\n');
    assert.ok((await stat(join(dirname(skills[0]!.path), 'SKILL.md'))).isFile());
  } finally { await rm(base, { recursive: true, force: true }); }
});
