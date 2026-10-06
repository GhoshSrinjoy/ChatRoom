import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { RoomToolDefinition, RoomToolName, RoomTools } from './types';
import { ROOM_TOOL_NAMES, roomToolSpecs } from './tool-specs';

export const MAX_TOOL_OUTPUT = 24_000, MAX_MCP_BODY = 1_000_000;
type Exec = (agentId: string, name: RoomToolName, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
const isRoomTool = (name: unknown): name is RoomToolName => typeof name === 'string' && (ROOM_TOOL_NAMES as string[]).includes(name);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Chatroom's room tools for native CLIs: a direct call API, an MCP JSON-RPC handler and a token-protected loopback HTTP MCP endpoint. */
export class RoomToolHost implements RoomTools {
  private server?: Server;
  private listening?: Promise<number>;
  private readonly tokens = new Map<string, string>();
  private readonly agentTokens = new Map<string, string>();
  private readonly inflight = new Set<AbortController>();
  constructor(private readonly exec: Exec) {}
  definitions(): RoomToolDefinition[] { return ROOM_TOOL_NAMES.map(name => roomToolSpecs[name]); }
  async call(agentId: string, name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    if (!isRoomTool(name)) return { text: `Tool error: Chatroom has no tool named ${String(name).slice(0, 80)}.`, isError: true };
    try { return { text: String(await this.exec(agentId, name, objectArgs(args), signal)).slice(0, MAX_TOOL_OUTPUT), isError: false }; }
    catch (error) { return { text: ('Tool error: ' + errorText(error)).slice(0, MAX_TOOL_OUTPUT), isError: true }; }
  }
  async mcp(agentId: string, message: any, signal?: AbortSignal): Promise<any | undefined> {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      // Responses from the client need no reply; anything else is malformed.
      return message && typeof message === 'object' && 'id' in message && !('method' in message) ? undefined : { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    const { id, method } = message, params = message.params ?? {};
    if (id === undefined || id === null || method.startsWith('notifications/')) return undefined;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chatroom', version: '0.4.0' } });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: this.definitions() });
    if (method === 'tools/call') {
      const result = await this.call(agentId, params.name, params.arguments, signal ?? new AbortController().signal);
      return reply({ content: [{ type: 'text', text: result.text }], isError: result.isError });
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method.slice(0, 80)}` } };
  }
  async httpEndpoint(agentId: string): Promise<{ url: string; headers: Record<string, string> }> {
    const port = await this.listen();
    let token = this.agentTokens.get(agentId);
    if (!token) { token = randomBytes(24).toString('hex'); this.agentTokens.set(agentId, token); this.tokens.set(token, agentId); }
    return { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
  }
  async dispose(): Promise<void> {
    for (const controller of this.inflight) controller.abort(new Error('Chatroom closed.'));
    const server = this.server; this.server = undefined; this.listening = undefined;
    if (!server) return;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }
  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once('error', error => { this.listening = undefined; this.server = undefined; reject(error); });
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      this.server = server;
    });
    return this.listening;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, body === undefined ? headers : { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if ((req.url ?? '').split('?')[0] !== '/mcp') return send(404);
    if (req.method !== 'POST') return send(405, undefined, { Allow: 'POST' });
    const agentId = this.tokens.get(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
    if (agentId === undefined) return send(401);
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); }
    catch (error) {
      if (error instanceof TooLarge) return send(413, undefined, { Connection: 'close' });
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const controller = new AbortController(); this.inflight.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('The MCP client disconnected.')); });
    try {
      const results = (await Promise.all((Array.isArray(body) ? body : [body]).map(m => this.mcp(agentId, m, controller.signal)))).filter(r => r !== undefined);
      if (!results.length) return send(202);
      send(200, Array.isArray(body) ? results : results[0]);
    } catch (error) { send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: errorText(error) } }); }
    finally { this.inflight.delete(controller); }
  }
}
class TooLarge extends Error {}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY) { reject(new TooLarge('Request body exceeds 1 MB.')); req.removeAllListeners('data'); req.resume(); return; } // drain, then answer 413
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
