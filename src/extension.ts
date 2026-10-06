import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Room, Agent, Connection, ProviderId, RoomMode, TaskPreset, ModelDefaults, addUsage, emptyUsage } from './types';
import { createRoom, boundedNumber, TOOL_NAMES, DEFAULT_TOOLS, overLimit } from './core';
import { RoomEngine } from './engine';
import { OllamaClient } from './ollama';
import { createProviders, detectConnections } from './providers';
import { ToolService } from './tools';
import { DocumentService, LocalModels } from './documents';
import { KnowledgeStore, sha256 } from './knowledge';
import { MAX_DOCUMENT_BYTES } from './extract';

const MODES: RoomMode[] = ['orchestrated', 'sequential', 'parallel'];
const SCHEMA = 4;

let app: ChatroomApp | undefined;
export function activate(context: vscode.ExtensionContext): void {
  app = new ChatroomApp(context);
  context.subscriptions.push(app,
    vscode.window.registerWebviewViewProvider('chatroom.chat', app, { webviewOptions: { retainContextWhenHidden: true } }),
    // Restored layouts from 0.1 still request this view ID. Keep its resolver
    // registered even though new windows contribute only the right-hand view.
    vscode.window.registerWebviewViewProvider('chatroom.sidebar', app, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('chatroom.open', () => vscode.commands.executeCommand('chatroom.chat.focus')),
    vscode.commands.registerCommand('chatroom.openEditor', () => app!.openPanel()),
    vscode.commands.registerCommand('chatroom.new', () => app!.newRoom()),
    vscode.commands.registerCommand('chatroom.refresh', () => app!.refresh(true)),
    vscode.commands.registerCommand('chatroom.export', () => app!.exportRoom()));
}
export function deactivate(): void { app?.dispose(); }

class ChatroomApp implements vscode.WebviewViewProvider, vscode.Disposable {
  private views = new Set<vscode.Webview>();
  private panel?: vscode.WebviewPanel;
  private rooms: Room[];
  private connections: Connection[] = [];
  private engine: RoomEngine;
  private ollama: OllamaClient;
  private tools: ToolService;
  private models: LocalModels;
  private knowledge: KnowledgeStore;
  private documents: DocumentService;
  private ingestions = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private disposed = false;
  private discovering = false;
  private persistence: Promise<unknown> = Promise.resolve();
  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<Room[]>('chatroom.rooms.v1', []);
    this.rooms = saved.filter(r => r && typeof r.id === 'string' && Array.isArray(r.agents) && Array.isArray(r.messages)).slice(0, 20);
    for (const room of this.rooms) this.restore(room);
    if (!this.rooms.length) this.rooms.push(this.createConfiguredRoom());
    this.models = context.workspaceState.get<LocalModels>('chatroom.localModels', { vision: '', embedding: '' });
    this.ollama = new OllamaClient(() => this.config('ollamaUrl', 'http://127.0.0.1:11434'), () => this.config('ollamaKeepAlive', '5m'),
      usage => { const room = this.engine.room; room.usage['local-tools'] = addUsage(room.usage['local-tools'] ?? emptyUsage(), usage); this.changed(); },
      () => { if (overLimit(this.engine.room)) throw new Error('This message reached its token limit before a local model request. Resume or change the limit in Usage.'); });
    this.knowledge = new KnowledgeStore(join((context.storageUri ?? context.globalStorageUri).fsPath, 'knowledge'));
    this.documents = new DocumentService(this.knowledge, this.ollama, this.models, (text, kind) => this.engine.log(text, kind ?? 'tool'), () => this.changed());
    this.tools = new ToolService(() => this.root(), this.documents, () => this.engine.room, text => this.engine.log(text, 'tool'));
    this.engine = this.makeEngine(this.rooms[0]!);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('chatroom')) this.changed(); }));
    void this.refresh(false);
  }
  /** Saved rooms come back idle; interrupted plans and document jobs are marked as such. */
  private restore(room: Room): void {
    room.status = 'idle'; room.currentAgent = undefined; room.activeAgents = []; room.queuedTurns = 0; room.agentStates = {};
    room.mode ??= 'sequential'; room.concurrency ??= 3; room.preset ??= 'planning'; room.flow = undefined;
    room.messages.forEach(m => {
      if (m.status === 'streaming') m.status = 'cancelled';
      for (const step of m.plan ?? []) if (step.status === 'pending' || step.status === 'running') Object.assign(step, { status: 'skipped', detail: 'Interrupted when the window closed.' });
    });
    room.documents = (room.documents ?? []).map(d => d.status === 'ready' || d.status === 'error' ? d : { ...d, status: 'error', detail: 'Interrupted · attach it again.' });
    const schema = room.schema ?? 0;
    if (schema < 3) for (const agent of room.agents) if (agent.tools.includes('read_file') && !agent.tools.includes('search_documents')) agent.tools.push('search_documents');
    // The old default room budget (50,000 tokens for the room's whole life) stopped runs after one Codex turn.
    if (schema < 4 && room.tokenBudget === 50000) room.tokenBudget = 0;
    room.schema = SCHEMA;
  }
  private config<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('chatroom').get<T>(key, fallback); }
  /** Fills empty OCR/embedding selections from installed local models, unless the user chose them. */
  private pickLocalModels(): void {
    if (this.context.workspaceState.get('chatroom.localModelsChosen', false)) return;
    const installed = (this.connections.find(c => c.id === 'ollama')?.models ?? []).filter(m => !m.remote && !m.error);
    const vision = installed.filter(m => m.capabilities?.includes('vision')), embedding = installed.filter(m => m.capabilities?.includes('embedding'));
    let picked = false;
    if (!this.models.vision && vision.length) { this.models.vision = (vision.find(m => /ocr/i.test(m.id)) ?? vision[0]!).id; picked = true; }
    if (!this.models.embedding && embedding.length) { this.models.embedding = (embedding.find(m => /embed/i.test(m.id)) ?? embedding[0]!).id; picked = true; }
    if (picked) void this.context.workspaceState.update('chatroom.localModels', this.models);
  }
  private defaults(): ModelDefaults {
    const saved = this.config<ModelDefaults>('modelDefaults', { planning: {}, drafting: {}, review: {} });
    const result: ModelDefaults = { planning: {}, drafting: {}, review: {} };
    for (const preset of ['planning', 'drafting', 'review'] as const) for (const provider of ['codex', 'claude', 'copilot', 'ollama'] as const) {
      const models = (this.connections.find(c => c.id === provider)?.models ?? []).filter(m => !m.error && (provider !== 'ollama' || (!m.remote && m.capabilities?.includes('completion'))));
      const suggested = provider === 'claude' ? ({ planning: 'opus', drafting: 'haiku', review: 'sonnet' })[preset]
        : (preset === 'drafting' ? models.find(m => /(?:luna|mini|haiku)/i.test(m.id))?.id : undefined) ?? models.find(m => m.isDefault)?.id ?? models[0]?.id ?? '';
      result[preset][provider] = saved?.[preset]?.[provider] || suggested;
    }
    return result;
  }
  private createConfiguredRoom(): Room {
    const room = createRoom(this.defaults(), this.config<TaskPreset>('defaultPreset', 'planning'));
    const mode = this.config<RoomMode>('executionMode', 'orchestrated');
    room.mode = MODES.includes(mode) ? mode : 'orchestrated'; room.schema = SCHEMA; room.concurrency = boundedNumber(this.config('maxParallelAgents', 3), 1, 4, 3); return room;
  }
  private selectModel(agent: Agent, model: string): void {
    agent.model = model;
    agent.reasoning = this.connections.find(c => c.id === agent.provider)?.models.find(m => m.id === model)?.defaultReasoning ?? 'medium';
  }
  private root(): string { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) throw new Error('Open a local workspace folder to use Chatroom.'); return root; }
  private makeEngine(room: Room): RoomEngine {
    return new RoomEngine(room, { providers: createProviders(() => this.root(), this.ollama, models => {
      if (!models.length) return;
      const previous = this.connections.find(c => c.id === 'copilot');
      const merged = new Map((previous?.models ?? []).map(m => [m.id, m]));
      for (const model of models) merged.set(model.id, { id: model.id, name: model.name });
      const connection: Connection = { id: 'copilot', status: 'ready', detail: `${merged.size} models available through VS Code`, models: [...merged.values()], modelSource: 'VS Code Copilot catalog' };
      this.connections = [...this.connections.filter(c => c.id !== 'copilot'), connection]; this.changed();
    }),
      tools: (call, agent, signal) => this.tools.execute(call, agent, signal),
      briefing: (target, query, signal) => this.documents.briefing(target, query, signal),
      contextTokens: () => boundedNumber(this.config('contextTokens', 12000), 2000, 64000, 12000),
      timeoutMs: () => boundedNumber(this.config('turnTimeoutSeconds', 180), 15, 1800, 180) * 1000,
      changed: () => this.changed() });
  }
  resolveWebviewView(view: vscode.WebviewView): void { this.setup(view.webview); view.onDidDispose(() => this.views.delete(view.webview)); }
  openPanel(): void {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel('chatroom.room', 'Chatroom', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media/chatroom.svg');
    const webview = this.panel.webview; this.setup(webview);
    this.panel.onDidDispose(() => { this.views.delete(webview); this.panel = undefined; });
  }
  private setup(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file)).toString();
    const nonce = randomBytes(18).toString('base64');
    this.views.add(webview);
    this.context.subscriptions.push(webview.onDidReceiveMessage(data => { void this.handle(data).catch(error => {
      const text = error instanceof Error ? error.message : String(error);
      void webview.postMessage({ type: 'error', text });
    }); }));
    // Install the bridge before navigating the webview so the first ready
    // message cannot race registration on a warm webview cache.
    webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('app.css')}"><title>Chatroom</title></head><body><div id="app"><p>Opening Chatroom…</p></div><script nonce="${nonce}" src="${uri('app.js')}"></script></body></html>`;
  }
  private changed(): void {
    if (this.disposed) return;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.broadcast(); }, 55);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.persist(); }, 700);
  }
  private persist(): void {
    // Serialize snapshots to avoid a slower old save overwriting newer room state.
    const snapshot = JSON.parse(JSON.stringify(this.rooms)) as Room[];
    this.persistence = this.persistence.then(() => this.context.workspaceState.update('chatroom.rooms.v1', snapshot)).catch(() => {});
  }
  private broadcast(): void {
    const state = { type: 'state', room: this.engine.room, rooms: this.rooms.map(r => ({ id: r.id, title: r.title })),
      connections: this.connections, localModels: this.models, discovering: this.discovering, modelDefaults: this.defaults(),
      defaultPreset: this.config('defaultPreset', 'planning'), executionMode: this.config('executionMode', 'orchestrated'), maxParallelAgents: this.config('maxParallelAgents', 3),
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? 'No folder open', trusted: vscode.workspace.isTrusted };
    for (const view of this.views) void view.postMessage(state);
  }
  async refresh(copilot: boolean): Promise<void> {
    if (this.discovering) { this.pendingCopilot ||= copilot; return; }
    this.discovering = true; this.changed();
    try {
      this.connections = await detectConnections(this.ollama, copilot, this.connections);
      this.pickLocalModels();
      for (const room of this.rooms) for (const agent of room.agents) if (!agent.model && room.status !== 'running') this.selectModel(agent, this.defaults()[room.preset ?? 'planning'][agent.provider] ?? '');
    } finally { this.discovering = false; this.changed(); if (this.pendingCopilot) { this.pendingCopilot = false; void this.refresh(true); } }
  }
  private pendingCopilot = false;
  newRoom(): void {
    if (this.engine.busy) { void vscode.window.showInformationMessage('Stop the current run before opening another room.'); return; }
    const room = this.createConfiguredRoom(); this.rooms.unshift(room); this.rooms = this.rooms.slice(0, 20); this.engine = this.makeEngine(room); this.changed();
  }
  async exportRoom(): Promise<void> {
    const room = this.engine.room;
    const name = (id: string) => room.agents.find(a => a.id === id)?.name ?? 'Removed agent';
    const text = `# ${room.title}\n\n` + room.messages.map(m => `## ${m.author}${m.step ? ` · step ${m.step.id}` : m.turn === 'synthesis' ? ' · final answer' : ''}${m.status !== 'complete' ? ` (${m.status})` : ''}\n\n${m.step ? `> ${m.step.task}\n\n` : ''}${m.text}\n${m.plan?.length ? '\n' + m.plan.map(s => `- **${s.id}** ${name(s.agentId)}: ${s.task}${s.after.length ? ` _(after ${s.after.join(', ')})_` : ''} — ${s.status}`).join('\n') + '\n' : ''}`).join('\n');
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${this.root()}/chatroom-${room.id.slice(0, 8)}.md`), filters: { Markdown: ['md'] } });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  }
  private async handle(data: any): Promise<void> {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    const room = this.engine.room;
    switch (data.type) {
      case 'ready': this.broadcast(); if (!this.connections.find(c => c.id === 'copilot' && c.status !== 'unchecked')) void this.refresh(true); break;
      case 'open': this.openPanel(); break;
      case 'refresh': await this.refresh(true); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:chatroom-local.chatroom'); break;
      case 'new': this.newRoom(); break;
      case 'export': await this.exportRoom(); break;
      case 'switch': {
        if (this.engine.busy) throw new Error('Stop the current run before switching rooms.');
        const next = this.rooms.find(r => r.id === data.id);
        if (next) { this.engine = this.makeEngine(next); this.changed(); } break;
      }
      case 'send': case 'start': {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting agents.');
        this.root();
        const text = data.type === 'send' && typeof data.text === 'string' ? data.text.trim().slice(0, 24000) : undefined;
        if (data.type === 'send' && !text) return;
        await this.engine.start(text, typeof data.target === 'string' && data.target ? data.target : undefined); break;
      }
      case 'pause': this.engine.pause(); break;
      case 'stop': this.engine.stop(); break;
      case 'stopAgent': if (typeof data.id === 'string') this.engine.stopAgent(data.id); break;
      case 'options': {
        if (this.engine.busy) throw new Error('Pause or stop the run before changing limits.');
        room.rounds = boundedNumber(data.rounds, 1, 10, room.rounds);
        const limit = boundedNumber(data.tokenBudget, 0, 10_000_000, room.tokenBudget);
        room.tokenBudget = limit && Math.max(1000, limit);
        if (MODES.includes(data.mode)) room.mode = data.mode;
        if (typeof data.leadId === 'string' && room.agents.some(a => a.id === data.leadId)) room.leadId = data.leadId;
        room.concurrency = boundedNumber(data.concurrency, 1, 4, room.concurrency ?? 3);
        if (['planning', 'drafting', 'review'].includes(data.preset)) {
          room.preset = data.preset;
          for (const agent of room.agents) this.selectModel(agent, this.defaults()[room.preset!][agent.provider] ?? '');
        }
        this.changed(); break;
      }
      case 'saveDefaults': {
        const defaults: ModelDefaults = { planning: {}, drafting: {}, review: {} };
        for (const preset of ['planning', 'drafting', 'review'] as const) for (const provider of ['codex', 'claude', 'copilot', 'ollama'] as const) {
          const value = data.modelDefaults?.[preset]?.[provider];
          if (typeof value === 'string') defaults[preset][provider] = value.trim().slice(0, 160);
        }
        const config = vscode.workspace.getConfiguration('chatroom');
        await config.update('modelDefaults', defaults, vscode.ConfigurationTarget.Global);
        if (['planning', 'drafting', 'review'].includes(data.defaultPreset)) await config.update('defaultPreset', data.defaultPreset, vscode.ConfigurationTarget.Global);
        if (MODES.includes(data.executionMode)) await config.update('executionMode', data.executionMode, vscode.ConfigurationTarget.Global);
        await config.update('maxParallelAgents', boundedNumber(data.maxParallelAgents, 1, 4, 3), vscode.ConfigurationTarget.Global);
        this.changed(); break;
      }
      case 'agent': {
        const agent = room.agents.find(a => a.id === data.id);
        if (!agent) return;
        if (typeof data.enabled === 'boolean') { if (!data.enabled) this.engine.stopAgent(agent.id); else agent.enabled = true; }
        if (!this.engine.busy) {
          if (typeof data.name === 'string') agent.name = data.name.trim().slice(0, 40) || agent.name;
          if (typeof data.model === 'string') this.selectModel(agent, data.model.trim().slice(0, 160));
          if (typeof data.reasoning === 'string') {
            const efforts = this.connections.find(c => c.id === agent.provider)?.models.find(m => m.id === agent.model)?.reasoning ?? ['minimal', 'low', 'medium', 'high'];
            if (efforts.includes(data.reasoning)) agent.reasoning = data.reasoning;
          }
          if (typeof data.role === 'string') agent.role = data.role.trim().slice(0, 1600);
          if (Array.isArray(data.tools)) agent.tools = TOOL_NAMES.filter(t => data.tools.includes(t));
        }
        this.changed(); break;
      }
      case 'addAgent': {
        if (this.engine.busy) throw new Error('Pause or stop the run before adding agents.');
        if (room.agents.length >= 8) throw new Error('A room supports up to 8 agents.');
        if (!['codex', 'claude', 'copilot', 'ollama'].includes(data.provider)) return;
        const provider = data.provider as ProviderId;
        const agent: Agent = { id: randomUUID(), provider, name: ({ codex: 'Codex', claude: 'Claude', copilot: 'Copilot', ollama: 'Ollama' })[provider],
          model: this.defaults()[room.preset ?? 'planning'][provider] ?? '', role: 'Specialist. Contribute your perspective and help resolve the user’s objective.', enabled: true, tools: [...DEFAULT_TOOLS] };
        room.agents.push(agent); this.changed(); break;
      }
      case 'removeAgent': {
        if (this.engine.busy) throw new Error('Pause or stop the run before removing agents.');
        room.agents = room.agents.filter(a => a.id !== data.id); this.changed(); break;
      }
      case 'localModels': {
        if (this.engine.busy) throw new Error('Pause or stop the run before changing local tools.');
        const available = this.connections.find(c => c.id === 'ollama')?.models ?? [];
        for (const key of ['vision', 'embedding'] as const) {
          if (typeof data[key] !== 'string') continue;
          if (data[key] && !available.some(m => m.id === data[key] && !m.remote && m.capabilities?.includes(key))) throw new Error(`Choose an installed local ${key} model.`);
          this.models[key] = data[key];
        }
        await this.context.workspaceState.update('chatroom.localModels', this.models);
        await this.context.workspaceState.update('chatroom.localModelsChosen', true); this.changed(); break;
      }
      case 'attachDocuments': {
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching documents.');
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach to Chatroom', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          filters: { 'Documents and images': ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'csv', 'json', 'html', 'xml', 'yaml', 'yml', 'log'], 'All files': ['*'] } });
        for (const uri of uris ?? []) {
          const name = vscode.workspace.asRelativePath(uri, false);
          if ((await vscode.workspace.fs.stat(uri)).size > MAX_DOCUMENT_BYTES) { this.engine.log(`${name} is larger than 40 MB and was not attached`, 'error'); continue; }
          const bytes = await vscode.workspace.fs.readFile(uri), key = `${room.id}:${sha256(bytes)}`, controller = new AbortController();
          this.ingestions.get(key)?.abort(); this.ingestions.set(key, controller);
          // The user chose these files, so extraction is not blocked by the agents' room budget; usage is still counted.
          void this.documents.ingest(room, name, bytes, { source: 'attached', signal: controller.signal, checkBudget: false })
            .finally(() => { if (this.ingestions.get(key) === controller) this.ingestions.delete(key); });
        }
        break;
      }
      case 'removeDocument': {
        const doc = room.documents?.find(d => d.id === data.id);
        if (!doc) return;
        this.ingestions.get(`${room.id}:${doc.hash}`)?.abort(new Error('Document removed.'));
        room.documents = room.documents!.filter(d => d.id !== doc.id); this.changed(); break;
      }
      case 'attach': {
        if (this.engine.busy) throw new Error('Pause or stop before attaching context.');
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new Error('Open a text file and select the context to attach.');
        const selection = editor.selection;
        const text = (selection.isEmpty ? editor.document.getText() : editor.document.getText(selection)).slice(0, 12000);
        const path = vscode.workspace.asRelativePath(editor.document.uri);
        for (const view of this.views) void view.postMessage({ type: 'attachment', text: `\n\n[File context: ${path}]\n${text}` });
        break;
      }
    }
  }
  dispose(): void { if (this.disposed) return; this.engine.stop(); for (const controller of this.ingestions.values()) controller.abort(); void this.knowledge.flush(); this.disposed = true; if (this.timer) clearTimeout(this.timer); if (this.persistTimer) clearTimeout(this.persistTimer); this.persist(); }
}
