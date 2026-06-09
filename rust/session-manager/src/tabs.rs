//! Sessions and the tabs that belong to them.
//!
//! V0 uses a single most-recent session that owns all open tabs. When ARC
//! grows multi-window support, additional sessions will join it.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TabKind {
    Terminal,
    Editor,
    Preview,
    Apiclient,
    Ssh,
    Diff,
}

impl TabKind {
    fn as_str(self) -> &'static str {
        match self {
            TabKind::Terminal => "terminal",
            TabKind::Editor => "editor",
            TabKind::Preview => "preview",
            TabKind::Apiclient => "apiclient",
            TabKind::Ssh => "ssh",
            TabKind::Diff => "diff",
        }
    }

    fn parse(s: &str) -> TabKind {
        match s {
            "editor" => TabKind::Editor,
            "preview" => TabKind::Preview,
            "apiclient" => TabKind::Apiclient,
            "ssh" => TabKind::Ssh,
            "diff" => TabKind::Diff,
            // Anything else (including stray data) defaults to terminal —
            // the schema CHECK prevents storage of other values, so this
            // branch only runs if the DB has been hand-edited.
            _ => TabKind::Terminal,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub kind: TabKind,
    pub file_path: Option<String>,
    pub preview_url: Option<String>,
    /// Per-tab opaque JSON blob for API Client tabs — sub-tab list, drafts,
    /// left-rail collapsed flag, etc. Owned by the frontend; the Rust layer
    /// only stores and round-trips it.
    pub apiclient_state_json: Option<String>,
    pub position: i64,
}

/// Frontend → backend: what the renderer sends when it wants tabs persisted.
/// Position is implicit (the order of the slice).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabInput {
    pub id: String,
    pub title: String,
    pub kind: TabKind,
    pub file_path: Option<String>,
    #[serde(default)]
    pub preview_url: Option<String>,
    #[serde(default)]
    pub apiclient_state_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub workspace_id: Option<String>,
    pub active_tab_id: Option<String>,
    pub created_at: i64,
    pub last_active_at: i64,
    /// Serialized pane-layout tree describing how this session's tabs are
    /// arranged into splits. JSON blob — see `migrations/0006_pane_layout.sql`
    /// for the shape. `None` means "single-leaf layout containing all tabs"
    /// and the frontend will synthesize one on hydrate.
    pub pane_layout: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session: Session,
    pub tabs: Vec<Tab>,
}

/// Fetch the most-recent session (creating one if the DB is empty) and its
/// tabs. The frontend calls this on launch to rehydrate the workspace.
pub async fn current_or_create(pool: &SqlitePool) -> Result<SessionState> {
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>, i64, i64, Option<String>)>(
        "SELECT id, workspace_id, active_tab_id, created_at, last_active_at, pane_layout \
         FROM sessions ORDER BY last_active_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    let session = match row {
        Some((id, workspace_id, active_tab_id, created_at, last_active_at, pane_layout)) => Session {
            id,
            workspace_id,
            active_tab_id,
            created_at,
            last_active_at,
            pane_layout,
        },
        None => {
            let now = now_ms();
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO sessions (id, workspace_id, active_tab_id, created_at, last_active_at) \
                 VALUES (?, NULL, NULL, ?, ?)",
            )
            .bind(&id)
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
            Session {
                id,
                workspace_id: None,
                active_tab_id: None,
                created_at: now,
                last_active_at: now,
                pane_layout: None,
            }
        }
    };

    let tab_rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, Option<String>, Option<String>, i64)>(
        "SELECT id, session_id, title, kind, file_path, preview_url, apiclient_state_json, position \
         FROM tabs WHERE session_id = ? ORDER BY position ASC",
    )
    .bind(&session.id)
    .fetch_all(pool)
    .await?;

    let tabs = tab_rows
        .into_iter()
        .map(|(id, session_id, title, kind, file_path, preview_url, apiclient_state_json, position)| Tab {
            id,
            session_id,
            title,
            kind: TabKind::parse(&kind),
            file_path,
            preview_url,
            apiclient_state_json,
            position,
        })
        .collect();

    Ok(SessionState { session, tabs })
}

/// Replace all tabs for `session_id` with `inputs` (in order) and update the
/// active tab. This is a single transaction — if anything fails the prior
/// state is preserved.
///
/// "Replace all" is intentionally coarse: tabs change rarely enough that
/// per-row diffing isn't worth the complexity, and the position ordering
/// stays trivially consistent.
pub async fn save_tabs(
    pool: &SqlitePool,
    session_id: &str,
    inputs: &[TabInput],
    active_tab_id: Option<&str>,
    pane_layout: Option<&str>,
) -> Result<()> {
    let now = now_ms();
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM tabs WHERE session_id = ?")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;

    for (idx, t) in inputs.iter().enumerate() {
        sqlx::query(
            "INSERT INTO tabs (id, session_id, title, kind, file_path, preview_url, apiclient_state_json, position, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&t.id)
        .bind(session_id)
        .bind(&t.title)
        .bind(t.kind.as_str())
        .bind(&t.file_path)
        .bind(&t.preview_url)
        .bind(&t.apiclient_state_json)
        .bind(idx as i64)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    // Persist the pane-layout JSON alongside the active-tab pointer so a
    // single write keeps tabs + layout coherent. NULL passes through to
    // mean "no layout known" — the next hydrate will synthesize one.
    sqlx::query(
        "UPDATE sessions SET active_tab_id = ?, last_active_at = ?, pane_layout = ? WHERE id = ?",
    )
    .bind(active_tab_id)
    .bind(now)
    .bind(pane_layout)
    .bind(session_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub async fn set_workspace(
    pool: &SqlitePool,
    session_id: &str,
    workspace_id: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE sessions SET workspace_id = ?, last_active_at = ? WHERE id = ?")
        .bind(workspace_id)
        .bind(now_ms())
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}
