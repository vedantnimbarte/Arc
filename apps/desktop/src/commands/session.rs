//! Tauri command surface for [`arc_session_manager`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("session_load")                                   -> SessionState
//!   invoke("session_save_tabs", { sessionId, tabs, activeTabId }) -> ()
//!   invoke("session_set_workspace", { sessionId, workspaceId })   -> ()
//!
//!   invoke("session_workspaces_list")                        -> Vec<Workspace>
//!   invoke("session_workspace_upsert", { name, root })       -> Workspace
//!   invoke("session_workspace_delete", { id })               -> ()
//!
//!   invoke("session_chat_load",   { workspaceId? })          -> ChatLoad
//!   invoke("session_chat_append", { conversationId, role, content }) -> ChatMessage
//!   invoke("session_chat_clear",  { conversationId })        -> ()

use arc_session_manager::{
    chat, commands as cmd_history, tabs, workspaces, ChatConversation, ChatMessage, ChatRole,
    CommandRecord, SessionState, SessionStore, TabInput, Workspace,
};
use serde::{Deserialize, Serialize};
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
) -> Result<(), String> {
    arc_session_manager::tabs::save_tabs(
        store.pool(),
        &session_id,
        &tabs,
        active_tab_id.as_deref(),
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

// ─── chat ─────────────────────────────────────────────────────────────────

/// Combined payload — saves a round-trip on launch.
#[derive(Debug, Serialize)]
pub struct ChatLoad {
    pub conversation: ChatConversation,
    pub messages: Vec<ChatMessage>,
}

#[tauri::command]
pub async fn session_chat_load(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
) -> Result<ChatLoad, String> {
    let conversation = chat::current_or_create(store.pool(), workspace_id.as_deref())
        .await
        .map_err(str_err)?;
    let messages = chat::list(store.pool(), &conversation.id)
        .await
        .map_err(str_err)?;
    Ok(ChatLoad { conversation, messages })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WireRole {
    System,
    User,
    Assistant,
}

impl From<WireRole> for ChatRole {
    fn from(r: WireRole) -> Self {
        match r {
            WireRole::System => ChatRole::System,
            WireRole::User => ChatRole::User,
            WireRole::Assistant => ChatRole::Assistant,
        }
    }
}

#[tauri::command]
pub async fn session_chat_append(
    store: State<'_, SessionStore>,
    conversation_id: String,
    role: WireRole,
    content: String,
) -> Result<ChatMessage, String> {
    chat::append(store.pool(), &conversation_id, role.into(), &content)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn session_chat_clear(
    store: State<'_, SessionStore>,
    conversation_id: String,
) -> Result<(), String> {
    chat::clear(store.pool(), &conversation_id)
        .await
        .map_err(str_err)
}

// ─── chat sessions (multi-conversation) ──────────────────────────────────

#[tauri::command]
pub async fn session_chat_sessions_list(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
) -> Result<Vec<ChatConversation>, String> {
    chat::list_conversations(store.pool(), workspace_id.as_deref())
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn session_chat_session_create(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
    agent_id: Option<String>,
    title: Option<String>,
) -> Result<ChatConversation, String> {
    chat::create(
        store.pool(),
        workspace_id.as_deref(),
        agent_id.as_deref(),
        title.as_deref(),
    )
    .await
    .map_err(str_err)
}

#[tauri::command]
pub async fn session_chat_session_update(
    store: State<'_, SessionStore>,
    id: String,
    title: Option<String>,
    agent_id: Option<String>,
) -> Result<(), String> {
    chat::update_meta(store.pool(), &id, title.as_deref(), agent_id.as_deref())
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn session_chat_session_delete(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    chat::delete_conversation(store.pool(), &id)
        .await
        .map_err(str_err)
}

/// Load just the messages for a specific conversation. Used after switching
/// active session so we don't refetch every conversation's history.
#[tauri::command]
pub async fn session_chat_messages_load(
    store: State<'_, SessionStore>,
    conversation_id: String,
) -> Result<Vec<ChatMessage>, String> {
    chat::list(store.pool(), &conversation_id)
        .await
        .map_err(str_err)
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
