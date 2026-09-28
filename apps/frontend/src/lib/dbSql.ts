import type { DbBackend } from './tauri';

/**
 * SQL text generation for the DB client: identifier/literal quoting (the same
 * rules as `arc_db::Backend`) and the statements behind the grid's staged
 * edits. Values always go in as quoted literals — every cell arrives as text,
 * and an untyped literal lets the server cast it to the column's type.
 */

/** Quote an identifier. A Postgres `schema.table` stays two identifiers. */
export function quoteIdent(backend: DbBackend, ident: string): string {
  if (backend === 'mysql') return '`' + ident.replace(/`/g, '``') + '`';
  if (backend === 'postgres') {
    return ident
      .split('.')
      .map((p) => '"' + p.replace(/"/g, '""') + '"')
      .join('.');
  }
  return '"' + ident.replace(/"/g, '""') + '"';
}

/** Quote a string literal. MySQL also treats backslash as an escape. */
export function quoteLiteral(backend: DbBackend, s: string): string {
  const v = backend === 'mysql' ? s.replace(/\\/g, '\\\\') : s;
  return "'" + v.replace(/'/g, "''") + "'";
}

/** `NULL` or a quoted literal. */
export function sqlValue(backend: DbBackend, v: string | null): string {
  return v === null ? 'NULL' : quoteLiteral(backend, v);
}

/** Pending grid changes against one table. Row indices are into the result's rows. */
export interface StagedEdits {
  /** row index → column → new value (null = NULL). */
  updates: Map<number, Map<string, string | null>>;
  deletes: Set<number>;
  /** New rows: column → value. A column left out takes its default. */
  inserts: Array<Map<string, string | null>>;
}

export function emptyEdits(): StagedEdits {
  return { updates: new Map(), deletes: new Set(), inserts: [] };
}

export function editCount(e: StagedEdits): number {
  let n = e.deletes.size + e.inserts.length;
  for (const [row, cols] of e.updates) if (!e.deletes.has(row) && cols.size > 0) n++;
  return n;
}

/**
 * The UPDATE / DELETE / INSERT statements that apply `edits`. Existing rows
 * are matched on `pk` using the values the grid loaded — a NULL key part
 * matches with `IS NULL`. Deletes win over updates to the same row.
 */
export function editStatements(
  backend: DbBackend,
  table: string,
  columns: string[],
  rows: Array<Array<string | null>>,
  pk: string[],
  edits: StagedEdits,
): string[] {
  const t = quoteIdent(backend, table);
  const q = (c: string) => quoteIdent(backend, c);
  const where = (row: Array<string | null>) =>
    pk
      .map((c) => {
        const v = row[columns.indexOf(c)] ?? null;
        return v === null ? `${q(c)} IS NULL` : `${q(c)} = ${quoteLiteral(backend, v)}`;
      })
      .join(' AND ');

  const out: string[] = [];
  for (const [ri, cols] of [...edits.updates].sort((a, b) => a[0] - b[0])) {
    const row = rows[ri];
    if (!row || edits.deletes.has(ri) || cols.size === 0) continue;
    const sets = [...cols].map(([c, v]) => `${q(c)} = ${sqlValue(backend, v)}`).join(', ');
    out.push(`UPDATE ${t} SET ${sets} WHERE ${where(row)}`);
  }
  for (const ri of [...edits.deletes].sort((a, b) => a - b)) {
    const row = rows[ri];
    if (row) out.push(`DELETE FROM ${t} WHERE ${where(row)}`);
  }
  for (const ins of edits.inserts) {
    if (ins.size === 0) {
      out.push(backend === 'mysql' ? `INSERT INTO ${t} () VALUES ()` : `INSERT INTO ${t} DEFAULT VALUES`);
      continue;
    }
    const cols = [...ins.keys()].map(q).join(', ');
    const vals = [...ins.values()].map((v) => sqlValue(backend, v)).join(', ');
    out.push(`INSERT INTO ${t} (${cols}) VALUES (${vals})`);
  }
  return out;
}
