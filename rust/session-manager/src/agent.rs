//! Agent run lifecycle persistence.

use sqlx::SqlitePool;

use crate::{now_ms, Result};

/// Insert a fresh "running" row. The caller is expected to follow up with
/// [`finish`] when the run terminates.
pub async fn start(
    pool: &SqlitePool,
    id: &str,
    workspace_id: Option<&str>,
    agent_id: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO agent_runs (id, workspace_id, agent_id, status, started_at, summary) \
         VALUES (?, ?, ?, 'running', ?, NULL)",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(agent_id)
    .bind(now_ms())
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark an existing row as completed/failed with an optional summary.
pub async fn finish(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    summary: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE agent_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?")
        .bind(status)
        .bind(now_ms())
        .bind(summary)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
