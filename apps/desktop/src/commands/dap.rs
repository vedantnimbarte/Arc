//! Tauri command surface for [`arc_dap`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("dap_start",   { id, params: StartParams })       -> { capabilities, breakpoints }
//!   invoke("dap_request", { id, command, arguments })        -> response body (JSON)
//!   invoke("dap_stop",    { id })                            -> ()
//!
//! Emitted events:
//!   "dap://event/<id>" -> DapEvent { session_id, event, body }

use std::sync::Arc;

use arc_dap::{DapEvent, DapManager, StartParams};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Holds the [`DapManager`] plus the task bridging its events onto Tauri.
pub struct DapState {
    pub manager: Arc<DapManager>,
}

impl DapState {
    pub fn new(app: AppHandle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<DapEvent>();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = rx.recv().await {
                let topic = format!("dap://event/{}", ev.session_id);
                let _ = app.emit(&topic, &ev);
            }
        });
        Self {
            manager: Arc::new(DapManager::new(tx)),
        }
    }
}

#[tauri::command]
pub async fn dap_start(
    state: State<'_, DapState>,
    id: String,
    params: StartParams,
) -> Result<Value, String> {
    state.manager.start(&id, params).await
}

#[tauri::command]
pub async fn dap_request(
    state: State<'_, DapState>,
    id: String,
    command: String,
    arguments: Value,
) -> Result<Value, String> {
    state.manager.request(&id, &command, arguments).await
}

#[tauri::command]
pub async fn dap_stop(state: State<'_, DapState>, id: String) -> Result<(), String> {
    state.manager.stop(&id).await
}
