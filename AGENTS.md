# Agents Guide — ARC

**Agents** are autonomous AI systems that can read files, search code, run shell commands, and edit files—all with your explicit approval. This guide explains how agents work and how to extend them with custom tools.

**Quick navigation:**
- [How Agents Work](#how-agents-work)
- [Running an Agent](#running-an-agent)
- [Built-in Tools](#built-in-tools)
- [Approval Gating](#approval-gating)
- [Custom Agents](#custom-agents)
- [Agent Memory](#agent-memory)
- [Extending with MCP](#extending-with-mcp)
- [Troubleshooting](#troubleshooting)

See [FEATURES.md](FEATURES.md) for user-facing agent guides, or [MCP_INTEGRATION.md](MCP_INTEGRATION.md) to add custom tools.

---

## How Agents Work

### Architecture

```
User: "/agent refactor auth.ts"
         ↓
   ┌─────────────────────────────┐
   │ Agent Runtime (Rust)        │
   │  1. Plan: Break down goal   │
   │  2. Loop:                   │
   │     - Choose next tool      │
   │     - Call tool             │
   │     - Await approval (if    │
   │       mutating)             │
   │     - Refine based on result│
   │  3. Return result           │
   └─────────────────────────────┘
         ↓
  ┌──────────────────────────────┐
  │ Tools                        │
  │  • fs_read_file              │
  │  • fs_write_file (approval)  │
  │  • shell (approval)          │
  │  • git_* (read-only)         │
  │  • memory_* (mixed)          │
  │  • MCP tools (dynamic)       │
  └──────────────────────────────┘
         ↓
User sees results in chat
```

### Agentic Loop

1. **Initial prompt:** Agent receives your goal (e.g., "refactor auth.ts")
2. **Planning:** Agent thinks about what to do
3. **Tool selection:** Agent picks the most relevant tool
4. **Execution:**
   - For read-only tools (fs_read_file, git_log): Run immediately
   - For mutating tools (fs_write_file, shell): Show approval prompt
5. **Feedback:** User approves, denies, or ignores (which auto-denies)
6. **Iteration:** Agent uses feedback to refine its next step
7. **Termination:** Agent completes goal or runs out of steps

### Example Run

```
User: /agent add TypeScript to the project

Agent (thinking): The goal is to add TypeScript. I should:
  1. Check project structure
  2. Look at package.json
  3. Install TypeScript
  4. Create a tsconfig.json
  
Step 1: Read package.json
Tool: fs_read_file("package.json")
Result: { "name": "my-app", "scripts": { ... } }

Step 2: Read tsconfig.json (if exists)
Tool: fs_read_file("tsconfig.json")
Result: File not found (good, we'll create one)

Step 3: Run npm install
Tool: shell("npm install --save-dev typescript")
[Approval prompt shown to user]
User: [Approve]
Result: npm install output...

Step 4: Create tsconfig.json
Tool: fs_write_file("tsconfig.json", "{...}")
[Approval prompt shown]
User: [Approve]
Result: File created

Agent (done): TypeScript added to the project.
```

---

## Running an Agent

### Command Syntax

In the chat panel:

```
/agent <goal>
```

Examples:
```
/agent implement the TODO in utils.ts
/agent fix the CSS bug in Header.tsx
/agent write a unit test for the getUserById function
/agent optimize the database query in queries.ts
/agent add error handling to the API routes
```

### With Persona

Combine with agent picker (`Ctrl+/`) to choose a persona:

```
[Select "Code Explainer" agent]
/agent explain the authentication flow in auth.ts
```

Each agent has a system prompt:
- **Chat Assistant** — General conversation
- **Code Explainer** — Explain code in detail
- **Task Planner** — Break down complex goals
- **Debug Buddy** — Help find and fix bugs
- **Review Agent** — Code review feedback
- **Sprint Planner** — Plan sprints and tasks

---

## Built-in Tools

### Read-Only Tools (No Approval Needed)

#### fs_read_file

Read a file's contents.

```rust
fs_read_file(path: String) -> Result<String>
```

**Usage:**
```
Tool: fs_read_file("src/auth.ts")
Result: file contents...
```

**Limitations:**
- Max 5 MiB per file
- Refuses binary files

---

#### fs_list_dir

List files in a directory.

```rust
fs_list_dir(path: String) -> Result<Vec<DirEntry>>
```

**Usage:**
```
Tool: fs_list_dir("src/")
Result: [
  { name: "auth.ts", isDir: false, size: 2048 },
  { name: "utils.ts", isDir: false, size: 1024 },
  ...
]
```

---

#### fs_search

Full-text search files by content.

```rust
fs_search(root: String, query: String, limit: u32) -> Result<Vec<SearchHit>>
```

**Usage:**
```
Tool: fs_search("src/", "async function login", 5)
Result: [
  { path: "src/auth.ts", lineNumber: 42, lineContent: "async function login(...)", score: 9.5 },
  ...
]
```

---

#### git_status

Check git status.

```rust
git_status(path: String) -> Result<Option<GitInfo>>
```

**Returns:**
```json
{
  "branch": "main",
  "ahead": 0,
  "behind": 2,
  "dirty": 3,
  "untracked": 1
}
```

---

#### git_log

View commit history.

```rust
git_log(path: String, limit: u32) -> Result<Vec<LogEntry>>
```

**Returns:**
```json
[
  {
    "hash": "abc123...",
    "author": "Alice",
    "message": "Fix auth bug",
    "timestamp": 1684000000
  }
]
```

---

#### git_diff

Show changes.

```rust
git_diff(path: String, scope: "worktree"|"staged"|"head") -> Result<String>
```

**Scopes:**
- `worktree` — Unstaged changes
- `staged` — Staged changes
- `head` — Last commit

---

#### memory_search

Search saved notes (FTS5).

```rust
memory_search(workspaceId: String, query: String, limit: u32) -> Result<Vec<MemoryHit>>
```

**Usage:**
Agent can search your memory for context:
```
Tool: memory_search("my-workspace", "TypeScript config", 5)
Result: [
  { id: "mem-123", title: "TypeScript Setup", score: 8.9 }
]
```

---

### Mutating Tools (Need Approval)

#### fs_write_file

Create or overwrite a file.

```rust
fs_write_file(path: String, content: String) -> Result<()>
```

**Approval prompt:**
```
🤖 Agent wants to: fs_write_file("tsconfig.json", "...")
  
[Approve] [Deny]
```

---

#### fs_edit

Surgical find-and-replace edit (safer than full rewrite).

```rust
fs_edit(path: String, find: String, replace: String) -> Result<()>
```

**Usage:**
```
Tool: fs_edit("src/auth.ts", 
  find: "function login(user) {",
  replace: "async function login(user) {"
)
```

**Approval shown.** User clicks Approve.

---

#### shell

Run shell commands.

```rust
shell(command: String, timeout: u32) -> Result<String>
```

**Limitations:**
- 30 second timeout (default)
- 16 KiB output cap
- Runs with PTY environment (PATH, HOME, etc.)

**Approval prompt:**
```
🤖 Agent wants to: shell("npm install typescript")

[Approve] [Deny]
```

---

#### memory_save

Save a note to workspace memory.

```rust
memory_save(title: String, content: String, tags?: Vec<String>) -> Result<MemoryEntry>
```

**No approval needed** (read-only side effect; agent documents findings).

---

### MCP Tools

When you connect an MCP server, its tools are automatically available to agents:

```
/mcp connect web-search npx @anthropic/mcp-server-web-search
/agent research Claude's latest announcements
```

Agent automatically uses `web_search` tool.

Tool names are prefixed: `mcp__<server>__<tool>` (sanitized, capped at 64 chars).

---

## Approval Gating

### Approval Prompt

When an agent calls a mutating tool:

```
┌─────────────────────────────────────┐
│ Agent wants to: fs_write_file(...)  │
│                                     │
│ Path: src/main.rs                   │
│ Content: [preview of new content]   │
│                                     │
│ [Approve]  [Deny]                   │
└─────────────────────────────────────┘
```

### What You Can Do

- **Approve** — Let the agent execute the tool and continue
- **Deny** — Reject the tool call; agent gets error and adjusts
- **Close popover (Escape)** — Implicit deny; agent stops gracefully

### Multiple Pending Approvals

If the agent calls multiple tools:

```
Agent calls: fs_write_file("file1.ts", ...)
[Approve] [Deny]

You click Approve

Agent calls: shell("npm test")
[Approve] [Deny]

You click Deny

Agent: "Shell execution was rejected. I'll continue without testing."
```

### Timeout

No explicit timeout on approval. If you don't respond, agent waits indefinitely. Close the popover or close ARC to force-stop.

---

## Custom Agents

### Creating a Custom Agent

Custom agents are JSON descriptors in the `agents.ts` store:

```typescript
// apps/frontend/src/state/agents.ts

const customAgents = [
  {
    id: "code-smell-detector",
    name: "Code Smell Detector",
    description: "Identifies potential code quality issues",
    systemPrompt: `You are an expert code reviewer. Look for:
      - Overly long functions (>100 lines)
      - Deep nesting (>3 levels)
      - Duplicate code
      - Missing error handling
      - Poor variable naming
      
      Provide specific line numbers and actionable suggestions.`,
    color: "amber",
    icon: "AlertTriangle",
  },
];
```

### Fields

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Unique ID (kebab-case) |
| `name` | string | Display name |
| `description` | string | What this agent does |
| `systemPrompt` | string | System prompt (shapes behavior) |
| `color` | string | UI color (tailwind color) |
| `icon` | string | Lucide icon name |

### Adding to ARC

1. Edit `apps/frontend/src/state/agents.ts`
2. Add your agent to the `customAgents` array
3. Save and restart ARC
4. Agent appears in the agent picker (`Ctrl+/`)

### Example: Bug Finder

```typescript
{
  id: "bug-finder",
  name: "Bug Finder",
  description: "Scans code for potential bugs and edge cases",
  systemPrompt: `You are a meticulous bug hunter. When analyzing code:
    1. Look for null/undefined reference errors
    2. Check for race conditions
    3. Verify error handling (try/catch, null checks)
    4. Check array/string bounds
    5. Look for timing issues (async/await)
    6. Identify unreachable code
    
    Be specific: show the exact line and explain the risk.`,
  color: "red",
  icon: "Bug",
}
```

---

## Agent Memory

### What is Agent Memory?

Agent memory is workspace-scoped notes. Agents can search and save notes to provide context and document findings.

### Searching Memory

Agent automatically uses your saved notes:

```
/memory save
Title: API Rate Limits
Content: OpenAI: 3,500 RPM. Anthropic: 50 RPS. Ollama: unlimited (local).

/agent design a rate limiting strategy considering these limits
```

Agent finds the memory entry and uses it in reasoning.

### Saving Findings

Agent can save what it discovers:

```
Agent: "I found 5 security issues. Let me save these for future reference."
Tool: memory_save("Security Audit Results", "Found 5 issues:\n1. ...\n2. ...", ["security", "audit"])
Result: Saved to memory.
```

### Example: Agent Research

```
/agent research and summarize the latest Claude model capabilities

Agent:
1. Uses web_search (via MCP) to find latest info
2. Reads saved memory about previous model versions
3. Saves findings to memory
4. Summarizes for you in chat

Result: Comprehensive summary with comparison to previous versions
```

---

## Extending with MCP

### Giving Agents Custom Tools

Connect an MCP server to unlock new tools:

```
/mcp connect api-tools npx @myorg/api-mcp-server

/agent integrate Stripe into the payment flow
```

Agent now has access to Stripe tools (charge, refund, list transactions, etc.).

### Tool Availability

Tools from MCP are available to agents immediately:

```
MCP server exposes: ["checkout", "refund", "list_charges"]
Agent tools now include: mcp__api-tools__checkout, mcp__api-tools__refund, ...
```

### Tool Limitations

- **Max tools per run:** 32 (if you connect multiple MCP servers)
- **Max output:** 16 KiB per tool call
- **Timeout:** 30 seconds per call

See [MCP_INTEGRATION.md](MCP_INTEGRATION.md) for building custom MCP servers.

---

## Error Handling

### Agent Errors

If a tool fails, agent sees the error and adjusts:

```
Agent: "Let me read the auth.ts file."
Tool: fs_read_file("src/auth.ts")
Error: "File not found"

Agent: "The file doesn't exist. Let me list the src directory."
Tool: fs_list_dir("src/")
Result: Lists files...
```

### Tool Failures

If shell commands fail:

```
Agent: "Let me run the tests."
Tool: shell("npm test")
Error: "npm: command not found"

Agent: "npm isn't installed. Let me check the package manager."
Tool: shell("pnpm --version")
Result: "7.22.0"

Agent: "Found! Let me run tests with pnpm."
Tool: shell("pnpm test")
Result: test output...
```

### Approval Denial

If you deny approval:

```
Agent: "I'll write the updated file."
Tool: fs_write_file("config.ts", "...")
User: [Deny]

Agent: "I wasn't able to write the file. Let me suggest changes in chat instead."
Result: Agent explains changes without writing
```

---

## Performance Tips

### For Large Codebases

1. **Use specific fs_search queries:**
   ```
   ✅ fs_search("src/", "login implementation", 10)
   ❌ fs_search("src/", "function", 100) // Too broad
   ```

2. **Rebuild the search index:**
   ```
   /agent rebuild the search index for faster lookups
   ```

3. **Break large goals into sub-goals:**
   ```
   ❌ /agent refactor the entire auth system
   ✅ /agent refactor the login function in auth.ts
       /agent refactor the signup function in auth.ts
   ```

### For Long-Running Agents

- Agent has 30-second timeout per tool call
- Long operations (npm install, data processing) may timeout
- Keep tool calls focused on quick operations

---

## Troubleshooting

### Agent Says "Tool Not Found"

**Cause:** Tool isn't defined or MCP server isn't connected.

**Fix:**
1. Check if the tool is built-in:
   ```
   Built-in: fs_read_file, fs_write_file, shell, git_*, memory_*
   ```
2. If it's an MCP tool, verify server is connected:
   ```
   /mcp list
   ```

### "Permission Denied" or "File Not Found"

**Cause:** File path is wrong or file doesn't exist.

**Fix:**
1. Ask agent to list the directory first:
   ```
   /agent list files in the src directory
   ```
2. Copy exact path from file tree

### Agent Gets Stuck / Doesn't Make Progress

**Cause:** Agent is in a loop or running out of ideas.

**Fix:**
- Close the chat popover to force-stop
- Or wait for timeout (30s per tool)
- Then start a new agent with more specific goal

### Approval Prompt Doesn't Appear

**Cause:** Popover is hidden or off-screen.

**Fix:**
- Press `Ctrl+J` to show chat panel
- Or click ChatPanel area
- Approval prompt should reappear

---

## See Also

- [FEATURES.md](FEATURES.md) — User guide for running agents
- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) — Building custom MCP servers
- [API_REFERENCE.md](API_REFERENCE.md) — `agent_run` and `agent_decide` commands
