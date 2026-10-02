import { describe, expect, it } from 'vitest';
import { toCsv, toInsertSql, toJson, toMarkdown } from '../dbExport';

describe('toCsv', () => {
  it('quotes only fields that need it, with CRLF rows', () => {
    expect(toCsv(['a', 'b'], [['1', 'plain']])).toBe('a,b\r\n1,plain\r\n');
    expect(toCsv(['x'], [['has,comma'], ['say "hi"'], ['two\nlines'], ['cr\r']])).toBe(
      'x\r\n"has,comma"\r\n"say ""hi"""\r\n"two\nlines"\r\n"cr\r"\r\n',
    );
  });

  it('keeps NULL distinct from the empty string', () => {
    expect(toCsv(['a', 'b'], [[null, '']])).toBe('a,b\r\n,""\r\n');
  });

  it('quotes header names too', () => {
    expect(toCsv(['count(*)', 'a,b'], [])).toBe('count(*),"a,b"\r\n');
  });
});

describe('toJson', () => {
  it('writes one object per row with null for NULL', () => {
    expect(JSON.parse(toJson(['id', 'name'], [['1', null], ['2', 'x']]))).toEqual([
      { id: '1', name: null },
      { id: '2', name: 'x' },
    ]);
  });

  it('suffixes duplicate column names instead of dropping them', () => {
    expect(JSON.parse(toJson(['id', 'id', 'id'], [['1', '2', '3']]))).toEqual([
      { id: '1', id_2: '2', id_3: '3' },
    ]);
  });

  it('is an empty array for no rows', () => {
    expect(JSON.parse(toJson(['a'], []))).toEqual([]);
  });
});

describe('toInsertSql / toMarkdown', () => {
  it('writes one INSERT per row with NULLs and quoting', () => {
    expect(toInsertSql('postgres', 'public.t', ['id', 'name'], [['1', "it's"], ['2', null]])).toBe(
      `INSERT INTO "public"."t" ("id", "name") VALUES ('1', 'it''s');\n` +
        `INSERT INTO "public"."t" ("id", "name") VALUES ('2', NULL);\n`,
    );
  });

  it('escapes pipes and newlines in Markdown cells', () => {
    expect(toMarkdown(['a', 'b'], [['x|y', 'two\nlines'], [null, '']])).toBe(
      '| a | b |\n| --- | --- |\n| x\\|y | two<br>lines |\n| NULL |  |\n',
    );
  });
});
