//! arc-agent-runtime — a tool-using coding agent.
//!
//! V0 scope:
//!   * Anthropic tool API only (well-documented wire format).
//!   * Read-only tools: `fs_read_file`, `fs_search`. The agent reads code,
//!     plans changes, and explains them — it does NOT mutate the filesystem
//!     or run shell commands. Write/exec + approval gating land with V1.
//!   * Single back-and-forth loop until the model emits a final answer.
//!
//! The crate is event-driven: a caller subscribes to an mpsc receiver of
//! [`AgentEvent`] and drives the run with [`run`].

pub mod tools;

use std::sync::Arc;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::mpsc;

pub use tools::{FsReadFileTool, FsSearchTool, Tool};

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
    /// The agent has produced a final answer and the run is done.
    Done { summary: String },
    /// Terminal error.
    Error { message: String },
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
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            model: "claude-sonnet-4-6".into(),
            max_steps: 8,
            max_tokens: 4096,
            workspace_root: None,
        }
    }
}

const SYSTEM_PROMPT: &str = "\
You are ARC's coding agent, embedded inside a developer's terminal.

You can call tools to read source files (`fs_read_file`) and search the workspace \
(`fs_search`). You CANNOT modify files or run shell commands — when the user needs \
those, propose the exact change or command for them to run themselves.

Style: be concise. Quote file paths and command names in backticks. Show diffs \
or code blocks when proposing changes. When the user's goal is achieved, stop \
calling tools and write a short final summary.\
";

/// Run the agent against `goal`. Sends [`AgentEvent`]s through `tx` and
/// returns when the model finishes (or `max_steps` is exhausted).
pub async fn run(
    goal: &str,
    cfg: RunConfig,
    tools: Vec<Arc<dyn Tool>>,
    tx: mpsc::UnboundedSender<AgentEvent>,
) -> Result<()> {
    let client = Client::new();
    let tool_schemas: Vec<Value> = tools.iter().map(|t| t.schema()).collect();

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
            "system": SYSTEM_PROMPT,
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
                Some(t) => match t.run(input, cfg.workspace_root.as_deref()).await {
                    Ok(out) => (true, out),
                    Err(err) => (false, format!("error: {err}")),
                },
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
