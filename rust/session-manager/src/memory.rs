//! Memory subsystem — workspace-scoped notes the user (or the agent on
//! their behalf) saves for later recall.
//!
//! V0 ships keyword search via SQLite FTS5 (`memory_fts`). The
//! `embedding` BLOB column on `memory_entries` is reserved for vector
//! search; once a provider is wired up we layer cosine similarity over
//! the same table without a schema change.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub workspace_id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub content: String,
    /// Comma-separated for V0. Whitespace around tokens is trimmed on read.
    pub tags: Option<String>,
    pub source: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemoryHit {
    pub entry: MemoryEntry,
    /// FTS5 bm25() score. Lower is better; we negate it client-side for
    /// display sort so the caller can ignore the sign convention.
    pub score: f64,
    /// Highlighted snippet from `content`. Matches wrapped in
    /// `[` … `]` so the UI can swap markers without parsing FTS internals.
    pub snippet: String,
}

/// Insert a new memory entry. Returns the persisted row.
pub async fn save(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
    kind: Option<&str>,
    title: Option<&str>,
    content: &str,
    tags: Option<&str>,
    source: Option<&str>,
) -> Result<MemoryEntry> {
    let id = Uuid::new_v4().to_string();
    let kind = kind.unwrap_or("note");
    let now = now_ms();
    let normalized_tags = tags.map(normalize_tags);

    sqlx::query(
        "INSERT INTO memory_entries \
             (id, workspace_id, kind, title, content, tags, source, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(workspace_id)
    .bind(kind)
    .bind(title)
    .bind(content)
    .bind(normalized_tags.as_deref())
    .bind(source)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(MemoryEntry {
        id,
        workspace_id: workspace_id.map(str::to_string),
        kind: kind.to_string(),
        title: title.map(str::to_string),
        content: content.to_string(),
        tags: normalized_tags,
        source: source.map(str::to_string),
        created_at: now,
        updated_at: now,
    })
}

/// Update title/content/tags on an existing row. None means "leave
/// unchanged"; the FTS trigger keeps the index in sync either way.
pub async fn update(
    pool: &SqlitePool,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
    tags: Option<&str>,
) -> Result<()> {
    let normalized_tags = tags.map(normalize_tags);
    sqlx::query(
        "UPDATE memory_entries SET \
             title = COALESCE(?, title), \
             content = COALESCE(?, content), \
             tags = COALESCE(?, tags), \
             updated_at = ? \
         WHERE id = ?",
    )
    .bind(title)
    .bind(content)
    .bind(normalized_tags.as_deref())
    .bind(now_ms())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM memory_entries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<MemoryEntry>> {
    let row = sqlx::query_as::<_, EntryRow>(
        "SELECT id, workspace_id, kind, title, content, tags, source, created_at, updated_at \
         FROM memory_entries WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Into::into))
}

/// Most-recently-updated first. `workspace_id = None` lists global entries
/// (rows with NULL workspace_id); pass `Some("__all__")` to list every row.
pub async fn list(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
    limit: i64,
) -> Result<Vec<MemoryEntry>> {
    let limit = limit.clamp(1, 500);
    let rows: Vec<EntryRow> = match workspace_id {
        Some("__all__") => {
            sqlx::query_as(
                "SELECT id, workspace_id, kind, title, content, tags, source, created_at, updated_at \
                 FROM memory_entries \
                 ORDER BY updated_at DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        Some(ws) => {
            sqlx::query_as(
                "SELECT id, workspace_id, kind, title, content, tags, source, created_at, updated_at \
                 FROM memory_entries WHERE workspace_id = ? \
                 ORDER BY updated_at DESC LIMIT ?",
            )
            .bind(ws)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query_as(
                "SELECT id, workspace_id, kind, title, content, tags, source, created_at, updated_at \
                 FROM memory_entries WHERE workspace_id IS NULL \
                 ORDER BY updated_at DESC LIMIT ?",
            )
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Full-text search via FTS5. Returns entries ordered by bm25 relevance.
///
/// `query` is passed straight to FTS5, so callers can use prefix syntax
/// (`foo*`), phrase queries (`"hello world"`), and boolean operators.
/// Common typos that the FTS5 parser rejects (stray `:` etc.) are sanitized
/// to a quoted phrase so the user never sees a parse error.
pub async fn search(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
    query: &str,
    limit: i64,
) -> Result<Vec<MemoryHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 200);
    let fts_query = sanitize_fts(q);

    // We join memory_fts back to memory_entries to apply the workspace
    // filter and pull every column we expose. `bm25()` is FTS5's default
    // ranking function (lower = more relevant).
    let rows: Vec<SearchRow> = match workspace_id {
        Some("__all__") => {
            sqlx::query_as(SEARCH_SQL_ALL)
                .bind(&fts_query)
                .bind(limit)
                .fetch_all(pool)
                .await?
        }
        Some(ws) => {
            sqlx::query_as(SEARCH_SQL_WS)
                .bind(&fts_query)
                .bind(ws)
                .bind(limit)
                .fetch_all(pool)
                .await?
        }
        None => {
            sqlx::query_as(SEARCH_SQL_GLOBAL)
                .bind(&fts_query)
                .bind(limit)
                .fetch_all(pool)
                .await?
        }
    };

    Ok(rows.into_iter().map(Into::into).collect())
}

// Column order matches `SearchRow` below — keep them in sync.
const SEARCH_SQL_ALL: &str = "SELECT e.id, e.workspace_id, e.kind, e.title, e.content, e.tags, \
                                     e.source, e.created_at, e.updated_at, \
                                     bm25(memory_fts) AS score, \
                                     snippet(memory_fts, 1, '[', ']', '…', 12) AS snippet \
                              FROM memory_fts JOIN memory_entries e ON e.rowid = memory_fts.rowid \
                              WHERE memory_fts MATCH ? \
                              ORDER BY score LIMIT ?";

const SEARCH_SQL_WS: &str = "SELECT e.id, e.workspace_id, e.kind, e.title, e.content, e.tags, \
                                    e.source, e.created_at, e.updated_at, \
                                    bm25(memory_fts) AS score, \
                                    snippet(memory_fts, 1, '[', ']', '…', 12) AS snippet \
                             FROM memory_fts JOIN memory_entries e ON e.rowid = memory_fts.rowid \
                             WHERE memory_fts MATCH ? AND e.workspace_id = ? \
                             ORDER BY score LIMIT ?";

const SEARCH_SQL_GLOBAL: &str = "SELECT e.id, e.workspace_id, e.kind, e.title, e.content, e.tags, \
                                        e.source, e.created_at, e.updated_at, \
                                        bm25(memory_fts) AS score, \
                                        snippet(memory_fts, 1, '[', ']', '…', 12) AS snippet \
                                 FROM memory_fts JOIN memory_entries e ON e.rowid = memory_fts.rowid \
                                 WHERE memory_fts MATCH ? AND e.workspace_id IS NULL \
                                 ORDER BY score LIMIT ?";

/// Normalize a comma/space-separated tag string into a deterministic
/// "tag1, tag2, tag3" form so FTS indexes them consistently.
fn normalize_tags(raw: &str) -> String {
    let mut out: Vec<String> = raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .collect();
    out.sort();
    out.dedup();
    out.join(", ")
}

/// Strip characters FTS5's query parser treats as operators when the user
/// almost certainly meant them literally. We keep `*`, `"`, and whitespace
/// so prefix and phrase queries still work; everything else folds into a
/// single space. If the result has no token chars left, fall back to a
/// quoted phrase of the original text.
fn sanitize_fts(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '*' | '"' | ' ' | '\t' => cleaned.push(ch),
            _ => cleaned.push(' '),
        }
    }
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        // Quote the raw text so FTS5 treats it as a phrase even if it had
        // only punctuation. Escape internal quotes per FTS5 rules.
        let escaped = raw.replace('"', "\"\"");
        format!("\"{}\"", escaped)
    } else {
        trimmed.to_string()
    }
}

// ── row mappers ──────────────────────────────────────────────────────────
//
// sqlx::FromRow keeps the column→field mapping declarative. We split the
// search row into a separate struct because FTS adds two extra columns.

#[derive(sqlx::FromRow)]
struct EntryRow {
    id: String,
    workspace_id: Option<String>,
    kind: String,
    title: Option<String>,
    content: String,
    tags: Option<String>,
    source: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl From<EntryRow> for MemoryEntry {
    fn from(r: EntryRow) -> Self {
        MemoryEntry {
            id: r.id,
            workspace_id: r.workspace_id,
            kind: r.kind,
            title: r.title,
            content: r.content,
            tags: r.tags,
            source: r.source,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(sqlx::FromRow)]
struct SearchRow {
    id: String,
    workspace_id: Option<String>,
    kind: String,
    title: Option<String>,
    content: String,
    tags: Option<String>,
    source: Option<String>,
    created_at: i64,
    updated_at: i64,
    score: f64,
    snippet: String,
}

impl From<SearchRow> for MemoryHit {
    fn from(r: SearchRow) -> Self {
        MemoryHit {
            entry: MemoryEntry {
                id: r.id,
                workspace_id: r.workspace_id,
                kind: r.kind,
                title: r.title,
                content: r.content,
                tags: r.tags,
                source: r.source,
                created_at: r.created_at,
                updated_at: r.updated_at,
            },
            score: r.score,
            snippet: r.snippet,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionStore;

    async fn fresh_store() -> SessionStore {
        let path = std::env::temp_dir().join(format!("arc-test-memory-{}.db", Uuid::new_v4()));
        SessionStore::open_at(&path).await.expect("open store")
    }

    #[tokio::test]
    async fn save_and_get_roundtrip() {
        let store = fresh_store().await;
        let saved = save(
            store.pool(),
            None,
            Some("note"),
            Some("hello"),
            "world",
            Some("greeting, intro"),
            Some("manual"),
        )
        .await
        .expect("save");
        let fetched = get(store.pool(), &saved.id).await.expect("get").expect("some");
        assert_eq!(fetched.title.as_deref(), Some("hello"));
        assert_eq!(fetched.content, "world");
        assert_eq!(fetched.tags.as_deref(), Some("greeting, intro"));
    }

    #[tokio::test]
    async fn list_filters_by_workspace() {
        let store = fresh_store().await;
        let ws = crate::workspaces::upsert(store.pool(), "arc", "/tmp/arc")
            .await
            .expect("ws");
        save(store.pool(), Some(&ws.id), None, None, "alpha", None, None)
            .await
            .expect("save ws");
        save(store.pool(), None, None, None, "beta", None, None)
            .await
            .expect("save global");

        let in_ws = list(store.pool(), Some(&ws.id), 10).await.expect("list ws");
        assert_eq!(in_ws.len(), 1);
        assert_eq!(in_ws[0].content, "alpha");

        let globals = list(store.pool(), None, 10).await.expect("list global");
        assert_eq!(globals.len(), 1);
        assert_eq!(globals[0].content, "beta");

        let all = list(store.pool(), Some("__all__"), 10)
            .await
            .expect("list all");
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn fts_search_returns_relevant_hit() {
        let store = fresh_store().await;
        save(
            store.pool(),
            None,
            None,
            Some("Tauri"),
            "Tauri runs Rust + a webview together",
            Some("rust"),
            None,
        )
        .await
        .expect("save 1");
        save(
            store.pool(),
            None,
            None,
            Some("Vite"),
            "Vite is a frontend dev server",
            Some("javascript"),
            None,
        )
        .await
        .expect("save 2");

        let hits = search(store.pool(), Some("__all__"), "tauri", 10)
            .await
            .expect("search");
        assert!(!hits.is_empty());
        assert!(hits[0].entry.content.contains("Tauri"));
        // Snippet should show the highlighted match.
        assert!(hits[0].snippet.contains('['));
    }

    #[tokio::test]
    async fn update_reindexes_fts() {
        let store = fresh_store().await;
        let saved = save(
            store.pool(),
            None,
            None,
            Some("old"),
            "stale text",
            None,
            None,
        )
        .await
        .expect("save");
        update(
            store.pool(),
            &saved.id,
            Some("new"),
            Some("fresh banana content"),
            None,
        )
        .await
        .expect("update");

        let hits = search(store.pool(), Some("__all__"), "banana", 10)
            .await
            .expect("search");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].entry.content.contains("banana"));

        let stale = search(store.pool(), Some("__all__"), "stale", 10)
            .await
            .expect("search");
        assert!(stale.is_empty(), "old content should be gone from fts");
    }

    #[tokio::test]
    async fn delete_removes_from_fts() {
        let store = fresh_store().await;
        let saved = save(
            store.pool(),
            None,
            None,
            None,
            "lookup target xyzzy",
            None,
            None,
        )
        .await
        .expect("save");
        delete(store.pool(), &saved.id).await.expect("delete");
        let hits = search(store.pool(), Some("__all__"), "xyzzy", 10)
            .await
            .expect("search");
        assert!(hits.is_empty());
    }

    #[tokio::test]
    async fn empty_query_returns_empty() {
        let store = fresh_store().await;
        save(store.pool(), None, None, None, "anything", None, None)
            .await
            .expect("save");
        assert!(search(store.pool(), None, "", 10).await.unwrap().is_empty());
        assert!(search(store.pool(), None, "   ", 10).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sanitize_keeps_phrase_search() {
        // Punctuation alone should still produce a runnable query, not a
        // sqlx error.
        let store = fresh_store().await;
        save(store.pool(), None, None, None, "weird ::: text", None, None)
            .await
            .expect("save");
        let _ = search(store.pool(), None, ":::", 10).await.expect("search");
    }

    #[test]
    fn normalize_tags_dedupes_and_sorts() {
        assert_eq!(normalize_tags("foo, bar foo BAR"), "bar, foo");
        assert_eq!(normalize_tags("  "), "");
        assert_eq!(normalize_tags("Alpha"), "alpha");
    }
}
