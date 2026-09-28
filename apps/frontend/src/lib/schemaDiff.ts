import type { DbBackend, DbTableSchema } from './tauri';
import { quoteIdent, quoteLiteral } from './dbSql';

/**
 * DDL from catalog data: `CREATE TABLE` for one table, and a structural diff
 * of two schemas with the statements that make the *target* match the
 * *source*. Review-only output — nothing here runs anything.
 *
 * Coverage is what the catalog reads give us: columns (type, NULL, default),
 * primary key, indexes, UNIQUE constraints, foreign keys, CHECKs. Not
 * covered: identity columns, FK ON DELETE/UPDATE actions, triggers, views,
 * enum/sequence objects. Changes a dialect can't make in place (most ALTERs
 * on SQLite, a changed primary key anywhere) come out as `--` comments.
 */

type Column = DbTableSchema['columns'][number];
type Index = DbTableSchema['indexes'][number];
type ForeignKey = DbTableSchema['foreign_keys'][number];
type Check = DbTableSchema['checks'][number];

const splitCols = (cols: string) =>
  cols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

/** A column's default as SQL. Postgres and SQLite report an expression;
 *  MySQL reports the bare value, which needs quoting unless it's a number,
 *  a keyword, or an expression default. */
function defaultSql(backend: DbBackend, col: Column): string | null {
  const d = col.default;
  if (d === null) return null;
  if (backend !== 'mysql') return d;
  if (
    /^-?\d+(\.\d+)?$/.test(d) ||
    /^(NULL|CURRENT_TIMESTAMP)(\(\d*\))?$/i.test(d) ||
    d.startsWith('(') ||
    /^b'[01]*'$/.test(d)
  ) {
    return d;
  }
  return quoteLiteral(backend, d);
}

/** A Postgres `nextval('…'::regclass)` default names a sequence the target
 *  may not have; `serial` recreates both. */
function pgSerial(col: Column): string | null {
  if (!col.default || !/^nextval\('[^']+'::regclass\)$/.test(col.default)) return null;
  const serials: Record<string, string> = {
    integer: 'serial',
    bigint: 'bigserial',
    smallint: 'smallserial',
  };
  return serials[col.data_type] ?? null;
}

export function columnDef(backend: DbBackend, col: Column): string {
  const serial = backend === 'postgres' ? pgSerial(col) : null;
  const parts = [quoteIdent(backend, col.name), serial ?? col.data_type];
  if (!col.nullable) parts.push('NOT NULL');
  const d = serial ? null : defaultSql(backend, col);
  if (d !== null) parts.push(`DEFAULT ${d}`);
  return parts.filter(Boolean).join(' ');
}

/** `table(a, b)` → parts. SQLite's implicit-PK form is just `table`. */
function parseReference(ref: string): { table: string; columns: string[] } {
  const paren = ref.indexOf('(');
  if (paren < 0) return { table: ref.trim(), columns: [] };
  return {
    table: ref.slice(0, paren).trim(),
    columns: splitCols(ref.slice(paren + 1, ref.lastIndexOf(')'))),
  };
}

const colList = (backend: DbBackend, cols: string[]) =>
  cols.map((c) => quoteIdent(backend, c)).join(', ');

const named = (backend: DbBackend, name: string) =>
  name ? `CONSTRAINT ${quoteIdent(backend, name)} ` : '';

function fkClause(backend: DbBackend, fk: ForeignKey): string {
  const ref = parseReference(fk.references);
  const target =
    quoteIdent(backend, ref.table) + (ref.columns.length ? ` (${colList(backend, ref.columns)})` : '');
  return `${named(backend, fk.name)}FOREIGN KEY (${colList(backend, splitCols(fk.columns))}) REFERENCES ${target}`;
}

const checkClause = (backend: DbBackend, c: Check) => `${named(backend, c.name)}CHECK ${c.expression}`;

/** Indexes a constraint owns but that aren't the PK: UNIQUE constraints. */
const uniqueConstraints = (s: DbTableSchema) => s.indexes.filter((ix) => ix.implicit && !ix.primary);
const plainIndexes = (s: DbTableSchema) => s.indexes.filter((ix) => !ix.implicit);

function uniqueClause(backend: DbBackend, ix: Index): string {
  // SQLite's autoindex names are positional, not something you can declare.
  const name = backend === 'sqlite' ? '' : ix.name;
  return `${named(backend, name)}UNIQUE (${colList(backend, splitCols(ix.columns))})`;
}

function createIndexSql(backend: DbBackend, table: string, ix: Index): string {
  if (ix.definition) return ix.definition;
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(backend, ix.name)} ON ${quoteIdent(backend, table)} (${colList(backend, splitCols(ix.columns))})`;
}

/** An index name, schema-qualified on Postgres (indexes live in their table's schema). */
function indexRef(backend: DbBackend, table: string, name: string): string {
  const dot = table.lastIndexOf('.');
  const qualified = backend === 'postgres' && dot > 0 ? `${table.slice(0, dot)}.${name}` : name;
  return quoteIdent(backend, qualified);
}

function dropIndexSql(backend: DbBackend, table: string, ix: Index): string {
  if (backend === 'mysql') {
    return `DROP INDEX ${quoteIdent(backend, ix.name)} ON ${quoteIdent(backend, table)}`;
  }
  return `DROP INDEX ${indexRef(backend, table, ix.name)}`;
}

const pkColumns = (s: DbTableSchema) => s.columns.filter((c) => c.primary_key).map((c) => c.name);

/** `CREATE TABLE` plus its `CREATE INDEX`es, as separate statements. */
export function createTableSql(backend: DbBackend, table: string, s: DbTableSchema): string[] {
  const lines = s.columns.map((c) => columnDef(backend, c));
  const pk = pkColumns(s);
  if (pk.length) lines.push(`PRIMARY KEY (${colList(backend, pk)})`);
  for (const ix of uniqueConstraints(s)) lines.push(uniqueClause(backend, ix));
  for (const c of s.checks) lines.push(checkClause(backend, c));
  for (const fk of s.foreign_keys) lines.push(fkClause(backend, fk));
  const create = `CREATE TABLE ${quoteIdent(backend, table)} (\n  ${lines.join(',\n  ')}\n)`;
  return [create, ...plainIndexes(s).map((ix) => createIndexSql(backend, table, ix))];
}

// ─── Diff ────────────────────────────────────────────────────────────────────

/**
 * When a statement has to run relative to the others. Foreign keys come off
 * first and go back on last, so tables and columns can change underneath
 * them; tables are dropped at the very end.
 */
const Phase = {
  DropFk: 0,
  CreateTable: 1,
  Alter: 2,
  AddFk: 3,
  DropTable: 4,
} as const;
type Phase = (typeof Phase)[keyof typeof Phase];

export interface Change {
  summary: string;
  /** Statements, or `--` comments where the dialect can't do it in place. */
  sql: string[];
  phase: Phase;
  unsupported?: boolean;
}

export interface TableDiff {
  table: string;
  status: 'added' | 'removed' | 'changed';
  changes: Change[];
}

const alterTable = (backend: DbBackend, table: string) => `ALTER TABLE ${quoteIdent(backend, table)}`;

function unsupported(summary: string, why: string, phase: Phase = Phase.Alter): Change {
  return { summary, sql: [`-- ${summary}: ${why}`], phase, unsupported: true };
}

const SQLITE_REBUILD = "SQLite can't do this in place — rebuild the table";

function describeColumn(c: Column): string {
  return `${c.data_type}${c.nullable ? '' : ' NOT NULL'}${c.default !== null ? ` DEFAULT ${c.default}` : ''}`;
}

function columnChanges(backend: DbBackend, table: string, from: Column, to: Column): Change | null {
  const typeChanged = from.data_type.toLowerCase() !== to.data_type.toLowerCase();
  const nullChanged = from.nullable !== to.nullable;
  const defaultChanged = from.default !== to.default;
  if (!typeChanged && !nullChanged && !defaultChanged) return null;
  const summary = `alter column ${to.name}: ${describeColumn(from)} → ${describeColumn(to)}`;
  if (backend === 'sqlite') return unsupported(summary, SQLITE_REBUILD);
  const alter = alterTable(backend, table);
  if (backend === 'mysql') {
    return { summary, sql: [`${alter} MODIFY COLUMN ${columnDef(backend, to)}`], phase: Phase.Alter };
  }
  const col = `${alter} ALTER COLUMN ${quoteIdent(backend, to.name)}`;
  const sql: string[] = [];
  if (typeChanged) sql.push(`${col} TYPE ${to.data_type}`);
  if (nullChanged) sql.push(`${col} ${to.nullable ? 'DROP' : 'SET'} NOT NULL`);
  if (defaultChanged) {
    const d = defaultSql(backend, to);
    sql.push(d === null ? `${col} DROP DEFAULT` : `${col} SET DEFAULT ${d}`);
  }
  return { summary, sql, phase: Phase.Alter };
}

/** Pair up two lists by key: [in both], only in `source`, only in `target`. */
function pairUp<T>(source: T[], target: T[], key: (t: T) => string) {
  const t = new Map(target.map((x) => [key(x), x]));
  const s = new Map(source.map((x) => [key(x), x]));
  const both: Array<[T, T]> = [];
  const added: T[] = [];
  for (const [k, v] of s) {
    const other = t.get(k);
    if (other) both.push([v, other]);
    else added.push(v);
  }
  const removed = [...t].filter(([k]) => !s.has(k)).map(([, v]) => v);
  return { both, added, removed };
}

function tableChanges(backend: DbBackend, table: string, src: DbTableSchema, tgt: DbTableSchema): Change[] {
  const out: Change[] = [];
  const alter = alterTable(backend, table);

  // Columns.
  const cols = pairUp(src.columns, tgt.columns, (c) => c.name);
  for (const c of cols.added) {
    out.push({
      summary: `add column ${c.name} ${describeColumn(c)}`,
      sql: [`${alter} ADD COLUMN ${columnDef(backend, c)}`],
      phase: Phase.Alter,
    });
  }
  for (const [s, t] of cols.both) {
    const ch = columnChanges(backend, table, t, s);
    if (ch) out.push(ch);
  }
  for (const c of cols.removed) {
    out.push({
      summary: `drop column ${c.name}`,
      sql: [`${alter} DROP COLUMN ${quoteIdent(backend, c.name)}`],
      phase: Phase.Alter,
    });
  }

  // Primary key.
  const pkS = pkColumns(src).join(', ');
  const pkT = pkColumns(tgt).join(', ');
  if (pkS !== pkT) {
    out.push(unsupported(`primary key (${pkT || 'none'}) → (${pkS || 'none'})`, 'change it by hand'));
  }

  // Plain indexes, by name.
  const ix = pairUp(plainIndexes(src), plainIndexes(tgt), (i) => i.name);
  const dropIx = (i: Index) => ({
    summary: `drop index ${i.name}`,
    sql: [dropIndexSql(backend, table, i)],
    phase: Phase.Alter,
  });
  const addIx = (i: Index) => ({
    summary: `add ${i.unique ? 'unique ' : ''}index ${i.name} (${i.columns})`,
    sql: [createIndexSql(backend, table, i)],
    phase: Phase.Alter,
  });
  for (const i of ix.removed) out.push(dropIx(i));
  for (const [s, t] of ix.both) {
    if (s.columns !== t.columns || s.unique !== t.unique) out.push(dropIx(t), addIx(s));
  }
  for (const i of ix.added) out.push(addIx(i));

  // UNIQUE constraints, by their columns (SQLite's autoindex names are positional).
  const uq = pairUp(uniqueConstraints(src), uniqueConstraints(tgt), (i) => i.columns);
  for (const i of uq.removed) {
    const summary = `drop unique (${i.columns})`;
    out.push(
      backend === 'sqlite'
        ? unsupported(summary, SQLITE_REBUILD)
        : backend === 'mysql'
          ? { summary, sql: [dropIndexSql(backend, table, i)], phase: Phase.Alter }
          : { summary, sql: [`${alter} DROP CONSTRAINT ${quoteIdent(backend, i.name)}`], phase: Phase.Alter },
    );
  }
  for (const i of uq.added) {
    const summary = `add unique (${i.columns})`;
    out.push(
      backend === 'sqlite'
        ? unsupported(summary, SQLITE_REBUILD)
        : { summary, sql: [`${alter} ADD ${uniqueClause(backend, i)}`], phase: Phase.Alter },
    );
  }

  // Check constraints, by name (or expression when unnamed).
  const ck = pairUp(src.checks, tgt.checks, (c) => c.name || c.expression);
  const dropCk = (c: Check): Change => {
    const summary = `drop check ${c.name || c.expression}`;
    if (backend === 'sqlite' || !c.name) return unsupported(summary, SQLITE_REBUILD);
    const verb = backend === 'mysql' ? 'CHECK' : 'CONSTRAINT';
    return { summary, sql: [`${alter} DROP ${verb} ${quoteIdent(backend, c.name)}`], phase: Phase.Alter };
  };
  const addCk = (c: Check): Change => {
    const summary = `add check ${c.name ? `${c.name} ` : ''}${c.expression}`;
    if (backend === 'sqlite') return unsupported(summary, SQLITE_REBUILD);
    return { summary, sql: [`${alter} ADD ${checkClause(backend, c)}`], phase: Phase.Alter };
  };
  for (const c of ck.removed) out.push(dropCk(c));
  for (const [s, t] of ck.both) if (s.expression !== t.expression) out.push(dropCk(t), addCk(s));
  for (const c of ck.added) out.push(addCk(c));

  // Foreign keys, by name (or shape when unnamed).
  const fk = pairUp(src.foreign_keys, tgt.foreign_keys, (f) => f.name || `${f.columns}->${f.references}`);
  const dropFk = (f: ForeignKey): Change => {
    const summary = `drop foreign key ${f.name || f.columns} → ${f.references}`;
    if (backend === 'sqlite' || !f.name) return unsupported(summary, SQLITE_REBUILD, Phase.DropFk);
    const verb = backend === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT';
    return { summary, sql: [`${alter} DROP ${verb} ${quoteIdent(backend, f.name)}`], phase: Phase.DropFk };
  };
  const addFk = (f: ForeignKey): Change => {
    const summary = `add foreign key ${f.columns} → ${f.references}`;
    if (backend === 'sqlite') return unsupported(summary, SQLITE_REBUILD, Phase.AddFk);
    return { summary, sql: [`${alter} ADD ${fkClause(backend, f)}`], phase: Phase.AddFk };
  };
  for (const f of fk.removed) out.push(dropFk(f));
  for (const [s, t] of fk.both) {
    if (s.columns !== t.columns || s.references !== t.references) out.push(dropFk(t), addFk(s));
  }
  for (const f of fk.added) out.push(addFk(f));

  return out;
}

/** Tables to create, ordered so each one's FK targets exist first (when they
 *  are among the new tables too). A cycle falls back to name order. */
function creationOrder(names: string[], source: Record<string, DbTableSchema>): string[] {
  const pending = new Set(names);
  const out: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter((t) =>
      source[t]!.foreign_keys.every((f) => {
        const ref = parseReference(f.references).table;
        return ref === t || ![...pending].some((p) => p === ref || p.endsWith(`.${ref}`));
      }),
    );
    const next = ready.length ? ready : [[...pending].sort()[0]!];
    for (const t of next.sort()) {
      out.push(t);
      pending.delete(t);
    }
  }
  return out;
}

/** What it takes to turn `target` into `source`, table by table. */
export function diffSchemas(
  backend: DbBackend,
  source: Record<string, DbTableSchema>,
  target: Record<string, DbTableSchema>,
): TableDiff[] {
  const added = Object.keys(source).filter((t) => !(t in target));
  const out: TableDiff[] = creationOrder(added, source).map((table) => ({
    table,
    status: 'added',
    changes: [
      {
        summary: `create table ${table}`,
        sql: createTableSql(backend, table, source[table]!),
        phase: Phase.CreateTable,
      },
    ],
  }));
  for (const table of Object.keys(source).sort()) {
    const tgt = target[table];
    if (!tgt) continue;
    const changes = tableChanges(backend, table, source[table]!, tgt);
    if (changes.length) out.push({ table, status: 'changed', changes });
  }
  for (const table of Object.keys(target).sort()) {
    if (table in source) continue;
    out.push({
      table,
      status: 'removed',
      changes: [
        {
          summary: `drop table ${table}`,
          sql: [`DROP TABLE ${quoteIdent(backend, table)}`],
          phase: Phase.DropTable,
        },
      ],
    });
  }
  return out;
}

/** Every change's SQL as one script, in phase order. */
export function migrationSql(diffs: TableDiff[]): string {
  const changes = diffs.flatMap((d) => d.changes);
  const ordered = changes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.phase - b.c.phase || a.i - b.i)
    .map(({ c }) => c);
  return ordered
    .flatMap((c) => c.sql)
    .map((s) => (s.startsWith('--') ? s : `${s};`))
    .join('\n\n');
}
