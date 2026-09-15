//! Tauri command surface for [`arc_filesystem`]. The real work lives in
//! the library crate; this file is a thin delegation layer + the watch
//! state.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("fs_default_root")              -> String
//!   invoke("fs_read_dir",   { path })      -> Vec<DirEntry>
//!   invoke("fs_parent",     { path })      -> Option<String>
//!   invoke("fs_pick_folder", { starting? })-> Option<String>
//!   invoke("fs_pick_save_file", { defaultName }) -> Option<String>
//!   invoke("fs_read_file",  { path })      -> String (utf-8)
//!   invoke("fs_write_file", { path, content }) -> ()
//!   invoke("fs_watch_start", { path })     -> String (watchId)
//!   invoke("fs_watch_stop",  { watchId })  -> ()
//!   invoke("fs_scratch_file", { ext })    -> String (path)
//!
//! Emitted events:
//!   "fs://change/<watchId>" -> ()  (one per debounced ~150 ms batch)

use std::sync::Arc;

use arc_filesystem::{DirEntry, FileItem, ReplaceMatch, ReplaceSummary, SearchHit, Watcher};
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

/// Create an empty scratch file and hand back its path. The caller opens it
/// like any other file — see `arc_filesystem::scratch_file`.
#[tauri::command]
pub async fn fs_scratch_file(ext: String) -> Result<String, String> {
    arc_filesystem::scratch_file(&ext).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_pick_folder(starting: Option<String>) -> Result<Option<String>, String> {
    arc_filesystem::pick_folder(starting)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_pick_save_file(default_name: String) -> Result<Option<String>, String> {
    arc_filesystem::pick_save_file(default_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_pick_files(starting: Option<String>) -> Result<Vec<String>, String> {
    arc_filesystem::pick_files(starting)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_list_files(
    root: String,
    query: String,
    limit: usize,
    ignore_dirs: Vec<String>,
) -> Result<Vec<FileItem>, String> {
    tokio::task::spawn_blocking(move || arc_filesystem::list_files(&root, &query, limit, &ignore_dirs))
        .await
        .map_err(|e| format!("list task: {e}"))?
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
pub async fn fs_search(
    root: String,
    query: String,
    limit: usize,
    ignore_dirs: Vec<String>,
) -> Result<Vec<SearchHit>, String> {
    tokio::task::spawn_blocking(move || {
        arc_filesystem::search_files(&root, &query, limit, &ignore_dirs)
    })
    .await
    .map_err(|e| format!("search task: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_rename(path: String, new_name: String) -> Result<String, String> {
    use std::path::Path;
    let src = Path::new(&path);
    let parent = src.parent().ok_or_else(|| "path has no parent".to_string())?;
    let dst = parent.join(&new_name);
    tokio::fs::rename(&src, &dst).await.map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn fs_delete(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        tokio::fs::remove_dir_all(p).await.map_err(|e| e.to_string())
    } else {
        tokio::fs::remove_file(p).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn fs_reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let p = std::path::Path::new(&path);
        if p.is_dir() {
            std::process::Command::new("explorer.exe")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", path))
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .unwrap_or_else(|| std::path::Path::new("/"))
            .to_string_lossy()
            .to_string();
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    tokio::fs::create_dir_all(&path).await.map_err(|e| e.to_string())
}

// ─── find & replace across the workspace ─────────────────────────────────
//
//   invoke("fs_replace_find",  { root, needle, caseSensitive, limit, ignoreDirs })
//       -> ReplaceMatch[]
//   invoke("fs_replace_apply", { root, files, needle, replacement, caseSensitive })
//       -> ReplaceSummary
//
// Two calls rather than one: the frontend previews the matches, the user
// approves, and only the files they kept are sent to the apply. Both run on
// the blocking pool — they walk and rewrite the tree synchronously, which
// would otherwise stall the async runtime.

#[tauri::command]
pub async fn fs_replace_find(
    root: String,
    needle: String,
    case_sensitive: bool,
    limit: usize,
    ignore_dirs: Vec<String>,
) -> Result<Vec<ReplaceMatch>, String> {
    tokio::task::spawn_blocking(move || {
        arc_filesystem::find_literal(&root, &needle, case_sensitive, limit, &ignore_dirs)
    })
    .await
    .map_err(|e| format!("replace-find task: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_replace_apply(
    root: String,
    files: Vec<String>,
    needle: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<ReplaceSummary, String> {
    tokio::task::spawn_blocking(move || {
        arc_filesystem::replace_in_files(&root, &files, &needle, &replacement, case_sensitive)
    })
    .await
    .map_err(|e| format!("replace-apply task: {e}"))?
    .map_err(|e| e.to_string())
}
