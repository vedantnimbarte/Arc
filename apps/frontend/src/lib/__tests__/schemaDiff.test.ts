import { describe, expect, it } from 'vitest';
import { createTableSql, diffSchemas, migrationSql } from '../schemaDiff';
import type { DbTableSchema } from '../tauri';

type Col = DbTableSchema['columns'][number];
type Ix = DbTableSchema['indexes'][number];

const col = (name: string, data_type: string, extra: Partial<Col> = {}): Col => ({
  name,
  data_type,
  nullable: true,
  default: null,
  primary_key: false,
  ...extra,
});
const ix = (name: string, columns: string, extra: Partial<Ix> = {}): Ix => ({
  name,
  columns,
  unique: false,
  primary: false,
  implicit: false,
  definition: null,
  ...extra,
});
const schema = (s: Partial<DbTableSchema>): DbTableSchema => ({
  columns: [],
  indexes: [],
  foreign_keys: [],
  checks: [],
  ...s,
});

const parent = schema({
  columns: [
    col('id', 'integer', { primary_key: true, nullable: false, default: "nextval('parent_id_seq'::regclass)" }),
    col('code', 'character varying(12)'),
  ],
  indexes: [
    ix('parent_pkey', 'id', { unique: true, primary: true, implicit: true }),
    ix('parent_code_key', 'code', { unique: true, implicit: true }),
  ],
});

const child = schema({
  columns: [
    col('id', 'bigint', { primary_key: true, nullable: false }),
    col('parent_id', 'integer', { nullable: false }),
    col('price', 'numeric(10,2)', { default: '0' }),
  ],
  indexes: [
    ix('child_pkey', 'id', { unique: true, primary: true, implicit: true }),
    ix('child_parent', 'parent_id', {
      definition: 'CREATE INDEX child_parent ON public.child USING btree (parent_id)',
    }),
  ],
  foreign_keys: [{ name: 'child_parent_fk', columns: 'parent_id', references: 'parent(id)' }],
  checks: [{ name: 'price_pos', expression: '(price >= 0::numeric)' }],
});

describe('createTableSql', () => {
  it('renders columns, keys, constraints and indexes', () => {
    expect(createTableSql('postgres', 'public.child', child)).toEqual([
      'CREATE TABLE "public"."child" (\n' +
        '  "id" bigint NOT NULL,\n' +
        '  "parent_id" integer NOT NULL,\n' +
        '  "price" numeric(10,2) DEFAULT 0,\n' +
        '  PRIMARY KEY ("id"),\n' +
        '  CONSTRAINT "price_pos" CHECK (price >= 0::numeric),\n' +
        '  CONSTRAINT "child_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "parent" ("id")\n' +
        ')',
      'CREATE INDEX child_parent ON public.child USING btree (parent_id)',
    ]);
  });

  it('turns a nextval default into serial and keeps UNIQUE constraints inline', () => {
    const [create] = createTableSql('postgres', 'parent', parent);
    expect(create).toContain('"id" serial NOT NULL,');
    expect(create).toContain('CONSTRAINT "parent_code_key" UNIQUE ("code")');
    expect(create).not.toContain('nextval');
  });

  it('quotes MySQL string defaults and builds indexes from columns', () => {
    const s = schema({
      columns: [col('state', 'varchar(8)', { default: 'new' }), col('n', 'int', { default: '3' })],
      indexes: [ix('by_state', 'state, n', { unique: true })],
    });
    expect(createTableSql('mysql', 't', s)).toEqual([
      "CREATE TABLE `t` (\n  `state` varchar(8) DEFAULT 'new',\n  `n` int DEFAULT 3\n)",
      'CREATE UNIQUE INDEX `by_state` ON `t` (`state`, `n`)',
    ]);
  });
});

describe('diffSchemas', () => {
  it('finds nothing between identical schemas', () => {
    expect(diffSchemas('postgres', { parent, child }, { parent, child })).toEqual([]);
  });

  it('creates missing tables in FK order and drops extra ones last', () => {
    const diffs = diffSchemas('postgres', { child, parent }, { legacy: schema({ columns: [col('x', 'text')] }) });
    expect(diffs.map((d) => `${d.status} ${d.table}`)).toEqual(['added parent', 'added child', 'removed legacy']);
    const sql = migrationSql(diffs);
    expect(sql.indexOf('CREATE TABLE "parent"')).toBeLessThan(sql.indexOf('CREATE TABLE "child"'));
    expect(sql.trimEnd().endsWith('DROP TABLE "legacy";')).toBe(true);
  });

  it('alters columns per dialect', () => {
    const target = schema({ ...child, columns: [child.columns[0]!, child.columns[1]!, col('price', 'integer', { nullable: false })] });
    const pg = diffSchemas('postgres', { child }, { child: target });
    expect(pg[0]!.changes[0]!.sql).toEqual([
      'ALTER TABLE "child" ALTER COLUMN "price" TYPE numeric(10,2)',
      'ALTER TABLE "child" ALTER COLUMN "price" DROP NOT NULL',
      'ALTER TABLE "child" ALTER COLUMN "price" SET DEFAULT 0',
    ]);
    const my = diffSchemas('mysql', { child }, { child: target });
    expect(my[0]!.changes[0]!.sql).toEqual(['ALTER TABLE `child` MODIFY COLUMN `price` numeric(10,2) DEFAULT 0']);
    const lite = diffSchemas('sqlite', { child }, { child: target });
    expect(lite[0]!.changes[0]!.unsupported).toBe(true);
    expect(lite[0]!.changes[0]!.sql[0]).toMatch(/^-- alter column price/);
  });

  it('adds and drops columns, indexes, checks and foreign keys', () => {
    const target = schema({
      columns: [...child.columns, col('legacy', 'text')],
      indexes: [child.indexes[0]!, ix('old_ix', 'price', { definition: 'CREATE INDEX old_ix ON public.child (price)' })],
      foreign_keys: [],
      checks: [{ name: 'price_pos', expression: '(price > 0::numeric)' }],
    });
    const diffs = diffSchemas('postgres', { 'public.child': child }, { 'public.child': target });
    const summaries = diffs[0]!.changes.map((c) => c.summary);
    expect(summaries).toEqual([
      'drop column legacy',
      'drop index old_ix',
      'add index child_parent (parent_id)',
      'drop check price_pos',
      'add check price_pos (price >= 0::numeric)',
      'add foreign key parent_id → parent(id)',
    ]);
    const sql = migrationSql(diffs);
    expect(sql).toContain('DROP INDEX "public"."old_ix";');
    expect(sql).toContain('ALTER TABLE "public"."child" DROP CONSTRAINT "price_pos";');
    // The FK goes on after the column/index/check work.
    expect(sql.trimEnd().endsWith(
      'ALTER TABLE "public"."child" ADD CONSTRAINT "child_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "parent" ("id");',
    )).toBe(true);
  });

  it('uses MySQL syntax to drop a foreign key and a check', () => {
    const target = schema({
      ...child,
      foreign_keys: [{ name: 'old_fk', columns: 'parent_id', references: 'parent(id)' }],
      checks: [...child.checks, { name: 'extra', expression: '(id > 0)' }],
    });
    const sql = migrationSql(diffSchemas('mysql', { child }, { child: target }));
    expect(sql).toContain('ALTER TABLE `child` DROP FOREIGN KEY `old_fk`;');
    expect(sql).toContain('ALTER TABLE `child` DROP CHECK `extra`;');
    // The old FK comes off before anything else.
    expect(sql.startsWith('ALTER TABLE `child` DROP FOREIGN KEY `old_fk`;')).toBe(true);
  });

  it('flags a primary key change instead of guessing', () => {
    const target = schema({ ...child, columns: child.columns.map((c) => ({ ...c, primary_key: c.name === 'parent_id' })) });
    const change = diffSchemas('postgres', { child }, { child: target })[0]!.changes.find((c) => c.unsupported);
    expect(change?.summary).toBe('primary key (parent_id) → (id)');
  });
});
