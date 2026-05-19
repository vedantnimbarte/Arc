//! Tauri command surface for the memory subsystem (arc-session-manager).
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("memory_save",   { workspaceId?, kind?, title?, content, tags?, source? }) -> MemoryEntry
//!   invoke("memory_update", { id, title?, content?, tags? })                          -> ()
//!   invoke("memory_delete", { id })                                                   -> ()
//!   invoke("memory_get",    { id })                                                   -> MemoryEntry | null
//!   invoke("memory_list",   { workspaceId?, limit })                                  -> MemoryEntry[]
//!   invoke("memory_search", { workspaceId?, query, limit })                           -> MemoryHit[]
//!
//! `workspaceId` semantics:
//!   * omitted / null     → entries whose workspace_id is NULL (global)
//!   * "__all__"          → every entry, regardless of workspace
//!   * any other string   → filter to that workspace

use arc_ai_runtime::{embed as ai_embed, EmbedProvider};
use arc_session_manager::{memory, MemoryEntry, MemoryHit, SessionStore};
use serde::Serialize;
use tauri::State;

fn str_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn memory_save(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
    kind: Option<String>,
    title: Option<String>,
    content: String,
    tags: Option<String>,
    source: Option<String>,
) -> Result<MemoryEntry, String> {
    memory::save(
        store.pool(),
        workspace_id.as_deref(),
        kind.as_deref(),
        title.as_deref(),
        &content,
        tags.as_deref(),
        source.as_deref(),
    )
    .await
    .map_err(str_err)
}

#[tauri::command]
pub async fn memory_update(
    store: State<'_, SessionStore>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    tags: Option<String>,
) -> Result<(), String> {
    memory::update(
        store.pool(),
        &id,
        title.as_deref(),
        content.as_deref(),
        tags.as_deref(),
    )
    .await
    .map_err(str_err)
}

#[tauri::command]
pub async fn memory_delete(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    memory::delete(store.pool(), &id).await.map_err(str_err)
}

#[tauri::command]
pub async fn memory_get(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Option<MemoryEntry>, String> {
    memory::get(store.pool(), &id).await.map_err(str_err)
}

#[tauri::command]
pub async fn memory_list(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
    limit: i64,
) -> Result<Vec<MemoryEntry>, String> {
    memory::list(store.pool(), workspace_id.as_deref(), limit)
        .await
        .map_err(str_err)
}

#[tauri::command]
pub async fn memory_search(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
    query: String,
    limit: i64,
) -> Result<Vec<MemoryHit>, String> {
    memory::search(store.pool(), workspace_id.as_deref(), &query, limit)
        .await
        .map_err(str_err)
}

// ─── Vector search (V1) ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct VectorHit {
    pub entry: MemoryEntry,
    /// Cosine similarity in [-1, 1]; higher = more relevant.
    pub similarity: f32,
}

/// Compute an embedding for `text` via the named provider, and attach it
/// to an existing memory entry. The provider must be `openai` or `ollama`;
/// Anthropic has no first-party embeddings API.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn memory_embed_entry(
    store: State<'_, SessionStore>,
    id: String,
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
    text: String,
) -> Result<(), String> {
    let provider = EmbedProvider::from_id(&provider)
        .ok_or_else(|| format!("unsupported embed provider: {provider}"))?;
    let result = ai_embed(provider, &model, &text, api_key.as_deref(), base_url.as_deref())
        .await
        .map_err(str_err)?;
    memory::set_embedding(store.pool(), &id, &result.model, &result.vector)
        .await
        .map_err(str_err)
}

/// Vector search: embed `query` with the same provider/model used for
/// existing entries, then rank by cosine similarity. Returns up to `limit`
/// hits sorted by descending similarity.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn memory_vector_search(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
    provider: String,
    model: String,
    api_key: Option<String>,
    base_url: Option<String>,
    query: String,
    limit: i64,
) -> Result<Vec<VectorHit>, String> {
    let provider = EmbedProvider::from_id(&provider)
        .ok_or_else(|| format!("unsupported embed provider: {provider}"))?;
    let result = ai_embed(
        provider,
        &model,
        &query,
        api_key.as_deref(),
        base_url.as_deref(),
    )
    .await
    .map_err(str_err)?;
    let hits = memory::vector_search(
        store.pool(),
        workspace_id.as_deref(),
        &result.model,
        &result.vector,
        limit,
    )
    .await
    .map_err(str_err)?;
    Ok(hits
        .into_iter()
        .map(|(entry, similarity)| VectorHit { entry, similarity })
        .collect())
}
