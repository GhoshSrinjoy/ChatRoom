import { Usage, emptyUsage } from './types';

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
export function cliUsage(provider: 'codex' | 'claude', value: any): Usage {
  if (provider === 'codex') return { ...emptyUsage(), input: count(value.input_tokens), output: count(value.output_tokens), cached: count(value.cached_input_tokens), requests: 1 };
  return { ...emptyUsage(), input: count(value.input_tokens) + count(value.cache_read_input_tokens) + count(value.cache_creation_input_tokens),
    output: count(value.output_tokens), cached: count(value.cache_read_input_tokens), cacheWrite: count(value.cache_creation_input_tokens), requests: 1 };
}
export class CliEvents {
  text = '';
  usage?: Usage;
  completed = false;
  constructor(private readonly provider: 'codex' | 'claude', private readonly onText: (text: string) => void, private readonly onActivity: (text: string) => void) {}
  accept(event: any): void {
    if (this.provider === 'codex') {
      // Codex 0.40 emits { id, msg }; newer versions emit item.* and turn.*.
      const legacy = event.msg;
      if (legacy?.type === 'agent_message') { this.text = legacy.message ?? ''; this.onText(this.text); this.completed = true; }
      if (legacy?.type === 'token_count') {
        if (legacy.info?.total_token_usage) this.usage = { ...cliUsage('codex', legacy.info.total_token_usage), quota: this.usage?.quota };
        const limits = legacy.rate_limits;
        if (limits && Number.isFinite(limits.primary_used_percent) && Number.isFinite(limits.secondary_used_percent)) {
          this.usage = { ...(this.usage ?? emptyUsage()), quota: { primaryUsedPercent: Math.min(100, count(limits.primary_used_percent)), secondaryUsedPercent: Math.min(100, count(limits.secondary_used_percent)),
            primaryWindowMinutes: limits.primary_window_minutes, secondaryWindowMinutes: limits.secondary_window_minutes, observedAt: Date.now() } };
        }
      }
      if (legacy?.type === 'exec_command_begin' || legacy?.type === 'mcp_tool_call_begin') this.onActivity(`Codex native ${legacy.type} (read-only sandbox)`);
      if (legacy?.type === 'error') throw new Error(legacy.message ?? 'Codex turn failed.');
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') { this.text = event.item.text ?? ''; this.onText(this.text); }
      if (event.type === 'item.started' && event.item?.type !== 'agent_message') this.onActivity(`Codex native ${event.item?.type ?? 'tool'} (read-only sandbox)`);
      if (event.type === 'turn.completed') { this.completed = true; if (event.usage) this.usage = cliUsage('codex', event.usage); }
      if (event.type === 'turn.failed' || event.type === 'error') throw new Error(event.error?.message ?? event.message ?? 'Codex turn failed.');
    } else {
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') { this.text += event.event.delta.text; this.onText(this.text); }
      if (event.type === 'assistant' && !this.text) { this.text = (event.message?.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'); this.onText(this.text); }
      if (event.type === 'result') {
        this.completed = true;
        if (event.usage) this.usage = cliUsage('claude', event.usage);
        if (this.usage && typeof event.total_cost_usd === 'number') this.usage.cost = event.total_cost_usd;
        if (event.is_error) throw new Error(event.result || (event.errors ?? []).join('\n') || 'Claude Code turn failed.');
        if (typeof event.result === 'string') { this.text = event.result; this.onText(this.text); }
      }
    }
  }
}
