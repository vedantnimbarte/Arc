//! Tauri command surface for [`arc_git`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("git_status",         { path })                              -> Option<GitInfo>
//!   invoke("git_diff_stat",      { path })                              -> Option<DiffStat>
//!   invoke("git_changes",        { path })                              -> Vec<ChangeEntry>
//!   invoke("git_log",            { path, limit, options? })             -> Vec<LogEntry>
//!   invoke("git_diff",           { path, scope, pathFilter? })          -> String
//!   invoke("git_blame",          { path, file, startLine?, endLine? })  -> Vec<BlameLine>
//!   invoke("git_branches",       { path })                              -> Vec<BranchInfo>
//!   invoke("git_checkout",       { path, name })                        -> CheckoutResult
//!   invoke("git_authors",        { path })                              -> Vec<AuthorInfo>
//!   invoke("git_remotes",        { path })                              -> Vec<RemoteInfo>
//!   invoke("git_fetch",          { path, remote? })                     -> RemoteOpResult
//!   invoke("git_pull",           { path, rebase })                      -> RemoteOpResult
//!   invoke("git_push",           { path, remote?, branch?, force, setUpstream }) -> RemoteOpResult
//!   invoke("git_stash_list",     { path })                              -> Vec<StashEntry>
//!   invoke("git_stash_push",     { path, message? })                    -> ()
//!   invoke("git_stash_pop",      { path, index? })                      -> ()
//!   invoke("git_stash_drop",     { path, index })                       -> ()
//!   invoke("git_branch_create",  { path, name, checkout })              -> ()
//!   invoke("git_branch_rename",  { path, oldName, newName })            -> ()
//!   invoke("git_branch_delete",  { path, name, force })                 -> ()
//!   invoke("git_merge",          { path, branch })                      -> MergeResult
//!   invoke("git_commit_amend",   { path, message })                     -> CommitResult
//!   invoke("git_revert",         { path, oid })                         -> CommitResult
//!   invoke("git_cherry_pick",    { path, oid })                         -> ()
//!   invoke("git_reset",          { path, oid, mode })                   -> ()
//!   invoke("git_last_message",   { path })                              -> String
//!   invoke("git_checkout_ours",  { path, paths })                       -> ()
//!   invoke("git_checkout_theirs",{ path, paths })                       -> ()

use arc_git::{
    AuthorInfo, BlameLine, BranchInfo, ChangeEntry, CheckoutResult, CommitResult, DiffScope,
    DiffStat, GitInfo, LogEntry, LogOptions, MergeResult, RemoteInfo, RemoteOpResult, ResetMode,
    StashEntry,
};

#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitInfo>, String> {
    arc_git::status(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_diff_stat(path: String) -> Result<Option<DiffStat>, String> {
    arc_git::diff_stat(&path).await.map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn git_apply(
    path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<(), String> {
    arc_git::apply(&path, &patch, cached, reverse)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_remotes(path: String) -> Result<Vec<RemoteInfo>, String> {
    arc_git::remotes(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_fetch(path: String, remote: Option<String>) -> Result<RemoteOpResult, String> {
    arc_git::fetch(&path, remote.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_pull(path: String, rebase: bool) -> Result<RemoteOpResult, String> {
    arc_git::pull(&path, rebase).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_push(
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    set_upstream: bool,
) -> Result<RemoteOpResult, String> {
    arc_git::push(&path, remote.as_deref(), branch.as_deref(), force, set_upstream)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stash_list(path: String) -> Result<Vec<StashEntry>, String> {
    arc_git::stash_list(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stash_push(path: String, message: Option<String>) -> Result<(), String> {
    arc_git::stash_push(&path, message.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stash_pop(path: String, index: Option<usize>) -> Result<(), String> {
    arc_git::stash_pop(&path, index).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stash_drop(path: String, index: usize) -> Result<(), String> {
    arc_git::stash_drop(&path, index).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branch_create(path: String, name: String, checkout: bool) -> Result<(), String> {
    arc_git::branch_create(&path, &name, checkout)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branch_rename(
    path: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    arc_git::branch_rename(&path, &old_name, &new_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branch_delete(path: String, name: String, force: bool) -> Result<(), String> {
    arc_git::branch_delete(&path, &name, force)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_merge(path: String, branch: String) -> Result<MergeResult, String> {
    arc_git::merge(&path, &branch).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit_amend(path: String, message: String) -> Result<CommitResult, String> {
    arc_git::commit_amend(&path, &message)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_revert(path: String, oid: String) -> Result<CommitResult, String> {
    arc_git::revert(&path, &oid).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_cherry_pick(path: String, oid: String) -> Result<(), String> {
    arc_git::cherry_pick(&path, &oid).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_reset(path: String, oid: String, mode: ResetMode) -> Result<(), String> {
    arc_git::reset(&path, &oid, mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_last_message(path: String) -> Result<String, String> {
    arc_git::last_commit_message(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_checkout_ours(path: String, paths: Vec<String>) -> Result<(), String> {
    arc_git::checkout_ours(&path, &paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_checkout_theirs(path: String, paths: Vec<String>) -> Result<(), String> {
    arc_git::checkout_theirs(&path, &paths)
        .await
        .map_err(|e| e.to_string())
}
