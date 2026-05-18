//! Tauri command surface for [`arc_filesystem`]. The real work lives in
//! the library crate; this file is a thin delegation layer + the watch
//! state.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("fs_default_root")              -> String
//!   invoke("fs_read_dir",   { path })      -> Vec<DirEntry>
//!   invoke("fs_parent",     { path })      -> Option<String>
//!   invoke("fs_pick_folder", { starting? })-> Option<String>
//!   invoke("fs_read_file",  { path })      -> String (utf-8)
//!   invoke("fs_write_file", { path, content }) -> ()
//!   invoke("fs_watch_start", { path })     -> String (watchId)
//!   invoke("fs_watch_stop",  { watchId })  -> ()
//!
//! Emitted events:
//!   "fs://change/<watchId>" -> ()  (one per debounced ~150 ms batch)

use std::sync::Arc;

use arc_filesystem::{DirEntry, Watcher};
use dashmap::DashMap;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Per-app state: live watchers keyed by their generated watch id. Dropping
/// a watcher from this map tears down both the notify watcher and its
/// bridge thread.
#[derive(Default, Clone)]
pub struct WatchState {
    watchers: Arc<DashMap<String, Watcher>>,
}

#[tauri::command]
pub async fn fs_default_root() -> Result<String, String> {
    arc_filesystem::default_root().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_parent(path: String) -> Result<Option<String>, String> {
    Ok(arc_filesystem::parent(&path))
}

#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    arc_filesystem::read_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<String, String> {
    arc_filesystem::read_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    arc_filesystem::write_file(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_pick_folder(starting: Option<String>) -> Result<Option<String>, String> {
    arc_filesystem::pick_folder(starting)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_watch_start(
    state: State<'_, WatchState>,
    app: AppHandle,
    path: String,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let (watcher, mut rx) = Watcher::start(&path).map_err(|e| e.to_string())?;

    // Forward debounced () events as Tauri events. The task exits naturally
    // when the watcher is dropped from `state` (sender closes → rx returns
    // None).
    let topic = format!("fs://change/{id}");
    let handle = app.clone();
    tokio::spawn(async move {
        while rx.recv().await.is_some() {
            let _ = handle.emit(&topic, ());
        }
    });

    state.watchers.insert(id.clone(), watcher);
    Ok(id)
}

#[tauri::command]
pub async fn fs_watch_stop(state: State<'_, WatchState>, watch_id: String) -> Result<(), String> {
    state.watchers.remove(&watch_id);
    Ok(())
}
