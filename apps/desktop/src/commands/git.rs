//! Tauri command surface for [`arc_git`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("git_status",   { path })                              -> Option<GitInfo>
//!   invoke("git_changes",  { path })                              -> Vec<ChangeEntry>
//!   invoke("git_log",      { path, limit, options? })             -> Vec<LogEntry>
//!   invoke("git_diff",     { path, scope, pathFilter? })           -> String
//!   invoke("git_blame",    { path, file, startLine?, endLine? })   -> Vec<BlameLine>
//!   invoke("git_branches", { path })                               -> Vec<BranchInfo>
//!   invoke("git_checkout", { path, name })                         -> CheckoutResult
//!   invoke("git_authors",  { path })                               -> Vec<AuthorInfo>

use arc_git::{AuthorInfo, BlameLine, BranchInfo, ChangeEntry, CheckoutResult, CommitResult, DiffScope, GitInfo, LogEntry, LogOptions};

#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitInfo>, String> {
    arc_git::status(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_changes(path: String) -> Result<Vec<ChangeEntry>, String> {
    arc_git::changes(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: usize,
    options: Option<LogOptions>,
) -> Result<Vec<LogEntry>, String> {
    let opts = options.unwrap_or_default();
    arc_git::log(&path, limit, &opts)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_authors(path: String) -> Result<Vec<AuthorInfo>, String> {
    arc_git::authors(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_diff(
    path: String,
    scope: DiffScope,
    path_filter: Option<String>,
) -> Result<String, String> {
    arc_git::diff(&path, scope, path_filter.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_blame(
    path: String,
    file: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<Vec<BlameLine>, String> {
    let range = match (start_line, end_line) {
        (Some(s), Some(e)) if s > 0 && e >= s => Some((s, e)),
        _ => None,
    };
    arc_git::blame(&path, &file, range)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    arc_git::branches(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_checkout(path: String, name: String) -> Result<CheckoutResult, String> {
    arc_git::checkout(&path, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stage(path: String, paths: Vec<String>) -> Result<(), String> {
    arc_git::stage(&path, &paths).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_unstage(path: String, paths: Vec<String>) -> Result<(), String> {
    arc_git::unstage(&path, &paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<CommitResult, String> {
    arc_git::commit(&path, &message)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_discard(
    path: String,
    tracked_paths: Vec<String>,
    untracked_paths: Vec<String>,
) -> Result<(), String> {
    arc_git::discard(&path, &tracked_paths, &untracked_paths)
        .await
        .map_err(|e| e.to_string())
}
