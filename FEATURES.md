# Features & User Guides — ARC

Comprehensive guides for each major feature in ARC. Choose a feature below and follow the step-by-step instructions.

**Quick navigation:**
- [Terminal](#terminal) — Running shells and commands
- [Code Editor](#code-editor) — Opening and editing files
- [AI Chat](#ai-chat) — Chatting with LLMs
- [Coding Agent](#coding-agent) — Automating tasks with agents
- [File Search](#file-search) — Finding files by content
- [Memory & Notes](#memory--notes) — Saving and searching notes
- [Settings](#settings) — Configuration and customization

---

## Terminal

### The Terminal Pane

The terminal is a real PTY (pseudo-terminal) backing xterm.js. It runs actual shell processes and behaves like iTerm2, Windows Terminal, or GNOME Terminal.

### Opening a New Terminal Tab

**Keyboard shortcut:** `Ctrl+T` (Windows/Linux) or `Cmd+T` (macOS)

**Via UI:**
1. Click the **+** button in the TabBar (top-left)
2. Select "New Terminal" from the menu

A new terminal tab opens with your default shell (set in Settings).

### Switching Between Terminals

**Via keyboard:**
- `Ctrl+Tab` — Next tab
- `Ctrl+Shift+Tab` — Previous tab
- `Ctrl+1` through `Ctrl+9` — Jump to tab 1–9

**Via UI:** Click any tab in the TabBar.

### Running Commands

Type commands as you would in any shell:

```bash
$ npm test
$ git log --oneline
$ python script.py
$ ls -la
```

Commands run with the PTY environment inherited from your system (PATH, HOME, etc.). If a command isn't found, ensure it's installed on your system.

### Resizing the Terminal

Grab the **divider** between the file tree and terminal and drag left/right to resize. The terminal automatically detects the new size and adjusts.

Terminal can also be resized manually in code if needed:

```typescript
await ptyResize(tabId, 150, 40)  // 150 cols x 40 rows
```

### Changing Shells

**Via Settings:**
1. Press `Ctrl+,` (or `Cmd+,` on macOS) to open Settings
2. Navigate to **Settings > Terminal**
3. Click the shell dropdown to select a different shell (bash, zsh, fish, PowerShell, cmd, Nu, etc.)
4. Or enter a custom path (e.g., `/opt/homebrew/bin/fish`)
5. Open a new terminal tab to use the new shell

**Per-terminal:**
You can also explicitly run a different shell in the current tab:

```bash
$ zsh
$ exit
```

### Command History

**Open the command palette:** `Ctrl+R` (or `Cmd+R`)

This shows recent commands you've typed, searchable by keyword. Select a command to paste it into the active terminal.

Commands are persisted to the database and survive app restarts.

### Shell Integration (OSC 133)

ARC supports OSC 133 shell integration, which marks command boundaries so the app can capture exit codes and output. This is useful for structured command history.

**Configure for bash:**
Add to `~/.bashrc`:
```bash
PS0='${PS0}\[\e]133;A\007\]'
PROMPT_COMMAND='{ PS1="\[\e]133;B\007\]$PS1"; }; '"${PROMPT_COMMAND#*}"
trap '[[ -z $BASHcommand_IGNORED ]] && builtin echo -e "\e]133;C;$?\007\e]133;D\007"' DEBUG
```

**Configure for zsh:**
Add to `~/.zshrc`:
```zsh
precmd() { echo -ne "\e]133;C\007" }
preexec() { echo -ne "\e]133;A\007" }
```

This is optional; basic command logging works without it.

---

## Code Editor

### Opening a File

**Method 1: Via File Tree**
1. Left-click a file in the file tree sidebar
2. It opens in the main editor pane

**Method 2: From Terminal**
Type a command like:
```bash
$ vim file.txt    # Opens in $EDITOR (if configured)
```

**Method 3: Drag a file path into the active terminal**
Click a file path in the file tree to auto-insert it into the terminal, useful for piping to commands.

### Editing Files

The editor uses CodeMirror 6 with:
- Syntax highlighting (detects language from file extension)
- Line numbering
- Basic keybindings (vim/emacs optional via extensions)
- Git-aware (shows modified indicator)

### Saving Changes

**Keyboard:** `Ctrl+S` (or `Cmd+S`)

**Auto-save:** Disabled by default. Set via Settings if desired.

### File Size Limits

- **Maximum file size:** 5 MiB
- **Binary files:** Refused (detected via magic bytes)

If a file exceeds the limit or is binary, open it in an external editor instead.

### Syntax Highlighting

Language detection is automatic based on file extension. Supported languages include:

- JavaScript/TypeScript (`*.js`, `*.ts`, `*.tsx`, `*.jsx`)
- Python (`*.py`)
- Rust (`*.rs`)
- SQL (`*.sql`)
- Markdown (`*.md`)
- JSON (`*.json`)
- YAML (`*.yaml`, `*.yml`)
- And ~50+ others

For unsupported languages, the editor shows plain text with line numbers.

### Editor Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Shift+Z` / `Cmd+Shift+Z` | Redo |
| `Ctrl+F` / `Cmd+F` | Find (in-editor search) |
| `Ctrl+H` / `Cmd+H` | Find & Replace |
| `Ctrl+G` / `Cmd+G` | Go to Line |
| `Tab` | Indent; `Shift+Tab` to dedent |

---

## AI Chat

### Opening the Chat Panel

**Keyboard shortcut:** `Ctrl+J` (or `Cmd+J`)

The chat panel slides in from the bottom-right. It's a floating popover that doesn't interrupt your terminal or editor.

### Sending a Message

1. Click in the message composer (bottom of the chat panel)
2. Type your message
3. Press `Enter` (or `Shift+Enter` for newline) to send

The message is sent to the active LLM provider and the response streams token-by-token.

### Switching AI Providers

**Via Settings:**
1. Press `Ctrl+,` to open Settings
2. Go to **Settings > Provider**
3. Select your provider:
   - **OpenAI** — Requires API key from [platform.openai.com](https://platform.openai.com/api-keys). Default model: `gpt-4o-mini`
   - **Anthropic** — Requires API key from [console.anthropic.com](https://console.anthropic.com). Default model: `claude-sonnet-4-6` (recommended)
   - **Ollama** — Local. Requires Ollama running (`ollama serve`). Default model: `llama3.2:1b`
4. Paste your API key into the **API Key** field (encrypted in credential vault)
5. Optionally override **Model** and **Base URL**
6. Click Save

### Selecting an Agent

**Via the agent picker:** `Ctrl+/` (or `Cmd+/`)

Choose a persona for the conversation:
- **Chat Assistant** — General-purpose conversation
- **Task Planner** — Break down goals into steps
- **Sprint Planner** — Plan sprints and milestones
- **Review Agent** — Code review and feedback
- **Code Explainer** — Explain code in detail
- **Debug Buddy** — Help debugging issues

Each agent has a system prompt that shapes its responses.

### Chat History

**Open the sessions panel:** `Ctrl+Shift+L` (or `Cmd+Shift+L`)

This shows all saved chat sessions. Click a session to load it.

**Create a new chat:**
1. Open the sessions panel
2. Click **New Chat**
3. Choose an agent
4. Optionally set a title

### Clearing a Chat

Open the chat panel and look for the **Clear** button (⊘ icon) to delete all messages in the current session.

### System Prompt

In Settings, set a custom **System Prompt** that applies to all conversations:

```
You are a helpful programming assistant. 
Provide concise, code-first answers.
Use the active context (files, terminal) when relevant.
```

---

## Coding Agent

### Running an Agent

In the chat panel, type `/agent <goal>`:

```
/agent fix the typo in main.rs
/agent implement the TODO in api.ts
/agent write a test for the getUserById function
```

The agent:
1. Reads files in the workspace
2. Searches for relevant code
3. Runs shell commands
4. Edits files with your approval
5. Refines based on feedback

### Approving Tool Calls

When the agent wants to write a file or run a shell command, **you must approve** it:

```
🤖 Agent wants to: fs_write_file("src/main.rs", "...new content...")

[Approve] [Deny]
```

Click **Approve** to let it proceed, or **Deny** to reject.

**Closing the popover** (pressing Escape) auto-denies all pending approvals.

### Built-in Agent Tools

The agent has access to these tools:

| Tool | What It Does |
|------|---|
| `fs_read_file` | Read file contents |
| `fs_list_dir` | List directory contents |
| `fs_search` | Full-text search files |
| `fs_write_file` | Write/create files (needs approval) |
| `fs_edit` | Surgical find/replace edits (needs approval) |
| `shell` | Run shell commands (needs approval) |
| `git_status` | Check git status |
| `git_log` | View commit history |
| `git_diff` | Show changes |
| `memory_save` | Save a note to memory |
| `memory_search` | Search saved notes |

### Agent Limitations

- **Execution time:** 30 second timeout per tool call
- **Output cap:** 16 KiB per tool call
- **Scope:** Workspace-aware (respects file tree root)
- **Tools:** Up to 32 MCP tools can be bridged in (see [MCP_INTEGRATION.md](MCP_INTEGRATION.md))

### Extending the Agent with MCP

Connect an MCP server to give the agent access to custom tools:

1. See [MCP_INTEGRATION.md](MCP_INTEGRATION.md) for setup
2. `/mcp connect my-server` in chat
3. Agent automatically gains access to those tools

Example:

```
/mcp connect web-search
/agent search for recent Claude updates
```

The agent uses the `web_search` tool automatically.

### Agent Memory

During an agent run, `/memory save` and `/memory search` are available so the agent can reference your notes. This is useful for giving the agent context:

```
/memory save
Title: Code Style Guide
Content: Use snake_case for function names, PascalCase for types

/agent refactor auth.ts according to our code style guide
```

The agent searches your memory to find the style guide and applies it.

---

## File Search

### Opening the Search Palette

**Keyboard shortcut:** `Ctrl+P` (or `Cmd+P`)

The search palette opens with a text input. As you type, results appear below.

### Searching Files by Name & Content

**Search by name:**
```
main
```

Matches files like `main.ts`, `main.rs`, `src/main/lib.rs`.

**Search by content (full-text):**
```
async function fetchData
```

Returns lines matching the phrase, ranked by relevance.

**Operators:**
- Simple keywords: `test auth` (matches lines with "test" AND "auth")
- Field filter: `path:src type:function` (if index supports it)

### Clicking a Result

Click a search result to:
1. Open the file in the editor
2. Jump to that line
3. Close the search palette

### Search Speed

- **First search:** May be slower (tantivy index is built on-demand)
- **Subsequent searches:** Fast (uses persisted index)

**Rebuild the index:**
Via the agent or manually through the FileTree menu → "Rebuild Index".

---

## Memory & Notes

### Creating a Note

In the chat, use the `/memory save` command:

```
/memory save
Title: Token Limits for Claude
Content: Claude 3.5 Sonnet: 200,000 input tokens, 4,096 output tokens.
Tags: limits, llm
```

Notes are stored in SQLite and survive app restarts.

### Listing Your Notes

Use `/memory list` in chat:

```
/memory list
```

Returns all saved notes with titles and previews.

### Searching Notes

**Keyword search:**
```
/memory search token limits
```

Uses full-text search (FTS5) for fast keyword matching.

**Semantic search (requires setup):**

If you've embedded your notes with OpenAI or Ollama embeddings, use semantic search:

```
/memory search -semantic What are the token limits for different models?
```

Returns notes by semantic similarity, not just keywords.

### Embedding Notes for Semantic Search

To enable semantic search:

1. Save a note (as above)
2. From the agent or via the API:
   ```typescript
   await memoryEmbedEntry(entryId, {
     provider: 'openai',
     model: 'text-embedding-3-small',
     text: noteContent,
   })
   ```

Now the note can be found via semantic search.

### Updating & Deleting Notes

Use `/memory update` and `/memory delete`:

```
/memory update <id> Title: New Title
/memory delete <id>
```

---

## Settings

### Opening Settings

**Keyboard shortcut:** `Ctrl+,` (or `Cmd+,`)

Settings dialog opens as a modal. Scroll through sections or close with Escape.

### Provider Settings

**Location:** Settings > Provider

**Options:**
- **Provider** — openai, anthropic, or ollama
- **API Key** — Credentials (encrypted in OS vault, never stored as plaintext)
- **Model** (optional) — Override default model for the provider
- **Base URL** (optional) — For self-hosted endpoints (e.g., local Ollama)

### Terminal Settings

**Location:** Settings > Terminal

**Options:**
- **Default Shell** — Dropdown of available shells + custom path field
- **Shell Availability** — Shows which shells are installed on your system

New terminals use the selected shell.

### Appearance Settings

**Location:** Settings > Appearance

**Options:**
- **Theme** — Light/Dark (default: Dark)
- **Font Size** — Adjust UI font size
- **Monospace Font** — For editor and terminal (defaults to system mono stack)

### Keyboard Shortcuts

**Location:** Settings > Keyboard Shortcuts

View all keybindings and customize them. Custom overrides are persisted.

**Example overrides:**
- Change `Ctrl+P` file search to `Ctrl+Shift+P`
- Change `Ctrl+,` settings to `Ctrl+.`

### About

**Location:** Settings > About

- ARC version
- Links to documentation and GitHub
- Build info

---

## Workspace Management

### Creating a Workspace

A **workspace** groups related files and tabs together. Multiple workspaces let you switch between different projects.

**Create a workspace:**
1. Click the **Workspace** dropdown in the StatusBar (bottom-left)
2. Click **New Workspace**
3. Enter a name (e.g., "My Project")
4. Pick a root folder
5. The workspace becomes active

### Switching Workspaces

Click the **Workspace** dropdown in the StatusBar and select a workspace to switch.

### Workspace Persistence

Each workspace stores:
- Open tabs and active tab
- File tree root path
- Chat sessions (workspace-scoped)
- Memory entries (workspace-scoped)

These persist across app restarts.

### Deleting a Workspace

1. Click the **Workspace** dropdown
2. Select the workspace to delete
3. Click **Delete**
4. The workspace and its sessions are removed

---

## Keyboard Shortcuts Reference

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New terminal |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+,` | Settings |
| `Ctrl+J` | Toggle chat |
| `Ctrl+P` | Search files |
| `Ctrl+R` | Command history |
| `Ctrl+/` | Agent picker |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+N` | New chat |
| `Ctrl+Shift+L` | Chat sessions |
| `Ctrl+Shift+?` | Keyboard shortcuts |
| `Escape` | Close popover / Cancel |

All shortcuts are customizable in Settings.

---

## Tips & Tricks

### Copy File Paths

In the file tree, right-click a file to copy its path to your clipboard, or click it to paste into the terminal.

### Multi-cursor Editing

The editor supports multi-cursor (usually `Ctrl+D` or `Cmd+D` to add cursor at next match).

### Search in Editor

Use `Ctrl+F` (in-editor search) while editing, separate from the global file search (`Ctrl+P`).

### Agent Debugging

If an agent run fails, check:
1. The error message in the chat
2. Recent command history (`Ctrl+R`) for shell failures
3. File permissions for fs_write_file errors

### Large Codebases

For repos > 100K files:
- Rebuild the search index (`fs_index_rebuild`)
- Use more specific search queries
- Consider memory limits if indexing is slow

---

## See Also

- [API_REFERENCE.md](API_REFERENCE.md) — Detailed command signatures
- [AGENTS.md](AGENTS.md) — Deep dive into the agent system
- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) — Connecting custom tools via MCP
