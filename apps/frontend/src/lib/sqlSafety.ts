import type { DbBackend } from './tauri';

/**
 * Find the statements in `sql` worth a confirmation before they run:
 * `DROP`, `TRUNCATE`, and `UPDATE`/`DELETE` with no top-level `WHERE`.
 * Returns one reason per offending statement ("DELETE without WHERE"), empty
 * when everything looks safe.
 *
 * A small lexer, not a parser: it skips comments, string literals, quoted
 * identifiers and dollar-quoted bodies so a `where` inside any of them doesn't
 * count, splits on `;`, and tracks paren depth so a `WHERE` in a subquery
 * doesn't vouch for the outer statement. It errs towards asking — anything it
 * misreads (a `;` inside a trigger body) produces an extra prompt, not a
 * missed one. `backend` picks MySQL's backslash escapes and `#` comments.
 */
export function unsafeStatements(sql: string, backend?: DbBackend): string[] {
  return statements(sql, backend)
    .map(verdict)
    .filter((r): r is string => r !== null);
}

/**
 * True when `sql` is exactly one read-only statement — SELECT, VALUES, TABLE,
 * SHOW, or a WITH whose own verb is SELECT — with no INSERT/UPDATE/DELETE/MERGE
 * anywhere inside it (Postgres allows those in a CTE). Gates the full-result
 * export, which re-runs the statement.
 */
export function isSelectLike(sql: string, backend?: DbBackend): boolean {
  const all = statements(sql, backend);
  if (all.length !== 1) return false;
  const words = all[0]!;
  if (words.some((w) => WRITES.has(w.word))) return false;
  const top = words.filter((w) => w.depth === 0).map((w) => w.word);
  // `(SELECT …) UNION (SELECT …)` has no top-level verb; its first word is.
  const first = words[0]!.depth === 0 ? top[0] : words[0]!.word;
  const verb = first === 'with' ? top.find((w) => VERBS.has(w)) : first;
  return verb === 'select' || verb === 'values' || verb === 'table' || verb === 'show';
}

type Word = { word: string; depth: number };

/** Lex `sql` into its `;`-separated statements, each a list of bare words
 *  with their paren depth. Empty statements are dropped. */
function statements(sql: string, backend?: DbBackend): Word[][] {
  const mysql = backend === 'mysql';
  const out: Word[][] = [];
  let words: Word[] = [];
  let depth = 0;

  const flush = () => {
    if (words.length > 0) out.push(words);
    words = [];
    depth = 0;
  };

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
      // MySQL escapes with backslash in both quote styles; Postgres only in
      // E'…' strings.
      const escapes =
        c !== '`' &&
        (mysql || (c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '')));
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === '$' && !mysql) {
      // Postgres dollar quoting: $$…$$ or $tag$…$tag$. `$1` placeholders
      // don't match — a tag can't start with a digit.
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
      } else {
        i++;
      }
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(sql[j]!)) j++;
      words.push({ word: sql.slice(i, j).toLowerCase(), depth });
      i = j;
    } else {
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ';') flush();
      i++;
    }
  }
  flush();
  return out;
}

const VERBS = new Set(['select', 'insert', 'update', 'delete', 'merge', 'values']);
const WRITES = new Set(['insert', 'update', 'delete', 'merge']);

function verdict(words: Word[]): string | null {
  const top = words.filter((w) => w.depth === 0).map((w) => w.word);
  const first = top[0];
  if (first === 'drop' || first === 'truncate') return first.toUpperCase();
  // `WITH x AS (…) DELETE FROM t`: the CTE bodies sit inside parens, so the
  // first top-level verb is the statement's own.
  const at = first === 'with' ? top.findIndex((w) => VERBS.has(w)) : 0;
  const verb = at < 0 ? undefined : top[at];
  if ((verb === 'update' || verb === 'delete') && !top.slice(at).includes('where')) {
    return `${verb.toUpperCase()} without WHERE`;
  }
  return null;
}
