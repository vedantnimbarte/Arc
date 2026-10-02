import { describe, expect, it } from 'vitest';
import { bindParams, queryParams } from '../sqlParams';

describe('queryParams', () => {
  it('finds named parameters once, in order', () => {
    expect(queryParams('SELECT * FROM u WHERE id = :id AND org = :org OR id = :id')).toEqual(['id', 'org']);
  });

  it('skips casts, strings, comments and dollar quotes', () => {
    expect(
      queryParams(
        "SELECT created_at::date, ':nope', \"a:b\" -- :c\n FROM t /* :d */ WHERE x = $$ :e $$ AND y = :real",
        'postgres',
      ),
    ).toEqual(['real']);
  });
});

describe('bindParams', () => {
  it('splices numbers raw, text quoted, blank as NULL', () => {
    expect(
      bindParams('SELECT :a, :b, :c, :a::text', 'postgres', { a: '42', b: "O'Hara", c: '' }),
    ).toBe("SELECT 42, 'O''Hara', NULL, 42::text");
  });
});
