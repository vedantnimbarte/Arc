//! Tauri command surface for [`arc_agent_runtime`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("agent_run", { req }) -> ()  (returns immediately; events stream)
//!
//! Emitted events:
//!   "agent://event/<runId>" -> AgentEvent (text / tool_start / tool_result / done / error)

use std::sync::Arc;

use arc_agent_runtime::{run, AgentEvent, FsReadFileTool, FsSearchTool, RunConfig, Tool};
use arc_session_manager::{agent as agent_db, SessionStore};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
pub struct AgentRunReq {
    pub id: String,
    pub goal: String,
    pub api_key: String,
    pub model: String,
    pub workspace_root: Option<String>,
    pub workspace_id: Option<String>,
}

#[tauri::command]
pub async fn agent_run(
    store: State<'_, SessionStore>,
    app: AppHandle,
    req: AgentRunReq,
) -> Result<(), String> {
    let topic = format!("agent://event/{}", req.id);

    if let Err(err) = agent_db::start(
        store.pool(),
        &req.id,
        req.workspace_id.as_deref(),
        "coding-v0",
    )
    .await
    {
        tracing::warn!(?err, "agent_runs insert failed");
    }

    let cfg = RunConfig {
        api_key: req.api_key,
        model: req.model,
        workspace_root: req.workspace_root,
        ..Default::default()
    };
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(FsReadFileTool), Arc::new(FsSearchTool)];

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
        let res = run(&goal, cfg, tools, tx).await;
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
