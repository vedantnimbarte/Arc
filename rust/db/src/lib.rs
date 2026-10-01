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
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use dashmap::DashMap;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::pool::PoolConnection;
use sqlx::{
    mysql::MySqlPoolOptions, postgres::PgPoolOptions, sqlite::SqlitePoolOptions, Column, Either,
    MySql, MySqlPool, PgPool, Postgres, Row, Sqlite, SqlitePool, TypeInfo, ValueRef,
};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

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

    /// The four read-only catalog queries behind [`DbManager::schema`]:
    /// columns, indexes, foreign keys, check constraints. Each returns text
    /// cells in the order `schema` reads them, with flags spelled `YES`/`NO`
    /// the way `information_schema.columns.is_nullable` already is.
    ///
    /// SQLite has no catalog for CHECK constraints; its fourth query returns
    /// the table's `CREATE TABLE` text for [`sqlite_checks`] to scan.
    fn schema_sql(self, table: &str) -> [String; 4] {
        match self {
            Backend::Postgres => {
                let regclass = format!("{}::regclass", self.quote_literal(&self.quote_ident(table)));
                [
                    // pg_attribute + format_type rather than information_schema:
                    // it keeps the type modifier (`character varying(255)`,
                    // `numeric(10,2)`, `integer[]`), which DDL generation needs.
                    format!(
                        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
                           CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, \
                           pg_get_expr(d.adbin, d.adrelid), \
                           CASE WHEN EXISTS ( \
                             SELECT 1 FROM pg_index i \
                             WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey) \
                           ) THEN 'YES' ELSE 'NO' END \
                         FROM pg_attribute a \
                         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                         WHERE a.attrelid = {regclass} AND a.attnum > 0 AND NOT a.attisdropped \
                         ORDER BY a.attnum"
                    ),
                    // information_schema has no indexes. pg_index is the cheap
                    // catalog, and pg_get_indexdef renders expression columns.
                    // An index a PK/UNIQUE/EXCLUDE constraint owns is "implicit":
                    // it comes and goes with its constraint, not DROP INDEX.
                    format!(
                        "SELECT i.relname, \
                           (SELECT string_agg(pg_get_indexdef(ix.indexrelid, k, true), ', ' ORDER BY k) \
                            FROM generate_series(1, ix.indnatts) k), \
                           CASE WHEN ix.indisunique THEN 'YES' ELSE 'NO' END, \
                           CASE WHEN ix.indisprimary THEN 'YES' ELSE 'NO' END, \
                           CASE WHEN EXISTS ( \
                             SELECT 1 FROM pg_constraint c \
                             WHERE c.conindid = ix.indexrelid AND c.conrelid = ix.indrelid \
                               AND c.contype IN ('p', 'u', 'x') \
                           ) THEN 'YES' ELSE 'NO' END, \
                           pg_get_indexdef(ix.indexrelid) \
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
                    format!(
                        "SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint \
                         WHERE conrelid = {regclass} AND contype = 'c' ORDER BY 1"
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
                    // MySQL's UNIQUE keys are plain indexes (DROP INDEX works),
                    // so only the primary key counts as implicit.
                    format!(
                        "SELECT index_name, \
                           GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', '), \
                           CASE WHEN MIN(non_unique) = 0 THEN 'YES' ELSE 'NO' END, \
                           CASE WHEN index_name = 'PRIMARY' THEN 'YES' ELSE 'NO' END, \
                           CASE WHEN index_name = 'PRIMARY' THEN 'YES' ELSE 'NO' END, \
                           NULL \
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
                    // check_constraints needs MySQL 8.0.16+ / MariaDB 10.2+;
                    // `schema` treats a failure here as "no checks".
                    format!(
                        "SELECT cc.constraint_name, cc.check_clause \
                         FROM information_schema.check_constraints cc \
                         JOIN information_schema.table_constraints tc \
                           ON tc.constraint_schema = cc.constraint_schema \
                          AND tc.constraint_name = cc.constraint_name \
                         WHERE tc.table_schema = DATABASE() AND tc.table_name = {name} \
                           AND tc.constraint_type = 'CHECK' \
                         ORDER BY 1"
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
                    // origin: 'c' = CREATE INDEX, 'pk' / 'u' = made by a
                    // PRIMARY KEY / UNIQUE constraint, and not droppable.
                    format!(
                        "SELECT il.name, \
                           (SELECT group_concat(name, ', ') FROM \
                             (SELECT name FROM pragma_index_info(il.name) ORDER BY seqno)), \
                           CASE WHEN il.\"unique\" THEN 'YES' ELSE 'NO' END, \
                           CASE WHEN il.origin = 'pk' THEN 'YES' ELSE 'NO' END, \
                           CASE WHEN il.origin IN ('pk', 'u') THEN 'YES' ELSE 'NO' END, \
                           (SELECT sql FROM sqlite_master WHERE type = 'index' AND name = il.name) \
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
                    format!("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = {name}"),
                ]
            }
        }
    }
}

/// The expression part of a check constraint, as `(…)`. Postgres renders the
/// whole clause (`CHECK ((price > 0)) NOT VALID`), MySQL just the condition.
fn check_expression(raw: &str) -> String {
    let mut s = raw.trim();
    if s.len() >= 5 && s[..5].eq_ignore_ascii_case("check") {
        s = s[5..].trim_start();
    }
    if let Some(rest) = s.strip_suffix("NOT VALID") {
        s = rest.trim_end();
    }
    if s.starts_with('(') && s.ends_with(')') {
        s.to_string()
    } else {
        format!("({s})")
    }
}

/// CHECK constraints in a SQLite `CREATE TABLE` statement — SQLite keeps no
/// catalog of them. A scanner, not a parser: it skips quoted text and picks
/// out `[CONSTRAINT name] CHECK (…)`, column-level or table-level.
fn sqlite_checks(create_sql: &str) -> Vec<CheckInfo> {
    let chars: Vec<char> = create_sql.chars().collect();
    let mut out = Vec::new();
    // Bare words since the last separator, to find `CONSTRAINT <name>`.
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, '\'' | '"' | '`' | '[') {
            let close = if c == '[' { ']' } else { c };
            let start = i + 1;
            i = start;
            while i < chars.len() && chars[i] != close {
                i += 1;
            }
            if c != '\'' {
                // A quoted identifier can be a constraint name.
                words.push(chars[start..i.min(chars.len())].iter().collect());
            }
            i += 1;
        } else if c.is_alphanumeric() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            if word.eq_ignore_ascii_case("check") {
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && chars[j] == '(' {
                    let end = matching_paren(&chars, j);
                    let name = match words.as_slice() {
                        [.., kw, name] if kw.eq_ignore_ascii_case("constraint") => name.clone(),
                        _ => String::new(),
                    };
                    out.push(CheckInfo {
                        name,
                        expression: chars[j..=end].iter().collect(),
                    });
                    words.clear();
                    i = end + 1;
                    continue;
                }
            }
            words.push(word);
        } else {
            if matches!(c, ',' | '(' | ')') {
                words.clear();
            }
            i += 1;
        }
    }
    out
}

/// Index of the `)` closing the `(` at `open`, skipping quoted text. The last
/// index when unbalanced.
fn matching_paren(chars: &[char], open: usize) -> usize {
    let mut depth = 0;
    let mut quote: Option<char> = None;
    for (i, &c) in chars.iter().enumerate().skip(open) {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '[' => quote = Some(']'),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            _ => {}
        }
    }
    chars.len() - 1
}

/// Parse CSV text (RFC 4180, the shape [`DbManager::export`] writes). Keeps
/// NULL and the empty string apart the same way export does: an empty
/// *unquoted* field is `None`, a quoted `""` is `Some("")`. A leading BOM is
/// dropped, and blank lines are skipped.
pub fn parse_csv(text: &str) -> Vec<Vec<Option<String>>> {
    fn take(field: &mut String, quoted: &mut bool) -> Option<String> {
        let f = std::mem::take(field);
        if f.is_empty() && !std::mem::replace(quoted, false) {
            None
        } else {
            *quoted = false;
            Some(f)
        }
    }
    fn push_row(rows: &mut Vec<Vec<Option<String>>>, row: Vec<Option<String>>) {
        if !(row.len() == 1 && row[0].is_none()) {
            rows.push(row);
        }
    }

    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() && !quoted => {
                in_quotes = true;
                quoted = true;
            }
            ',' => row.push(take(&mut field, &mut quoted)),
            '\r' => {}
            '\n' => {
                row.push(take(&mut field, &mut quoted));
                push_row(&mut rows, std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || quoted || !row.is_empty() {
        row.push(take(&mut field, &mut quoted));
        push_row(&mut rows, row);
    }
    rows
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
    pub checks: Vec<CheckInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckInfo {
    /// Empty for an unnamed SQLite check.
    pub name: String,
    /// The condition, parenthesized: `(price > 0)`.
    pub expression: String,
}

/// A table's row count, for the sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct RowCount {
    pub table: String,
    /// `None` when the catalog has no estimate yet (never analyzed).
    pub rows: Option<i64>,
    /// A catalog estimate (Postgres/MySQL) rather than a `COUNT(*)`.
    pub estimated: bool,
}

/// What [`DbManager::import_csv`] loads, and where.
#[derive(Debug, Clone, Deserialize)]
pub struct ImportSpec {
    pub table: String,
    /// Target columns, in the order of `sources`.
    pub columns: Vec<String>,
    /// For each target column, the CSV field index it reads.
    pub sources: Vec<usize>,
    /// Skip the first record.
    pub has_header: bool,
}

/// First records of a CSV file, for the import dialog's mapping step.
#[derive(Debug, Clone, Serialize)]
pub struct CsvPreview {
    pub rows: Vec<Vec<Option<String>>>,
    /// Records in the whole file, header included.
    pub total_rows: usize,
}

/// Rows per INSERT during an import. Well under every dialect's statement and
/// parameter limits, big enough that a 100k-row file is 500 round trips.
const IMPORT_BATCH: usize = 200;

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
    /// Backs the primary key.
    pub primary: bool,
    /// Owned by a constraint (PK, or a UNIQUE constraint on Postgres/SQLite):
    /// created and dropped with it, never by CREATE/DROP INDEX.
    pub implicit: bool,
    /// The server's own `CREATE INDEX` text, where it keeps one (Postgres,
    /// SQLite). MySQL has none; DDL is rebuilt from `columns` there.
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyInfo {
    /// Empty on SQLite, whose foreign keys have no names.
    pub name: String,
    pub columns: String,
    /// `table(col, …)`.
    pub references: String,
}

#[derive(Clone)]
enum Pool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

/// One connection checked out of a [`Pool`].
enum Conn {
    Postgres(PoolConnection<Postgres>),
    Mysql(PoolConnection<MySql>),
    Sqlite(PoolConnection<Sqlite>),
}

impl Conn {
    fn backend(&self) -> Backend {
        match self {
            Conn::Postgres(_) => Backend::Postgres,
            Conn::Mysql(_) => Backend::Mysql,
            Conn::Sqlite(_) => Backend::Sqlite,
        }
    }

    /// Close this connection instead of returning it to the pool — for one
    /// whose transaction state is unknown. The server rolls back whatever was
    /// open when the socket goes.
    fn discard(self) {
        match self {
            Conn::Postgres(c) => drop(c.detach()),
            Conn::Mysql(c) => drop(c.detach()),
            Conn::Sqlite(c) => drop(c.detach()),
        }
    }
}

async fn acquire(pool: &Pool) -> Result<Conn> {
    Ok(match pool {
        Pool::Postgres(p) => Conn::Postgres(p.acquire().await?),
        Pool::Mysql(p) => Conn::Mysql(p.acquire().await?),
        Pool::Sqlite(p) => Conn::Sqlite(p.acquire().await?),
    })
}

/// One live connection id: its pool, and the connection a manual transaction
/// is pinned to.
struct Entry {
    pool: Pool,
    /// `Some` between [`DbManager::begin`] and commit/rollback. Every call on
    /// this id runs on it meanwhile, so reads see the transaction's own
    /// uncommitted writes — and SQLite's single-connection pool isn't left
    /// waiting on a connection the transaction holds.
    tx: Arc<AsyncMutex<Option<Conn>>>,
    in_tx: Arc<AtomicBool>,
}

/// The connection one call runs on: the pinned transaction connection, or one
/// checked out of the pool for the duration.
struct Lease {
    pool: Pool,
    slot: Slot,
}

enum Slot {
    Pinned(OwnedMutexGuard<Option<Conn>>),
    Owned(Option<Conn>),
}

impl Lease {
    fn conn(&mut self) -> &mut Conn {
        match &mut self.slot {
            Slot::Pinned(g) => g.as_mut().expect("a pinned lease holds a connection"),
            Slot::Owned(c) => c.as_mut().expect("an owned lease holds a connection"),
        }
    }

    fn pinned(&self) -> bool {
        matches!(self.slot, Slot::Pinned(_))
    }

    /// Undo the transaction this lease opened itself. If even ROLLBACK fails,
    /// the connection is closed rather than handed to the next caller
    /// mid-transaction.
    async fn rollback(&mut self) {
        if run(self.conn(), "ROLLBACK").await.is_err() {
            if let Slot::Owned(c) = &mut self.slot {
                if let Some(c) = c.take() {
                    c.discard();
                }
            }
        }
    }
}

/// How to stop a running statement, keyed by the frontend's query id.
#[derive(Clone)]
enum Canceller {
    /// `pg_cancel_backend(pid)`, sent on another pooled connection.
    Postgres(PgPool, i32),
    /// `KILL QUERY <connection id>`, sent on another pooled connection.
    Mysql(MySqlPool, u64),
    /// The running connection's `sqlite3*`, for `sqlite3_interrupt`. Valid
    /// while the entry exists: it is removed before that connection is
    /// released (see [`Registered`]).
    Sqlite(usize),
}

/// Removes a query's [`Canceller`] when the query ends. Declared after the
/// [`Lease`] it guards, so it drops — and deregisters — first.
struct Registered<'a> {
    running: &'a DashMap<String, Canceller>,
    id: String,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.running.remove(&self.id);
    }
}

/// Live connection pools, keyed by the frontend's connection id. Cheap to
/// clone (the DashMap is behind the manager, which is `.manage()`d once).
#[derive(Default)]
pub struct DbManager {
    entries: DashMap<String, Entry>,
    running: DashMap<String, Canceller>,
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
        // fat pool against a shared dev database is rude. Four leaves room
        // for a pinned transaction, a running query, its cancel, and the
        // analytics view's poll.
        let pool = match backend {
            Backend::Postgres => Pool::Postgres(
                PgPoolOptions::new()
                    .max_connections(4)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect(url)
                    .await
                    .context("could not connect")?,
            ),
            Backend::Mysql => Pool::Mysql(
                MySqlPoolOptions::new()
                    .max_connections(4)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect(url)
                    .await
                    .context("could not connect")?,
            ),
            // One connection: `sqlite::memory:` is a separate database per
            // connection.
            Backend::Sqlite => Pool::Sqlite(
                SqlitePoolOptions::new()
                    .max_connections(1)
                    .acquire_timeout(CONNECT_TIMEOUT)
                    .connect(url)
                    .await
                    .context("could not connect")?,
            ),
        };
        if let Some((_, old)) = self.entries.remove(id) {
            close_entry(old).await;
        }
        self.entries.insert(
            id.to_string(),
            Entry {
                pool,
                tx: Default::default(),
                in_tx: Default::default(),
            },
        );
        Ok(backend)
    }

    /// Close the pool. An open manual transaction is rolled back (by closing
    /// its connection).
    pub async fn disconnect(&self, id: &str) {
        if let Some((_, entry)) = self.entries.remove(id) {
            close_entry(entry).await;
        }
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    /// True between [`begin`](Self::begin) and commit/rollback.
    pub fn in_transaction(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.in_tx.load(Ordering::Relaxed))
    }

    /// The pool and transaction slot for `id`, cloned out of the map — holding
    /// a DashMap guard across an await deadlocks the shard on the next access
    /// from the same task.
    fn parts(&self, id: &str) -> Result<(Pool, Arc<AsyncMutex<Option<Conn>>>, Arc<AtomicBool>)> {
        let e = self
            .entries
            .get(id)
            .ok_or_else(|| anyhow!("not connected — open the connection first"))?;
        Ok((e.pool.clone(), e.tx.clone(), e.in_tx.clone()))
    }

    async fn lease(&self, id: &str) -> Result<Lease> {
        let (pool, tx, _) = self.parts(id)?;
        let guard = tx.lock_owned().await;
        if guard.is_some() {
            return Ok(Lease {
                pool,
                slot: Slot::Pinned(guard),
            });
        }
        drop(guard);
        let conn = acquire(&pool).await?;
        Ok(Lease {
            pool,
            slot: Slot::Owned(Some(conn)),
        })
    }

    /// Run `sql` on connection `id`. With a `query_id`, the statement can be
    /// stopped from elsewhere with [`cancel`](Self::cancel) while it runs.
    pub async fn query(&self, id: &str, sql: &str, query_id: Option<&str>) -> Result<QueryResult> {
        let mut lease = self.lease(id).await?;
        let _registered = match query_id {
            Some(q) => Some(self.register(q, &mut lease).await?),
            None => None,
        };
        run(lease.conn(), sql).await
    }

    /// Run the analytics view's catalog/stats SQL. Unlike [`query`](Self::query)
    /// it never touches a pinned transaction on Postgres/MySQL — a failing
    /// poll must not abort the user's transaction — and the caller keeps it
    /// out of history. SQLite has one connection, so it shares the lease.
    pub async fn stats(&self, id: &str, sql: &str) -> Result<QueryResult> {
        let (pool, _, _) = self.parts(id)?;
        if matches!(pool, Pool::Sqlite(_)) {
            let mut lease = self.lease(id).await?;
            return run(lease.conn(), sql).await;
        }
        let mut conn = acquire(&pool).await?;
        run(&mut conn, sql).await
    }

    /// Note how to cancel whatever runs next on `lease`'s connection.
    async fn register(&self, query_id: &str, lease: &mut Lease) -> Result<Registered<'_>> {
        let pool = lease.pool.clone();
        let canceller = match (lease.conn(), pool) {
            (Conn::Postgres(c), Pool::Postgres(p)) => {
                let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                    .fetch_one(&mut **c)
                    .await?;
                Canceller::Postgres(p, pid)
            }
            (Conn::Mysql(c), Pool::Mysql(p)) => {
                let conn_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                    .fetch_one(&mut **c)
                    .await?;
                Canceller::Mysql(p, conn_id)
            }
            (Conn::Sqlite(c), Pool::Sqlite(_)) => {
                let handle = c.lock_handle().await?.as_raw_handle().as_ptr() as usize;
                Canceller::Sqlite(handle)
            }
            _ => unreachable!("a lease's connection comes from its own pool"),
        };
        self.running.insert(query_id.to_string(), canceller);
        Ok(Registered {
            running: &self.running,
            id: query_id.to_string(),
        })
    }

    /// Ask the server to stop the statement running under `query_id`. A no-op
    /// when it has already finished. The statement then fails with the
    /// server's own "cancelled" error; inside a manual transaction Postgres
    /// marks the transaction failed and SQLite rolls it back.
    pub async fn cancel(&self, query_id: &str) -> Result<()> {
        let remote = match self.running.get(query_id).as_deref() {
            None => return Ok(()),
            Some(Canceller::Sqlite(handle)) => {
                // SAFETY: `handle` is the `sqlite3*` of a connection the
                // running query still holds. Its entry is removed before that
                // connection is released, and removal needs this shard's
                // write lock, which the read guard we're under excludes.
                // `sqlite3_interrupt` is documented safe to call from any
                // thread while a statement runs.
                unsafe { libsqlite3_sys::sqlite3_interrupt(*handle as *mut libsqlite3_sys::sqlite3) };
                return Ok(());
            }
            Some(c) => c.clone(),
        };
        match remote {
            Canceller::Postgres(pool, pid) => {
                sqlx::query("SELECT pg_cancel_backend($1)")
                    .bind(pid)
                    .execute(&pool)
                    .await?;
            }
            Canceller::Mysql(pool, conn_id) => {
                sqlx::raw_sql(&format!("KILL QUERY {conn_id}"))
                    .execute(&pool)
                    .await?;
            }
            Canceller::Sqlite(_) => unreachable!("handled above"),
        }
        Ok(())
    }

    /// Open a manual transaction: pin a connection and run BEGIN on it.
    pub async fn begin(&self, id: &str) -> Result<()> {
        let (pool, tx, in_tx) = self.parts(id)?;
        let mut slot = tx.lock_owned().await;
        if slot.is_some() {
            bail!("a transaction is already open");
        }
        let mut conn = acquire(&pool).await?;
        run(&mut conn, "BEGIN").await?;
        *slot = Some(conn);
        in_tx.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub async fn commit(&self, id: &str) -> Result<()> {
        self.finish(id, "COMMIT").await
    }

    pub async fn rollback(&self, id: &str) -> Result<()> {
        self.finish(id, "ROLLBACK").await
    }

    async fn finish(&self, id: &str, verb: &str) -> Result<()> {
        let (_, tx, in_tx) = self.parts(id)?;
        let conn = tx.lock().await.take();
        in_tx.store(false, Ordering::Relaxed);
        let Some(mut conn) = conn else {
            bail!("no transaction is open");
        };
        let res = run(&mut conn, verb).await.map(|_| ());
        if res.is_err() {
            // Whatever state it's in, it isn't going back to the pool.
            conn.discard();
        }
        res
    }

    /// Run `statements` as one unit: all or nothing. Inside a manual
    /// transaction they join it (and the user commits); otherwise they get a
    /// transaction of their own. Returns the total rows affected.
    pub async fn apply(&self, id: &str, statements: &[String]) -> Result<u64> {
        let mut lease = self.lease(id).await?;
        let own_tx = !lease.pinned();
        let n = statements.len();
        let res = async {
            let conn = lease.conn();
            if own_tx {
                run(conn, "BEGIN").await?;
            }
            let mut affected = 0;
            for (i, sql) in statements.iter().enumerate() {
                affected += run(conn, sql)
                    .await
                    .with_context(|| format!("statement {} of {n}", i + 1))?
                    .rows_affected;
            }
            if own_tx {
                run(conn, "COMMIT").await?;
            }
            Ok(affected)
        }
        .await;
        if res.is_err() && own_tx {
            lease.rollback().await;
        }
        res
    }

    /// Every user table/view in the connected database, dialect-aware.
    pub async fn tables(&self, id: &str) -> Result<Vec<String>> {
        let mut lease = self.lease(id).await?;
        let conn = lease.conn();
        let res = run(conn, conn.backend().tables_sql()).await?;
        Ok(first_column(res))
    }

    /// Row counts for the sidebar: catalog estimates on Postgres/MySQL (a
    /// `COUNT(*)` of every table can take minutes on a real database), exact
    /// counts on SQLite, where the file is local and small.
    pub async fn row_counts(&self, id: &str) -> Result<Vec<RowCount>> {
        let mut lease = self.lease(id).await?;
        let conn = lease.conn();
        let estimate_sql = match conn.backend() {
            Backend::Postgres => {
                "SELECT n.nspname || '.' || c.relname, c.reltuples::bigint \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relkind IN ('r', 'p', 'm', 'f') \
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
                   AND n.nspname NOT LIKE 'pg_toast%'"
            }
            Backend::Mysql => {
                "SELECT table_name, table_rows FROM information_schema.tables \
                 WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
            }
            Backend::Sqlite => {
                let tables = first_column(
                    run(
                        conn,
                        "SELECT name FROM sqlite_master \
                         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    )
                    .await?,
                );
                let mut out = Vec::with_capacity(tables.len());
                for table in tables {
                    let sql = format!("SELECT COUNT(*) FROM {}", Backend::Sqlite.quote_ident(&table));
                    let rows = first_column(run(conn, &sql).await?)
                        .first()
                        .and_then(|n| n.parse().ok());
                    out.push(RowCount {
                        table,
                        rows,
                        estimated: false,
                    });
                }
                return Ok(out);
            }
        };
        Ok(run(conn, estimate_sql)
            .await?
            .rows
            .into_iter()
            .filter_map(|mut r| {
                let table = r.get_mut(0)?.take()?;
                // Postgres reports -1 for a table that was never analyzed.
                let rows = r
                    .get_mut(1)
                    .and_then(Option::take)
                    .and_then(|n| n.parse::<i64>().ok())
                    .filter(|n| *n >= 0);
                Some(RowCount {
                    table,
                    rows,
                    estimated: true,
                })
            })
            .collect())
    }

    /// `SELECT COUNT(*)` of one table — the exact number behind an estimate.
    pub async fn exact_count(&self, id: &str, table: &str) -> Result<i64> {
        let mut lease = self.lease(id).await?;
        let conn = lease.conn();
        let sql = format!("SELECT COUNT(*) FROM {}", conn.backend().quote_ident(table));
        first_column(run(conn, &sql).await?)
            .first()
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| anyhow!("COUNT(*) returned nothing"))
    }

    /// `SELECT * FROM <table> LIMIT n` with the name quoted for the dialect —
    /// what a click on a table in the sidebar runs.
    pub async fn preview(&self, id: &str, table: &str, limit: u32) -> Result<QueryResult> {
        let mut lease = self.lease(id).await?;
        let conn = lease.conn();
        let sql = format!(
            "SELECT * FROM {} LIMIT {}",
            conn.backend().quote_ident(table),
            limit.min(MAX_ROWS as u32)
        );
        run(conn, &sql).await
    }

    /// Columns, indexes, foreign keys and check constraints of `table`, read
    /// from the catalog.
    pub async fn schema(&self, id: &str, table: &str) -> Result<TableSchema> {
        let mut lease = self.lease(id).await?;
        let conn = lease.conn();
        let backend = conn.backend();
        let [columns_sql, indexes_sql, fks_sql, checks_sql] = backend.schema_sql(table);
        fn text(r: &mut [Option<String>], i: usize) -> Option<String> {
            r.get_mut(i).and_then(Option::take)
        }
        fn yes(r: &mut [Option<String>], i: usize) -> bool {
            text(r, i).as_deref() == Some("YES")
        }

        let columns = run(conn, &columns_sql)
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
        let indexes = run(conn, &indexes_sql)
            .await?
            .rows
            .into_iter()
            .map(|mut r| IndexInfo {
                name: text(&mut r, 0).unwrap_or_default(),
                columns: text(&mut r, 1).unwrap_or_default(),
                unique: yes(&mut r, 2),
                primary: yes(&mut r, 3),
                implicit: yes(&mut r, 4),
                definition: text(&mut r, 5),
            })
            .collect();
        let foreign_keys = run(conn, &fks_sql)
            .await?
            .rows
            .into_iter()
            .map(|mut r| ForeignKeyInfo {
                name: text(&mut r, 0).unwrap_or_default(),
                columns: text(&mut r, 1).unwrap_or_default(),
                references: text(&mut r, 2).unwrap_or_default(),
            })
            .collect();
        let checks = match backend {
            Backend::Sqlite => first_column(run(conn, &checks_sql).await?)
                .first()
                .map(|sql| sqlite_checks(sql))
                .unwrap_or_default(),
            // An older MySQL has no check_constraints table: no checks.
            _ => run(conn, &checks_sql)
                .await
                .map(|r| r.rows)
                .unwrap_or_default()
                .into_iter()
                .map(|mut r| CheckInfo {
                    name: text(&mut r, 0).unwrap_or_default(),
                    expression: check_expression(&text(&mut r, 1).unwrap_or_default()),
                })
                .collect(),
        };
        Ok(TableSchema {
            columns,
            indexes,
            foreign_keys,
            checks,
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
        let mut lease = self.lease(id).await?;
        let file = tokio::fs::File::create(path)
            .await
            .with_context(|| format!("could not create {}", path.display()))?;
        let mut out = BufWriter::new(file);
        let res = export_to(lease.conn(), sql, format, &mut out, cancel, progress).await;
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

    /// Load a CSV file into `spec.table`, all or nothing, in batches of
    /// [`IMPORT_BATCH`] rows. Values go in as quoted literals so the server
    /// casts each to its column's type; an empty unquoted field is NULL.
    /// `progress` gets the running row count after each batch; `cancel` stops
    /// the import and rolls it back. Inside a manual transaction the rows join
    /// it instead, and nothing is committed here.
    //
    // ponytail: reads the whole file into memory. Fine into the hundreds of
    // MB; stream the parser if anyone imports bigger than that.
    pub async fn import_csv(
        &self,
        id: &str,
        path: &Path,
        spec: &ImportSpec,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64),
    ) -> Result<u64> {
        if spec.columns.is_empty() {
            bail!("map at least one column");
        }
        if spec.columns.len() != spec.sources.len() {
            bail!("every target column needs a source field");
        }
        let text = read_text(path).await?;
        let records = parse_csv(&text);
        let skip = usize::from(spec.has_header);
        let data = records.get(skip..).unwrap_or_default();

        let mut lease = self.lease(id).await?;
        let own_tx = !lease.pinned();
        let res = async {
            let conn = lease.conn();
            let backend = conn.backend();
            let prefix = format!(
                "INSERT INTO {} ({}) VALUES ",
                backend.quote_ident(&spec.table),
                spec.columns
                    .iter()
                    .map(|c| backend.quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            if own_tx {
                run(conn, "BEGIN").await?;
            }
            let mut done: u64 = 0;
            for (b, batch) in data.chunks(IMPORT_BATCH).enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    bail!("import cancelled");
                }
                let tuples: Vec<String> = batch
                    .iter()
                    .map(|record| {
                        let values: Vec<String> = spec
                            .sources
                            .iter()
                            .map(|&i| match record.get(i) {
                                Some(Some(v)) => backend.quote_literal(v),
                                _ => "NULL".to_string(),
                            })
                            .collect();
                        format!("({})", values.join(", "))
                    })
                    .collect();
                let first = b * IMPORT_BATCH + 1 + skip;
                run(conn, &format!("{prefix}{}", tuples.join(", ")))
                    .await
                    .with_context(|| {
                        format!("CSV records {first}–{}", first + batch.len() - 1)
                    })?;
                done += batch.len() as u64;
                progress(done);
            }
            if own_tx {
                run(conn, "COMMIT").await?;
            }
            Ok(done)
        }
        .await;
        if res.is_err() && own_tx {
            lease.rollback().await;
        }
        res
    }

    /// Close every pool. Called on app exit so servers see clean disconnects.
    pub async fn close_all(&self) {
        let ids: Vec<String> = self.entries.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }
}

/// The first `limit` records of a CSV file, plus how many it has in all.
pub async fn csv_preview(path: &Path, limit: usize) -> Result<CsvPreview> {
    let mut rows = parse_csv(&read_text(path).await?);
    let total_rows = rows.len();
    rows.truncate(limit);
    Ok(CsvPreview { rows, total_rows })
}

async fn read_text(path: &Path) -> Result<String> {
    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("could not read {}", path.display()))?;
    String::from_utf8(bytes).map_err(|_| anyhow!("{} is not UTF-8 text", path.display()))
}

/// Column 0 of every row, skipping NULLs.
fn first_column(res: QueryResult) -> Vec<String> {
    res.rows
        .into_iter()
        .filter_map(|mut r| if r.is_empty() { None } else { r.swap_remove(0) })
        .collect()
}

async fn close_entry(entry: Entry) {
    // `close` waits for every checked-out connection, so the pinned one has
    // to go first. Discarded, not returned: it's mid-transaction.
    if let Some(conn) = entry.tx.lock().await.take() {
        conn.discard();
    }
    match entry.pool {
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
    ($sql:expr, $conn:expr) => {{
        let mut columns: Vec<String> = Vec::new();
        let mut rows: Vec<Vec<Option<String>>> = Vec::new();
        let mut rows_affected: u64 = 0;
        let mut truncated = false;

        let mut stream = sqlx::raw_sql($sql).fetch_many($conn);
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

async fn run(conn: &mut Conn, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    let (columns, rows, rows_affected, truncated) = match conn {
        Conn::Postgres(c) => {
            fn cell(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            drain!(sql, &mut **c)
        }
        Conn::Mysql(c) => {
            fn cell(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            drain!(sql, &mut **c)
        }
        Conn::Sqlite(c) => {
            fn cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            drain!(sql, &mut **c)
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
    ($sql:expr, $conn:expr, $format:expr, $out:expr, $cancel:expr, $progress:expr) => {{
        let mut stream = sqlx::raw_sql($sql).fetch($conn);
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
    conn: &mut Conn,
    sql: &str,
    format: ExportFormat,
    out: &mut W,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<u64> {
    // ponytail: with zero rows there are no column names to read from the row
    // stream, so an empty CSV has no header. Describe the statement first if
    // that ever matters.
    let n = match conn {
        Conn::Postgres(c) => {
            fn cell(row: &sqlx::postgres::PgRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            export_rows!(sql, &mut **c, format, out, cancel, progress)
        }
        Conn::Mysql(c) => {
            fn cell(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            export_rows!(sql, &mut **c, format, out, cancel, progress)
        }
        Conn::Sqlite(c) => {
            fn cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> Option<String> {
                cell_body!(row, i)
            }
            export_rows!(sql, &mut **c, format, out, cancel, progress)
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
            None,
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
            None,
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
            .query("t", "CREATE TABLE t (a INTEGER, b TEXT, c REAL, d BLOB)", None)
            .await
            .unwrap();
        assert!(ddl.columns.is_empty());

        let ins = mgr
            .query(
                "t",
                "INSERT INTO t VALUES (1, 'x', 1.5, x'00ff'), (2, NULL, NULL, NULL), (3, '', 0.0, NULL)",
                None,
            )
            .await
            .unwrap();
        assert_eq!(ins.rows_affected, 3);

        let res = mgr.query("t", "SELECT a, b, c FROM t ORDER BY a", None).await.unwrap();
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
        assert!(mgr.query("nope", "SELECT 1", None).await.is_err());
    }

    fn cells(res: &QueryResult) -> Vec<Vec<Option<&str>>> {
        res.rows
            .iter()
            .map(|r| r.iter().map(Option::as_deref).collect())
            .collect()
    }

    #[test]
    fn csv_parsing_keeps_null_and_empty_apart() {
        let rows = parse_csv("\u{feff}a,b,c\r\n1,,\"\"\r\n\"x,\"\"y\"\"\",\"line\nbreak\",z\n\n2,3");
        assert_eq!(
            rows,
            vec![
                vec![Some("a".into()), Some("b".into()), Some("c".into())],
                vec![Some("1".into()), None, Some("".into())],
                vec![Some("x,\"y\"".into()), Some("line\nbreak".into()), Some("z".into())],
                vec![Some("2".into()), Some("3".into())],
            ]
        );
        assert!(parse_csv("").is_empty());
    }

    #[test]
    fn sqlite_check_constraints_are_scanned() {
        let sql = "CREATE TABLE \"t\" (\n  id INTEGER PRIMARY KEY,\n  \
                   price REAL CHECK (price > 0),\n  note TEXT DEFAULT 'CHECK (no)',\n  \
                   qty INT, CONSTRAINT qty_ok CHECK(qty BETWEEN 1 AND (10 * 2)),\n  \
                   CONSTRAINT [odd name] CHECK (note <> ')'))";
        let checks = sqlite_checks(sql);
        assert_eq!(checks.len(), 3, "{checks:?}");
        assert_eq!(checks[0].name, "");
        assert_eq!(checks[0].expression, "(price > 0)");
        assert_eq!(checks[1].name, "qty_ok");
        assert_eq!(checks[1].expression, "(qty BETWEEN 1 AND (10 * 2))");
        assert_eq!(checks[2].name, "odd name");
        assert_eq!(checks[2].expression, "(note <> ')')");

        assert_eq!(check_expression("CHECK ((price > (0)::numeric)) NOT VALID"), "((price > (0)::numeric))");
        assert_eq!(check_expression("(`qty` > 0)"), "(`qty` > 0)");
        assert_eq!(check_expression("qty > 0"), "(qty > 0)");
    }

    #[tokio::test]
    async fn sqlite_schema_reports_checks_and_index_origins() {
        let mgr = DbManager::new();
        mgr.connect("c", "sqlite::memory:").await.unwrap();
        mgr.query(
            "c",
            "CREATE TABLE t (id INTEGER PRIMARY KEY, code TEXT UNIQUE, n INT CHECK (n >= 0)); \
             CREATE INDEX t_n ON t (n);",
            None,
        )
        .await
        .unwrap();
        let s = mgr.schema("c", "t").await.unwrap();
        assert_eq!(s.checks.len(), 1);
        assert_eq!(s.checks[0].expression, "(n >= 0)");
        let by_name = |n: &str| s.indexes.iter().find(|i| i.name == n).unwrap();
        let explicit = by_name("t_n");
        assert!(!explicit.implicit && !explicit.primary);
        assert_eq!(explicit.definition.as_deref(), Some("CREATE INDEX t_n ON t (n)"));
        let auto = s.indexes.iter().find(|i| i.name.starts_with("sqlite_autoindex")).unwrap();
        assert!(auto.implicit && auto.unique && !auto.primary);
    }

    #[tokio::test]
    async fn manual_transactions_pin_one_connection() {
        let mgr = DbManager::new();
        mgr.connect("x", "sqlite::memory:").await.unwrap();
        mgr.query("x", "CREATE TABLE t (a INT)", None).await.unwrap();
        assert!(mgr.commit("x").await.is_err(), "nothing to commit yet");

        mgr.begin("x").await.unwrap();
        assert!(mgr.in_transaction("x"));
        assert!(mgr.begin("x").await.is_err(), "one transaction at a time");
        mgr.query("x", "INSERT INTO t VALUES (1)", None).await.unwrap();
        // Reads run on the pinned connection too — no deadlock on SQLite's
        // single connection, and the uncommitted row is visible.
        assert_eq!(mgr.exact_count("x", "t").await.unwrap(), 1);
        mgr.rollback("x").await.unwrap();
        assert!(!mgr.in_transaction("x"));
        assert_eq!(mgr.exact_count("x", "t").await.unwrap(), 0);

        mgr.begin("x").await.unwrap();
        mgr.query("x", "INSERT INTO t VALUES (2)", None).await.unwrap();
        mgr.commit("x").await.unwrap();
        assert_eq!(mgr.exact_count("x", "t").await.unwrap(), 1);

        // Disconnecting with a transaction open doesn't hang on the pinned
        // connection.
        mgr.begin("x").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), mgr.disconnect("x"))
            .await
            .expect("disconnect finishes");
        assert!(!mgr.is_connected("x"));
    }

    #[tokio::test]
    async fn apply_is_all_or_nothing() {
        let mgr = DbManager::new();
        mgr.connect("a", "sqlite::memory:").await.unwrap();
        mgr.query("a", "CREATE TABLE t (a INT PRIMARY KEY)", None).await.unwrap();

        let ok = vec!["INSERT INTO t VALUES (1)".into(), "INSERT INTO t VALUES (2)".into()];
        assert_eq!(mgr.apply("a", &ok).await.unwrap(), 2);

        let bad = vec![
            "INSERT INTO t VALUES (3)".to_string(),
            "INSERT INTO t VALUES (1)".to_string(), // duplicate key
        ];
        let err = mgr.apply("a", &bad).await.unwrap_err();
        assert!(format!("{err:#}").starts_with("statement 2 of 2"), "{err:#}");
        assert_eq!(mgr.exact_count("a", "t").await.unwrap(), 2, "row 3 rolled back");
        // The connection went back clean: a new transaction can start.
        mgr.begin("a").await.unwrap();
        mgr.rollback("a").await.unwrap();

        // Inside a manual transaction, apply joins it.
        mgr.begin("a").await.unwrap();
        mgr.apply("a", &["DELETE FROM t".to_string()]).await.unwrap();
        mgr.rollback("a").await.unwrap();
        assert_eq!(mgr.exact_count("a", "t").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn a_running_sqlite_query_can_be_cancelled() {
        let mgr = Arc::new(DbManager::new());
        mgr.connect("q", "sqlite::memory:").await.unwrap();
        let running = {
            let mgr = mgr.clone();
            tokio::spawn(async move {
                mgr.query(
                    "q",
                    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
                     SELECT count(*) FROM c",
                    Some("q1"),
                )
                .await
            })
        };
        // Wait until it's registered, then stop it.
        while !mgr.running.contains_key("q1") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        mgr.cancel("q1").await.unwrap();
        let res = tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("cancelled query returns")
            .unwrap();
        assert!(format!("{:#}", res.unwrap_err()).contains("interrupt"));
        assert!(mgr.running.is_empty());
        // The connection is still usable, and a stale cancel is a no-op.
        mgr.cancel("q1").await.unwrap();
        assert_eq!(mgr.query("q", "SELECT 1", None).await.unwrap().rows.len(), 1);
    }

    /// Against a real server: `ARC_TEST_PG_URL=postgres://postgres:pw@127.0.0.1:55432/postgres`
    /// (e.g. `docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine`).
    /// Skipped when unset.
    #[tokio::test]
    async fn postgres_catalog_cancel_and_transactions() {
        let Ok(url) = std::env::var("ARC_TEST_PG_URL") else {
            return;
        };
        let mgr = Arc::new(DbManager::new());
        mgr.connect("pg", &url).await.unwrap();
        mgr.query(
            "pg",
            "DROP SCHEMA IF EXISTS arc_t CASCADE; CREATE SCHEMA arc_t; \
             CREATE TYPE arc_t.mood AS ENUM ('ok', 'meh'); \
             CREATE TABLE arc_t.parent (id serial PRIMARY KEY, code varchar(12) UNIQUE); \
             CREATE TABLE arc_t.child ( \
               id bigint PRIMARY KEY, \
               parent_id int NOT NULL REFERENCES arc_t.parent(id), \
               price numeric(10,2) DEFAULT 0 CONSTRAINT price_pos CHECK (price >= 0), \
               tags text[], mood arc_t.mood); \
             CREATE INDEX child_parent ON arc_t.child (parent_id); \
             INSERT INTO arc_t.parent (code) VALUES ('a'), ('b'); ANALYZE arc_t.parent;",
            None,
        )
        .await
        .unwrap();

        let s = mgr.schema("pg", "arc_t.child").await.unwrap();
        let types: Vec<_> = s.columns.iter().map(|c| c.data_type.as_str()).collect();
        assert_eq!(types, vec!["bigint", "integer", "numeric(10,2)", "text[]", "arc_t.mood"]);
        assert!(s.columns[0].primary_key && !s.columns[0].nullable);
        assert_eq!(s.columns[2].default.as_deref(), Some("0"));
        assert_eq!(s.checks.len(), 1);
        assert_eq!(s.checks[0].name, "price_pos");
        assert_eq!(s.checks[0].expression, "(price >= 0::numeric)");
        let pk = s.indexes.iter().find(|i| i.primary).unwrap();
        assert!(pk.implicit && pk.unique);
        let ix = s.indexes.iter().find(|i| i.name == "child_parent").unwrap();
        assert!(!ix.implicit);
        assert!(ix.definition.as_deref().unwrap().starts_with("CREATE INDEX child_parent ON arc_t.child"));
        assert_eq!(s.foreign_keys[0].references, "arc_t.parent(id)");

        let p = mgr.schema("pg", "arc_t.parent").await.unwrap();
        let unique = p.indexes.iter().find(|i| i.name.contains("code")).unwrap();
        assert!(unique.implicit && unique.unique && !unique.primary, "UNIQUE constraint index");
        assert_eq!(p.columns[1].data_type, "character varying(12)");

        let counts = mgr.row_counts("pg").await.unwrap();
        let parent = counts.iter().find(|c| c.table == "arc_t.parent").unwrap();
        assert_eq!((parent.rows, parent.estimated), (Some(2), true));
        assert_eq!(mgr.exact_count("pg", "arc_t.parent").await.unwrap(), 2);

        // Cancel a sleeping statement.
        let running = {
            let mgr = mgr.clone();
            tokio::spawn(async move { mgr.query("pg", "SELECT pg_sleep(30)", Some("sleep")).await })
        };
        while !mgr.running.contains_key("sleep") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        mgr.cancel("sleep").await.unwrap();
        let err = tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("cancel lands")
            .unwrap()
            .unwrap_err();
        assert!(format!("{err:#}").contains("canceling statement"), "{err:#}");

        // A manual transaction is visible to itself and gone after rollback.
        mgr.begin("pg").await.unwrap();
        mgr.query("pg", "INSERT INTO arc_t.parent (code) VALUES ('c')", None).await.unwrap();
        assert_eq!(mgr.exact_count("pg", "arc_t.parent").await.unwrap(), 3);
        mgr.rollback("pg").await.unwrap();
        assert_eq!(mgr.exact_count("pg", "arc_t.parent").await.unwrap(), 2);

        // apply rolls back as a unit.
        let err = mgr
            .apply(
                "pg",
                &[
                    "INSERT INTO arc_t.parent (code) VALUES ('d')".into(),
                    "INSERT INTO arc_t.parent (code) VALUES ('a')".into(),
                ],
            )
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("statement 2 of 2"));
        assert_eq!(mgr.exact_count("pg", "arc_t.parent").await.unwrap(), 2);

        mgr.query("pg", "DROP SCHEMA arc_t CASCADE", None).await.unwrap();
        mgr.disconnect("pg").await;
    }

    /// Against a real server: `ARC_TEST_MYSQL_URL=mysql://root:pw@127.0.0.1:53306/arc`
    /// (e.g. `docker run --rm -e MYSQL_ROOT_PASSWORD=pw -e MYSQL_DATABASE=arc -p 53306:3306 mysql:8.4`).
    /// Skipped when unset.
    #[tokio::test]
    async fn mysql_catalog_cancel_and_transactions() {
        let Ok(url) = std::env::var("ARC_TEST_MYSQL_URL") else {
            return;
        };
        let mgr = Arc::new(DbManager::new());
        mgr.connect("my", &url).await.unwrap();
        mgr.query(
            "my",
            "DROP TABLE IF EXISTS arc_child; DROP TABLE IF EXISTS arc_parent; \
             CREATE TABLE arc_parent (id int AUTO_INCREMENT PRIMARY KEY, code varchar(12) UNIQUE) ENGINE=InnoDB; \
             CREATE TABLE arc_child ( \
               id bigint PRIMARY KEY, \
               parent_id int NOT NULL, \
               price decimal(10,2) DEFAULT 0, \
               CONSTRAINT price_pos CHECK (price >= 0), \
               CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES arc_parent(id)) ENGINE=InnoDB; \
             INSERT INTO arc_parent (code) VALUES ('a'), ('b');",
            None,
        )
        .await
        .unwrap();

        let s = mgr.schema("my", "arc_child").await.unwrap();
        let types: Vec<_> = s.columns.iter().map(|c| c.data_type.as_str()).collect();
        assert_eq!(types, vec!["bigint", "int", "decimal(10,2)"]);
        assert_eq!(s.checks.len(), 1);
        assert_eq!(s.checks[0].name, "price_pos");
        assert!(s.checks[0].expression.contains("price"), "{:?}", s.checks[0]);
        let pk = s.indexes.iter().find(|i| i.primary).unwrap();
        assert!(pk.implicit && pk.name == "PRIMARY");
        assert_eq!(s.foreign_keys[0].references, "arc_parent(id)");
        let p = mgr.schema("my", "arc_parent").await.unwrap();
        let code = p.indexes.iter().find(|i| i.name == "code").unwrap();
        assert!(code.unique && !code.implicit, "MySQL UNIQUE keys drop like indexes");

        let counts = mgr.row_counts("my").await.unwrap();
        assert!(counts.iter().any(|c| c.table == "arc_parent" && c.estimated));
        assert_eq!(mgr.exact_count("my", "arc_parent").await.unwrap(), 2);

        // KILL QUERY cuts SLEEP short (it returns 1 rather than failing).
        let started = Instant::now();
        let running = {
            let mgr = mgr.clone();
            tokio::spawn(async move { mgr.query("my", "SELECT SLEEP(30)", Some("sleep")).await })
        };
        while !mgr.running.contains_key("sleep") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        mgr.cancel("sleep").await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("cancel lands");
        assert!(started.elapsed() < Duration::from_secs(10));

        mgr.begin("my").await.unwrap();
        mgr.query("my", "INSERT INTO arc_parent (code) VALUES ('c')", None).await.unwrap();
        assert_eq!(mgr.exact_count("my", "arc_parent").await.unwrap(), 3);
        mgr.rollback("my").await.unwrap();
        assert_eq!(mgr.exact_count("my", "arc_parent").await.unwrap(), 2);

        let err = mgr
            .apply(
                "my",
                &[
                    "INSERT INTO arc_parent (code) VALUES ('d')".into(),
                    "INSERT INTO arc_parent (code) VALUES ('a')".into(),
                ],
            )
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("statement 2 of 2"));
        assert_eq!(mgr.exact_count("my", "arc_parent").await.unwrap(), 2);

        mgr.query("my", "DROP TABLE arc_child; DROP TABLE arc_parent", None).await.unwrap();
        mgr.disconnect("my").await;
    }

    #[tokio::test]
    async fn csv_import_maps_columns_and_rolls_back_on_error() {
        let mgr = DbManager::new();
        mgr.connect("i", "sqlite::memory:").await.unwrap();
        mgr.query(
            "i",
            "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, nick TEXT)",
            None,
        )
        .await
        .unwrap();
        let path = std::env::temp_dir().join(format!("arc-db-import-{}.csv", std::process::id()));
        // Columns in a different order than the table, and more of them.
        let mut csv = String::from("nick,ignored,id,name\n");
        for i in 1..=450 {
            let nick = if i == 2 { "" } else if i == 3 { "\"\"" } else { "n" };
            csv.push_str(&format!("{nick},x,{i},\"Name, {i}\"\n"));
        }
        std::fs::write(&path, &csv).unwrap();

        let preview = csv_preview(&path, 3).await.unwrap();
        assert_eq!(preview.total_rows, 451);
        assert_eq!(preview.rows.len(), 3);

        let spec = ImportSpec {
            table: "people".into(),
            columns: vec!["id".into(), "name".into(), "nick".into()],
            sources: vec![2, 3, 0],
            has_header: true,
        };
        let cancel = AtomicBool::new(false);
        let mut ticks = Vec::new();
        let n = mgr
            .import_csv("i", &path, &spec, &cancel, |n| ticks.push(n))
            .await
            .unwrap();
        assert_eq!(n, 450);
        assert_eq!(ticks, vec![200, 400, 450]);
        let res = mgr
            .query("i", "SELECT id, name, nick FROM people WHERE id <= 3 ORDER BY id", None)
            .await
            .unwrap();
        assert_eq!(
            cells(&res),
            vec![
                vec![Some("1"), Some("Name, 1"), Some("n")],
                vec![Some("2"), Some("Name, 2"), None],
                vec![Some("3"), Some("Name, 3"), Some("")],
            ]
        );

        // Importing again collides on every id: the batch fails and nothing
        // from this import stays.
        let err = mgr
            .import_csv("i", &path, &spec, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("CSV records 2–201"), "{err:#}");
        assert_eq!(mgr.exact_count("i", "people").await.unwrap(), 450);

        let counts = mgr.row_counts("i").await.unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].rows, Some(450));
        assert!(!counts[0].estimated);
        let _ = std::fs::remove_file(&path);
    }
}
