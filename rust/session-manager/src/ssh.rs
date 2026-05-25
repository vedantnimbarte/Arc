//! SSH hosts, keys, and per-session connection logs.
//!
//! All key *material* (private keys, passphrases) lives outside this DB —
//! private keys on disk, passphrases in the OS credential vault. Here we
//! only track metadata (path, fingerprint, kind) so the UI can list and
//! reference them.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshKey {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub fingerprint: String,
    pub has_passphrase: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHost {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub identity_id: Option<String>,
    pub keepalive_secs: i64,
    pub startup_cmd: Option<String>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshSessionLogEntry {
    pub id: i64,
    pub host_id: String,
    pub session_uuid: String,
    pub at: i64,
    pub level: String,
    pub msg: String,
}

/// Frontend → backend payload when adding or updating a host. `id` is
/// optional: when omitted a new UUID is minted.
#[derive(Debug, Clone, Deserialize)]
pub struct SshHostInput {
    #[serde(default)]
    pub id: Option<String>,
    pub workspace_id: Option<String>,
    pub name: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: i64,
    pub username: String,
    pub identity_id: Option<String>,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: i64,
    pub startup_cmd: Option<String>,
}

fn default_port() -> i64 {
    22
}

fn default_keepalive() -> i64 {
    30
}

// ---------- ssh_keys -------------------------------------------------------

pub async fn key_list(pool: &SqlitePool) -> Result<Vec<SshKey>> {
    let rows = sqlx::query_as::<_, (String, String, String, String, String, i64, i64)>(
        "SELECT id, name, path, kind, fingerprint, has_passphrase, created_at \
         FROM ssh_keys ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, path, kind, fingerprint, has_passphrase, created_at)| SshKey {
            id,
            name,
            path,
            kind,
            fingerprint,
            has_passphrase: has_passphrase != 0,
            created_at,
        })
        .collect())
}

pub async fn key_get(pool: &SqlitePool, id: &str) -> Result<Option<SshKey>> {
    let row = sqlx::query_as::<_, (String, String, String, String, String, i64, i64)>(
        "SELECT id, name, path, kind, fingerprint, has_passphrase, created_at \
         FROM ssh_keys WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(id, name, path, kind, fingerprint, has_passphrase, created_at)| SshKey {
            id,
            name,
            path,
            kind,
            fingerprint,
            has_passphrase: has_passphrase != 0,
            created_at,
        },
    ))
}

pub async fn key_insert(
    pool: &SqlitePool,
    name: &str,
    path: &str,
    kind: &str,
    fingerprint: &str,
    has_passphrase: bool,
) -> Result<SshKey> {
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO ssh_keys (id, name, path, kind, fingerprint, has_passphrase, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(path)
    .bind(kind)
    .bind(fingerprint)
    .bind(if has_passphrase { 1 } else { 0 })
    .bind(now)
    .execute(pool)
    .await?;
    Ok(SshKey {
        id,
        name: name.to_string(),
        path: path.to_string(),
        kind: kind.to_string(),
        fingerprint: fingerprint.to_string(),
        has_passphrase,
        created_at: now,
    })
}

pub async fn key_delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM ssh_keys WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------- ssh_hosts ------------------------------------------------------

pub async fn host_list(pool: &SqlitePool, workspace_id: Option<&str>) -> Result<Vec<SshHost>> {
    let rows = if let Some(ws) = workspace_id {
        sqlx::query_as::<
            _,
            (
                String,
                Option<String>,
                String,
                String,
                i64,
                String,
                Option<String>,
                i64,
                Option<String>,
                i64,
                Option<i64>,
            ),
        >(
            "SELECT id, workspace_id, name, host, port, username, identity_id, keepalive_secs, startup_cmd, created_at, last_used_at \
             FROM ssh_hosts WHERE workspace_id = ? OR workspace_id IS NULL \
             ORDER BY COALESCE(last_used_at, created_at) DESC",
        )
        .bind(ws)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<
            _,
            (
                String,
                Option<String>,
                String,
                String,
                i64,
                String,
                Option<String>,
                i64,
                Option<String>,
                i64,
                Option<i64>,
            ),
        >(
            "SELECT id, workspace_id, name, host, port, username, identity_id, keepalive_secs, startup_cmd, created_at, last_used_at \
             FROM ssh_hosts ORDER BY COALESCE(last_used_at, created_at) DESC",
        )
        .fetch_all(pool)
        .await?
    };

    Ok(rows
        .into_iter()
        .map(|t| SshHost {
            id: t.0,
            workspace_id: t.1,
            name: t.2,
            host: t.3,
            port: t.4,
            username: t.5,
            identity_id: t.6,
            keepalive_secs: t.7,
            startup_cmd: t.8,
            created_at: t.9,
            last_used_at: t.10,
        })
        .collect())
}

pub async fn host_upsert(pool: &SqlitePool, input: SshHostInput) -> Result<SshHost> {
    let now = now_ms();
    if let Some(id) = input.id {
        sqlx::query(
            "UPDATE ssh_hosts SET workspace_id = ?, name = ?, host = ?, port = ?, username = ?, \
                                  identity_id = ?, keepalive_secs = ?, startup_cmd = ? \
             WHERE id = ?",
        )
        .bind(&input.workspace_id)
        .bind(&input.name)
        .bind(&input.host)
        .bind(input.port)
        .bind(&input.username)
        .bind(&input.identity_id)
        .bind(input.keepalive_secs)
        .bind(&input.startup_cmd)
        .bind(&id)
        .execute(pool)
        .await?;

        if let Some(h) = host_get(pool, &id).await? {
            return Ok(h);
        }
    }

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO ssh_hosts (id, workspace_id, name, host, port, username, identity_id, \
                                keepalive_secs, startup_cmd, created_at, last_used_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(&id)
    .bind(&input.workspace_id)
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.identity_id)
    .bind(input.keepalive_secs)
    .bind(&input.startup_cmd)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(SshHost {
        id,
        workspace_id: input.workspace_id,
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username,
        identity_id: input.identity_id,
        keepalive_secs: input.keepalive_secs,
        startup_cmd: input.startup_cmd,
        created_at: now,
        last_used_at: None,
    })
}

pub async fn host_get(pool: &SqlitePool, id: &str) -> Result<Option<SshHost>> {
    let row = sqlx::query_as::<
        _,
        (
            String,
            Option<String>,
            String,
            String,
            i64,
            String,
            Option<String>,
            i64,
            Option<String>,
            i64,
            Option<i64>,
        ),
    >(
        "SELECT id, workspace_id, name, host, port, username, identity_id, keepalive_secs, startup_cmd, created_at, last_used_at \
         FROM ssh_hosts WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|t| SshHost {
        id: t.0,
        workspace_id: t.1,
        name: t.2,
        host: t.3,
        port: t.4,
        username: t.5,
        identity_id: t.6,
        keepalive_secs: t.7,
        startup_cmd: t.8,
        created_at: t.9,
        last_used_at: t.10,
    }))
}

pub async fn host_delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM ssh_hosts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn host_touch(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("UPDATE ssh_hosts SET last_used_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------- ssh_session_logs ----------------------------------------------

pub async fn log_append(
    pool: &SqlitePool,
    host_id: &str,
    session_uuid: &str,
    at: i64,
    level: &str,
    msg: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO ssh_session_logs (host_id, session_uuid, at, level, msg) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(host_id)
    .bind(session_uuid)
    .bind(at)
    .bind(level)
    .bind(msg)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn log_load_recent(
    pool: &SqlitePool,
    host_id: &str,
    limit: i64,
) -> Result<Vec<SshSessionLogEntry>> {
    let rows = sqlx::query_as::<_, (i64, String, String, i64, String, String)>(
        "SELECT id, host_id, session_uuid, at, level, msg FROM ssh_session_logs \
         WHERE host_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(host_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut out: Vec<SshSessionLogEntry> = rows
        .into_iter()
        .map(|(id, host_id, session_uuid, at, level, msg)| SshSessionLogEntry {
            id,
            host_id,
            session_uuid,
            at,
            level,
            msg,
        })
        .collect();
    out.reverse(); // newest-last for natural read order
    Ok(out)
}
