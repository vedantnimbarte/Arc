# API Reference — ARC Tauri Commands

Complete documentation of all 57 Tauri commands available in ARC. Each command is callable from the frontend via the typed wrappers in `apps/frontend/src/lib/tauri.ts`.

**Organization:** Commands are grouped by functional area. For architecture context, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## PTY (Pseudo-Terminal) Commands

### pty_spawn

Spawns a new terminal process and returns a unique tab ID.

**Signature:**
```typescript
ptySpawn(opts: { shell?: string; cwd?: string; cols?: number; rows?: number }): Promise<string>
```

**Parameters:**
- `shell` (optional) — Path to shell executable (e.g., `/bin/bash`, `pwsh.exe`). If omitted, uses default from Settings.
- `cwd` (optional) — Working directory. If omitted, defaults to home directory.
- `cols` (optional) — Terminal width in columns. Default: 80.
- `rows` (optional) — Terminal height in rows. Default: 24.

**Returns:** A unique string ID identifying the PTY session.

**Events emitted:**
- `pty://data/<id>` — Shell output (bytes)
- `pty://exit/<id>` — Process exit code

**Errors:**
- `"Shell not found: <path>"` — Shell executable doesn't exist
- `"Failed to spawn PTY: <reason>"` — OS-level PTY creation failed
- `"Invalid working directory: <cwd>"` — Directory doesn't exist

**Example:**
```typescript
const tabId = await ptySpawn({
  shell: '/bin/bash',
  cwd: '/home/user/project',
  cols: 100,
  rows: 30,
})

// Listen for output
onPtyData(tabId, (event) => {
  console.log('Shell output:', event.bytes)
})

// Listen for exit
onPtyExit(tabId, (event) => {
  console.log('Exit code:', event.code)
})
```

---

### pty_write

Writes bytes to a PTY's stdin.

**Signature:**
```typescript
ptyWrite(id: string, data: string): Promise<void>
```

**Parameters:**
- `id` — PTY session ID (from `pty_spawn`)
- `data` — String to send to the shell

**Returns:** Resolves when bytes are written to PTY's stdin.

**Errors:**
- `"PTY not found: <id>"` — No active PTY with this ID
- `"Failed to write to PTY: <reason>"` — I/O error

**Example:**
```typescript
await ptyWrite(tabId, 'ls -la\n')
```

---

### pty_resize

Resizes a PTY to new dimensions.

**Signature:**
```typescript
ptyResize(id: string, cols: number, rows: number): Promise<void>
```

**Parameters:**
- `id` — PTY session ID
- `cols` — New width in columns
- `rows` — New height in rows

**Returns:** Resolves when resize is applied.

**Errors:**
- `"PTY not found: <id>"` — No active PTY with this ID
- `"Invalid dimensions: cols=<cols>, rows=<rows>"` — Negative or zero dimensions

**Example:**
```typescript
await ptyResize(tabId, 120, 40)
```

---

### pty_kill

Terminates a PTY session.

**Signature:**
```typescript
ptyKill(id: string): Promise<void>
```

**Parameters:**
- `id` — PTY session ID

**Returns:** Resolves when PTY is killed.

**Errors:**
- `"PTY not found: <id>"` — No active PTY with this ID

**Example:**
```typescript
await ptyKill(tabId)
```

---

### pty_list_shells

Lists available shells on the system.

**Signature:**
```typescript
ptyListShells(): Promise<Array<{ name: string; path: string; available: boolean }>>
```

**Returns:** Array of shell info objects:
- `name` — Display name (e.g., "Bash", "PowerShell")
- `path` — Executable path
- `available` — Whether the shell is installed

**Errors:** None (graceful fallback to SHELL/COMSPEC).

**Example:**
```typescript
const shells = await ptyListShells()
// => [
//   { name: 'Bash', path: '/bin/bash', available: true },
//   { name: 'Zsh', path: '/bin/zsh', available: true },
//   { name: 'Fish', path: '/usr/local/bin/fish', available: false },
// ]
```

---

## LLM (Language Model) Commands

### llm_stream

Streams a chat request to an LLM provider (OpenAI, Anthropic, Ollama).

**Signature:**
```typescript
llmStream(req: {
  providerId?: string
  model?: string
  messages: Array<{ role: string; content: string }>
  systemPrompt?: string
  temperature?: number
}): Promise<() => Promise<void>>  // Returns cancel function
```

**Parameters:**
- `providerId` (optional) — Provider ID (openai, anthropic, ollama). If omitted, uses active provider from Settings.
- `model` (optional) — Model name (e.g., "gpt-4o-mini", "claude-sonnet-4-6"). If omitted, uses default for the provider.
- `messages` — Array of role/content pairs (role: "user" | "assistant" | "system")
- `systemPrompt` (optional) — System prompt override
- `temperature` (optional) — Sampling temperature (0.0–2.0, default 1.0)

**Returns:** A cancel function that, when called, aborts streaming.

**Events emitted:**
- `llm://chunk/<requestId>` — Token chunk `{ delta: string; ... }`
- `llm://done/<requestId>` — Completion `{ usage: { ... }, stop_reason: string }`

**Errors:**
- `"No API key configured for provider: <provider>"` — Missing credentials
- `"Model not found: <model>"` — Invalid model name
- `"Network error: <reason>"` — Connection or timeout
- `"Rate limited by provider"` — API rate limit exceeded

**Example:**
```typescript
const cancel = await llmStream({
  providerId: 'anthropic',
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello, Claude!' }],
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,
})

// Subscribe to chunks
onLlmChunk(requestId, (event) => {
  console.log('Token:', event.delta)
})

// User can cancel
await cancel()
```

---

### llm_cancel

Cancels an active LLM stream.

**Signature:**
```typescript
llmCancel(requestId: string): Promise<void>
```

**Parameters:**
- `requestId` — ID of the streaming request to cancel

**Returns:** Resolves when cancellation is processed.

**Errors:**
- `"Request not found: <requestId>"` — No active request with this ID

**Example:**
```typescript
await llmCancel(requestId)
```

---

## Filesystem Commands

### fs_default_root

Gets the system default root directory.

**Signature:**
```typescript
fsDefaultRoot(): Promise<string>
```

**Returns:** Absolute path to default root (home directory on most systems).

**Errors:** None.

**Example:**
```typescript
const root = await fsDefaultRoot()
// => "/home/user" or "C:\Users\User"
```

---

### fs_parent

Gets the parent directory of a path.

**Signature:**
```typescript
fsParent(path: string): Promise<string | null>
```

**Parameters:**
- `path` — File or directory path

**Returns:** Parent directory path, or `null` if already at root.

**Errors:** None (graceful).

**Example:**
```typescript
const parent = await fsParent('/home/user/project/src/main.rs')
// => "/home/user/project/src"
```

---

### fs_read_dir

Lists files and directories in a folder.

**Signature:**
```typescript
fsReadDir(path: string): Promise<Array<{
  name: string
  path: string
  isDir: boolean
  size?: number
  modified?: string
}>>
```

**Parameters:**
- `path` — Directory path

**Returns:** Array of entries (files and directories).

**Errors:**
- `"Directory not found: <path>"` — Path doesn't exist
- `"Permission denied: <path>"` — Access denied
- `"Not a directory: <path>"` — Path is a file, not a directory

**Example:**
```typescript
const entries = await fsReadDir('/home/user/project')
```

---

### fs_read_file

Reads a file's contents as a string.

**Signature:**
```typescript
fsReadFile(path: string): Promise<string>
```

**Parameters:**
- `path` — File path

**Returns:** File contents as UTF-8 string.

**Limits:**
- Maximum 5 MiB
- Refuses binary files (detects via magic bytes)

**Errors:**
- `"File not found: <path>"`
- `"Permission denied: <path>"`
- `"File too large: <size> > 5 MiB"`
- `"Binary file: <path>"` — Detected as non-UTF-8

**Example:**
```typescript
const content = await fsReadFile('/path/to/file.txt')
```

---

### fs_write_file

Writes contents to a file (creates or overwrites).

**Signature:**
```typescript
fsWriteFile(path: string, content: string): Promise<void>
```

**Parameters:**
- `path` — File path
- `content` — String to write

**Returns:** Resolves when file is written.

**Errors:**
- `"Permission denied: <path>"`
- `"Parent directory not found: <parent>"`

**Example:**
```typescript
await fsWriteFile('/path/to/file.txt', 'Hello, World!')
```

---

### fs_pick_folder

Opens a native folder picker dialog.

**Signature:**
```typescript
fsPickFolder(starting?: string): Promise<string | null>
```

**Parameters:**
- `starting` (optional) — Initial folder to show in dialog

**Returns:** Absolute path to selected folder, or `null` if cancelled.

**Errors:** None (user cancellation returns `null`).

**Example:**
```typescript
const folder = await fsPickFolder('/home/user')
if (folder) {
  console.log('Selected:', folder)
}
```

---

### fs_watch_start

Starts watching a directory for changes.

**Signature:**
```typescript
fsWatchStart(path: string): Promise<string>
```

**Parameters:**
- `path` — Directory path to watch

**Returns:** Watch ID (use with `fs_watch_stop`).

**Events emitted:**
- `fs://change/<watchId>` — `{ path, event: 'create' | 'modify' | 'delete' }`

**Errors:**
- `"Directory not found: <path>"`
- `"Permission denied: <path>"`

**Example:**
```typescript
const watchId = await fsWatchStart('/home/user/project')

onFsChange(watchId, (event) => {
  console.log(`File ${event.event}:`, event.path)
})
```

---

### fs_watch_stop

Stops watching a directory.

**Signature:**
```typescript
fsWatchStop(watchId: string): Promise<void>
```

**Parameters:**
- `watchId` — Watch ID (from `fs_watch_start`)

**Returns:** Resolves when watcher is stopped.

**Errors:**
- `"Watch not found: <watchId>"`

**Example:**
```typescript
await fsWatchStop(watchId)
```

---

### fs_search

Searches files by content using full-text search (BM25).

**Signature:**
```typescript
fsSearch(root: string, query: string, limit?: number): Promise<Array<{
  path: string
  lineNumber: number
  lineContent: string
  score: number
}>>
```

**Parameters:**
- `root` — Root directory to search
- `query` — Search query (simple keywords or operators)
- `limit` (optional) — Max results (default: 100)

**Returns:** Array of matching lines, ranked by BM25 score.

**Behavior:**
- Prefers tantivy index if built; falls back to walkdir if not
- Skips hidden files, node_modules, .git, etc.
- Case-insensitive

**Errors:**
- `"Directory not found: <root>"`
- `"Empty query"`

**Example:**
```typescript
const results = await fsSearch('/home/user/project', 'async function', 50)
// => [
//   { path: 'src/utils.ts', lineNumber: 42, lineContent: 'async function fetch() {', score: 9.5 },
//   ...
// ]
```

---

### fs_index_rebuild

Rebuilds the tantivy full-text index for a directory.

**Signature:**
```typescript
fsIndexRebuild(root: string): Promise<number>
```

**Parameters:**
- `root` — Root directory to index

**Returns:** Number of documents indexed.

**Errors:**
- `"Directory not found: <root>"`
- `"Indexing failed: <reason>"`

**Example:**
```typescript
const docCount = await fsIndexRebuild('/home/user/project')
console.log(`Indexed ${docCount} files`)
```

---

### fs_index_status

Checks if an index exists and is up-to-date.

**Signature:**
```typescript
fsIndexStatus(root: string): Promise<boolean>
```

**Parameters:**
- `root` — Root directory

**Returns:** `true` if index exists and is current; `false` otherwise.

**Errors:** None (graceful).

**Example:**
```typescript
const hasIndex = await fsIndexStatus('/home/user/project')
if (!hasIndex) {
  console.log('Index needs rebuilding')
}
```

---

## Git Commands

### git_status

Gets the current git status.

**Signature:**
```typescript
gitStatus(path: string): Promise<{
  branch: string
  ahead: number
  behind: number
  dirty: number
  untracked: number
} | null>
```

**Parameters:**
- `path` — Path to git repository

**Returns:** Git info, or `null` if not a git repo.

**Errors:** None (graceful fallback).

**Example:**
```typescript
const status = await gitStatus('/home/user/project')
if (status) {
  console.log(`Branch: ${status.branch}, ahead: ${status.ahead}, dirty: ${status.dirty}`)
}
```

---

### git_log

Retrieves git commit history.

**Signature:**
```typescript
gitLog(path: string, limit?: number, pathFilter?: string): Promise<Array<{
  hash: string
  author: string
  email: string
  message: string
  timestamp: number
}>>
```

**Parameters:**
- `path` — Repository path
- `limit` (optional) — Max commits (default: 50)
- `pathFilter` (optional) — Filter commits affecting this path

**Returns:** Commit entries.

**Errors:**
- `"Not a git repository: <path>"`
- `"Git command failed: <reason>"`

**Example:**
```typescript
const commits = await gitLog('/home/user/project', 20)
```

---

### git_diff

Shows changes between commits/stages.

**Signature:**
```typescript
gitDiff(path: string, scope: 'worktree' | 'staged' | 'head', pathFilter?: string): Promise<string>
```

**Parameters:**
- `path` — Repository path
- `scope` — What to diff:
  - `worktree` — Unstaged changes
  - `staged` — Staged changes
  - `head` — Changes in HEAD
- `pathFilter` (optional) — Filter by file path

**Returns:** Unified diff format string.

**Errors:**
- `"Not a git repository: <path>"`
- `"Git command failed: <reason>"`

**Example:**
```typescript
const diff = await gitDiff('/home/user/project', 'worktree')
```

---

### git_blame

Shows line-by-line blame info.

**Signature:**
```typescript
gitBlame(path: string, file: string, startLine?: number, endLine?: number): Promise<Array<{
  lineNumber: number
  hash: string
  author: string
  date: string
  code: string
}>>
```

**Parameters:**
- `path` — Repository path
- `file` — File path (relative to repo root)
- `startLine` (optional) — Start line number (1-indexed)
- `endLine` (optional) — End line number

**Returns:** Blame entries.

**Errors:**
- `"Not a git repository: <path>"`
- `"File not found: <file>"`
- `"Git command failed: <reason>"`

**Example:**
```typescript
const blame = await gitBlame('/home/user/project', 'src/main.ts', 1, 50)
```

---

## Session Commands

### session_load

Loads the current session state (tabs, workspace).

**Signature:**
```typescript
sessionLoad(): Promise<{
  sessionId: string
  tabs: Array<{ id: string; title: string; kind: 'terminal' | 'editor'; ... }>
  activeTabId: string
}>
```

**Returns:** Session state.

**Errors:**
- `"Failed to load session: <reason>"`

**Example:**
```typescript
const session = await sessionLoad()
```

---

### session_save_tabs

Saves the current tab state.

**Signature:**
```typescript
sessionSaveTabs(sessionId: string, tabs: Tab[], activeTabId?: string): Promise<void>
```

**Parameters:**
- `sessionId` — Current session ID
- `tabs` — Tab array
- `activeTabId` (optional) — Active tab ID

**Returns:** Resolves when saved.

**Errors:**
- `"Failed to save tabs: <reason>"`

**Example:**
```typescript
await sessionSaveTabs(sessionId, tabs, activeTabId)
```

---

### session_set_workspace

Sets the active workspace.

**Signature:**
```typescript
sessionSetWorkspace(sessionId: string, workspaceId?: string): Promise<void>
```

**Parameters:**
- `sessionId` — Current session ID
- `workspaceId` (optional) — Workspace ID (if omitted, clears workspace)

**Returns:** Resolves when set.

**Errors:**
- `"Workspace not found: <workspaceId>"`

**Example:**
```typescript
await sessionSetWorkspace(sessionId, workspaceId)
```

---

### session_workspaces_list

Lists all workspaces.

**Signature:**
```typescript
sessionWorkspacesList(): Promise<Array<{ id: string; name: string; root: string }>>
```

**Returns:** Workspace array.

**Errors:** None.

**Example:**
```typescript
const workspaces = await sessionWorkspacesList()
```

---

### session_workspace_upsert

Creates or updates a workspace.

**Signature:**
```typescript
sessionWorkspaceUpsert(name: string, root: string): Promise<{ id: string; name: string; root: string }>
```

**Parameters:**
- `name` — Workspace name
- `root` — Root directory path

**Returns:** Created/updated workspace.

**Errors:**
- `"Directory not found: <root>"`

**Example:**
```typescript
const ws = await sessionWorkspaceUpsert('My Project', '/home/user/my-project')
```

---

### session_workspace_delete

Deletes a workspace.

**Signature:**
```typescript
sessionWorkspaceDelete(id: string): Promise<void>
```

**Parameters:**
- `id` — Workspace ID

**Returns:** Resolves when deleted.

**Errors:**
- `"Workspace not found: <id>"`

**Example:**
```typescript
await sessionWorkspaceDelete(workspaceId)
```

---

## Chat Commands

### session_chat_load

Loads all chat sessions for a workspace.

**Signature:**
```typescript
sessionChatLoad(workspaceId?: string): Promise<{
  conversations: Array<{ id: string; title: string; agentId: string; ... }>
  activeConversationId: string
}>
```

**Parameters:**
- `workspaceId` (optional) — Workspace ID (if omitted, loads default)

**Returns:** Chat load data.

**Errors:**
- `"Workspace not found: <workspaceId>"`

**Example:**
```typescript
const { conversations, activeConversationId } = await sessionChatLoad(workspaceId)
```

---

### session_chat_append

Appends a message to a chat.

**Signature:**
```typescript
sessionChatAppend(conversationId: string, role: 'user' | 'assistant' | 'system', content: string): Promise<{
  id: string
  conversationId: string
  role: string
  content: string
  createdAt: string
}>
```

**Parameters:**
- `conversationId` — Chat conversation ID
- `role` — Message role
- `content` — Message text

**Returns:** Created message.

**Errors:**
- `"Conversation not found: <conversationId>"`

**Example:**
```typescript
const msg = await sessionChatAppend(convId, 'user', 'Hello!')
```

---

### session_chat_clear

Clears all messages in a conversation.

**Signature:**
```typescript
sessionChatClear(conversationId: string): Promise<void>
```

**Parameters:**
- `conversationId` — Chat conversation ID

**Returns:** Resolves when cleared.

**Errors:**
- `"Conversation not found: <conversationId>"`

**Example:**
```typescript
await sessionChatClear(convId)
```

---

### session_chat_sessions_list

Lists all chat sessions in a workspace.

**Signature:**
```typescript
sessionChatSessionsList(workspaceId?: string): Promise<Array<{
  id: string
  title: string
  agentId: string
  createdAt: string
}>>
```

**Returns:** Conversation array.

**Errors:** None.

**Example:**
```typescript
const convs = await sessionChatSessionsList(workspaceId)
```

---

### session_chat_session_create

Creates a new chat session.

**Signature:**
```typescript
sessionChatSessionCreate(workspaceId?: string, agentId?: string, title?: string): Promise<{
  id: string
  title: string
  agentId: string
}>
```

**Parameters:**
- `workspaceId` (optional) — Workspace ID
- `agentId` (optional) — Agent ID (default: Chat Assistant)
- `title` (optional) — Session title (auto-generated if omitted)

**Returns:** Created conversation.

**Errors:** None.

**Example:**
```typescript
const conv = await sessionChatSessionCreate(workspaceId, 'code-explainer', 'Code Review')
```

---

### session_chat_session_update

Updates a chat session.

**Signature:**
```typescript
sessionChatSessionUpdate(id: string, title?: string, agentId?: string): Promise<void>
```

**Parameters:**
- `id` — Conversation ID
- `title` (optional) — New title
- `agentId` (optional) — New agent ID

**Returns:** Resolves when updated.

**Errors:**
- `"Conversation not found: <id>"`

**Example:**
```typescript
await sessionChatSessionUpdate(convId, 'New Title')
```

---

### session_chat_session_delete

Deletes a chat session.

**Signature:**
```typescript
sessionChatSessionDelete(id: string): Promise<void>
```

**Parameters:**
- `id` — Conversation ID

**Returns:** Resolves when deleted.

**Errors:**
- `"Conversation not found: <id>"`

**Example:**
```typescript
await sessionChatSessionDelete(convId)
```

---

### session_chat_messages_load

Loads all messages in a conversation.

**Signature:**
```typescript
sessionChatMessagesLoad(conversationId: string): Promise<Array<{
  id: string
  role: string
  content: string
  createdAt: string
}>>
```

**Returns:** Message array.

**Errors:**
- `"Conversation not found: <conversationId>"`

**Example:**
```typescript
const messages = await sessionChatMessagesLoad(convId)
```

---

## Command History Commands

### session_command_log

Logs a shell command.

**Signature:**
```typescript
sessionCommandLog(cwd: string, command: string, tabId?: string, workspaceId?: string): Promise<number>
```

**Parameters:**
- `cwd` — Current working directory
- `command` — Command text
- `tabId` (optional) — Terminal tab ID
- `workspaceId` (optional) — Workspace ID

**Returns:** Command entry ID.

**Errors:** None.

**Example:**
```typescript
const entryId = await sessionCommandLog('/home/user/project', 'npm test', tabId)
```

---

### session_commands_recent

Retrieves recent commands, optionally filtered.

**Signature:**
```typescript
sessionCommandsRecent(limit?: number, query?: string): Promise<Array<{
  id: number
  command: string
  cwd: string
  exitCode?: number
  finishedAt?: string
}>>
```

**Parameters:**
- `limit` (optional) — Max results (default: 50)
- `query` (optional) — Search query

**Returns:** Command array.

**Errors:** None.

**Example:**
```typescript
const recent = await sessionCommandsRecent(20, 'npm')
```

---

### session_command_finish

Marks a command as finished with exit code and output.

**Signature:**
```typescript
sessionCommandFinish(id: number, exitCode?: number, outputExcerpt?: string): Promise<void>
```

**Parameters:**
- `id` — Command entry ID
- `exitCode` (optional) — Exit code from shell
- `outputExcerpt` (optional) — First 4 KiB of output

**Returns:** Resolves when updated.

**Errors:**
- `"Command not found: <id>"`

**Example:**
```typescript
await sessionCommandFinish(entryId, 0, 'Test output...')
```

---

## Agent Commands

### agent_run

Runs an agent with a goal.

**Signature:**
```typescript
agentRun(req: {
  goal: string
  conversationId?: string
  workspaceId?: string
  systemPrompt?: string
}): Promise<void>
```

**Parameters:**
- `goal` — What the agent should do
- `conversationId` (optional) — Chat context
- `workspaceId` (optional) — Workspace context
- `systemPrompt` (optional) — Override system prompt

**Returns:** Resolves immediately; events stream afterward.

**Events emitted:**
- `agent://event/<runId>` — Agent event (thinking, tool call, approval, result, error)

**Errors:**
- `"Workspace not found: <workspaceId>"`
- `"Conversation not found: <conversationId>"`

**Example:**
```typescript
await agentRun({
  goal: 'Fix the bug in main.rs',
  conversationId: convId,
  systemPrompt: 'You are a Rust expert.',
})

onAgentEvent(runId, (event) => {
  if (event.type === 'tool_call') {
    console.log('Tool:', event.tool, 'Args:', event.args)
  }
})
```

---

### agent_decide

Approves or denies a pending tool call.

**Signature:**
```typescript
agentDecide(approvalId: string, approve: boolean): Promise<void>
```

**Parameters:**
- `approvalId` — ID of the pending approval
- `approve` — `true` to allow, `false` to deny

**Returns:** Resolves when decision is processed.

**Errors:**
- `"Approval not found: <approvalId>"`

**Example:**
```typescript
await agentDecide(approvalId, true)  // Approve
```

---

## MCP (Model Context Protocol) Commands

### mcp_connect

Connects to an MCP server via stdio.

**Signature:**
```typescript
mcpConnect(id: string, command: string, args?: string[]): Promise<void>
```

**Parameters:**
- `id` — Unique server ID
- `command` — Executable path (e.g., "npx", "python")
- `args` (optional) — Command arguments (e.g., ["my-mcp-server"])

**Returns:** Resolves when connected.

**Errors:**
- `"Command not found: <command>"`
- `"Failed to start server: <reason>"`

**Example:**
```typescript
await mcpConnect('my-server', 'npx', ['@myorg/my-mcp-server'])
```

---

### mcp_connect_http

Connects to an MCP server via HTTP/SSE.

**Signature:**
```typescript
mcpConnectHttp(id: string, url: string, headers?: Record<string, string>): Promise<void>
```

**Parameters:**
- `id` — Unique server ID
- `url` — Server endpoint (e.g., `http://localhost:3000/mcp`)
- `headers` (optional) — Custom headers (e.g., `{ Authorization: 'Bearer <token>' }`)

**Returns:** Resolves when connected.

**Errors:**
- `"Connection failed: <reason>"`
- `"Invalid URL: <url>"`

**Example:**
```typescript
await mcpConnectHttp('remote-server', 'http://api.example.com/mcp', {
  Authorization: 'Bearer token123',
})
```

---

### mcp_list_tools

Lists available tools from an MCP server.

**Signature:**
```typescript
mcpListTools(id: string): Promise<Array<{
  name: string
  description: string
  inputSchema: object
}>>
```

**Parameters:**
- `id` — Server ID

**Returns:** Tool array.

**Errors:**
- `"Server not connected: <id>"`
- `"Failed to list tools: <reason>"`

**Example:**
```typescript
const tools = await mcpListTools('my-server')
```

---

### mcp_call_tool

Calls a tool on an MCP server.

**Signature:**
```typescript
mcpCallTool(id: string, name: string, args: Record<string, any>): Promise<string>
```

**Parameters:**
- `id` — Server ID
- `name` — Tool name
- `args` — Tool arguments

**Returns:** Tool result as string.

**Errors:**
- `"Server not connected: <id>"`
- `"Tool not found: <name>"`
- `"Tool execution failed: <reason>"`

**Example:**
```typescript
const result = await mcpCallTool('my-server', 'read_file', { path: '/etc/hosts' })
```

---

### mcp_disconnect

Disconnects from an MCP server.

**Signature:**
```typescript
mcpDisconnect(id: string): Promise<void>
```

**Parameters:**
- `id` — Server ID

**Returns:** Resolves when disconnected.

**Errors:**
- `"Server not connected: <id>"`

**Example:**
```typescript
await mcpDisconnect('my-server')
```

---

## Secrets Commands

### secrets_set_api_key

Stores an API key in the OS credential vault.

**Signature:**
```typescript
secretsSetApiKey(provider: string, key: string): Promise<void>
```

**Parameters:**
- `provider` — Provider ID (openai, anthropic, ollama, etc.)
- `key` — API key (empty string to delete)

**Returns:** Resolves when stored.

**Errors:**
- `"Failed to store key: <reason>"`

**Example:**
```typescript
await secretsSetApiKey('openai', 'sk-...')
await secretsSetApiKey('openai', '')  // Delete
```

---

### secrets_get_api_key

Retrieves an API key from the credential vault.

**Signature:**
```typescript
secretsGetApiKey(provider: string): Promise<string | null>
```

**Parameters:**
- `provider` — Provider ID

**Returns:** API key, or `null` if not found.

**Errors:** None.

**Example:**
```typescript
const key = await secretsGetApiKey('openai')
```

---

### secrets_delete_api_key

Deletes an API key.

**Signature:**
```typescript
secretsDeleteApiKey(provider: string): Promise<void>
```

**Parameters:**
- `provider` — Provider ID

**Returns:** Resolves when deleted.

**Errors:** None.

**Example:**
```typescript
await secretsDeleteApiKey('openai')
```

---

## Memory Commands

### memory_save

Saves a memory entry (note).

**Signature:**
```typescript
memorySave(req: {
  workspaceId?: string
  kind?: string
  title: string
  content: string
  tags?: string[]
  source?: string
}): Promise<{ id: string; ... }>
```

**Parameters:**
- `workspaceId` (optional) — Workspace ID
- `kind` (optional) — Entry type (e.g., "note", "snippet", "decision")
- `title` — Entry title
- `content` — Entry content
- `tags` (optional) — Tags
- `source` (optional) — Source (e.g., "user", "agent", "system")

**Returns:** Created memory entry.

**Errors:** None.

**Example:**
```typescript
const entry = await memorySave({
  workspaceId: wsId,
  title: 'Token Limits',
  content: 'Claude 3.5 Sonnet: 200k input, 4k output',
  tags: ['limits', 'llm'],
})
```

---

### memory_update

Updates a memory entry.

**Signature:**
```typescript
memoryUpdate(id: string, req: { title?: string; content?: string; tags?: string[] }): Promise<void>
```

**Parameters:**
- `id` — Memory entry ID
- `title` (optional) — New title
- `content` (optional) — New content
- `tags` (optional) — New tags

**Returns:** Resolves when updated.

**Errors:**
- `"Memory not found: <id>"`

**Example:**
```typescript
await memoryUpdate(entryId, { title: 'Updated Title' })
```

---

### memory_delete

Deletes a memory entry.

**Signature:**
```typescript
memoryDelete(id: string): Promise<void>
```

**Parameters:**
- `id` — Memory entry ID

**Returns:** Resolves when deleted.

**Errors:**
- `"Memory not found: <id>"`

**Example:**
```typescript
await memoryDelete(entryId)
```

---

### memory_get

Retrieves a single memory entry.

**Signature:**
```typescript
memoryGet(id: string): Promise<{ id: string; title: string; content: string; ... } | null>
```

**Parameters:**
- `id` — Memory entry ID

**Returns:** Memory entry, or `null` if not found.

**Errors:** None.

**Example:**
```typescript
const entry = await memoryGet(entryId)
```

---

### memory_list

Lists all memory entries.

**Signature:**
```typescript
memoryList(workspaceId?: string, limit?: number): Promise<Array<{ id: string; title: string; ... }>>
```

**Parameters:**
- `workspaceId` (optional) — Filter by workspace
- `limit` (optional) — Max results (default: 100)

**Returns:** Memory entry array.

**Errors:** None.

**Example:**
```typescript
const entries = await memoryList(wsId, 50)
```

---

### memory_search

Searches memory entries by keyword (FTS5).

**Signature:**
```typescript
memorySearch(workspaceId?: string, query: string, limit?: number): Promise<Array<{
  id: string
  title: string
  content: string
  score: number
}>>
```

**Parameters:**
- `workspaceId` (optional) — Filter by workspace
- `query` — Search query
- `limit` (optional) — Max results (default: 50)

**Returns:** Search results ranked by relevance.

**Errors:**
- `"Empty query"`

**Example:**
```typescript
const results = await memorySearch(wsId, 'token limits', 20)
```

---

### memory_embed_entry

Computes and stores a vector embedding for a memory entry.

**Signature:**
```typescript
memoryEmbedEntry(id: string, req: {
  provider: string
  model: string
  text: string
  apiKey?: string
  baseUrl?: string
}): Promise<void>
```

**Parameters:**
- `id` — Memory entry ID
- `provider` — Embedding provider (openai, ollama, etc.)
- `model` — Embedding model name
- `text` — Text to embed
- `apiKey` (optional) — Override API key
- `baseUrl` (optional) — Override base URL

**Returns:** Resolves when embedded.

**Errors:**
- `"Memory not found: <id>"`
- `"Embedding failed: <reason>"`

**Example:**
```typescript
await memoryEmbedEntry(entryId, {
  provider: 'openai',
  model: 'text-embedding-3-small',
  text: entry.content,
})
```

---

### memory_vector_search

Searches memory entries by semantic similarity.

**Signature:**
```typescript
memoryVectorSearch(workspaceId?: string, req: {
  provider: string
  model: string
  query: string
  limit?: number
  apiKey?: string
  baseUrl?: string
}): Promise<Array<{ id: string; title: string; score: number }>>
```

**Parameters:**
- `workspaceId` (optional) — Filter by workspace
- `provider` — Embedding provider
- `model` — Embedding model
- `query` — Search query (will be embedded)
- `limit` (optional) — Max results (default: 20)
- `apiKey` (optional) — Override API key
- `baseUrl` (optional) — Override base URL

**Returns:** Search results ranked by cosine similarity.

**Errors:**
- `"Embedding failed: <reason>"`

**Example:**
```typescript
const results = await memoryVectorSearch(wsId, {
  provider: 'openai',
  model: 'text-embedding-3-small',
  query: 'How many tokens does Claude use?',
  limit: 10,
})
```

---

## Error Handling

All commands reject with a string error message. Use try/catch:

```typescript
try {
  const content = await fsReadFile('/path/to/file.txt')
} catch (error) {
  console.error('Error:', error as string)
  // Handle gracefully
}
```

---

## Batch Operations

For better performance, batch related operations:

```typescript
// ❌ Slow: sequential
await sessionCommandLog(cwd, 'npm install')
await sessionCommandLog(cwd, 'npm test')
await sessionCommandLog(cwd, 'npm build')

// ✅ Better: parallel where possible
await Promise.all([
  sessionCommandLog(cwd, 'npm install'),
  fsSearch(root, 'test'),
])
```

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) — System design
- [FEATURES.md](FEATURES.md) — User-facing feature guides
- [DEVELOPMENT.md](DEVELOPMENT.md) — Contributing
