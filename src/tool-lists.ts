import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSwitchConfig } from './codex-native';
import { JsonlProcess, RpcConnection, RpcError, spawnJsonl } from './jsonl';
import { childEnv } from './process';
import { Executable, NativeProviderId } from './types';

/**
 * Codex, Copilot and Gemini report no list of their built-in tools, but send one with every model request. So a read starts the CLI once
 * against a local stand-in for its model service and takes the list from the first request. Nothing leaves the machine: the CLI gets an
 * empty home and folder and no logins, and any other connection it tries goes to a local proxy that refuses it.
 */
export type ListedProvider = Extract<NativeProviderId, 'codex' | 'copilot' | 'gemini'>;
export const isListedProvider = (id: string): id is ListedProvider => id === 'codex' || id === 'copilot' || id === 'gemini';
export interface ToolList {
  tools: string[];
  /** Tools a real run kept with every switch on: they get no button. */
  fixed?: string[];
}
export interface ReadOptions {
  /** The model to read for: Codex offers different tools per model. */
  model?: string;
  /** Codex thread config for the read. */
  config?: Record<string, unknown>;
  /** Chatroom's version, as the client it reports. */
  version?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
}
const READ_MS = 30_000, MAX_BODY = 8_000_000, KEEP = 16, RETRY_MS = 3_600_000;
/** Anything that could carry a login or send traffic elsewhere. What a read needs is set again afterwards. */
const SCRUB = /^(anthropic|azure|codex|copilot|gemini|google|openai)_|_(api_key|token|proxy)$|^(all|http|https|no)_proxy$/i;
const PLACEHOLDER = 'chatroom-tool-list';
const NO_REPLY = "Chatroom is only reading this CLI's tool list.";
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

/** The tool names in a model request, in the shape each CLI sends them. */
export function toolNames(provider: ListedProvider, body: any): string[] {
  const names: (string | undefined)[] = [];
  if (provider === 'gemini') for (const group of list(body?.tools)) for (const declared of list(group?.functionDeclarations)) names.push(text(declared?.name));
  if (provider === 'copilot') for (const tool of list(body?.tools)) names.push(text(tool?.function?.name) ?? text(tool?.name));
  if (provider === 'codex') {
    const visit = (tool: any, prefix = ''): void => {
      if (tool?.type === 'namespace') { for (const inner of list(tool.tools)) visit(inner, tool.name === 'functions' ? '' : `${tool.name}.`); return; }
      const name = text(tool?.name) ?? text(tool?.type);
      if (name) names.push(prefix + name);
      // Current models reach most tools through exec, which describes each under a heading of its own.
      if (name === 'exec') for (const heading of (text(tool?.description) ?? '').matchAll(/^### `([^`]+)`/gm)) names.push(heading[1]);
    };
    for (const tool of list(body?.tools)) visit(tool);
    for (const item of list(body?.input)) if (item?.type === 'additional_tools') for (const tool of list(item.tools)) visit(tool);
  }
  return [...new Set(names.filter((name): name is string => !!name))];
}

interface Plan {
  args: string[];
  dialect: 'jsonrpc2' | 'codex';
  env(url: string, home: string): NodeJS.ProcessEnv;
  files?(url: string, home: string): Promise<void>;
  begin(rpc: RpcConnection, work: string): Promise<void>;
}
const acp = (version: string) => async (rpc: RpcConnection, work: string): Promise<void> => {
  await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'chatroom', version } }, READ_MS);
  const session = await rpc.request('session/new', { cwd: work, mcpServers: [] }, READ_MS);
  void rpc.request('session/prompt', { sessionId: session?.sessionId, prompt: [{ type: 'text', text: 'Hello' }] }, READ_MS).catch(() => undefined);
};
function plan(provider: ListedProvider, options: ReadOptions): Plan {
  const version = options.version ?? '0';
  if (provider === 'gemini') return { args: ['--acp'], dialect: 'jsonrpc2', begin: acp(version),
    env: (url, home) => ({ GEMINI_CLI_HOME: home, GEMINI_API_KEY: PLACEHOLDER, GOOGLE_GEMINI_BASE_URL: url, GEMINI_CLI_NO_RELAUNCH: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'true', NO_BROWSER: 'true' }),
    files: async (_url, home) => {
      await mkdir(join(home, '.gemini'), { recursive: true });
      await writeFile(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false }, general: { disableAutoUpdate: true, disableUpdateNag: true } }));
    } };
  if (provider === 'copilot') return { args: ['--acp', '--no-auto-update', '--no-color', '--log-level', 'warning'], dialect: 'jsonrpc2', begin: acp(version),
    env: (url, home) => ({ COPILOT_HOME: home, COPILOT_PROVIDER_BASE_URL: `${url}/v1`, COPILOT_PROVIDER_API_KEY: PLACEHOLDER, COPILOT_MODEL: options.model ?? PLACEHOLDER, COPILOT_AUTO_UPDATE: 'false' }) };
  return { args: ['app-server'], dialect: 'codex',
    env: (_url, home) => ({ CODEX_HOME: home }),
    files: (url, home) => writeFile(join(home, 'config.toml'), [...(options.model ? [`model = ${JSON.stringify(options.model)}`] : []), 'model_provider = "chatroom"', '', '[model_providers.chatroom]', 'name = "chatroom"',
      `base_url = ${JSON.stringify(`${url}/v1`)}`, 'wire_api = "responses"', 'requires_openai_auth = false', 'stream_max_retries = 0', 'request_max_retries = 0', ''].join('\n')),
    begin: async (rpc, work) => {
      await rpc.request('initialize', { clientInfo: { name: 'chatroom', title: 'Chatroom', version }, capabilities: { experimentalApi: true } }, READ_MS);
      rpc.notify('initialized', {});
      const started = await rpc.request('thread/start', { cwd: work, ...(options.config ? { config: options.config } : {}) }, READ_MS);
      void rpc.request('turn/start', { threadId: started?.thread?.id, input: [{ type: 'text', text: 'Hello', text_elements: [] }] }, READ_MS).catch(() => undefined);
    } };
}
const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});
/** Stands in for the model service: takes the tool list from a request and refuses it, which ends the CLI's turn. */
function standIn(provider: ListedProvider, found: (names: string[]) => void): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { if (raw.length < MAX_BODY) raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'POST') { res.end('{"data":[],"models":[]}'); return; }
      try { const names = toolNames(provider, JSON.parse(raw)); if (names.length) found(names); } catch { /* Not a model request. */ }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: 400, message: NO_REPLY, status: 'INVALID_ARGUMENT' } }));
    });
  });
}
/** Where the CLI's other traffic goes (update checks, telemetry): nothing gets through. */
function refuseAll(): Server {
  const proxy = createServer((_req, res) => { res.statusCode = 502; res.end(); });
  proxy.on('connect', (_req, socket) => { socket.on('error', () => undefined); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  return proxy;
}
function readEnv(provider: ListedProvider, executable: Executable, url: string, proxyUrl: string, home: string, cli: Plan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(childEnv(executable, provider))) if (!SCRUB.test(key)) env[key] = value;
  const proxy = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  return { ...env, HOME: home, USERPROFILE: home, ...proxy, ...cli.env(url, home) };
}

/** Starts the CLI once, in an empty folder, and returns the tools it offers its model. */
export async function readToolList(provider: ListedProvider, executable: Executable, options: ReadOptions = {}): Promise<string[]> {
  const cli = plan(provider, options), dir = await mkdtemp(join(tmpdir(), 'chatroom-tools-')), home = join(dir, 'home'), work = join(dir, 'work');
  const servers: Server[] = [];
  let proc: JsonlProcess | undefined, rpc: RpcConnection | undefined, timer: NodeJS.Timeout | undefined, stop: (() => void) | undefined;
  try {
    await Promise.all([mkdir(home), mkdir(work)]);
    return await new Promise<string[]>((resolve, reject) => {
      const ms = options.timeoutMs ?? READ_MS;
      timer = setTimeout(() => reject(new Error(`no tool list after ${Math.round(ms / 1000)} s`)), ms);
      stop = () => reject(new Error('stopped'));
      if (options.signal?.aborted) return stop();
      options.signal?.addEventListener('abort', stop, { once: true });
      const start = async () => {
        const service = standIn(provider, resolve), proxy = refuseAll();
        servers.push(service, proxy);
        const [port, proxyPort] = await Promise.all([listen(service), listen(proxy)]), url = `http://127.0.0.1:${port}`;
        await cli.files?.(url, home);
        const started = spawnJsonl(executable, cli.args, { cwd: work, env: readEnv(provider, executable, url, `http://127.0.0.1:${proxyPort}`, home, cli), spawnProcess: options.spawnProcess,
          onMessage: m => rpc?.receive(m),
          onExit: code => reject(new Error(`the CLI exited (code ${code}). ${started.stderrTail.trim().slice(-300)}`.trim())) });
        proc = started;
        rpc = new RpcConnection(m => started.send(m), { dialect: cli.dialect, onNotification: () => undefined, onRequest: async () => { throw new RpcError(-32601, NO_REPLY); } });
        await cli.begin(rpc, work);
      };
      start().catch(reject);
    });
  } finally {
    clearTimeout(timer);
    if (stop) options.signal?.removeEventListener('abort', stop);
    rpc?.close(new Error('Finished reading.'));
    await proc?.kill().catch(() => undefined);
    for (const server of servers) { server.closeAllConnections?.(); server.close(); }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

/** What a CLI offers, and for Codex which tools have no switch: it accepts any key without complaint, so a switch only counts once a real run shows it working. */
export async function readTools(provider: ListedProvider, executable: Executable, options: ReadOptions = {}): Promise<ToolList> {
  const tools = await readToolList(provider, executable, options);
  if (provider !== 'codex') return { tools };
  const left = new Set(await readToolList(provider, executable, { ...options, config: codexSwitchConfig() }));
  return { tools, fixed: tools.filter(tool => left.has(tool)) };
}

export interface ToolListRequest { provider: ListedProvider; version: string; model?: string }
export type StoredToolList = ToolList & { at: number; failed?: boolean };
export interface ToolListStore { get(): Record<string, StoredToolList>; set(lists: Record<string, StoredToolList>): void }
/** Lists remembered per CLI version (and model, where it matters). A read runs at most once at a time and never makes anyone wait: `get` answers from what is known. */
export class ToolLists {
  private readonly pending = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: ToolListStore, private readonly read: (request: ToolListRequest) => Promise<ToolList>,
    private readonly options: { changed(): void; log(text: string): void; now?: () => number }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  get(request: ToolListRequest): ToolList | undefined {
    const key = `${request.provider}@${request.version}${request.model ? `:${request.model}` : ''}`, known = this.store.get()[key];
    if (known && !known.failed) return known;
    if (known && this.now() - known.at < RETRY_MS) return undefined;
    if (!this.pending.has(key)) { this.pending.add(key); this.queue = this.queue.then(() => this.fetch(key, request)); }
    return undefined;
  }
  /** Forgets failed reads, so the next `get` tries again. */
  retry(): void {
    const lists = this.store.get(), kept = Object.fromEntries(Object.entries(lists).filter(([, entry]) => !entry.failed));
    if (Object.keys(kept).length !== Object.keys(lists).length) this.store.set(kept);
  }
  private async fetch(key: string, request: ToolListRequest): Promise<void> {
    let entry: StoredToolList;
    try { entry = { ...(await this.read(request)), at: this.now() }; }
    catch (error) {
      entry = { tools: [], failed: true, at: this.now() };
      this.options.log(`Could not read the tool list of ${request.provider} ${request.version}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const newest = Object.entries({ ...this.store.get(), [key]: entry }).sort(([, a], [, b]) => b.at - a.at).slice(0, KEEP);
    this.store.set(Object.fromEntries(newest));
    this.pending.delete(key);
    this.options.changed();
  }
}
