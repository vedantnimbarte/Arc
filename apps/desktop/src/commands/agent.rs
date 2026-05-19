//! Tauri command surface for [`arc_agent_runtime`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("agent_run", { req })                              -> ()
//!   invoke("agent_decide", { approvalId, approve })           -> ()
//!
//! Emitted events:
//!   "agent://event/<runId>" -> AgentEvent
//!     (text / tool_start / tool_result / approval_request / done / error)

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use arc_agent_runtime::{
    run, AgentEvent, Approver, FsEditTool, FsListDirTool, FsReadFileTool, FsSearchTool,
    FsWriteFileTool, GitDiffTool, GitLogTool, GitStatusTool, RunConfig, ShellTool, Tool,
};
use arc_session_manager::{agent as agent_db, memory as memory_db, SessionStore, SqlitePool};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

use crate::commands::mcp::{McpState, McpTool as McpServerTool};

/// Hard cap on the total number of MCP tools we expose to the agent. Each
/// tool eats schema tokens in every Anthropic request; keep the budget sane
/// even if a user has multiple chatty servers connected. Servers are
/// enumerated in DashMap-iteration order — first N tools win.
const MCP_TOOL_BUDGET: usize = 32;

/// Global registry of in-flight tool-approval prompts, keyed by the
/// runtime-generated `approval_id`. The `agent_run` command stashes the
/// oneshot sender on request; `agent_decide` removes it and resolves the
/// matching future.
#[derive(Default)]
pub struct AgentApprovals {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl AgentApprovals {
    pub fn new() -> Self {
        Self::default()
    }

    fn handle(&self) -> Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> {
        Arc::clone(&self.pending)
    }
}

/// Approver implementation that parks on a oneshot, expecting the matching
/// `agent_decide` Tauri call to send the decision. If the channel drops
/// (e.g. the window closes mid-prompt), the request resolves as "deny" so
/// the runtime doesn't hang.
struct EventBusApprover {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

impl Approver for EventBusApprover {
    fn request(
        &self,
        approval_id: String,
        _tool_name: String,
        _tool_use_id: String,
        _input: Value,
    ) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        let pending = Arc::clone(&self.pending);
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            pending.lock().await.insert(approval_id, tx);
            rx.await.unwrap_or(false)
        })
    }
}

/// Tool implementation that proxies a single MCP server's tool through the
/// agent runtime. The runtime stays Tauri-agnostic; this struct holds a
/// clone of [`McpState`] (which is itself `Arc`-backed internally) so the
/// agent can route `tools/call` over the same JSON-RPC pipeline the `/mcp`
/// chat commands use.
///
/// All MCP tools require approval — a connected server is effectively
/// arbitrary code (web fetch, DB query, file write) so we treat every
/// invocation the same as `shell`.
struct McpBridgeTool {
    mcp: McpState,
    server_id: String,
    /// MCP-side tool name (what `tools/call` expects).
    remote_name: String,
    /// Anthropic-side tool name (`mcp__<server>__<tool>`, sanitized + capped
    /// at 64 chars per the API's tool-name pattern).
    exposed_name: String,
    description: String,
    input_schema: Value,
}

impl McpBridgeTool {
    /// Build the wrapper for a single tool. Returns `None` if no portion of
    /// the server/tool name survives sanitization (i.e. the model wouldn't
    /// have anything callable).
    fn new(mcp: McpState, server_id: String, tool: McpServerTool) -> Option<Self> {
        let exposed_name = mangle_tool_name(&server_id, &tool.name)?;
        let description = tool
            .description
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| format!("MCP tool `{}` from server `{}`.", tool.name, server_id));
        let description = format!(
            "[MCP server `{server_id}`] {description}\n\n\
             Requires user approval. Output is whatever the server emits \
             (text blocks concatenated, or pretty-printed JSON if non-text).",
        );
        // MCP servers return an arbitrary JSON Schema as inputSchema; pass
        // it straight through. If the server didn't advertise one, fall
        // back to an empty object schema so Anthropic still accepts the
        // tool definition.
        let input_schema = if tool.input_schema.is_object() {
            tool.input_schema
        } else {
            json!({ "type": "object", "properties": {} })
        };
        Some(Self {
            mcp,
            server_id,
            remote_name: tool.name,
            exposed_name,
            description,
            input_schema,
        })
    }
}

#[async_trait]
impl Tool for McpBridgeTool {
    fn name(&self) -> &str {
        &self.exposed_name
    }

    fn schema(&self) -> Value {
        json!({
            "name": self.exposed_name,
            "description": self.description,
            "input_schema": self.input_schema,
        })
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn run(&self, input: &Value, _workspace_root: Option<&str>) -> Result<String, String> {
        self.mcp
            .call_tool(&self.server_id, &self.remote_name, input.clone())
            .await
    }
}

/// Build a tool name that satisfies Anthropic's `^[a-zA-Z0-9_-]{1,64}$`
/// constraint. Invalid characters collapse to underscores; if the whole
/// composed name exceeds 64 bytes we truncate the *tool* portion (the
/// server prefix is the part the model needs to disambiguate). Returns
/// `None` if no valid characters survive — that tool just gets skipped.
fn mangle_tool_name(server_id: &str, tool_name: &str) -> Option<String> {
    fn sanitize(s: &str) -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect()
    }
    let srv = sanitize(server_id);
    let tool = sanitize(tool_name);
    if srv.is_empty() || tool.is_empty() {
        return None;
    }
    const PREFIX: &str = "mcp__";
    const SEP: &str = "__";
    const MAX: usize = 64;
    // Budget for the tool part = MAX - prefix - separator - server name.
    let fixed = PREFIX.len() + SEP.len() + srv.len();
    if fixed >= MAX {
        // Server name alone already overflows; fall back to truncating it.
        let avail = MAX.saturating_sub(PREFIX.len() + SEP.len() + 1);
        let srv_trunc = &srv[..srv.len().min(avail)];
        let tool_trunc = &tool[..tool.len().min(1)];
        return Some(format!("{PREFIX}{srv_trunc}{SEP}{tool_trunc}"));
    }
    let tool_avail = MAX - fixed;
    let tool_trunc = &tool[..tool.len().min(tool_avail)];
    Some(format!("{PREFIX}{srv}{SEP}{tool_trunc}"))
}

/// Enumerate connected MCP servers, list their tools, and produce bridge
/// tools the agent can call. Failures on a single server are logged and
/// skipped — one broken server shouldn't kill a run.
async fn discover_mcp_tools(mcp: &McpState) -> Vec<Arc<dyn Tool>> {
    let mut out: Vec<Arc<dyn Tool>> = Vec::new();
    let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for server_id in mcp.server_ids() {
        if out.len() >= MCP_TOOL_BUDGET {
            tracing::warn!(
                budget = MCP_TOOL_BUDGET,
                "MCP tool budget reached, skipping remaining servers"
            );
            break;
        }
        let tools = match mcp.list_tools(&server_id).await {
            Ok(t) => t,
            Err(err) => {
                tracing::warn!(?err, server = %server_id, "mcp list_tools failed");
                continue;
            }
        };
        for tool in tools {
            if out.len() >= MCP_TOOL_BUDGET {
                break;
            }
            let Some(bridge) = McpBridgeTool::new(mcp.clone(), server_id.clone(), tool) else {
                continue;
            };
            // Defense in depth: if two servers produce the same mangled
            // name (e.g. both have a `search` tool and identical id
            // prefixes after sanitization), keep the first and drop the
            // duplicate — Anthropic rejects duplicate tool names.
            if !seen_names.insert(bridge.exposed_name.clone()) {
                tracing::warn!(name = %bridge.exposed_name, "duplicate MCP tool name, skipping");
                continue;
            }
            out.push(Arc::new(bridge));
        }
    }
    out
}

// ─── memory tools ────────────────────────────────────────────────────────
//
// Bridge the workspace-scoped memory subsystem (arc-session-manager::memory)
// into the agent runtime. Lets a /agent run save findings ("the auth flow
// lives in src/auth/oauth.rs") and recall them on a later run via FTS5
// keyword search.
//
// `memory_save` is read/write but never destructive (insert-only). We treat
// it as non-approval to keep the agent fluent — the worst case is a row
// the user has to `/memory delete` later. `memory_search` is read-only.

struct MemorySaveTool {
    pool: SqlitePool,
    workspace_id: Option<String>,
}

#[async_trait]
impl Tool for MemorySaveTool {
    fn name(&self) -> &str {
        "memory_save"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "memory_save",
            "description":
                "Save a workspace-scoped note for later recall. Use this when you discover a \
                 non-obvious fact you'll want on a future run (a file's purpose, a config \
                 location, a gotcha). Indexed for keyword search via `memory_search`.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The note body. Prefer concrete sentences over jargon."
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional short label."
                    },
                    "tags": {
                        "type": "string",
                        "description": "Optional comma-separated tags, e.g. `auth, oauth, gotcha`."
                    }
                },
                "required": ["content"]
            }
        })
    }

    async fn run(&self, input: &Value, _workspace_root: Option<&str>) -> Result<String, String> {
        let content = input
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `content`".to_string())?;
        if content.trim().is_empty() {
            return Err("`content` must be non-empty".into());
        }
        let title = input.get("title").and_then(|v| v.as_str());
        let tags = input.get("tags").and_then(|v| v.as_str());
        let entry = memory_db::save(
            &self.pool,
            self.workspace_id.as_deref(),
            Some("note"),
            title,
            content,
            tags,
            Some("agent"),
        )
        .await
        .map_err(|e| format!("memory_save: {e}"))?;
        Ok(format!("saved memory {} ({}B)", &entry.id[..8], content.len()))
    }
}

struct MemorySearchTool {
    pool: SqlitePool,
    workspace_id: Option<String>,
}

#[async_trait]
impl Tool for MemorySearchTool {
    fn name(&self) -> &str {
        "memory_search"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "memory_search",
            "description":
                "Keyword-search previously-saved memory notes (FTS5). Returns up to `limit` hits \
                 with snippet + title. Run this near the start of a task to recall context from \
                 prior sessions. Supports prefix syntax like `oauth*` and phrase queries.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": {
                        "type": "integer",
                        "description": "Default 5, max 25.",
                        "minimum": 1,
                        "maximum": 25
                    }
                },
                "required": ["query"]
            }
        })
    }

    async fn run(&self, input: &Value, _workspace_root: Option<&str>) -> Result<String, String> {
        let query = input
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `query`".to_string())?;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(5)
            .clamp(1, 25);

        // Search across the current workspace AND global (NULL workspace_id)
        // notes — agents shouldn't have to know which scope a note was saved
        // under. We run both queries and merge by score.
        let ws_hits = memory_db::search(
            &self.pool,
            self.workspace_id.as_deref().or(Some("__all__")),
            query,
            limit,
        )
        .await
        .map_err(|e| format!("memory_search: {e}"))?;

        if ws_hits.is_empty() {
            return Ok(format!("no memory hits for `{query}`"));
        }
        let mut out = format!("{} hit(s) for `{query}`:\n", ws_hits.len());
        for (i, h) in ws_hits.iter().enumerate() {
            let title = h.entry.title.as_deref().unwrap_or("(untitled)");
            out.push_str(&format!(
                "{}. [{}] {} — {}\n",
                i + 1,
                &h.entry.id[..8.min(h.entry.id.len())],
                title,
                h.snippet
            ));
        }
        Ok(out)
    }
}

#[derive(Debug, Deserialize)]
pub struct AgentRunReq {
    pub id: String,
    pub goal: String,
    pub api_key: String,
    pub model: String,
    pub workspace_root: Option<String>,
    pub workspace_id: Option<String>,
    /// Optional persona prompt (e.g. the active UI agent's system prompt).
    /// Layered on top of the runtime's default coding-agent prompt.
    #[serde(default)]
    pub system_prompt: Option<String>,
}

#[tauri::command]
pub async fn agent_run(
    store: State<'_, SessionStore>,
    approvals: State<'_, AgentApprovals>,
    mcp: State<'_, McpState>,
    app: AppHandle,
    req: AgentRunReq,
) -> Result<(), String> {
    let topic = format!("agent://event/{}", req.id);

    if let Err(err) = agent_db::start(
        store.pool(),
        &req.id,
        req.workspace_id.as_deref(),
        "coding-v1",
    )
    .await
    {
        tracing::warn!(?err, "agent_runs insert failed");
    }

    let cfg = RunConfig {
        api_key: req.api_key,
        model: req.model,
        workspace_root: req.workspace_root,
        system_prompt: req.system_prompt,
        ..Default::default()
    };
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(FsReadFileTool),
        Arc::new(FsListDirTool),
        Arc::new(FsSearchTool),
        Arc::new(FsWriteFileTool),
        Arc::new(FsEditTool),
        Arc::new(ShellTool),
        Arc::new(GitStatusTool),
        Arc::new(GitLogTool),
        Arc::new(GitDiffTool),
        Arc::new(MemorySaveTool {
            pool: store.pool().clone(),
            workspace_id: req.workspace_id.clone(),
        }),
        Arc::new(MemorySearchTool {
            pool: store.pool().clone(),
            workspace_id: req.workspace_id.clone(),
        }),
    ];

    // Discover currently-connected MCP servers and expose their tools to
    // the agent. We do this once at run-start so the tool list is stable
    // for the duration of the run — a server connected mid-run won't show
    // up until the next /agent invocation.
    let mcp_clone = mcp.inner().clone();
    let mcp_tools = discover_mcp_tools(&mcp_clone).await;
    if !mcp_tools.is_empty() {
        tracing::info!(count = mcp_tools.len(), "exposed MCP tools to agent");
        tools.extend(mcp_tools);
    }

    let approver: Arc<dyn Approver> = Arc::new(EventBusApprover {
        pending: approvals.handle(),
    });

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    let app_for_events = app.clone();
    let topic_for_events = topic.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let _ = app_for_events.emit(&topic_for_events, &ev);
        }
    });

    let goal = req.goal;
    let run_id = req.id;
    let pool = store.pool().clone();
    tokio::spawn(async move {
        let res = run(&goal, cfg, tools, tx, approver).await;
        let (status, summary, error_msg): (&str, String, Option<String>) = match res {
            Ok(()) => ("completed", goal.chars().take(160).collect::<String>(), None),
            Err(err) => ("failed", String::new(), Some(err.to_string())),
        };
        let _ = agent_db::finish(&pool, &run_id, status, Some(&summary)).await;

        if let Some(msg) = error_msg {
            let _ = app.emit(&topic, &AgentEvent::Error { message: msg });
        }
    });

    Ok(())
}

/// Resolve a pending approval. `approve=true` lets the tool run; `false`
/// causes the runtime to skip the tool and feed back "denied by user" as
/// the tool_result content so the model can recover or apologize.
#[tauri::command]
pub async fn agent_decide(
    approvals: State<'_, AgentApprovals>,
    approval_id: String,
    approve: bool,
) -> Result<(), String> {
    let mut map = approvals.pending.lock().await;
    match map.remove(&approval_id) {
        Some(tx) => {
            let _ = tx.send(approve);
            Ok(())
        }
        // It's not necessarily an error to decide twice (e.g. double-click
        // on Approve); just no-op. The error message is intentionally
        // vague — the UI doesn't need to distinguish.
        None => Err(format!("no pending approval for {approval_id}")),
    }
}
