//! Tauri command surface for [`arc_pty::PtyManager`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("pty_spawn",       { opts: PtySpawnOpts, onData: Channel }) -> id
//!   invoke("pty_write",       { id, data })             -> ()
//!   invoke("pty_resize",      { id, cols, rows })       -> ()
//!   invoke("pty_kill",        { id })                   -> ()
//!   invoke("pty_list_shells", {})                       -> Vec<ShellInfo>
//!
//! Shell output is streamed to the frontend over a per-spawn
//! `tauri::ipc::Channel` carrying **raw bytes** (`InvokeResponseBody::Raw`).
//! This is point-to-point (no broadcast to the settings/git popup windows)
//! and — for the bursty chunks that actually saturate the UI — skips the
//! JSON-number-array serialization the global event bus would impose. The
//! old `pty://data/<id>` *event* (which serialized every byte as a JSON
//! number and fanned out to every window) is gone; that fan-out + bloat was
//! the cause of the multi-tab freeze.
//!
//! Emitted events (low frequency — kept on the global bus):
//!   "pty://exit/<id>" -> { id, code: number | null }

use std::sync::Arc;

use arc_pty::{discover_ai_clis, discover_shells, AiCliInfo, PtyManager, ShellInfo, SpawnOptions};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
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
struct PtyExitEvent {
    id: String,
    code: Option<i32>,
}

#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    opts: PtySpawnOpts,
    on_data: Channel<InvokeResponseBody>,
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
    let exit_topic = format!("pty://exit/{id}");

    // Drain the data channel straight onto the per-spawn IPC channel as raw
    // bytes. `on_data` is registered on the JS side before this command even
    // runs, so there's no spawn→listen race (the old event path had one).
    {
        let mut rx = result.data_rx;
        let channel = on_data;
        let id_for_data = id.clone();
        tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                if channel.send(InvokeResponseBody::Raw(bytes)).is_err() {
                    // Webview/channel gone — stop draining; the reader thread
                    // and shell are torn down when `pty_kill` runs.
                    break;
                }
            }
            tracing::debug!(id = %id_for_data, "pty data stream closed");
        });
    }

    // Drain exit channel exactly once. Single low-frequency event — the
    // global bus is fine here.
    {
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

// PTY writes/resizes/kills hit blocking syscalls (writing to the shell's
// stdin can block when the child isn't draining it; locking the master is a
// blocking mutex). Running those directly in an `async` command parks a Tokio
// worker thread — and once enough are parked, *no* async command can be
// scheduled, so `pty_spawn` (open a tab) and `pty_kill` (close a tab / quit)
// silently hang. Offloading to the blocking pool keeps the async runtime free.

#[tauri::command]
pub async fn pty_write(
    state: State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&id, data.as_bytes()))
        .await
        .map_err(|e| format!("pty write task failed: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.resize(&id, cols, rows))
        .await
        .map_err(|e| format!("pty resize task failed: {e}"))?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let manager = state.manager.clone();
    tauri::async_runtime::spawn_blocking(move || manager.kill(&id))
        .await
        .map_err(|e| format!("pty kill task failed: {e}"))?
        .map_err(|e| format!("{e:#}"))
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
