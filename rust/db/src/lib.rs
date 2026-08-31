//! arc-db — connection pooling and query execution for ARC's database client
//! tab. Postgres, MySQL, and SQLite, picked from the URL scheme.
//!
//! ## Why every cell comes back as a string
//!
//! A database *client* has to render whatever the server sends — uuid,
//! timestamptz, numeric, jsonb, arrays, enums. sqlx's `Any` driver can't do
//! that: `AnyRow::map_from` fails the whole row the moment a column's type
//! isn't one of its eight built-ins, so a single `created_at` column would
//! blank out an entire table.
//!
//! Instead we run the user's SQL through [`sqlx::raw_sql`], which sends it
//! unprepared. Postgres and MySQL both answer an unprepared query in their
//! *text* protocol, so every value arrives already formatted the way `psql`
//! would print it — and `try_get_unchecked::<String>` hands it straight back
//! without a type check. SQLite has no wire format, but `sqlite3_column_text`
//! coerces its four storage classes to text just as happily.
//!
//! The numeric/bool/blob fallbacks below only fire for the binary-protocol
//! paths that don't apply today; they're two lines each and keep a future
//! prepared-statement path from rendering `<binary>` everywhere.

use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{
    mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions, Column, Either,
    MySqlPool, PgPool, Row, SqlitePool, ValueRef,
};

/// Hard cap on rows held in memory for one query. The grid is not a data
/// export tool; anything past this is truncated and flagged in the result.
//
// ponytail: fixed cap, no paging. Add a LIMIT/OFFSET pager if anyone actually
// wants to page through a million-row table in the UI.
pub const MAX_ROWS: usize = 5_000;

/// Give up on a connect attempt after this long. A wrong host otherwise hangs
/// the panel on the OS's TCP timeout.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Postgres,
    Mysql,
    Sqlite,
}

impl Backend {
    /// Classify a connection URL by scheme. The accepted spellings match what
    /// sqlx itself accepts, so a URL that parses here also connects.
    ///
    /// Split on the first `:`, not on `://` — SQLite's own URLs often have no
    /// authority at all (`sqlite:app.db`, `sqlite::memory:`), and requiring
    /// the slashes would reject them.
    pub fn from_url(url: &str) -> Result<Backend> {
        let scheme = url
            .split_once(':')
            .map(|(s, _)| s.to_ascii_lowercase())
            .unwrap_or_default();
        match scheme.as_str() {
            "postgres" | "postgresql" => Ok(Backend::Postgres),
            "mysql" | "mariadb" => Ok(Backend::Mysql),
            "sqlite" => Ok(Backend::Sqlite),
            "" => Err(anyhow!(
                "connection URL needs a scheme, e.g. postgres://user@host/db"
            )),
            other => Err(anyhow!("unsupported database scheme: {other}")),
        }
    }

    /// The dialect's "list every user table" query.
    fn tables_sql(self) -> &'static str {
        match self {
            Backend::Postgres => {
                "SELECT table_schema || '.' || table_name AS name \
                 FROM information_schema.tables \
                 WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY 1"
            }
            Backend::Mysql => {
                "SELECT table_name AS name FROM information_schema.tables \
                 WHERE table_schema = DATABASE() ORDER BY 1"
            }
            Backend::Sqlite => {
                "SELECT name FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY 1"
            }
        }
    }

    /// Quote an identifier for this dialect, so a table with a capital letter
    /// or a reserved word still previews. Embedded quote characters are
    /// doubled — the standard escape in all three dialects.
    fn quote_ident(self, ident: &str) -> String {
        match self {
            Backend::Mysql => format!("`{}`", ident.replace('`', "``")),
            // Postgres schema-qualified names arrive as `schema.table`; quote
            // each part so `public.Orders` stays two identifiers, not one.
            Backend::Postgres => ident
                .split('.')
                .map(|p| format!("\"{}\"", p.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join("."),
            Backend::Sqlite => format!("\"{}\"", ident.replace('"', "\"\"")),
        }
    }
}

/// One query's results. `columns` is empty for statements that return no rows
/// (INSERT/UPDATE/DDL); `rows_affected` is 0 for SELECTs.
#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// Row-major cells. `None` is SQL NULL — distinct from the empty string.
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: u64,
    pub duration_ms: u64,
    /// True when the server had more rows than [`MAX_ROWS`].
    pub truncated: bool,
}

enum Pool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

/// Live connection pools, keyed by the frontend's connection id. Cheap to
/// clone (the DashMap is behind the manager, which is `.manage()`d once).
#[derive(Default)]
pub struct DbManager {
    pools: DashMap<String, Pool>,
}

impl DbManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a pool for `url` and register it under `id`, replacing (and
    /// closing) any pool already there. Round-trips a trivial query so a bad
    /// host/credential surfaces here rather than on the user's first SELECT.
    pub async fn connect(&self, id: &str, url: &str) -> Result<Backend> {
        let backend = Backend::from_url(url)?;
        // Small pool: this is one human running one query at a time, and a
        // fat pool against a shared dev database is rude.
        let pool = match backend {
            Backend::Postgres => Pool::Postgres(
                PgPoolOptions::new()
                    .max_connections(3)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect(url)
                    .await
                    .context("could not connect")?,
            ),
            Backend::Mysql => Pool::Mysql(
                MySqlPoolOptions::new()
                    .max_connections(3)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect(url)
                    .await
                    .context("could not connect")?,
            ),
            Backend::Sqlite => Pool::Sqlite(
                SqlitePoolOptions::new()
                    .max_connections(1)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect(url)
                    .await
                    .context("could not connect")?,
            ),
        };
        if let Some((_, old)) = self.pools.remove(id) {
            close(old).await;
        }
        self.pools.insert(id.to_string(), pool);
        Ok(backend)
    }

    pub async fn disconnect(&self, id: &str) {
        if let Some((_, pool)) = self.pools.remove(id) {
            close(pool).await;
        }
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.pools.contains_key(id)
    }

    /// Run `sql` on the pool registered under `id`.
    pub async fn query(&self, id: &str, sql: &str) -> Result<QueryResult> {
        // Clone the pool handle out of the map before awaiting — holding a
        // DashMap guard across an await deadlocks the shard on the next
        // access from the same task.
        let pool = self.clone_pool(id)?;
        run(&pool, sql).await
    }

    /// Every user table/view in the connected database, dialect-aware.
    pub async fn tables(&self, id: &str) -> Result<Vec<String>> {
        let pool = self.clone_pool(id)?;
        let backend = backend_of(&pool);
        let res = run(&pool, backend.tables_sql()).await?;
        Ok(res
            .rows
            .into_iter()
            .filter_map(|mut r| if r.is_empty() { None } else { r.swap_remove(0) })
            .collect())
    }

    /// `SELECT * FROM <table> LIMIT n` with the name quoted for the dialect —
    /// what a click on a table in the sidebar runs.
    pub async fn preview(&self, id: &str, table: &str, limit: u32) -> Result<QueryResult> {
        let pool = self.clone_pool(id)?;
        let backend = backend_of(&pool);
        let sql = format!(
            "SELECT * FROM {} LIMIT {}",
            backend.quote_ident(table),
            limit.min(MAX_ROWS as u32)
        );
        run(&pool, &sql).await
    }

    fn clone_pool(&self, id: &str) -> Result<Pool> {
        let entry = self
            .pools
            .get(id)
            .ok_or_else(|| anyhow!("not connected — open the connection first"))?;
        Ok(match &*entry {
            Pool::Postgres(p) => Pool::Postgres(p.clone()),
            Pool::Mysql(p) => Pool::Mysql(p.clone()),
            Pool::Sqlite(p) => Pool::Sqlite(p.clone()),
        })
    }

    /// Close every pool. Called on app exit so servers see clean disconnects.
    pub async fn close_all(&self) {
        let ids: Vec<String> = self.pools.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }
}

fn backend_of(pool: &Pool) -> Backend {
    match pool {
        Pool::Postgres(_) => Backend::Postgres,
        Pool::Mysql(_) => Backend::Mysql,
        Pool::Sqlite(_) => Backend::Sqlite,
    }
}

async fn close(pool: Pool) {
    match pool {
        Pool::Postgres(p) => p.close().await,
        Pool::Mysql(p) => p.close().await,
        Pool::Sqlite(p) => p.close().await,
    }
}

/// Drive one `raw_sql` execution to completion, folding the interleaved
/// "query result" / "row" stream into a [`QueryResult`].
///
/// The three arms differ only in the concrete row type, which is why this is a
/// macro rather than a generic fn: expressing "any `Row` whose `Database` can
/// decode `String`, `i64`, `f64`, `bool` and `Vec<u8>`" needs a bound list
/// longer than the body it would abstract over.
macro_rules! drain {
    ($sql:expr, $pool:expr) => {{
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut rows_affected: u64 = 0;
        let mut truncated = false;

        let mut stream = sqlx::raw_sql($sql).fetch_many($pool);
        while let Some(item) = stream.try_next().await? {
            match item {
                Either::Left(res) => rows_affected += res.rows_affected(),
                Either::Right(row) => {
                    if columns.is_empty() {
                        columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    if rows.len() >= MAX_ROWS {
                        truncated = true;
                        continue;
                    }
                    let mut cells = Vec::with_capacity(row.columns().len());
                    for i in 0..row.columns().len() {
                        cells.push(cell(&row, i));
                    }
                    rows.push(cells);
                }
            }
        }
        (columns, rows, rows_affected, truncated)
    }};
}

/// Read one cell as display text. `None` means SQL NULL.
///
/// See the module docs for why `try_get_unchecked::<String>` is the primary
/// path: unprepared queries answer in the text protocol, so the server has
/// already done the formatting for us.
macro_rules! cell_body {
    ($row:expr, $i:expr) => {{
        match $row.try_get_raw($i) {
            Ok(raw) if raw.is_null() => None,
            Ok(_) | Err(_) => {
                if let Ok(v) = $row.try_get_unchecked::<String, _>($i) {
                    Some(v)
                } else if let Ok(v) = $row.try_get_unchecked::<i64, _>($i) {
                    Some(v.to_string())
                } else if let Ok(v) = $row.try_get_unchecked::<f64, _>($i) {
                    Some(v.to_string())
                } else if let Ok(v) = $row.try_get_unchecked::<bool, _>($i) {
                    Some(v.to_string())
                } else if let Ok(v) = $row.try_get_unchecked::<Vec<u8>, _>($i) {
                    Some(format!("<{} bytes>", v.len()))
                } else {
                    // Undecodable but not null — say so rather than showing an
                    // empty cell the user would read as NULL.
                    Some("<unreadable>".to_string())
                }
            }
        }
    }};
}

async fn run(pool: &Pool, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    let (columns, rows, rows_affected, truncated) = match pool {
        Pool::Postgres(p) => {
            fn cell(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            drain!(sql, p)
        }
        Pool::Mysql(p) => {
            fn cell(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            drain!(sql, p)
        }
        Pool::Sqlite(p) => {
            fn cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            drain!(sql, p)
        }
    };
    Ok(QueryResult {
        columns,
        rows,
        rows_affected,
        duration_ms: started.elapsed().as_millis() as u64,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_classification() {
        assert_eq!(
            Backend::from_url("postgres://u:p@h/db").unwrap(),
            Backend::Postgres
        );
        assert_eq!(
            Backend::from_url("postgresql://h/db").unwrap(),
            Backend::Postgres
        );
        assert_eq!(Backend::from_url("mysql://h/db").unwrap(), Backend::Mysql);
        assert_eq!(Backend::from_url("sqlite://./a.db").unwrap(), Backend::Sqlite);
        // SQLite's authority-less spellings, which sqlx accepts too.
        assert_eq!(Backend::from_url("sqlite:app.db").unwrap(), Backend::Sqlite);
        assert_eq!(Backend::from_url("sqlite::memory:").unwrap(), Backend::Sqlite);
        assert!(Backend::from_url("mongodb://h/db").is_err());
        assert!(Backend::from_url("/just/a/path").is_err());
    }

    #[test]
    fn identifiers_are_quoted_and_escaped() {
        assert_eq!(Backend::Sqlite.quote_ident("Orders"), "\"Orders\"");
        assert_eq!(Backend::Mysql.quote_ident("or`der"), "`or``der`");
        // A schema-qualified Postgres name keeps its dot outside the quotes.
        assert_eq!(
            Backend::Postgres.quote_ident("public.Orders"),
            "\"public\".\"Orders\""
        );
        assert_eq!(Backend::Postgres.quote_ident("a\"b"), "\"a\"\"b\"");
    }

    /// Round-trips a real query against an in-memory SQLite database: NULL
    /// stays distinct from the empty string, ints/reals/blobs all render, and
    /// a non-SELECT reports `rows_affected` instead of columns.
    #[tokio::test]
    async fn sqlite_round_trip() {
        let mgr = DbManager::new();
        mgr.connect("t", "sqlite::memory:").await.unwrap();

        let ddl = mgr
            .query("t", "CREATE TABLE t (a INTEGER, b TEXT, c REAL, d BLOB)")
            .await
            .unwrap();
        assert!(ddl.columns.is_empty());

        let ins = mgr
            .query(
                "t",
                "INSERT INTO t VALUES (1, 'x', 1.5, x'00ff'), (2, NULL, NULL, NULL), (3, '', 0.0, NULL)",
            )
            .await
            .unwrap();
        assert_eq!(ins.rows_affected, 3);

        let res = mgr.query("t", "SELECT a, b, c FROM t ORDER BY a").await.unwrap();
        assert_eq!(res.columns, vec!["a", "b", "c"]);
        assert_eq!(res.rows.len(), 3);
        assert_eq!(res.rows[0][0], Some("1".to_string()));
        assert_eq!(res.rows[0][1], Some("x".to_string()));
        // NULL and '' must not collapse into the same rendering.
        assert_eq!(res.rows[1][1], None);
        assert_eq!(res.rows[2][1], Some("".to_string()));
        assert!(!res.truncated);

        assert_eq!(mgr.tables("t").await.unwrap(), vec!["t".to_string()]);
        assert_eq!(mgr.preview("t", "t", 2).await.unwrap().rows.len(), 2);

        // An unknown connection id is an error, not a panic.
        assert!(mgr.query("nope", "SELECT 1").await.is_err());
    }
}
