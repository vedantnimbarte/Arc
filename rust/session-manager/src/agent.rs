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
    /// Filesystem path of the isolated worktree this run executed in, or NULL
    /// for an in-place run.
    pub worktree_path: Option<String>,
    /// Throwaway branch the worktree was created on, or NULL.
    pub worktree_branch: Option<String>,
}

type Row = (
    String,
    Option<String>,
    String,
    String,
    i64,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
);

const SELECT_COLS: &str = "id, workspace_id, agent_id, status, started_at, finished_at, summary, \
     worktree_path, worktree_branch";

fn row_to_run(row: Row) -> AgentRun {
    let (
        id,
        workspace_id,
        agent_id,
        status,
        started_at,
        finished_at,
        summary,
        worktree_path,
        worktree_branch,
    ) = row;
    AgentRun {
        id,
        workspace_id,
        agent_id,
        status,
        started_at,
        finished_at,
        summary,
        worktree_path,
        worktree_branch,
    }
}

/// Most-recent runs first, capped at `limit`. Optionally scoped to a workspace.
pub async fn list(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
    limit: i64,
) -> Result<Vec<AgentRun>> {
    let rows = if let Some(ws) = workspace_id {
        sqlx::query_as::<_, Row>(&format!(
            "SELECT {SELECT_COLS} FROM agent_runs WHERE workspace_id = ? \
             ORDER BY started_at DESC LIMIT ?"
        ))
        .bind(ws)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, Row>(&format!(
            "SELECT {SELECT_COLS} FROM agent_runs ORDER BY started_at DESC LIMIT ?"
        ))
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows.into_iter().map(row_to_run).collect())
}

/// Fetch a single run by id, or `None` if it doesn't exist.
pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<AgentRun>> {
    let row = sqlx::query_as::<_, Row>(&format!(
        "SELECT {SELECT_COLS} FROM agent_runs WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(row_to_run))
}

/// Insert a fresh "running" row. The caller is expected to follow up with
/// [`finish`] when the run terminates. `worktree_path` / `worktree_branch` are
/// set for isolated runs and NULL otherwise.
pub async fn start(
    pool: &SqlitePool,
    id: &str,
    workspace_id: Option<&str>,
    agent_id: &str,
    worktree_path: Option<&str>,
    worktree_branch: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO agent_runs \
         (id, workspace_id, agent_id, status, started_at, summary, worktree_path, worktree_branch) \
         VALUES (?, ?, ?, 'running', ?, NULL, ?, ?)",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(agent_id)
    .bind(now_ms())
    .bind(worktree_path)
    .bind(worktree_branch)
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
