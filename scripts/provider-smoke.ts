import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { CopilotProvider } from '../src/providers';
import { createRoom } from '../src/core';
import { RoomEngine } from '../src/engine';

export async function run(): Promise<void> {
  const room = createRoom(); room.agents = [room.agents[2]!]; room.agents[0]!.model = 'fixture-model';
  let requests = 0, executions = 0;
  const model = {
    id: 'fixture-model', name: 'Native protocol fixture', maxInputTokens: 100000,
    countTokens: async () => 100,
    sendRequest: async (messages: vscode.LanguageModelChatMessage[], options: vscode.LanguageModelChatRequestOptions) => {
      assert.ok(options.tools?.some(t => t.name === 'read_file'));
      if (++requests === 1) {
        assert.doesNotMatch(JSON.stringify(messages), /<chatroom-tool>/);
        return { stream: (async function* () { yield new vscode.LanguageModelToolCallPart('native-123', 'read_file', { path: 'README.md' }); })() };
      }
      const previous = messages.at(-2)!.content[0];
      assert.ok(previous instanceof vscode.LanguageModelToolCallPart); assert.equal(previous.callId, 'native-123');
      const result = messages.at(-1)!.content[0];
      assert.ok(result instanceof vscode.LanguageModelToolResultPart); assert.equal(result.callId, 'native-123');
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart); assert.equal(result.content[0].value, 'Real tool output');
      return { stream: (async function* () { yield new vscode.LanguageModelTextPart('Verified response'); })() };
    }
  } as unknown as vscode.LanguageModelChat;
  const provider = new CopilotProvider(undefined, async selector => { assert.equal(selector?.id, 'fixture-model'); return [model]; });
  const engine = new RoomEngine(room, { providers: { copilot: provider, codex: provider, claude: provider, ollama: provider }, native: () => undefined, tools: async () => { executions++; return 'Real tool output'; },
    framing: () => 'You are an agent in Chatroom.', contextTokens: () => 12000, timeoutMs: () => 5000, approvalTimeoutMs: () => 60000, maxHandoffs: () => 6, changed: () => {} });
  await engine.start('Read the documentation.');
  assert.equal(requests, 2); assert.equal(executions, 1); assert.equal(room.messages.at(-1)?.text, 'Verified response');
  assert.equal(room.completedTurns, 1);
}
