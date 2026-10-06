/* Chatroom webview. No network access; all provider traffic stays in the extension host. */
(() => {
  'use strict';
  const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: m => window.dispatchEvent(new CustomEvent('preview-message', { detail: m })), getState: () => ({}), setState: () => {} };
  const saved = bridge.getState() || {};
  let state, tab = saved.tab || 'usage', editing, lastRoom, messageSignature = '', nearBottom = true, pendingDraft = '', target = saved.target || '';
  const $ = id => document.getElementById(id);
  const send = (type, data = {}) => bridge.postMessage({ type, ...data });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = value => new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value || 0);
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
    file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>', selection: '<path d="M5 6h14M5 11h9M5 16h6"/><path d="M17 14v6M15 14h4M15 20h4"/>',
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>'
  };
  const icon = name => name === 'logo' ? icons.logo : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
  const marks = { codex: '⌘', claude: '✳', copilot: '⌥', ollama: '◎' };
  const names = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot', ollama: 'Ollama' };
  const toolLabels = { list_files: 'List files', read_file: 'Read files', search_files: 'Search text', search_documents: 'Search documents', ollama_ocr: 'Local OCR', semantic_search: 'Semantic search' };
  const toolDescriptions = { list_files: 'Find files in the workspace', read_file: 'Read files; PDFs, Word files and images are converted to text automatically', search_files: 'Find exact text across files', search_documents: 'Find passages in the documents attached to this room', ollama_ocr: 'Read images with a local vision model', semantic_search: 'Find relevant code with local embeddings' };
  const modeLabels = { orchestrated: 'Lead + team', sequential: 'Relay', parallel: 'Parallel' };
  const modeHelp = {
    orchestrated: 'The lead splits the task into steps for the team. Independent steps run in parallel, dependent steps build on earlier results, and the lead writes the final answer.',
    sequential: 'Agents reply one after another, and each builds on the replies before it.',
    parallel: 'Agents answer independently at the same time. The next round sees all replies.'
  };
  const stepLabels = { pending: 'Waiting', running: 'Working…', complete: 'Done', error: 'Failed', skipped: 'Skipped' };
  $('app').innerHTML = `
    <header class="topbar"><div class="brand"><span class="brandmark">${icon('logo')}</span>Chatroom</div><div class="top-actions"><span id="workspace" class="workspace-label"></span><button class="icon-button" data-action="refresh" title="Refresh connections and models" aria-label="Refresh connections">${icon('refresh')}</button><button class="icon-button" data-action="open" title="Open in editor" aria-label="Open in editor">${icon('arrow')}</button><button class="icon-button" data-action="defaults" title="Models and defaults" aria-label="Settings">${icon('settings')}</button></div></header>
    <div class="room-bar"><div class="room-picker"><select id="rooms" aria-label="Conversation"></select><button class="icon-button small" data-action="new" aria-label="New room">${icon('plus')}</button></div><div class="room-bar-right"><span id="room-status" class="status-label"></span><button class="icon-button small inspector-toggle" data-action="inspector" aria-label="Usage, tools and activity">${icon('grid')}</button><button class="icon-button small" data-action="export" aria-label="Export conversation">${icon('export')}</button></div></div>
    <main class="workspace">
      <details class="roster" open><summary>Agents <span id="agent-count" class="count"></span></summary><div id="agents" class="agents"></div><button class="add-agent" data-action="add">${icon('plus')} Add agent</button></details>
      <section class="conversation"><div class="conversation-heading"><h1 id="conversation-title"></h1><span id="turns" class="turn-count"></span></div><div id="messages" class="messages" role="log" aria-label="Room conversation" aria-live="polite"></div>
        <div id="run-controls" class="run-controls"></div>
        <div class="composer-wrap"><form id="composer" class="composer"><div class="composer-context"><select id="target" aria-label="Who should respond"><option value="">Everyone</option></select><select id="mode" aria-label="How agents collaborate">${Object.entries(modeLabels).map(([value, label]) => `<option value="${value}" title="${esc(modeHelp[value])}">${label}</option>`).join('')}</select><select id="lead" aria-label="Lead agent" title="The lead plans the steps and writes the final answer"></select><select id="preset" aria-label="Task preset"><option value="planning">Planning</option><option value="drafting">Drafting</option><option value="review">Review</option></select></div><div id="documents" class="documents" aria-label="Attached documents" hidden></div><textarea id="prompt" rows="3" maxlength="24000" aria-label="Message the room" placeholder="Ask your agents…"></textarea><div class="composer-bottom"><button type="button" class="icon-button" data-action="attachDocuments" aria-label="Attach documents" title="Attach documents: PDF, Word, images or text. They are read automatically (OCR for scans) and indexed for every agent.">${icon('attach')}</button><button type="button" class="icon-button" data-action="attach" aria-label="Attach editor selection" title="Attach editor selection">${icon('selection')}</button><span class="keyboard-hint">Enter to send · Shift+Enter for newline</span><button id="send" class="send-button" type="submit" aria-label="Send message">${icon('send')}</button></div></form></div>
        <footer id="runtime-status" class="runtime-status" role="status" aria-live="polite"></footer>
      </section>
      <aside id="inspector" class="inspector"><div class="inspector-header"><div class="tabs" role="tablist"><button data-tab="usage" role="tab">Usage</button><button data-tab="tools" role="tab">Tools</button><button data-tab="activity" role="tab">Activity</button></div><button class="icon-button small inspector-close" data-action="inspector" aria-label="Close inspector">${icon('close')}</button></div><div id="inspector-content" class="inspector-content"></div></aside>
    </main><div id="toast" class="toast" role="alert" hidden></div><div id="dialog-layer" class="dialog-layer" hidden></div>`;
  $('prompt').value = saved.draft || '';

  function avatar(agent, extra = '') { return `<span class="avatar ${esc(agent.provider)} ${extra}">${marks[agent.provider] || '◈'}</span>`; }
  function render() {
    if (!state) return;
    const room = state.room, busy = room.status === 'running';
    if (lastRoom !== room.id) { lastRoom = room.id; nearBottom = true; messageSignature = ''; }
    $('workspace').textContent = state.workspace;
    $('rooms').innerHTML = state.rooms.map(r => `<option value="${esc(r.id)}" ${r.id === room.id ? 'selected' : ''}>${esc(r.title)}</option>`).join('');
    $('rooms').disabled = busy;
    $('room-status').textContent = busy ? 'Conversation in progress' : room.status === 'paused' ? 'Conversation paused' : 'Ready when you are';
    $('room-status').className = `status-label ${room.status}`;
    $('agent-count').textContent = String(room.agents.filter(a => a.enabled).length);
    const lead = leadOf(room);
    $('agents').innerHTML = room.agents.map(a => {
      const connection = state.connections.find(c => c.id === a.provider);
      const active = (room.activeAgents || [room.currentAgent]).includes(a.id);
      const status = room.agentStates?.[a.id];
      const label = !a.enabled ? 'Disabled' : status?.status === 'error' ? 'Failed' : status?.status === 'tool' ? 'Using ' + status.detail : active ? 'Thinking…' : status?.status === 'queued' ? 'Queued' : status?.status === 'complete' ? 'Done' : status?.status === 'stopped' ? 'Stopped' : connection?.status === 'ready' ? 'Ready' : connection?.status === 'unchecked' ? 'Connect to discover' : 'Setup needed';
      const badge = room.mode === 'orchestrated' && lead?.id === a.id ? '<span class="lead-badge" title="Plans the steps and writes the final answer">Lead</span>' : '';
      return `<article class="agent-card ${a.enabled ? '' : 'disabled'} ${active ? 'speaking' : ''}"><div class="agent-card-top"><button class="agent-edit" data-edit="${esc(a.id)}" aria-label="Configure ${esc(a.name)}">${avatar(a)}<span><strong>${esc(a.name)}</strong><small>${esc(a.model || 'Client default')}</small></span></button><button class="agent-toggle ${a.enabled ? 'on' : ''}" data-toggle="${esc(a.id)}" role="switch" aria-checked="${a.enabled}" aria-label="${a.enabled ? 'Stop' : 'Enable'} ${esc(a.name)}"><span></span></button></div><select class="agent-model-picker" data-model-agent="${esc(a.id)}" aria-label="${esc(a.name)} model" ${busy ? 'disabled' : ''}>${modelOptions(a.provider, a.model)}</select><div class="agent-meta"><span class="connection-dot ${status?.status === 'error' ? 'error' : active ? 'speaking' : connection?.status || 'unchecked'}"></span><span>${esc(label)}</span>${badge}<button data-edit="${esc(a.id)}" class="text-button" title="Configure tools">${a.tools.length} tools ${icon('chevron')}</button></div></article>`;
    }).join('');
    $('target').innerHTML = '<option value="">Everyone in the room</option>' + room.agents.filter(a => a.enabled).map(a => `<option value="${esc(a.id)}">Only ${esc(a.name)} · 1:1 chat</option>`).join('');
    $('target').value = [...$('target').options].some(o => o.value === target) ? target : '';
    $('lead').innerHTML = room.agents.filter(a => a.enabled).map(a => `<option value="${esc(a.id)}">Lead: ${esc(a.name)}</option>`).join('');
    if (lead) $('lead').value = lead.id;
    $('conversation-title').textContent = room.title;
    $('turns').textContent = room.completedTurns ? `${room.completedTurns} turns` : '';
    $('preset').value = room.preset || 'planning'; $('mode').value = room.mode || 'sequential';
    $('preset').disabled = busy;
    updateComposer();
    renderDocuments();
    const activeNames = room.agents.filter(a => (room.activeAgents || [room.currentAgent]).includes(a.id)).map(a => a.name);
    const failed = Object.values(room.agentStates || {}).filter(s => s.status === 'error').length;
    const modeText = room.mode === 'parallel' ? `Parallel (max ${room.concurrency || 3})` : room.mode === 'orchestrated' ? `Lead + team (max ${room.concurrency || 3} in parallel)` : 'Relay';
    $('runtime-status').textContent = modeText + ' · ' + activeNames.length + ' running · ' + (room.queuedTurns || 0) + ' queued' + (failed ? ' · ' + failed + ' failed' : '') + (activeNames.length ? ' — ' + activeNames.join(', ') : '');
    $('send').disabled = busy || !room.agents.some(a => a.enabled);
    $('run-controls').innerHTML = busy
      ? `<span class="thinking"><i></i><i></i><i></i> ${activeNames.length} active</span><button data-action="pause">${icon('pause')} Pause</button><button data-action="stop" class="stop-control">${icon('stop')} Stop</button>`
      : room.messages.length ? `<span>${room.status === 'paused' ? 'Take your time. Resume when ready.' : 'The floor is yours.'}</span><button data-action="start">${icon('play')} ${room.status === 'paused' ? 'Resume' : 'Continue round'}</button>` : '';
    renderMessages(); renderInspector();
  }
  function leadOf(room) { return room.agents.find(a => a.id === room.leadId && a.enabled) || room.agents.find(a => a.enabled); }
  /** 1:1 chat ignores the room mode and lead; the lead picker only matters in Lead + team mode. */
  function updateComposer() {
    const room = state.room, busy = room.status === 'running', direct = !!$('target').value;
    $('mode').disabled = busy || direct; $('lead').disabled = busy || direct;
    $('lead').hidden = room.mode !== 'orchestrated';
    $('mode').title = direct ? '1:1 chat: only the selected agent replies' : modeHelp[room.mode || 'sequential'];
    $('prompt').placeholder = direct ? `Message ${$('target').selectedOptions[0]?.textContent.replace(/^Only | · 1:1 chat$/g, '')}…` : room.mode === 'orchestrated' ? `Ask the team · ${leadOf(room)?.name || 'the lead'} will coordinate…` : 'Ask your agents…';
  }
  function docStatus(d) {
    if (d.status === 'error') return 'Failed';
    if (d.status !== 'ready') return d.detail || (d.status === 'embedding' ? 'Indexing…' : 'Reading…');
    return [d.pages ? `${d.pages} p.` : '', d.ocrPages ? `${d.ocrPages} OCR` : '', d.embedded ? 'indexed' : 'keyword search'].filter(Boolean).join(' · ');
  }
  function renderDocuments() {
    const docs = state.room.documents || [];
    $('documents').hidden = !docs.length;
    $('documents').innerHTML = docs.map(d => `<span class="doc-chip ${esc(d.status)}" title="${esc(d.name + (d.detail ? ' — ' + d.detail : d.status === 'ready' ? ` — ${d.chars.toLocaleString()} characters in ${d.chunks} passages${d.embedded ? `, embedded with ${d.embedded}` : ''}` : ''))}">${icon('file')}<span class="doc-name">${esc(d.name.split(/[\\/]/).pop())}</span><span class="doc-status">${esc(docStatus(d))}</span><button type="button" class="doc-remove" data-remove-doc="${esc(d.id)}" aria-label="Remove ${esc(d.name)}">${icon('close')}</button></span>`).join('');
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
  function renderMessages() {
    const messages = state.room.messages;
    const signature = JSON.stringify(messages);
    if (signature === messageSignature) return;
    messageSignature = signature;
    const container = $('messages');
    const oldScroll = container.scrollTop;
    const expanded = new Set([...container.querySelectorAll('details[open]')].map(el => el.dataset.id));
    container.replaceChildren();
    if (!messages.length) {
      container.innerHTML = `<div class="empty-state"><span class="empty-icon">${icon('logo')}</span><h2>Chat with your agents</h2><p>In <strong>Lead + team</strong>, the lead splits your task into steps. The others work on them in parallel or build on each other's results, and the lead combines everything into one answer. Pick <strong>Only …</strong> to chat with a single agent. Attach PDFs, Word files or images and every agent can search them.</p><div class="suggestions"><button data-prompt="Inspect this repository using the file tools, then explain its architecture and suggest next steps.">Explain this repository ${icon('arrow')}</button><button data-prompt="Review this workspace for reliability issues. Split the review by area, read the relevant files, and challenge each other's findings.">Review the code as a team ${icon('arrow')}</button></div></div>`;
      return;
    }
    for (const m of messages) {
      if (m.kind === 'tool') {
        const detail = document.createElement('details'); detail.className = 'tool-result'; detail.dataset.id = m.id; detail.open = expanded.has(m.id);
        const summary = document.createElement('summary'); summary.textContent = `${toolLabels[m.author] || m.author} · tool result`;
        const pre = document.createElement('pre'); pre.textContent = m.text;
        detail.append(summary, pre); container.append(detail); continue;
      }
      const agent = state.room.agents.find(a => a.id === m.agentId), article = document.createElement('article');
      const chip = m.turn === 'plan' ? 'Plan' : m.turn === 'step' ? `Step ${m.step?.id || ''}` : m.turn === 'synthesis' ? 'Final answer' : m.turn === 'direct' ? '1:1' : '';
      const planMessage = m.step?.plan && messages.find(p => p.id === m.step.plan);
      const inputs = (m.step?.after || []).map(id => { const s = planMessage?.plan?.find(p => p.id === id); const a = s && state.room.agents.find(x => x.id === s.agentId); return a ? `${a.name} (${id})` : id; });
      article.className = `message ${m.kind} ${m.status}${m.turn ? ` turn-${m.turn}` : ''}`;
      article.innerHTML = `<div class="message-avatar">${m.kind === 'user' ? '<span class="avatar user-avatar">Y</span>' : avatar(agent || { provider: 'ollama' })}</div><div class="message-main"><div class="message-heading"><strong>${esc(m.author)}</strong>${chip ? `<span class="turn-chip ${esc(m.turn)}">${esc(chip)}</span>` : ''}${agent ? `<span class="model-label">${esc(agent.model || names[agent.provider])}</span>` : '<span class="model-label">You</span>'}<time>${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>${m.step ? `<div class="step-task">${esc(m.step.task)}${inputs.length ? `<span class="builds-on"> · builds on ${esc(inputs.join(', '))}</span>` : ''}</div>` : ''}<div class="message-content"></div>${m.plan?.length ? renderPlan(m.plan, state.room.agents) : ''}<div class="message-footer"></div></div>`;
      const content = article.querySelector('.message-content');
      const agrees = m.kind === 'agent' && /\[CONSENSUS\]\s*$/.test(m.text), text = agrees ? m.text.replace(/\s*\[CONSENSUS\]\s*$/, '') : m.text;
      if (!text && m.status === 'streaming') content.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';
      else markdown(content, text);
      const foot = article.querySelector('.message-footer');
      if (m.usage) foot.textContent = `${m.usage.estimated ? '~' : ''}${fmt(m.usage.input + m.usage.output)} tokens${m.usage.cached ? ` · ${fmt(m.usage.cached)} cached` : ''}`;
      if (agrees) foot.textContent += `${foot.textContent ? ' · ' : ''}agrees · nothing to add`;
      if (m.status === 'cancelled' || m.status === 'error') foot.textContent += ` · ${m.status}`;
      if (m.status === 'streaming') foot.textContent = 'Responding…';
      container.append(article);
    }
    if (nearBottom) container.scrollTop = container.scrollHeight; else container.scrollTop = oldScroll;
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
  function renderInspector() {
    document.querySelectorAll('[data-tab]').forEach(el => { el.classList.toggle('active', el.dataset.tab === tab); el.setAttribute('aria-selected', String(el.dataset.tab === tab)); });
    const room = state.room, busy = room.status === 'running', root = $('inspector-content');
    // Preserve focused limit fields while state streams in.
    if (root.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (tab === 'usage') {
      const total = Object.values(room.usage).reduce((s, u) => s + u.input + u.output, 0);
      const cached = Object.values(room.usage).reduce((s, u) => s + u.cached, 0);
      const estimated = Object.values(room.usage).some(u => u.estimated);
      const fresh = Object.values(room.usage).reduce((s, u) => s + Math.max(0, u.input - u.cached) + u.output, 0);
      const limit = room.tokenBudget || 0, run = Math.max(0, fresh - (room.runStartTokens || 0));
      const limits = [0, 50000, 100000, 250000, 500000, 1000000];
      if (!limits.includes(limit)) limits.push(limit);
      const limitOptions = limits.sort((a, b) => a - b).map(n => `<option value="${n}" ${n === limit ? 'selected' : ''}>${n ? fmt(n) + ' new tokens' : 'No limit'}</option>`).join('');
      root.innerHTML = `<div class="inspector-section"><div class="section-heading">TOKENS USED <span class="subtle">this room</span></div><div class="big-stat">${estimated ? '~' : ''}${fmt(total)}</div><div class="stat-caption"><span>${fmt(fresh)} new</span><span>${fmt(cached)} cached re-reads</span></div>${limit ? `<div class="section-heading run-heading">THIS MESSAGE <span class="subtle">limit ${fmt(limit)}</span></div><progress class="budget-progress" value="${Math.min(run, limit)}" max="${limit}"></progress><div class="stat-caption"><span>${fmt(run)} new tokens</span><span>${Math.min(100, Math.round(run / limit * 100))}%</span></div>` : ''}</div><div class="inspector-section"><div class="section-heading">BY AGENT</div>${room.agents.map(a => {
        const u = room.usage[a.id]; return `<div class="usage-agent"><div class="usage-agent-name">${avatar(a, 'mini')}<span>${esc(a.name)}</span><strong>${u?.estimated ? '~' : ''}${fmt(u ? u.input + u.output : 0)}</strong></div><div class="usage-breakdown"><span>Input <b>${fmt(u?.input)}</b></span><span>Output <b>${fmt(u?.output)}</b></span></div><div class="usage-breakdown"><span>Cache read <b>${fmt(u?.cached)}</b></span><span>Requests <b>${fmt(u?.requests)}</b></span></div>${u?.cost !== undefined ? `<div class="subtle cost">Provider reported: $${u.cost.toFixed(4)}</div>` : ''}</div>`;
      }).join('')}</div><div class="cache-card"><span class="cache-symbol">↻</span><div><strong>${fmt(cached)} cached tokens</strong><p>Stable prompt prefixes help providers reuse context.</p></div></div><div class="inspector-section limits"><div class="section-heading">CONVERSATION LIMITS</div><label>Rounds per run<select id="rounds" ${busy ? 'disabled' : ''}>${[1, 2, 3, 5, 10].map(n => `<option ${n === room.rounds ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>Parallel agent limit<select id="parallel-limit" ${busy ? 'disabled' : ''}>${[1, 2, 3, 4].map(n => `<option ${n === (room.concurrency || 3) ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>Token limit per message<select id="budget" ${busy ? 'disabled' : ''}>${limitOptions}</select></label><p class="fine-print"></p></div>`;
    } else if (tab === 'tools') {
      const ollama = state.connections.find(c => c.id === 'ollama');
      const options = capability => '<option value="">Select a local model…</option>' + (ollama?.models || []).filter(m => !m.remote && m.capabilities?.includes(capability)).map(m => `<option value="${esc(m.id)}" ${state.localModels[capability] === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
      const needs = { ollama_ocr: state.localModels.vision ? '' : 'needs an OCR model', semantic_search: state.localModels.embedding ? '' : 'needs an embedding model', search_documents: state.localModels.embedding ? '' : 'keyword search until an embedding model is chosen' };
      const symbols = { list_files: '▤', read_file: '↗', search_files: '⌕', search_documents: '❏', ollama_ocr: '◫', semantic_search: '≈' };
      const docs = room.documents || [];
      root.innerHTML = `<div class="inspector-section"><div class="section-heading">TOOLS <span class="pill">READ ONLY</span></div><p class="muted">Every agent is told which tools it and the others have. Turn tools on or off per agent in its settings.</p>${Object.keys(toolLabels).map(t => { const users = room.agents.filter(a => a.enabled && a.tools.includes(t)).map(a => a.name); return `<div class="tool-row"><span class="tool-symbol">${symbols[t]}</span><div><strong>${toolLabels[t]}</strong><small>${toolDescriptions[t]}</small><small>${users.length ? esc(users.join(', ')) : 'No agent has this tool'}${needs[t] ? ' · ' + needs[t] : ''}</small></div></div>`; }).join('')}</div><div class="inspector-section"><div class="section-heading">ROOM DOCUMENTS <span class="count">${docs.length}</span></div><p class="muted">Attached files are read automatically, with OCR for images and scanned pages, then split into passages and embedded. Agents get the most relevant passages with each message and can search for more.</p>${docs.map(d => `<div class="doc-row ${esc(d.status)}"><span class="tool-symbol">${icon('file')}</span><div><strong>${esc(d.name)}</strong><small>${esc(d.status === 'ready' ? `${docStatus(d)} · ${d.chars.toLocaleString()} characters · ${d.chunks} passages` : d.detail || d.status)}</small></div><button class="icon-button small" data-remove-doc="${esc(d.id)}" aria-label="Remove ${esc(d.name)}">${icon('close')}</button></div>`).join('')}<button class="outline-button" data-action="attachDocuments">${icon('attach')} Attach documents</button></div><div class="inspector-section"><div class="section-heading">LOCAL SPECIALISTS <span class="connection-dot ${ollama?.status || 'unchecked'}"></span></div><p class="muted">Local Ollama models read documents and build the search index. Installed models are selected automatically.</p><label class="model-field">Vision / OCR<select id="vision-model" ${busy ? 'disabled' : ''}>${options('vision')}</select></label><label class="model-field">Embeddings<select id="embedding-model" ${busy ? 'disabled' : ''}>${options('embedding')}</select></label><p class="fine-print">Models must already be installed in Ollama. Cloud models are excluded. Extracted text, OCR results and embeddings are cached on disk in this workspace's VS Code storage, so the same file is never processed twice.</p></div><div class="inspector-section"><div class="section-heading">CONNECTIONS</div>${state.connections.map(c => `<div class="connection-row"><span class="connection-dot ${c.status}"></span><div><strong>${names[c.id]}</strong><small>${esc(c.detail)}</small><small>${esc(c.modelSource || '')}</small></div></div>`).join('')}<button class="outline-button" data-action="refresh" ${state.discovering ? 'disabled' : ''}>${icon('refresh')} ${state.discovering ? 'Discovering…' : 'Refresh connections'}</button></div><p class="fine-print footnote">Codex may also use its native tools in a read-only sandbox. Chatroom tool switches control the tools listed above. Claude native tools are disabled.</p>`;
    } else {
      root.innerHTML = `<div class="inspector-section"><div class="section-heading">LIVE ACTIVITY <span class="count">${room.activity.length}</span></div><p class="muted">Agent turns, tool calls, and connection issues appear here.</p></div><div class="activity-list">${room.activity.length ? room.activity.slice().reverse().map(a => `<div class="activity-item ${a.kind}"><span class="activity-node"></span><div><p>${esc(a.text)}</p><time>${new Date(a.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div></div>`).join('') : '<div class="activity-empty">All quiet for now.<br>Your next idea gets things moving.</div>'}</div>`;
    }
    if (tab === 'usage') {
      root.querySelectorAll('.usage-agent').forEach((row, index) => {
        const u = room.usage[room.agents[index]?.id];
        const quota = document.createElement('p'); quota.className = 'fine-print quota-note';
        if (u?.quota) {
          const q = u.quota;
          quota.textContent = `Account remaining: ${(100 - q.primaryUsedPercent).toFixed(0)}% primary · ${(100 - q.secondaryUsedPercent).toFixed(0)}% secondary (as of ${new Date(q.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
          quota.title = `Primary window: ${q.primaryWindowMinutes ?? 'unknown'} minutes. Secondary window: ${q.secondaryWindowMinutes ?? 'unknown'} minutes. Provider-reported snapshot; not a live quota query.`;
        } else quota.textContent = 'Account quota: not reported';
        row.append(quota);
        if (u?.cacheWrite) { const line = document.createElement('p'); line.className = 'fine-print'; line.textContent = `${fmt(u.cacheWrite)} cache-write tokens`; row.append(line); }
      });
      const note = root.querySelector('.limits .fine-print');
      if (note) note.textContent = 'Optional safety stop. It counts new tokens, not cached re-reads, from when you send a message or press Resume. When the limit is reached, the agent finishes its answer without more tools and the room pauses; Resume continues. Account quota is shown only when the client reports it. ~ marks estimates.';
      for (const [id, u] of Object.entries(room.usage)) {
        if (room.agents.some(a => a.id === id)) continue;
        const row = document.createElement('div'); row.className = 'usage-agent';
        row.innerHTML = `<div class="usage-agent-name">${avatar({ provider: 'ollama' }, 'mini')}<span>${id === 'local-tools' ? 'Local specialists' : 'Removed agent'}</span><strong>${u.estimated ? '~' : ''}${fmt(u.input + u.output)}</strong></div><div class="usage-breakdown"><span>Input <b>${fmt(u.input)}</b></span><span>Output <b>${fmt(u.output)}</b></span></div><div class="usage-breakdown"><span>Requests <b>${fmt(u.requests)}</b></span></div>`;
        root.querySelectorAll('.inspector-section')[1]?.append(row);
      }
    }
  }
  let returnFocus;
  function openDialog(html) {
    returnFocus = document.activeElement;
    $('dialog-layer').hidden = false;
    $('dialog-layer').innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">${html}</section>`;
    $('dialog-layer').querySelector('input,select,button')?.focus();
  }
  function closeDialog() { $('dialog-layer').hidden = true; $('dialog-layer').replaceChildren(); editing = undefined; returnFocus?.focus(); }
  function editAgent(id) {
    const a = state.room.agents.find(agent => agent.id === id); if (!a) return;
    editing = id;
    const connection = state.connections.find(c => c.id === a.provider);
    const locked = state.room.status === 'running';
    openDialog(`<div class="dialog-heading">${avatar(a)}<div><h2 id="dialog-title">Agent settings</h2><p>${names[a.provider]}</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><form id="agent-form"><label>Display name<input id="agent-name" maxlength="40" value="${esc(a.name)}" ${locked ? 'disabled' : ''}></label><label>Model<select id="agent-model" ${locked ? 'disabled' : ''}>${modelOptions(a.provider, a.model)}</select></label><div id="reasoning-field">${reasoningField(a.provider, a.model, a.reasoning, locked)}</div><p class="field-help">${esc(connection?.modelSource || 'Refresh connections to discover models.')} · ${esc(connection?.version || '')}</p><label>Role<textarea id="agent-role" rows="3" maxlength="1600" ${locked ? 'disabled' : ''}>${esc(a.role)}</textarea></label><div class="section-heading dialog-tools-heading">TOOLS</div>${Object.keys(toolLabels).map(t => `<label class="tool-checkbox"><input type="checkbox" name="tool" value="${t}" ${a.tools.includes(t) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span><strong>${toolLabels[t]}</strong><small>${toolDescriptions[t]}</small></span></label>`).join('')}<div class="dialog-actions"><button type="button" class="text-button danger" data-remove="${esc(a.id)}" ${locked ? 'disabled' : ''}>Remove agent</button><button type="submit" class="primary-button" ${locked ? 'disabled' : ''}>Save agent</button></div>${locked ? '<p class="fine-print">Pause or stop the run to edit this agent.</p>' : ''}</form>`);
  }
  function modelOptions(provider, selected) {
    const models = state.connections.find(c => c.id === provider)?.models || [];
    return '<option value="">Automatic / client default</option>' + (selected && !models.some(m => m.id === selected) ? '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (saved)</option>' : '') + models.map(m => '<option value="' + esc(m.id) + '" ' + (selected === m.id ? 'selected' : '') + '>' + esc(m.name) + (m.remote ? ' · cloud' : '') + '</option>').join('');
  }
  function reasoningField(provider, model, selected, locked = false) {
    if (provider !== 'codex') return '';
    const info = state.connections.find(c => c.id === provider)?.models.find(m => m.id === model);
    const value = selected || info?.defaultReasoning || 'medium';
    return '<label>Reasoning effort<select id="agent-reasoning" ' + (locked ? 'disabled' : '') + '>' + (info?.reasoning || ['low', 'medium', 'high']).map(r => '<option ' + (r === value ? 'selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></label>';
  }
  function editDefaults() {
    openDialog(`<div class="dialog-heading"><div><h2 id="dialog-title">Models and defaults</h2><p>Set a model for each client and task.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><form id="defaults-form">${['planning', 'drafting', 'review'].map(p => `<fieldset><legend>${{ planning: 'Planning / orchestration', drafting: 'Drafting / general tasks', review: 'Review' }[p]}</legend>${Object.keys(names).map(provider => `<label>${names[provider]}<select data-default-preset="${p}" data-default-provider="${provider}">${modelOptions(provider, state.modelDefaults?.[p]?.[provider] || '')}</select></label>`).join('')}</fieldset>`).join('')}<label>Default task<select id="default-preset">${['planning', 'drafting', 'review'].map(p => `<option ${state.defaultPreset === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label>Default collaboration<select id="default-mode">${Object.entries(modeLabels).map(([value, label]) => `<option value="${value}" ${state.executionMode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Parallel agent limit<input id="default-concurrency" type="number" min="1" max="4" value="${state.maxParallelAgents || 3}"></label><p class="fine-print">Defaults apply to new rooms. Choose a task in the composer to apply its models to this room. In Lead + team, the parallel limit caps how many steps run at once.</p><div class="dialog-actions"><button type="button" class="text-button" data-action="settings">VS Code settings</button><button type="submit" class="primary-button">Save defaults</button></div></form>`);
  }
  function addAgent() {
    openDialog(`<div class="dialog-heading"><div><h2 id="dialog-title">Another perspective.</h2><p>Add a client to the conversation.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close">${icon('close')}</button></div><div class="provider-grid">${Object.keys(names).map(p => `<button data-provider="${p}">${avatar({ provider: p })}<span><strong>${names[p]}</strong><small>${p === 'ollama' ? 'Local & cloud models' : p === 'copilot' ? 'Models available in VS Code' : 'Your existing CLI login'}</small></span>${icon('plus')}</button>`).join('')}</div><p class="fine-print">You can add multiple agents from the same client, each with its own model, role, and tools.</p>`);
  }
  function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 7000); }
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.action) {
      const action = button.dataset.action;
      if (action === 'inspector') $('inspector').classList.toggle('expanded');
      else if (action === 'add') addAgent();
      else if (action === 'defaults') editDefaults();
      else if (action === 'close-dialog') closeDialog();
      else send(action);
    }
    if (button.dataset.edit) editAgent(button.dataset.edit);
    if (button.dataset.toggle) { const a = state.room.agents.find(a => a.id === button.dataset.toggle); send('agent', { id: a.id, enabled: !a.enabled }); }
    if (button.dataset.tab) { tab = button.dataset.tab; renderInspector(); saveDraft(); }
    if (button.dataset.provider) { send('addAgent', { provider: button.dataset.provider }); closeDialog(); }
    if (button.dataset.remove) { send('removeAgent', { id: button.dataset.remove }); closeDialog(); }
    if (button.dataset.removeDoc) send('removeDocument', { id: button.dataset.removeDoc });
    if (button.dataset.prompt) { $('prompt').value = button.dataset.prompt; $('prompt').focus(); saveDraft(); }
  });
  document.addEventListener('change', event => {
    const id = event.target.id;
    if (event.target.dataset.modelAgent) send('agent', { id: event.target.dataset.modelAgent, model: event.target.value });
    if (id === 'preset' || id === 'mode') send('options', { [id]: event.target.value });
    if (id === 'lead') send('options', { leadId: event.target.value });
    if (id === 'target') { target = event.target.value; updateComposer(); saveDraft(); }
    if (id === 'parallel-limit') send('options', { concurrency: Number(event.target.value) });
    if (id === 'agent-model') { const a = state.room.agents.find(a => a.id === editing); $('reasoning-field').innerHTML = reasoningField(a.provider, event.target.value); }
    if (id === 'rooms') send('switch', { id: event.target.value });
    if (id === 'rounds' || id === 'budget') send('options', { rounds: Number($('rounds').value), tokenBudget: Number($('budget').value) });
    if (id === 'vision-model' || id === 'embedding-model') send('localModels', { vision: $('vision-model').value, embedding: $('embedding-model').value });
  });
  document.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'composer') {
      const text = $('prompt').value.trim(); if (!text || state?.room.status === 'running' || pendingDraft) return;
      pendingDraft = text; send('send', { text, target: $('target').value }); $('prompt').value = ''; saveDraft(); nearBottom = true;
    }
    if (event.target.id === 'defaults-form') {
      const modelDefaults = { planning: {}, drafting: {}, review: {} };
      document.querySelectorAll('[data-default-preset]').forEach(el => { modelDefaults[el.dataset.defaultPreset][el.dataset.defaultProvider] = el.value; });
      send('saveDefaults', { modelDefaults, defaultPreset: $('default-preset').value, executionMode: $('default-mode').value, maxParallelAgents: Number($('default-concurrency').value) }); closeDialog();
    }
    if (event.target.id === 'agent-form') {
      send('agent', { id: editing, name: $('agent-name').value, model: $('agent-model').value, reasoning: $('agent-reasoning')?.value, role: $('agent-role').value,
        tools: [...document.querySelectorAll('input[name="tool"]:checked')].map(el => el.value) }); closeDialog();
    }
  });
  function saveDraft() { bridge.setState({ draft: $('prompt').value, tab, target }); }
  $('prompt').addEventListener('input', saveDraft);
  $('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
  $('messages').addEventListener('scroll', () => { const el = $('messages'); nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90; });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeDialog(); $('inspector').classList.remove('expanded'); }
    if (event.key === 'Tab' && !$('dialog-layer').hidden) {
      const focusable = [...$('dialog-layer').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('dialog-layer').addEventListener('click', event => { if (event.target === $('dialog-layer')) closeDialog(); });
  window.addEventListener('message', event => {
    if (event.data.type === 'state') { state = event.data; if (pendingDraft && state.room.messages.some(m => m.kind === 'user' && m.text === pendingDraft)) pendingDraft = ''; render(); }
    if (event.data.type === 'error') { if (pendingDraft && !$('prompt').value) { $('prompt').value = pendingDraft; saveDraft(); } pendingDraft = ''; toast(event.data.text); }
    if (event.data.type === 'attachment') { $('prompt').value = ($('prompt').value + event.data.text).slice(0, 24000); $('prompt').focus(); saveDraft(); }
  });
  send('ready');
})();
