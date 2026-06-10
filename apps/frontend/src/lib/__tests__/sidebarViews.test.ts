import { describe, expect, it } from 'vitest';
import {
  moveView,
  normalizeOrder,
  resolveRailViews,
  SIDEBAR_VIEWS,
} from '../sidebarViews';
import type { SidebarView } from '../../state/files';

const ALL = SIDEBAR_VIEWS.map((v) => v.id);

describe('normalizeOrder', () => {
  it('defaults to the catalogue order when empty', () => {
    expect(normalizeOrder([])).toEqual(ALL);
  });

  it('keeps a custom order and appends views it omits', () => {
    const out = normalizeOrder(['ssh', 'git']);
    expect(out.slice(0, 2)).toEqual(['ssh', 'git']);
    // Every catalogue view still appears exactly once.
    expect([...out].sort()).toEqual([...ALL].sort());
  });

  it('drops unknown ids and de-duplicates', () => {
    const out = normalizeOrder(['git', 'git', 'bogus' as SidebarView, 'files']);
    expect(out.filter((v) => v === 'git')).toHaveLength(1);
    expect(out).not.toContain('bogus');
    expect(out[0]).toBe('git');
  });
});

describe('resolveRailViews', () => {
  it('omits hidden views', () => {
    const ids = resolveRailViews([], ['ssh', 'agents']).map((v) => v.id);
    expect(ids).not.toContain('ssh');
    expect(ids).not.toContain('agents');
    expect(ids).toContain('files');
  });

  it('never hides Explorer even if asked', () => {
    const ids = resolveRailViews([], ['files']).map((v) => v.id);
    expect(ids).toContain('files');
  });
});

describe('moveView', () => {
  it('swaps a view earlier and later', () => {
    const base = normalizeOrder([]);
    const moved = moveView(base, base[1]!, -1);
    expect(moved[0]).toBe(base[1]);
    expect(moved[1]).toBe(base[0]);
  });

  it('is a no-op at the bounds', () => {
    const base = normalizeOrder([]);
    expect(moveView(base, base[0]!, -1)).toEqual(base);
    expect(moveView(base, base[base.length - 1]!, 1)).toEqual(base);
  });
});
