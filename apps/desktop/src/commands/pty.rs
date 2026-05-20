//! Tauri command surface for [`arc_pty::PtyManager`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("pty_spawn",       { opts: PtySpawnOpts })   -> id
//!   invoke("pty_write",       { id, data })             -> ()
//!   invoke("pty_resize",      { id, cols, rows })       -> ()
//!   invoke("pty_kill",        { id })                   -> ()
//!   invoke("pty_list_shells", {})                       -> Vec<ShellInfo>
//!
//! Emitted events:
//!   "pty://data/<id>" -> { id, bytes: number[] }
//!   "pty://exit/<id>" -> { id, code: number | null }

use std::sync::Arc;

use arc_pty::{discover_ai_clis, discover_shells, AiCliInfo, PtyManager, ShellInfo, SpawnOptions};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct PtyState {
    pub manager: Arc<PtyManager>,
}

#[derive(Debug, Deserialize)]
pub struct PtySpawnOpts {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Clone)]
struct PtyDataEvent {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
struct PtyExitEvent {
    id: String,
    code: Option<i32>,
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    opts: PtySpawnOpts,
) -> Result<String, String> {
    let result = state
        .manager
        .spawn(SpawnOptions {
            shell: opts.shell,
            cwd: opts.cwd,
            cols: opts.cols,
            rows: opts.rows,
        })
        .map_err(|e| format!("{e:#}"))?;

    let id = result.id;
    let data_topic = format!("pty://data/{id}");
    let exit_topic = format!("pty://exit/{id}");

    // Drain data channel and forward as Tauri events.
    {
        let app = app.clone();
        let mut rx = result.data_rx;
        let id_for_data = id.clone();
        tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                if app
                    .emit(
                        &data_topic,
                        PtyDataEvent {
                            id: id_for_data.clone(),
                            bytes,
                        },
                    )
                    .is_err()
                {
                    break;
                }
            }
            tracing::debug!(id = %id_for_data, "pty data stream closed");
        });
    }

    // Drain exit channel exactly once.
    {
        let app = app.clone();
        let rx = result.exit_rx;
        let id_for_exit = id.clone();
        tokio::spawn(async move {
            if let Ok(code) = rx.await {
                let _ = app.emit(
                    &exit_topic,
                    PtyExitEvent {
                        id: id_for_exit.clone(),
                        code,
                    },
                );
                tracing::debug!(id = %id_for_exit, code = ?code, "pty exited");
            }
        });
    }

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .manager
        .write(&id, data.as_bytes())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .manager
        .resize(&id, cols, rows)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    state.manager.kill(&id).map_err(|e| format!("{e:#}"))
}

/// Enumerate shells the picker can offer. The OS default is flagged via
/// `is_default`; an empty result means none of the known candidates are on
/// PATH (e.g. a stripped container image). The UI still lets the user type
/// a custom path in that case.
#[tauri::command]
pub async fn pty_list_shells() -> Result<Vec<ShellInfo>, String> {
    Ok(discover_shells())
}

/// Enumerate installed AI coding-agent CLIs (Claude Code, OpenAI Codex,
/// OpenCode). Used by the launcher UI to populate menus and by the chat
/// panel to surface `local-cli` providers only when their binary is
/// actually present.
#[tauri::command]
pub async fn pty_list_ai_clis() -> Result<Vec<AiCliInfo>, String> {
    Ok(discover_ai_clis())
}
