# CLAUDE.md — Orientation for Claude Code

You are working in **ARC**, an AI-native terminal & agent runtime. This file is your starting point. Read it first, then [docs/architecture.md](docs/architecture.md) for the deeper map.

## What ARC is

A Tauri (Rust) + React (TS) desktop app that aims to combine:

- A real PTY-backed terminal (xterm.js front, `portable-pty` back)
- An embedded code editor (CodeMirror 6)
- Multi-agent orchestration with background execution
- Local + cloud AI providers behind one interface

Phase 1 (current) ships an end-to-end **PTY terminal, file tree, CodeMirror editor, and streaming AI chat** (OpenAI / Anthropic / Ollama). Agent runtime, persistence, indexing, git introspection, and MCP are still scaffolded stubs.l

## Repo layout

```
apps/
  desktop/     Tauri shell. Rust crate that registers `pty_*`, `llm_*`, and
               `fs_*` commands and serves apps/frontend's build (or dev server)
               inside a window. Depends on the /rust/* crates.
  frontend/    React + Vite + TS app. Pure UI. Talks to Rust via Tauri
               `invoke` and `listen` (see src/lib/tauri.ts).

packages/      Pure-TS packages, linked via pnpm workspaces.
  shared/        Cross-package types.
  provider-sdk/  Provider interface (Provider, ChatRequest, ChatChunk). The
                 real streaming providers are Rust-side in `rust/ai-runtime`;
                 this contract is kept for any future TS-side fallback.
  terminal/      Reserved — placeholder until we extract terminal logic out of
                 apps/frontend.
  editor/        Reserved — same idea for the editor.
  agents/        Agent descriptors (TS side). Pairs with rust/agent-runtime.
  mcp/           Reserved — MCP client.
  ui/            Reserved — shared UI primitives.

rust/          Cargo workspace members consumed by apps/desktop.
  pty/             ✅ PtyManager — spawn/write/resize/kill, streams output via
                   tokio::sync::mpsc.
  ai-runtime/      ✅ Streaming chat providers (OpenAI, Anthropic, Ollama)
                   behind one `Provider` trait. Driven by `llm_*` commands.
  session-manager/ ✅ SQLite-backed `SessionStore` (sqlx) — workspaces, tabs,
                   chat history, command history, agent runs. DB at
                   `<data_dir>/arc/arc.db`. Driven by `session_*` commands.
  agent-runtime/   ✅ V0 — Anthropic tool-using coding agent with read-only
                   tools (`fs_read_file`, `fs_search`). `Tool` trait + multi-
                   step run loop. Write/exec tools + approval gating in V1.
  filesystem/      ✅ read_dir / read_file / write_file / pick_folder /
                   default_root / parent + a notify-backed recursive
                   Watcher (debounced ~150 ms) + walk-based content search.
                   Driven by `fs_*` commands; tantivy index swaps in later.
  git/             ✅ V0 status (branch, ahead/behind, dirty + counts) by
                   shelling out to `git status --porcelain=v2 --branch`.
                   Driven by `git_status`. gix-backed diff/blame/log later.

docs/          Architecture + decisions.
```

## Running it

```bash
pnpm install           # installs JS deps for all workspaces
pnpm tauri:dev         # boots Tauri → spawns vite → opens the window
```

Frontend-only (no Rust, no PTY):

```bash
pnpm dev               # opens http://127.0.0.1:5173 — UI only, anything that
                       # needs `invoke`/`listen` (PTY, fs, LLM) is gated off
                       # and chat falls back to a local echo stub
```

Type-check / sanity:

```bash
pnpm typecheck
cargo check --workspace
```

## Key conventions

- **Tauri command names**: `<area>_<verb>` snake_case. Today: `pty_*` (spawn/write/resize/kill), `llm_*` (stream/cancel), `fs_*` (default_root, parent, read_dir, pick_folder, read_file, write_file, watch_start, watch_stop, search), `session_*` (load, save_tabs, set_workspace, workspaces_list, workspace_upsert, workspace_delete, chat_load, chat_append, chat_clear, command_log, commands_recent), `git_status`, `secrets_*` (set_api_key, get_api_key, delete_api_key), `agent_run`, `mcp_*` (connect, list_tools, call_tool, disconnect).
- **Event topics**: `<area>://<verb>/<id>`, e.g. `pty://data/<uuid>`, `llm://chunk/<id>`, `llm://done/<id>`, `fs://change/<watchId>`. The frontend's `lib/tauri.ts` exposes typed wrappers — use those, don't hand-roll `invoke`/`listen` in components.
- **State**: Zustand stores in `apps/frontend/src/state/*` — one per concern (`workspace`, `chat`, `settings`, `files`). Components don't reach across stores. `workspace` and `chat` hydrate from SQLite via `session_*` and debounce-write on changes; `settings` and `files` persist to localStorage via `zustand/middleware`.
- **Styling**: Tailwind, dark-first. Theme tokens are in `apps/frontend/tailwind.config.ts` (`bg-base`, `fg-base`, `accent`, etc.). Don't hardcode hex colors in components.
- **Rust modules**: One feature per crate (`arc-pty`, `arc-agent-runtime`, ...). The desktop app *composes* them; it shouldn't grow business logic of its own.
- **Errors crossing the IPC boundary**: Map to `String` at the command layer. Internal Rust code uses `anyhow::Result`.

## What's stubbed vs. real

| Area              | Status         | Notes                                                                  |
| ----------------- | -------------- | ---------------------------------------------------------------------- |
| PTY → xterm.js    | ✅ real         | Default shell (COMSPEC on Win, SHELL elsewhere), resize, kill on close |
| Tabs / workspace  | ✅ real         | Tab state hydrates from SQLite on launch, debounce-writes on change.   |
| AI chat           | ✅ real         | OpenAI / Anthropic / Ollama streaming via `rust/ai-runtime`. Multi-session + agent personas (Chat Assistant / Task Planner / Sprint Planner / Review Agent / Code Explainer / Debug Buddy + custom agents). API keys in Settings (⌘,). Floating popover (⌘J), `⌘⇧N` new chat, `⌘⇧L` history, `⌘/` agent picker. Sessions persist to SQLite (`chat_conversations` + `chat_messages`); legacy localStorage entries auto-migrate on first launch. |
| Editor            | ✅ real         | CodeMirror 6, lazy-loaded per tab. Reads/writes via `fs_read_file` / `fs_write_file`; 5 MiB cap, refuses binaries. |
| File tree         | ✅ real         | Browse + open files, pick root via native dialog, click-to-paste paths into the active terminal. |
| Filesystem        | ✅ real (V0)   | `rust/filesystem` owns read/dir/file/dialog + a notify-backed recursive Watcher (debounced ~150 ms). FileTree subscribes for the current root and refreshes visible nodes on change. Tantivy index lands with memory/search. |
| Session persist   | ✅ real (V0)   | sqlx + SQLite via `rust/session-manager`. Workspaces, tabs, and chat history persist. `command_history` and `agent_runs` tables exist but aren't wired yet. |
| Agent runtime     | ✅ V1           | Anthropic tool-using coding agent via `/agent <goal>` in chat. Tools: `fs_read_file`, `fs_search`, `fs_write_file`, `shell` (30s default timeout, 16 KiB output cap). Mutating tools gate on an `Approver` — the runtime emits `ApprovalRequest`, the UI shows an inline Approve/Deny tray over the composer, and `agent_decide(approval_id, approve)` resolves the parked oneshot. Closing the popover auto-denies pending prompts. Persona prompt from the active UI agent is layered on top of the runtime's default prompt. Runs persisted to `agent_runs`. |
| Git introspection | ✅ real (V0)   | `rust/git` shells out to porcelain v2 for branch + ahead/behind + dirty counts. StatusBar shows the current branch with a dirty dot. Refreshes on root change. |
| Memory / search   | ⛔ stub        | SQLite + embeddings not started                                         |
| MCP, plugins      | ⛔ stub        | Placeholder packages                                                    |
| Bundling / icons  | ✅ real         | Icons regenerated from `apps/desktop/icons/source.png` via `@tauri-apps/cli icon`. |
| API key storage   | ✅ real         | Per-provider keys live in the OS credential vault via the `keyring` crate. `settings.ts` `partialize` strips them from localStorage; `hydrateSecrets()` migrates legacy keys on first launch. |
| Command history   | ✅ V0           | xterm input lines captured per-tab and persisted to `command_history` (no OSC 133, so output/exit codes are V1). ⌃R opens a fuzzy palette that pastes the selected command into the active terminal. |
| File search       | ✅ V0           | Walk-on-search across the workspace root via `fs_search`. Skips `node_modules`, `target`, `.git`, etc.; caps files at 256 KiB. ⌘P opens a results palette + a sidebar filter (Search icon in FileTree header). Tantivy index replaces the walk later. |
| MCP client        | ✅ V0           | Stdio-transport JSON-RPC client. `/mcp connect|list|call|disconnect` chat commands. Wiring into the agent runtime is V1. |

## Working in this repo

- Prefer editing existing files over creating new ones. New crates/packages should appear in `Cargo.toml` workspace members and `pnpm-workspace.yaml` first.
- When adding a new Tauri command, update both `apps/desktop/src/commands/<area>.rs` AND `apps/frontend/src/lib/tauri.ts` so the typed wrapper stays in sync.
- Run `pnpm typecheck && cargo check --workspace` before finishing a change.
- The default shell on Windows is `cmd.exe` via `COMSPEC`. If you want PowerShell, pass `shell: "powershell.exe"` to `pty_spawn`.

## Reading order for new contributors

1. This file
2. `docs/architecture.md` — component map + IPC contract
3. `docs/decisions.md` — why we chose Tauri/Zustand/etc., recorded as ADRs
4. `apps/frontend/src/components/Terminal.tsx` + `rust/pty/src/lib.rs` — the PTY round-trip in ~90 lines per side
5. `apps/frontend/src/components/ChatPanel.tsx` + `rust/ai-runtime/src/lib.rs` — the streaming-LLM round-trip
6. `apps/frontend/src/components/Editor.tsx` + `apps/desktop/src/commands/fs.rs` — the editor + filesystem round-trip
