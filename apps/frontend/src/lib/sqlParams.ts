import type { DbBackend } from './tauri';
import { quoteLiteral } from './dbSql';

/**
 * Named query parameters: `:user_id` in the editor, prompted for when the
 * query runs and spliced in as literals. Skips string literals, quoted
 * identifiers, comments and dollar-quoted bodies, and Postgres `::type`
 * casts — `created_at::date` is not a parameter.
 */

type Span = { name: string; start: number; end: number };

function scan(sql: string, backend?: DbBackend): Span[] {
  const mysql = backend === 'mysql';
  const out: Span[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if ((c === '-' && next === '-') || (mysql && c === '#')) {
      const eol = sql.indexOf('\n', i);
      i = eol < 0 ? n : eol + 1;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const escapes = c !== '`' && mysql;
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === '$' && !mysql) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
      } else i++;
    } else if (c === ':' && next === ':') {
      i += 2; // a cast, and the type name after it is not a parameter
    } else if (c === ':' && next !== undefined && /[A-Za-z_]/.test(next) && !/[\w:]/.test(sql[i - 1] ?? '')) {
      let j = i + 2;
      while (j < n && /\w/.test(sql[j]!)) j++;
      out.push({ name: sql.slice(i + 1, j), start: i, end: j });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/** Distinct parameter names in order of first use. */
export function queryParams(sql: string, backend?: DbBackend): string[] {
  return [...new Set(scan(sql, backend).map((s) => s.name))];
}

/**
 * How a typed value goes into SQL: blank or `null` → NULL, a plain number
 * stays a number, anything else becomes a quoted string literal.
 */
export function paramLiteral(backend: DbBackend, raw: string): string {
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'null') return 'NULL';
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return quoteLiteral(backend, raw);
}

/** `sql` with every `:name` replaced by its value's literal. */
export function bindParams(sql: string, backend: DbBackend, values: Record<string, string>): string {
  let out = '';
  let at = 0;
  for (const s of scan(sql, backend)) {
    out += sql.slice(at, s.start) + paramLiteral(backend, values[s.name] ?? '');
    at = s.end;
  }
  return out + sql.slice(at);
}
