//! Saved database connections for the DB client tab.
//!
//! Metadata only. The password is stripped from the URL by the frontend and
//! stored in the OS credential vault instead — this table never sees it,
//! mirroring how [`crate::ssh`] keeps key passphrases out of the database.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConnection {
    pub id: String,
    pub name: String,
    pub backend: String,
    /// Connection URL with the password component removed.
    pub url: String,
    pub has_password: bool,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub ssh: Option<DbSsh>,
}

/// Reach the database through an SSH local forward. The URL's host and port
/// are then as seen from the SSH server. The key's passphrase, if any, lives
/// in the OS vault, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DbSsh {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
}

/// Frontend → backend payload. `id` absent means "create".
#[derive(Debug, Clone, Deserialize)]
pub struct DbConnectionInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub backend: String,
    pub url: String,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub ssh: Option<DbSsh>,
}

type Row = (
    String,
    String,
    String,
    String,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
);

fn hydrate(t: Row) -> DbConnection {
    let ssh = match (t.7, t.9, t.10) {
        (Some(host), Some(user), Some(key_path)) => Some(DbSsh {
            host,
            port: t.8 as u16,
            user,
            key_path,
        }),
        _ => None,
    };
    DbConnection {
        id: t.0,
        name: t.1,
        backend: t.2,
        url: t.3,
        has_password: t.4 != 0,
        created_at: t.5,
        last_used_at: t.6,
        ssh,
    }
}

const SELECT: &str = "SELECT id, name, backend, url, has_password, created_at, last_used_at, \
                      ssh_host, ssh_port, ssh_user, ssh_key_path \
                      FROM db_connections";

pub async fn list(pool: &SqlitePool) -> Result<Vec<DbConnection>> {
    let sql = format!("{SELECT} ORDER BY COALESCE(last_used_at, created_at) DESC");
    let rows = sqlx::query_as::<_, Row>(&sql).fetch_all(pool).await?;
    Ok(rows.into_iter().map(hydrate).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<DbConnection>> {
    let sql = format!("{SELECT} WHERE id = ?");
    let row = sqlx::query_as::<_, Row>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(hydrate))
}

pub async fn upsert(pool: &SqlitePool, input: DbConnectionInput) -> Result<DbConnection> {
    let ssh = input.ssh.as_ref();
    if let Some(id) = &input.id {
        sqlx::query(
            "UPDATE db_connections SET name = ?, backend = ?, url = ?, has_password = ?, \
             ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_key_path = ? WHERE id = ?",
        )
        .bind(&input.name)
        .bind(&input.backend)
        .bind(&input.url)
        .bind(i64::from(input.has_password))
        .bind(ssh.map(|s| &s.host))
        .bind(ssh.map_or(22, |s| i64::from(s.port)))
        .bind(ssh.map(|s| &s.user))
        .bind(ssh.map(|s| &s.key_path))
        .bind(id)
        .execute(pool)
        .await?;
        if let Some(c) = get(pool, id).await? {
            return Ok(c);
        }
    }

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO db_connections (id, name, backend, url, has_password, created_at, last_used_at, \
         ssh_host, ssh_port, ssh_user, ssh_key_path) \
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.backend)
    .bind(&input.url)
    .bind(i64::from(input.has_password))
    .bind(now_ms())
    .bind(ssh.map(|s| &s.host))
    .bind(ssh.map_or(22, |s| i64::from(s.port)))
    .bind(ssh.map(|s| &s.user))
    .bind(ssh.map(|s| &s.key_path))
    .execute(pool)
    .await?;

    Ok(get(pool, &id).await?.expect("row just inserted"))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM db_connections WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn touch(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("UPDATE db_connections SET last_used_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── Query history ────────────────────────────────────────────────────────

/// Most history rows kept per connection; `history_add` prunes the oldest.
pub const HISTORY_CAP: i64 = 500;

/// One statement run from the DB client's editor.
#[derive(Debug, Clone, Serialize)]
pub struct DbQueryHistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub sql: String,
    pub executed_at: i64,
    pub duration_ms: i64,
    /// Rows returned (or affected). `None` when the statement failed.
    pub row_count: Option<i64>,
    pub error: Option<String>,
}

type HistoryRow = (i64, String, String, i64, i64, Option<i64>, Option<String>);

pub async fn history_add(
    pool: &SqlitePool,
    connection_id: &str,
    sql: &str,
    duration_ms: i64,
    row_count: Option<i64>,
    error: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO db_query_history (connection_id, sql, executed_at, duration_ms, row_count, error) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(connection_id)
    .bind(sql)
    .bind(now_ms())
    .bind(duration_ms)
    .bind(row_count)
    .bind(error)
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM db_query_history WHERE connection_id = ? AND id NOT IN \
         (SELECT id FROM db_query_history WHERE connection_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(connection_id)
    .bind(connection_id)
    .bind(HISTORY_CAP)
    .execute(pool)
    .await?;
    Ok(())
}

/// Newest first. At most [`HISTORY_CAP`] rows, so the panel searches
/// client-side.
pub async fn history_list(pool: &SqlitePool, connection_id: &str) -> Result<Vec<DbQueryHistoryEntry>> {
    let rows = sqlx::query_as::<_, HistoryRow>(
        "SELECT id, connection_id, sql, executed_at, duration_ms, row_count, error \
         FROM db_query_history WHERE connection_id = ? ORDER BY id DESC",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|t| DbQueryHistoryEntry {
            id: t.0,
            connection_id: t.1,
            sql: t.2,
            executed_at: t.3,
            duration_ms: t.4,
            row_count: t.5,
            error: t.6,
        })
        .collect())
}

pub async fn history_delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM db_query_history WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn history_clear(pool: &SqlitePool, connection_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM db_query_history WHERE connection_id = ?")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── Saved queries ────────────────────────────────────────────────────────

/// A named query kept on a connection.
#[derive(Debug, Clone, Serialize)]
pub struct DbSavedQuery {
    pub id: String,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Frontend → backend payload. `id` absent means "create".
#[derive(Debug, Clone, Deserialize)]
pub struct DbSavedQueryInput {
    #[serde(default)]
    pub id: Option<String>,
    pub connection_id: String,
    pub name: String,
    pub sql: String,
}

type SavedRow = (String, String, String, String, i64, i64);

const SAVED_SELECT: &str =
    "SELECT id, connection_id, name, sql, created_at, updated_at FROM db_saved_queries";

fn hydrate_saved(t: SavedRow) -> DbSavedQuery {
    DbSavedQuery {
        id: t.0,
        connection_id: t.1,
        name: t.2,
        sql: t.3,
        created_at: t.4,
        updated_at: t.5,
    }
}

/// Alphabetical, case-insensitive.
pub async fn saved_list(pool: &SqlitePool, connection_id: &str) -> Result<Vec<DbSavedQuery>> {
    let sql = format!("{SAVED_SELECT} WHERE connection_id = ? ORDER BY name COLLATE NOCASE");
    let rows = sqlx::query_as::<_, SavedRow>(&sql)
        .bind(connection_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(hydrate_saved).collect())
}

pub async fn saved_upsert(pool: &SqlitePool, input: DbSavedQueryInput) -> Result<DbSavedQuery> {
    let now = now_ms();
    let id = match input.id {
        Some(id) => {
            sqlx::query("UPDATE db_saved_queries SET name = ?, sql = ?, updated_at = ? WHERE id = ?")
                .bind(&input.name)
                .bind(&input.sql)
                .bind(now)
                .bind(&id)
                .execute(pool)
                .await?;
            id
        }
        None => {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO db_saved_queries (id, connection_id, name, sql, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(&input.connection_id)
            .bind(&input.name)
            .bind(&input.sql)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            id
        }
    };
    let sql = format!("{SAVED_SELECT} WHERE id = ?");
    let row = sqlx::query_as::<_, SavedRow>(&sql).bind(&id).fetch_one(pool).await?;
    Ok(hydrate_saved(row))
}

pub async fn saved_delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM db_saved_queries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
