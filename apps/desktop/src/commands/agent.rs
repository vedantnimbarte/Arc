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
    run, AgentEvent, Approver, FsReadFileTool, FsSearchTool, FsWriteFileTool, RunConfig,
    ShellTool, Tool,
};
use arc_session_manager::{agent as agent_db, SessionStore};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

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
    let tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(FsReadFileTool),
        Arc::new(FsSearchTool),
        Arc::new(FsWriteFileTool),
        Arc::new(ShellTool),
    ];

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
