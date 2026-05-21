//! Tauri command surface for [`arc_git`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("git_status",   { path })                              -> Option<GitInfo>
//!   invoke("git_log",      { path, limit, pathFilter? })           -> Vec<LogEntry>
//!   invoke("git_diff",     { path, scope, pathFilter? })           -> String
//!   invoke("git_blame",    { path, file, startLine?, endLine? })   -> Vec<BlameLine>
//!   invoke("git_branches", { path })                               -> Vec<BranchInfo>
//!   invoke("git_checkout", { path, name })                         -> CheckoutResult

use arc_git::{BlameLine, BranchInfo, CheckoutResult, DiffScope, GitInfo, LogEntry};

#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitInfo>, String> {
    arc_git::status(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: usize,
    path_filter: Option<String>,
) -> Result<Vec<LogEntry>, String> {
    arc_git::log(&path, limit, path_filter.as_deref())
        .await
        .map_err(|e| e.to_string())
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
