//! Tauri command surface for [`arc_lsp`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("lsp_start",      { id, command, args, rootUri? })            -> capabilities (JSON)
//!   invoke("lsp_did_open",   { id, uri, languageId, version, text })     -> ()
//!   invoke("lsp_did_change", { id, uri, version, text })                 -> ()
//!   invoke("lsp_did_close",  { id, uri })                                -> ()
//!   invoke("lsp_hover",      { id, uri, line, character })               -> Hover | null (JSON)
//!   invoke("lsp_completion", { id, uri, line, character })               -> CompletionList (JSON)
//!   invoke("lsp_definition", { id, uri, line, character })               -> Location[] (JSON)
//!   invoke("lsp_stop",       { id })                                     -> ()
//!   invoke("lsp_is_running", { id })                                     -> bool
//!
//! Emitted events:
//!   "lsp://event/<id>" -> LspEvent { session_id, method, params }
//!     (notably method = "textDocument/publishDiagnostics")

use std::sync::Arc;

use arc_lsp::{LspEvent, LspManager};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Holds the [`LspManager`] plus the emitter task that bridges its
/// notification channel onto Tauri events.
pub struct LspState {
    pub manager: Arc<LspManager>,
}

impl LspState {
    /// Build the manager and spawn the task that re-emits every server
    /// notification on `lsp://event/<session_id>`.
    pub fn new(app: AppHandle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<LspEvent>();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = rx.recv().await {
                let topic = format!("lsp://event/{}", ev.session_id);
                let _ = app.emit(&topic, &ev);
            }
        });
        Self {
            manager: Arc::new(LspManager::new(tx)),
        }
    }
}

#[tauri::command]
pub async fn lsp_start(
    state: State<'_, LspState>,
    id: String,
    command: String,
    args: Vec<String>,
    root_uri: Option<String>,
) -> Result<Value, String> {
    state
        .manager
        .start(&id, &command, &args, root_uri.as_deref())
        .await
}

#[tauri::command]
pub async fn lsp_did_open(
    state: State<'_, LspState>,
    id: String,
    uri: String,
    language_id: String,
    version: i64,
    text: String,
) -> Result<(), String> {
    state
        .manager
        .did_open(&id, &uri, &language_id, version, &text)
        .await
}

#[tauri::command]
pub async fn lsp_did_change(
    state: State<'_, LspState>,
    id: String,
    uri: String,
    version: i64,
    text: String,
) -> Result<(), String> {
    state.manager.did_change(&id, &uri, version, &text).await
}

#[tauri::command]
pub async fn lsp_did_close(
    state: State<'_, LspState>,
    id: String,
    uri: String,
) -> Result<(), String> {
    state.manager.did_close(&id, &uri).await
}

#[tauri::command]
pub async fn lsp_hover(
    state: State<'_, LspState>,
    id: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    state.manager.hover(&id, &uri, line, character).await
}

#[tauri::command]
pub async fn lsp_completion(
    state: State<'_, LspState>,
    id: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    state.manager.completion(&id, &uri, line, character).await
}

#[tauri::command]
pub async fn lsp_definition(
    state: State<'_, LspState>,
    id: String,
    uri: String,
    line: u32,
    character: u32,
) -> Result<Value, String> {
    state.manager.definition(&id, &uri, line, character).await
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LspState>, id: String) -> Result<(), String> {
    state.manager.stop(&id).await
}

#[tauri::command]
pub async fn lsp_is_running(state: State<'_, LspState>, id: String) -> Result<bool, String> {
    Ok(state.manager.is_running(&id))
}
