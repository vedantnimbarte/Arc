/**
 * Serialize a database client result grid for export. Cells are the text the
 * server sent (see `arc_db`), with `null` for SQL NULL.
 */

type Cell = string | null;

/**
 * RFC 4180 CSV: CRLF line endings, a header row, and fields quoted when they
 * contain a comma, quote, CR or LF, with embedded quotes doubled.
 *
 * NULL is written as an empty unquoted field and the empty string as `""` —
 * both are valid RFC 4180, and it's the convention Postgres `COPY … CSV` reads
 * back as NULL vs ''.
 */
export function toCsv(columns: string[], rows: Cell[][]): string {
  const field = (v: Cell) => {
    if (v === null) return '';
    return v === '' || /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [columns, ...rows].map((r) => r.map(field).join(',')).join('\r\n') + '\r\n';
}

/**
 * A JSON array of one object per row. Cells stay strings (the grid has no
 * types to recover); NULL becomes `null`. Duplicate column names — a join's
 * two `id`s — get `_2`, `_3` suffixes instead of silently overwriting.
 */
export function toJson(columns: string[], rows: Cell[][]): string {
  const seen = new Map<string, number>();
  const keys = columns.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    return n === 1 ? c : `${c}_${n}`;
  });
  const objects = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null])));
  return JSON.stringify(objects, null, 2);
}
