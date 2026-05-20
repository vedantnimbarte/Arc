# arc-agent-runtime — Tool-Using Agent

Agentic loop for autonomous task execution with approval gating.

## What It Does

- **Agent loop:** Think → Plan → Choose tool → Execute → Iterate
- **Tool registry:** Built-in tools (fs, git, shell, memory) + MCP tools
- **Approval gating:** Mutating tools require user approval
- **Streaming:** Emit events as agent thinks and acts
- **Memory integration:** Agent can search and save notes

## Built-in Tools

**Read-only (no approval):**
- `fs_read_file` — Read file contents
- `fs_list_dir` — List directory
- `fs_search` — Search files by content
- `git_status`, `git_log`, `git_diff` — Git introspection
- `memory_search` — Search saved notes

**Mutating (need approval):**
- `fs_write_file` — Create/overwrite file
- `fs_edit` — Find-and-replace edit
- `shell` — Run shell command
- `memory_save` — Save a note

**MCP tools:** Dynamically bridged from connected MCP servers (capped at 32)

## Key Types

```rust
pub struct AgentRun {
    pub goal: String,
    pub system_prompt: String,
    pub conversationId: Option<String>,
    pub workspaceId: Option<String>,
}

pub enum ToolResult {
    Success { content: String },
    Denied,  // User rejected approval
    Error { message: String },
}
```

## Approvals

When an agent calls a mutating tool:

```rust
let approval_request = ApprovalRequest {
    tool_name: "fs_write_file",
    input: ...,
};

// Emit event; wait for user decision
let decision = wait_for_approval(approval_id).await;

if decision.approve {
    execute_tool(...)?
} else {
    return ToolResult::Denied
}
```

## Event Streaming

Agent emits events as it runs:

```rust
AgentEvent::Thinking("Let me analyze the code...")
AgentEvent::ToolCall { tool: "fs_read_file", args: {...} }
AgentEvent::ToolResult { result: "file contents..." }
AgentEvent::Done { result: "Task completed" }
```

## Configuration

```rust
let mut agent = AgentRuntime::new(...);
agent.run(AgentRun {
    goal: "Fix the bug in auth.ts".to_string(),
    system_prompt: "You are a Rust expert.".to_string(),
    workspaceId: Some("ws-123".to_string()),
    ..Default::default()
}).await?;
```

## Limitations

- **Timeout:** 30 seconds per tool call
- **Output cap:** 16 KiB per tool result
- **Tools:** Max 32 from MCP servers
- **Memory:** No persistent context across runs

## See Also

- `apps/desktop/src/commands/agent.rs` — Tauri command layer
- `AGENTS.md` — User guide for agents
- `DEVELOPMENT.md` — Extending agents
