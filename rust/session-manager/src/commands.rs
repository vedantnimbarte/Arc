//! Command history — every line the user runs at the shell. V0 captured
//! only the input side (command text + cwd + timestamps). V1 also
//! finalizes the row when the shell emits an OSC 133 `D[;<exit>]`
//! sequence, filling in `finished_at`, `exit_code`, and an
//! `output_excerpt` snapshot.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRecord {
    pub id: i64,
    pub session_id: Option<String>,
    pub tab_id: Option<String>,
    pub workspace_id: Option<String>,
    pub cwd: Option<String>,
    pub command: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub exit_code: Option<i64>,
}

/// Finalize a previously-appended command: record exit code, the time it
/// finished, and a short output excerpt. Idempotent — calling twice with
/// the same id overwrites the prior values.
pub async fn finish(
    pool: &SqlitePool,
    id: i64,
    exit_code: Option<i64>,
    output_excerpt: Option<&str>,
) -> Result<()> {
    let now = now_ms();
    // Cap excerpt to 4 KiB so the SQLite row stays small. The full
    // output never leaves the terminal — the excerpt is a recall aid.
    const EXCERPT_CAP: usize = 4 * 1024;
    let excerpt: Option<String> = output_excerpt.map(|s| {
        if s.len() <= EXCERPT_CAP {
            s.to_string()
        } else {
            let mut cut = EXCERPT_CAP;
            while !s.is_char_boundary(cut) && cut > 0 {
                cut -= 1;
            }
            format!("{}\n…", &s[..cut])
        }
    });
    sqlx::query(
        "UPDATE command_history \
         SET finished_at = ?, exit_code = ?, output_excerpt = ? \
         WHERE id = ?",
    )
    .bind(now)
    .bind(exit_code)
    .bind(excerpt)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Append a captured command. Returns the assigned row id.
pub async fn append(
    pool: &SqlitePool,
    session_id: Option<&str>,
    tab_id: Option<&str>,
    workspace_id: Option<&str>,
    cwd: Option<&str>,
    command: &str,
) -> Result<i64> {
    let now = now_ms();
    let result = sqlx::query(
        "INSERT INTO command_history \
             (session_id, tab_id, workspace_id, cwd, command, started_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(tab_id)
    .bind(workspace_id)
    .bind(cwd)
    .bind(command)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(result.last_insert_rowid())
}

/// Most-recent commands first, optionally filtered by a substring. Empty
/// query returns all (subject to limit).
pub async fn recent(pool: &SqlitePool, limit: i64, query: Option<&str>) -> Result<Vec<CommandRecord>> {
    let limit = limit.clamp(1, 500);
    let rows = if let Some(q) = query.filter(|q| !q.is_empty()) {
        let like = format!("%{q}%");
        sqlx::query_as::<
            _,
            (i64, Option<String>, Option<String>, Option<String>, Option<String>, String, i64, Option<i64>, Option<i64>),
        >(
            "SELECT id, session_id, tab_id, workspace_id, cwd, command, started_at, finished_at, exit_code \
             FROM command_history \
             WHERE command LIKE ? \
             ORDER BY started_at DESC, id DESC LIMIT ?",
        )
        .bind(like)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<
            _,
            (i64, Option<String>, Option<String>, Option<String>, Option<String>, String, i64, Option<i64>, Option<i64>),
        >(
            "SELECT id, session_id, tab_id, workspace_id, cwd, command, started_at, finished_at, exit_code \
             FROM command_history \
             ORDER BY started_at DESC, id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(pool)
        .await?
    };

    Ok(rows
        .into_iter()
        .map(
            |(id, session_id, tab_id, workspace_id, cwd, command, started_at, finished_at, exit_code)| {
                CommandRecord {
                    id,
                    session_id,
                    tab_id,
                    workspace_id,
                    cwd,
                    command,
                    started_at,
                    finished_at,
                    exit_code,
                }
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionStore;

    async fn fresh_store() -> SessionStore {
        let path = std::env::temp_dir().join(format!("arc-test-cmd-{}.db", uuid::Uuid::new_v4()));
        SessionStore::open_at(&path).await.expect("open store")
    }

    #[tokio::test]
    async fn append_and_recent_roundtrip() {
        let store = fresh_store().await;
        append(store.pool(), None, None, None, Some("/tmp"), "ls -la")
            .await
            .expect("append");
        append(store.pool(), None, None, None, Some("/tmp"), "cd src")
            .await
            .expect("append");
        append(store.pool(), None, None, None, Some("/tmp/src"), "git status")
            .await
            .expect("append");

        let all = recent(store.pool(), 50, None).await.expect("recent");
        assert_eq!(all.len(), 3);
        // Most recent first.
        assert_eq!(all[0].command, "git status");
        assert_eq!(all[2].command, "ls -la");

        let filtered = recent(store.pool(), 50, Some("git")).await.expect("recent");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].command, "git status");
    }
}
