//! arc-agent-runtime — a tool-using coding agent.
//!
//! Scope:
//!   * Anthropic tool API only (well-documented wire format).
//!   * Built-in tools: `fs_read_file`, `fs_search` (read-only) +
//!     `fs_write_file`, `shell` (approval-gated via [`Approver`]).
//!   * External tools (e.g. MCP servers) are supplied by the caller via
//!     the `tools` argument to [`run`]; the runtime is transport-agnostic.
//!   * Single back-and-forth loop until the model emits a final answer or
//!     `max_steps` is exhausted.
//!
//! The crate is event-driven: a caller subscribes to an mpsc receiver of
//! [`AgentEvent`] and drives the run with [`run`].

pub mod tools;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::mpsc;

pub use tools::{
    FsEditTool, FsListDirTool, FsReadFileTool, FsSearchTool, FsWriteFileTool, GitDiffTool,
    GitLogTool, GitStatusTool, ShellTool, Tool,
};

#[derive(Debug, Error)]
pub enum Error {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("anthropic API: {0}")]
    Api(String),
    #[error("bad response shape: {0}")]
    Shape(String),
    #[error("agent stopped after {0} steps without a final answer")]
    StepLimit(u32),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Events the caller streams to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    /// A piece of assistant prose ready to render.
    Text { text: String },
    /// The agent is about to call a tool. `id` is the per-call identifier
    /// the model will reference in its follow-up.
    ToolStart {
        id: String,
        name: String,
        input: Value,
    },
    /// Tool execution finished. Output is whatever the tool returned (or an
    /// error message).
    ToolResult {
        id: String,
        ok: bool,
        output: String,
    },
    /// The agent wants to run a mutating tool; the UI must call
    /// `agent_decide(approval_id, approve)` before the runtime proceeds.
    /// The matching `tool_use_id` is sent so the UI can pin the prompt
    /// next to the already-rendered `ToolStart` row.
    ApprovalRequest {
        approval_id: String,
        tool_use_id: String,
        name: String,
        input: Value,
    },
    /// The agent has produced a final answer and the run is done.
    Done { summary: String },
    /// Terminal error.
    Error { message: String },
}

/// Trait that lets the runtime ask "may I run this tool?" without coupling
/// to a specific transport (event bus, modal dialog, CLI prompt, etc.).
/// The runtime owns `approval_id` (so it can emit it on the event bus) and
/// passes it through so the implementation can key its pending map.
/// Returns `true` to approve, `false` to deny.
pub trait Approver: Send + Sync {
    fn request(
        &self,
        approval_id: String,
        tool_name: String,
        tool_use_id: String,
        input: Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send>>;
}

/// Approver that auto-approves every request — useful for tests + the
/// CLI/headless paths where no human is in the loop.
pub struct AutoApprover;

impl Approver for AutoApprover {
    fn request(
        &self,
        _approval_id: String,
        _tool_name: String,
        _tool_use_id: String,
        _input: Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        Box::pin(async { true })
    }
}

#[derive(Debug, Clone)]
pub struct RunConfig {
    pub api_key: String,
    pub model: String,
    /// Hard cap on loop iterations. Each iteration is one Anthropic request.
    pub max_steps: u32,
    /// Per-request token cap.
    pub max_tokens: u32,
    /// Workspace root — used as the cwd reference for relative paths the
    /// model emits.
    pub workspace_root: Option<String>,
    /// Persona system prompt supplied by the UI (e.g. the active agent's
    /// description). Empty/None falls back to [`DEFAULT_SYSTEM_PROMPT`].
    pub system_prompt: Option<String>,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model: "claude-sonnet-4-6".into(),
            max_steps: 8,
            max_tokens: 4096,
            workspace_root: None,
            system_prompt: None,
        }
    }
}

/// Default coding-agent system prompt. Describes the *capability envelope*
/// — the built-in tools and the approval contract — but stays silent on
/// MCP-side tools (whose names and purposes vary per connected server, and
/// which the model discovers from the tool list at request time). The
/// persona prompt supplied by the UI is appended so a "Review Agent" or
/// "Task Planner" flavors how the agent talks without re-stating the rules.
pub const DEFAULT_SYSTEM_PROMPT: &str = "\
You are ARC's coding agent, embedded inside a developer's terminal.

Built-in tools:
  * `fs_read_file` — read a text file in the workspace.
  * `fs_list_dir`  — list the contents of a directory (names + kinds).
  * `fs_search`    — substring-search the workspace.
  * `fs_write_file` — create or overwrite a file. Requires user approval.
  * `fs_edit`      — surgical find/replace inside an existing file. Prefer \
this over `fs_write_file` for small targeted edits. Requires user approval.
  * `shell`        — run a one-shot shell command (30s default cap). Requires \
user approval.
  * `git_status`   — summarize the workspace's git state (branch, dirty counts).
  * `git_log`      — recent commit history; optionally filter by path.
  * `git_diff`     — unified diff of pending changes (worktree / staged / head).
  * `memory_search` — recall workspace-scoped notes you (or earlier runs) saved. \
FTS5 keyword search. Try this near the start of a task to surface prior \
context — file purposes, gotchas, design decisions.
  * `memory_save`  — save a note for future runs. Use sparingly: only for \
non-obvious facts you'll want again, not for things easily re-derived from \
the code.

Any additional tools you see whose names begin with `mcp__<server>__` are \
proxied from MCP servers the user has connected; they also require approval. \
Read their descriptions before calling.

Before any approval-gated call, say in one sentence what you're about to do \
and why — that's the prompt the user sees when deciding. Prefer reads and \
searches first; only write or shell out when you're confident.

Style: be concise. Quote file paths and command names in backticks. Show diffs \
or code blocks when proposing changes. When the user's goal is achieved, stop \
calling tools and write a short final summary.\
";

/// Run the agent against `goal`. Sends [`AgentEvent`]s through `tx` and
/// returns when the model finishes (or `max_steps` is exhausted). Mutating
/// tools (anything where `Tool::requires_approval()` is `true`) gate on
/// `approver` before they run.
pub async fn run(
    goal: &str,
    cfg: RunConfig,
    tools: Vec<Arc<dyn Tool>>,
    tx: mpsc::UnboundedSender<AgentEvent>,
    approver: Arc<dyn Approver>,
) -> Result<()> {
    let client = Client::new();
    let tool_schemas: Vec<Value> = tools.iter().map(|t| t.schema()).collect();

    // Compose the system prompt once: default capability envelope, then the
    // optional persona overlay separated by a blank line so the model reads
    // them as distinct sections.
    let system_prompt = match cfg
        .system_prompt
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(persona) => format!("{DEFAULT_SYSTEM_PROMPT}\n\n{persona}"),
        None => DEFAULT_SYSTEM_PROMPT.to_string(),
    };

    // We mirror the Anthropic messages array. Each "user" message can be
    // text OR a list of tool_result blocks; each "assistant" message can
    // be text OR a list with tool_use blocks.
    let mut messages: Vec<Value> = vec![json!({
        "role": "user",
        "content": goal,
    })];

    for step in 0..cfg.max_steps {
        tracing::debug!(step, "agent step");

        let req_body = json!({
            "model": cfg.model,
            "max_tokens": cfg.max_tokens,
            "system": system_prompt,
            "tools": tool_schemas,
            "messages": messages,
        });

        let resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &cfg.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&req_body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(Error::Api(format!("{status}: {body}")));
        }

        let body: Value = resp.json().await?;
        let content = body
            .get("content")
            .and_then(|c| c.as_array())
            .ok_or_else(|| Error::Shape("missing content[]".into()))?;

        // First pass: forward any text blocks and collect tool_use blocks.
        let mut tool_uses: Vec<(String, String, Value)> = Vec::new();
        let mut last_text = String::new();
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    let text = block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string();
                    last_text = text.clone();
                    let _ = tx.send(AgentEvent::Text { text });
                }
                Some("tool_use") => {
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    tool_uses.push((id, name, input));
                }
                _ => {}
            }
        }

        // Append the assistant turn verbatim — Anthropic requires the full
        // block list (including tool_use entries) to be replayed on the
        // next request.
        messages.push(json!({
            "role": "assistant",
            "content": content,
        }));

        // Stop condition: no tools requested → we have the final answer.
        if tool_uses.is_empty() {
            let _ = tx.send(AgentEvent::Done { summary: last_text });
            return Ok(());
        }

        // Execute each tool, collect results, send back as one user turn.
        let mut tool_results: Vec<Value> = Vec::new();
        for (id, name, input) in &tool_uses {
            let _ = tx.send(AgentEvent::ToolStart {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            });

            let tool = tools.iter().find(|t| t.name() == name);
            let (ok, output) = match tool {
                Some(t) => {
                    // Mutating tools must be approved before they run. The
                    // approver emits the request to the UI and parks until
                    // the user clicks Approve/Deny.
                    let allowed = if t.requires_approval() {
                        let approval_id = uuid::Uuid::new_v4().to_string();
                        let _ = tx.send(AgentEvent::ApprovalRequest {
                            approval_id: approval_id.clone(),
                            tool_use_id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        approver
                            .request(approval_id, name.clone(), id.clone(), input.clone())
                            .await
                    } else {
                        true
                    };
                    if !allowed {
                        (false, "denied by user".to_string())
                    } else {
                        match t.run(input, cfg.workspace_root.as_deref()).await {
                            Ok(out) => (true, out),
                            Err(err) => (false, format!("error: {err}")),
                        }
                    }
                }
                None => (false, format!("unknown tool: {name}")),
            };

            let _ = tx.send(AgentEvent::ToolResult {
                id: id.clone(),
                ok,
                output: output.clone(),
            });

            tool_results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": output,
                "is_error": !ok,
            }));
        }

        messages.push(json!({
            "role": "user",
            "content": tool_results,
        }));
    }

    Err(Error::StepLimit(cfg.max_steps))
}
