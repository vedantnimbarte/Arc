import { describe, expect, it } from 'vitest';
import { browseSql, filterSql, newBrowse } from '../dbBrowse';

describe('filterSql', () => {
  it('understands null checks and comparisons', () => {
    expect(filterSql('postgres', 'deleted_at', 'null')).toBe('"deleted_at" IS NULL');
    expect(filterSql('postgres', 'deleted_at', '!NULL')).toBe('"deleted_at" IS NOT NULL');
    expect(filterSql('mysql', 'age', '>= 21')).toBe("`age` >= '21'");
    expect(filterSql('sqlite', 'name', "!=O'Hara")).toBe(`"name" <> 'O''Hara'`);
    expect(filterSql('sqlite', 'name', '   ')).toBeNull();
  });

  it('turns plain text into an escaped contains match', () => {
    expect(filterSql('postgres', 'email', '50%_off!')).toBe(
      `CAST("email" AS TEXT) ILIKE '%50!%!_off!!%' ESCAPE '!'`,
    );
    expect(filterSql('mysql', 'note', 'a\\b')).toBe("CAST(`note` AS CHAR) LIKE '%a\\\\b%' ESCAPE '!'");
  });
});

describe('browseSql', () => {
  it('builds WHERE, ORDER BY and a one-extra-row page', () => {
    const b = { ...newBrowse('public.users', { role: '=admin', name: '' }), sort: { column: 'id', dir: 'desc' as const }, page: 2 };
    expect(browseSql('postgres', b)).toBe(
      `SELECT * FROM "public"."users" WHERE "role" = 'admin' ORDER BY "id" DESC LIMIT 201 OFFSET 400`,
    );
    expect(browseSql('sqlite', newBrowse('t'))).toBe('SELECT * FROM "t" LIMIT 201');
    expect(browseSql('sqlite', newBrowse('t'), 'page')).toBe('SELECT * FROM "t" LIMIT 200');
    expect(browseSql('postgres', b, 'none')).toBe(
      `SELECT * FROM "public"."users" WHERE "role" = 'admin' ORDER BY "id" DESC`,
    );
  });
});
