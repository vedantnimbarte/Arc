//! Tauri command surface for [`arc_session_manager`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("session_load")                                   -> SessionState
//!   invoke("session_save_tabs", { sessionId, tabs, activeTabId, paneLayout }) -> ()
//!   invoke("session_set_workspace", { sessionId, workspaceId })   -> ()
//!
//!   invoke("session_workspaces_list")                        -> Vec<Workspace>
//!   invoke("session_workspace_upsert", { name, root })       -> Workspace
//!   invoke("session_workspace_delete", { id })               -> ()

use arc_session_manager::{
    commands as cmd_history, settings, tabs, workspaces, CommandRecord, SessionState, SessionStore,
    TabInput, Workspace,
};
use tauri::State;

fn str_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ─── sessions / tabs ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_load(store: State<'_, SessionStore>) -> Result<SessionState, String> {
    tabs::current_or_create(store.pool()).await.map_err(str_err)
}

#[tauri::command]
pub async fn session_save_tabs(
    store: State<'_, SessionStore>,
    session_id: String,
    tabs: Vec<TabInput>,
    active_tab_id: Option<String>,
    pane_layout: Option<String>,
) -> Result<(), String> {
    arc_session_manager::tabs::save_tabs(
        store.pool(),
        &session_id,
        &tabs,
        active_tab_id.as_deref(),
        pane_layout.as_deref(),
    )
    .await
    .map_err(str_err)
}

#[tauri::command]
pub async fn session_set_workspace(
    store: State<'_, SessionStore>,
    session_id: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    arc_session_manager::tabs::set_workspace(store.pool(), &session_id, workspace_id.as_deref())
        .await
        .map_err(str_err)
}

// ─── workspaces ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_workspaces_list(
    store: State<'_, SessionStore>,
) -> Result<Vec<Workspace>, String> {
    workspaces::list(store.pool()).await.map_err(str_err)
}

#[tauri::command]
pub async fn session_workspace_upsert(
    store: State<'_, SessionStore>,
    name: String,
    root: String,
) -> Result<Workspace, String> {
    workspaces::upsert(store.pool(), &name, &root)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn session_workspace_delete(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    workspaces::delete(store.pool(), &id).await.map_err(str_err)
}

// ─── command history ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn session_command_log(
    store: State<'_, SessionStore>,
    session_id: Option<String>,
    tab_id: Option<String>,
    workspace_id: Option<String>,
    cwd: Option<String>,
    command: String,
) -> Result<i64, String> {
    cmd_history::append(
        store.pool(),
        session_id.as_deref(),
        tab_id.as_deref(),
        workspace_id.as_deref(),
        cwd.as_deref(),
        &command,
    )
    .await
    .map_err(str_err)
}

#[tauri::command]
pub async fn session_commands_recent(
    store: State<'_, SessionStore>,
    limit: i64,
    query: Option<String>,
) -> Result<Vec<CommandRecord>, String> {
    cmd_history::recent(store.pool(), limit, query.as_deref())
        .await
        .map_err(str_err)
}

// ─── app settings ─────────────────────────────────────────────────────────

/// Load the serialized user settings JSON, or `null` if none saved yet.
#[tauri::command]
pub async fn session_settings_load(
    store: State<'_, SessionStore>,
) -> Result<Option<String>, String> {
    settings::load(store.pool(), "user_settings")
        .await
        .map_err(str_err)
}

/// Persist the serialized user settings JSON.
#[tauri::command]
pub async fn session_settings_save(
    store: State<'_, SessionStore>,
    value: String,
) -> Result<(), String> {
    settings::save(store.pool(), "user_settings", &value)
        .await
        .map_err(str_err)
}

/// Finalize a command row once the shell reports it has finished (OSC 133 D).
#[tauri::command]
pub async fn session_command_finish(
    store: State<'_, SessionStore>,
    id: i64,
    exit_code: Option<i64>,
    output_excerpt: Option<String>,
) -> Result<(), String> {
    cmd_history::finish(store.pool(), id, exit_code, output_excerpt.as_deref())
        .await
        .map_err(str_err)
}
