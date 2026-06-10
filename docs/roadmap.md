# Roadmap

> Forward-looking feature plan for ARC. Companion to [architecture.md](architecture.md) (how things are wired today) and [decisions.md](decisions.md) (why). Features here are **planned**, not shipped — the source of truth for "what's real" remains the status table in [CLAUDE.md](../CLAUDE.md).

The plan is sequenced into six tiers. Tiers ship as **one PR per tier** (batched). Within a tier, features are ordered so the riskiest/most foundational lands first — if a tier runs long, the tail can split into a follow-up PR without leaving the codebase in a half-state.

Legend: 🟢 quick (≤1 day) · 🟡 medium (2–4 days) · 🔴 large (≥1 week)

---

## Tier 0 — Foundations

**Goal:** Land the four substrates that every later tier piggybacks on. Nothing here is user-visible on its own (except themes), but skipping them means re-doing work in Tiers 1–5.

### 0.1 Command palette (⌘K) 🟡

Central action dispatcher. Every feature in later tiers registers actions here instead of inventing its own shortcut UI.

- **Frontend:** new `apps/frontend/src/components/CommandPalette.tsx` (fuzzy-search modal, keyboard nav). New `apps/frontend/src/state/commands.ts` Zustand store exposing `register(action)` / `unregister(id)` / `run(id)`.
- **Action shape:** `{ id, title, group, keywords[], shortcut?, icon?, when?(): boolean, run(): Promise<void> }`.
- **Seed actions:** open settings, new tab, new chat, open file, switch workspace, run git status, etc. — replaces the scattered ⌘, ⌘J ⌘⇧N ⌘⇧L ⌘⇧S handlers with one source.
- **Ship criteria:** ⌘K opens, type to filter, Enter runs, Esc closes. At least 20 seeded actions covering existing shortcuts. Existing shortcuts still work (palette is additive, not a replacement).

### 0.2 Per-project `.arc/` config 🟡

A directory inside each workspace root that ARC reads on workspace open. First feature to consume it is workspace templates (Tier 1.6), but agents, MCP servers, env vars, and themes all pull from here in later tiers.

- **Schema:** `.arc/config.toml` — top-level keys `[workspace]`, `[env]`, `[[agents]]`, `[[mcp_servers]]`, `[terminal]`, `[theme]`. Versioned (`schema = 1`).
- **Loader:** new `rust/project-config` crate (`load(root) -> ProjectConfig`, watches for changes via existing notify watcher). Exposed as `project_config_load` / event `project://config-changed/<workspace_id>`.
- **Precedence:** project config overrides user settings; user settings override defaults. Merge is shallow per section.
- **Frontend:** `useProjectConfig()` hook in `apps/frontend/src/state/workspace.ts`. Settings panel grows a "Project (.arc/)" tab showing what's currently loaded.
- **Ship criteria:** drop a `.arc/config.toml` with custom env vars + an agent definition into a workspace root → both show up live without restart.

### 0.3 Block-based output 🔴

Re-architect terminal rendering around **command blocks**: each prompt-to-next-prompt span is a collapsible region with metadata (command text, exit code, duration, output). Required for OSC 8 hyperlinks (Tier 1.1), inline error explainer (Tier 4.1), rerun, copy-output actions.

- **Frontend:** `apps/frontend/src/components/Terminal.tsx` grows a `BlockRenderer` overlay that listens for OSC 133 (`A` prompt start, `B` command start, `C` output start, `D[;exit]` command end — already partly handled today, see CLAUDE.md command-history row) and groups xterm rows into blocks.
- **Per-block UI:** chevron to collapse, copy-output button, rerun button, "Ask ARC" button (Tier 4.1 wires this up; for now it's a stub).
- **Fallback:** shells that don't emit OSC 133 get a single rolling block (no regression).
- **State:** blocks live in `apps/frontend/src/state/blocks.ts`, persisted alongside command history.
- **Ship criteria:** running 5 commands shows 5 collapsible blocks; collapsing hides output; rerun re-sends the command via `pty_write`; works on bash + pwsh + zsh.

### 0.4 Themes infrastructure 🟡

Token system + JSON theme loader. The "marketplace" (Tier 1.7) is just a registry on top of this.

- **Token map:** extract every color used in `tailwind.config.ts` into `packages/ui/tokens.ts` (`bg.base`, `bg.surface`, `fg.base`, `fg.muted`, `accent.primary`, `terminal.ansi.0..15`, etc.).
- **Theme file format:** JSON, matches token map exactly, plus `{ name, author, version, kind: "light" | "dark" }`.
- **Runtime:** `packages/ui/src/theme.ts` exposes `applyTheme(theme)` — writes CSS variables to `:root`. Tailwind config switches to `var(--token-name)`.
- **Loader:** themes live in `~/.arc/themes/*.json` and `.arc/themes/*.json` (project-scoped). User picks active theme in settings.
- **Ship criteria:** default Catppuccin Mocha is now `default.json` loaded via this system; switching themes in settings recolors editor + terminal + chrome without reload.

**Tier 0 ship criteria:** all four merged; type-check + cargo check pass; no regression in existing shortcuts; CLAUDE.md status table updated.

---

## Tier 1 — Quick wins

**Goal:** 7 visible improvements in one PR. Each individually small; collectively a noticeable polish bump. All ride Tier 0.

### 1.1 OSC 8 hyperlinks → editor 🟢

Detect OSC 8 sequences in xterm output (file paths emitted by `ls`, compiler errors, test runners) and route clicks to the editor instead of the browser.

- xterm.js has `LinkProvider` API — register one that intercepts `file://` URLs and `path:line:col` patterns even without OSC 8.
- On click: resolve path against active workspace root → if exists, open in editor tab (existing `fs_read_file` flow) → if has `:line:col`, jump there.
- **Files:** `apps/frontend/src/components/Terminal.tsx`, new `apps/frontend/src/lib/links.ts`.

### 1.2 Recent commands / recent files on new tab 🟢

When a new terminal tab is empty (no command run yet) or a new chat is opened, show a 2-column splash: recent commands (from `command_history`) and recent files (from editor open history).

- Click a command → pastes into the prompt (doesn't auto-run).
- Click a file → opens in editor.
- **Files:** new `apps/frontend/src/components/NewTabSplash.tsx`, `apps/frontend/src/state/files.ts` (add `recentFiles` array).

### 1.3 File-tree git decorations 🟢

M/A/U/? dots next to filenames in the file tree, using `rust/git` `status` output.

- Subscribe to `git_status` poll (existing) and a future `git://status-changed/<workspace>` event (debounced filesystem watcher already exists — wire it to re-run status on changes inside the workspace, ignoring `.git/`).
- Color tokens from theme: `git.modified`, `git.added`, `git.untracked`, `git.conflicted`.
- **Files:** `apps/frontend/src/components/FileTree.tsx`, `rust/git/src/lib.rs` (expose status map keyed by path).

### 1.4 Smart paste warnings 🟢

When user pastes into a terminal, check for: multi-line (≥2 newlines), `sudo `, `rm -rf`, `curl ... | sh`, `chmod -R`. Show a modal — preview the content, list flagged patterns, require explicit confirm.

- One-shot bypass via shift-paste.
- **Files:** `apps/frontend/src/components/Terminal.tsx` (intercept `onPaste`), new `apps/frontend/src/components/PasteWarning.tsx`.

### 1.5 Long-command notifications 🟢

When a command (OSC 133-tracked) runs >30s and the window isn't focused, fire a system notification on exit (✅ exit 0, ❌ non-zero). Optional sound.

- Tauri's `notification` plugin handles cross-platform delivery.
- Threshold + sound configurable in settings.
- **Files:** `apps/desktop/Cargo.toml` (+ `tauri-plugin-notification`), `apps/frontend/src/state/blocks.ts` (already has timing if Tier 0.3 lands first).

### 1.6 Cost / token meter 🟢

Per-chat-session running total: input tokens, output tokens, $ estimate (using current provider's posted pricing, hardcoded table). Shown in chat header.

- Reads from `llm_*` chunk events — they already include usage on the final chunk for OpenAI/Anthropic. Ollama has no cost.
- Pricing table: `packages/shared/src/pricing.ts`, easy to update.
- **Files:** `apps/frontend/src/components/ChatPanel.tsx`, `apps/frontend/src/state/chat.ts`.

### 1.7 Themes marketplace (local) 🟢

Settings → Themes tab: grid of installed themes (default + anything in `~/.arc/themes/`), preview swatches, "Install from URL" field that fetches JSON, validates against schema, writes to `~/.arc/themes/<slug>.json`.

- No central registry in V1 — users share theme URLs (gist, github raw). V2 can add a hosted index.
- **Files:** new `apps/frontend/src/components/ThemesPanel.tsx`, `packages/ui/src/theme.ts` (add `validateTheme`).

### 1.8 Multi-cursor + Vim mode 🟢

CodeMirror 6 has `@codemirror/vim` and built-in multi-cursor (Alt-click, ⌘D). Just enable, gate Vim behind a setting.

- **Files:** `apps/frontend/src/components/Editor.tsx`, `apps/frontend/src/state/settings.ts` (`editor.vimMode: boolean`).

**Tier 1 ship criteria:** all 8 features above merged in one PR; settings UI updated; no regression in terminal/editor/chat.

---

## Tier 2 — Git cluster

**Goal:** Make ARC a credible alternative to dedicated git GUIs for the operations developers actually do daily. All features extend `rust/git` and the existing diff/log/blame infra.

### 2.1 Worktree manager 🟡

UI for `git worktree add/list/remove`. Each worktree appears as a switchable "workspace" in ARC (reuses workspace concept).

- **Rust:** `rust/git` adds `worktree_list`, `worktree_add(path, branch)`, `worktree_remove(path)`. Tauri commands `git_worktree_*`.
- **Frontend:** new `apps/frontend/src/components/WorktreePanel.tsx` accessible from status bar branch indicator.
- **Why first in tier:** simplest, no destructive ops beyond `worktree remove` (which git itself protects).

### 2.2 Cherry-pick across branches 🟡

Right-click a commit in log view → "Cherry-pick to…" → branch picker → conflict resolution reuses existing conflict UI (commit 25d1835 — side-by-side diff with per-hunk stage).

- **Rust:** `rust/git` adds `cherry_pick(commit_sha, target_branch?, no_commit: bool)`. Tauri command `git_cherry_pick`.
- **Frontend:** extend existing log view's context menu.

### 2.3 Interactive rebase UI 🔴

The big one. Drag-to-reorder commits, change action per-commit (pick/squash/fixup/edit/drop/reword), preview the resulting history before confirming.

- **Approach:** run `git rebase -i` with `GIT_SEQUENCE_EDITOR` pointing at an ARC helper binary that reads the todo list, sends it to the frontend via a pending IPC channel, waits for the user's edited list, writes it back. Same trick for `GIT_EDITOR` on reword/edit stops.
- **Rust:** new `rust/git/src/rebase.rs` orchestrates the session. New crate binary `arc-git-sequence-editor` (small — reads a file path, talks to the parent over a Unix domain socket / named pipe).
- **Frontend:** new `apps/frontend/src/components/RebasePanel.tsx` — drag-and-drop list (react-dnd or @dnd-kit), action picker per row.
- **Risk:** abort path must be bulletproof. Keep a stash + reflog pointer before starting; expose "abort rebase" prominently.

### 2.4 PR creation / review (GitHub first) 🔴

Inside ARC: list PRs for current repo, open PR detail (description, commits, files changed, comments), create new PR from current branch.

- **Auth:** GitHub PAT in keyring (`secrets_*` infrastructure already exists). OAuth device flow as a follow-up.
- **Rust:** new `rust/git-host` crate. Trait `GitHost` with `list_prs`, `get_pr`, `create_pr`, `list_comments`, `post_comment`, `merge_pr`. Implementation `GitHubHost` using `octocrab` or hand-rolled `reqwest` (lighter dep).
- **Tauri commands:** `git_host_pr_*`.
- **Frontend:** new `apps/frontend/src/components/PrPanel.tsx`. PR detail view reuses existing diff component for files changed.
- **GitLab:** same trait, second implementation. Ship as a follow-up unless trivial.

**Tier 2 ship criteria:** worktree create + switch works; cherry-pick succeeds on clean case and surfaces conflicts on dirty case; rebase reorders 3 commits and survives an abort; can list + open + create a PR against a github.com repo.

---

## Tier 3 — Remote cluster

**Goal:** SSH sessions feel like local terminals — including file transfer, port forwarding, and survival across network blips. Extends `rust/ssh`.

### 3.1 SFTP file panel 🟡

When an SSH tab is active, an "SFTP" toggle in the file tree switches the tree to the remote filesystem. Browse, open files in editor (read), edit + save (write), drag local→remote and remote→local for upload/download.

- **Rust:** `russh` has `russh-sftp` companion. `rust/ssh` grows `sftp_list_dir(session_id, path)`, `sftp_read(session_id, path)`, `sftp_write(session_id, path, bytes)`, `sftp_stat`, `sftp_upload`, `sftp_download` (chunked, progress events on `sftp://progress/<transfer_id>`).
- **Frontend:** `FileTree` learns a `source: 'local' | 'sftp:<session_id>'` mode.

### 3.2 Port forwarding manager 🟡

UI for local (`-L`), remote (`-R`), and dynamic (`-D`) forwards. Saved per-host, autoconnect optional, status indicators (listening / connection count).

- **Rust:** `rust/ssh` adds `port_forward_open(session_id, spec)` / `port_forward_close(forward_id)` / `port_forward_list`. `russh::client::Handle` supports channel direct-tcpip + forward-tcp.
- **Schema:** `ssh_port_forwards` table (host_id, kind, local_addr, local_port, remote_addr, remote_port, autoconnect). New migration.
- **Frontend:** new tab in `SshPanel` — "Tunnels". List + add/edit/delete + per-row toggle.

### 3.3 Mosh-style reconnection 🔴

The hardest of the three because mosh is its own protocol (UDP, SSP). Two options:

- **Option A (faithful):** spawn `mosh-server` on the remote, run a Rust mosh-client. There's no mature pure-Rust mosh client; building one is its own multi-week project.
- **Option B (pragmatic):** detect SSH disconnect, auto-reattach to a `tmux new-session -A -s arc-<host>` (or `screen`, `zellij`) on reconnect. Not true UDP roaming, but recovers from sleep/network change in <1s if a multiplexer is available.

V1 ships Option B with multiplexer auto-detect; Option A becomes a separate roadmap item if demand justifies the lift.

- **Rust:** `rust/ssh` adds `connect_with_resume(host, options)` — runs `which tmux || which screen` on connect, picks one, wraps the shell command. On `ssh://exit` with non-clean disconnect, schedule reconnect with exponential backoff (1s/2s/5s/10s, give up at 30s).
- **Frontend:** session log drawer shows reconnect attempts; status bar shows "Reconnecting…".

**Tier 3 ship criteria:** open SFTP panel, upload a 1 MB file with progress; create a `-L 5432:localhost:5432` forward, connect to it from another local app; sleep the laptop for 1 minute, wake up, terminal session is still attached to the remote tmux.

---

## Tier 4 — AI depth

**Goal:** Make the AI feel like a co-pilot present in the terminal, not a chat window beside it. All features ride block-based output (Tier 0.3) and the agent runtime.

### 4.1 Inline error explainer 🟢

When a block exits non-zero, an "Ask ARC why" button appears in the block footer. Clicking it sends `{ command, exit_code, last_4kb_of_output, recent_5_commands }` to chat as a pre-filled prompt — user can edit before sending or send immediately.

- **Files:** `apps/frontend/src/components/Terminal.tsx` (block footer), `apps/frontend/src/state/chat.ts` (new `composeFromBlock(block)` helper).

### 4.2 Inline command suggestions 🟡

Ghost-text suggestion as user types in the terminal: based on recent commands, project context (`.arc/config.toml` exposed commands), and shell history. Tab to accept, Esc to dismiss.

- **Approach V1:** local — fuzzy-match against `command_history` table + a static command corpus.
- **Approach V2:** AI-powered — small model (Haiku) called with recent history + current input as context. Debounced 200ms, cached aggressively, opt-in (costs money).
- Both modes coexist; settings toggle.
- **Files:** `apps/frontend/src/components/Terminal.tsx` (xterm doesn't render ghost text natively — overlay a positioned `<span>` over the input row).

### 4.3 Background agents tab 🔴

New top-level panel (alongside chat / git / ssh / mcp): list of all agent runs, status (running / awaiting approval / completed / failed), progress (current step + tool), pause / resume / cancel, diff preview before applying file writes.

- **Rust:** `rust/agent-runtime` already persists runs in `agent_runs`. Extend with: pause/resume support (currently runs are one-shot), per-run streaming progress events on `agent://progress/<run_id>`, ability to detach the chat composer (run can outlive its originating chat).
- **Diff preview:** for `fs_write_file` / `fs_edit` tool calls, stage the change in a virtual diff (reuse Tier 2 side-by-side diff component) and gate approval on user confirming the diff, not just the tool call.
- **Frontend:** new `apps/frontend/src/components/AgentsPanel.tsx`. Status bar grows an "agents: N running" indicator.

### 4.4 Multi-file refactor with preview tree 🟡

Special agent mode: instead of approving per-file write, the agent gathers all proposed edits into a preview tree (left: file list with +N/-N indicators, right: per-file diff), user picks which to apply (checkboxes), then applies as one atomic operation.

- **Rust:** `rust/agent-runtime` learns a `mode: BatchEdit` where `fs_write_file` / `fs_edit` are stashed instead of executed; agent emits a `BatchProposal` event when it calls a `finalize_refactor` synthetic tool.
- **Frontend:** new `apps/frontend/src/components/RefactorPreview.tsx`.

**Tier 4 ship criteria:** non-zero exit shows "Ask ARC" → routes to chat with full context; typing `git che` shows ghost-text `git checkout main` based on history; background agent runs to completion while user works in another tab; multi-file refactor proposes 5 file changes, user unchecks 2, applies the rest.

---

## Tier 5 — Editor depth

**Goal:** CodeMirror tab becomes a serious editor, not a viewer. Hardest tier — LSP is the dominant cost.

### 5.1 Quick-open by symbol (⌘T) 🟡

Like ⌘P but for symbols. Indexes function/class/method definitions across the workspace using tree-sitter (no LSP needed).

- **Rust:** new `rust/symbols` crate. Uses `tree-sitter` with grammars for ts/tsx/js/rs/go/py at minimum. Walks workspace on demand (or on file change via existing watcher), extracts `(kind, name, file, line)` tuples, stores in tantivy (reuse existing index).
- **Tauri command:** `symbols_search(query, limit)`.
- **Frontend:** ⌘T opens a palette identical to ⌘P, results are symbols.

### 5.2 LSP integration 🔴

The largest single feature in the roadmap. Plumb language servers for diagnostics, hover, completion, go-to-definition, find-references, rename.

- **Rust:** new `rust/lsp` crate. `LspManager` spawns + supervises language server processes (one per (language, workspace_root) pair). JSON-RPC over stdio. Translates LSP messages to a stable internal shape so CodeMirror doesn't need to know LSP.
- **Server discovery:** built-in registry (rust-analyzer, typescript-language-server, gopls, pyright, etc.). User can override path / args in settings or `.arc/config.toml` (`[lsp.<lang>]` section).
- **Tauri commands:** `lsp_start(language, root)`, `lsp_stop(server_id)`, `lsp_hover(server_id, uri, pos)`, `lsp_completion(...)`, `lsp_definition(...)`, `lsp_diagnostics_subscribe(...)`. Events on `lsp://diagnostics/<server_id>`.
- **Frontend:** `apps/frontend/src/components/Editor.tsx` grows CodeMirror extensions wired to the LSP commands. Use [`codemirror-languageserver`](https://github.com/FurqanSoftware/codemirror-languageserver) as reference but our IPC layer sits between it and the actual server.
- **Phasing within 5.2:**
  1. Lifecycle (start/stop, capability handshake)
  2. Diagnostics (squiggles + problems panel)
  3. Hover + go-to-definition
  4. Completion
  5. Rename + find-references
- Ship 5.2a (lifecycle + diagnostics) first; the rest can be a follow-up PR.

**Tier 5 ship criteria:** ⌘T finds a function by name and jumps to its definition; rust-analyzer attaches to a Rust project, shows squiggles on a deliberate type error, hover reveals the type.

---

## Cross-cutting work

These don't belong to one tier but get touched repeatedly. Track separately so they don't drift:

- **Settings tabs:** every tier adds settings. Keep them grouped (General / Terminal / Editor / AI / Git / Remote / Themes / Project) instead of one giant scroll.
- **Telemetry (opt-in):** no analytics today. Before Tier 4 ships, add a minimal opt-in pipeline so we can see what people actually use. ADR required.
- **Docs:** every shipped tier updates the status table in `CLAUDE.md`. New crates appear in `docs/architecture.md`. Big architectural choices (rebase plumbing, LSP transport, mosh option A vs B) get an ADR in `docs/decisions.md`.
- **Tests:** Tier 0–1 are mostly UI; visual + integration only. Tiers 2 and 5 (git ops + LSP) need real unit tests in their Rust crates — both have well-defined inputs/outputs and history of footguns.

---

## What we are deliberately not doing (yet)

- **Plugin/extension API.** Tempting but premature. MCP already covers most "let users ship tools" scenarios. Revisit after Tier 4 if there's a concrete extension that MCP can't express.
- **Cloud sync of settings.** Mentioned in the original brainstorm — defer until at least one user asks for it. Adds an auth surface for limited value.
- **Image rendering in terminal (sixel/kitty).** Cool, niche. Slot into Tier 1 only if a quick xterm.js addon exists; otherwise skip.
- **Themes hosted registry.** V1 marketplace is URL-install. A central index needs governance we don't have yet.
- **Mosh Option A.** True mosh protocol client. Re-evaluate only if Option B (multiplexer auto-reattach) proves insufficient.

---

## Status

| Tier | Status | PR |
| ---- | ------ | -- |
| 0    | ✅ shipped | tier-0-foundations |
| 1    | ✅ shipped | tier-1-quick-wins |
| 2    | ✅ shipped | tier-2-git |
| 3    | planned | — |
| 4    | planned | — |
| 5    | planned | — |

Update this table as each tier lands.

### Tier 0 — what actually landed

- **0.1 Command palette (⌘K)** — `state/commands.ts` registry, `CommandPalette.tsx` UI, 16 seed actions auto-derived from `ACTION_META`. Existing ⌃R palette moved to `CommandHistoryPalette.tsx`. Future features register more via `useCommands.getState().register(...)`.
- **0.2 `.arc/` config** — new `rust/project-config` crate (TOML schema v1, 5 unit tests). `project_config_load` Tauri command, `useProjectConfig` store auto-reloads on workspace root change. Consumer wiring (env injection, MCP auto-connect, agent registration) deferred to later tiers — V0 ships the load path.
- **0.3 Block-based output** — `state/blocks.ts` captures OSC 133 boundaries. `BlocksDrawer.tsx` floats over each terminal pane with per-block copy / rerun / "Ask ARC" actions. Compromise vs. the original plan: xterm renders to canvas/webgl, so blocks live in a drawer rather than inline-collapsible rows. The data model + capture layer is what subsequent Tier 1+ features need anyway. No-shell-integration shells produce no blocks (drawer shows a hint).
- **0.4 Themes infrastructure** — Catppuccin Mocha + Latte built-in (4 themes total). `THEMES` registry + `registerTheme(theme)` + `validateThemeJson(json)` cover Tier 1.7 marketplace consumption. Settings → Appearance grows a theme picker with swatch previews. `themeId` persisted; `resolveActiveTheme(appearance, themeId)` is the new resolver. The `~/.arc/themes/*.json` disk loader is intentionally part of Tier 1.7 (marketplace) — the infra here makes that a small add.

### Tier 1 — what actually landed

- **1.1 OSC 8 / path hyperlinks** — `lib/links.ts` registers an xterm LinkProvider that detects file paths (separator- or extension-bearing tokens, optional `:line:col`) in output and opens them in an editor tab, resolving relative paths against the tree root. URLs stay with the web-links addon. Line-jump on click is deferred (the editor doesn't yet accept a target line).
- **1.2 Recent commands/files splash** — `<NewTabSplash>` overlays a fresh terminal with recent commands (`session_commands_recent`; click pastes without auto-running) and recent files (new `recentFiles` in the files store, pushed from `openFile`; click opens). Dismisses on first interaction.
- **1.3 File-tree git decorations** — new `git_root` command maps repo-relative `git_changes` paths to absolute; the git store derives an abs-path → `{status,kind}` map + a dirty-folder set. FileTree paints a colored porcelain letter on changed files (conflicts red) and an amber dot on collapsed dirty folders. Rides the existing 4s poll.
- **1.4 Smart paste warnings** — `detectRiskyPaste` flags multi-line, `sudo`, `rm -rf`, `curl|sh`, `chmod/chown -R`, `dd`-to-device; the Terminal intercepts paste in the capture phase and parks flagged ones behind a `<PasteWarning>` confirm dialog (`usePaste` store), re-issuing via `term.paste()`. Shift-paste bypasses.
- **1.5 Long-command notifications** — `tauri-plugin-notification` (+ capability). When an OSC133-tracked command exceeds a configurable threshold and the window is unfocused, a system notification fires (✓/✗ + duration + command). Settings → Terminal → Notifications: enable / threshold / sound.
- **1.6 Cost / token meter** — `Chunk` now carries `input_tokens`/`output_tokens` (OpenAI `include_usage` trailing chunk; Anthropic `message_start`/`_delta`). `@arc/shared` ships a pricing table (`estimateCostUsd`/`formatUsd`). A `<CostMeter>` in the chat header shows per-session tokens + estimated USD, hidden for local models, dollar figure dropped when the model has no known price.
- **1.7 Themes marketplace (local)** — `lib/themeMarketplace.ts` loads `~/.arc/themes/*.json` on boot (`registerTheme`) and installs themes from a URL via `http_request` (CORS-free), validated + persisted to disk. Settings → Themes grows an "Install from URL" field.
- **1.8 Multi-cursor + Vim** — CodeMirror rectangular selection + crosshair on top of always-on multiple selections (Alt-click, ⌘D). New `editorVimMode` setting lazy-loads `@replit/codemirror-vim` into a compartment so the layer toggles live. Settings → Editor hosts the toggle.

### Tier 2 — what actually landed

- **2.1 Worktree manager** — `rust/git::worktree_{list,add,remove}` (porcelain parser + 1 unit test). `<WorktreePanel>` lists worktrees with badges (locked/prunable/main/active), supports add (new or existing branch, optional start-point, native folder picker) and remove with force escape hatch. Switch action reroots the file tree.
- **2.2 Cherry-pick across branches** — `<CherryPickDialog>` filters local branches, runs `git checkout <target>` then `git cherry_pick <oid>`. Conflict path surfaces stderr + nudges to the diff view. Lives next to the existing scissors-onto-HEAD action — adds a branch-icon button per commit row.
- **2.3 Interactive rebase** — `rust/git::rebase_{interactive,abort,continue}`. Helper script (`.sh` on Unix, `.cmd` on Windows) overwrites git's TODO file via `GIT_SEQUENCE_EDITOR`; `GIT_EDITOR` is `true`/`cmd /c rem` so squash combined-message buffers auto-accept. UI: up/down reorder + per-row action picker (pick/squash/fixup/drop). Reword + edit deferred. Conflict path = abort button surfaced inline.
- **2.4 Pull requests (GitHub)** — new `rust/git-host` crate (6 unit tests for URL parsing). `GitHost` trait + `GitHubHost` (reqwest, PAT-in-keyring). 3-view `<PrPanel>` (list / detail / create). One-time token-entry pane on first use. Auto-detects `origin` → github.com slug. Comments / reviews / merge button intentionally deferred — they're each a sub-feature. GitLab implementation slot exists in the trait.
