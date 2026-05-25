//! Tauri command surface for [`arc_system_monitor`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("system_snapshot")                        -> SystemSnapshot
//!   invoke("system_processes_list")                  -> Vec<ProcessInfo>
//!   invoke("system_process_kill", { pid })           -> ()

use std::sync::Arc;

use arc_system_monitor::{Monitor, ProcessInfo, SystemSnapshot};
use tauri::State;

/// Tauri-managed shared state. One `Monitor` for the entire app — the
/// network-rate counters live inside it, so two callers sampling at
/// different cadences still get a coherent series.
pub type SystemState = Arc<Monitor>;

#[tauri::command]
pub async fn system_snapshot(state: State<'_, SystemState>) -> Result<SystemSnapshot, String> {
    let monitor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || monitor.snapshot())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn system_processes_list(
    state: State<'_, SystemState>,
) -> Result<Vec<ProcessInfo>, String> {
    let monitor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || monitor.processes())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn system_process_kill(
    state: State<'_, SystemState>,
    pid: u32,
) -> Result<(), String> {
    let monitor = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || monitor.kill(pid))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
