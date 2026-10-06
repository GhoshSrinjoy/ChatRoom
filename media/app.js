/* Chatroom webview. No network access; all provider traffic stays in the extension host. */
(() => {
  'use strict';
  const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: m => window.dispatchEvent(new CustomEvent('preview-message', { detail: m })), getState: () => ({}), setState: () => {} };
  const saved = bridge.getState() || {};
  let state, tab = saved.tab || 'usage', editing, dialogKind = '', dialogDirty = false, dialogHtml = '', returnFocus, returnKey = '', lastRoom, nearBottom = true, lastSent;
  let droppedKey = '', think = false, ultra = false, pop = '', popAnchor, popHtml = '', confirmClose;
  const ultraConfirmed = saved.ultraConfirmed || {}, openState = new Map(), nodes = new Map(), capsAsked = {};
  const menu = { open: false, kind: '', query: '', start: 0, end: 0, items: [], index: 0 };
  const $ = id => document.getElementById(id);
  const send = (type, data = {}) => bridge.postMessage({ type, ...data });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = value => new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
  const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const clock = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const icons = {
    logo: '<svg viewBox="0 0 32 32" fill="none"><path d="M6 5h15a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-9l-6 5v-5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" stroke="currentColor" stroke-width="1.8"/><path d="M25 10h1a3 3 0 0 1 3 3v13l-5-4" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="13" r="1.3" fill="currentColor"/><circle cx="14" cy="13" r="1.3" fill="currentColor"/><circle cx="19" cy="13" r="1.3" fill="currentColor"/></svg>',
    plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="m7 17 10-10M7 7h10v10"/>',
    send: '<path d="m5 12 7-7 7 7M12 5v15"/>', pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>', play: '<path d="m8 5 11 7-11 7Z"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
    attach: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2M6 15l8-8"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m8 5 7 7-7 7"/>', export: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    sparkle: '<path d="M12 3.5 13.9 9l5.6 2-5.6 2L12 18.5 10.1 13l-5.6-2 5.6-2Z"/><path d="m18.5 15.5.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12Z"/>',
    at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 8.5v4.6a2.7 2.7 0 0 0 5.4 0V12a9 9 0 1 0-3.6 7.2"/>',
    slash: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m14 7.5-4 9"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeClosed: '<path d="M3 9.5c2.4 3.2 5.4 4.8 9 4.8s6.6-1.6 9-4.8M6 13l-1.6 2.4M10 14.6l-.5 2.9M14 14.6l.5 2.9M18 13l1.6 2.4"/>',
    star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8Z"/>',
    users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M15.5 5.3a3.3 3.3 0 0 1 0 6.4M17.5 14a6 6 0 0 1 3.5 5.5"/>',
    loop: '<path d="m17 3.5 3 3-3 3"/><path d="M4 11.5v-1a4 4 0 0 1 4-4h12"/><path d="m7 20.5-3-3 3-3"/><path d="M20 12.5v1a4 4 0 0 1-4 4H4"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.9 7.5 9.5 4.3-1.6 7.5-4.9 7.5-9.5V6Z"/>',
    gauge: '<path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0"/><path d="m12 14 3.5-4.5"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
    edit: '<path d="M4 20h4L19.5 8.5l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
    plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0Z"/><path d="M12 16.5V21"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
    alert: '<path d="M12 3.5 2.5 20h19Z"/><path d="M12 10v4.5M12 17.2h.01"/>',
    tool: '<path d="M14.5 4.5a4.5 4.5 0 0 0-5.3 5.9l-5.7 5.7v4.4h4.4l5.7-5.7a4.5 4.5 0 0 0 5.9-5.3l-2.8 2.8-2.9-.6-.6-2.9Z"/>',
    book: '<path d="M4 4.5h5.5A2.5 2.5 0 0 1 12 7v13a2 2 0 0 0-2-2H4ZM20 4.5h-5.5A2.5 2.5 0 0 0 12 7v13a2 2 0 0 1 2-2h6Z"/>',
    compress: '<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/>'
  };
  const icon = name => name === 'logo' ? icons.logo : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
  // Provider glyphs. Copilot (copilot-16) and Ollama (cpu-16) are Primer Octicons, MIT (see ThirdPartyNotices.txt); Codex and Claude are drawn here.
  const GLYPHS = {
    codex: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 12.5A2.6 2.6 0 1 1 5.2 7.37A3.4 3.4 0 1 1 11.98 7.7A2.4 2.4 0 1 1 12 12.5Z"/><path d="M6.3 8.3l1.5 1.4-1.5 1.4M9.1 11.1h2"/></svg>',
    claude: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 5.9L8 1.4M9.05 6.18L10.4 3.84M9.82 6.95L13.72 4.7M10.1 8L12.8 8M9.82 9.05L13.72 11.3M9.05 9.82L10.4 12.16M8 10.1L8 14.6M6.95 9.82L5.6 12.16M6.18 9.05L2.28 11.3M5.9 8L3.2 8M6.18 6.95L2.28 4.7M6.95 6.18L5.6 3.84"/></svg>',
    copilot: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"/><path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/></svg>',
    ollama: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.5.75V2h3V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75V5h1.25a.75.75 0 0 1 0 1.5H14v3h1.25a.75.75 0 0 1 0 1.5H14v1.25A1.75 1.75 0 0 1 12.25 14H11v1.25a.75.75 0 0 1-1.5 0V14h-3v1.25a.75.75 0 0 1-1.5 0V14H3.75A1.75 1.75 0 0 1 2 12.25V11H.75a.75.75 0 0 1 0-1.5H2v-3H.75a.75.75 0 0 1 0-1.5H2V3.75C2 2.784 2.784 2 3.75 2H5V.75a.75.75 0 0 1 1.5 0Zm5.75 11.75a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25ZM5.75 5h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-.75.75h-4.5a.75.75 0 0 1-.75-.75v-4.5A.75.75 0 0 1 5.75 5Zm.75 4.5h3v-3h-3Z"/></svg>'
  };
  const names = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot', ollama: 'Ollama' };
  const toolLabels = { list_files: 'List files', read_file: 'Read files', search_files: 'Search text', search_documents: 'Search documents', ollama_ocr: 'Local OCR', semantic_search: 'Semantic search' };
  const toolDescriptions = { list_files: 'Find files in the workspace', read_file: 'Read files; PDFs, Word files and images are converted to text automatically', search_files: 'Find exact text across files', search_documents: 'Find passages in the documents attached to this room', ollama_ocr: 'Read images with a local vision model', semantic_search: 'Find relevant code with local embeddings' };
  const ROOM_TOOLS = [
    ['search_documents', 'Search documents', 'book', 'Search the documents attached to this Chatroom (PDFs, Word files, images, text) by meaning and return the most relevant passages with page numbers.'],
    ['read_document', 'Read documents', 'file', 'Read a PDF, Word (.docx) or image file from the workspace as text, using local OCR for scans and images. It also attaches the file to the room so every agent can search it. Use your own tools for plain text files.'],
    ['semantic_search', 'Semantic search', 'search', 'Find relevant workspace code or text snippets with the local embedding model.'],
    ['ollama_ocr', 'Local OCR', 'eye', 'Extract text from a workspace image with the local vision model.']];
  const modeLabels = { orchestrated: 'Team', sequential: 'Relay', parallel: 'Parallel' };
  const modeHelp = {
    orchestrated: 'The lead gets your message first. It answers itself or splits the work for the team; independent steps run in parallel, and the lead writes the final answer.',
    sequential: 'Agents reply one after another, and each builds on the replies before it.',
    parallel: 'Agents answer independently at the same time. The next round sees all replies.'
  };
  const permLabels = { plan: 'Plan', ask: 'Ask', 'auto-edit': 'Auto-edit', full: 'Full access' };
  const permHelp = { plan: 'Read and plan only', ask: 'Ask before edits and commands (approval cards)', 'auto-edit': 'Edit files freely, ask for the rest', full: 'No approvals. Use with care' };
  const effortLabels = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
  const verbs = { command: 'run a command', edit: 'edit files', read: 'read files', network: 'use the network', mcp: 'use a tool', plan: 'leave plan mode and start editing' };
  const decided = { allowed: 'Allowed', 'allowed-session': 'Allowed for session', denied: 'Denied', expired: 'Expired', cancelled: 'Cancelled' };
  const actIcons = { tool: 'tool', command: 'terminal', edit: 'edit', read: 'file', search: 'search', mcp: 'plug', subagent: 'users', plan: 'list', compact: 'compress', info: 'info', error: 'alert' };
  const stepLabels = { pending: 'Waiting', running: 'Working…', complete: 'Done', error: 'Failed', skipped: 'Skipped' };
  const DEFAULT_LOOP = { kind: 'once', rounds: 2, everyMinutes: 10, maxIterations: 5, maxMinutes: 60, maxTokens: 0 };
  const DEFAULT_OPTIONS = { effort: '', thinking: 'on', summary: 'auto', permission: 'ask', useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: [], ultra: false };
  const SUPPORT = {
    claude: { thinking: true, summary: false, sandbox: false, webSearch: true, useMcp: true, useSkills: true, useProjectSettings: true, extraDirs: true, ultraSession: false, ultraTurn: false, thinkHard: true, fullAccess: true, customAgent: true },
    codex: { thinking: false, summary: true, sandbox: true, webSearch: true, useMcp: true, useSkills: false, useProjectSettings: true, extraDirs: true, ultraSession: false, ultraTurn: false, thinkHard: true, fullAccess: true, customAgent: false },
    copilot: { thinking: false, summary: false, sandbox: false, webSearch: false, useMcp: true, useSkills: false, useProjectSettings: true, extraDirs: true, ultraSession: false, ultraTurn: true, thinkHard: false, fullAccess: true, customAgent: true }
  };
  const THINK_TITLE = 'Think harder on this message (Claude: ultrathink · Codex: one effort level higher · Copilot: higher reasoning effort)';
  const ULTRA_TEXT = 'Ultra lets each agent orchestrate its own sub-agents (Claude ultracode, Codex Ultra effort, Copilot fleet). It can use many times more tokens. Turn it on for this message?';
  $('app').innerHTML = `
    <header class="topbar"><div class="brand"><span class="brandmark">${icon('logo')}</span>Chatroom</div><div class="top-actions"><span id="workspace" class="workspace-label"></span><button class="icon-button" data-action="refresh" title="Refresh connections and models" aria-label="Refresh connections">${icon('refresh')}</button><button class="icon-button" data-action="open" title="Open in editor" aria-label="Open in editor">${icon('arrow')}</button><button class="icon-button" data-action="defaults" title="Models and defaults" aria-label="Settings">${icon('settings')}</button></div></header>
    <div class="room-bar"><div class="room-picker"><select id="rooms" aria-label="Conversation"></select><button class="icon-button small" data-action="new" aria-label="New room" title="New room">${icon('plus')}</button></div><div class="room-bar-right"><span id="room-status" class="status-label"></span><button class="icon-button small inspector-toggle" data-action="inspector" aria-label="Usage, tools and activity" title="Usage, tools and activity">${icon('grid')}</button><button class="icon-button small" data-action="export" aria-label="Export conversation" title="Export conversation">${icon('export')}</button></div></div>
    <main class="workspace">
      <nav id="team-strip" class="team-strip" role="toolbar" aria-label="Agents in this room"><div id="team-pills" class="team-pills"></div><button class="icon-button small" data-action="add" aria-label="Add agent" title="Add an agent">${icon('plus')}</button><button class="icon-button small" data-action="room-setup" aria-label="Room setup" title="Room setup: who is in the room, who leads, and how they work together">${icon('settings')}</button></nav>
      <section class="conversation"><div class="conversation-heading"><h1 id="conversation-title"></h1><span id="turns" class="turn-count"></span></div><div id="messages" class="messages" role="log" aria-label="Room conversation" aria-live="polite"></div>
        <div id="run-controls" class="run-controls"></div>
        <div class="composer-wrap"><div id="menu" class="popover-menu" role="listbox" aria-label="Suggestions" hidden></div><div id="popover" class="chip-popover" role="dialog" tabindex="-1" hidden></div>
          <form id="composer" class="composer"><div id="context-chips" class="context-chips" hidden><span id="editor-slot" class="editor-slot"></span><span id="documents" class="documents" aria-label="Attached documents"></span></div>
            <textarea id="prompt" rows="2" maxlength="24000" aria-label="Message the room" aria-controls="menu" aria-expanded="false" aria-autocomplete="list" placeholder="Message the room — @ to mention, / for commands"></textarea>
            <div class="composer-bar"><div class="bar-left"><button type="button" class="icon-button" data-action="attachDocuments" aria-label="Attach documents" title="Attach documents: PDF, Word, images or text. They are read automatically (OCR for scans) and indexed for every agent.">${icon('plus')}</button><button type="button" class="icon-button" id="open-mention" aria-label="Mention an agent" title="Mention an agent (@)">${icon('at')}</button><button type="button" class="icon-button" id="open-slash" aria-label="Commands" title="Commands (/)">${icon('slash')}</button></div>
              <div class="bar-chips"><button type="button" class="chip" id="chip-team" data-pop="team" aria-haspopup="dialog" aria-expanded="false"></button><button type="button" class="chip" id="chip-loop" data-pop="loop" aria-haspopup="dialog" aria-expanded="false"></button><button type="button" class="chip" id="chip-perm" data-pop="perm" aria-haspopup="dialog" aria-expanded="false"></button><button type="button" class="chip" id="chip-effort" data-pop="effort" aria-haspopup="dialog" aria-expanded="false"></button><button type="button" class="chip toggle" id="chip-think" aria-pressed="false" aria-label="Think harder" title="${esc(THINK_TITLE)}">${icon('sparkle')}</button><button type="button" class="chip toggle" id="chip-ultra" aria-pressed="false" aria-label="Ultra" title="Ultra: agents orchestrate their own sub-agents for this message">${icon('bolt')}</button></div>
              <div class="bar-right"><button type="button" class="context-ring" id="context-ring" data-pop="context" aria-label="Context use" aria-expanded="false" hidden></button><button id="send" class="send-button" type="submit" aria-label="Send message">${icon('send')}</button></div></div></form></div>
        <footer id="runtime-status" class="runtime-status" role="status" aria-live="polite"></footer>
      </section>
      <aside id="inspector" class="inspector"><div class="inspector-header"><div class="tabs" role="tablist"><button data-tab="usage" role="tab">Usage</button><button data-tab="tools" role="tab">Tools</button><button data-tab="activity" role="tab">Activity</button></div><button class="icon-button small inspector-close" data-action="inspector" aria-label="Close inspector">${icon('close')}</button></div><div id="inspector-content" class="inspector-content"></div></aside>
    </main><div id="toast" class="toast" role="alert" hidden></div><div id="dialog-layer" class="dialog-layer" hidden></div>`;
  $('prompt').value = saved.draft || '';

  // ---- Model helpers -------------------------------------------------------------------------
  const busy = () => state?.room.status === 'running';
  const agentById = id => state?.room.agents.find(a => a.id === id);
  const enabledAgents = () => state.room.agents.filter(a => a.enabled);
  const caps = a => { const c = state.capabilities?.[a.id]; return c && { tools: [], skills: [], commands: [], mcpServers: [], models: [], efforts: [], ...c }; };
  const conn = a => state.connections.find(c => c.id === a.provider);
  const opts = a => ({ ...DEFAULT_OPTIONS, ...(a.options || {}) });
  const perm = a => opts(a).permission;
  // Codex sandbox: the override may only tighten what the permission level allows; Plan is always read-only.
  const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };
  const derivedSandbox = p => p === 'full' ? 'danger-full-access' : p === 'auto-edit' ? 'workspace-write' : 'read-only';
  const sandboxOf = o => { const d = derivedSandbox(o.permission); return o.permission !== 'plan' && SANDBOX_RANK[o.sandbox] < SANDBOX_RANK[d] ? o.sandbox : d; };
  const effortLabel = e => effortLabels[e] || e;
  const quoteName = name => /\s/.test(name) ? `@"${name}"` : '@' + name;
  function isNative(a) {
    if (a.provider === 'claude' || a.provider === 'codex') return true;
    if (a.provider !== 'copilot' || a.options?.copilotRuntime === 'vscode-lm') return false;
    const c = caps(a); return c ? c.runtime === 'cli' : conn(a)?.runtime === 'cli';
  }
  function supports(a, key) { if (!isNative(a)) return false; const s = caps(a)?.supports; return s ? !!s[key] : !!SUPPORT[a.provider]?.[key]; }
  function runtimeLabel(a) { return a.provider === 'claude' ? 'Claude Code' : a.provider === 'codex' ? 'Codex CLI' : a.provider === 'copilot' ? (isNative(a) ? 'GitHub Copilot CLI' : 'GitHub Copilot (VS Code chat model)') : 'Ollama (local model)'; }
  function modelsOf(a) { const list = caps(a)?.models; return list?.length ? list : conn(a)?.models || []; }
  function modelInfo(a, id) { const all = [...(caps(a)?.models || []), ...(conn(a)?.models || [])]; return id ? all.find(m => m.id === id) : all.find(m => m.isDefault); }
  function modelName(a) { return a.model ? modelInfo(a, a.model)?.name || a.model : 'default'; }
  function shortModel(a) { const m = modelName(a); return m.length > 18 ? m.slice(0, 17) + '…' : m; }
  function effortsOf(a, model = a.model) {
    if (!isNative(a)) return [];
    const m = model ? modelInfo(a, model) : undefined;
    if (m?.reasoning?.length) return m.reasoning;
    const c = caps(a)?.efforts; if (c?.length) return c;
    return modelInfo(a)?.reasoning || [];
  }
  function ctxOf(a) { const c = a.session?.context ?? caps(a)?.context; return c && typeof c.percent === 'number' ? c : undefined; }
  function leadOf(r) { return r.agents.find(a => a.id === r.leadId && a.enabled) || r.agents.find(a => a.enabled); }
  function needsSetup(a) { const c = caps(a); if (c) return ['missing', 'signed-out', 'error'].includes(c.status); const k = conn(a); return !k || ['missing', 'error'].includes(k.status); }
  function avatar(agent, extra = '') { const p = agent?.provider; return `<span class="avatar ${esc(p || 'ollama')} ${extra}" aria-hidden="true">${GLYPHS[p] || GLYPHS.ollama}</span>`; }
  // Replaces the markup only when it changed, and moves keyboard focus to the same control in the new markup.
  function setHtml(el, html) {
    if (!el || el._html === html) return;
    const a = document.activeElement, key = a !== el && el.contains(a) ? keyOf(a) : '';
    el._html = html; el.innerHTML = html;
    if (key && !el.contains(document.activeElement)) el.querySelector(key)?.focus({ preventScroll: true });
  }
  function keyOf(el) {
    if (!el || el === document.body) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.tagName === 'SUMMARY' && el.parentElement?.id) return '#' + CSS.escape(el.parentElement.id) + ' > summary';
    if (el.name) return `[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`;
    const [k, v] = Object.entries(el.dataset)[0] || [];
    return k ? `[data-${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${CSS.escape(v)}"]` : '';
  }

  // ---- Render --------------------------------------------------------------------------------
  function render() {
    if (!state) return;
    const r = state.room, running = busy();
    r.loop = { ...DEFAULT_LOOP, ...(r.loop || {}) };
    if (lastRoom !== r.id) { lastRoom = r.id; nearBottom = true; nodes.clear(); think = false; ultra = false; closePopover(); }
    if (droppedKey && state.editor?.key !== droppedKey) droppedKey = '';
    if (lastSent && r.messages.some(m => m.kind === 'user' && m.text === lastSent.text && m.createdAt >= lastSent.at - 5000)) lastSent = undefined;
    $('workspace').textContent = state.workspace || '';
    setHtml($('rooms'), state.rooms.map(x => `<option value="${esc(x.id)}" ${x.id === r.id ? 'selected' : ''}>${esc(x.title)}</option>`).join(''));
    $('rooms').disabled = running;
    $('room-status').textContent = running ? 'Conversation in progress' : r.status === 'paused' ? 'Conversation paused' : 'Ready when you are';
    $('room-status').className = `status-label ${r.status}`;
    $('conversation-title').textContent = r.title;
    $('turns').textContent = r.completedTurns ? `${r.completedTurns} turns` : '';
    renderStrip(); renderChips(); renderContextChips(); renderRunControls();
    const activeNames = r.agents.filter(a => (r.activeAgents || [r.currentAgent]).includes(a.id)).map(a => a.name);
    const failed = Object.values(r.agentStates || {}).filter(s => s.status === 'error').length;
    const modeText = r.mode === 'parallel' ? `Parallel (max ${r.concurrency || 3})` : r.mode === 'orchestrated' ? `Lead + team (max ${r.concurrency || 3} in parallel)` : 'Relay';
    const loopText = r.loopState && !r.loopState.stoppedReason && r.loop.kind !== 'once' ? ` · loop ${r.loopState.iteration}` : '';
    $('runtime-status').textContent = modeText + ' · ' + activeNames.length + ' running · ' + (r.queuedTurns || 0) + ' queued' + (failed ? ' · ' + failed + ' failed' : '') + loopText + (activeNames.length ? ' — ' + activeNames.join(', ') : '');
    $('prompt').placeholder = r.mode === 'orchestrated' ? `Message the team · ${leadOf(r)?.name || 'the lead'} leads — @ to mention, / for commands` : 'Message the room — @ to mention, / for commands';
    renderMessages(); renderPopover(); renderInspector(); refreshDialog();
    if (menu.open) openMenu(menu.kind, menu.query, menu.start, menu.end, false);
  }
  function statusOf(a) {
    if (!a.enabled) return 'off';
    const r = state.room, s = r.agentStates?.[a.id]?.status;
    if (s && s !== 'complete' && s !== 'stopped') return s;
    if ((r.activeAgents || [r.currentAgent]).includes(a.id)) return 'active';
    if (needsSetup(a)) return 'setup';
    return s || 'idle';
  }
  function stateLabel(a, s) {
    const detail = state.room.agentStates?.[a.id]?.detail;
    return ({ off: 'Off', thinking: 'Thinking…', active: 'Working…', tool: 'Using ' + (detail || 'a tool'), approval: 'Waiting for your approval', queued: 'Queued', complete: 'Done', error: 'Failed', stopped: 'Stopped', idle: 'Ready' })[s] || (s === 'setup' ? caps(a)?.detail || conn(a)?.detail || 'Setup needed' : s);
  }
  function renderStrip() {
    const r = state.room, lead = leadOf(r);
    $('team-strip').classList.toggle('team-mode', r.mode === 'orchestrated');
    setHtml($('team-pills'), r.agents.map(a => {
      const s = statusOf(a), isLead = lead?.id === a.id, native = isNative(a), effort = native ? opts(a).effort : '';
      const tip = [a.name, runtimeLabel(a), modelName(a), 'effort ' + (effort ? effortLabel(effort) : 'default'), native ? permLabels[perm(a)] + (supports(a, 'sandbox') ? ' (sandbox ' + sandboxOf(opts(a)) + ')' : '') : 'Read-only (Chatroom tools)', stateLabel(a, s)].join(' · ') + (isLead ? ' · lead' : '') + ' · click for settings';
      return `<button type="button" class="agent-pill status-${esc(s)}${isLead ? ' is-lead' : ''}${a.enabled ? '' : ' is-off'}" data-agent="${esc(a.id)}" aria-label="${esc(a.name)} settings" title="${esc(tip)}">${avatar(a, 'mini')}<span class="pill-name">${esc(a.name)}</span><span class="pill-meta">${esc(shortModel(a) + (effort ? ' · ' + effortLabel(effort) : ''))}</span>${isLead ? `<span class="lead-star">${icon('star')}</span>` : ''}<span class="pill-dot"></span></button>`;
    }).join('') || '<span class="strip-empty">No agents yet. Add one with +</span>');
  }
  function loopLabel(r) {
    const l = r.loop;
    if (l.kind === 'rounds') return `${l.rounds} rounds`;
    if (l.kind === 'consensus') return 'Until agree';
    if (l.kind === 'lead-done') return 'Until done';
    if (l.kind === 'interval') { const next = r.loopState?.nextAt; return `Every ${l.everyMinutes}m` + (next ? ' · ' + mmss(Math.max(0, Math.round((next - Date.now()) / 1000))) : ''); }
    return 'Once';
  }
  const CHIP_NAMES = { 'chip-team': 'Collaboration', 'chip-loop': 'Loop', 'chip-perm': 'Permissions', 'chip-effort': 'Effort' };
  function chip(id, iconName, label, title) { const el = $(id); setHtml(el, `${icon(iconName)}<span class="chip-label">${esc(label)}</span>`); el.title = title; el.setAttribute('aria-label', `${CHIP_NAMES[id]}: ${label}`); }
  function renderChips() {
    const r = state.room, enabled = enabledAgents(), natives = enabled.filter(isNative), lead = leadOf(r), running = busy();
    chip('chip-team', 'users', r.mode === 'orchestrated' ? `Team · ${lead?.name || 'no'} lead${lead ? 's' : ''}` : r.mode === 'parallel' ? 'Parallel' : 'Relay', `How agents work together: ${modeHelp[r.mode || 'sequential']} Click to change the mode or the lead.`);
    chip('chip-loop', 'loop', loopLabel(r), r.loopState?.stoppedReason ? `Loop stopped: ${r.loopState.stoppedReason}` : 'Repeat the room\'s work until a condition or limit');
    $('chip-loop').classList.toggle('muted', r.loop.kind === 'once');
    const perms = new Set(natives.map(perm)), level = perms.size === 1 ? [...perms][0] : '';
    chip('chip-perm', 'shield', !natives.length ? 'Read-only' : level ? permLabels[level] : 'Mixed', 'What agents may do without asking');
    $('chip-perm').classList.toggle('danger', perms.has('full'));
    const efforts = new Set(natives.filter(a => effortsOf(a).length).map(a => opts(a).effort)), effort = efforts.size === 1 ? [...efforts][0] : '';
    chip('chip-effort', 'gauge', effort ? effortLabel(effort) : 'Effort', 'Reasoning effort per agent');
    $('chip-effort').classList.toggle('muted', !effort);
    const canThink = enabled.some(a => supports(a, 'thinkHard')), canUltra = enabled.some(a => supports(a, 'ultraTurn'));
    if (!canThink) think = false;
    if (!canUltra) ultra = false;
    $('chip-think').disabled = !canThink; $('chip-ultra').disabled = !canUltra;
    $('chip-think').title = canThink ? THINK_TITLE : 'None of the agents in this room can think harder on demand';
    $('chip-ultra').title = canUltra ? 'Ultra: agents orchestrate their own sub-agents for this message' : 'None of the agents in this room supports Ultra';
    $('chip-think').setAttribute('aria-pressed', String(think)); $('chip-ultra').setAttribute('aria-pressed', String(ultra));
    const sendButton = $('send');
    setHtml(sendButton, icon(running ? 'stop' : 'send'));
    sendButton.setAttribute('aria-label', running ? 'Stop' : 'Send message');
    sendButton.title = running ? 'Stop all agents' : 'Send (Enter) · Shift+Enter for a new line';
    sendButton.classList.toggle('stop', running);
    renderRing();
  }
  function renderRing() {
    const ring = $('context-ring'), list = enabledAgents().map(a => [a, ctxOf(a)]).filter(([, c]) => c);
    ring.hidden = !list.length;
    if (!list.length) { if (pop === 'context') closePopover(); return; }
    const max = Math.min(100, Math.max(...list.map(([, c]) => c.percent))), C = 2 * Math.PI * 7, text = list.map(([a, c]) => `${a.name} ${Math.round(c.percent)}%`).join(' · ');
    ring.title = text; ring.setAttribute('aria-label', 'Context use: ' + text);
    ring.classList.toggle('warn', max >= 80);
    setHtml(ring, `<svg viewBox="0 0 18 18" aria-hidden="true"><circle class="ring-track" cx="9" cy="9" r="7"/><circle class="ring-value" cx="9" cy="9" r="7" stroke-dasharray="${(max / 100 * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 9 9)"/></svg>`);
  }
  function renderContextChips() {
    const ed = state.editor, on = state.room.attachEditor !== false, show = !!ed && droppedKey !== ed.key, docs = state.room.documents || [];
    setHtml($('editor-slot'), show ? editorChip(ed, on) : '');
    $('documents').hidden = !docs.length;
    setHtml($('documents'), docs.map(d => `<span class="doc-chip ${esc(d.status)}" title="${esc(d.name + (d.detail ? ' — ' + d.detail : d.status === 'ready' ? ` — ${d.chars.toLocaleString()} characters in ${d.chunks} passage${d.chunks === 1 ? '' : 's'}${d.embedded ? `, embedded with ${d.embedded}` : ''}` : ''))}">${icon('file')}<span class="doc-name">${esc(d.name.split(/[\\/]/).pop())}</span><span class="doc-status">${esc(docStatus(d))}</span><button type="button" class="doc-remove" data-remove-doc="${esc(d.id)}" aria-label="Remove ${esc(d.name)}">${icon('close')}</button></span>`).join(''));
    $('context-chips').hidden = !show && !docs.length;
  }
  function rangeOf(sel, long) { if (!sel) return ''; return sel.startLine === sel.endLine ? (long ? ` line ${sel.startLine}` : `L${sel.startLine}`) : (long ? ` lines ${sel.startLine}–${sel.endLine}` : `L${sel.startLine}–${sel.endLine}`); }
  function editorChip(ed, on) {
    const range = rangeOf(ed.selection), title = on ? `Sharing ${ed.relPath}${rangeOf(ed.selection, true)} with the agents · click to open` : `Not sharing ${ed.relPath} · turn on the eye to share it with your messages`;
    const eye = on ? 'Shared with every message. Click to stop sharing the open file' : 'Not shared. Click to send the open file with every message';
    return `<span id="editor-chip" class="ctx-chip editor${on ? '' : ' off'}"><button type="button" class="ctx-open" data-editor-action="reveal" title="${esc(title)}">${icon(ed.kind === 'image' ? 'image' : 'file')}<span class="ctx-name">${esc(ed.label + (ed.dirty ? ' •' : ''))}</span>${range ? `<span class="ctx-range">${range}</span>` : ''}</button><button type="button" class="ctx-eye" data-editor-action="toggle" aria-pressed="${on}" aria-label="Send the open file with messages" title="${eye}">${icon(on ? 'eye' : 'eyeClosed')}</button><button type="button" class="ctx-x" data-editor-action="drop" aria-label="Don't send with this message" title="${esc(on ? `Don't send ${ed.label} for now. The next file you open is shared again` : `Hide ${ed.label}`)}">${icon('close')}</button></span>`;
  }
  function docStatus(d) {
    if (d.status === 'error') return 'Failed';
    if (d.status !== 'ready') return d.detail || (d.status === 'embedding' ? 'Indexing…' : 'Reading…');
    return [d.pages ? `${d.pages} p.` : '', d.ocrPages ? `${d.ocrPages} OCR` : '', d.embedded ? 'indexed' : 'keyword search'].filter(Boolean).join(' · ');
  }
  const pendingApprovals = () => state.room.messages.filter(m => m.kind === 'approval' && m.approval?.status === 'pending');
  function renderRunControls() {
    const r = state.room, running = busy(), active = r.agents.filter(a => (r.activeAgents || [r.currentAgent]).includes(a.id)).length, n = pendingApprovals().length;
    const waiting = n ? `<button type="button" class="approval-pill" data-action="jump-approval" title="Show the request">${n} waiting for you</button>` : '';
    setHtml($('run-controls'), running
      ? `<span class="thinking"><i></i><i></i><i></i> ${active} active</span>${waiting}<button data-action="pause">${icon('pause')} Pause</button><button data-action="stop" class="stop-control">${icon('stop')} Stop</button>`
      : r.messages.length ? `<span>${r.status === 'paused' ? 'Take your time. Resume when ready.' : 'The floor is yours.'}</span>${waiting}<button data-action="start">${icon('play')} ${r.status === 'paused' ? 'Resume' : 'Continue round'}</button>` : waiting);
  }

  // ---- Messages ------------------------------------------------------------------------------
  const isOpen = (key, fallback) => openState.has(key) ? openState.get(key) : fallback;
  function signature(m) {
    const a = agentById(m.agentId), plan = m.step?.plan ? state.room.messages.find(p => p.id === m.step.plan)?.plan : undefined;
    const people = [...(m.targets || []), ...(m.handoff ? [m.handoff.from, ...m.handoff.to] : [])].map(id => agentById(id)?.name);
    return JSON.stringify([m, a?.name, a?.model, a?.provider, plan, people, m.plan ? state.room.agents.map(x => x.name + x.provider) : 0]);
  }
  function emptyHtml() {
    return `<div class="empty-state"><span class="empty-icon">${icon('logo')}</span><h2>Chat with your agents</h2><p>Claude Code, Codex and Copilot work here with their own tools, skills and sessions. Type <strong>@</strong> to talk to one agent and <strong>/</strong> for commands. Click an agent above to set its model, effort and permissions; <strong>Room setup</strong> chooses who takes part and who leads the team.</p><div class="suggestions"><button data-prompt="Look through this repository, then explain its architecture and suggest next steps.">Explain this repository ${icon('arrow')}</button><button data-prompt="Review this workspace for reliability issues. Split the review by area, read the relevant files, and challenge each other's findings.">Review the code as a team ${icon('arrow')}</button></div></div>`;
  }
  function renderMessages() {
    const container = $('messages'), messages = state.room.messages;
    if (!messages.length) { nodes.clear(); if (!container.querySelector('.empty-state')) container.innerHTML = emptyHtml(); return; }
    container.querySelector('.empty-state')?.remove();
    const oldScroll = container.scrollTop, wanted = [], used = new Set();
    messages.forEach((m, i) => {
      const key = used.has(m.id) ? `${m.id}#${i}` : m.id, sig = signature(m), cached = nodes.get(key);
      used.add(key);
      let node = cached?.sig === sig ? cached.node : undefined;
      if (!node) { node = buildMessage(m); nodes.set(key, { sig, node }); }
      wanted.push(node);
    });
    for (const key of [...nodes.keys()]) if (!used.has(key)) nodes.delete(key);
    wanted.forEach((node, i) => { const at = container.children[i]; if (at !== node) container.insertBefore(node, at || null); });
    while (container.children.length > wanted.length) container.lastElementChild.remove();
    container.scrollTop = nearBottom ? container.scrollHeight : oldScroll;
  }
  function buildMessage(m) {
    if (m.kind === 'tool') {
      const detail = document.createElement('details'); detail.className = 'tool-result'; detail.dataset.id = m.id; detail.open = isOpen(m.id, false);
      const summary = document.createElement('summary'); summary.textContent = `${toolLabels[m.author] || m.author} · tool result`;
      const pre = document.createElement('pre'); pre.textContent = m.text;
      detail.append(summary, pre); return detail;
    }
    if (m.kind === 'notice') return noticeNode(m);
    if (m.kind === 'approval') return approvalNode(m);
    return chatNode(m);
  }
  function noticeNode(m) {
    const div = document.createElement('div'), span = document.createElement('span');
    div.className = 'notice-line'; div.dataset.id = m.id; span.textContent = m.text; div.append(span);
    const action = /npm i(?:nstall)? -g @github\/copilot/.test(m.text) ? 'install' : /copilot login/.test(m.text) ? 'login' : '';
    if (action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'outline-button inline'; b.dataset.copilot = action; b.textContent = action === 'install' ? 'Install Copilot CLI' : 'Sign in to Copilot'; div.append(b); }
    return div;
  }
  function fillDiff(pre, text) {
    for (const line of String(text).split('\n').slice(0, 600)) {
      const span = document.createElement('span');
      span.className = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx';
      span.textContent = line + '\n'; pre.append(span);
    }
  }
  function approvalNode(m) {
    const ap = m.approval || { id: '', kind: 'other', tool: 'tool', title: m.text, status: 'expired', canAllowSession: false, expiresAt: 0 };
    const agent = agentById(m.agentId || ap.agentId), who = agent?.name || m.author, article = document.createElement('article');
    article.className = `message approval ${ap.status}`; article.dataset.id = m.id;
    const pending = ap.status === 'pending', id = esc(ap.id), left = Math.max(0, Math.round((ap.expiresAt - Date.now()) / 1000));
    article.innerHTML = `<div class="message-avatar">${avatar(agent || { provider: ap.provider })}</div><div class="approval-card" role="group" aria-label="${esc(who)} approval request"><div class="approval-head"><strong>${esc(who)}</strong> wants to ${esc(verbs[ap.kind] || `use ${ap.tool}`)}<span class="approval-tool">${esc(ap.tool)}</span></div><div class="approval-title">${esc(ap.title)}</div>${ap.detail || ap.diff ? '<pre class="approval-detail"></pre>' : ''}${pending
      ? `<div class="approval-actions"><button type="button" class="primary-button" data-approve="${id}" data-decision="allow" title="Allow once">Allow</button>${ap.canAllowSession ? `<button type="button" class="outline-button" data-approve="${id}" data-decision="allow-session" title="Allow this and similar requests for the rest of the session">Allow for session</button>` : ''}<button type="button" class="outline-button danger" data-approve="${id}" data-decision="deny">Deny</button><span class="approval-expiry" data-expires="${Number(ap.expiresAt) || 0}" title="Denied automatically when the time runs out">${mmss(left)} left</span></div>`
      : `<div class="approval-result">${esc(decided[ap.status] || ap.status)}${ap.decidedAt ? ' · ' + clock(ap.decidedAt) : ''}</div>`}</div>`;
    const pre = article.querySelector('.approval-detail');
    if (pre) { if (ap.detail) pre.append(document.createTextNode(ap.detail + (ap.diff ? '\n\n' : ''))); if (ap.diff) fillDiff(pre, ap.diff); }
    return article;
  }
  function markerOf(m) {
    if (m.kind !== 'agent') return undefined;
    if (m.marker) return m.marker;
    if (m.status === 'streaming') return undefined;
    return /\[(?:AGREE|CONSENSUS)\]\s*$/.test(m.text || '') ? 'agree' : /\[DONE\]\s*$/.test(m.text || '') ? 'done' : undefined;
  }
  function chatNode(m) {
    const r = state.room, agent = agentById(m.agentId), article = document.createElement('article'), streaming = m.status === 'streaming';
    const turnChip = ({ plan: 'Plan', step: `Step ${m.step?.id || ''}`, synthesis: 'Final answer', direct: '1:1', handoff: 'Hand-off', command: 'Command' })[m.turn] || '';
    const planMessage = m.step?.plan && r.messages.find(p => p.id === m.step.plan);
    const inputs = (m.step?.after || []).map(id => { const s = planMessage?.plan?.find(p => p.id === id); const a = s && agentById(s.agentId); return a ? `${a.name} (${id})` : id; });
    const marker = markerOf(m);
    let text = m.text || '';
    if (marker === 'agree') text = text.replace(/\s*\[(?:AGREE|CONSENSUS)\]\s*$/, '');
    if (marker === 'done') text = text.replace(/\s*\[DONE\]\s*$/, '');
    article.className = `message ${m.kind} ${m.status}${m.turn ? ` turn-${m.turn}` : ''}`; article.dataset.id = m.id;
    const who = m.kind === 'user' ? `<span class="avatar user-avatar">${m.author === 'Loop' ? icon('loop') : 'Y'}</span>` : avatar(agent || { provider: 'ollama' });
    article.innerHTML = `<div class="message-avatar">${who}</div><div class="message-main"><div class="message-heading"><strong>${esc(m.author)}</strong>${turnChip ? `<span class="turn-chip ${esc(m.turn)}">${esc(turnChip)}</span>` : ''}${m.handoff ? handoffChip(m) : ''}${agent ? `<span class="model-label">${esc(agent.model || names[agent.provider])}</span>` : m.kind === 'user' ? '<span class="model-label">You</span>' : ''}<time>${clock(m.createdAt)}</time></div>${m.step ? `<div class="step-task">${esc(m.step.task)}${inputs.length ? `<span class="builds-on"> · builds on ${esc(inputs.join(', '))}</span>` : ''}</div>` : ''}${m.thinking ? `<details class="thinking-block" data-id="${esc(m.id)}-t"${isOpen(m.id + '-t', streaming) ? ' open' : ''}><summary>Thinking</summary><div class="thinking-text"></div></details>` : ''}${m.activity?.length ? activityHtml(m) : ''}<div class="message-content"></div>${m.plan?.length ? renderPlan(m.plan, r.agents) : ''}${m.kind === 'user' ? userMeta(m) : ''}<div class="message-footer"></div></div>`;
    const thinking = article.querySelector('.thinking-text'); if (thinking) thinking.textContent = m.thinking;
    article.querySelectorAll('.act-diff').forEach(pre => fillDiff(pre, m.activity[Number(pre.dataset.diff)]?.diff || ''));
    const content = article.querySelector('.message-content');
    if (!text && streaming) content.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
    else markdown(content, text);
    const parts = [];
    if (m.usage) parts.push(`${m.usage.estimated ? '~' : ''}${fmt(m.usage.input + m.usage.output)} tokens${m.usage.cached ? ` · ${fmt(m.usage.cached)} cached` : ''}`);
    if (marker === 'agree') parts.push('agrees · nothing to add');
    if (marker === 'done') parts.push('marked done');
    if (m.status === 'cancelled' || m.status === 'error') parts.push(m.status);
    article.querySelector('.message-footer').textContent = streaming ? 'Responding…' : parts.join(' · ');
    return article;
  }
  function handoffChip(m) {
    const h = m.handoff, list = (h.to || []).map(id => '@' + (agentById(id)?.name || 'removed agent')).join(' ');
    if (!m.agentId || m.agentId === h.from) return `<span class="handoff-chip" title="Handed off to ${esc(list)}">→ ${esc(list)}</span>`;
    return `<span class="handoff-chip from" title="Asked by ${esc(agentById(h.from)?.name || 'an agent')}">← @${esc(agentById(h.from)?.name || 'agent')}</span>`;
  }
  function activityHtml(m) {
    const items = m.activity, last = items[items.length - 1], key = m.id + '-a';
    const summary = `${items.length} step${items.length === 1 ? '' : 's'}${last?.status === 'running' ? ' · ' + last.title : ''}`;
    return `<details class="activity-block" data-id="${esc(key)}"${isOpen(key, m.status === 'streaming') ? ' open' : ''}><summary>${esc(summary)}</summary><ol class="activity-steps">${items.map((it, i) => `<li class="act ${esc(it.kind)} ${esc(it.status)}" title="${esc(it.status)}"><span class="act-icon">${icon(actIcons[it.kind] || 'tool')}</span><span class="act-title">${esc(it.title)}</span><span class="act-detail">${esc(it.detail || '')}</span>${it.diff ? `<pre class="act-diff" data-diff="${i}"></pre>` : ''}</li>`).join('')}</ol></details>`;
  }
  function userMeta(m) {
    const parts = [];
    if (m.editor) { const range = rangeOf(m.editor.selection); parts.push(`<span class="ctx-chip readonly" title="${esc('Sent with ' + m.editor.relPath + rangeOf(m.editor.selection, true))}">${icon('file')}<span class="ctx-name">${esc(m.editor.label)}</span>${range ? `<span class="ctx-range">${range}</span>` : ''}</span>`); }
    if (m.flags?.think) parts.push(`<span class="flag-badge" title="Think harder">${icon('sparkle')}</span>`);
    if (m.flags?.ultra) parts.push(`<span class="flag-badge ultra" title="Ultra">${icon('bolt')}</span>`);
    if (m.targets?.length) parts.push(`<span class="msg-targets">to ${esc(m.targets.map(id => '@' + (agentById(id)?.name || 'removed agent')).join(', '))}</span>`);
    return parts.length ? `<div class="msg-meta">${parts.join('')}</div>` : '';
  }
  function renderPlan(steps, agents) {
    const level = {}, stages = [];
    for (const s of steps) { const value = Math.max(0, ...s.after.map(id => (level[id] ?? -1) + 1)); level[s.id] = value; (stages[value] ||= []).push(s); }
    const done = steps.filter(s => s.status === 'complete').length, groups = stages.filter(Boolean);
    return `<div class="plan-card" role="list" aria-label="Plan"><div class="plan-heading"><span>Plan</span><span class="subtle">${done}/${steps.length} steps · ${groups.length} stage${groups.length === 1 ? '' : 's'}</span></div>${groups.map((stage, index) => `<div class="plan-stage"><div class="plan-stage-label">Stage ${index + 1}${stage.length > 1 ? ' · in parallel' : ''}</div>${stage.map(s => {
      const a = agents.find(agent => agent.id === s.agentId);
      return `<div class="plan-step ${esc(s.status)}" role="listitem" title="${esc(s.detail || '')}"><span class="step-dot"></span><span class="step-id">${esc(s.id)}</span>${avatar(a || { provider: 'ollama' }, 'mini')}<div class="step-body"><div class="step-line"><strong>${esc(a?.name || 'Removed agent')}</strong><span class="step-status">${esc(stepLabels[s.status] || s.status)}</span></div><p>${esc(s.task)}</p>${s.after.length ? `<small>builds on ${s.after.map(esc).join(', ')}</small>` : ''}</div></div>`;
    }).join('')}</div>`).join('')}</div>`;
  }
  function markdown(parent, text) {
    const sections = text.split(/```/);
    sections.forEach((section, index) => {
      if (index % 2) {
        const newline = section.indexOf('\n'), pre = document.createElement('pre'), code = document.createElement('code');
        code.textContent = newline >= 0 ? section.slice(newline + 1).replace(/\n$/, '') : section;
        pre.append(code); parent.append(pre);
      } else {
        for (const block of section.split(/\n\s*\n/)) {
          if (!block.trim()) continue;
          const p = document.createElement(/^#{1,3} /.test(block) ? 'h3' : 'p');
          const clean = block.replace(/^#{1,3} /, '');
          for (const part of clean.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
            const node = document.createElement(part.startsWith('**') ? 'strong' : part.startsWith('`') ? 'code' : 'span');
            node.textContent = part.startsWith('**') ? part.slice(2, -2) : part.startsWith('`') ? part.slice(1, -1) : part;
            p.append(node);
          }
          parent.append(p);
        }
      }
    });
  }

  // ---- Composer popovers ---------------------------------------------------------------------
  function teamPop() {
    const r = state.room, dis = busy() ? ' disabled' : '', lead = leadOf(r), preset = r.preset || state.defaultPreset || 'planning';
    return `<div class="pop-title">How the agents work together</div><div class="radio-list" role="radiogroup" aria-label="Collaboration mode">${Object.keys(modeLabels).map(mode => `<label class="radio-row"><input type="radio" name="mode" value="${mode}" ${(r.mode || 'sequential') === mode ? 'checked' : ''}${dis}><span><strong>${modeLabels[mode]}</strong><small>${esc(modeHelp[mode])}</small></span></label>`).join('')}</div>`
      + `<label class="pop-field">Lead${r.mode === 'orchestrated' ? '' : ' <span class="subtle">for @lead and "Until done" loops</span>'}<select id="lead-select"${dis}>${enabledAgents().map(a => `<option value="${esc(a.id)}" ${lead?.id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>`
      + `<label class="pop-field">Model routing<select id="preset-select"${dis}>${['planning', 'drafting', 'review'].map(p => `<option value="${p}" ${preset === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>`
      + `<label class="pop-field">Parallel limit<select id="parallel-limit"${dis}>${[1, 2, 3, 4].map(n => `<option ${n === (r.concurrency || 3) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`
      + `<p class="fine-print">Start a line with @Name to talk to one agent. Agents hand work to each other the same way.${busy() ? ' Wait for the agents to finish to change these.' : ''}</p>`;
  }
  function loopPop() {
    const r = state.room, l = r.loop, dis = busy() ? ' disabled' : '', ls = r.loopState;
    const kinds = [['once', 'Once', 'One pass, then stop'], ['rounds', 'Rounds', 'A fixed number of passes'], ['consensus', 'Until agree', 'Until every agent ends with [AGREE]'], ['lead-done', 'Until done', `Until ${leadOf(r)?.name || 'the lead'} (the lead) ends with [DONE]`], ['interval', 'Every few minutes', 'Repeat on a timer']];
    const field = (forKinds, label, input) => `<label class="pop-field"${forKinds ? ` data-loop-for="${forKinds}"` : ''}>${label}${input}</label>`;
    return `<form id="loop-form"><div class="pop-title">Repeat the room's work</div><div class="radio-list" role="radiogroup" aria-label="Loop">${kinds.map(([k, label, help]) => `<label class="radio-row"><input type="radio" name="loop-kind" value="${k}" ${l.kind === k ? 'checked' : ''}${dis}><span><strong>${label}</strong><small>${esc(help)}</small></span></label>`).join('')}</div><div class="loop-fields">`
      + field('rounds', 'Rounds', `<input id="loop-rounds" type="number" min="1" max="50" value="${Number(l.rounds) || 2}"${dis}>`)
      + field('interval', 'Every (minutes)', `<input id="loop-every" type="number" min="1" max="1440" value="${Number(l.everyMinutes) || 10}"${dis}>`)
      + field('interval', 'Prompt <span class="subtle">empty = your latest message</span>', `<textarea id="loop-prompt" rows="2" maxlength="4000"${dis}>${esc(l.prompt || '')}</textarea>`)
      + field('consensus lead-done interval', 'Max iterations', `<input id="loop-max" type="number" min="1" max="50" value="${Number(l.maxIterations) || 5}"${dis}>`)
      + field('', 'Max minutes <span class="subtle">0 = none</span>', `<input id="loop-minutes" type="number" min="0" max="1440" value="${Number(l.maxMinutes) || 0}"${dis}>`)
      + field('', 'Max new tokens <span class="subtle">0 = none</span>', `<input id="loop-tokens" type="number" min="0" max="10000000" value="${Number(l.maxTokens) || 0}"${dis}>`)
      + `</div><p class="fine-print">Caps always apply. Stop ends any loop.${ls?.stoppedReason ? ' Last loop stopped: ' + esc(ls.stoppedReason) + '.' : ls ? ` Running: iteration ${ls.iteration}.` : ''}</p><div class="pop-actions"><button type="submit" class="primary-button"${dis}>Done</button></div></form>`;
  }
  function permPop() {
    const enabled = enabledAgents(), natives = enabled.filter(isNative), perms = new Set(natives.map(perm)), current = perms.size === 1 ? [...perms][0] : '', allow = !!state.settings?.allowFullAccess, running = busy();
    return `<div class="pop-title">What agents may do without asking</div>${['plan', 'ask', 'auto-edit', 'full'].map(p => {
      const off = running || !natives.length || (p === 'full' && !allow);
      return `<button type="button" class="perm-option${p === 'full' ? ' full' : ''}" data-perm="${p}" aria-pressed="${current === p}"${off ? ' disabled' : ''}${p === 'full' && !allow ? ' title="Enable chatroom.allowFullAccess in Settings"' : ''}><strong>${permLabels[p]}</strong><small>${esc(permHelp[p])}</small></button>`;
    }).join('')}<p class="fine-print">${natives.length ? 'Applies to every agent in the room. Set one agent\'s level in its settings.' : 'Only chat-model agents are in this room.'}${enabled.length > natives.length ? ' Chat-model agents stay read-only (Chatroom tools).' : ''}</p>${allow ? '' : '<p class="fine-print">Full access is off. <button type="button" class="text-button link" data-action="settings">Open Settings</button> and enable chatroom.allowFullAccess to use it.</p>'}`;
  }
  function effortPop() {
    return `<div class="pop-title">Reasoning effort</div>${enabledAgents().map(a => {
      const list = effortsOf(a), o = opts(a), head = `${avatar(a, 'mini')}<span class="effort-name">${esc(a.name)}</span>`;
      if (!isNative(a)) return `<div class="effort-row">${head}<span class="subtle">Not adjustable</span></div>`;
      const values = list.includes(o.effort) || !o.effort ? list : [...list, o.effort];
      const select = values.length ? `<select data-effort-agent="${esc(a.id)}" aria-label="${esc(a.name)} effort"><option value="">Default</option>${values.map(e => `<option value="${esc(e)}" ${o.effort === e ? 'selected' : ''}>${esc(effortLabel(e))}</option>`).join('')}</select>` : '<span class="subtle">Default</span>';
      return `<div class="effort-row">${head}${select}${supports(a, 'thinking') ? `<label class="switch"><input type="checkbox" data-thinking-agent="${esc(a.id)}" ${o.thinking !== 'off' ? 'checked' : ''}> Thinking</label>` : ''}</div>`;
    }).join('') || '<p class="fine-print">No agents are enabled.</p>'}<p class="fine-print">Higher effort thinks longer and uses more tokens. The sparkle button raises it for one message.</p>`;
  }
  function contextPop() {
    const running = busy() ? ' disabled' : '', rows = enabledAgents().filter(a => ctxOf(a));
    return `<div class="pop-title">Context use</div>${rows.map(a => { const c = ctxOf(a); return `<div class="ctx-row">${avatar(a, 'mini')}<span class="effort-name">${esc(a.name)}</span><progress max="100" value="${Math.min(100, Math.max(0, c.percent))}"></progress><span class="subtle">${Math.round(c.percent)}%</span><button type="button" class="text-button" data-compact="${esc(a.id)}"${running}>Compact</button></div>${c.window ? `<div class="fine-print ctx-sub">${fmt(c.tokens)} of ${fmt(c.window)} tokens</div>` : ''}`; }).join('')}<div class="pop-actions"><button type="button" class="outline-button" data-compact=""${running}>${icon('compress')} Compact all</button></div><p class="fine-print">Compacting summarizes an agent's session to free context.</p>`;
  }
  const POPS = { team: teamPop, loop: loopPop, perm: permPop, effort: effortPop, context: contextPop };
  const POP_LABELS = { team: 'Team and lead', loop: 'Loop', perm: 'Permissions', effort: 'Effort', context: 'Context use' };
  function renderPopover(force = false) {
    const el = $('popover');
    if (!pop || !state) { el.hidden = true; return; }
    const html = POPS[pop]?.() ?? '', active = document.activeElement, inside = el.contains(active);
    if (!force && html === popHtml) return;
    if (!force && inside && (active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || (active.tagName === 'INPUT' && !['radio', 'checkbox'].includes(active.type)))) return;
    const key = inside ? keyOf(active) : '';
    popHtml = html; el.innerHTML = html; el.hidden = false;
    if (pop === 'loop') updateLoopFields();
    if (key) el.querySelector(key)?.focus();
    placePopover();
  }
  function placePopover() {
    const el = $('popover'), anchor = popAnchor?.getBoundingClientRect(), wrap = el.parentElement.getBoundingClientRect();
    if (!anchor) return;
    el.style.left = Math.max(8, Math.min(anchor.left - wrap.left, wrap.width - el.offsetWidth - 8)) + 'px';
  }
  function togglePopover(kind, anchor) {
    if (pop === kind) { closePopover(true); return; }
    closeMenu(); pop = kind; popAnchor = anchor; popHtml = '';
    document.querySelectorAll('[data-pop]').forEach(b => b.setAttribute('aria-expanded', String(b === anchor)));
    $('popover').setAttribute('aria-label', POP_LABELS[kind] || kind);
    renderPopover(true);
    const el = $('popover');
    (el.querySelector('input:checked:not(:disabled),input:not(:disabled):not([type=radio]),select:not(:disabled),button:not(:disabled),textarea:not(:disabled)') || el).focus();
  }
  function closePopover(refocus = false) {
    if (!pop) return;
    const anchor = popAnchor; pop = ''; popHtml = ''; popAnchor = undefined;
    $('popover').hidden = true; $('popover').replaceChildren();
    document.querySelectorAll('[data-pop]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    if (refocus) anchor?.focus();
  }
  function updateLoopFields() {
    const kind = document.querySelector('input[name="loop-kind"]:checked')?.value || 'once';
    document.querySelectorAll('[data-loop-for]').forEach(el => { el.hidden = !el.dataset.loopFor.split(' ').includes(kind); });
  }
  // Applies on every change, like the other chips; Done (or Enter) also closes the popover.
  function saveLoop(close = true) {
    const kind = document.querySelector('input[name="loop-kind"]:checked')?.value || 'once';
    const num = (id, lo, hi, fallback) => { const n = Math.round(Number($(id)?.value)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
    const loop = { kind, rounds: num('loop-rounds', 1, 50, 2), everyMinutes: num('loop-every', 1, 1440, 10), maxIterations: num('loop-max', 1, 50, 5), maxTokens: num('loop-tokens', 0, 10000000, 0) };
    // Send the minute cap only when the user changed it, so the host can drop a default cap that would cut an interval loop short.
    const minutes = num('loop-minutes', 0, 1440, 0);
    if (minutes !== (Number(state.room.loop?.maxMinutes) || 0)) loop.maxMinutes = minutes;
    if (kind === 'interval') loop.prompt = ($('loop-prompt')?.value || '').trim();
    send('options', { loop }); if (close) closePopover(true);
  }

  // ---- Confirm -------------------------------------------------------------------------------
  function confirmBox(text, ok) {
    return new Promise(resolve => {
      confirmClose?.();
      const layer = document.createElement('div'), previous = document.activeElement;
      layer.className = 'confirm-layer';
      layer.innerHTML = `<section class="dialog confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-text"><p id="confirm-text">${esc(text)}</p><div class="dialog-actions"><button type="button" class="text-button" data-confirm="no">Cancel</button><button type="button" class="primary-button" data-confirm="yes">${esc(ok)}</button></div></section>`;
      const done = value => { layer.remove(); confirmClose = undefined; previous?.focus?.(); resolve(value); };
      layer.addEventListener('click', event => {
        const button = event.target.closest('[data-confirm]');
        if (button || event.target === layer) { event.stopPropagation(); done(button?.dataset.confirm === 'yes'); }
      });
      confirmClose = () => done(false);
      $('app').append(layer); layer.querySelector('[data-confirm="no"]').focus();
    });
  }
  function confirmUltra() {
    const id = state.room.id;
    if (ultraConfirmed[id]) return Promise.resolve(true);
    return confirmBox(ULTRA_TEXT, 'Turn on Ultra').then(ok => { if (ok) { ultraConfirmed[id] = true; saveDraft(); } return ok; });
  }

  // ---- Slash and mention menu ----------------------------------------------------------------
  function mentionedAgents(text) {
    const out = [], re = /(^|[\s(\[,;])@("([^"]+)"|[A-Za-z0-9_.-]+)/g, enabled = enabledAgents();
    let m;
    while ((m = re.exec(text))) {
      const token = (m[3] ?? m[2].replace(/[.,:;!?)]+$/, '')).toLowerCase();
      let found = enabled.find(a => a.name.toLowerCase() === token);
      if (!found && token === 'lead') found = leadOf(state.room);
      if (!found) { const same = enabled.filter(a => a.provider === token || names[a.provider].toLowerCase() === token); if (same.length === 1) found = same[0]; }
      if (found && !out.includes(found)) out.push(found);
    }
    return out;
  }
  // Name prefix beats name substring beats alias beats description, so "/st" selects /status and never /clear ("Start fresh…").
  // Each agent group is capped on its own, so a long list never hides the groups after it.
  function slashItems(query, start) {
    const q = query.toLowerCase(), mentioned = mentionedAgents($('prompt').value.slice(0, start)), items = [], limit = q || mentioned.length ? 80 : 12;
    const has = s => String(s).toLowerCase().includes(q);
    const rank = c => { const n = c.name.toLowerCase(); return !q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : (c.aliases || []).some(has) ? 2 : has(c.description || '') ? 3 : -1; };
    const ranked = list => list.map(c => [c, rank(c)]).filter(([, r]) => r >= 0).sort((x, y) => x[1] - y[1]);
    for (const [c, r] of ranked((state.roomCommands || []).filter(c => !mentioned.length || c.agentScoped))) items.push({ group: 'Chatroom', insert: `/${c.name} `, name: '/' + c.name, hint: c.args || '', desc: c.description, agent: '', rank: r });
    for (const a of (mentioned.length ? mentioned : enabledAgents()).filter(isNative)) {
      const list = ranked(caps(a)?.commands || []), group = `${a.name} · ${runtimeLabel(a)}` + (list.length > limit ? ` · ${limit} of ${list.length}, type to filter` : '');
      for (const [c, r] of list.slice(0, limit)) items.push({ group, insert: `/${c.name} `, name: '/' + c.name, hint: c.argumentHint || '', desc: c.description || (c.source === 'skill' ? 'Skill' : ''), agent: a.id, rank: r });
    }
    return items;
  }
  function mentionItems(query) {
    const q = query.toLowerCase(), items = [], r = state.room, lead = leadOf(r);
    if ('all'.startsWith(q)) items.push({ insert: '@all ', name: '@all', desc: 'Everyone, using the room mode' });
    if (r.mode === 'orchestrated' && lead && 'lead'.startsWith(q)) items.push({ insert: '@lead ', name: '@lead', desc: `${lead.name} · the lead` });
    for (const a of enabledAgents()) if (a.name.toLowerCase().split(/[\s._-]+/).some(w => w.startsWith(q)) || a.name.toLowerCase().startsWith(q) || a.provider.startsWith(q)) items.push({ insert: quoteName(a.name) + ' ', name: a.name, desc: `${modelName(a)} · ${runtimeLabel(a)}`, avatar: avatar(a, 'mini'), agent: a.id });
    return items;
  }
  function detectMenu() {
    const p = $('prompt');
    if (!state || p.selectionStart !== p.selectionEnd) { closeMenu(); return; }
    const caret = p.selectionStart, before = p.value.slice(0, caret);
    let m = before.match(/^\s*(?:@(?:"[^"]+"|\S+)[\s,]+)*\/([\w:.-]*)$/);
    if (m) { openMenu('slash', m[1], caret - m[1].length - 1, caret); return; }
    m = before.match(/(^|[\s(\[,;])@([A-Za-z0-9_.-]*)$/);
    if (m) { openMenu('mention', m[2], caret - m[2].length - 1, caret); return; }
    closeMenu();
  }
  // reveal = false for state broadcasts: the menu keeps its scroll position while agents stream.
  function openMenu(kind, query, start, end, reveal = true) {
    const items = kind === 'slash' ? slashItems(query, start) : mentionItems(query);
    if (!items.length) { closeMenu(); return; }
    if (!menu.open || menu.kind !== kind || menu.query !== query) { const best = Math.min(...items.map(i => i.rank ?? 0)); menu.index = Math.max(0, items.findIndex(i => (i.rank ?? 0) === best)); }
    Object.assign(menu, { open: true, kind, query, start, end, items });
    menu.index = Math.min(menu.index, items.length - 1);
    if (pop) closePopover();
    renderMenu(reveal);
  }
  function renderMenu(reveal = true) {
    let html = '', group;
    menu.items.forEach((it, i) => {
      if (it.group && it.group !== group) { group = it.group; html += `<div class="menu-group" role="presentation">${esc(group)}</div>`; }
      html += `<div class="menu-item" role="option" id="mi-${i}" data-index="${i}" data-insert="${esc(it.insert)}" data-agent="${esc(it.agent || '')}" title="${esc([it.name, it.hint, it.desc].filter(Boolean).join(' '))}" aria-selected="${i === menu.index}">${it.avatar || ''}<span class="menu-name">${esc(it.name)}</span>${menu.kind === 'slash' ? `<span class="menu-hint">${esc(it.hint)}</span>` : ''}<span class="menu-desc">${esc(it.desc || '')}</span></div>`;
    });
    const el = $('menu'), sig = menu.index + '|' + html;
    if (el._sig !== sig) { const top = el.scrollTop; el.innerHTML = html; el.scrollTop = top; el._sig = sig; }
    el.hidden = false;
    $('prompt').setAttribute('aria-expanded', 'true'); $('prompt').setAttribute('aria-activedescendant', 'mi-' + menu.index);
    if (reveal) el.querySelector('#mi-' + menu.index)?.scrollIntoView({ block: 'nearest' });
  }
  function moveMenu(delta) { menu.index = (menu.index + delta + menu.items.length) % menu.items.length; renderMenu(); }
  function closeMenu() {
    if (!menu.open) return;
    menu.open = false; $('menu').hidden = true; $('menu').replaceChildren(); $('menu')._sig = '';
    $('prompt').setAttribute('aria-expanded', 'false'); $('prompt').removeAttribute('aria-activedescendant');
  }
  function acceptMenu(index = menu.index) {
    const item = menu.items[index], p = $('prompt'); if (!item) return;
    const before = p.value.slice(0, menu.start);
    let after = p.value.slice(menu.end).replace(menu.kind === 'slash' ? /^[\w:.-]*/ : /^[A-Za-z0-9_.-]*/, ''), insert = item.insert, prefix = '';
    if (/^\s/.test(after)) insert = insert.trimEnd();
    if (menu.kind === 'slash' && item.agent && !mentionedAgents(before).some(a => a.id === item.agent)) prefix = quoteName(agentById(item.agent)?.name || '') + ' ';
    p.value = prefix + before + insert + after;
    const caret = (prefix + before + insert).length;
    closeMenu(); p.focus(); p.setSelectionRange(caret, caret); autoGrow(); saveDraft();
  }
  function insertSlash() {
    const p = $('prompt'), lead = p.value.match(/^\s*(?:@(?:"[^"]+"|\S+)[\s,]+)*/)[0], rest = p.value.slice(lead.length);
    if (!rest.startsWith('/')) p.value = lead + '/' + (rest ? ' ' + rest : '');
    const caret = lead.length + 1 + (rest.startsWith('/') ? (rest.slice(1).match(/^[\w:.-]*/)[0].length) : 0);
    p.focus(); p.setSelectionRange(caret, caret); autoGrow(); saveDraft(); detectMenu();
  }
  function insertMention() {
    const p = $('prompt'), s = p.selectionStart, e = p.selectionEnd, pre = p.value.slice(0, s), ins = (pre && !/[\s(\[,;]$/.test(pre) ? ' ' : '') + '@';
    p.value = pre + ins + p.value.slice(e);
    p.focus(); p.setSelectionRange(s + ins.length, s + ins.length); autoGrow(); saveDraft(); detectMenu();
  }

  // ---- Dialogs -------------------------------------------------------------------------------
  function openDialog(html, kind = '') {
    const layer = $('dialog-layer');
    if (layer.hidden) { returnFocus = document.activeElement; returnKey = keyOf(returnFocus); }
    closePopover(); closeMenu();
    dialogKind = kind; dialogDirty = false; dialogHtml = html;
    layer.hidden = false; layer.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">${html}</section>`;
    (layer.querySelector('[data-autofocus]') || layer.querySelector('input,select,button,textarea'))?.focus();
  }
  function closeDialog() { if ($('dialog-layer').hidden) return; $('dialog-layer').hidden = true; $('dialog-layer').replaceChildren(); editing = undefined; dialogKind = ''; (returnFocus?.isConnected ? returnFocus : returnKey && document.querySelector(returnKey))?.focus?.(); }
  function rerenderDialog(html) {
    const box = $('dialog-layer').querySelector('.dialog'); if (!box) return;
    const scroll = box.scrollTop, active = document.activeElement, key = box.contains(active) ? keyOf(active) : '', advanced = box.querySelector('details.advanced')?.open;
    dialogHtml = html; box.innerHTML = html; box.scrollTop = scroll;
    if (advanced) { const d = box.querySelector('details.advanced'); if (d) d.open = true; }
    if (key) box.querySelector(key)?.focus();
  }
  function refreshDialog() {
    if ($('dialog-layer').hidden) return;
    if (dialogKind === 'agent') {
      const a = agentById(editing); if (!a) { closeDialog(); return; }
      if (!dialogDirty) { const html = agentDialog(a); if (html !== dialogHtml) rerenderDialog(html); }
      else setHtml($('agent-session'), sessionHtml(a));
    } else if (dialogKind === 'setup') { const html = setupDialog(); if (html !== dialogHtml) rerenderDialog(html); }
  }
  function agentModelOptions(a, selected) {
    const models = modelsOf(a);
    return '<option value="">Automatic / client default</option>' + (selected && !models.some(m => m.id === selected) ? `<option value="${esc(selected)}" selected>${esc(selected)} (saved)</option>` : '') + models.map(m => `<option value="${esc(m.id)}" ${selected === m.id ? 'selected' : ''} title="${esc(m.description || '')}">${esc(m.name)}${m.remote ? ' · cloud' : ''}</option>`).join('');
  }
  function sandboxOptions(permission, selected) {
    const derived = permission === 'plan' ? 'read-only' : derivedSandbox(permission), max = SANDBOX_RANK[derived];
    return `<option value="">From permissions (${derived})</option>` + Object.keys(SANDBOX_RANK).filter(s => SANDBOX_RANK[s] < max).map(s => `<option value="${s}" ${selected === s ? 'selected' : ''}>${s}</option>`).join('');
  }
  function effortOptions(list, selected) { return '<option value="">Default</option>' + list.map(e => `<option value="${esc(e)}" ${selected === e ? 'selected' : ''}>${esc(effortLabel(e))}</option>`).join(''); }
  function capsLine(a) {
    const c = caps(a);
    if (!c) return 'Capabilities load when the agent connects.';
    if (c.status !== 'ready') return c.detail || `Status: ${c.status}`;
    return `${c.tools.length} tools · ${c.skills.length} skills · ${c.mcpServers.length} MCP servers · ${c.commands.length} commands`;
  }
  function sessionHtml(a) {
    if (!isNative(a)) return `<div class="section-heading">SESSION</div><p class="fine-print">Chat models have no native session. Chatroom sends the recent conversation with each turn.</p>`;
    const sid = a.session?.id, ctx = ctxOf(a);
    return `<div class="section-heading">SESSION</div><p class="session-line">${sid ? `Session ${esc(sid.slice(0, 8))}${ctx ? ` · ${Math.round(ctx.percent)}% context` : ''}` : 'No session yet'}</p><div class="session-actions"><button type="button" class="outline-button" data-session="new" title="Forget the native session; the agent starts fresh from here">New session</button><button type="button" class="outline-button" data-session="copyResume"${sid ? '' : ' disabled'} title="Copy a command that opens this session in a terminal">Copy resume command</button><button type="button" class="outline-button" data-caps-refresh="${esc(a.id)}">${icon('refresh')} Refresh</button></div><p class="fine-print caps-line">${esc(capsLine(a))}</p>`;
  }
  function agentDialog(a) {
    const o = opts(a), native = isNative(a), c = caps(a), running = busy(), sup = key => supports(a, key), allow = !!state.settings?.allowFullAccess;
    const version = c?.version || conn(a)?.version || '', efforts = effortsOf(a);
    const runtime = a.provider === 'copilot' && !native ? `GitHub Copilot via VS Code models (chat only) <button type="button" class="text-button link" data-copilot="install">Install Copilot CLI</button>` : esc(`${runtimeLabel(a)} ${version}`.trim()) + (c?.account ? ` · ${esc(c.account)}` : '');
    const check = (id, key, label, checked) => `<label class="check-row"${sup(key) ? '' : ' title="Not supported by this CLI"'}><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}${sup(key) ? '' : ' disabled'}><span>${label}</span></label>`;
    const runtimeSelect = a.provider === 'copilot' ? `<label>Copilot runtime<select id="agent-copilot-runtime">${[['auto', 'Automatic (CLI when installed)'], ['cli', 'Copilot CLI'], ['vscode-lm', 'VS Code chat model']].map(([v, l]) => `<option value="${v}" ${(o.copilotRuntime || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : '';
    const web = o.webSearch === undefined ? '' : o.webSearch ? 'live' : 'off';
    const advanced = native ? `<details class="advanced" id="agent-advanced"><summary>Advanced</summary>`
      + (sup('sandbox') ? `<label>Sandbox <span class="subtle">can only tighten the permission level</span><select id="agent-sandbox">${sandboxOptions(o.permission, o.sandbox)}</select></label>` : '')
      + `<label${sup('webSearch') ? '' : ' title="Not supported by this CLI"'}>Web search<select id="agent-websearch"${sup('webSearch') ? '' : ' disabled'}><option value="">Default</option><option value="off" ${web === 'off' ? 'selected' : ''}>Off</option>${a.provider === 'codex' ? `<option value="live" ${web === 'live' ? 'selected' : ''}>Live</option>` : ''}</select></label>`
      + check('agent-use-mcp', 'useMcp', 'Use my MCP servers', o.useMcp) + check('agent-use-skills', 'useSkills', 'Use skills and slash commands', o.useSkills) + check('agent-use-project', 'useProjectSettings', 'Use project settings (CLAUDE.md, AGENTS.md, hooks)', o.useProjectSettings)
      + (sup('ultraSession') ? `<label class="check-row"><input type="checkbox" id="agent-ultra" ${o.ultra ? 'checked' : ''}><span>Always use Ultra (session)</span></label>` : '')
      + `<label>Extra folders <span class="subtle">one absolute path per line</span><textarea id="agent-dirs" rows="2" maxlength="4000" placeholder="C:\\path\\to\\folder">${esc((o.extraDirs || []).join('\n'))}</textarea></label>`
      + runtimeSelect + `</details>` : runtimeSelect;
    const lead = leadOf(state.room)?.id === a.id;
    const leadControl = a.enabled ? `<p class="lead-line">${lead ? `${icon('star')} Leads this room${state.room.mode === 'orchestrated' ? '' : ' (used for @lead and "Until done" loops)'}` : `<button type="button" class="text-button link" data-make-lead="${esc(a.id)}"${running ? ' disabled' : ''}>Make ${esc(a.name)} the lead</button>`}</p>` : '';
    return `<div class="dialog-heading">${avatar(a)}<div class="dialog-heading-text"><h2 id="dialog-title">Agent settings</h2><p class="runtime-line">${runtime}</p></div><label class="switch" title="Take part in this room"><input type="checkbox" id="agent-enabled" role="switch" aria-label="${esc(a.name)} takes part" ${a.enabled ? 'checked' : ''}></label><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div>`
      + leadControl + `<form id="agent-form"><label>Display name<input id="agent-name" maxlength="40" value="${esc(a.name)}" data-autofocus></label>`
      + `<div class="field-row"><label>Model<select id="agent-model">${agentModelOptions(a, a.model)}</select></label><label id="effort-field"${efforts.length ? '' : ' hidden'}>Effort<select id="agent-effort">${effortOptions(efforts, o.effort)}</select></label></div>`
      + (sup('thinking') ? `<label class="check-row"><input type="checkbox" id="agent-thinking" ${o.thinking !== 'off' ? 'checked' : ''}><span>Extended thinking</span></label>` : '')
      + (sup('summary') ? `<label>Reasoning summary<select id="agent-summary">${['auto', 'concise', 'detailed', 'none'].map(s => `<option value="${s}" ${o.summary === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label>` : '')
      + (native ? `<label>Permissions<select id="agent-permission">${['plan', 'ask', 'auto-edit', 'full'].map(p => `<option value="${p}" ${o.permission === p ? 'selected' : ''}${p === 'full' && !allow ? ' disabled' : ''}>${permLabels[p]} — ${permHelp[p]}</option>`).join('')}</select>${allow ? '' : '<small class="field-help">Full access needs chatroom.allowFullAccess in Settings.</small>'}</label>` : '<p class="field-help">Read-only (Chatroom tools)</p>')
      + advanced
      + `<label>Focus <span class="subtle">optional role</span><textarea id="agent-role" rows="2" maxlength="1600" placeholder="Optional. Leave empty and the agent is simply itself.">${esc(a.role)}</textarea></label>`
      + (native ? '' : `<div class="section-heading dialog-tools-heading">CHATROOM TOOLS</div>${Object.keys(toolLabels).map(t => `<label class="tool-checkbox"><input type="checkbox" name="tool" value="${t}" ${a.tools.includes(t) ? 'checked' : ''}><span><strong>${toolLabels[t]}</strong><small>${toolDescriptions[t]}</small></span></label>`).join('')}`)
      + `<div id="agent-session" class="session-section">${sessionHtml(a)}</div>`
      + (running ? '<p class="fine-print">Changes apply from this agent\'s next turn.</p>' : '')
      + `<div class="dialog-actions"><button type="button" class="text-button danger" data-remove="${esc(a.id)}"${running ? ' disabled' : ''}>Remove agent</button><button type="submit" class="primary-button">Save agent</button></div></form>`;
  }
  function editAgent(id) {
    const a = agentById(id); if (!a) return;
    const c = caps(a);
    if ((!c || Date.now() - (c.updatedAt || 0) > 300000) && Date.now() - (capsAsked[id] || 0) > 30000) { capsAsked[id] = Date.now(); send('capabilities', { id }); }
    editing = id; openDialog(agentDialog(a), 'agent');
  }
  function saveAgent() {
    const a = agentById(editing); if (!a) { closeDialog(); return; }
    const value = id => $(id)?.value, usable = id => $(id) && !$(id).disabled, options = {};
    if ($('agent-effort')) options.effort = $('effort-field').hidden ? '' : value('agent-effort');
    if ($('agent-thinking')) options.thinking = $('agent-thinking').checked ? 'on' : 'off';
    if ($('agent-summary')) options.summary = value('agent-summary');
    if ($('agent-permission')) options.permission = value('agent-permission');
    if ($('agent-sandbox')) options.sandbox = value('agent-sandbox');
    if (usable('agent-websearch')) options.webSearch = value('agent-websearch') ? value('agent-websearch') === 'live' : null;
    if (usable('agent-use-mcp')) options.useMcp = $('agent-use-mcp').checked;
    if (usable('agent-use-skills')) options.useSkills = $('agent-use-skills').checked;
    if (usable('agent-use-project')) options.useProjectSettings = $('agent-use-project').checked;
    if ($('agent-ultra')) options.ultra = $('agent-ultra').checked;
    if ($('agent-dirs')) options.extraDirs = $('agent-dirs').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 10);
    if ($('agent-copilot-runtime')) options.copilotRuntime = value('agent-copilot-runtime');
    send('agent', { id: a.id, name: value('agent-name'), model: value('agent-model'), role: value('agent-role'), enabled: $('agent-enabled').checked,
      ...(isNative(a) ? {} : { tools: [...document.querySelectorAll('input[name="tool"]:checked')].map(el => el.value) }), options });
    closeDialog();
  }
  function setupDialog() {
    const r = state.room, lead = leadOf(r), dis = busy() ? ' disabled' : '', preset = r.preset || state.defaultPreset || 'planning';
    return `<div class="dialog-heading"><div><h2 id="dialog-title">Room setup</h2><p>Who is in this room, who leads, and how they work together.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div>`
      + `<div class="section-heading">AGENTS <span class="subtle">star = lead</span></div><div class="setup-roster">${r.agents.map(a => `<div class="setup-agent${a.enabled ? '' : ' is-off'}"><label class="lead-radio" title="Make ${esc(a.name)} the lead"><input type="radio" name="setup-lead" value="${esc(a.id)}" aria-label="${esc(a.name)} leads" ${lead?.id === a.id ? 'checked' : ''}${a.enabled && !busy() ? '' : ' disabled'}>${icon('star')}</label>${avatar(a)}<div class="setup-agent-text"><strong>${esc(a.name)}</strong><small>${esc(runtimeLabel(a))} · ${esc(shortModel(a))} · ${isNative(a) ? permLabels[perm(a)] : 'Read-only'}</small></div><label class="switch" title="Take part in this room"><input type="checkbox" role="switch" data-enable-agent="${esc(a.id)}" aria-label="${esc(a.name)} takes part" ${a.enabled ? 'checked' : ''}></label><button type="button" class="icon-button small" data-edit="${esc(a.id)}" aria-label="${esc(a.name)} settings">${icon('settings')}</button></div>`).join('') || '<p class="fine-print">No agents yet.</p>'}</div>`
      + `<button type="button" class="outline-button" data-action="add">${icon('plus')} Add agent</button>`
      + `<div class="section-heading setup-heading">HOW THEY WORK TOGETHER</div><div class="radio-list">${Object.keys(modeLabels).map(mode => `<label class="radio-row"><input type="radio" name="setup-mode" value="${mode}" ${(r.mode || 'sequential') === mode ? 'checked' : ''}${dis}><span><strong>${modeLabels[mode]}</strong><small>${esc(modeHelp[mode])}</small></span></label>`).join('')}</div>`
      + `<label>Model routing<select id="setup-preset"${dis}>${['planning', 'drafting', 'review'].map(p => `<option value="${p}" ${preset === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>`
      + `<p class="fine-print">Type @Name to talk to one agent, or @all for everyone. In Team mode your message goes to the lead first; the lead answers or brings in teammates. The lead also decides when an "Until done" loop is finished.</p>`;
  }
  function modelOptions(provider, selected) {
    const models = state.connections.find(c => c.id === provider)?.models || [];
    return '<option value="">Automatic / client default</option>' + (selected && !models.some(m => m.id === selected) ? '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (saved)</option>' : '') + models.map(m => '<option value="' + esc(m.id) + '" ' + (selected === m.id ? 'selected' : '') + '>' + esc(m.name) + (m.remote ? ' · cloud' : '') + '</option>').join('');
  }
  function editDefaults() {
    openDialog(`<div class="dialog-heading"><div><h2 id="dialog-title">Models and defaults</h2><p>Set a model for each client and task.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><form id="defaults-form">${['planning', 'drafting', 'review'].map(p => `<fieldset><legend>${{ planning: 'Planning / orchestration', drafting: 'Drafting / general tasks', review: 'Review' }[p]}</legend>${Object.keys(names).map(provider => `<label>${names[provider]}<select data-default-preset="${p}" data-default-provider="${provider}">${modelOptions(provider, state.modelDefaults?.[p]?.[provider] || '')}</select></label>`).join('')}</fieldset>`).join('')}<label>Default task<select id="default-preset">${['planning', 'drafting', 'review'].map(p => `<option ${state.defaultPreset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label>Default collaboration<select id="default-mode">${Object.entries({ orchestrated: 'Lead + team', sequential: 'Relay', parallel: 'Parallel' }).map(([value, label]) => `<option value="${value}" ${state.executionMode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Parallel agent limit<input id="default-concurrency" type="number" min="1" max="4" value="${state.maxParallelAgents || 3}"></label><p class="fine-print">Defaults apply to new rooms. Model routing in the Team chip applies a task's models to this room. In Team mode, the parallel limit caps how many steps run at once.</p><div class="dialog-actions"><button type="button" class="text-button" data-action="settings">VS Code settings</button><button type="submit" class="primary-button">Save defaults</button></div></form>`, 'defaults');
  }
  function addAgent() {
    const hints = { codex: 'Codex CLI with its own tools and sessions', claude: 'Claude Code with its own tools, skills and sessions', copilot: 'Copilot CLI, or models available in VS Code', ollama: 'Local & cloud models' };
    openDialog(`<div class="dialog-heading"><div><h2 id="dialog-title">Another perspective.</h2><p>Add an agent to the room.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><div class="provider-grid">${Object.keys(names).map(p => `<button data-provider="${p}">${avatar({ provider: p })}<span><strong>${names[p]}</strong><small>${hints[p]}</small></span>${icon('plus')}</button>`).join('')}</div><p class="fine-print">You can add several agents from the same client, each with its own model, effort, permissions and focus.</p>`, 'add');
  }

  // ---- Inspector -----------------------------------------------------------------------------
  function quotaHtml(q) {
    if (!q) return '<p class="fine-print quota-note">Account quota: not reported</p>';
    return `<p class="fine-print quota-note" title="${esc(`Primary window: ${q.primaryWindowMinutes ?? 'unknown'} minutes. Secondary window: ${q.secondaryWindowMinutes ?? 'unknown'} minutes. Provider-reported snapshot; not a live quota query.`)}">Account remaining: ${(100 - q.primaryUsedPercent).toFixed(0)}% primary · ${(100 - q.secondaryUsedPercent).toFixed(0)}% secondary (as of ${clock(q.observedAt)})</p>`;
  }
  function usageTab() {
    const r = state.room, usage = r.usage || {}, list = Object.values(usage), dis = busy() ? ' disabled' : '';
    const total = list.reduce((s, u) => s + u.input + u.output, 0), cached = list.reduce((s, u) => s + u.cached, 0), estimated = list.some(u => u.estimated);
    const fresh = list.reduce((s, u) => s + Math.max(0, u.input - u.cached) + u.output, 0), limit = r.tokenBudget || 0, run = Math.max(0, fresh - (r.runStartTokens || 0));
    const limits = [0, 50000, 100000, 250000, 500000, 1000000]; if (!limits.includes(limit)) limits.push(limit);
    const row = (a, u, label) => {
      const ctx = a && ctxOf(a);
      return `<div class="usage-agent"><div class="usage-agent-name">${avatar(a || { provider: 'ollama' }, 'mini')}<span>${esc(label)}</span><strong>${u?.estimated ? '~' : ''}${fmt(u ? u.input + u.output : 0)}</strong></div><div class="usage-breakdown"><span>Input <b>${fmt(u?.input)}</b></span><span>Output <b>${fmt(u?.output)}</b></span></div><div class="usage-breakdown"><span>Cache read <b>${fmt(u?.cached)}</b></span><span>Requests <b>${fmt(u?.requests)}</b></span></div>${u?.cost !== undefined ? `<div class="subtle cost">Provider reported: $${u.cost.toFixed(4)}</div>` : ''}${ctx ? `<p class="fine-print context-note">Context ${Math.round(ctx.percent)}%${ctx.window ? ` of ${fmt(ctx.window)}` : ''}</p>` : ''}${a ? quotaHtml(a.session?.quota ?? u?.quota) : ''}${u?.cacheWrite ? `<p class="fine-print">${fmt(u.cacheWrite)} cache-write tokens</p>` : ''}</div>`;
    };
    const others = Object.entries(usage).filter(([id]) => !r.agents.some(a => a.id === id)).map(([id, u]) => row(undefined, u, id === 'local-tools' ? 'Local specialists' : 'Removed agent')).join('');
    return `<div class="inspector-section"><div class="section-heading">TOKENS USED <span class="subtle">this room</span></div><div class="big-stat">${estimated ? '~' : ''}${fmt(total)}</div><div class="stat-caption"><span>${fmt(fresh)} new</span><span>${fmt(cached)} cached re-reads</span></div>${limit ? `<div class="section-heading run-heading">THIS MESSAGE <span class="subtle">limit ${fmt(limit)}</span></div><progress class="budget-progress" value="${Math.min(run, limit)}" max="${limit}"></progress><div class="stat-caption"><span>${fmt(run)} new tokens</span><span>${Math.min(100, Math.round(run / limit * 100))}%</span></div>` : ''}</div>`
      + `<div class="inspector-section"><div class="section-heading">BY AGENT</div>${r.agents.map(a => row(a, usage[a.id], a.name)).join('')}${others}</div>`
      + `<div class="cache-card"><span class="cache-symbol">${icon('refresh')}</span><div><strong>${fmt(cached)} cached tokens</strong><p>Native sessions keep context between turns; cached re-reads are cheaper.</p></div></div>`
      + `<div class="inspector-section limits"><div class="section-heading">CONVERSATION LIMITS</div><label>Parallel agent limit<select id="parallel-limit"${dis}>${[1, 2, 3, 4].map(n => `<option ${n === (r.concurrency || 3) ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>Token limit per message<select id="budget"${dis}>${limits.sort((x, y) => x - y).map(n => `<option value="${n}" ${n === limit ? 'selected' : ''}>${n ? fmt(n) + ' new tokens' : 'No limit'}</option>`).join('')}</select></label><p class="fine-print">Optional safety stop. It counts new tokens, not cached re-reads, from when you send a message or press Resume. When the limit is reached, the room pauses; Resume continues. Loops have their own caps in the loop chip. Account quota is shown only when the client reports it. ~ marks estimates.</p></div>`;
  }
  const capChips = (list, label = x => x, title = () => '') => list.length ? list.slice(0, 24).map(x => `<span class="cap-chip" title="${esc(title(x))}">${esc(label(x))}</span>`).join('') + (list.length > 24 ? `<span class="cap-chip more">+${list.length - 24} more</span>` : '') : '<span class="subtle">None</span>';
  const mcpDot = status => /^(ready|connected|ok|running)$/i.test(status) ? 'ready' : /fail|error/i.test(status) ? 'error' : 'unchecked';
  function hintButtons(action, provider, status) {
    if (action === 'copilotLogin' || (provider === 'copilot' && status === 'signed-out')) return '<button type="button" class="outline-button inline" data-copilot="login">Sign in to Copilot</button>';
    if (action === 'installCopilot' || (provider === 'copilot' && status === 'missing')) return '<button type="button" class="outline-button inline" data-copilot="install">Install Copilot CLI</button>';
    if (action === 'openSettings') return '<button type="button" class="outline-button inline" data-action="settings">Open Settings</button>';
    return '';
  }
  function capsCard(a) {
    const c = caps(a), native = isNative(a), status = c?.status || 'unchecked', version = c?.version || conn(a)?.version || '';
    const dot = status === 'ready' ? 'ready' : status === 'unchecked' ? 'unchecked' : 'error';
    const head = `<div class="caps-head">${avatar(a, 'mini')}<div><strong>${esc(a.name)}</strong><small><span class="connection-dot ${dot}"></span>${esc(`${runtimeLabel(a)} ${version}`.trim())}${c?.account ? ' · ' + esc(c.account) : ''}</small></div><button type="button" class="icon-button small" data-caps-refresh="${esc(a.id)}" aria-label="Refresh ${esc(a.name)} capabilities" title="Refresh">${icon('refresh')}</button></div>`;
    const problem = status !== 'ready' && status !== 'unchecked' ? `<p class="caps-detail">${esc(c?.detail || status)}</p>${hintButtons(c?.action, a.provider, status)}` : '';
    if (!native) {
      const hint = a.provider === 'copilot' ? hintButtons('installCopilot') : '';
      return `<div class="caps-card legacy">${head}${problem}<div class="caps-row"><span class="caps-label">Chatroom tools (${a.tools.length})</span><div class="cap-list">${capChips(a.tools, t => toolLabels[t] || t, t => toolDescriptions[t] || '')}</div></div><p class="fine-print">Chat model: reads files through Chatroom's read-only tools.</p>${hint}</div>`;
    }
    if (!c) return `<div class="caps-card">${head}<p class="fine-print">Tools, skills and commands load when the agent connects. Refresh to check now.</p></div>`;
    if (problem) return `<div class="caps-card">${head}${problem}</div>`;
    return `<div class="caps-card">${head}${problem}<div class="caps-row"><span class="caps-label">Tools (${c.tools.length})</span><div class="cap-list">${c.tools.length ? capChips(c.tools) : '<span class="subtle">Listed after the first turn</span>'}</div></div><div class="caps-row"><span class="caps-label">Skills (${c.skills.length})</span><div class="cap-list">${capChips(c.skills, s => s.name, s => s.description || '')}</div></div><div class="caps-row"><span class="caps-label">MCP servers (${c.mcpServers.length})</span><div class="cap-list">${c.mcpServers.length ? c.mcpServers.slice(0, 24).map(s => `<span class="cap-chip" title="${esc(s.status)}"><span class="connection-dot ${mcpDot(s.status)}"></span>${esc(s.name)}${s.tools !== undefined ? ` · ${s.tools}` : ''}</span>`).join('') : '<span class="subtle">None</span>'}</div></div><div class="caps-row"><span class="caps-label">Commands (${c.commands.length})</span><div class="cap-list">${capChips(c.commands, x => '/' + x.name, x => x.description || '')}</div></div></div>`;
  }
  function toolsTab() {
    const r = state.room, running = busy(), docs = r.documents || [], skills = state.sharedSkills || [], ollama = state.connections.find(c => c.id === 'ollama');
    const options = capability => '<option value="">Select a local model…</option>' + (ollama?.models || []).filter(m => !m.remote && m.capabilities?.includes(capability)).map(m => `<option value="${esc(m.id)}" ${state.localModels?.[capability] === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    const needs = { ollama_ocr: state.localModels?.vision ? '' : ' · needs an OCR model', read_document: state.localModels?.vision ? '' : ' · scans need an OCR model', semantic_search: state.localModels?.embedding ? '' : ' · needs an embedding model', search_documents: state.localModels?.embedding ? '' : ' · keyword search until an embedding model is chosen' };
    const glyphs = s => (s.nativeTo || []).map(p => avatar({ provider: p }, 'micro')).join('');
    return `<div class="inspector-section"><div class="section-heading">AGENTS <span class="count">${r.agents.length}</span></div>${r.agents.map(capsCard).join('') || '<p class="muted">No agents in this room.</p>'}</div>`
      + `<div class="inspector-section"><div class="section-heading">SHARED WITH THE ROOM</div><label class="switch-row"><span><strong>Share skills between agents</strong><small>Claude Code, Codex and Copilot can use each other's skills.</small></span><span class="switch"><input type="checkbox" id="share-skills" role="switch" aria-label="Share skills between agents" ${r.shareSkills !== false ? 'checked' : ''}${running ? ' disabled' : ''}></span></label>${skills.slice(0, 60).map(s => `<div class="skill-row"><div class="skill-head"><strong>${esc(s.name)}</strong><span class="subtle">${esc(s.source)}</span><span class="native-to" title="Native to ${esc((s.nativeTo || []).map(p => names[p]).join(', '))}">${glyphs(s)}</span></div><p>${esc(s.description)}</p></div>`).join('')}${skills.length > 60 ? `<p class="fine-print">+${skills.length - 60} more skills</p>` : skills.length ? '' : '<p class="fine-print">No skills found in .claude, .agents, .codex, .github or .copilot folders.</p>'}<div class="section-heading sub-heading">ROOM TOOLS</div>${ROOM_TOOLS.map(([name, label, iconName, description]) => `<div class="tool-row"><span class="tool-symbol">${icon(iconName)}</span><div><strong>${label}</strong><small>${esc(description)}</small><small>available to every native agent${needs[name] || ''}</small></div></div>`).join('')}</div>`
      + `<div class="inspector-section"><div class="section-heading">ROOM DOCUMENTS <span class="count">${docs.length}</span></div><p class="muted">Attached files are read automatically, with OCR for images and scanned pages, then split into passages and embedded. Agents get the most relevant passages with each message and can search for more.</p>${docs.map(d => `<div class="doc-row ${esc(d.status)}"><span class="tool-symbol">${icon('file')}</span><div><strong>${esc(d.name)}</strong><small>${esc(d.status === 'ready' ? `${docStatus(d)} · ${d.chars.toLocaleString()} characters · ${d.chunks} passage${d.chunks === 1 ? '' : 's'}` : d.detail || d.status)}</small></div><button class="icon-button small" data-remove-doc="${esc(d.id)}" aria-label="Remove ${esc(d.name)}">${icon('close')}</button></div>`).join('')}<button class="outline-button" data-action="attachDocuments">${icon('attach')} Attach documents</button></div>`
      + `<div class="inspector-section"><div class="section-heading">LOCAL SPECIALISTS <span class="connection-dot ${ollama?.status || 'unchecked'}"></span></div><p class="muted">Local Ollama models read documents and build the search index. Installed models are selected automatically.</p><label class="model-field">Vision / OCR<select id="vision-model"${running ? ' disabled' : ''}>${options('vision')}</select></label><label class="model-field">Embeddings<select id="embedding-model"${running ? ' disabled' : ''}>${options('embedding')}</select></label><p class="fine-print">Models must already be installed in Ollama. Cloud models are excluded. Extracted text, OCR results and embeddings are cached on disk in this workspace's VS Code storage, so the same file is never processed twice.</p></div>`
      + `<div class="inspector-section"><div class="section-heading">CONNECTIONS</div>${state.connections.map(c => `<div class="connection-row"><span class="connection-dot ${c.status}"></span><div><strong>${names[c.id] || esc(c.id)}</strong><small>${esc(c.detail)}</small><small>${esc(c.modelSource || '')}</small>${c.hint ? `<small class="hint">${esc(c.hint.text)}</small>${hintButtons(c.hint.action, c.id)}` : ''}</div></div>`).join('')}<button class="outline-button" data-action="refresh"${state.discovering ? ' disabled' : ''}>${icon('refresh')} ${state.discovering ? 'Discovering…' : 'Refresh connections'}</button></div><p class="fine-print footnote">Native agents use their own tools, skills and MCP servers, governed by each agent's permission level.</p>`;
  }
  function activityTab() {
    const r = state.room;
    return `<div class="inspector-section"><div class="section-heading">LIVE ACTIVITY <span class="count">${r.activity.length}</span></div><p class="muted">Agent turns, tool calls, and connection issues appear here.</p></div><div class="activity-list">${r.activity.length ? r.activity.slice().reverse().map(a => `<div class="activity-item ${a.kind}"><span class="activity-node"></span><div><p>${esc(a.text)}</p><time>${new Date(a.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div></div>`).join('') : '<div class="activity-empty">All quiet for now.<br>Your next idea gets things moving.</div>'}</div>`;
  }
  function renderInspector() {
    document.querySelectorAll('[data-tab]').forEach(el => { el.classList.toggle('active', el.dataset.tab === tab); el.setAttribute('aria-selected', String(el.dataset.tab === tab)); });
    const root = $('inspector-content');
    if (!state || !$('inspector').classList.contains('expanded')) return;
    // Preserve focused limit fields while state streams in.
    if (root.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    setHtml(root, tab === 'usage' ? usageTab() : tab === 'tools' ? toolsTab() : activityTab());
  }

  // ---- Events --------------------------------------------------------------------------------
  function toast(text, kind = 'error') { $('toast').textContent = text; $('toast').className = `toast ${kind}`; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 7000); }
  function saveDraft() { bridge.setState({ draft: $('prompt').value, tab, ultraConfirmed }); }
  function autoGrow() { const p = $('prompt'); p.style.height = 'auto'; p.style.height = Math.min(Math.max(p.scrollHeight + 2, 44), 180) + 'px'; }
  function submitComposer() {
    if (!state) return;
    const text = $('prompt').value.trim(); if (!text) return;
    if (busy() && !/^\s*(?:@(?:"[^"]+"|\S+)[\s,]+)*\/[A-Za-z]/.test(text)) { toast('Agents are working. Wait or press Stop.', 'info'); return; }
    const ed = state.editor;
    send('send', { text, editor: !!ed && state.room.attachEditor !== false && droppedKey !== ed.key, think, ultra });
    lastSent = { text, at: Date.now() };
    $('prompt').value = ''; think = false; ultra = false; nearBottom = true;
    closeMenu(); autoGrow(); saveDraft(); renderChips();
  }
  function act(action, button) {
    if (action === 'inspector') { $('inspector').classList.toggle('expanded'); renderInspector(); }
    else if (action === 'add') addAgent();
    else if (action === 'defaults') editDefaults();
    else if (action === 'room-setup') openDialog(setupDialog(), 'setup');
    else if (action === 'close-dialog') closeDialog();
    else if (action === 'jump-approval') { const id = pendingApprovals()[0]?.id; const el = id && $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`); el?.scrollIntoView({ block: 'center' }); el?.querySelector('[data-decision]')?.focus(); }
    else { if (action === 'settings' && button.closest('#dialog-layer')) closeDialog(); send(action); }
  }
  document.addEventListener('mousedown', event => { if (event.target.closest('#menu')) event.preventDefault(); });
  $('menu').addEventListener('mousedown', event => { const item = event.target.closest('.menu-item'); if (item) acceptMenu(Number(item.dataset.index)); });
  $('messages').addEventListener('click', event => { const details = event.target.closest('summary')?.parentElement; if (details?.dataset.id) openState.set(details.dataset.id, !details.open); });
  document.addEventListener('click', event => {
    const target = event.target;
    if (target.closest('#menu')) return;
    if (pop && !target.closest('#popover') && !target.closest('[data-pop]')) closePopover();
    const button = target.closest('button'); if (!button || button.disabled || !state && !button.dataset.action) return;
    const d = button.dataset;
    if (d.pop) { togglePopover(d.pop, button); return; }
    if (button.id === 'send' && busy()) { event.preventDefault(); send('stop'); return; }
    if (button.id === 'chip-think') { think = !think; button.setAttribute('aria-pressed', String(think)); return; }
    if (button.id === 'chip-ultra') { if (ultra) { ultra = false; button.setAttribute('aria-pressed', 'false'); } else confirmUltra().then(ok => { if (ok) { ultra = true; button.setAttribute('aria-pressed', 'true'); } }); return; }
    if (button.id === 'open-slash') { insertSlash(); return; }
    if (button.id === 'open-mention') { insertMention(); return; }
    if (d.action) act(d.action, button);
    if (d.agent && button.classList.contains('agent-pill')) editAgent(d.agent);
    if (d.edit) editAgent(d.edit);
    if (d.tab) { tab = d.tab; renderInspector(); saveDraft(); }
    if (d.provider) { send('addAgent', { provider: d.provider }); closeDialog(); }
    if (d.remove) { send('removeAgent', { id: d.remove }); closeDialog(); }
    if (d.removeDoc) send('removeDocument', { id: d.removeDoc });
    if (d.prompt) { $('prompt').value = d.prompt; $('prompt').focus(); autoGrow(); saveDraft(); }
    if (d.editorAction === 'reveal') send('editor', { action: 'reveal' });
    if (d.editorAction === 'toggle') send('options', { attachEditor: state.room.attachEditor === false });
    if (d.editorAction === 'drop' && state.editor) { droppedKey = state.editor.key; renderContextChips(); $('prompt').focus(); }
    if (d.approve) {
      send('approval', { id: d.approve, decision: d.decision }); button.closest('.approval-actions')?.querySelectorAll('button').forEach(b => { b.disabled = true; });
      // Disabling drops focus; move it to the next request (keyboard activation scrolls to it) or back to the prompt.
      ($('messages').querySelector('.approval-actions [data-decision="allow"]:not(:disabled)') || $('prompt')).focus({ preventScroll: event.detail > 0 });
    }
    if (d.perm) {
      closePopover(true);
      if (d.perm === 'full') confirmBox('Allow agents to edit files and run commands without asking?', 'Allow full access').then(ok => { if (ok) send('options', { permission: 'full' }); });
      else send('options', { permission: d.perm });
    }
    if (d.copilot) send('copilot', { action: d.copilot });
    if (d.makeLead) send('options', { leadId: d.makeLead });
    if (d.capsRefresh !== undefined) { if (d.capsRefresh) capsAsked[d.capsRefresh] = Date.now(); send('capabilities', d.capsRefresh ? { id: d.capsRefresh } : {}); }
    if (d.session && editing) send('agentSession', { id: editing, action: d.session });
    if (d.compact !== undefined) { const a = agentById(d.compact); send('send', { text: a ? `${quoteName(a.name)} /compact` : '/compact', editor: false, think: false, ultra: false }); closePopover(); }
  });
  document.addEventListener('change', event => {
    const el = event.target, id = el.id;
    if (dialogKind === 'agent' && el.closest('#dialog-layer')) dialogDirty = true;
    if (el.name === 'mode' || el.name === 'setup-mode') send('options', { mode: el.value });
    if (el.name === 'setup-lead' || id === 'lead-select') send('options', { leadId: el.value });
    if (id === 'preset-select' || id === 'setup-preset') send('options', { preset: el.value });
    if (id === 'parallel-limit') send('options', { concurrency: Number(el.value) });
    if (id === 'budget') send('options', { tokenBudget: Number(el.value) });
    if (el.name === 'loop-kind') updateLoopFields();
    if (el.closest?.('#loop-form')) saveLoop(false);
    if (el.dataset.effortAgent) send('agent', { id: el.dataset.effortAgent, options: { effort: el.value } });
    if (el.dataset.thinkingAgent) send('agent', { id: el.dataset.thinkingAgent, options: { thinking: el.checked ? 'on' : 'off' } });
    if (el.dataset.enableAgent) send('agent', { id: el.dataset.enableAgent, enabled: el.checked });
    if (id === 'share-skills') send('options', { shareSkills: el.checked });
    if (id === 'agent-model') { const a = agentById(editing); if (a) { const list = effortsOf(a, el.value), current = $('agent-effort')?.value || ''; $('agent-effort').innerHTML = effortOptions(list, list.includes(current) ? current : ''); $('effort-field').hidden = !list.length; } }
    const syncSandbox = () => { const s = $('agent-sandbox'), p = $('agent-permission'); if (s && p) s.innerHTML = sandboxOptions(p.value, s.value); };
    if (id === 'agent-permission') syncSandbox();
    if (id === 'agent-permission' && el.value === 'full') { const previous = opts(agentById(editing) || {}).permission; confirmBox('Allow this agent to edit files and run commands without asking?', 'Allow full access').then(ok => { if (!ok && $('agent-permission')) { $('agent-permission').value = previous === 'full' ? 'ask' : previous; syncSandbox(); } }); }
    if (id === 'agent-ultra' && el.checked) confirmUltra().then(ok => { if (!ok && $('agent-ultra')) $('agent-ultra').checked = false; });
    if (id === 'rooms') send('switch', { id: el.value });
    if (id === 'vision-model' || id === 'embedding-model') send('localModels', { vision: $('vision-model').value, embedding: $('embedding-model').value });
  });
  document.addEventListener('input', event => { if (dialogKind === 'agent' && event.target.closest?.('#dialog-layer')) dialogDirty = true; });
  document.addEventListener('submit', event => {
    event.preventDefault();
    const id = event.target.id;
    if (id === 'composer') submitComposer();
    if (id === 'loop-form') saveLoop();
    if (id === 'agent-form') saveAgent();
    if (id === 'defaults-form') {
      const modelDefaults = { planning: {}, drafting: {}, review: {} };
      document.querySelectorAll('[data-default-preset]').forEach(el => { modelDefaults[el.dataset.defaultPreset][el.dataset.defaultProvider] = el.value; });
      send('saveDefaults', { modelDefaults, defaultPreset: $('default-preset').value, executionMode: $('default-mode').value, maxParallelAgents: Number($('default-concurrency').value) }); closeDialog();
    }
  });
  const prompt = $('prompt');
  prompt.addEventListener('input', () => { saveDraft(); autoGrow(); detectMenu(); });
  prompt.addEventListener('click', detectMenu);
  prompt.addEventListener('keyup', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) detectMenu(); });
  prompt.addEventListener('blur', closeMenu);
  prompt.addEventListener('keydown', event => {
    if (menu.open && !event.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveMenu(event.key === 'ArrowDown' ? 1 : -1); return; }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); acceptMenu(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  $('messages').addEventListener('scroll', () => { const el = $('messages'); nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (confirmClose) { confirmClose(); return; }
      if (menu.open) { closeMenu(); return; }
      if (pop) { closePopover(true); return; }
      if (!$('dialog-layer').hidden) { closeDialog(); return; }
      $('inspector').classList.remove('expanded');
    }
    const layer = document.querySelector('.confirm-layer') || (!$('dialog-layer').hidden && $('dialog-layer'));
    if (event.key === 'Tab' && layer) {
      const focusable = [...layer.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('dialog-layer').addEventListener('click', event => { if (event.target === $('dialog-layer')) closeDialog(); });
  window.addEventListener('resize', () => { if (pop) placePopover(); });
  setInterval(() => {
    if (!state) return;
    document.querySelectorAll('.approval-expiry[data-expires]').forEach(el => { el.textContent = mmss(Math.max(0, Math.round((Number(el.dataset.expires) - Date.now()) / 1000))) + ' left'; });
    if (state.room.loop?.kind === 'interval' && state.room.loopState?.nextAt) chip('chip-loop', 'loop', loopLabel(state.room), $('chip-loop').title);
  }, 1000);
  window.addEventListener('message', event => {
    const data = event.data; if (!data || typeof data !== 'object') return;
    if (data.type === 'state') { state = data; render(); }
    if (data.type === 'error') {
      if (lastSent && Date.now() - lastSent.at < 10000 && !$('prompt').value.trim()) { $('prompt').value = lastSent.text; autoGrow(); saveDraft(); }
      lastSent = undefined; toast(data.text);
    }
    if (data.type === 'notice') toast(data.text, 'info');
  });
  autoGrow();
  send('ready');
})();
