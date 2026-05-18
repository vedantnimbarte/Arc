//! Workspaces — folders the user has opened in ARC.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root: String,
    pub created_at: i64,
    pub last_opened_at: i64,
}

/// All workspaces, most-recently-opened first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Workspace>> {
    let rows = sqlx::query_as::<_, (String, String, String, i64, i64)>(
        "SELECT id, name, root, created_at, last_opened_at \
         FROM workspaces ORDER BY last_opened_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, root, created_at, last_opened_at)| Workspace {
            id,
            name,
            root,
            created_at,
            last_opened_at,
        })
        .collect())
}

/// Upsert by `root`. If a workspace with the same root exists, bump its
/// `last_opened_at` and return it; otherwise insert a fresh row.
pub async fn upsert(pool: &SqlitePool, name: &str, root: &str) -> Result<Workspace> {
    let now = now_ms();

    if let Some(existing) = sqlx::query_as::<_, (String, String, String, i64, i64)>(
        "SELECT id, name, root, created_at, last_opened_at FROM workspaces WHERE root = ?",
    )
    .bind(root)
    .fetch_optional(pool)
    .await?
    {
        sqlx::query("UPDATE workspaces SET last_opened_at = ? WHERE id = ?")
            .bind(now)
            .bind(&existing.0)
            .execute(pool)
            .await?;
        return Ok(Workspace {
            id: existing.0,
            name: existing.1,
            root: existing.2,
            created_at: existing.3,
            last_opened_at: now,
        });
    }

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO workspaces (id, name, root, created_at, last_opened_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(root)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(Workspace {
        id,
        name: name.to_string(),
        root: root.to_string(),
        created_at: now,
        last_opened_at: now,
    })
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
