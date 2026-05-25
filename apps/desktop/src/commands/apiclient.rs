//! Tauri command surface for the API Client tab's persistence — collections,
//! saved requests, history, and environments. Mirrors the `memory_*` /
//! `session_*` style.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("apiclient_list_collections", { sessionId })                    -> Collection[]
//!   invoke("apiclient_upsert_collection", { sessionId, id?, parentId?, name, position }) -> Collection
//!   invoke("apiclient_delete_collection", { id })                          -> ()
//!   invoke("apiclient_list_requests",     { sessionId })                   -> SavedRequest[]
//!   invoke("apiclient_upsert_request",    { sessionId, input })            -> SavedRequest
//!   invoke("apiclient_delete_request",    { id })                          -> ()
//!   invoke("apiclient_append_history",    { sessionId, input })            -> HistoryEntry
//!   invoke("apiclient_history",           { sessionId, limit })            -> HistoryEntry[]
//!   invoke("apiclient_clear_history",     { sessionId })                   -> ()
//!   invoke("apiclient_envs_list",         { sessionId })                   -> Environment[]
//!   invoke("apiclient_envs_upsert",       { sessionId, id?, name, varsJson }) -> Environment
//!   invoke("apiclient_envs_delete",       { id })                          -> ()
//!   invoke("apiclient_envs_set_active",   { sessionId, id? })              -> ()

use arc_session_manager::{
    apiclient::{
        self, Collection, Environment, HistoryEntry, HistoryInput, SavedRequest,
        SavedRequestInput,
    },
    SessionStore,
};
use tauri::State;

fn str_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ─── Collections ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn apiclient_list_collections(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Vec<Collection>, String> {
    apiclient::list_collections(store.pool(), &session_id)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_upsert_collection(
    store: State<'_, SessionStore>,
    session_id: String,
    id: Option<String>,
    parent_id: Option<String>,
    name: String,
    position: i64,
) -> Result<Collection, String> {
    apiclient::upsert_collection(
        store.pool(),
        &session_id,
        id.as_deref(),
        parent_id.as_deref(),
        &name,
        position,
    )
    .await
    .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_delete_collection(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    apiclient::delete_collection(store.pool(), &id)
        .await
        .map_err(str_err)
}

// ─── Saved requests ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn apiclient_list_requests(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Vec<SavedRequest>, String> {
    apiclient::list_requests(store.pool(), &session_id)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_upsert_request(
    store: State<'_, SessionStore>,
    session_id: String,
    input: SavedRequestInput,
) -> Result<SavedRequest, String> {
    apiclient::upsert_request(store.pool(), &session_id, input)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_delete_request(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    apiclient::delete_request(store.pool(), &id)
        .await
        .map_err(str_err)
}

// ─── History ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn apiclient_append_history(
    store: State<'_, SessionStore>,
    session_id: String,
    input: HistoryInput,
) -> Result<HistoryEntry, String> {
    apiclient::append_history(store.pool(), &session_id, input)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_history(
    store: State<'_, SessionStore>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
    apiclient::list_history(store.pool(), &session_id, limit.unwrap_or(100))
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_clear_history(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<(), String> {
    apiclient::clear_history(store.pool(), &session_id)
        .await
        .map_err(str_err)
}

// ─── Environments ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn apiclient_envs_list(
    store: State<'_, SessionStore>,
    session_id: String,
) -> Result<Vec<Environment>, String> {
    apiclient::list_environments(store.pool(), &session_id)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_envs_upsert(
    store: State<'_, SessionStore>,
    session_id: String,
    id: Option<String>,
    name: String,
    vars_json: String,
) -> Result<Environment, String> {
    apiclient::upsert_environment(store.pool(), &session_id, id.as_deref(), &name, &vars_json)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_envs_delete(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    apiclient::delete_environment(store.pool(), &id)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn apiclient_envs_set_active(
    store: State<'_, SessionStore>,
    session_id: String,
    id: Option<String>,
) -> Result<(), String> {
    apiclient::set_active_environment(store.pool(), &session_id, id.as_deref())
        .await
        .map_err(str_err)
}
