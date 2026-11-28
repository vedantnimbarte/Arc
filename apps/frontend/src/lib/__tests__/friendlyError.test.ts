import { describe, expect, it } from 'vitest';
import { friendlyError } from '../friendlyError';

describe('friendlyError', () => {
  it('maps common causes to plain sentences and keeps the raw text', () => {
    const r = friendlyError(new Error('HTTP 401: Bad credentials'));
    expect(r.message).toBe('You were signed out. Sign in again.');
    expect(r.detail).toBe('HTTP 401: Bad credentials');
    expect(friendlyError('API rate limit exceeded for user').message).toMatch(/hourly request limit/);
    expect(friendlyError('connect ECONNREFUSED 127.0.0.1:5432').message).toMatch(/Nothing answered/);
    expect(friendlyError(new TypeError('Failed to fetch')).message).toMatch(/Can't reach/);
  });

  it('falls back to the first line, capitalised, with details only when there is more', () => {
    expect(friendlyError('error: pathspec did not match')).toEqual({
      message: 'Pathspec did not match',
      detail: 'error: pathspec did not match',
    });
    expect(friendlyError('Merge conflict in a.ts')).toEqual({ message: 'Merge conflict in a.ts', detail: '' });
    expect(friendlyError('line one\nline two').detail).toBe('line one\nline two');
    expect(friendlyError(null).message).toBe('Something went wrong.');
  });
});
