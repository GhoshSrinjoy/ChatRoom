import { Agent, AgentCapabilities, LoopConfig, NativeCommand, NativeProviderId, RoomCommandInfo, TeamConfig, WorktreeMode } from './types';
import { normalizeTeam } from './core';

export const ROOM_COMMANDS: RoomCommandInfo[] = [
  { name: 'help', description: 'Show Chatroom commands', agentScoped: false },
  { name: 'clear', description: 'Start fresh native sessions; agents forget earlier messages', agentScoped: true },
  { name: 'compact', args: '[instructions]', description: "Summarize each agent's native session to free context", agentScoped: true },
  { name: 'new', description: 'Open a new room', agentScoped: false },
  { name: 'export', description: 'Export this conversation as Markdown', agentScoped: false },
  { name: 'loop', args: '[N | consensus | done | every 10m <prompt> | off]', description: "Repeat the room's work until a condition or limit", agentScoped: false },
  { name: 'mode', args: 'team | relay | parallel | custom', description: 'Choose how agents collaborate', agentScoped: false },
  { name: 'lead', args: '<agent>', description: 'Choose the lead for Team mode', agentScoped: false },
  { name: 'team', args: '[name | Lead: Claude > Draft: Codex > … | save <name> | edit | off]', description: 'Set up your own team: stages such as lead, drafting, review, testing', agentScoped: false },
  { name: 'worktrees', args: 'off | auto | always | status | apply | keep [name] | discard | cleanup', description: 'Give agents their own git worktrees so parallel edits never collide', agentScoped: false },
  { name: 'model', args: '<model>', description: 'Set the model of the mentioned agent', agentScoped: true },
  { name: 'effort', args: '<level>', description: 'Set reasoning effort for the mentioned agents (or all)', agentScoped: true },
  { name: 'permissions', args: 'plan | ask | auto | full', description: 'Set what agents may do without asking', agentScoped: true },
  { name: 'status', description: 'Show sessions, models and context use', agentScoped: true },
  { name: 'stop', description: 'Stop all running agents', agentScoped: false },
];
/** Room commands that take @mentioned agents (compact, clear, model, effort, permissions, status). */
export const AGENT_SCOPED: string[] = ROOM_COMMANDS.filter(c => c.agentScoped).map(c => c.name);
const ROOM_NAMES = new Set(ROOM_COMMANDS.map(c => c.name));

/** Native commands Chatroom never lists or forwards. A trailing `*` matches a prefix. */
export const NATIVE_COMMAND_DENYLIST: Record<NativeProviderId, string[]> = {
  claude: ['exit', 'quit', 'login', 'logout', 'doctor', 'vim', 'theme', 'config', 'terminal-setup', 'statusline', 'keybindings', 'ide', 'install-github-app',
    'upgrade', 'feedback', 'bug', 'mobile', 'voice', 'tui', 'teleport', 'remote-control', 'desktop', 'session', 'background', 'restart', 'resume', 'rewind',
    'export', 'copy', 'color', 'focus', 'heapdump', 'debug', 'passes', 'radio', 'stickers', 'help', 'add-dir', 'cd', 'login-*'],
  codex: [],
  copilot: ['login', 'logout', 'exit', 'theme', 'vim', 'terminal-setup', 'statusline', 'footer', 'update', 'changelog', 'feedback', 'diagnose', 'app', 'ide',
    'voice', 'remote', 'restart', 'keep-alive', 'user', 'settings', 'experimental', 'collect-debug-logs', 'copy', 'share', 'resume', 'cwd', 'cd', 'add-dir',
    'list-dirs', 'allow-all', 'yolo', 'new', 'help', 'version', 'session'],
};
const denied = (provider: NativeProviderId, name: string) => (NATIVE_COMMAND_DENYLIST[provider] ?? []).some(d => d.endsWith('*') ? name.startsWith(d.slice(0, -1)) : name === d);
export function filterNativeCommands(provider: NativeProviderId, commands: NativeCommand[]): NativeCommand[] {
  const seen = new Set<string>(), out: NativeCommand[] = [];
  for (const command of commands ?? []) {
    if (typeof command?.name !== 'string') continue;
    const name = command.name.trim().replace(/^\//, ''), key = name.toLowerCase();
    if (!name || seen.has(key) || denied(provider, key) || AGENT_SCOPED.includes(key)) continue;
    seen.add(key); out.push(name === command.name ? command : { ...command, name });
  }
  return out;
}

/** Blanks ``` fences and `inline code` with spaces, keeping every offset and line break. */
export function stripCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text.replace(/```[\s\S]*?(?:```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}
export function markerOf(text: string): 'agree' | 'done' | undefined {
  const m = /\[(AGREE|CONSENSUS|DONE)\][\s*_`.!]*$/i.exec(text ?? '');
  return !m ? undefined : m[1]!.toUpperCase() === 'DONE' ? 'done' : 'agree';
}

const MENTION = /(^|[\s(\[,;])@("([^"]+)"|[A-Za-z0-9_.-]+)/g;
interface MentionToken { token: string; start: number; end: number }
/** Mention tokens in already code-stripped text. A token followed by `/` or `\` is a path (`@src/a.ts`), not a mention. */
function mentions(text: string): MentionToken[] {
  const out: MentionToken[] = [];
  for (const m of text.matchAll(MENTION)) {
    const start = (m.index ?? 0) + m[1]!.length;
    let end = start + 1 + m[2]!.length;
    let token = m[3] ?? m[2]!;
    if (m[3] === undefined) {
      if (/[\/\\]/.test(text[end] ?? '')) continue;
      const trimmed = token.replace(/[.,:;!?)]+$/, ''); end -= token.length - trimmed.length; token = trimmed;
    }
    if (token.trim()) out.push({ token: token.trim(), start, end });
  }
  return out;
}
const PROVIDER_ALIASES: Record<string, Agent['provider']> = {
  claude: 'claude', 'claude code': 'claude', 'claude-code': 'claude', codex: 'codex', copilot: 'copilot', 'github copilot': 'copilot', 'github-copilot': 'copilot', ollama: 'ollama',
};
export function resolveMention(token: string, agents: Agent[], leadId?: string): Agent[] | 'all' | undefined {
  const t = token.trim().toLowerCase();
  if (!t) return undefined;
  const named = agents.filter(a => a.name.trim().toLowerCase() === t);
  const byName = named.find(a => a.enabled) ?? named[0];
  if (byName) return [byName];
  if (t === 'all' || t === 'room' || t === 'everyone') return 'all';
  const enabled = agents.filter(a => a.enabled);
  if (t === 'lead') { const lead = enabled.find(a => a.id === leadId) ?? enabled[0]; return lead ? [lead] : undefined; }
  const provider = PROVIDER_ALIASES[t];
  const owners = provider ? enabled.filter(a => a.provider === provider) : [];
  return owners.length === 1 ? owners : undefined;
}

export interface ParsedComposer {
  text: string;
  targets: string[];
  all: boolean;
  command?: { name: string; args: string; scope: 'room' | 'native'; agentIds: string[] };
  error?: string;
}
const at = (agent: Agent) => /\s/.test(agent.name) ? `@"${agent.name}"` : `@${agent.name}`;
/** The native command an agent has under this name or alias, after filtering. Legacy agents have none. */
function nativeCommand(agent: Agent, caps: AgentCapabilities | undefined, name: string): NativeCommand | undefined {
  if (!caps || caps.runtime !== 'cli' || agent.provider === 'ollama') return undefined;
  return filterNativeCommands(agent.provider, caps.commands ?? []).find(c => c.name.toLowerCase() === name || (c.aliases ?? []).some(a => a.replace(/^\//, '').toLowerCase() === name));
}
export function parseComposer(text: string, agents: Agent[], caps: Record<string, AgentCapabilities | undefined>, leadId?: string): ParsedComposer {
  const t = (text ?? '').trim();
  if (t.startsWith('//')) return { text: t.slice(1), targets: [], all: false };
  const stripped = stripCode(t), tokens = mentions(stripped);
  const collect = (list: MentionToken[]) => {
    const targets: string[] = [], off: Agent[] = [], unknown: string[] = [];
    let all = false;
    for (const { token } of list) {
      const hit = resolveMention(token, agents, leadId);
      if (hit === 'all') all = true;
      else if (!hit) unknown.push(token);
      else for (const agent of hit) {
        if (!agent.enabled) { if (!off.includes(agent)) off.push(agent); }
        else if (!targets.includes(agent.id)) targets.push(agent.id);
      }
    }
    return { targets: all ? [] : targets, all, off, unknown };
  };
  // Command detection: the leading run of mentions, then /name args.
  const leading: MentionToken[] = [];
  let index = 0;
  for (const token of tokens) {
    if (stripped.slice(index, token.start).replace(/[\s,]/g, '') !== '') break;
    leading.push(token); index = token.end;
  }
  const rest = t.slice(index).replace(/^[\s,]+/, '');
  const m = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(rest);
  if (m) {
    const name = m[1]!.toLowerCase(), args = (m[2] ?? '').trim();
    const lead = collect(leading);
    if (lead.unknown.length) return { text: t, targets: [], all: false, error: `No agent named @${lead.unknown[0]} in this room.` };
    if (lead.off.length && !lead.targets.length && !lead.all) return { text: t, targets: [], all: false, error: `${lead.off[0]!.name} is turned off. Turn it on first.` };
    const base = { text: t, targets: lead.targets, all: lead.all };
    if (!lead.targets.length) {
      if (ROOM_NAMES.has(name)) return { ...base, command: { name, args, scope: 'room', agentIds: [] } };
      const owners = agents.filter(a => a.enabled).map(a => ({ agent: a, found: nativeCommand(a, caps[a.id], name) })).filter(o => o.found);
      if (owners.length === 1) return { ...base, command: { name: canonical(owners[0]!.found!, name), args, scope: 'native', agentIds: [owners[0]!.agent.id] } };
      if (owners.length > 1) return { ...base, error: `Several agents have /${name}: mention one, e.g. ${at(owners[0]!.agent)} /${name}.` };
      return { ...base, error: `Unknown command /${name}. Type / to see the commands.` };
    }
    if (AGENT_SCOPED.includes(name)) return { ...base, command: { name, args, scope: 'room', agentIds: lead.targets } };
    const targets = lead.targets.map(id => agents.find(a => a.id === id)!);
    const found = targets.map(a => nativeCommand(a, caps[a.id], name));
    if (found.every(Boolean)) return { ...base, command: { name: canonical(found[0]!, name), args, scope: 'native', agentIds: lead.targets } };
    if (ROOM_NAMES.has(name)) return { ...base, command: { name, args, scope: 'room', agentIds: lead.targets } };
    return { ...base, error: `${targets[found.findIndex(f => !f)]!.name} has no /${name} command.` };
  }
  const { targets, all, off } = collect(tokens);
  if (!t) return { text: t, targets, all, error: 'Write a message first.' };
  if (off.length && !targets.length && !all) return { text: t, targets, all, error: `${off[0]!.name} is turned off. Turn it on first.` };
  return { text: t, targets, all };
}
const canonical = (command: NativeCommand, typed: string) => command.name.toLowerCase() === typed ? command.name : typed;

/** Agent lines that start with @Name hand the next turn to that agent. */
export function extractHandoffs(text: string, author: Agent | undefined, agents: Agent[], leadId?: string): { agentId: string; line: string }[] {
  const original = (text ?? '').split('\n'), stripped = stripCode(text ?? '').split('\n');
  const out: { agentId: string; line: string }[] = [];
  stripped.forEach((line, i) => {
    const marker = /^\s*(?:[-*+>]|\d+[.)])\s+/.exec(line)?.[0].length ?? 0;
    const body = line.slice(marker).replace(/\*/g, ' ');
    const run = /^(?:\s*@(?:"[^"]+"|[A-Za-z0-9_.-]+)[\s,]*)+/.exec(body);
    if (!run) return;
    const ids: string[] = [];
    for (const { token, end } of mentions(body)) {
      if (end > run[0].length) break;
      const hit = resolveMention(token, agents, leadId);
      if (!hit || hit === 'all') continue;
      for (const agent of hit) if (agent.enabled && agent.id !== author?.id && !ids.includes(agent.id)) ids.push(agent.id);
    }
    if (!ids.length) return;
    let task = (original[i] ?? '').slice(marker + run[0].length).replace(/^[\s:,\-–—]+/, '').trim();
    if (!task) task = original.slice(i + 1).map(l => l.trim()).find(Boolean) ?? '';
    task = task.slice(0, 500);
    for (const agentId of ids) if (!out.some(o => o.agentId === agentId && o.line === task)) out.push({ agentId, line: task });
  });
  return out;
}

const LOOP_USAGE = 'Usage: /loop [N | consensus | done | every 10m <prompt> | off]';
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec((text ?? '').trim());
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}
const count = (text: string | undefined, max: number) => text !== undefined && /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= max ? Number(text) : undefined;
export function parseLoop(args: string): { loop?: Partial<LoopConfig>; prompt?: string; show?: boolean; error?: string } {
  const text = (args ?? '').trim();
  if (!text) return { show: true };
  const words = text.split(/\s+/), lower = words.map(w => w.toLowerCase());
  const error = { error: LOOP_USAGE };
  const first = lower[0]!;
  if ((first === 'off' || first === 'once') && words.length === 1) return { loop: { kind: 'once' } };
  if (/^\d+$/.test(first) || first === 'rounds') {
    const n = first === 'rounds' ? words[1] : words[0];
    const rounds = count(n, 50);
    return rounds !== undefined && words.length === (first === 'rounds' ? 2 : 1) ? { loop: { kind: 'rounds', rounds } } : error;
  }
  // Optional "max <N>" at `index`; returns the iteration cap and where the rest begins.
  const max = (index: number): { value?: number; next: number } | undefined => {
    if (lower[index] !== 'max') return { next: index };
    const value = count(words[index + 1], 50);
    return value === undefined ? undefined : { value, next: index + 2 };
  };
  if (first === 'consensus' || first === 'done') {
    const cap = max(1);
    if (!cap || cap.next !== words.length) return error;
    return { loop: { kind: first === 'done' ? 'lead-done' : 'consensus', ...(cap.value !== undefined ? { maxIterations: cap.value } : {}) } };
  }
  if (first === 'every') {
    const ms = parseDuration(words[1] ?? '');
    const cap = max(2);
    if (ms === undefined || !cap) return error;
    const everyMinutes = Math.max(1, Math.round(ms / 60000));
    if (everyMinutes > 1440) return error;
    const prompt = cap.next < words.length ? text.slice(offsetOf(text, cap.next)).trim() : '';
    return { loop: { kind: 'interval', everyMinutes, ...(cap.value !== undefined ? { maxIterations: cap.value } : {}) }, ...(prompt ? { prompt } : {}) };
  }
  return error;
}
/** Character offset where the n-th whitespace-separated word of `text` starts. */
function offsetOf(text: string, n: number): number {
  const re = /\S+/g;
  let m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) { if (i++ === n) return m.index; }
  return text.length;
}
const WORKTREES_USAGE = 'Usage: /worktrees off | auto | always | status | apply | keep [name] | discard | cleanup';
export interface ParsedWorktrees { mode?: WorktreeMode; action?: 'status' | 'apply' | 'keep' | 'discard' | 'cleanup'; name?: string; error?: string }
/** /worktrees arguments: a mode, or an action on the room's combined changes (keep takes an optional branch name). */
export function parseWorktrees(args: string): ParsedWorktrees {
  const text = (args ?? '').trim(), [first = '', ...rest] = text.split(/\s+/), word = first.toLowerCase();
  if (word === 'keep') { const name = text.slice(first.length).trim().slice(0, 80); return { action: 'keep', ...(name ? { name } : {}) }; }
  if (rest.length) return { error: WORKTREES_USAGE };
  if (!word || word === 'status') return { action: 'status' };
  if (word === 'off' || word === 'auto' || word === 'always') return { mode: word };
  if (word === 'apply' || word === 'discard' || word === 'cleanup') return { action: word };
  return { error: WORKTREES_USAGE };
}
const TEAM_USAGE ='Usage: /team · /team <saved name> · /team Lead: Claude > Draft: Codex > Review: Claude, Copilot · /team save <name> · /team edit · /team off';
export interface ParsedTeam { show?: true; off?: true; edit?: true; save?: string; remove?: string; use?: string; team?: TeamConfig; error?: string }
/** /team arguments: show, off, edit, save <name>, delete <name>, an inline team ("Lead: Claude > Draft: Codex (first pass) > Review: Claude, Copilot") or a team name. */
export function parseTeam(args: string): ParsedTeam {
  const text = (args ?? '').trim(), lower = text.toLowerCase();
  if (!text) return { show: true };
  if (lower === 'off') return { off: true };
  if (lower === 'edit') return { edit: true };
  const named = /^(save|delete|remove)(?:\s+([\s\S]*))?$/i.exec(text);
  if (named) {
    const name = (named[2] ?? '').trim().slice(0, 40);
    if (named[1]!.toLowerCase() === 'save') return { save: name };
    return name ? { remove: name } : { error: TEAM_USAGE };
  }
  if (!text.includes(':')) return { use: text };
  const stages = text.split(/\s*(?:->|→|>|\||;|\n)\s*/).map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.indexOf(':'), name = colon >= 0 ? part.slice(0, colon).trim() : '';
    let refs = colon >= 0 ? part.slice(colon + 1).trim() : part, task = '';
    const paren = /\(([^()]*)\)\s*$/.exec(refs);
    if (paren) { task = paren[1]!.trim(); refs = refs.slice(0, paren.index).trim(); }
    return { name, agents: refs.split(/\s*[,+&]\s*|\s+and\s+/i).map(r => r.trim()).filter(Boolean), ...(task ? { task } : {}) };
  });
  const team = normalizeTeam({ name: 'Custom team', stages });
  return team ? { team } : { error: `That team has no stage with an agent. ${TEAM_USAGE}` };
}
