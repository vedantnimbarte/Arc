import { describe, expect, it } from 'vitest';
import { defaultWidthForView, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from '../files';

describe('defaultWidthForView', () => {
  it('uses the file-tree default for Explorer and Git', () => {
    expect(defaultWidthForView('files')).toBe(SIDEBAR_DEFAULT);
    expect(defaultWidthForView('git')).toBe(SIDEBAR_DEFAULT);
  });

  it('gives SSH / Search / Agents a wider default', () => {
    expect(defaultWidthForView('ssh')).toBeGreaterThan(SIDEBAR_DEFAULT);
    expect(defaultWidthForView('search')).toBeGreaterThan(SIDEBAR_DEFAULT);
    expect(defaultWidthForView('agents')).toBeGreaterThan(SIDEBAR_DEFAULT);
  });

  it('always returns a width within the clamp range', () => {
    for (const view of ['files', 'git', 'ssh', 'search', 'outline', 'agents'] as const) {
      const w = defaultWidthForView(view);
      expect(w).toBeGreaterThanOrEqual(SIDEBAR_MIN);
      expect(w).toBeLessThanOrEqual(SIDEBAR_MAX);
    }
  });
});
