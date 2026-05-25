//! Persistence for the built-in API Client tab — collections (folder tree
//! of saved requests), saved requests, executed-request history, and
//! environment variable sets.
//!
//! The Rust side stores opaque JSON blobs for params/headers/body/auth and
//! environment vars — the frontend owns the schema there. Everything is
//! scoped to a session id so a workspace switch hides another workspace's
//! collections / history / envs.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

/// History rows over this count get trimmed (oldest first) after each insert.
pub const HISTORY_CAP_PER_SESSION: i64 = 500;
/// Max bytes of response body we stash in the history excerpt.
pub const HISTORY_EXCERPT_BYTES: usize = 4096;

// ─── Collections ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: String,
    pub session_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub position: i64,
    pub created_at: i64,
}

pub async fn list_collections(pool: &SqlitePool, session_id: &str) -> Result<Vec<Collection>> {
    let rows = sqlx::query_as::<_, (String, String, Option<String>, String, i64, i64)>(
        "SELECT id, session_id, parent_id, name, position, created_at \
         FROM api_collections WHERE session_id = ? \
         ORDER BY position ASC, created_at ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, session_id, parent_id, name, position, created_at)| Collection {
            id,
            session_id,
            parent_id,
            name,
            position,
            created_at,
        })
        .collect())
}

pub async fn upsert_collection(
    pool: &SqlitePool,
    session_id: &str,
    id: Option<&str>,
    parent_id: Option<&str>,
    name: &str,
    position: i64,
) -> Result<Collection> {
    let now = now_ms();
    match id {
        Some(existing) => {
            sqlx::query(
                "UPDATE api_collections SET parent_id = ?, name = ?, position = ? WHERE id = ?",
            )
            .bind(parent_id)
            .bind(name)
            .bind(position)
            .bind(existing)
            .execute(pool)
            .await?;
            Ok(Collection {
                id: existing.to_string(),
                session_id: session_id.to_string(),
                parent_id: parent_id.map(str::to_string),
                name: name.to_string(),
                position,
                created_at: now,
            })
        }
        None => {
            let new_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO api_collections (id, session_id, parent_id, name, position, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&new_id)
            .bind(session_id)
            .bind(parent_id)
            .bind(name)
            .bind(position)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(Collection {
                id: new_id,
                session_id: session_id.to_string(),
                parent_id: parent_id.map(str::to_string),
                name: name.to_string(),
                position,
                created_at: now,
            })
        }
    }
}

pub async fn delete_collection(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM api_collections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── Saved requests ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedRequest {
    pub id: String,
    pub session_id: String,
    pub collection_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
    pub params_json: Option<String>,
    pub headers_json: Option<String>,
    pub body_json: Option<String>,
    pub auth_json: Option<String>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedRequestInput {
    pub id: Option<String>,
    pub collection_id: Option<String>,
    pub name: String,
    pub method: String,
    pub url: String,
    pub params_json: Option<String>,
    pub headers_json: Option<String>,
    pub body_json: Option<String>,
    pub auth_json: Option<String>,
    #[serde(default)]
    pub position: i64,
}

pub async fn list_requests(pool: &SqlitePool, session_id: &str) -> Result<Vec<SavedRequest>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            i64,
            i64,
            i64,
        ),
    >(
        "SELECT id, session_id, collection_id, name, method, url, \
                params_json, headers_json, body_json, auth_json, \
                position, created_at, updated_at \
         FROM api_requests WHERE session_id = ? \
         ORDER BY collection_id ASC, position ASC, created_at ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| SavedRequest {
            id: r.0,
            session_id: r.1,
            collection_id: r.2,
            name: r.3,
            method: r.4,
            url: r.5,
            params_json: r.6,
            headers_json: r.7,
            body_json: r.8,
            auth_json: r.9,
            position: r.10,
            created_at: r.11,
            updated_at: r.12,
        })
        .collect())
}

pub async fn upsert_request(
    pool: &SqlitePool,
    session_id: &str,
    input: SavedRequestInput,
) -> Result<SavedRequest> {
    let now = now_ms();
    match input.id.clone() {
        Some(existing) => {
            sqlx::query(
                "UPDATE api_requests SET collection_id = ?, name = ?, method = ?, url = ?, \
                     params_json = ?, headers_json = ?, body_json = ?, auth_json = ?, \
                     position = ?, updated_at = ? WHERE id = ?",
            )
            .bind(&input.collection_id)
            .bind(&input.name)
            .bind(&input.method)
            .bind(&input.url)
            .bind(&input.params_json)
            .bind(&input.headers_json)
            .bind(&input.body_json)
            .bind(&input.auth_json)
            .bind(input.position)
            .bind(now)
            .bind(&existing)
            .execute(pool)
            .await?;
            Ok(SavedRequest {
                id: existing,
                session_id: session_id.to_string(),
                collection_id: input.collection_id,
                name: input.name,
                method: input.method,
                url: input.url,
                params_json: input.params_json,
                headers_json: input.headers_json,
                body_json: input.body_json,
                auth_json: input.auth_json,
                position: input.position,
                created_at: now,
                updated_at: now,
            })
        }
        None => {
            let new_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO api_requests \
                     (id, session_id, collection_id, name, method, url, \
                      params_json, headers_json, body_json, auth_json, \
                      position, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&new_id)
            .bind(session_id)
            .bind(&input.collection_id)
            .bind(&input.name)
            .bind(&input.method)
            .bind(&input.url)
            .bind(&input.params_json)
            .bind(&input.headers_json)
            .bind(&input.body_json)
            .bind(&input.auth_json)
            .bind(input.position)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(SavedRequest {
                id: new_id,
                session_id: session_id.to_string(),
                collection_id: input.collection_id,
                name: input.name,
                method: input.method,
                url: input.url,
                params_json: input.params_json,
                headers_json: input.headers_json,
                body_json: input.body_json,
                auth_json: input.auth_json,
                position: input.position,
                created_at: now,
                updated_at: now,
            })
        }
    }
}

pub async fn delete_request(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM api_requests WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── History ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub session_id: String,
    pub method: String,
    pub url: String,
    pub request_snapshot_json: String,
    pub status: Option<i64>,
    pub time_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    pub response_excerpt: Option<String>,
    pub error: Option<String>,
    pub executed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryInput {
    pub method: String,
    pub url: String,
    pub request_snapshot_json: String,
    pub status: Option<i64>,
    pub time_ms: Option<i64>,
    pub size_bytes: Option<i64>,
    pub response_excerpt: Option<String>,
    pub error: Option<String>,
}

pub async fn append_history(
    pool: &SqlitePool,
    session_id: &str,
    input: HistoryInput,
) -> Result<HistoryEntry> {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();

    // Clip excerpt to HISTORY_EXCERPT_BYTES on a char boundary.
    let excerpt = input.response_excerpt.as_deref().map(|s| {
        if s.len() <= HISTORY_EXCERPT_BYTES {
            s.to_string()
        } else {
            let mut end = HISTORY_EXCERPT_BYTES;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s[..end].to_string()
        }
    });

    sqlx::query(
        "INSERT INTO api_history \
             (id, session_id, method, url, request_snapshot_json, status, time_ms, \
              size_bytes, response_excerpt, error, executed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(session_id)
    .bind(&input.method)
    .bind(&input.url)
    .bind(&input.request_snapshot_json)
    .bind(input.status)
    .bind(input.time_ms)
    .bind(input.size_bytes)
    .bind(&excerpt)
    .bind(&input.error)
    .bind(now)
    .execute(pool)
    .await?;

    // Trim oldest entries beyond the cap. Doing it inline keeps the table
    // small without needing a separate maintenance job.
    sqlx::query(
        "DELETE FROM api_history WHERE id IN ( \
             SELECT id FROM api_history WHERE session_id = ? \
             ORDER BY executed_at DESC LIMIT -1 OFFSET ? \
         )",
    )
    .bind(session_id)
    .bind(HISTORY_CAP_PER_SESSION)
    .execute(pool)
    .await?;

    Ok(HistoryEntry {
        id,
        session_id: session_id.to_string(),
        method: input.method,
        url: input.url,
        request_snapshot_json: input.request_snapshot_json,
        status: input.status,
        time_ms: input.time_ms,
        size_bytes: input.size_bytes,
        response_excerpt: excerpt,
        error: input.error,
        executed_at: now,
    })
}

pub async fn list_history(
    pool: &SqlitePool,
    session_id: &str,
    limit: i64,
) -> Result<Vec<HistoryEntry>> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            String,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, session_id, method, url, request_snapshot_json, status, time_ms, \
                size_bytes, response_excerpt, error, executed_at \
         FROM api_history WHERE session_id = ? \
         ORDER BY executed_at DESC LIMIT ?",
    )
    .bind(session_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| HistoryEntry {
            id: r.0,
            session_id: r.1,
            method: r.2,
            url: r.3,
            request_snapshot_json: r.4,
            status: r.5,
            time_ms: r.6,
            size_bytes: r.7,
            response_excerpt: r.8,
            error: r.9,
            executed_at: r.10,
        })
        .collect())
}

pub async fn clear_history(pool: &SqlitePool, session_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM api_history WHERE session_id = ?")
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── Environments ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Environment {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub vars_json: String,
    pub is_active: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn list_environments(pool: &SqlitePool, session_id: &str) -> Result<Vec<Environment>> {
    let rows = sqlx::query_as::<_, (String, String, String, String, i64, i64, i64)>(
        "SELECT id, session_id, name, vars_json, is_active, created_at, updated_at \
         FROM api_environments WHERE session_id = ? \
         ORDER BY name ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Environment {
            id: r.0,
            session_id: r.1,
            name: r.2,
            vars_json: r.3,
            is_active: r.4 != 0,
            created_at: r.5,
            updated_at: r.6,
        })
        .collect())
}

pub async fn upsert_environment(
    pool: &SqlitePool,
    session_id: &str,
    id: Option<&str>,
    name: &str,
    vars_json: &str,
) -> Result<Environment> {
    let now = now_ms();
    match id {
        Some(existing) => {
            sqlx::query(
                "UPDATE api_environments SET name = ?, vars_json = ?, updated_at = ? WHERE id = ?",
            )
            .bind(name)
            .bind(vars_json)
            .bind(now)
            .bind(existing)
            .execute(pool)
            .await?;
            Ok(Environment {
                id: existing.to_string(),
                session_id: session_id.to_string(),
                name: name.to_string(),
                vars_json: vars_json.to_string(),
                is_active: false, // is_active is managed separately
                created_at: now,
                updated_at: now,
            })
        }
        None => {
            let new_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO api_environments (id, session_id, name, vars_json, is_active, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, 0, ?, ?)",
            )
            .bind(&new_id)
            .bind(session_id)
            .bind(name)
            .bind(vars_json)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Ok(Environment {
                id: new_id,
                session_id: session_id.to_string(),
                name: name.to_string(),
                vars_json: vars_json.to_string(),
                is_active: false,
                created_at: now,
                updated_at: now,
            })
        }
    }
}

pub async fn delete_environment(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM api_environments WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Set a single environment as active for the session (deactivates all
/// others). Pass `id = None` to deactivate all environments.
pub async fn set_active_environment(
    pool: &SqlitePool,
    session_id: &str,
    id: Option<&str>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE api_environments SET is_active = 0 WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    if let Some(id) = id {
        sqlx::query(
            "UPDATE api_environments SET is_active = 1 WHERE id = ? AND session_id = ?",
        )
        .bind(id)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
