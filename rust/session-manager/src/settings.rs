//! Key→value settings store in SQLite. Values are JSON blobs.

use sqlx::SqlitePool;

use crate::{now_ms, Result};

pub async fn load(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(v,)| v))
}

pub async fn save(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

// ─── terminal scrollback ──────────────────────────────────────────────────
//
// Serialized xterm buffers, one row per terminal tab, so a relaunched tab
// comes back showing what it showed before the quit instead of an empty
// pane. They ride in `app_settings` under a `scrollback:` key prefix rather
// than a table of their own — same lifetime, same store, no migration.
//
// ponytail: prefix scan on a table that holds a handful of rows. Move to a
// dedicated table if app_settings ever grows past a few hundred keys.

const SCROLLBACK_PREFIX: &str = "scrollback:";

fn scrollback_key(tab_id: &str) -> String {
    format!("{SCROLLBACK_PREFIX}{tab_id}")
}

pub async fn scrollback_save(pool: &SqlitePool, tab_id: &str, data: &str) -> Result<()> {
    save(pool, &scrollback_key(tab_id), data).await
}

pub async fn scrollback_load(pool: &SqlitePool, tab_id: &str) -> Result<Option<String>> {
    load(pool, &scrollback_key(tab_id)).await
}

pub async fn scrollback_delete(pool: &SqlitePool, tab_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(scrollback_key(tab_id))
        .execute(pool)
        .await?;
    Ok(())
}

/// Drop every stored scrollback whose tab is no longer open. Called after the
/// frontend hydrates, so blobs for tabs closed in a previous run (or closed
/// while the app was not running) don't accumulate forever.
pub async fn scrollback_prune(pool: &SqlitePool, keep_tab_ids: &[String]) -> Result<()> {
    if keep_tab_ids.is_empty() {
        sqlx::query("DELETE FROM app_settings WHERE key LIKE ?")
            .bind(format!("{SCROLLBACK_PREFIX}%"))
            .execute(pool)
            .await?;
        return Ok(());
    }
    // sqlx has no list binding for SQLite, so build the placeholder run.
    let placeholders = std::iter::repeat("?")
        .take(keep_tab_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "DELETE FROM app_settings WHERE key LIKE ? AND key NOT IN ({placeholders})"
    );
    let mut q = sqlx::query(&sql).bind(format!("{SCROLLBACK_PREFIX}%"));
    for id in keep_tab_ids {
        q = q.bind(scrollback_key(id));
    }
    q.execute(pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL, \
             value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn scrollback_round_trips_and_prunes() {
        let pool = pool().await;
        scrollback_save(&pool, "tab-a", "aaa").await.unwrap();
        scrollback_save(&pool, "tab-b", "bbb").await.unwrap();
        save(&pool, "user_settings", "{}").await.unwrap();

        assert_eq!(
            scrollback_load(&pool, "tab-a").await.unwrap().as_deref(),
            Some("aaa")
        );

        // Keeping only tab-a drops tab-b but must not touch user_settings.
        scrollback_prune(&pool, &["tab-a".to_string()]).await.unwrap();
        assert!(scrollback_load(&pool, "tab-a").await.unwrap().is_some());
        assert!(scrollback_load(&pool, "tab-b").await.unwrap().is_none());
        assert!(load(&pool, "user_settings").await.unwrap().is_some());

        // Empty keep-list clears every scrollback, still sparing settings.
        scrollback_prune(&pool, &[]).await.unwrap();
        assert!(scrollback_load(&pool, "tab-a").await.unwrap().is_none());
        assert!(load(&pool, "user_settings").await.unwrap().is_some());

        // Delete is keyed, not prefixed.
        scrollback_save(&pool, "tab-c", "ccc").await.unwrap();
        scrollback_delete(&pool, "tab-c").await.unwrap();
        assert!(scrollback_load(&pool, "tab-c").await.unwrap().is_none());
    }
}
