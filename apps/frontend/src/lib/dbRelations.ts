import type { DbTableSchema } from './tauri';

export type RelationKind = '1:1' | '1:N' | 'M:N';

export interface Relation {
  /** The table holding the foreign key. */
  from: string;
  fromColumns: string[];
  /** The table the foreign key points at. */
  to: string;
  toColumns: string[];
  kind: RelationKind;
  /** Set when this edge is one leg of a junction table's pair. */
  viaJunction?: string;
}

/** `columns` is comma-joined in schema order; compare sets, not order. */
function columnSet(columns: string): Set<string> {
  return new Set(
    columns
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  );
}

function sameColumns(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((c) => b.has(c));
}

/** Strip quoting a dialect may have wrapped an identifier in. */
function unquote(ident: string): string {
  return ident.replace(/^["`]|["`]$/g, '');
}

/** Split `foreign_keys[].references` ("table" or "table(col, …)") into its parts. */
function parseReference(references: string): { table: string; columns: string[] } {
  const paren = references.indexOf('(');
  if (paren < 0) return { table: unquote(references.trim()), columns: [] };
  return {
    table: unquote(references.slice(0, paren).trim()),
    columns: references
      .slice(paren + 1, references.lastIndexOf(')'))
      .split(',')
      .map((c) => unquote(c.trim()))
      .filter(Boolean),
  };
}

/**
 * Match a foreign key's target name against the known table names.
 *
 * SQLite/MySQL references are already bare table names. Postgres emits
 * `regclass::text`, which drops the `public.` prefix `dbTables` includes and
 * quotes a name that needs it — so an exact match is tried first, then
 * `public.<name>`, then whichever known table's name after its last dot
 * matches (covers schemas other than `public`).
 */
function resolveTable(name: string, known: string[]): string | null {
  if (known.includes(name)) return name;
  const withPublic = `public.${name}`;
  if (known.includes(withPublic)) return withPublic;
  const bare = known.filter((t) => t.slice(t.lastIndexOf('.') + 1) === name);
  return bare.length === 1 ? (bare[0] ?? null) : null;
}

/**
 * Turn every table's schema into the foreign-key edges between them,
 * classified as 1:1, 1:N, or M:N (via a junction table).
 */
export function buildRelations(schemas: Record<string, DbTableSchema>): {
  relations: Relation[];
  /** table -> the two tables it joins, for tables recognized as pure junctions. */
  junctions: Record<string, [string, string]>;
} {
  const tableNames = Object.keys(schemas);
  const relations: Relation[] = [];

  for (const [table, schema] of Object.entries(schemas)) {
    const pk = columnSet(schema.columns.filter((c) => c.primary_key).map((c) => c.name).join(', '));
    const uniqueSets = schema.indexes.filter((ix) => ix.unique).map((ix) => columnSet(ix.columns));

    for (const fk of schema.foreign_keys) {
      const ref = parseReference(fk.references);
      const to = resolveTable(ref.table, tableNames);
      if (!to) continue; // unresolved reference — nothing to draw
      const fromCols = columnSet(fk.columns);
      // An implicit SQLite self-reference to the parent's primary key omits
      // the column list; fall back to the parent's own PK.
      const toCols = ref.columns.length > 0 ? ref.columns : [...(schemas[to]?.columns ?? [])
        .filter((c) => c.primary_key)
        .map((c) => c.name)];

      const isOneToOne = sameColumns(fromCols, pk) || uniqueSets.some((u) => sameColumns(u, fromCols));

      relations.push({
        from: table,
        fromColumns: [...fromCols],
        to,
        toColumns: toCols,
        kind: isOneToOne ? '1:1' : '1:N',
      });
    }
  }

  // A junction table: exactly two foreign keys, whose combined columns are
  // covered by the primary key or a unique index — so the pair together
  // identifies the row, the classic many-to-many join table shape.
  // ponytail: this is a heuristic, not a constraint reader — a junction
  // table with no unique constraint over the pair just shows as two 1:N
  // edges instead of being collapsed into M:N.
  const junctions: Record<string, [string, string]> = {};
  for (const [table, schema] of Object.entries(schemas)) {
    const fks = schema.foreign_keys;
    if (fks.length !== 2) continue;
    const [fk0, fk1] = fks;
    if (!fk0 || !fk1) continue;
    const pk = columnSet(schema.columns.filter((c) => c.primary_key).map((c) => c.name).join(', '));
    const uniqueSets = schema.indexes.filter((ix) => ix.unique).map((ix) => columnSet(ix.columns));
    const combined = new Set([...columnSet(fk0.columns), ...columnSet(fk1.columns)]);
    const isJunction = sameColumns(combined, pk) || uniqueSets.some((u) => sameColumns(u, combined));
    if (!isJunction) continue;

    const rels = relations.filter((r) => r.from === table);
    const [a, b] = rels;
    if (!a || !b || rels.length !== 2) continue;
    a.kind = 'M:N';
    b.kind = 'M:N';
    a.viaJunction = table;
    b.viaJunction = table;
    junctions[table] = [a.to, b.to];
  }

  return { relations, junctions };
}
