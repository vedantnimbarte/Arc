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
  lsp/             ✅ V1 — LspManager spawns language servers and drives them
                   over Content-Length framed JSON-RPC on stdio (mirrors the
                   MCP stdio transport). initialize/initialized handshake,
                   full-text didOpen/didChange/didClose, and hover/completion/
                   definition requests. publishDiagnostics + other server
                   notifications forward to the host via an `LspEvent` channel.
                   Tauri commands: `lsp_*`.
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

- **Tauri command names**: `<area>_<verb>` snake_case. Today: `pty_*` (spawn/write/resize/kill/list_shells), `llm_*` (stream/cancel), `fs_*` (default_root, parent, read_dir, pick_folder, read_file, write_file, watch_start, watch_stop, search, index_rebuild, index_status), `session_*` (load, save_tabs, set_workspace, workspaces_list, workspace_upsert, workspace_delete, chat_load, chat_append, chat_clear, command_log, commands_recent, command_finish), `git_*` (status, log, diff, blame, changes, root), `secrets_*` (set_api_key, get_api_key, delete_api_key), `ssh_*` (connect, write, resize, close, host_list, host_upsert, host_delete, key_list, key_generate, key_import, key_delete, session_logs), `agent_run`, `agent_decide`, `agent_worktree_discard`, `lsp_*` (start, did_open, did_change, did_close, hover, completion, definition, stop, is_running), `mcp_*` (connect, connect_http, list_tools, call_tool, disconnect), `memory_*` (save, update, delete, get, list, search, embed_entry, vector_search), `project_config_load`, `git_worktree_*` (list, add, remove), `git_rebase_*` (interactive, abort, continue), `git_host_*` (detect, token_set/get/delete, pr_list, pr_get, pr_create).
- **Event topics**: `<area>://<verb>/<id>`, e.g. `pty://data/<uuid>`, `llm://chunk/<id>`, `llm://done/<id>`, `ssh://data/<id>`, `ssh://log/<id>`, `ssh://exit/<id>`, `fs://change/<watchId>`, `lsp://event/<sessionId>`. The frontend's `lib/tauri.ts` exposes typed wrappers — use those, don't hand-roll `invoke`/`listen` in components.
- **State**: Zustand stores in `apps/frontend/src/state/*` — one per concern (`workspace`, `chat`, `settings`, `files`). Components don't reach across stores. `workspace` and `chat` hydrate from SQLite via `session_*` and debounce-write on changes; `settings` and `files` persist to localStorage via `zustand/middleware`.
- **Styling**: Tailwind, dark-first. Theme tokens are in `apps/frontend/tailwind.config.ts` (`bg-base`, `fg-base`, `accent`, etc.). Don't hardcode hex colors in components.
- **Rust modules**: One feature per crate (`arc-pty`, `arc-agent-runtime`, ...). The desktop app *composes* them; it shouldn't grow business logic of its own.
- **Errors crossing the IPC boundary**: Map to `String` at the command layer. Internal Rust code uses `anyhow::Result`.

## What's stubbed vs. real

| Area              | Status         | Notes                                                                  |
| ----------------- | -------------- | ---------------------------------------------------------------------- |
| PTY → xterm.js    | ✅ real         | Default shell (COMSPEC on Win, SHELL elsewhere); resize; kill on close. Settings → Terminal exposes a picker over `pty_list_shells` (discovers cmd / powershell / pwsh / bash / nu / wsl on Windows, bash / zsh / fish / nu / sh elsewhere) plus a custom-path field; choice persists as `defaultShell` and applies to newly-opened tabs. |
| Tabs / workspace  | ✅ real         | Tab state hydrates from SQLite on launch, debounce-writes on change. Per-pane strip (`PaneTabStrip`) renders kind-specific icons on wider pills. Chrome-style **tab groups**: contiguous tabs wrap in a collapsible colour-coded container with an editable name + 8-colour palette (`lib/tabGroups.ts`, `TabGroupMenu`). Group metadata + membership ride inside the existing `pane_layout` JSON envelope (no Rust/SQLite migration); a group is confined to one leaf and a tab leaves its group when dragged to another pane. |
| AI chat           | ✅ real         | OpenAI / Anthropic / Ollama streaming via `rust/ai-runtime`. Multi-session + agent personas (Chat Assistant / Task Planner / Sprint Planner / Review Agent / Code Explainer / Debug Buddy + custom agents). API keys in Settings (⌘,). Floating popover (⌘J), `⌘⇧N` new chat, `⌘⇧L` history, `⌘/` agent picker. Sessions persist to SQLite (`chat_conversations` + `chat_messages`); legacy localStorage entries auto-migrate on first launch. |
| Editor            | ✅ real         | CodeMirror 6, lazy-loaded per tab. Reads/writes via `fs_read_file` / `fs_write_file`; 5 MiB cap, refuses binaries. Multi-cursor (Alt-click, ⌘D, Alt-drag rectangular) always on; opt-in Vim mode (`editorVimMode` setting, lazy `@replit/codemirror-vim`, Settings → Editor). |
| Inline AI edit    | ✅ V1          | ⌘K in the editor opens `<InlineEditPanel>`: type an instruction, the selection (or current line) streams through the active chat provider, and the result shows as a line-diff with accept/discard/retry. Pure prompt/fence/diff helpers in `lib/inlineEdit.ts` (vitest). Intercepted via a CM `domEventHandler` that stopPropagation's so it doesn't also open the palette. Toggle `editorInlineAi` (default on), Settings → Editor. |
| LSP               | ✅ V1          | `rust/lsp` (LspManager, stdio JSON-RPC) + `lsp_*` commands. Frontend `lib/lspServers.ts` (CM-language → server registry: TS/JS, Rust, Python, Go, C/C++) + `lib/lspClient.ts` (URI/position/severity/completion mapping — vitest — plus `attachLsp`). Editor wires diagnostics (lint squiggles + gutter), hover tooltips, and an LSP completion source through a compartment; debounced didChange, didClose on teardown. Opt-in `editorLsp` (default off — needs servers on PATH); missing servers degrade to a plain editor. |
| Agent worktrees   | ✅ V1          | `/agent --worktree` (or `-w`) runs the coding agent in an isolated git worktree on an `arc/agent-<id>` branch so edits don't touch the live tree until reviewed. Worktree path/branch persist on the run (`agent_runs` migration 0013); `<AgentsView>` surfaces them with "review changes" (reroots the file tree) + a confirm-gated discard (`agent_worktree_discard` — removes the worktree + branch, repo root derived via git). Approval cards render a compact line-diff for `fs_edit` / `fs_write_file` so the user sees the change before approving. |
| File tree         | ✅ real         | Browse + open files, pick root via native dialog, click-to-paste paths into the active terminal. Git decorations: colored porcelain status letter on changed files + amber dot on collapsed dirty folders (via `git_root` + the git store's abs-path map), refreshed by the Sidebar's fs-watcher (sees `.git/` churn too) with a slow backstop poll. |
| Terminal links    | ✅ V1 (Tier 1.1) | `lib/links.ts` xterm LinkProvider turns file paths (`path`, `./rel`, `C:\abs`, optional `:line:col`) in output into clickable links that open in the editor; URLs stay with the web-links addon. A parsed `:line` scrolls the editor to and selects that line (via the `reveal` store, which works for both freshly-opened and already-open tabs). |
| New-tab splash    | ✅ V1 (Tier 1.2) | `<NewTabSplash>` over a fresh terminal: recent commands (click pastes, no auto-run) + recent files (`recentFiles` in files store; click opens). Dismisses on first interaction. |
| Smart paste       | ✅ V1 (Tier 1.4) | Terminal intercepts paste in capture phase; `detectRiskyPaste` flags multi-line / `sudo` / `rm -rf` / `curl\|sh` / `chmod -R` / `dd`; `<PasteWarning>` confirm tray (`usePaste` store). Shift-paste bypasses. |
| Long-cmd notify   | ✅ V1 (Tier 1.5) | `tauri-plugin-notification`; OSC133-tracked commands over a threshold fire a system notification when unfocused. `lib/notify.ts` caches the permission. Settings → Terminal → Notifications (enable / threshold / sound). |
| Chat cost meter   | ✅ V1 (Tier 1.6) | `Chunk` carries `input_tokens`/`output_tokens` (OpenAI `include_usage`; Anthropic `message_start`/`_delta`). `@arc/shared` pricing table; `<CostMeter>` in the chat header shows per-session tokens + est. USD (hidden for local models). |
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
| Themes            | ✅ V1          | CSS-variable theme tokens in `apps/frontend/src/themes/index.ts`. Four built-ins: dark, light, Catppuccin Mocha, Catppuccin Latte. `THEMES` registry + `registerTheme(theme)` + `validateThemeJson(json)` cover Tier 1.7 marketplace consumption. Settings → Appearance grows a "Theme" picker; `themeId` persists alongside `appearance` and (when set) overrides the dark/light resolution. `resolveActiveTheme(appearance, themeId)` is the call site for new code. Tier 1.7 marketplace shipped: `lib/themeMarketplace.ts` loads `~/.arc/themes/*.json` on boot and installs themes from a URL via `http_request` (validated, persisted to disk) — Settings → Themes has an "Install from URL" field. |
| Project config    | ✅ V0          | `rust/project-config` parses `.arc/config.toml` (schema v1: workspace meta, env, agents, mcp_servers, terminal.default_shell, theme.id). Tauri command `project_config_load` returns `null` when the file is missing — that's the common case. `useProjectConfig` (state/projectConfig.ts) subscribes to file-tree root changes and refetches automatically. Consumers (env injection into PTY, auto-MCP-connect, agent registration) wire in incrementally — V0 ships the load path only. |

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
