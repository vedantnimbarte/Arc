//! Agent run lifecycle persistence.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{now_ms, Result};

/// A persisted agent run, as surfaced to the frontend Agents view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRun {
    pub id: String,
    pub workspace_id: Option<String>,
    pub agent_id: String,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub summary: Option<String>,
}

/// Most-recent runs first, capped at `limit`. Optionally scoped to a workspace.
pub async fn list(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
    limit: i64,
) -> Result<Vec<AgentRun>> {
    type Row = (String, Option<String>, String, String, i64, Option<i64>, Option<String>);
    let rows = if let Some(ws) = workspace_id {
        sqlx::query_as::<_, Row>(
            "SELECT id, workspace_id, agent_id, status, started_at, finished_at, summary \
             FROM agent_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?",
        )
        .bind(ws)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, Row>(
            "SELECT id, workspace_id, agent_id, status, started_at, finished_at, summary \
             FROM agent_runs ORDER BY started_at DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows
        .into_iter()
        .map(
            |(id, workspace_id, agent_id, status, started_at, finished_at, summary)| AgentRun {
                id,
                workspace_id,
                agent_id,
                status,
                started_at,
                finished_at,
                summary,
            },
        )
        .collect())
}

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
