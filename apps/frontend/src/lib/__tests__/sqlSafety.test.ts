import { describe, expect, it } from 'vitest';
import { isSelectLike, unsafeStatements } from '../sqlSafety';

describe('unsafeStatements', () => {
  it('passes filtered writes and plain reads', () => {
    expect(unsafeStatements('UPDATE t SET a=1 WHERE id=2')).toEqual([]);
    expect(unsafeStatements('delete from t where id = 1;')).toEqual([]);
    expect(unsafeStatements('SELECT * FROM t')).toEqual([]);
    expect(unsafeStatements('INSERT INTO t VALUES (1)')).toEqual([]);
    expect(unsafeStatements('')).toEqual([]);
  });

  it('flags UPDATE/DELETE without WHERE, DROP and TRUNCATE', () => {
    expect(unsafeStatements('DELETE FROM t')).toEqual(['DELETE without WHERE']);
    expect(unsafeStatements('update t set a = 1')).toEqual(['UPDATE without WHERE']);
    expect(unsafeStatements('DROP TABLE t')).toEqual(['DROP']);
    expect(unsafeStatements('truncate t')).toEqual(['TRUNCATE']);
  });

  it('ignores WHERE inside comments', () => {
    expect(unsafeStatements('DELETE FROM t -- where x')).toEqual(['DELETE without WHERE']);
    expect(unsafeStatements('DELETE FROM t /* where x */')).toEqual(['DELETE without WHERE']);
    expect(unsafeStatements('DELETE FROM t # where x', 'mysql')).toEqual(['DELETE without WHERE']);
  });

  it('ignores WHERE inside strings and quoted identifiers', () => {
    expect(unsafeStatements("UPDATE t SET a='where' ")).toEqual(['UPDATE without WHERE']);
    expect(unsafeStatements('UPDATE "where" SET a=1')).toEqual(['UPDATE without WHERE']);
    expect(unsafeStatements('UPDATE `where` SET a=1', 'mysql')).toEqual(['UPDATE without WHERE']);
    expect(unsafeStatements("UPDATE t SET a='it''s where'")).toEqual(['UPDATE without WHERE']);
    expect(unsafeStatements("UPDATE t SET a=$$ where $$")).toEqual(['UPDATE without WHERE']);
  });

  it('handles backslash escapes per dialect', () => {
    // MySQL: \' stays inside the string, so the WHERE is real.
    expect(unsafeStatements("UPDATE t SET a='x\\' where' WHERE id=1", 'mysql')).toEqual([]);
    // Postgres: backslash is literal, the string ends at \' and WHERE is real.
    expect(unsafeStatements("UPDATE t SET a='C:\\' WHERE id=1", 'postgres')).toEqual([]);
    expect(unsafeStatements("UPDATE t SET a=E'x\\' where' ", 'postgres')).toEqual([
      'UPDATE without WHERE',
    ]);
  });

  it('checks every ;-separated statement, and ; inside strings does not split', () => {
    expect(unsafeStatements('SELECT 1; DELETE FROM t; UPDATE t SET a=1 WHERE b=2; DROP VIEW v')).toEqual([
      'DELETE without WHERE',
      'DROP',
    ]);
    expect(unsafeStatements("UPDATE t SET a=';' WHERE id=1")).toEqual([]);
  });

  it('does not let a subquery WHERE vouch for the outer statement', () => {
    expect(unsafeStatements('UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)')).toEqual([
      'UPDATE without WHERE',
    ]);
    expect(unsafeStatements('DELETE FROM t WHERE id IN (SELECT id FROM u)')).toEqual([]);
  });

  it('finds the verb after a CTE', () => {
    expect(unsafeStatements('WITH x AS (SELECT 1 WHERE true) DELETE FROM t')).toEqual([
      'DELETE without WHERE',
    ]);
    expect(unsafeStatements('WITH x AS (SELECT 1) SELECT * FROM x')).toEqual([]);
  });
});

describe('isSelectLike', () => {
  it('accepts one read-only statement', () => {
    expect(isSelectLike('SELECT * FROM t;')).toBe(true);
    expect(isSelectLike('-- all\nselect a from t where b = 1')).toBe(true);
    expect(isSelectLike('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true);
    expect(isSelectLike('(SELECT 1) UNION (SELECT 2)')).toBe(true);
    expect(isSelectLike("SELECT 'delete'")).toBe(true);
    expect(isSelectLike('SHOW TABLES', 'mysql')).toBe(true);
  });

  it('rejects writes, DDL, empty input and multiple statements', () => {
    expect(isSelectLike('DELETE FROM t')).toBe(false);
    expect(isSelectLike('CREATE TABLE t (a int)')).toBe(false);
    expect(isSelectLike('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d')).toBe(false);
    expect(isSelectLike('SELECT 1; SELECT 2')).toBe(false);
    expect(isSelectLike('  ')).toBe(false);
  });
});
