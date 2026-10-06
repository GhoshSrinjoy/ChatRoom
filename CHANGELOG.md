# Changelog

## 0.3.2

Fixes from the agents' own reliability review of this workspace:

- Stopping or timing out a Codex/Claude turn can no longer hang the room. On macOS/Linux, the CLI runs in its own process group and the whole group is stopped. A CLI that ignores the stop request is force-killed after 2 seconds, and Chatroom stops waiting for its output after 2 more seconds.
- A CLI that exits while a helper process still holds its output no longer leaves the turn waiting forever.
- When a CLI prints a plain-text message instead of an answer (for example, a login error) and exits normally, the turn's error now shows that message instead of a generic one. Plain-text stdout is also used when a failing CLI writes nothing to stderr.
- `ELECTRON_RUN_AS_NODE` is set only when a JavaScript CLI runs through VS Code's own executable. Native CLIs, and the programs they start, no longer inherit it.

## 0.3.1

- Replace the room token budget with an optional **token limit per message**, off by default. The old 50,000-token budget covered the room's whole life, counted cached re-reads, and could be used up by a single Codex turn. The new limit counts only new tokens since the message was sent or resumed. Saved rooms that still have the old default are switched to no limit.
- When an agent reaches the limit mid-turn, it answers from the tool results it already has instead of failing and discarding its work. The room then pauses, and Resume continues.
- The Usage tab separates new tokens from cached re-reads and shows progress for the current message only when a limit is set.

## 0.3.0

- **Lead + team mode** (new default). A lead agent either answers directly or plans a graph of steps for the team. Independent steps run in parallel; dependent steps receive only the outputs they build on; the lead writes one final answer. Failed steps skip their dependents; pause, resume and stop work mid-plan; extra waves are allowed while rounds remain. The plan card shows stages and live step status.
- **1:1 chat**: choosing a single agent sends one direct turn with a one-on-one prompt.
- Agents now see the room roster (client, model, role, tools) and attached documents. Relay and parallel prompts tell agents to build on earlier replies instead of repeating them. `[CONSENSUS]` is shown as *agrees*.
- **Documents**: attach PDFs, Word files, images or text. Text layers are extracted, scanned pages and images go through local OCR, passages are chunked per page and embedded locally, and relevant passages are shared with every agent. New `search_documents` tool; `read_file` converts workspace documents automatically.
- Extracted text, OCR results and embeddings are cached on disk by content hash, and semantic search reuses them. Installed OCR and embedding models are selected automatically.
- GLM-OCR fence loops are cleaned up and treated as complete rather than partial.

## 0.2.1

- Register both current and legacy sidebar view IDs and activate at startup so restored Chatroom views can resolve after an upgrade.
- Register the webview message listener before loading its HTML.
- Add a real VS Code renderer test that waits for the agent controls, composer, and settings dialog, including restored windows.

## 0.2.0

- Open Chatroom in the right Secondary Side Bar, with VS Code theme colors and a compact chat layout.
- Discover the installed Codex and Claude extension runtimes and their model catalogs. Add per-agent model dropdowns and supported Codex reasoning choices; override incompatible inherited reasoning settings.
- Add Planning/orchestration, Drafting, and Review model defaults, plus sequential/parallel execution with a concurrency limit and live running/queued/failed counts.
- Execute Copilot native tool calls and preserve results across requests. Accept CLI tool actions following explanatory text, report failed agents, and stop only the affected agent's remaining turns.
- Exclude local project memory and development state from the installable extension.

## 0.1.0

Initial local release: activity-bar logo, responsive conversation UI, Codex/Claude/Copilot/Ollama adapters, bounded multi-agent rounds, usage accounting, workspace research tools, local OCR and semantic search, conversation persistence, and Markdown export.
