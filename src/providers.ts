import * as vscode from 'vscode';
import { Provider, ProviderId, ProviderRequest, ProviderResult, Connection, ToolCall, emptyUsage } from './types';
import { OllamaClient } from './ollama';
import { CliProvider } from './cli-provider';
import { Runtime, findRuntime, codexModels, claudeModels } from './catalog';
import { toolSpecs } from './tool-specs';

const runtimes = new Map<string, { expires: number; promise: Promise<Runtime | undefined> }>();
export function providerRuntime(id: 'codex' | 'claude'): Promise<Runtime | undefined> {
  const configured = vscode.workspace.getConfiguration('chatroom').get<string>(`${id}Path`, id);
  const extensionPath = vscode.extensions.getExtension(id === 'codex' ? 'openai.chatgpt' : 'anthropic.claude-code')?.extensionPath;
  const key = JSON.stringify([id, configured, extensionPath]), existing = runtimes.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const promise = findRuntime(id, configured, extensionPath); runtimes.set(key, { promise, expires: Date.now() + 180000 }); return promise;
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
export function createProviders(cwd: () => string, ollama: OllamaClient, connected?: (models: vscode.LanguageModelChat[]) => void): Record<ProviderId, Provider> {
  return { codex: new CliProvider('codex', cwd, () => providerRuntime('codex')), claude: new CliProvider('claude', cwd, () => providerRuntime('claude')), copilot: new CopilotProvider(connected), ollama };
}
export async function detectConnections(ollama: OllamaClient, includeCopilot: boolean, previous: Connection[]): Promise<Connection[]> {
  return Promise.all((['codex', 'claude', 'copilot', 'ollama'] as const).map(async id => {
    try {
      if (id === 'codex' || id === 'claude') {
        const runtime = await providerRuntime(id);
        if (!runtime) return { id, status: 'missing', detail: 'No runtime found · install the client extension or configure its executable', models: [] } as Connection;
        const catalog = await (id === 'codex' ? codexModels(runtime) : claudeModels(runtime));
        return { id, status: 'ready', detail: `${runtime.version} · ${runtime.source} · ${catalog.models.length} models`, models: catalog.models, modelSource: catalog.source, executable: runtime.executable.prefix[0] ?? runtime.executable.command, version: runtime.version } as Connection;
      }
      if (id === 'ollama') {
        const models = await ollama.models();
        return { id, status: 'ready', detail: `${models.length} installed models · loopback endpoint`, models, modelSource: 'Ollama installed models' } as Connection;
      }
      if (!includeCopilot) return previous.find(c => c.id === id) ?? { id, status: 'unchecked', detail: 'Connect to discover your Copilot models', models: [] };
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return { id, status: models.length ? 'ready' : 'missing', detail: models.length ? `${models.length} models available through VS Code` : 'Sign in to GitHub Copilot in VS Code', models: models.map(m => ({ id: m.id, name: m.name })), modelSource: 'VS Code Copilot catalog' } as Connection;
    } catch (error) { return { id, status: 'error', detail: error instanceof Error ? error.message : String(error), models: [] } as Connection; }
  }));
}
