import type { DbBackend, DbTableSchema } from './tauri';
import { quoteIdent } from './dbSql';
import { createTableSql, diffSchemas, migrationSql } from './schemaDiff';

type Column = DbTableSchema['columns'][number];

/** One row of the table designer. `original` is the column's name in the
 *  live table, or null for a column being added — how a rename is told
 *  apart from a drop plus an add (which would lose the data). */
export interface DraftColumn extends Column {
  original: string | null;
}

export interface Draft {
  table: string;
  columns: DraftColumn[];
}

/** Common column types per dialect, offered as suggestions. */
export const TYPE_SUGGESTIONS: Record<DbBackend, string[]> = {
  postgres: [
    'bigserial', 'serial', 'bigint', 'integer', 'smallint', 'numeric(12,2)', 'double precision', 'boolean',
    'text', 'varchar(255)', 'uuid', 'date', 'timestamptz', 'timestamp', 'jsonb', 'bytea',
  ],
  mysql: [
    'bigint AUTO_INCREMENT', 'int AUTO_INCREMENT', 'bigint', 'int', 'tinyint(1)', 'decimal(12,2)', 'double',
    'varchar(255)', 'text', 'char(36)', 'date', 'datetime', 'timestamp', 'json', 'blob',
  ],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
};

export function draftFrom(table: string, schema: DbTableSchema): Draft {
  return { table, columns: schema.columns.map((c) => ({ ...c, original: c.name })) };
}

export function emptyDraft(backend: DbBackend): Draft {
  const idType = backend === 'postgres' ? 'bigserial' : backend === 'mysql' ? 'bigint AUTO_INCREMENT' : 'INTEGER';
  return {
    table: '',
    columns: [{ name: 'id', data_type: idType, nullable: false, default: null, primary_key: true, original: null }],
  };
}

/** What's wrong with the draft, or null when it can be turned into SQL. */
export function draftProblem(d: Draft): string | null {
  if (!d.table.trim()) return 'Name the table.';
  if (d.columns.length === 0) return 'Add at least one column.';
  const names = d.columns.map((c) => c.name.trim());
  if (names.some((n) => !n)) return 'Every column needs a name.';
  if (d.columns.some((c) => !c.data_type.trim())) return 'Every column needs a type.';
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return `Two columns are named “${dup}”.`;
  return null;
}

const strip = (c: DraftColumn): Column => ({
  name: c.name.trim(),
  data_type: c.data_type.trim(),
  nullable: c.nullable,
  default: c.default?.trim() ? c.default.trim() : null,
  primary_key: c.primary_key,
});

/**
 * The SQL that turns the live table (`current`, null when creating) into
 * `draft`. Renames go first, so the diff that follows sees matching names
 * and only alters what actually changed. Lines the dialect can't do in place
 * come back as `--` comments, as in the schema diff.
 */
export function designSql(backend: DbBackend, current: { table: string; schema: DbTableSchema } | null, draft: Draft): string {
  const table = draft.table.trim();
  if (!current) {
    const schema: DbTableSchema = { columns: draft.columns.map(strip), indexes: [], foreign_keys: [], checks: [] };
    return createTableSql(backend, table, schema).map((s) => `${s};`).join('\n\n');
  }

  const out: string[] = [];
  const t = quoteIdent(backend, current.table);
  // Columns renamed in the draft, applied to the live schema before diffing.
  const renames = new Map<string, string>();
  for (const c of draft.columns) {
    if (c.original && c.original !== c.name.trim()) renames.set(c.original, c.name.trim());
  }
  for (const [from, to] of renames) {
    out.push(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(backend, from)} TO ${quoteIdent(backend, to)};`);
  }
  const renamed: DbTableSchema = {
    ...current.schema,
    columns: current.schema.columns.map((c) => ({ ...c, name: renames.get(c.name) ?? c.name })),
  };
  const desired: DbTableSchema = { ...renamed, columns: draft.columns.map(strip) };
  const migration = migrationSql(diffSchemas(backend, { [current.table]: desired }, { [current.table]: renamed }));
  if (migration) out.push(migration);

  // A table rename goes last, so every statement above names the table as it is.
  if (table !== current.table) {
    const newName = backend === 'postgres' ? table.slice(table.lastIndexOf('.') + 1) : table;
    out.push(
      backend === 'mysql'
        ? `RENAME TABLE ${t} TO ${quoteIdent(backend, table)};`
        : `ALTER TABLE ${t} RENAME TO ${quoteIdent(backend, newName)};`,
    );
  }
  return out.join('\n\n');
}
