import type { DbBackend } from './tauri';
import { quoteIdent, quoteLiteral } from './dbSql';

/**
 * Browsing a table server-side: sort, per-column filters and paging become
 * the WHERE / ORDER BY / LIMIT of the preview query, so they cover the whole
 * table rather than the rows that happen to be loaded.
 */
export interface Browse {
  table: string;
  sort: { column: string; dir: 'asc' | 'desc' } | null;
  /** column → filter text, as typed (see `filterSql`). */
  filters: Record<string, string>;
  page: number;
  pageSize: number;
}

export const PAGE_SIZE = 200;

export function newBrowse(table: string, filters: Record<string, string> = {}): Browse {
  return { table, sort: null, filters, page: 0, pageSize: PAGE_SIZE };
}

/**
 * One column's filter text as a condition:
 *   `null` / `!null`                → IS NULL / IS NOT NULL
 *   `=v` `!=v` `<>v` `>v` `>=v` `<v` `<=v` → that comparison
 *   anything else                    → case-insensitive "contains"
 * Returns null for a blank filter.
 */
export function filterSql(backend: DbBackend, column: string, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const col = quoteIdent(backend, column);
  if (/^null$/i.test(t)) return `${col} IS NULL`;
  if (/^!null$/i.test(t)) return `${col} IS NOT NULL`;
  // Always a quoted literal: an untyped string compares against any column
  // type (Postgres casts it, MySQL and SQLite coerce it), where a bare 5
  // against a text column is an error on Postgres.
  const op = /^(<>|!=|>=|<=|=|>|<)\s*(.*)$/s.exec(t);
  if (op) return `${col} ${op[1] === '!=' ? '<>' : op[1]} ${quoteLiteral(backend, op[2]!)}`;
  // `!` escapes LIKE's wildcards the same way in all three dialects.
  const pattern = quoteLiteral(backend, `%${t.replace(/[!%_]/g, '!$&')}%`);
  if (backend === 'postgres') return `CAST(${col} AS TEXT) ILIKE ${pattern} ESCAPE '!'`;
  if (backend === 'mysql') return `CAST(${col} AS CHAR) LIKE ${pattern} ESCAPE '!'`;
  return `CAST(${col} AS TEXT) LIKE ${pattern} ESCAPE '!'`;
}

/**
 * The browse as a SELECT. By default it fetches one row past the page so the
 * caller knows whether there is a next page without counting the table;
 * `limit: 'page'` is the page itself (what the editor shows), and
 * `limit: 'none'` drops LIMIT/OFFSET for a full export.
 */
export function browseSql(backend: DbBackend, b: Browse, limit: 'fetch' | 'page' | 'none' = 'fetch'): string {
  const where = Object.entries(b.filters)
    .map(([c, t]) => filterSql(backend, c, t))
    .filter((w): w is string => w !== null);
  let sql = `SELECT * FROM ${quoteIdent(backend, b.table)}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  if (b.sort) sql += ` ORDER BY ${quoteIdent(backend, b.sort.column)} ${b.sort.dir.toUpperCase()}`;
  if (limit === 'none') return sql;
  sql += ` LIMIT ${limit === 'fetch' ? b.pageSize + 1 : b.pageSize}`;
  if (b.page > 0) sql += ` OFFSET ${b.page * b.pageSize}`;
  return sql;
}
