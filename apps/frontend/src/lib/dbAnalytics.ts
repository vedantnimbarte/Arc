// Analytics view: per-backend catalog SQL, and turning cumulative server
// counters into the per-second series the live charts draw. Every query here
// runs through `dbStats` — off the history, outside any open transaction.
import type { DbBackend, DbQueryResult } from './tauri';

export type Counters = Record<string, number>;

/** One live chart: which counters it draws, and whether they are cumulative
 *  (drawn as a per-second rate) or gauges (drawn as-is). */
export interface ChartSpec {
  title: string;
  unit: string;
  rate: boolean;
  series: { key: string; label: string }[];
}

export interface Column {
  key: string;
  label: string;
  format?: 'bytes' | 'num' | 'secs';
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
}

export interface Section {
  sql: string;
  columns: Column[];
  /** Shown when the query fails — usually a missing extension/privilege. */
  unavailable: string;
}

export interface Dialect {
  /** One poll's counters; null on SQLite, which has no server to ask. */
  counters: string | null;
  charts: ChartSpec[];
  overview: string;
  tables: Section;
  unusedIndexes: Section | null;
  activity: Section | null;
  locks: Section | null;
  /** SQL that stops session `pid`, by how hard. */
  stop: ((pid: number, hard: boolean) => string) | null;
}

const SESSIONS: ChartSpec = {
  title: 'Sessions',
  unit: '',
  rate: false,
  series: [
    { key: 'total', label: 'Total' },
    { key: 'active', label: 'Active' },
    { key: 'idle', label: 'Idle' },
  ],
};
const TRANSACTIONS: ChartSpec = {
  title: 'Transactions',
  unit: '/s',
  rate: true,
  series: [
    { key: 'commits', label: 'Commits' },
    { key: 'rollbacks', label: 'Rollbacks' },
  ],
};
const ROWS_IN: ChartSpec = {
  title: 'Rows written',
  unit: '/s',
  rate: true,
  series: [
    { key: 'inserted', label: 'Inserted' },
    { key: 'updated', label: 'Updated' },
    { key: 'deleted', label: 'Deleted' },
  ],
};
const BLOCK_IO: ChartSpec = {
  title: 'Block I/O',
  unit: '/s',
  rate: true,
  series: [
    { key: 'disk_reads', label: 'Disk reads' },
    { key: 'cache_hits', label: 'Cache hits' },
  ],
};

const TABLE_COLUMNS: Column[] = [
  { key: 'name', label: 'Table' },
  { key: 'total_bytes', label: 'Total size', format: 'bytes', numeric: true },
  { key: 'index_bytes', label: 'Indexes', format: 'bytes', numeric: true },
  { key: 'live', label: 'Rows', format: 'num', numeric: true },
];

const ACTIVITY_COLUMNS: Column[] = [
  { key: 'pid', label: 'PID', numeric: true },
  { key: 'user', label: 'User' },
  { key: 'client', label: 'Client' },
  { key: 'state', label: 'State' },
  { key: 'waiting', label: 'Waiting on' },
  { key: 'secs', label: 'Running', format: 'secs', numeric: true },
  { key: 'query', label: 'Query' },
];

const LOCK_COLUMNS: Column[] = [
  { key: 'pid', label: 'PID', numeric: true },
  { key: 'locktype', label: 'Type' },
  { key: 'relation', label: 'Object' },
  { key: 'mode', label: 'Mode' },
  { key: 'granted', label: 'Granted' },
];

const INDEX_COLUMNS: Column[] = [
  { key: 'index_name', label: 'Index' },
  { key: 'table_name', label: 'Table' },
  { key: 'bytes', label: 'Size', format: 'bytes', numeric: true },
];

const POSTGRES: Dialect = {
  counters: `SELECT
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend') AS total,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active') AS active,
  (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle%') AS idle,
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS server_sessions,
  xact_commit AS commits, xact_rollback AS rollbacks,
  tup_inserted AS inserted, tup_updated AS updated, tup_deleted AS deleted,
  tup_fetched AS fetched, tup_returned AS returned,
  blks_read AS disk_reads, blks_hit AS cache_hits
FROM pg_stat_database WHERE datname = current_database()`,
  charts: [
    SESSIONS,
    TRANSACTIONS,
    ROWS_IN,
    {
      title: 'Rows read',
      unit: '/s',
      rate: true,
      series: [
        { key: 'fetched', label: 'Fetched' },
        { key: 'returned', label: 'Returned' },
      ],
    },
    BLOCK_IO,
  ],
  overview: `SELECT pg_database_size(current_database()) AS size_bytes,
  current_setting('server_version') AS version,
  extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime_secs,
  current_setting('max_connections') AS max_connections`,
  tables: {
    sql: `SELECT n.nspname || '.' || c.relname AS name,
  pg_total_relation_size(c.oid) AS total_bytes, pg_indexes_size(c.oid) AS index_bytes,
  s.n_live_tup AS live, s.n_dead_tup AS dead,
  to_char(greatest(s.last_vacuum, s.last_autovacuum), 'YYYY-MM-DD HH24:MI') AS last_vacuum
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY 2 DESC LIMIT 20`,
    columns: [
      ...TABLE_COLUMNS,
      { key: 'dead', label: 'Dead rows', format: 'num', numeric: true },
      { key: 'last_vacuum', label: 'Last vacuum' },
    ],
    unavailable: 'Table sizes are unavailable on this server.',
  },
  unusedIndexes: {
    sql: `SELECT s.indexrelname AS index_name, s.schemaname || '.' || s.relname AS table_name,
  pg_relation_size(s.indexrelid) AS bytes
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY 3 DESC LIMIT 20`,
    columns: INDEX_COLUMNS,
    unavailable: 'Index usage stats are unavailable on this server.',
  },
  activity: {
    sql: `SELECT pid, usename AS "user", coalesce(client_addr::text, 'local') AS client, state,
  wait_event_type || coalesce(': ' || wait_event, '') AS waiting,
  extract(epoch FROM now() - coalesce(query_start, backend_start))::bigint AS secs,
  left(query, 400) AS query, pid = pg_backend_pid() AS self
FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend'
ORDER BY state = 'active' DESC, secs DESC`,
    columns: ACTIVITY_COLUMNS,
    unavailable: 'Session activity is unavailable — the role may lack pg_read_all_stats.',
  },
  locks: {
    sql: `SELECT l.pid, l.locktype, coalesce(c.relname, l.locktype) AS relation, l.mode,
  CASE WHEN l.granted THEN 'yes' ELSE 'waiting' END AS granted
FROM pg_locks l LEFT JOIN pg_class c ON c.oid = l.relation
WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY l.granted, l.pid LIMIT 200`,
    columns: LOCK_COLUMNS,
    unavailable: 'Lock information is unavailable on this server.',
  },
  stop: (pid, hard) => `SELECT ${hard ? 'pg_terminate_backend' : 'pg_cancel_backend'}(${pid})`,
};

/** Status variables the MySQL poll reads, renamed to the shared chart keys. */
const MYSQL_STATUS: Record<string, string> = {
  Threads_connected: 'total',
  Threads_running: 'active',
  Com_commit: 'commits',
  Com_rollback: 'rollbacks',
  Innodb_rows_inserted: 'inserted',
  Innodb_rows_updated: 'updated',
  Innodb_rows_deleted: 'deleted',
  Innodb_rows_read: 'read',
  Innodb_buffer_pool_reads: 'disk_reads',
  Innodb_buffer_pool_read_requests: 'cache_hits',
  Uptime: 'uptime_secs',
};

const MYSQL: Dialect = {
  counters: `SHOW GLOBAL STATUS WHERE Variable_name IN (${Object.keys(MYSQL_STATUS)
    .map((k) => `'${k}'`)
    .join(', ')})`,
  charts: [
    SESSIONS,
    TRANSACTIONS,
    ROWS_IN,
    { title: 'Rows read', unit: '/s', rate: true, series: [{ key: 'read', label: 'Read' }] },
    BLOCK_IO,
  ],
  overview: `SELECT VERSION() AS version, @@max_connections AS max_connections,
  (SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables
   WHERE table_schema = DATABASE()) AS size_bytes`,
  tables: {
    sql: `SELECT table_name AS name, data_length + index_length AS total_bytes,
  index_length AS index_bytes, table_rows AS live, data_free AS free_bytes
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
ORDER BY 2 DESC LIMIT 20`,
    columns: [
      ...TABLE_COLUMNS,
      { key: 'free_bytes', label: 'Free', format: 'bytes', numeric: true },
    ],
    unavailable: 'Table sizes are unavailable on this server.',
  },
  unusedIndexes: {
    sql: `SELECT index_name, object_name AS table_name, NULL AS bytes
FROM sys.schema_unused_indexes WHERE object_schema = DATABASE() LIMIT 20`,
    columns: INDEX_COLUMNS,
    unavailable: 'Unused-index stats need the sys schema and performance_schema.',
  },
  activity: {
    sql: `SELECT id AS pid, user AS \`user\`, host AS client, command AS state, state AS waiting,
  time AS secs, LEFT(info, 400) AS query, id = CONNECTION_ID() AS self
FROM information_schema.processlist
WHERE command <> 'Daemon'
ORDER BY command = 'Query' DESC, time DESC`,
    columns: ACTIVITY_COLUMNS,
    unavailable: 'Session activity is unavailable — the user may lack the PROCESS privilege.',
  },
  locks: {
    sql: `SELECT t.processlist_id AS pid, l.lock_type AS locktype,
  CONCAT_WS('.', l.object_schema, l.object_name) AS relation, l.lock_mode AS mode,
  IF(l.lock_status = 'GRANTED', 'yes', 'waiting') AS granted
FROM performance_schema.data_locks l
LEFT JOIN performance_schema.threads t ON t.thread_id = l.thread_id
ORDER BY l.lock_status <> 'GRANTED' DESC LIMIT 200`,
    columns: LOCK_COLUMNS,
    unavailable: 'Lock information needs MySQL 8 with performance_schema enabled.',
  },
  stop: (pid, hard) => `${hard ? 'KILL' : 'KILL QUERY'} ${pid}`,
};

const SQLITE: Dialect = {
  counters: null,
  charts: [],
  overview: `SELECT sqlite_version() AS version,
  (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS size_bytes,
  (SELECT freelist_count FROM pragma_freelist_count()) * (SELECT page_size FROM pragma_page_size()) AS free_bytes,
  (SELECT journal_mode FROM pragma_journal_mode()) AS journal_mode`,
  tables: {
    // dbstat is a compile-time option; without it the section says so.
    sql: `SELECT name, SUM(pgsize) AS total_bytes FROM dbstat
GROUP BY name ORDER BY 2 DESC LIMIT 20`,
    columns: [
      { key: 'name', label: 'Table or index' },
      { key: 'total_bytes', label: 'Size', format: 'bytes', numeric: true },
    ],
    unavailable: 'Per-table sizes need SQLite built with the dbstat table.',
  },
  unusedIndexes: null,
  activity: null,
  locks: null,
  stop: null,
};

export const DIALECTS: Record<DbBackend, Dialect> = {
  postgres: POSTGRES,
  mysql: MYSQL,
  sqlite: SQLITE,
};

/** Rows as objects keyed by column name. */
export function records(res: DbQueryResult): Record<string, string | null>[] {
  return res.rows.map((row) => Object.fromEntries(res.columns.map((c, i) => [c, row[i] ?? null])));
}

/** A poll's counters as numbers: Postgres returns one wide row, MySQL's
 *  `SHOW STATUS` one row per variable. */
export function parseCounters(backend: DbBackend, res: DbQueryResult): Counters {
  const out: Counters = {};
  if (backend === 'mysql') {
    for (const [name, value] of res.rows) {
      const key = name ? MYSQL_STATUS[name] : undefined;
      if (key) out[key] = Number(value);
    }
    if (out.total !== undefined) {
      out.idle = out.total - (out.active ?? 0);
      out.server_sessions = out.total;
    }
  } else {
    const row = records(res)[0] ?? {};
    for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = Number(v);
  }
  return out;
}

/** One chart point from two consecutive polls: rate charts get the counter
 *  delta per second, gauge charts the current value. A counter that went
 *  backwards (stats reset, server restart) reads as 0, not a negative spike. */
export function point(
  spec: ChartSpec,
  prev: Counters | null,
  cur: Counters,
  dtSecs: number,
): number[] | null {
  if (!spec.rate) return spec.series.map((s) => cur[s.key] ?? 0);
  if (!prev || dtSecs <= 0) return null;
  return spec.series.map((s) => Math.max(0, ((cur[s.key] ?? 0) - (prev[s.key] ?? 0)) / dtSecs));
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1024 && i < BYTE_UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${BYTE_UNITS[i]}`;
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export function formatNumber(n: number): string {
  return Math.abs(n) < 1000 ? String(Math.round(n * 10) / 10) : compact.format(n);
}

export function formatCell(value: string | null, format: Column['format']): string {
  if (value === null) return '—';
  const n = Number(value);
  if (format === 'bytes' && Number.isFinite(n)) return formatBytes(n);
  if (format === 'num' && Number.isFinite(n)) return n < 0 ? '—' : formatNumber(n);
  if (format === 'secs' && Number.isFinite(n)) return formatDuration(Math.max(0, n));
  return value;
}
