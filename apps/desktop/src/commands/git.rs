//! Tauri command surface for [`arc_git`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("git_status",         { path })                              -> Option<GitInfo>
//!   invoke("git_diff_stat",      { path })                              -> Option<DiffStat>
//!   invoke("git_changes",        { path })                              -> Vec<ChangeEntry>
//!   invoke("git_root",           { path })                              -> Option<String>
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
//!   invoke("git_checkpoint_create",  { path, label })                    -> Option<String>
//!   invoke("git_checkpoint_restore", { path, oid })                      -> ()
//!   invoke("git_checkpoint_forget",  { path, oid })                      -> ()
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
//!   invoke("git_worktree_list",  { path })                              -> Vec<WorktreeEntry>
//!   invoke("git_worktree_add",   { path, newPath, branch?, createBranch, startPoint? }) -> ()
//!   invoke("git_worktree_remove",{ path, targetPath, force })           -> ()
//!   invoke("git_rebase_interactive", { path, base, entries })           -> ()
//!   invoke("git_rebase_abort",   { path })                              -> ()
//!   invoke("git_rebase_continue",{ path })                              -> ()
//!   invoke("git_tags",           { path })                              -> Vec<TagInfo>
//!   invoke("git_tag_create",     { path, name, message?, oid? })        -> ()
//!   invoke("git_tag_delete",     { path, name })                        -> ()
//!   invoke("git_tag_push",       { path, name, remote? })               -> RemoteOpResult
//!   invoke("git_remote_add",     { path, name, url })                   -> ()
//!   invoke("git_remote_remove",  { path, name })                        -> ()
//!   invoke("git_remote_set_url", { path, name, url })                   -> ()
//!   invoke("git_reflog",         { path, limit })                       -> Vec<ReflogEntry>
//!   invoke("git_submodules",     { path })                              -> Vec<SubmoduleEntry>
//!   invoke("git_bisect_status",  { path })                              -> BisectStatus
//!   invoke("git_bisect_start",   { path, bad?, good? })                 -> String
//!   invoke("git_bisect_mark",    { path, term })                        -> String
//!   invoke("git_bisect_reset",   { path })                              -> ()

use arc_git::{
    AuthorInfo, BisectStatus, BlameLine, BranchInfo, ChangeEntry, CheckoutResult, CommitResult, DiffScope,
    DiffStat, GitInfo, LogEntry, LogOptions, MergeResult, RebaseTodoEntry, ReflogEntry, RemoteInfo,
    RemoteOpResult, ResetMode, StashEntry, SubmoduleEntry, TagInfo, WorktreeEntry,
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
pub async fn git_root(path: String) -> Result<Option<String>, String> {
    arc_git::root(&path).await.map_err(|e| e.to_string())
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
pub async fn git_commit(
    path: String,
    message: String,
    sign: Option<bool>,
    signoff: Option<bool>,
) -> Result<CommitResult, String> {
    arc_git::commit(
        &path,
        &message,
        sign.unwrap_or(false),
        signoff.unwrap_or(false),
    )
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

/// Take a restore point before an agent edits the tree. `None` means the tree
/// was clean and there is nothing to restore to.
#[tauri::command]
pub async fn git_checkpoint_create(path: String, label: String) -> Result<Option<String>, String> {
    arc_git::checkpoint_create(&path, &label)
        .await
        .map_err(|e| e.to_string())
}

/// Put tracked files back as they were at `oid`. Files created since are left
/// alone — see `arc_git::checkpoint_create`.
#[tauri::command]
pub async fn git_checkpoint_restore(path: String, oid: String) -> Result<(), String> {
    arc_git::checkpoint_restore(&path, &oid)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_checkpoint_forget(path: String, oid: String) -> Result<(), String> {
    arc_git::checkpoint_forget(&path, &oid)
        .await
        .map_err(|e| e.to_string())
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
pub async fn git_commit_amend(
    path: String,
    message: String,
    sign: Option<bool>,
    signoff: Option<bool>,
) -> Result<CommitResult, String> {
    arc_git::commit_amend(
        &path,
        &message,
        sign.unwrap_or(false),
        signoff.unwrap_or(false),
    )
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

#[tauri::command]
pub async fn git_worktree_list(path: String) -> Result<Vec<WorktreeEntry>, String> {
    arc_git::worktree_list(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_worktree_add(
    path: String,
    new_path: String,
    branch: Option<String>,
    create_branch: bool,
    start_point: Option<String>,
) -> Result<(), String> {
    arc_git::worktree_add(
        &path,
        &new_path,
        branch.as_deref(),
        create_branch,
        start_point.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_worktree_remove(
    path: String,
    target_path: String,
    force: bool,
) -> Result<(), String> {
    arc_git::worktree_remove(&path, &target_path, force)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_rebase_interactive(
    path: String,
    base: String,
    entries: Vec<RebaseTodoEntry>,
) -> Result<(), String> {
    arc_git::rebase_interactive(&path, &base, &entries)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_rebase_abort(path: String) -> Result<(), String> {
    arc_git::rebase_abort(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_rebase_continue(path: String) -> Result<(), String> {
    arc_git::rebase_continue(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_tags(path: String) -> Result<Vec<TagInfo>, String> {
    arc_git::tags(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_tag_create(
    path: String,
    name: String,
    message: Option<String>,
    oid: Option<String>,
) -> Result<(), String> {
    arc_git::tag_create(&path, &name, message.as_deref(), oid.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_tag_delete(path: String, name: String) -> Result<(), String> {
    arc_git::tag_delete(&path, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_tag_push(
    path: String,
    name: String,
    remote: Option<String>,
) -> Result<RemoteOpResult, String> {
    arc_git::tag_push(&path, &name, remote.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_remote_add(path: String, name: String, url: String) -> Result<(), String> {
    arc_git::remote_add(&path, &name, &url)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_remote_remove(path: String, name: String) -> Result<(), String> {
    arc_git::remote_remove(&path, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_remote_set_url(path: String, name: String, url: String) -> Result<(), String> {
    arc_git::remote_set_url(&path, &name, &url)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_reflog(path: String, limit: Option<usize>) -> Result<Vec<ReflogEntry>, String> {
    arc_git::reflog(&path, limit.unwrap_or(100))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_submodules(path: String) -> Result<Vec<SubmoduleEntry>, String> {
    arc_git::submodules(&path).await.map_err(|e| e.to_string())
}

// ----- bisect ---------------------------------------------------------------

#[tauri::command]
pub async fn git_bisect_status(path: String) -> Result<BisectStatus, String> {
    arc_git::bisect_status(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_bisect_start(
    path: String,
    bad: Option<String>,
    good: Option<String>,
) -> Result<String, String> {
    arc_git::bisect_start(&path, bad.as_deref(), good.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// `term` is one of `good`, `bad`, `skip` — validated in `arc_git` before it
/// reaches a command line, since it comes from the renderer.
#[tauri::command]
pub async fn git_bisect_mark(path: String, term: String) -> Result<String, String> {
    arc_git::bisect_mark(&path, &term)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_bisect_reset(path: String) -> Result<(), String> {
    arc_git::bisect_reset(&path).await.map_err(|e| e.to_string())
}
