import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnv, resolveCli } from './process';
import { ModelInfo, NativeProviderId, Runtime } from './types';

export type { Runtime } from './types';
const exec = promisify(execFile);
function candidatePaths(provider: NativeProviderId, configured: string, folders: string[]): { path: string; source: string }[] {
  if (configured && configured !== provider) return [{ path: configured, source: 'Configured executable' }];
  const candidates: { path: string; source: string }[] = [];
  if (provider === 'copilot') {
    candidates.push({ path: 'copilot', source: 'PATH executable' });
    if (process.platform === 'win32') {
      if (process.env.APPDATA) candidates.push({ path: join(process.env.APPDATA, 'npm', 'copilot.cmd'), source: 'npm global install' });
      if (process.env.LOCALAPPDATA) candidates.push({ path: join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'copilot.exe'), source: 'WinGet install' });
    }
    return candidates;
  }
  for (const folder of new Set(folders)) {
    const platform = process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    for (const relative of provider === 'codex' ? [`bin/${platform}/codex${process.platform === 'win32' ? '.exe' : ''}`] : ['resources/native-binary/claude.exe', 'resources/native-binary/claude', 'resources/claude.exe']) {
      const path = join(folder, relative); if (existsSync(path)) candidates.push({ path, source: 'VS Code extension runtime' });
    }
  }
  candidates.push({ path: provider, source: 'PATH executable' });
  return candidates;
}
function isModern(provider: NativeProviderId, version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (provider === 'codex') return major > 0 || minor >= 100;
  if (provider === 'copilot') return major >= 1;
  return major >= 2 && patch >= 100;
}
/** Finds a working CLI. Copilot: the configured path, then PATH (npm shim resolved to the native exe), npm's global folder and WinGet's link. The CLI is never bundled. */
export async function findRuntime(provider: NativeProviderId, configured: string, extensionPath?: string): Promise<Runtime | undefined> {
  const folders: string[] = extensionPath ? [extensionPath] : [];
  if (provider !== 'copilot' && (!configured || configured === provider)) {
    const prefix = provider === 'codex' ? 'openai.chatgpt-' : 'anthropic.claude-code-';
    for (const folder of [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.vscode-insiders', 'extensions')]) {
      try { folders.push(...(await readdir(folder)).filter(n => n.startsWith(prefix)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(n => join(folder, n))); } catch { /* Optional installation. */ }
    }
  }
  for (const candidate of candidatePaths(provider, configured, folders)) {
    const executable = resolveCli(candidate.path, provider); if (!executable) continue;
    try {
      const { stdout } = await exec(executable.command, [...executable.prefix, '--version'], { windowsHide: true, timeout: provider === 'copilot' ? 20000 : 10000, env: childEnv(executable, provider) });
      const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? 'unknown';
      return { executable, version, source: candidate.source, modern: isModern(provider, version) };
    } catch { /* Continue to a working runtime. */ }
  }
}

// Read-only control exchange. Never sends a user prompt or starts model inference.
function exchange(runtime: Runtime, provider: NativeProviderId, args: string[], initial: object, handler: (event: any, send: (value: object) => void) => ModelInfo[] | undefined): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable.command, [...runtime.executable.prefix, ...args], { windowsHide: true, shell: false, env: childEnv(runtime.executable, provider), stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', errorText = '', settled = false;
    const timer = setTimeout(() => finish(new Error('Model discovery timed out.')), 20000);
    const finish = (error?: Error, models?: ModelInfo[]) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
      error ? reject(error) : resolve(models ?? []);
    };
    const send = (value: object) => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on('error', () => {}); child.on('error', error => finish(error));
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-1500); });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      if (pending.length > 2_000_000) return finish(new Error('Model discovery response too large.'));
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0 && !settled) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { const models = handler(JSON.parse(line), send); if (models) finish(undefined, models); }
        catch (error) { if (!(error instanceof SyntaxError)) finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    child.on('close', () => { if (!settled) finish(new Error(errorText || 'Model discovery exited without a catalog.')); });
    send(initial);
  });
}
const strings = (values: unknown): string[] => Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
export function normalizeCodexModels(entries: any[], cache = false): ModelInfo[] {
  return entries.filter(m => cache ? m.visibility !== 'hide' : !m.hidden).flatMap(m => {
    const id = cache ? m.slug : m.model ?? m.id;
    if (typeof id !== 'string') return [];
    const reasoning = (cache ? m.supported_reasoning_levels ?? [] : m.supportedReasoningEfforts ?? []).map((r: any) => r.reasoningEffort ?? r.effort).filter((v: unknown): v is string => typeof v === 'string');
    const description = typeof m.description === 'string' && m.description ? m.description : undefined;
    return [{ id, name: (cache ? m.display_name : m.displayName) || id, isDefault: !!m.isDefault,
      defaultReasoning: cache ? m.default_reasoning_level : m.defaultReasoningEffort, reasoning, ultra: reasoning.includes('ultra'), ...(description ? { description } : {}) }];
  });
}
/** Claude initialize `models` → ModelInfo (efforts, adaptive thinking, ultracode availability, the `default` entry). */
export function normalizeClaudeModels(entries: any[]): ModelInfo[] {
  return (Array.isArray(entries) ? entries : []).filter(m => typeof m?.value === 'string').map(m => {
    const reasoning = strings(m.supportedEffortLevels);
    return { id: m.value, name: m.displayName || m.value, reasoning, thinking: !!m.supportsAdaptiveThinking, ultra: !!m.supportsEffort && reasoning.includes('xhigh'),
      isDefault: m.value === 'default', ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}) };
  });
}
export async function codexModels(runtime: Runtime): Promise<{ models: ModelInfo[]; source: string }> {
  if (runtime.modern) {
    try {
      const all: ModelInfo[] = [];
      const models = await exchange(runtime, 'codex', ['-c', 'model_reasoning_effort="medium"', 'app-server'], { id: 1, method: 'initialize', params: { clientInfo: { name: 'chatroom', title: 'Chatroom', version: '0.4.0' } } }, (event, send) => {
        if (event.error) throw new Error(event.error.message ?? 'Codex model discovery failed.');
        if (event.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } }); }
        if (event.id === 2) {
          all.push(...normalizeCodexModels(event.result?.data ?? []));
          if (event.result?.nextCursor) send({ id: 2, method: 'model/list', params: { limit: 100, cursor: event.result.nextCursor, includeHidden: false } });
          else return all;
        }
      });
      if (models.length) return { models, source: 'Codex model/list' };
    } catch { /* The local catalog remains useful when the server is unavailable. */ }
  }
  try {
    const data = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    const models = normalizeCodexModels(data.models ?? [], true);
    if (models.length) return { models, source: 'Codex cached catalog · access verified on use' };
  } catch { /* No account catalog yet. */ }
  return { models: [], source: 'No catalog available · sign in to the Codex extension and refresh' };
}
export async function claudeModels(runtime: Runtime): Promise<{ models: ModelInfo[]; source: string }> {
  try {
    const models = await exchange(runtime, 'claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
      { type: 'control_request', request_id: 'chatroom-models', request: { subtype: 'initialize', hooks: {} } }, event => {
        if (event.type === 'control_response' && event.response?.request_id === 'chatroom-models') {
          if (event.response.subtype === 'error') throw new Error(event.response.error);
          return normalizeClaudeModels(event.response.response?.models ?? []);
        }
      });
    if (models.length) return { models, source: 'Claude Code model catalog' };
  } catch { /* Older clients can use their documented aliases. */ }
  return { models: [{ id: 'sonnet', name: 'Sonnet · CLI alias' }, { id: 'opus', name: 'Opus · CLI alias' }, { id: 'haiku', name: 'Haiku · CLI alias' }], source: 'Claude CLI aliases · exact model resolved by client' };
}
