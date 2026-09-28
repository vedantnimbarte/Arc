import { describe, expect, it } from 'vitest';
import { editCount, editStatements, emptyEdits, quoteIdent, quoteLiteral } from '../dbSql';

describe('quoting', () => {
  it('matches the Rust side per dialect', () => {
    expect(quoteIdent('postgres', 'public.Orders')).toBe('"public"."Orders"');
    expect(quoteIdent('mysql', 'or`der')).toBe('`or``der`');
    expect(quoteIdent('sqlite', 'a"b')).toBe('"a""b"');
    expect(quoteLiteral('sqlite', "o'k")).toBe("'o''k'");
    expect(quoteLiteral('postgres', 'a\\b')).toBe("'a\\b'");
    expect(quoteLiteral('mysql', "a\\'b")).toBe("'a\\\\''b'");
  });
});

describe('editStatements', () => {
  const columns = ['id', 'org', 'name', 'note'];
  const rows: Array<Array<string | null>> = [
    ['1', 'a', 'Ann', null],
    ['2', null, "O'Brien", 'x'],
    ['3', 'a', 'Cy', 'y'],
  ];

  it('builds updates, deletes and inserts keyed on the primary key', () => {
    const e = emptyEdits();
    e.updates.set(1, new Map([['name', 'Bea'], ['note', null]]));
    e.updates.set(2, new Map([['name', 'ignored']])); // deleted below — delete wins
    e.deletes.add(2);
    e.inserts.push(new Map([['name', 'New'], ['org', 'b']]));
    e.inserts.push(new Map());
    expect(editCount(e)).toBe(4);

    expect(editStatements('postgres', 'public.people', columns, rows, ['id', 'org'], e)).toEqual([
      `UPDATE "public"."people" SET "name" = 'Bea', "note" = NULL WHERE "id" = '2' AND "org" IS NULL`,
      `DELETE FROM "public"."people" WHERE "id" = '3' AND "org" = 'a'`,
      `INSERT INTO "public"."people" ("name", "org") VALUES ('New', 'b')`,
      `INSERT INTO "public"."people" DEFAULT VALUES`,
    ]);
  });

  it('uses MySQL syntax for an all-default insert', () => {
    const e = emptyEdits();
    e.inserts.push(new Map());
    expect(editStatements('mysql', 't', columns, rows, ['id'], e)).toEqual(['INSERT INTO `t` () VALUES ()']);
  });

  it('skips updates with nothing changed', () => {
    const e = emptyEdits();
    e.updates.set(0, new Map());
    expect(editStatements('sqlite', 't', columns, rows, ['id'], e)).toEqual([]);
    expect(editCount(e)).toBe(0);
  });
});
