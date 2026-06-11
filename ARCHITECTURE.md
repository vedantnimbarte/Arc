# Architecture — ARC

This document describes how ARC is structured and how its components communicate. For the design rationale (why we chose Tauri, Zustand, etc.), see [docs/decisions.md](docs/decisions.md).

**Quick links:**
- Setup: [INSTALLATION.md](INSTALLATION.md)
- Contributing: [DEVELOPMENT.md](DEVELOPMENT.md)
- Design decisions: [docs/decisions.md](docs/decisions.md)

---

## System Overview

ARC is a layered desktop application:

```
┌──────────────────────────────────────────────────────────────┐
│ Frontend (React 18 + Vite)                                   │
│  • Terminal (xterm.js)        • Editor (CodeMirror 6)        │
│  • File Tree                  • Settings Dialog              │
│  • Chat Panel                 • Command/Search Palettes      │
│  • Zustand stores (workspace, chat, settings, files, agents) │
└──────────────────────────────────────────────────────────────┘
                   ↓ invoke / listen (Tauri IPC)
┌──────────────────────────────────────────────────────────────┐
│ Tauri Shell (Rust 2)                                         │
│  • Registers 57 Tauri commands                               │
│  • Manages app window & lifecycle                            │
│  • Acts as HTTP/WebSocket bridge to Rust crates             │
│  • Coordinates state (PtyState, LlmState, etc.)              │
└──────────────────────────────────────────────────────────────┘
                   ↓
┌──────────────────────────────────────────────────────────────┐
│ Rust Crates (Cargo workspace)                                │
│  • arc-pty           → PTY process mgmt (portable-pty)       │
│  • arc-ai-runtime    → Streaming LLM providers               │
│  • arc-filesystem    → File ops, watch, search (tantivy)     │
│  • arc-git           → Git status/log/diff/blame             │
│  • arc-session-mgr   → SQLite persistence                    │
│  • arc-agent-runtime → Agentic loop & tool execution         │
└──────────────────────────────────────────────────────────────┘
```

---

## Monorepo Layout

```
Arc/
├── apps/
│   ├── desktop/              # Tauri shell (Rust). Registers commands & manages window.
│   │   ├── src/
│   │   │   ├── main.rs       # App bootstrap, command registration, state initialization
│   │   │   ├── commands/     # Tauri command handlers (pty.rs, llm.rs, fs.rs, etc.)
│   │   │   └── lib.rs
│   │   └── tauri.conf.json   # Window config, bundle settings, CSP
│   │
│   └── frontend/             # React + Vite + TypeScript. Pure UI (no Rust, no Tauri directly).
│       ├── src/
│       │   ├── App.tsx        # Root component; orchestrates layout & hydration
│       │   ├── components/    # All UI components (Terminal, Editor, FileTree, etc.)
│       │   ├── state/         # Zustand stores (workspace, chat, settings, files, agents)
│       │   ├── lib/
│       │   │   └── tauri.ts   # Typed IPC wrappers (the ONLY place invoke/listen are called)
│       │   └── main.tsx
│       ├── tailwind.config.ts # Semantic color tokens, animations, typography
│       └── index.css          # Global styles
│
├── packages/                 # Shared TypeScript packages (linked via pnpm workspaces)
│   ├── shared/               # Cross-package types
│   ├── provider-sdk/         # LLM provider interface (TS-side contract)
│   ├── agents/               # Agent descriptors & built-in agents
│   ├── mcp/                  # MCP types (McpTool, McpNotification, etc.)
│   ├── terminal/             # xterm.js theme export
│   ├── editor/               # CodeMirror language ID mapping
│   └── ui/                   # Catppuccin Mocha color palette
│
├── rust/                     # Cargo workspace. Each crate owns one problem.
│   ├── pty/                  # PTY spawning & management
│   ├── ai-runtime/           # OpenAI, Anthropic, Ollama streaming
│   ├── filesystem/           # File ops, watch, index, search
│   ├── git/                  # Git introspection
│   ├── session-manager/      # SQLite persistence (SQLx + bundled sqlite)
│   ├── agent-runtime/        # Tool-using agent loop
│   └── Cargo.toml            # Workspace root; defines shared deps
│
├── docs/
│   ├── architecture.md       # This file (system design)
│   └── decisions.md          # Why we chose Tauri, Zustand, etc.
│
├── CLAUDE.md                 # Orientation for Claude Code editing this repo
├── INSTALLATION.md           # Setup guide for all platforms
├── DEVELOPMENT.md            # Contributing guide & code conventions
└── README.md                 # High-level overview
```

---

## Frontend Layer

### Components & Hierarchy

The React app (`apps/frontend/src/App.tsx`) orchestrates:

```
<App>
  ├─ <TabBar>           Top chrome (new tab, settings, toggles)
  ├─ <FileTree>         Left sidebar (collapsible, file browser)
  ├─ <ResizeHandle>     Drag-to-resize between sidebar & main pane
  ├─ <MainPane>         Renders Terminal or Editor per active tab
  │   ├─ <Terminal>     xterm.js, one per tab (all mounted, visibility toggled)
  │   └─ <Editor>       CodeMirror 6, one per tab (lazy-loaded)
  ├─ <StatusBar>        Bottom chrome (git branch, dirty indicator)
  ├─ <ChatPanel>        Floating popover (bottom-right)
  │   ├─ <AgentPicker>  Persona selector
  │   ├─ <SessionsList> Chat history browser
  │   └─ <Composer>     Input + send + agent approval gates
  └─ Four modals (always present, visibility toggled)
      ├─ <SettingsDialog>    API keys, model, shell, theme
      ├─ <CommandPalette>    Fuzzy search command history
      ├─ <SearchPalette>     Fuzzy search files by content
      └─ <ShortcutsDialog>   View/edit keyboard bindings
```

### State Management (Zustand)

Each store is a single Zustand module. Stores are **isolated**—they don't reach into each other; cross-store reads happen at the component level.

| Store | File | Persists Via | Purpose |
|-------|------|--------------|---------|
| `useWorkspace` | `state/workspace.ts` | SQLite (`session_save_tabs`) + localStorage fallback | Active tab, tab list, session ID, dirty flags |
| `useChat` | `state/chat.ts` | SQLite (`session_chat_append`, etc.) + localStorage fallback | Chat sessions, messages, streaming state, agent runs |
| `useSettings` | `state/settings.ts` | localStorage (`arc-settings` v3) for UI settings; OS credential vault for API keys | Provider choice, model, system prompt, default shell, keybindings UI |
| `useAgents` | `state/agents.ts` | localStorage (`arc-agents` v1) | Custom agent definitions (on top of 6 built-in agents) |
| `useFiles` | `state/files.ts` | localStorage (`arc-files` v2) | File tree root path, hidden file toggle, sidebar collapsed state, pane widths |
| `useShortcuts` | `state/shortcuts.ts` | localStorage (`arc-shortcuts` v1) | Keybinding overrides; includes `actionFor(e)` matcher |

### Hydration Flow

On app launch (`App.tsx` mount):
```typescript
useEffect(() => {
  // Three independent async operations, race to completion
  useWorkspace().hydrate()        // Load tabs from SQLite
  useChat().hydrate()             // Load chat sessions + messages
  useSettings().hydrateSecrets()  // Load API keys from OS vault
}, [])
```

This happens once on first mount. localStorage migrations (legacy sessions → SQLite) happen automatically on first run.

### Persistence Strategy

| Data | Where | When | Why |
|------|-------|------|-----|
| Active tab, tab list | SQLite | Debounced 250ms on change | Survives app restart |
| Chat messages | SQLite | Appended immediately on send | Survives app restart |
| Settings (provider, model, prompt) | localStorage | On change | Fast, local, no network |
| API keys | OS credential vault | On save in Settings | Encrypted, not persisted to disk in plaintext |
| Keybindings | localStorage | On change | Survives app restart, editable in UI |

---

## Tauri IPC Contract

The frontend and Rust backend communicate via Tauri's IPC (inter-process communication):

- **invoke** → async function call from TS to Rust (request/response)
- **listen** → subscribe to event stream from Rust to TS (subscription)

### Typed Wrappers

`apps/frontend/src/lib/tauri.ts` is the **only** file allowed to call `invoke()` / `listen()` directly. All components import typed helpers from this file.

Example:
```typescript
// tauri.ts
export const ptySpawn = (opts: PtySpawnOpts): Promise<string> => 
  invoke('pty_spawn', { opts })

// Component usage
const tabId = await ptySpawn({ shell: 'bash', cwd: '/home/user', rows: 24, cols: 80 })
```

### Naming Conventions

- **Commands:** `<area>_<verb>` snake_case (e.g., `pty_spawn`, `fs_read_file`, `llm_stream`)
- **Events:** `<area>://<verb>/<id>` (e.g., `pty://data/<tabId>`, `llm://chunk/<requestId>`)

### Error Handling

All Rust commands return `Result<T, String>` at the Tauri boundary:
- On success: Rust value serialized to JSON → TS as typed result
- On error: Error message stringified → TS as Promise rejection

Internal Rust code uses `anyhow::Result` and maps to `String` only at the command layer.

---

## Rust Layer

### Cargo Workspace

All Rust code is in `rust/`. The workspace defines shared dependencies (tokio, serde, sqlx, etc.) and each crate owns one problem:

| Crate | Directory | Role | Key Dependencies |
|-------|-----------|------|------------------|
| `arc-pty` | `rust/pty` | PTY process spawning, stdin/stdout management | `portable-pty`, `tokio`, `bytes` |
| `arc-ai-runtime` | `rust/ai-runtime` | Streaming LLM providers (OpenAI, Anthropic, Ollama) + embeddings | `reqwest`, `eventsource-stream`, `serde_json` |
| `arc-filesystem` | `rust/filesystem` | File ops (read/write/list), watch, index, search | `notify`, `walkdir`, `tantivy`, `rfd` (native dialogs) |
| `arc-git` | `rust/git` | Git status, log, diff, blame (shells out to git CLI) | `tokio::process`, `regex` |
| `arc-session-manager` | `rust/session-manager` | SQLite-backed persistence (tabs, chat, command history, memory) | `sqlx`, `sqlite` (bundled), `chrono` |
| `arc-agent-runtime` | `rust/agent-runtime` | Agentic loop, tool execution, approval gating | `arc-filesystem`, `arc-git`, `anyhow`, `serde` |

### Desktop App (Tauri Integration)

`apps/desktop/src/main.rs` bootstraps the Tauri app:

1. Initializes logging (`tracing_subscriber`)
2. Calls `tauri::Builder::default()` and registers five managed state objects:
   - `PtyState` (PTY manager)
   - `LlmState` (LLM request tracking)
   - `WatchState` (file watchers)
   - `McpState` (MCP servers)
   - `AgentApprovals` (pending tool approvals)
3. In `.setup()`, opens SQLite and injects `SessionStore` as managed state
4. Registers all 57 Tauri commands via `tauri::generate_handler![...]`

### Tauri Commands Surface

All commands are async and live in `apps/desktop/src/commands/`:

#### PTY Commands (`pty.rs`)
```rust
pty_spawn(opts: PtySpawnOpts) -> String          // Returns tab ID
pty_write(id: String, data: String) -> ()
pty_resize(id: String, cols: u16, rows: u16) -> ()
pty_kill(id: String) -> ()
pty_list_shells() -> Vec<ShellInfo>
```

#### LLM Commands (`llm.rs`)
```rust
llm_stream(req: LlmStreamReq) -> ()              // Streams to llm://chunk/<id> and llm://done/<id>
llm_cancel(id: String) -> ()
```

#### Filesystem Commands (`fs.rs`)
```rust
fs_default_root() -> String
fs_parent(path: String) -> Option<String>
fs_read_dir(path: String) -> Vec<DirEntry>
fs_read_file(path: String) -> String            // 5 MiB limit, refuses binaries
fs_write_file(path: String, content: String) -> ()
fs_pick_folder(starting?: String) -> Option<String>
fs_watch_start(path: String) -> String          // Returns watch ID
fs_watch_stop(watchId: String) -> ()
fs_search(root: String, query: String, limit: u32) -> Vec<SearchHit>
fs_index_rebuild(root: String) -> usize         // Returns doc count
fs_index_status(root: String) -> bool
```

#### Git Commands (`git.rs`)
```rust
git_status(path: String) -> Option<GitInfo>
git_log(path: String, limit: u32, pathFilter?: String) -> Vec<LogEntry>
git_diff(path: String, scope: DiffScope, pathFilter?: String) -> String
git_blame(path: String, file: String, startLine?: u32, endLine?: u32) -> Vec<BlameLine>
```

#### Session Commands (`session.rs`) — Workspace, Tabs, Chat History
```rust
session_load() -> SessionState
session_save_tabs(sessionId: String, tabs: Vec<TabState>, activeTabId?: String) -> ()
session_set_workspace(sessionId: String, workspaceId?: String) -> ()
session_workspaces_list() -> Vec<Workspace>
session_workspace_upsert(name: String, root: String) -> Workspace
session_workspace_delete(id: String) -> ()
session_chat_load(workspaceId?: String) -> ChatLoad
session_chat_append(conversationId: String, role: ChatRole, content: String) -> ChatMessage
session_chat_clear(conversationId: String) -> ()
session_chat_sessions_list(workspaceId?: String) -> Vec<ChatConversation>
session_chat_session_create(workspaceId?: String, agentId?: String, title?: String) -> ChatConversation
session_chat_session_update(id: String, title?: String, agentId?: String) -> ()
session_chat_session_delete(id: String) -> ()
session_chat_messages_load(conversationId: String) -> Vec<ChatMessage>
```

#### Command History (`session.rs`)
```rust
session_command_log(tabId?: String, cwd: String, command: String) -> i64  // Returns entry ID
session_commands_recent(limit: u32, query?: String) -> Vec<CommandRecord>
session_command_finish(id: i64, exitCode?: i32, outputExcerpt?: String) -> ()
```

#### Agent Commands (`agent.rs`)
```rust
agent_run(req: AgentRunReq) -> ()                // Streams events to agent://event/<runId>
agent_decide(approvalId: String, approve: bool) -> ()
```

#### MCP Commands (`mcp.rs`) — Model Context Protocol
```rust
mcp_connect(id: String, command: String, args: Vec<String>) -> ()      // stdio transport
mcp_connect_http(id: String, url: String, headers?: Map) -> ()         // HTTP/SSE transport
mcp_list_tools(id: String) -> Vec<McpTool>
mcp_call_tool(id: String, name: String, args: Value) -> String
mcp_disconnect(id: String) -> ()
// Emits: mcp://notification/<serverId> for server-initiated notifications
```

#### Secrets Commands (`secrets.rs`)
```rust
secrets_set_api_key(provider: String, key: String) -> ()  // Empty key = delete
secrets_get_api_key(provider: String) -> Option<String>
secrets_delete_api_key(provider: String) -> ()
```

#### Memory Commands (`memory.rs`) — Notes & Search
```rust
memory_save(workspaceId?: String, kind?: String, title: String, content: String, tags?: Vec<String>, source?: String) -> MemoryEntry
memory_update(id: String, title?: String, content?: String, tags?: Vec<String>) -> ()
memory_delete(id: String) -> ()
memory_get(id: String) -> Option<MemoryEntry>
memory_list(workspaceId?: String, limit: u32) -> Vec<MemoryEntry>
memory_search(workspaceId?: String, query: String, limit: u32) -> Vec<MemoryHit>  // FTS5
memory_embed_entry(id: String, provider: String, model: String, text: String, apiKey?: String, baseUrl?: String) -> ()
memory_vector_search(workspaceId?: String, provider: String, model: String, query: String, limit: u32, apiKey?: String, baseUrl?: String) -> Vec<VectorHit>
```

---

## Data Persistence

### SQLite Schema

The SQLite database (`<data_dir>/arc/arc.db`) uses SQLx with migrations. Key tables:

| Table | Purpose | Columns (selection) |
|-------|---------|-------------------|
| `sessions` | Workspace-level state | `id`, `name`, `created_at` |
| `tabs` | Terminal/editor tabs | `id`, `session_id`, `kind` (terminal/editor), `title`, `order` |
| `chat_conversations` | Chat sessions | `id`, `workspace_id`, `agent_id`, `title`, `created_at` |
| `chat_messages` | Chat messages | `id`, `conversation_id`, `role`, `content`, `created_at` |
| `command_history` | Shell commands | `id`, `tab_id`, `cwd`, `command`, `exit_code`, `output_excerpt`, `finished_at` |
| `agent_runs` | Agent execution logs | `id`, `workspace_id`, `goal`, `status`, `events_json`, `created_at` |
| `memory_entries` | User notes | `id`, `workspace_id`, `kind`, `title`, `content`, `tags`, `source`, `created_at` |
| `memory_fts` | Full-text index of memory | `rowid`, `title`, `content` (FTS5 virtual table) |
| `embedding` | Vector embeddings for memory | `entry_id`, `embedding` (BLOB), `embedding_model` |

### Tantivy Index

Full-text search uses tantivy BM25 indexing (separate from SQLite FTS5). The index lives at:

```
<data_dir>/arc/index/<workspace-hash>/
  └─ meta.json              # Index metadata
     segments/              # Index segments
```

Index is **per-workspace-root** (identified by path hash). When you change the file tree root, a new index is built.

`fs_search` prefers the tantivy index when available; if not yet built, falls back to `walkdir` (simple file walk).

### Credential Vault

API keys are **never persisted to disk in plaintext**. They live in:
- **macOS:** Keychain (system credential store)
- **Windows:** Credential Manager (system credential store)
- **Linux:** sync-secret-service (system credential store)

The Rust `keyring` crate abstracts this. Service name: `dev.arc.terminal`. Username: `<provider>` (e.g., `openai`, `anthropic`).

---

## Key Data Flows

### PTY Pipeline

```
User types in xterm.js
         ↓
  onData(input) event
         ↓
  invoke("pty_write", { id, data })
         ↓
  Tauri command dispatches to PtyManager
         ↓
  PtyManager::write() writes to PTY's stdin
         ↓
  Shell process writes to PTY's stdout
         ↓
  Reader thread (blocking) reads bytes
         ↓
  tokio::mpsc::Receiver<Vec<u8>>
         ↓
  Tauri emits pty://data/<id> event with bytes
         ↓
  Frontend listens & calls term.write(bytes)
         ↓
  xterm.js renders to screen
```

**Key point:** Reader thread is OS-level (blocking), Tokio is only for the channel and event emission.

### LLM Streaming Pipeline

```
User submits message in chat composer
         ↓
  invoke("llm_stream", { request: ChatRequest })
         ↓
  Tauri command dispatches to active Provider (OpenAI/Anthropic/Ollama)
         ↓
  Provider streams HTTP chunks (eventsource-stream)
         ↓
  For each chunk: Tauri emits llm://chunk/<requestId> { delta, ... }
         ↓
  Frontend listens & appends delta to message
         ↓
  User sees token-by-token streaming
         ↓
  On HTTP stream close: emit llm://done/<requestId>
         ↓
  Frontend finalizes message, saves to SQLite
```

**Cancellation:** `invoke("llm_cancel", { id })` sets a DashMap flag; the streaming loop checks it and aborts.

### Agent Approval Flow

When an agent tries to call a **mutating tool** (fs_write_file, shell, etc.):

```
Agent runtime encounters fs_write_file("path", "content")
         ↓
  Create ApprovalRequest { toolName, input, ... }
         ↓
  Emit agent://event/<runId> with ApprovalRequest
         ↓
  Frontend shows inline Approve/Deny buttons over the composer
         ↓
  User clicks Approve or Deny (or presses Escape to deny)
         ↓
  invoke("agent_decide", { approvalId, approve: bool })
         ↓
  Resolve parked oneshot in agent runtime
         ↓
  If approved: execute tool, continue agent loop
  If denied: emit error event, agent stops gracefully
```

**Timeout:** No explicit timeout; if the user doesn't respond, the agent waits indefinitely (user can close the popover to force-deny).

---

## Styling & Theming

### Tailwind Configuration

`apps/frontend/tailwind.config.ts` defines a semantic color system (not hex colors):

**Background colors:**
- `bg-base` — main surface color (#161618)
- `bg-panel` — secondary surface (#28282a)
- `bg-overlay` — semi-transparent overlay

**Foreground colors:**
- `fg-base` — primary text
- `fg-muted` — secondary text
- `fg-accent` — accent (platinum #c8cad0)

**Status colors:**
- `status-ok`, `status-warn`, `status-err`, `status-info`

**Utilities:**
- `shadow-panel`, `shadow-sheet`, `shadow-focus` — semantic shadows
- `animate-popover-in`, `animate-sheet-in` — animation keyframes
- `border-squircle`, `border-window` — semantic border-radius

### xterm.js Theme

`packages/terminal/src/XTERM_THEME.ts` mirrors the Tailwind tokens so the terminal blends with the UI chrome. Both use the Catppuccin Mocha palette (`packages/ui/src/MOCHA.ts`).

---

## Extension Points

### Adding a New Tauri Command

1. **Rust side:** Create a `#[tauri::command]` function in `apps/desktop/src/commands/<area>.rs`
2. **Register:** Add to `tauri::generate_handler![...]` in `main.rs`
3. **TypeScript wrapper:** Add async function to `apps/frontend/src/lib/tauri.ts`
4. **Use:** Call the TS wrapper from any component

Example in [DEVELOPMENT.md](DEVELOPMENT.md).

### Adding a New Zustand Store

Create `apps/frontend/src/state/<feature>.ts` with:
- Initial state shape
- Actions (setter functions)
- Optional persistence middleware (for localStorage or SQLite)

Stores don't communicate with each other; components can use multiple stores.

### Adding a New Rust Crate

1. Create directory `rust/<name>`
2. Run `cargo init --lib rust/<name>`
3. Add to `[workspace]` members in `rust/Cargo.toml`
4. Desktop app can depend on it via `arc-<name>` in `Cargo.toml`

Ensure the crate owns **one problem only**—don't add cross-cutting logic to the desktop app.

### Connecting an MCP Server

1. `invoke("mcp_connect", { id: "my-server", command: "npx", args: ["my-mcp-server"] })`
2. `invoke("mcp_list_tools", { id: "my-server" })` → returns available tools
3. `invoke("mcp_call_tool", { id: "my-server", name: "tool_name", args: {...} })`
4. Tools bridge into the agent runtime automatically (capped at 32 per run)

See [README.md](README.md#documentation) for MCP resources.

---

## Summary

**Frontend:** React components + Zustand stores, styled with Tailwind dark-first semantic tokens.

**IPC:** Typed async `invoke()` wrappers in `tauri.ts` + event `listen()` subscriptions; named `<area>_<verb>` and `<area>://<verb>/<id>`.

**Backend:** Six Rust crates coordinated by Tauri. Each owns one concern. State is managed via Tauri's `manage()` (singleton pattern). Commands run async.

**Persistence:** SQLite for structured data (sessions, chat, memory), tantivy for full-text search, OS credential vault for secrets, localStorage for UI-only settings.

**Theming:** Tailwind semantic tokens mirrored in xterm.js, all using Catppuccin Mocha.

For more, see:
- [INSTALLATION.md](INSTALLATION.md) — Setup
- [DEVELOPMENT.md](DEVELOPMENT.md) — Contributing
- [docs/architecture.md](docs/architecture.md) — Deep dives (PTY pipeline, state rationale, etc.)
- [docs/decisions.md](docs/decisions.md) — Why Tauri, Zustand, etc.
