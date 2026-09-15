import { describe, expect, it } from 'vitest';
import { describeError } from '../errorLog';

describe('describeError', () => {
  it('joins strings, errors and objects into one line', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at x';
    expect(describeError(['failed:', err, { code: 7 }])).toBe('failed: Error: boom\n    at x {"code":7}');
  });

  it('survives values JSON cannot encode', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeError([cyclic])).toBe('[object Object]');
  });
});
