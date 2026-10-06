import * as vscode from 'vscode';
import { Agent, AgentCapabilities, Connection, DriverHost, NativeDriver, NativeProviderId, Provider, ProviderRequest, ProviderResult, Runtime, ToolCall, emptyUsage } from './types';
import { OllamaClient } from './ollama';
import { findRuntime, codexModels, claudeModels } from './catalog';
import { toolSpecs } from './tool-specs';
import { ClaudeDriver } from './claude-native';
import { CodexDriver } from './codex-native';
import { CopilotDriver } from './copilot-native';

const EXTENSIONS: Record<NativeProviderId, string | undefined> = { codex: 'openai.chatgpt', claude: 'anthropic.claude-code', copilot: undefined };
const runtimes = new Map<string, { expires: number; promise: Promise<Runtime | undefined> }>();
/** Settings `chatroom.{codex,claude,copilot}Path`, cached for 3 minutes. */
export function providerRuntime(id: NativeProviderId): Promise<Runtime | undefined> {
  const configured = vscode.workspace.getConfiguration('chatroom').get<string>(`${id}Path`, id);
  const extension = EXTENSIONS[id], extensionPath = extension ? vscode.extensions.getExtension(extension)?.extensionPath : undefined;
  const key = JSON.stringify([id, configured, extensionPath]), existing = runtimes.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const promise = findRuntime(id, configured, extensionPath); runtimes.set(key, { promise, expires: Date.now() + 180000 }); return promise;
}
export interface Drivers { claude: ClaudeDriver; codex: CodexDriver; copilot: CopilotDriver }
export function createDrivers(host: DriverHost): Drivers {
  return { claude: new ClaudeDriver(host), codex: new CodexDriver(host), copilot: new CopilotDriver(host) };
}
export function createLegacyProviders(ollama: OllamaClient, connected?: (models: vscode.LanguageModelChat[]) => void): { copilot: Provider; ollama: Provider } {
  return { copilot: new CopilotProvider(connected), ollama };
}
/** Driver to use for an agent, or undefined for the legacy path. Copilot uses the CLI when it was detected (or explicitly chosen) and the agent did not pick VS Code models. */
export function nativeDriverFor(agent: Agent, drivers: Drivers, connections: Connection[]): NativeDriver | undefined {
  if (agent.provider === 'claude') return drivers.claude;
  if (agent.provider === 'codex') return drivers.codex;
  if (agent.provider !== 'copilot') return undefined;
  const choice = agent.options?.copilotRuntime ?? 'auto';
  if (choice === 'vscode-lm') return undefined;
  return choice === 'cli' || connections.find(c => c.id === 'copilot')?.runtime === 'cli' ? drivers.copilot : undefined;
}
const NO_SUPPORT = { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: false, useSkills: false, useProjectSettings: false, extraDirs: false,
  ultraSession: false, ultraTurn: false, thinkHard: false, fullAccess: false, customAgent: false };
/** Capabilities of chat-model agents (Ollama, Copilot through vscode.lm): Chatroom's read-only tools only. */
export function legacyCapabilities(agent: Agent, connection: Connection | undefined): AgentCapabilities {
  const status = connection?.status === 'ready' || connection?.status === 'missing' || connection?.status === 'error' ? connection.status : 'unchecked';
  return { provider: agent.provider, runtime: agent.provider === 'ollama' ? 'ollama' : 'vscode-lm', status, ...(connection?.detail ? { detail: connection.detail } : {}),
    ...(connection?.version ? { version: connection.version } : {}), models: connection?.models ?? [], efforts: [], tools: [...agent.tools], skills: [], commands: [], mcpServers: [],
    supports: { ...NO_SUPPORT }, ...(connection?.hint?.action ? { action: connection.hint.action } : {}), updatedAt: Date.now() };
}
export class CopilotProvider implements Provider {
  constructor(private readonly connected?: (models: vscode.LanguageModelChat[]) => void,
    private readonly selectModels: typeof vscode.lm.selectChatModels = selector => vscode.lm.selectChatModels(selector)) {}
  async run(request: ProviderRequest): Promise<ProviderResult> {
    const models = await this.selectModels({ vendor: 'copilot', ...(request.agent.model ? { id: request.agent.model } : {}) });
    this.connected?.(models);
    const model = models[0];
    if (!model) throw new Error('No matching Copilot model. Sign in to GitHub Copilot and refresh connections.');
    const tokenSource = new vscode.CancellationTokenSource(), cancel = () => tokenSource.cancel();
    request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) tokenSource.cancel();
    try {
      const nativeSystem = request.system.replace(/To use a Chatroom tool,[\s\S]*$/, 'Use the provided native tools to inspect real workspace files. Never write tool-call XML in the answer. Do not claim a tool ran without a tool result.');
      const messages: vscode.LanguageModelChatMessage[] = request.continuation
        ? [...request.continuation as vscode.LanguageModelChatMessage[]]
        : [vscode.LanguageModelChatMessage.User(nativeSystem + '\n\n' + request.prompt)];
      if (request.continuation && request.toolResults?.length) messages.push(vscode.LanguageModelChatMessage.User(request.toolResults.map(result => new vscode.LanguageModelToolResultPart(result.call.id!, [new vscode.LanguageModelTextPart(result.output)]))));
      if (request.allowTools === false) messages.push(vscode.LanguageModelChatMessage.User('Tool limit reached. Give a final answer using only verified results already available.'));
      const inputTokens = await model.countTokens(JSON.stringify(messages), tokenSource.token);
      if (inputTokens > model.maxInputTokens) throw new Error(`Context exceeds ${model.name}'s ${model.maxInputTokens} token limit. Lower Chatroom's context budget.`);
      const tools = request.allowTools === false ? [] : request.agent.tools.map(name => toolSpecs[name]);
      const response = await model.sendRequest(messages, { justification: 'Participate in your Chatroom conversation.', ...(tools.length ? { tools } : {}) }, tokenSource.token);
      let text = '';
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [], calls: ToolCall[] = [];
      for await (const part of response.stream) {
        request.signal.throwIfAborted();
        if (part instanceof vscode.LanguageModelTextPart) { text += part.value; parts.push(part); request.onText(text); }
        else if (part instanceof vscode.LanguageModelToolCallPart) {
          parts.push(part); calls.push({ id: part.callId, name: part.name as ToolCall['name'], arguments: part.input as Record<string, unknown> });
        }
      }
      const output = await model.countTokens(text + (calls.length ? JSON.stringify(calls) : ''), tokenSource.token);
      return { text, toolCalls: calls, continuation: [...messages, vscode.LanguageModelChatMessage.Assistant(parts)], usage: { ...emptyUsage(), input: inputTokens, output, requests: 1, estimated: true } };
    } finally { request.signal.removeEventListener('abort', cancel); tokenSource.dispose(); }
  }
}
const INSTALL_HINT = { text: 'Install the GitHub Copilot CLI to give Copilot its own tools, skills and sessions: npm i -g @github/copilot', action: 'installCopilot' as const };
async function copilotConnection(includeCopilot: boolean, previous: Connection[]): Promise<Connection> {
  const runtime = await providerRuntime('copilot');
  if (runtime) return { id: 'copilot', status: 'ready', runtime: 'cli', detail: `Copilot CLI ${runtime.version} · sign-in is checked when an agent connects`, models: [],
    modelSource: 'Copilot CLI (models load when the agent connects)', executable: runtime.executable.prefix[0] ?? runtime.executable.command, version: runtime.version };
  if (!includeCopilot) {
    const known = previous.find(c => c.id === 'copilot' && c.runtime !== 'cli');
    return known ? { ...known, runtime: 'vscode-lm', hint: INSTALL_HINT } : { id: 'copilot', status: 'unchecked', runtime: 'vscode-lm', detail: 'Connect to discover your Copilot models', models: [], hint: INSTALL_HINT };
  }
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return { id: 'copilot', status: models.length ? 'ready' : 'missing', runtime: 'vscode-lm', detail: models.length ? `${models.length} models available through VS Code` : 'Sign in to GitHub Copilot in VS Code',
    models: models.map(m => ({ id: m.id, name: m.name })), modelSource: 'VS Code Copilot catalog', hint: INSTALL_HINT };
}
export async function detectConnections(ollama: OllamaClient, includeCopilot: boolean, previous: Connection[]): Promise<Connection[]> {
  return Promise.all((['codex', 'claude', 'copilot', 'ollama'] as const).map(async id => {
    try {
      if (id === 'codex' || id === 'claude') {
        const runtime = await providerRuntime(id);
        if (!runtime) return { id, status: 'missing', runtime: 'cli', detail: 'No runtime found · install the client extension or configure its executable', models: [] } as Connection;
        const catalog = await (id === 'codex' ? codexModels(runtime) : claudeModels(runtime));
        return { id, status: 'ready', runtime: 'cli', detail: `${runtime.version} · ${runtime.source} · ${catalog.models.length} models`, models: catalog.models, modelSource: catalog.source, executable: runtime.executable.prefix[0] ?? runtime.executable.command, version: runtime.version } as Connection;
      }
      if (id === 'ollama') {
        const models = await ollama.models();
        return { id, status: 'ready', runtime: 'http', detail: `${models.length} installed models · loopback endpoint`, models, modelSource: 'Ollama installed models' } as Connection;
      }
      return await copilotConnection(includeCopilot, previous);
    } catch (error) { return { id, status: 'error', detail: error instanceof Error ? error.message : String(error), models: [] } as Connection; }
  }));
}
