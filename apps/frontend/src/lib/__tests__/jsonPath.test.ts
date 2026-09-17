import { describe, expect, it } from 'vitest';
import { parseJsonPath, queryJsonPath } from '../jsonPath';

const doc = {
  data: { accessToken: 'abc', 'x-y': { z: 1 }, items: [{ id: 7 }, { id: 8, tags: ['a', 'b'] }] },
  ok: false,
  nothing: null,
};

describe('jsonPath', () => {
  it('parses dotted, indexed and quoted segments', () => {
    expect(parseJsonPath('$')).toEqual([]);
    expect(parseJsonPath('$.a.b')).toEqual(['a', 'b']);
    expect(parseJsonPath(`$.a[0].b`)).toEqual(['a', 0, 'b']);
    expect(parseJsonPath(`$['x-y']["q.r"][ 2 ]`)).toEqual(['x-y', 'q.r', 2]);
    expect(parseJsonPath(`$['it\\'s']`)).toEqual([`it's`]);
  });

  it('rejects paths outside the subset', () => {
    expect(() => parseJsonPath('data.token')).toThrow();
    expect(() => parseJsonPath('$.')).toThrow();
    expect(() => parseJsonPath('$[*]')).toThrow();
    expect(() => parseJsonPath('$..id')).toThrow();
  });

  it('reads values', () => {
    expect(queryJsonPath(doc, '$.data.accessToken')).toBe('abc');
    expect(queryJsonPath(doc, `$.data['x-y'].z`)).toBe(1);
    expect(queryJsonPath(doc, '$.data.items[1].tags[0]')).toBe('a');
    expect(queryJsonPath(doc, '$.ok')).toBe(false);
    expect(queryJsonPath(doc, '$.nothing')).toBe(null);
    expect(queryJsonPath(doc, '$')).toBe(doc);
  });

  it('returns undefined for missing steps and type mismatches', () => {
    expect(queryJsonPath(doc, '$.data.missing')).toBeUndefined();
    expect(queryJsonPath(doc, '$.data.items[5].id')).toBeUndefined();
    expect(queryJsonPath(doc, '$.data[0]')).toBeUndefined();
    expect(queryJsonPath(doc, '$.data.items.length')).toBeUndefined();
    expect(queryJsonPath(doc, '$.nothing.x')).toBeUndefined();
    expect(queryJsonPath(doc, '$.data.toString')).toBeUndefined();
  });
});
