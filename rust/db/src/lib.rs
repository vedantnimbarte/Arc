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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use dashmap::DashMap;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{
    mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions, Column, Either,
    MySqlPool, PgPool, Row, SqlitePool, TypeInfo, ValueRef,
};
use tokio::io::{AsyncWriteExt, BufWriter};

/// File format for [`DbManager::export`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

/// How many rows between progress callbacks during an export.
const PROGRESS_EVERY: u64 = 1_000;

/// Hard cap on rows held in memory for one query. The grid is not a data
/// export tool; anything past this is truncated and flagged in the result.
//
// ponytail: fixed cap, no paging. Add a LIMIT/OFFSET pager if anyone actually
// wants to page through a million-row table in the UI.
pub const MAX_ROWS: usize = 20_000;

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

    /// Quote a string literal. `run` sends SQL unprepared, so the schema
    /// queries can't bind parameters — the table name is inlined instead.
    /// MySQL also treats backslash as an escape unless NO_BACKSLASH_ESCAPES
    /// is set, so it gets doubled there too.
    fn quote_literal(self, s: &str) -> String {
        let s = match self {
            Backend::Mysql => s.replace('\\', "\\\\"),
            _ => s.to_string(),
        };
        format!("'{}'", s.replace('\'', "''"))
    }

    /// The three read-only catalog queries behind [`DbManager::schema`]:
    /// columns, indexes, foreign keys. Each returns text cells in the order
    /// `schema` reads them, with flags spelled `YES`/`NO` the way
    /// `information_schema.columns.is_nullable` already is.
    fn schema_sql(self, table: &str) -> [String; 3] {
        match self {
            Backend::Postgres => {
                // Tables are listed as `schema.table`; a bare name falls back
                // to the first schema on the search path.
                let (schema, name) = match table.split_once('.') {
                    Some((s, n)) => (self.quote_literal(s), self.quote_literal(n)),
                    None => ("current_schema()".to_string(), self.quote_literal(table)),
                };
                let regclass = format!("{}::regclass", self.quote_literal(&self.quote_ident(table)));
                [
                    format!(
                        "SELECT c.column_name, \
                           CASE WHEN c.data_type IN ('USER-DEFINED', 'ARRAY') THEN c.udt_name ELSE c.data_type END, \
                           c.is_nullable, c.column_default, \
                           CASE WHEN EXISTS ( \
                             SELECT 1 FROM information_schema.table_constraints tc \
                             JOIN information_schema.key_column_usage k \
                               ON k.constraint_schema = tc.constraint_schema \
                              AND k.constraint_name = tc.constraint_name \
                              AND k.table_name = tc.table_name \
                             WHERE tc.constraint_type = 'PRIMARY KEY' \
                               AND tc.table_schema = c.table_schema \
                               AND tc.table_name = c.table_name \
                               AND k.column_name = c.column_name \
                           ) THEN 'YES' ELSE 'NO' END \
                         FROM information_schema.columns c \
                         WHERE c.table_schema = {schema} AND c.table_name = {name} \
                         ORDER BY c.ordinal_position"
                    ),
                    // information_schema has no indexes. pg_index is the cheap
                    // catalog, and pg_get_indexdef renders expression columns.
                    format!(
                        "SELECT i.relname, \
                           (SELECT string_agg(pg_get_indexdef(ix.indexrelid, k, true), ', ' ORDER BY k) \
                            FROM generate_series(1, ix.indnatts) k), \
                           CASE WHEN ix.indisunique THEN 'YES' ELSE 'NO' END \
                         FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid \
                         WHERE ix.indrelid = {regclass} ORDER BY 1"
                    ),
                    // pg_constraint rather than information_schema: Postgres
                    // constraint names are only unique per table, which makes
                    // the information_schema joins ambiguous.
                    format!(
                        "SELECT c.conname, \
                           (SELECT string_agg(a.attname, ', ' ORDER BY k) \
                            FROM generate_subscripts(c.conkey, 1) k \
                            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[k]), \
                           c.confrelid::regclass::text || '(' || \
                           (SELECT string_agg(a.attname, ', ' ORDER BY k) \
                            FROM generate_subscripts(c.confkey, 1) k \
                            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = c.confkey[k]) || ')' \
                         FROM pg_constraint c \
                         WHERE c.conrelid = {regclass} AND c.contype = 'f' ORDER BY 1"
                    ),
                ]
            }
            Backend::Mysql => {
                let name = self.quote_literal(table);
                [
                    format!(
                        "SELECT column_name, column_type, is_nullable, column_default, \
                           CASE WHEN column_key = 'PRI' THEN 'YES' ELSE 'NO' END \
                         FROM information_schema.columns \
                         WHERE table_schema = DATABASE() AND table_name = {name} \
                         ORDER BY ordinal_position"
                    ),
                    format!(
                        "SELECT index_name, \
                           GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', '), \
                           CASE WHEN MIN(non_unique) = 0 THEN 'YES' ELSE 'NO' END \
                         FROM information_schema.statistics \
                         WHERE table_schema = DATABASE() AND table_name = {name} \
                         GROUP BY index_name ORDER BY index_name"
                    ),
                    format!(
                        "SELECT constraint_name, \
                           GROUP_CONCAT(column_name ORDER BY ordinal_position SEPARATOR ', '), \
                           CONCAT(MAX(referenced_table_name), '(', \
                             GROUP_CONCAT(referenced_column_name ORDER BY ordinal_position SEPARATOR ', '), ')') \
                         FROM information_schema.key_column_usage \
                         WHERE table_schema = DATABASE() AND table_name = {name} \
                           AND referenced_table_name IS NOT NULL \
                         GROUP BY constraint_name ORDER BY constraint_name"
                    ),
                ]
            }
            Backend::Sqlite => {
                let name = self.quote_literal(table);
                [
                    format!(
                        "SELECT name, type, CASE WHEN \"notnull\" THEN 'NO' ELSE 'YES' END, dflt_value, \
                           CASE WHEN pk > 0 THEN 'YES' ELSE 'NO' END \
                         FROM pragma_table_info({name}) ORDER BY cid"
                    ),
                    format!(
                        "SELECT il.name, \
                           (SELECT group_concat(name, ', ') FROM \
                             (SELECT name FROM pragma_index_info(il.name) ORDER BY seqno)), \
                           CASE WHEN il.\"unique\" THEN 'YES' ELSE 'NO' END \
                         FROM pragma_index_list({name}) il ORDER BY il.name"
                    ),
                    // SQLite foreign keys have no names. `to` is NULL when the
                    // reference targets the parent's primary key implicitly.
                    format!(
                        "SELECT '', group_concat(\"from\", ', '), \
                           \"table\" || ifnull('(' || group_concat(\"to\", ', ') || ')', '') \
                         FROM (SELECT * FROM pragma_foreign_key_list({name}) ORDER BY id, seq) \
                         GROUP BY id, \"table\""
                    ),
                ]
            }
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

/// Structure of one table, for the schema view. Read-only catalog data.
#[derive(Debug, Clone, Serialize)]
pub struct TableSchema {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    /// Comma-joined, in index order.
    pub columns: String,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    /// Empty on SQLite, whose foreign keys have no names.
    pub name: String,
    pub columns: String,
    /// `table(col, …)`.
    pub references: String,
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

    /// Columns, indexes and foreign keys of `table`, read from the catalog.
    pub async fn schema(&self, id: &str, table: &str) -> Result<TableSchema> {
        let pool = self.clone_pool(id)?;
        let [columns_sql, indexes_sql, fks_sql] = backend_of(&pool).schema_sql(table);
        fn text(r: &mut [Option<String>], i: usize) -> Option<String> {
            r.get_mut(i).and_then(Option::take)
        }
        fn yes(r: &mut [Option<String>], i: usize) -> bool {
            text(r, i).as_deref() == Some("YES")
        }

        let columns = run(&pool, &columns_sql)
            .await?
            .rows
            .into_iter()
            .map(|mut r| ColumnInfo {
                name: text(&mut r, 0).unwrap_or_default(),
                data_type: text(&mut r, 1).unwrap_or_default(),
                nullable: yes(&mut r, 2),
                default: text(&mut r, 3),
                primary_key: yes(&mut r, 4),
            })
            .collect();
        let indexes = run(&pool, &indexes_sql)
            .await?
            .rows
            .into_iter()
            .map(|mut r| IndexInfo {
                name: text(&mut r, 0).unwrap_or_default(),
                columns: text(&mut r, 1).unwrap_or_default(),
                unique: yes(&mut r, 2),
            })
            .collect();
        let foreign_keys = run(&pool, &fks_sql)
            .await?
            .rows
            .into_iter()
            .map(|mut r| ForeignKeyInfo {
                name: text(&mut r, 0).unwrap_or_default(),
                columns: text(&mut r, 1).unwrap_or_default(),
                references: text(&mut r, 2).unwrap_or_default(),
            })
            .collect();
        Ok(TableSchema {
            columns,
            indexes,
            foreign_keys,
        })
    }

    /// Re-run `sql` and stream every row straight into `path` as CSV or JSON,
    /// ignoring [`MAX_ROWS`]. Rows are written as they arrive, so memory stays
    /// flat however big the result is. `progress` gets the running row count
    /// every [`PROGRESS_EVERY`] rows; setting `cancel` stops the export. On
    /// any failure (cancel included) the partial file is removed.
    ///
    /// Only SELECT-like statements are accepted — an export must never be
    /// the thing that runs someone's DELETE a second time.
    pub async fn export(
        &self,
        id: &str,
        sql: &str,
        format: ExportFormat,
        path: &Path,
        cancel: &AtomicBool,
        progress: impl FnMut(u64),
    ) -> Result<u64> {
        if !is_select_like(sql) {
            bail!("only SELECT-like statements can be exported");
        }
        let pool = self.clone_pool(id)?;
        let file = tokio::fs::File::create(path)
            .await
            .with_context(|| format!("could not create {}", path.display()))?;
        let mut out = BufWriter::new(file);
        let res = export_to(&pool, sql, format, &mut out, cancel, progress).await;
        let res = match res {
            Ok(n) => out.shutdown().await.map(|_| n).map_err(Into::into),
            Err(e) => Err(e),
        };
        if res.is_err() {
            drop(out);
            let _ = tokio::fs::remove_file(path).await;
        }
        res
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

/// True when `sql` starts (after comments, whitespace and parens) with a
/// read-only verb. A first-word check, not a parser: the frontend's
/// `sqlSafety` lexer does the careful single-statement check before this.
pub fn is_select_like(sql: &str) -> bool {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else if let Some(rest) = s.strip_prefix('(') {
            s = rest.trim_start();
        } else {
            break;
        }
    }
    let word: String = s
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(word.as_str(), "select" | "with" | "values" | "table" | "show")
}

/// One CSV field, quoted per RFC 4180 — the same rules as the frontend's
/// `toCsv`: NULL is an empty unquoted field, the empty string is `""`.
fn csv_field(v: Option<&str>) -> String {
    match v {
        None => String::new(),
        Some(s) if s.is_empty() || s.contains(['"', ',', '\r', '\n']) => {
            format!("\"{}\"", s.replace('"', "\"\""))
        }
        Some(s) => s.to_string(),
    }
}

/// A cell's JSON value. The text arrives server-formatted (see the module
/// docs); the column's type name says whether it's really a number or bool.
/// Anything that doesn't parse cleanly — NUMERIC past f64, NaN, an unsigned
/// bigint — stays a string rather than losing precision.
fn json_value(type_name: &str, text: Option<String>) -> serde_json::Value {
    use serde_json::Value;
    let Some(text) = text else {
        return Value::Null;
    };
    let base = type_name.trim_end_matches(" UNSIGNED");
    match base {
        "INT2" | "INT4" | "INT8" | "OID" | "INT" | "INTEGER" | "BIGINT" | "SMALLINT"
        | "TINYINT" | "MEDIUMINT" => {
            if let Ok(n) = text.parse::<i64>() {
                return n.into();
            }
            if let Ok(n) = text.parse::<u64>() {
                return n.into();
            }
        }
        "FLOAT4" | "FLOAT8" | "REAL" | "FLOAT" | "DOUBLE" => {
            if let Some(n) = text.parse::<f64>().ok().and_then(serde_json::Number::from_f64) {
                return Value::Number(n);
            }
        }
        "BOOL" | "BOOLEAN" => match text.as_str() {
            "t" | "true" | "1" => return Value::Bool(true),
            "f" | "false" | "0" => return Value::Bool(false),
            _ => {}
        },
        _ => {}
    }
    Value::String(text)
}

/// Disambiguate duplicate column names (a join's two `id`s) with `_2`, `_3`,
/// matching the frontend's grid export.
fn dedupe_keys(columns: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashMap::<&str, u32>::new();
    columns
        .iter()
        .map(|c| {
            let n = seen.entry(c).or_insert(0);
            *n += 1;
            if *n == 1 {
                c.clone()
            } else {
                format!("{c}_{n}")
            }
        })
        .collect()
}

/// The streaming half of [`DbManager::export`]; a macro per backend for the
/// same reason as [`drain!`].
macro_rules! export_rows {
    ($sql:expr, $pool:expr, $format:expr, $out:expr, $cancel:expr, $progress:expr) => {{
        let mut stream = sqlx::raw_sql($sql).fetch($pool);
        let mut n: u64 = 0;
        let mut keys: Vec<String> = Vec::new();
        while let Some(row) = stream.try_next().await? {
            if $cancel.load(Ordering::Relaxed) {
                bail!("export cancelled");
            }
            let width = row.columns().len();
            let mut line = String::new();
            if n == 0 {
                let names: Vec<String> =
                    row.columns().iter().map(|c| c.name().to_string()).collect();
                match $format {
                    ExportFormat::Csv => {
                        let header: Vec<String> =
                            names.iter().map(|c| csv_field(Some(c))).collect();
                        line.push_str(&header.join(","));
                        line.push_str("\r\n");
                    }
                    ExportFormat::Json => line.push_str("[\n"),
                }
                keys = dedupe_keys(&names);
            } else if $format == ExportFormat::Json {
                line.push_str(",\n");
            }
            match $format {
                ExportFormat::Csv => {
                    let cells: Vec<String> =
                        (0..width).map(|i| csv_field(cell(&row, i).as_deref())).collect();
                    line.push_str(&cells.join(","));
                    line.push_str("\r\n");
                }
                ExportFormat::Json => {
                    line.push('{');
                    for i in 0..width {
                        if i > 0 {
                            line.push(',');
                        }
                        let type_name = row
                            .try_get_raw(i)
                            .map(|v| v.type_info().name().to_ascii_uppercase())
                            .unwrap_or_default();
                        let value = json_value(&type_name, cell(&row, i));
                        line.push_str(&serde_json::to_string(&keys[i])?);
                        line.push(':');
                        line.push_str(&serde_json::to_string(&value)?);
                    }
                    line.push('}');
                }
            }
            $out.write_all(line.as_bytes()).await?;
            n += 1;
            if n % PROGRESS_EVERY == 0 {
                $progress(n);
            }
        }
        n
    }};
}

async fn export_to<W: tokio::io::AsyncWrite + Unpin>(
    pool: &Pool,
    sql: &str,
    format: ExportFormat,
    out: &mut W,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<u64> {
    // ponytail: with zero rows there are no column names to read from the row
    // stream, so an empty CSV has no header. Describe the statement first if
    // that ever matters.
    let n = match pool {
        Pool::Postgres(p) => {
            fn cell(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            export_rows!(sql, p, format, out, cancel, progress)
        }
        Pool::Mysql(p) => {
            fn cell(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            export_rows!(sql, p, format, out, cancel, progress)
        }
        Pool::Sqlite(p) => {
            fn cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            export_rows!(sql, p, format, out, cancel, progress)
        }
    };
    if format == ExportFormat::Json {
        out.write_all(if n == 0 { b"[]\n" as &[u8] } else { b"\n]\n" }).await?;
    }
    progress(n);
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_like_statements() {
        assert!(is_select_like("SELECT 1"));
        assert!(is_select_like("  -- note\n/* c */ (select 1) union (select 2)"));
        assert!(is_select_like("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_select_like("DELETE FROM t"));
        assert!(!is_select_like("-- SELECT\nDROP TABLE t"));
        assert!(!is_select_like(""));
    }

    #[test]
    fn typed_json_values() {
        use serde_json::json;
        assert_eq!(json_value("INT8", Some("42".into())), json!(42));
        assert_eq!(json_value("BIGINT UNSIGNED", Some("18446744073709551615".into())), json!(u64::MAX));
        assert_eq!(json_value("FLOAT8", Some("1.5".into())), json!(1.5));
        assert_eq!(json_value("FLOAT8", Some("NaN".into())), json!("NaN"));
        assert_eq!(json_value("BOOL", Some("t".into())), json!(true));
        assert_eq!(json_value("NUMERIC", Some("1.10".into())), json!("1.10"));
        assert_eq!(json_value("TEXT", None), serde_json::Value::Null);
        assert_eq!(csv_field(Some("a,\"b\"")), "\"a,\"\"b\"\"\"");
        assert_eq!(csv_field(Some("")), "\"\"");
        assert_eq!(csv_field(None), "");
        assert_eq!(
            dedupe_keys(&["id".into(), "id".into(), "x".into()]),
            vec!["id", "id_2", "x"]
        );
    }

    /// Streams well past MAX_ROWS to disk, with real JSON types, and cleans up
    /// after a cancel.
    #[tokio::test]
    async fn sqlite_export_beyond_cap() {
        const N: usize = MAX_ROWS + 5_000;
        let mgr = DbManager::new();
        mgr.connect("e", "sqlite::memory:").await.unwrap();
        mgr.query(
            "e",
            &format!(
                "CREATE TABLE t (a INTEGER, b TEXT, c REAL, d TEXT); \
                 WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM s WHERE x < {N}) \
                 INSERT INTO t SELECT x, 'n,' || x, x * 0.5, NULL FROM s;"
            ),
        )
        .await
        .unwrap();

        let dir = std::env::temp_dir();
        let json_path = dir.join(format!("arc-db-export-{}.json", std::process::id()));
        let csv_path = dir.join(format!("arc-db-export-{}.csv", std::process::id()));
        let cancel = AtomicBool::new(false);

        let mut ticks = 0;
        let n = mgr
            .export("e", "SELECT * FROM t ORDER BY a", ExportFormat::Json, &json_path, &cancel, |_| ticks += 1)
            .await
            .unwrap();
        assert_eq!(n as usize, N);
        assert!(ticks >= N / PROGRESS_EVERY as usize);
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
        let rows = parsed.as_array().unwrap();
        assert_eq!(rows.len(), N);
        assert_eq!(rows[0], serde_json::json!({"a": 1, "b": "n,1", "c": 0.5, "d": null}));
        assert_eq!(rows[N - 1]["a"], serde_json::json!(N));

        let n = mgr
            .export("e", "SELECT a, b FROM t", ExportFormat::Csv, &csv_path, &cancel, |_| {})
            .await
            .unwrap();
        assert_eq!(n as usize, N);
        let csv = std::fs::read_to_string(&csv_path).unwrap();
        assert_eq!(csv.lines().count(), N + 1);
        assert!(csv.starts_with("a,b\r\n1,\"n,1\"\r\n"));

        assert!(mgr
            .export("e", "DELETE FROM t", ExportFormat::Csv, &csv_path, &cancel, |_| {})
            .await
            .is_err());

        cancel.store(true, Ordering::Relaxed);
        assert!(mgr
            .export("e", "SELECT * FROM t", ExportFormat::Csv, &csv_path, &cancel, |_| {})
            .await
            .is_err());
        assert!(!csv_path.exists(), "a cancelled export leaves no partial file");
        let _ = std::fs::remove_file(&json_path);
    }

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

    #[test]
    fn literals_are_quoted_and_escaped() {
        assert_eq!(Backend::Sqlite.quote_literal("o'k"), "'o''k'");
        // Backslash is literal in standard Postgres strings, an escape in MySQL.
        assert_eq!(Backend::Postgres.quote_literal("a\\b"), "'a\\b'");
        assert_eq!(Backend::Mysql.quote_literal("a\\'b"), "'a\\\\''b'");
    }

    /// The SQLite schema queries against a real table: PK, NOT NULL, default,
    /// a composite index in index order, and an implicit-PK foreign key. The
    /// table name carries a quote to exercise the literal escaping.
    #[tokio::test]
    async fn sqlite_schema() {
        let mgr = DbManager::new();
        mgr.connect("s", "sqlite::memory:").await.unwrap();
        mgr.query(
            "s",
            "CREATE TABLE parent (id INTEGER PRIMARY KEY); \
             CREATE TABLE \"child's\" ( \
               id INTEGER PRIMARY KEY, \
               parent_id INTEGER NOT NULL REFERENCES parent, \
               name TEXT DEFAULT 'x', \
               age INT); \
             CREATE UNIQUE INDEX child_name_age ON \"child's\" (age, name);",
        )
        .await
        .unwrap();

        let s = mgr.schema("s", "child's").await.unwrap();
        let names: Vec<_> = s.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["id", "parent_id", "name", "age"]);
        assert!(s.columns[0].primary_key);
        assert!(!s.columns[1].nullable && !s.columns[1].primary_key);
        assert!(s.columns[2].nullable);
        assert_eq!(s.columns[2].default.as_deref(), Some("'x'"));
        assert_eq!(s.columns[3].default, None);
        assert_eq!(s.columns[3].data_type, "INT");

        assert_eq!(s.indexes.len(), 1);
        assert_eq!(s.indexes[0].name, "child_name_age");
        assert_eq!(s.indexes[0].columns, "age, name");
        assert!(s.indexes[0].unique);

        assert_eq!(s.foreign_keys.len(), 1);
        assert_eq!(s.foreign_keys[0].columns, "parent_id");
        assert_eq!(s.foreign_keys[0].references, "parent");
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
