import { describe, expect, it } from 'vitest';
import { designSql, draftFrom, draftProblem, emptyDraft } from '../tableDesign';
import type { DbTableSchema } from '../tauri';

const users: DbTableSchema = {
  columns: [
    { name: 'id', data_type: 'integer', nullable: false, default: null, primary_key: true },
    { name: 'nme', data_type: 'text', nullable: true, default: null, primary_key: false },
    { name: 'legacy', data_type: 'text', nullable: true, default: null, primary_key: false },
  ],
  indexes: [],
  foreign_keys: [],
  checks: [],
};

describe('designSql', () => {
  it('creates a table from a fresh draft', () => {
    const d = emptyDraft('postgres');
    d.table = 'public.notes';
    d.columns.push({ name: 'body', data_type: 'text', nullable: false, default: "''", primary_key: false, original: null });
    expect(designSql('postgres', null, d)).toBe(
      `CREATE TABLE "public"."notes" (\n  "id" bigserial NOT NULL,\n  "body" text NOT NULL DEFAULT '',\n  PRIMARY KEY ("id")\n);`,
    );
  });

  it('renames instead of drop+add, then alters, drops and adds', () => {
    const d = draftFrom('public.users', users);
    d.columns[1] = { ...d.columns[1]!, name: 'name', nullable: false };
    d.columns.splice(2, 1);
    d.columns.push({ name: 'age', data_type: 'integer', nullable: true, default: null, primary_key: false, original: null });
    const sql = designSql('postgres', { table: 'public.users', schema: users }, d);
    expect(sql).toContain('ALTER TABLE "public"."users" RENAME COLUMN "nme" TO "name";');
    expect(sql).toContain('ALTER COLUMN "name" SET NOT NULL');
    expect(sql).toContain('DROP COLUMN "legacy"');
    expect(sql).toContain('ADD COLUMN "age" integer');
    expect(sql).not.toContain('DROP COLUMN "nme"');
    expect(sql.indexOf('RENAME COLUMN')).toBeLessThan(sql.indexOf('SET NOT NULL'));
  });

  it('renames the table last, unqualified on Postgres', () => {
    const d = { ...draftFrom('public.users', users), table: 'public.people' };
    expect(designSql('postgres', { table: 'public.users', schema: users }, d)).toBe(
      'ALTER TABLE "public"."users" RENAME TO "people";',
    );
    expect(designSql('mysql', { table: 'users', schema: users }, { ...draftFrom('users', users), table: 'people' })).toBe(
      'RENAME TABLE `users` TO `people`;',
    );
  });
});

it('draftProblem catches blank and duplicate names', () => {
  expect(draftProblem({ table: '', columns: [] })).toBe('Name the table.');
  const d = draftFrom('t', users);
  d.columns[2]!.name = 'id';
  expect(draftProblem(d)).toBe('Two columns are named “id”.');
});
