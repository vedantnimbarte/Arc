# CLAUDE.md — Orientation for Claude Code

You are working in **ARC**, an AI-native terminal & agent runtime. This file is your starting point. Read it first, then [docs/architecture.md](docs/architecture.md) for the deeper map.

## What ARC is

A Tauri (Rust) + React (TS) desktop app that aims to combine:

- A real PTY-backed terminal (xterm.js front, `portable-pty` back)
- An embedded code editor (CodeMirror 6)
- Multi-agent orchestration with background execution
- Local + cloud AI providers behind one interface

Phase 1 (current) ships an end-to-end **PTY terminal, file tree, CodeMirror editor, streaming AI chat** (OpenAI / Anthropic / Ollama), **tool-using coding agent**, **SQLite-backed persistence**, **tantivy-indexed file search**, **git introspection** (status/log/diff/blame), and an **MCP client** (stdio + Streamable HTTP). See the status table below for the per-area state.

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
  terminal/      Exports the graphite `XTERM_THEME` consumed by
                 `apps/frontend/src/components/Terminal.tsx`. Reserved for
                 the React shell once we need a second consumer.
  editor/        Exports `pathToLanguageId(path)` — the pure extension→id
                 mapping the Editor uses for its lazy lang-* imports.
                 Reserved for the CodeMirror wrapper itself later.
  agents/        Agent descriptors (TS side). Pairs with rust/agent-runtime.
  mcp/           Shared TS types for the MCP client (`McpTool`,
                 `McpNotification`, known notification methods + log /
                 progress param shapes). Re-exported from
                 `apps/frontend/src/lib/tauri.ts`.
  ui/            Exports the Catppuccin Mocha palette (`MOCHA`) so the
                 editor + file tree share one colour reference.

rust/          Cargo workspace members consumed by apps/desktop.
  pty/             ✅ PtyManager — spawn/write/resize/kill, streams output via
                   tokio::sync::mpsc.
  ai-runtime/      ✅ Streaming chat providers (OpenAI, Anthropic, Ollama)
                   behind one `Provider` trait. Driven by `llm_*` commands.
  session-manager/ ✅ SQLite-backed `SessionStore` (sqlx) — workspaces, tabs,
                   chat history, command history, agent runs, and memory
                   (FTS5-indexed notes). DB at `<data_dir>/arc/arc.db`.
                   Driven by `session_*` + `memory_*` commands.
  agent-runtime/   ✅ V2 — Anthropic tool-using coding agent. Built-in tools:
                   `fs_read_file`, `fs_list_dir`, `fs_search`, `fs_write_file`,
                   `fs_edit`, `shell`, `git_status`, `git_log`, `git_diff`,
                   `memory_save`, `memory_search`. Mutating tools are
                   approval-gated; MCP tools bridge in automatically.
  filesystem/      ✅ read_dir / read_file / write_file / pick_folder /
                   default_root / parent + a notify-backed recursive
                   Watcher (debounced ~150 ms) + tantivy-backed `fs_search`
                   (falls back to a walk when no index has been built).
                   Driven by `fs_*` commands.
  git/             ✅ V1 — `status` (porcelain v2), plus `log`, `diff` (worktree
                   / staged / head), and `blame` (porcelain). All shell out to
                   git. Tauri commands: `git_status`, `git_log`, `git_diff`,
                   `git_blame`.
  git-host/        ✅ V1 — GitHost trait + GitHubHost impl (reqwest, PAT
                   in keyring). PRs: list/get/create. Comments + merge
                   intentionally deferred.
  project-config/  ✅ V0 — TOML loader for `<workspace>/.arc/config.toml`
                   (schema v1: workspace/env/agents/mcp_servers/terminal/theme).
                   Tauri command `project_config_load` returns `null` when
                   the file is absent. Consumers wire in per-tier.
  ssh/             ✅ V1 — pure-Rust SSH client built on `russh`. SshManager
                   mirrors PtyManager (DashMap of sessions, data/log/exit
                   channels). `generate_key` + `load_key_metadata` use
                   `ssh-key` for OpenSSH keypair generation, fingerprinting,
                   and import. Server keys are trust-on-first-use in V1.
                   Tauri commands: `ssh_connect`, `ssh_write`, `ssh_resize`,
                   `ssh_close`, `ssh_host_*`, `ssh_key_*`, `ssh_session_logs`.

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

- **Tauri command names**: `<area>_<verb>` snake_case. Today: `pty_*` (spawn/write/resize/kill/list_shells), `llm_*` (stream/cancel), `fs_*` (default_root, parent, read_dir, pick_folder, read_file, write_file, watch_start, watch_stop, search, index_rebuild, index_status), `session_*` (load, save_tabs, set_workspace, workspaces_list, workspace_upsert, workspace_delete, chat_load, chat_append, chat_clear, command_log, commands_recent, command_finish), `git_*` (status, log, diff, blame), `secrets_*` (set_api_key, get_api_key, delete_api_key), `ssh_*` (connect, write, resize, close, host_list, host_upsert, host_delete, key_list, key_generate, key_import, key_delete, session_logs), `agent_run`, `mcp_*` (connect, connect_http, list_tools, call_tool, disconnect), `memory_*` (save, update, delete, get, list, search, embed_entry, vector_search), `project_config_load`, `git_worktree_*` (list, add, remove), `git_rebase_*` (interactive, abort, continue), `git_host_*` (detect, token_set/get/delete, pr_list, pr_get, pr_create).
- **Event topics**: `<area>://<verb>/<id>`, e.g. `pty://data/<uuid>`, `llm://chunk/<id>`, `llm://done/<id>`, `ssh://data/<id>`, `ssh://log/<id>`, `ssh://exit/<id>`, `fs://change/<watchId>`. The frontend's `lib/tauri.ts` exposes typed wrappers — use those, don't hand-roll `invoke`/`listen` in components.
- **State**: Zustand stores in `apps/frontend/src/state/*` — one per concern (`workspace`, `chat`, `settings`, `files`). Components don't reach across stores. `workspace` and `chat` hydrate from SQLite via `session_*` and debounce-write on changes; `settings` and `files` persist to localStorage via `zustand/middleware`.
- **Styling**: Tailwind, dark-first. Theme tokens are in `apps/frontend/tailwind.config.ts` (`bg-base`, `fg-base`, `accent`, etc.). Don't hardcode hex colors in components.
- **Rust modules**: One feature per crate (`arc-pty`, `arc-agent-runtime`, ...). The desktop app *composes* them; it shouldn't grow business logic of its own.
- **Errors crossing the IPC boundary**: Map to `String` at the command layer. Internal Rust code uses `anyhow::Result`.

## What's stubbed vs. real

| Area              | Status         | Notes                                                                  |
| ----------------- | -------------- | ---------------------------------------------------------------------- |
| PTY → xterm.js    | ✅ real         | Default shell (COMSPEC on Win, SHELL elsewhere); resize; kill on close. Settings → Terminal exposes a picker over `pty_list_shells` (discovers cmd / powershell / pwsh / bash / nu / wsl on Windows, bash / zsh / fish / nu / sh elsewhere) plus a custom-path field; choice persists as `defaultShell` and applies to newly-opened tabs. |
| Tabs / workspace  | ✅ real         | Tab state hydrates from SQLite on launch, debounce-writes on change.   |
| AI chat           | ✅ real         | OpenAI / Anthropic / Ollama streaming via `rust/ai-runtime`. Multi-session + agent personas (Chat Assistant / Task Planner / Sprint Planner / Review Agent / Code Explainer / Debug Buddy + custom agents). API keys in Settings (⌘,). Floating popover (⌘J), `⌘⇧N` new chat, `⌘⇧L` history, `⌘/` agent picker. Sessions persist to SQLite (`chat_conversations` + `chat_messages`); legacy localStorage entries auto-migrate on first launch. |
| Editor            | ✅ real         | CodeMirror 6, lazy-loaded per tab. Reads/writes via `fs_read_file` / `fs_write_file`; 5 MiB cap, refuses binaries. |
| File tree         | ✅ real         | Browse + open files, pick root via native dialog, click-to-paste paths into the active terminal. |
| Filesystem        | ✅ real (V0)   | `rust/filesystem` owns read/dir/file/dialog + a notify-backed recursive Watcher (debounced ~150 ms). FileTree subscribes for the current root and refreshes visible nodes on change. Tantivy index lands with memory/search. |
| Session persist   | ✅ V1          | sqlx + SQLite via `rust/session-manager`. Workspaces, tabs, chat history, command history (with exit codes when OSC 133 is available), and agent runs all persist. |
| Filesystem        | ✅ V1          | `rust/filesystem` owns read/dir/file/dialog + a notify-backed recursive Watcher (debounced ~150 ms) + a tantivy-backed full-text index (`fs_index_rebuild`/`fs_index_status`) used by `fs_search`. Falls back to the V0 walk when no index has been built for the current root. |
| Agent runtime     | ✅ V2          | Anthropic tool-using coding agent via `/agent <goal>` in chat. Built-in tools: `fs_read_file`, `fs_list_dir`, `fs_search`, `fs_write_file`, `fs_edit` (surgical find/replace), `shell` (30s default timeout, 16 KiB output cap), `git_status`, `git_log`, `git_diff`, `memory_save`, `memory_search`. Plus every tool from each connected MCP server, exposed as `mcp__<server>__<tool>` (sanitized, capped at 64 chars; budget of 32 MCP tools per run). All mutating tools — including every MCP call — gate on an `Approver`: the runtime emits `ApprovalRequest`, the UI shows an inline Approve/Deny tray over the composer, and `agent_decide(approval_id, approve)` resolves the parked oneshot. Closing the popover auto-denies pending prompts. Persona prompt from the active UI agent is layered on top of the runtime's default prompt. Runs persisted to `agent_runs`. |
| Git introspection | ✅ V1          | `rust/git` shells out to git for `status` (porcelain v2 — branch, ahead/behind, dirty counts), `log` (custom-formatted entries), `diff` (worktree / staged / head, optional path filter), and `blame` (porcelain). StatusBar shows the current branch with a dirty dot. |
| Git worktrees     | ✅ V1          | `rust/git` parses `git worktree list --porcelain` into `WorktreeEntry`; `worktree_add` and `worktree_remove` shell out with standard flags. `<WorktreePanel>` lists every worktree with branch + HEAD + locked/prunable badges, supports add (new or existing branch, optional start-point, native folder picker) and remove with a confirm + force escape hatch. Reachable from the ⌘K palette as "Manage Worktrees" — clicking "switch" reroots the file tree onto that worktree. |
| Cherry-pick UI    | ✅ V1          | `<CherryPickDialog>` opens from the commit list's branch-icon action: picks a target branch (filterable list), does `git checkout <target>` then `git cherry_pick <oid>`. Conflict path surfaces stderr inline and points the user at the diff view + `git cherry-pick --continue`. The existing scissors action (cherry-pick onto current HEAD) is preserved. |
| Interactive rebase| ✅ V1          | `rust/git::rebase_interactive` runs `git rebase -i <base>` with a pre-built TODO file injected via a helper script as `GIT_SEQUENCE_EDITOR`; `GIT_EDITOR` is a no-op so squash/fixup combined-message dialogs accept their defaults. `<RebasePanel>` shows the last N commits (oldest-first, configurable 1–50), up/down to reorder, per-row action picker (pick / squash / fixup / drop). Reword + edit are deferred — UI nudges users toward `git commit --amend` after. Conflict path shows abort/continue affordances; helper temp dir cleans up on completion. |
| Git host (GitHub) | ✅ V1          | New `rust/git-host` crate. `GitHost` trait + `GitHubHost` impl uses `reqwest` directly (no octocrab). Auth: PAT in OS keychain under `dev.arc.terminal.git-host`. `<PrPanel>` has three views — list (open/closed/all + filter), detail (title/body + commits + per-file diff with patch preview), create (head/base pickers, title, body, draft). One-time token-entry pane shows when no PAT is set. Origin URL is auto-detected via `git remote get-url origin`; non-github remotes show a friendly empty state. Comments, reviews, line threads, and merge button are intentionally deferred. |
| SSH client        | ✅ V1          | Pure-Rust SSH via `russh`. `<SshPanel>` (⌘⇧S) manages saved hosts + keys; connecting a host opens a `kind: 'ssh'` tab whose xterm is wired to `ssh_write` / `onSshData` / `ssh_resize`. Per-step handshake events flow on `ssh://log/<id>` and drive a 6-dot connecting overlay + an optional `<SshSessionLogDrawer>`. Keys are referenced by on-disk path (`~/.ssh/...`); passphrases live in the OS keyring under `dev.arc.terminal.ssh`. `ssh_key_generate` writes ed25519/rsa keypairs in OpenSSH format with `ssh-key`. Hosts + keys + per-session logs persist via migration 0010. Server keys are auto-accepted in V1 — known_hosts UI comes later. |
| Memory / search   | ✅ V1          | Workspace-scoped notes via `arc-session-manager::memory`. Keyword path: `memory_entries` + FTS5 (`memory_fts`) with porter-unicode61 tokenizer + bm25 scoring. Vector path: `embedding` BLOB column + `embedding_model` (migration 0004) holds an OpenAI / Ollama embedding, and `memory_vector_search` ranks by cosine similarity. `arc_ai_runtime::embed` is the shared helper. Tauri `memory_*` commands and `/memory save\|search\|list\|delete` chat slash command. |
| Reserved packages | ✅ partial     | `packages/ui` exports the `MOCHA` palette; `packages/terminal` exports `XTERM_THEME`; `packages/editor` exports `pathToLanguageId`; `packages/mcp` exports the shared MCP types (`McpTool`, `McpNotification`, log/progress param shapes). All four are imported by `apps/frontend`. The React components themselves still live in `apps/frontend` until a second consumer needs them. |
| Bundling / icons  | ✅ real         | Icons regenerated from `apps/desktop/icons/source.png` via `@tauri-apps/cli icon`. |
| API key storage   | ✅ real         | Per-provider keys live in the OS credential vault via the `keyring` crate. `settings.ts` `partialize` strips them from localStorage; `hydrateSecrets()` migrates legacy keys on first launch. |
| Command history   | ✅ V1          | xterm input lines captured per-tab and persisted to `command_history`. When the shell emits OSC 133 (`A`/`B`/`C`/`D[;exit]`), the matching row's `exit_code`, `finished_at`, and a 4 KiB `output_excerpt` are filled in by `session_command_finish`. ⌃R opens a fuzzy palette that pastes the selected command into the active terminal. |
| File search       | ✅ V1          | tantivy-backed BM25 index at `<data_dir>/arc/index/<hash>/`. `fs_search` prefers the index when built; otherwise it falls back to the walker (same skip-list, 256 KiB cap). ⌘P opens a results palette + a sidebar filter (Search icon in FileTree header). |
| MCP client        | ✅ V2          | Two transports behind one `Transport` trait: stdio (`Content-Length` framed JSON-RPC, owned by a background reader task that demuxes responses from notifications) and HTTP/SSE (Streamable HTTP, 2025-03-26 — notifications interleaved on a request's SSE stream are forwarded too). `/mcp connect\|list\|call\|disconnect` chat commands. `mcp_connect_http(id, url, headers?)` wires up remote servers. Connected servers' tools bridge into `/agent` automatically (see Agent runtime row). Server-initiated JSON-RPC notifications are emitted on `mcp://notification/<server_id>`; subscribe via `onMcpNotification(id, ...)`. |
| Command palette   | ✅ V1          | Unified ⌘K action dispatcher via `useCommands` (`apps/frontend/src/state/commands.ts`). `CommandPalette.tsx` renders fuzzy-filtered actions grouped by `CommandGroup`; existing shortcut handlers in App.tsx auto-seed 16 actions from `ACTION_META`. The legacy ⌃R command-history palette moved to `CommandHistoryPalette.tsx`. Future features register their own actions with `useCommands.getState().register({ … })`. |
| Themes            | ✅ V1          | CSS-variable theme tokens in `apps/frontend/src/themes/index.ts`. Four built-ins: dark, light, Catppuccin Mocha, Catppuccin Latte. `THEMES` registry + `registerTheme(theme)` + `validateThemeJson(json)` cover Tier 1.7 marketplace consumption. Settings → Appearance grows a "Theme" picker; `themeId` persists alongside `appearance` and (when set) overrides the dark/light resolution. `resolveActiveTheme(appearance, themeId)` is the call site for new code. |
| Project config    | ✅ V0          | `rust/project-config` parses `.arc/config.toml` (schema v1: workspace meta, env, agents, mcp_servers, terminal.default_shell, theme.id). Tauri command `project_config_load` returns `null` when the file is missing — that's the common case. `useProjectConfig` (state/projectConfig.ts) subscribes to file-tree root changes and refetches automatically. Consumers (env injection into PTY, auto-MCP-connect, agent registration) wire in incrementally — V0 ships the load path only. |
| Command blocks    | ✅ V0          | OSC 133 capture in `Terminal.tsx` pushes per-command blocks into `useBlocks` (state/blocks.ts) — command, start/finish timestamps, exit code, 4 KiB output excerpt. `BlocksDrawer.tsx` floats over the bottom of each terminal pane, listing blocks with per-row copy-output / rerun / "Ask ARC" actions. Toggle chip top-right of the pane; also reachable from the ⌘K palette as "Toggle Command Blocks". Shells without shell-integration produce no blocks (drawer shows a hint instead). |

## Working in this repo

- Prefer editing existing files over creating new ones. New crates/packages should appear in `Cargo.toml` workspace members and `pnpm-workspace.yaml` first.
- When adding a new Tauri command, update both `apps/desktop/src/commands/<area>.rs` AND `apps/frontend/src/lib/tauri.ts` so the typed wrapper stays in sync.
- Run `pnpm typecheck && cargo check --workspace` before finishing a change.
- The default shell on Windows is `cmd.exe` via `COMSPEC`. Users override this from Settings → Terminal (picker over `pty_list_shells` + custom-path field). To force a specific shell from code, pass `shell: "powershell.exe"` directly to `pty_spawn`.

## Reading order for new contributors

1. This file
2. `docs/architecture.md` — component map + IPC contract
3. `docs/decisions.md` — why we chose Tauri/Zustand/etc., recorded as ADRs
4. `apps/frontend/src/components/Terminal.tsx` + `rust/pty/src/lib.rs` — the PTY round-trip in ~90 lines per side
5. `apps/frontend/src/components/ChatPanel.tsx` + `rust/ai-runtime/src/lib.rs` — the streaming-LLM round-trip
6. `apps/frontend/src/components/Editor.tsx` + `apps/desktop/src/commands/fs.rs` — the editor + filesystem round-trip
