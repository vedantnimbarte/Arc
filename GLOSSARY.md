# Glossary — ARC Terminology

Definitions of technical terms used throughout ARC documentation and UI.

---

## A

### Agent
An autonomous AI system that can read files, search code, run shell commands, and edit files with your explicit approval. Uses an LLM (language model) to plan and execute tasks.

### Approval
User consent for an agent to execute a mutating tool (write file, run shell command). Shown as an inline prompt in the chat panel.

### API Key
Credentials for accessing an LLM provider (OpenAI, Anthropic). Stored securely in the OS credential vault.

---

## C

### Chat Panel
Floating popover in the UI (bottom-right) where you interact with the AI assistant. Collapsible via `Ctrl+J`.

### CodeMirror
Open-source code editor component used for file editing in ARC. Provides syntax highlighting, keybindings, and performance optimizations.

### Command History
Log of shell commands you've typed, searchable via `Ctrl+R`. Persisted to SQLite.

### Conversation
A chat session with the AI. Multiple conversations can exist per workspace, each with its own message history.

---

## D

### Data Directory
System folder where ARC stores SQLite database, indexes, and configuration. Location varies by OS (see [INSTALLATION.md](INSTALLATION.md#data-directory)).

### Diff
Changes between versions (worktree changes, staged changes, commit vs. HEAD). Can be viewed via `/git diff` or agent tools.

### DiffScope
Specifies which changes to show: `worktree` (unstaged), `staged`, or `head` (last commit).

---

## E

### Embedding
Vector representation of text, computed by an embedding model (OpenAI, Ollama). Used for semantic search in memory.

### Event Topic
Tauri event channel name following `<area>://<verb>/<id>` format (e.g., `pty://data/<tabId>`).

---

## F

### File Tree
Left sidebar UI showing directory structure, files, and folders for the current workspace root.

### FTS5
Full-text search engine built into SQLite. Used for keyword-based search in memory entries and command history.

---

## G

### Git Porcelain
Human-readable output format from git commands (used by `git_status`, `git_log`, `git_blame`).

### Glossary
This document! Definitions of terms.

---

## H

### Hook
(Planned) Custom code executed on events (like `before_shutdown`). Currently, configure via `settings.json` (advanced).

---

## I

### Invoke
Tauri IPC call from frontend (TypeScript) to backend (Rust). Async request/response pattern.

### IPC
Inter-Process Communication. How the React frontend and Rust backend exchange data via Tauri.

---

## J

### JSON-RPC
Protocol used by MCP servers for tool definitions and calls. Request/response messages with method, params, and result.

---

## K

### Keychain
macOS credential vault where API keys are securely stored.

### Keybinding
Keyboard shortcut (e.g., `Ctrl+T`, `Cmd+J`). Customizable in Settings.

---

## L

### Language Model
AI system trained to generate text (OpenAI's GPT, Anthropic's Claude, Meta's Llama). Provides chat completeness, embeddings, etc.

### Listen
Tauri event subscription from frontend. Updates flow from backend (Rust) to frontend (React).

### LLM
Abbreviation for Language Model.

---

## M

### MCP
Model Context Protocol. Standard for connecting AI agents to external tools and data sources. See [MCP_INTEGRATION.md](MCP_INTEGRATION.md).

### MCP Server
Process or HTTP endpoint exposing tools and resources via MCP protocol. Examples: web search, database query, Slack API.

### Memory
Workspace-scoped notes saved in SQLite. Searchable by keyword (FTS5) or semantics (vector embedding).

---

## N

### Notification
Pop-up message or event from MCP server (e.g., "New Slack message arrived").

---

## O

### Ollama
Local LLM inference engine. Run models locally without sending data to the cloud. See [ollama.ai](https://ollama.ai).

### OSC 133
Shell Integration protocol for marking command boundaries (stdin/stdout/exit). Enables structured command logging.

---

## P

### Persona
AI agent personality/role. Examples: Chat Assistant, Code Explainer, Debug Buddy. Defined by system prompt.

### Popover
Floating UI panel that appears on top of other content. Examples: chat panel, approval prompt.

### Provider
LLM service (OpenAI, Anthropic, Ollama). Selected in Settings → Provider.

### PTY
Pseudo-terminal. Virtual terminal interface that acts like a real terminal. Connects to shell processes.

---

## Q

### Query
Search input (keyword or semantic). Used in file search, memory search, agent planning.

---

## R

### Resource
Data source exposed by MCP server (e.g., text file, database record, API endpoint).

---

## S

### Scoped
Limited to a specific context. Example: "memory is workspace-scoped" means each workspace has separate notes.

### Search Index
Tantivy BM25 index for fast full-text search. Built once per workspace root, cached on disk.

### Server Sent Events
HTTP protocol for one-way streaming from server to client. Used by MCP HTTP transport.

### Session
Active instance of ARC (one window). Contains workspaces, tabs, chat sessions.

### Shell
Command-line interpreter (bash, zsh, PowerShell, cmd, Nu, etc.). Runs in PTY.

### Splice
Custom find-and-replace operation. Agent tool `fs_edit` does splicing (safer than full file rewrite).

### SSE
Abbreviation for Server-Sent Events.

### System Prompt
Instructions given to the LLM to shape behavior (e.g., "You are a Rust expert"). Can be overridden per conversation.

---

## T

### Tantivy
Rust full-text search library. Used for BM25 indexing and search in ARC.

### Tauri
Desktop app framework combining Rust backend + web frontend (React + TypeScript). Provides window management, IPC, native system access.

### Terminal Tab
Open shell session in the terminal pane. Multiple tabs can exist; only one is visible at a time.

### Tool
Function exposed by an agent or MCP server. Examples: `fs_read_file`, `web_search`, `shell`.

### Tool Approval
See Approval.

### Typed Wrapper
Function in TypeScript that wraps a Tauri `invoke()` call with type checking. Example: `ptySpawn()` in `lib/tauri.ts`.

---

## U

### Untracked
File not committed to git. Shows up in `git_status`.

---

## V

### Vector Search
Semantic similarity search using embeddings. Finds notes/documents with similar meaning to your query (not just keyword matching).

---

## W

### Watcher
File system monitoring service. Emits events when files change in a watched directory.

### Workspace
Project-level container grouping tabs, chat sessions, and memory. Multiple workspaces can exist; switch between them via StatusBar.

---

## X

### xterm.js
Open-source terminal emulator component for the web. Renders the ARC terminal UI.

---

## Y

### (none)

---

## Z

### Zustand
Lightweight state management library for React. Used for workspace, chat, settings, files stores in ARC.

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) — System design and terminology context
- [API_REFERENCE.md](API_REFERENCE.md) — Technical command signatures
- [AGENTS.md](AGENTS.md) — Agent-specific terminology
