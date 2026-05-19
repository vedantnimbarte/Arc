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

use arc_filesystem::{DirEntry, SearchHit, Watcher};
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

#[tauri::command]
pub async fn fs_search(root: String, query: String, limit: usize) -> Result<Vec<SearchHit>, String> {
    // Prefer the persistent index if one's been built. Otherwise fall back
    // to the walk-based search — same shape of result either way, so the
    // frontend palette is none the wiser.
    let root_for_index = root.clone();
    let query_for_index = query.clone();
    let from_index = tokio::task::spawn_blocking(move || {
        arc_filesystem::index_search(&root_for_index, &query_for_index, limit)
    })
    .await
    .map_err(|e| format!("index task: {e}"))?
    .map_err(|e| e.to_string())?;

    if let Some(hits) = from_index {
        return Ok(hits
            .into_iter()
            .map(|h| SearchHit {
                path: h.path,
                name: h.name,
                line: h.line,
                snippet: h.snippet,
                // Map tantivy BM25 (float, larger = better) onto the existing
                // i32 score field by scaling. Doesn't need to be precise —
                // we only sort within the result list.
                score: (h.score * 100.0) as i32,
            })
            .collect());
    }

    tokio::task::spawn_blocking(move || arc_filesystem::search_files(&root, &query, limit))
        .await
        .map_err(|e| format!("search task: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_index_rebuild(root: String) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || arc_filesystem::index_rebuild(&root))
        .await
        .map_err(|e| format!("index task: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_index_status(root: String) -> Result<bool, String> {
    Ok(arc_filesystem::index_is_built(&root))
}
