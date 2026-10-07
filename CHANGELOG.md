# Changelog

## 0.5.1

- Copilot CLI: a model that the CLI lists twice (1.0.92 lists "Auto" twice on accounts that only have Auto) now appears once. Verified live: signing in, a native session that remembers across turns, and usage reporting.
- README: every screenshot now sits in the section it shows, with a caption. New screenshots of agent settings, the Team and Loop chips, and an agent that can't run. New section on several agents editing the same files and where each CLI runs commands (sandboxes).

## 0.5.0

- **Your own team.** A new **Custom team** mode runs the stages you set up, in order, for example Leads → Drafting → Review → Testing → Coding:
  - Each stage has one or more agents, who answer together or one after another, plus an optional task and optional model routing (Planning, Drafting or Review models). The agent's own model setting does not change.
  - A lead stage sets up the work for the later stages, or answers directly with `[DONE]`. The lead can write the final answer.
  - Set teams up in the new team builder (Team chip, Room setup, Models and defaults), in the `chatroom.teams` setting, or with `/team`: an inline team, a saved name, `save`, `edit`, `off`.
  - Three templates: Lead, draft, review · Build and test · Draft and review.
  - Messages show their stage (`Review · 3/4`) and the footer shows the current stage.
- **Agents that can't run are shown and skipped.**
  - Out of usage (until the reset time the CLI reports), a model that isn't available, a CLI that isn't installed or is signed out, and Ollama not running are recognized.
  - The agent's pill says why; the room posts one notice and continues with the others.
  - Team-mode leads, plan steps and custom-team stages move to an available agent, which is told it is standing in. Hand-offs to such an agent are skipped. Loops keep going.
  - **Try again now** in the agent's settings clears the mark.
- `/mode custom`, `/status` shows unavailable agents, and the `executionMode` setting accepts `pipeline`.

## 0.4.0

The agents are now the real CLIs, working together in one room.

- **Native CLIs.** Claude Code runs as a long-lived `claude` process in stream-json mode, Codex as one `codex app-server` per window, and Copilot as `copilot --acp` when the Copilot CLI is installed (otherwise it stays a VS Code chat model). Each keeps its own tools, skills, slash commands, MCP servers, `CLAUDE.md`/`AGENTS.md`, hooks and native session, which resumes after a reload.
- **Delta delivery.** Each agent receives only the room messages it has not seen; its own replies are already in its session. New or lost sessions get a bounded copy of the room history once. The long protocol prompt and the default personas are gone: a short room framing is appended to each CLI's own system prompt.
- **Permissions and approvals.** Per agent: Plan, Ask (default), Auto-edit or Full access, mapped to each CLI's own modes. Approval requests appear as cards in the room and are denied after a timeout. Full access needs `chatroom.allowFullAccess` and a confirmation. Agents that edit run one at a time.
- **Teamwork.** A line starting with `@Name` hands the next turn to that agent, within a hop cap. Team mode accepts mention lines as well as step plans. Messages that start with `@Agent` go to just those agents.
- **Loops.** Rounds, until consensus (`[AGREE]`), until the lead says done (`[DONE]`), or every few minutes, with iteration, time and token caps. `/loop` sets them.
- **Composer.** `@` mentions, `/` room and native commands, chips for team mode, loops, permissions and effort, think-harder and Ultra toggles, a context ring, and the open file and selection as context.
- **Shared skills and room tools.** Skills are shared between the CLIs; four room tools reach native agents through MCP or Codex dynamic tools. `chatroom.sharedMcpServers` gives every native agent extra MCP servers.
- **Room commands:** `/help`, `/clear`, `/compact`, `/new`, `/export`, `/loop`, `/mode`, `/lead`, `/model`, `/effort`, `/permissions`, `/status`, `/stop`.
- **Timeouts.** The turn timeout now measures inactivity (default 300 s) and does not count time spent waiting for approval. Stop sends each CLI's own interrupt first.
- **New settings:** `copilotPath`, `attachOpenFile`, `defaultPermission`, `allowFullAccess`, `approvalTimeoutSeconds`, `idleSessionMinutes`, `shareSkills`, `sharedMcpServers`, `maxHandoffs`, `copilotUseEnvToken`. New command: **Chatroom: Sign in to Copilot CLI**.
- **Review fixes.**
  - Team mode: when the lead cannot run (for example, Codex at its usage limit), the next enabled agent leads that message. A lead whose CLI is missing hands the lead to an agent that is ready.
  - Every unseen message reaches a native session in full. A Stop after the CLI received a message no longer sends that message again, and step outputs a dependent step received are not sent to that agent again.
  - Codex: turning MCP off no longer breaks every turn (the built-in apps server is turned off with `features.apps`). Option changes reach a running thread. "Default" model and effort follow your Codex config. Sub-agent approvals and room-tool calls reach their parent turn. Approval cards always show the exact command.
  - Claude: "Allow for session" no longer raises an agent to Auto-edit or writes settings files. Only the four room tools are auto-allowed. `/compact` on a session that cannot be resumed no longer starts an empty one, and its tokens are counted. The first turn reuses the process that loaded capabilities.
  - Copilot: room-tool trust comes only from the CLI's own metadata. Auto-edit allows reads and edits only inside the workspace and extra folders, and network requests always ask. Ultra puts `/fleet` at the start of the message.
  - Full-access, default-permission, shared-MCP and Copilot token settings are read from user settings only.
  - `/loop every …` is no longer cut short by the default 60-minute cap. A loop with no agent turned on stops instead of failing. A new message ends a paused plan. A Codex sandbox override can only tighten what the permission level allows, so it can no longer turn Ask into Auto-edit.
  - Large rooms broadcast less often while streaming and are saved at least every 5 seconds.
- **Migration.** Saved rooms move to schema 5: default personas are cleared, Rounds become a rounds loop, Codex reasoning becomes the agent's effort, and pending approvals are marked expired. Agents start fresh native sessions with the room's recent history.

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
