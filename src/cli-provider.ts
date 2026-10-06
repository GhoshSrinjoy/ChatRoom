import { Provider, ProviderRequest, ProviderResult } from './types';
import { Runtime } from './catalog';
import { CliEvents } from './cli-events';
import { runJsonLines } from './process';
import { estimatedUsage } from './core';

export function cliArgs(provider: 'codex' | 'claude', runtime: Runtime, request: Pick<ProviderRequest, 'agent' | 'system'>): string[] {
  if (provider === 'codex') {
    const effort = request.agent.reasoning || 'medium';
    if (!runtime.modern && !['minimal', 'low', 'medium', 'high'].includes(effort)) throw new Error(`Codex ${runtime.version} does not support ${effort} reasoning. Choose high or use the newer Codex extension runtime.`);
    return ['-a', 'never', '-c', `model_reasoning_effort="${effort}"`, '-c', 'mcp_servers={}', 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', ...(runtime.modern ? ['--ephemeral'] : []), ...(request.agent.model ? ['--model', request.agent.model] : []), '-'];
  }
  return ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', request.system, ...(request.agent.model ? ['--model', request.agent.model] : [])];
}
export class CliProvider implements Provider {
  constructor(private readonly id: 'codex' | 'claude', private readonly cwd: () => string, private readonly runtime: () => Promise<Runtime | undefined>) {}
  async run(request: ProviderRequest): Promise<ProviderResult> {
    const runtime = await this.runtime();
    if (!runtime) throw new Error(`${this.id} runtime was not found. Install its VS Code extension or configure its executable in Chatroom settings.`);
    request.signal.throwIfAborted();
    request.onActivity(`${this.id} ${runtime.version} · ${request.agent.model || 'Client default'} · ${runtime.source}`);
    const events = new CliEvents(this.id, request.onText, request.onActivity);
    const prompt = this.id === 'codex' ? request.system + '\n\n' + request.prompt : request.prompt;
    const output = await runJsonLines(runtime.executable, cliArgs(this.id, runtime, request), prompt, this.cwd(), request.signal, event => events.accept(event));
    if (!events.completed || !events.text.trim()) {
      // A CLI that prints a plain-text error (for example, a login prompt) and exits 0 explains itself here.
      const said = (output.stdout || output.stderr).slice(-800);
      throw new Error(`The ${this.id === 'codex' ? 'Codex' : 'Claude'} CLI returned no answer.${said ? ` It printed:\n${said}` : ' Check its login and the Activity tab.'}`);
    }
    return { text: events.text, usage: events.usage?.requests ? events.usage : { ...estimatedUsage(request.system + request.prompt, events.text), quota: events.usage?.quota } };
  }
}
