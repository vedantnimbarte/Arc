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
    const ids = resolveRailViews([], ['ssh']).map((v) => v.id);
    expect(ids).not.toContain('ssh');
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

describe('the Wingman + Claude Code merge', () => {
  // Those two views became one `agents` panel. Anyone upgrading has the old
  // ids in their persisted rail order, and `normalizeOrder` is what has to
  // drop them — a stale id would index `SIDEBAR_VIEW_BY_ID` to undefined and
  // render an empty rail slot.
  it('drops the retired ids from a saved order', () => {
    const out = normalizeOrder(['git', 'wingman', 'claude', 'ssh'] as unknown as SidebarView[]);
    expect(out).not.toContain('wingman' as SidebarView);
    expect(out).not.toContain('claude' as SidebarView);
    expect(out.slice(0, 2)).toEqual(['git', 'ssh']);
  });

  it('appends the merged view for someone who never had it', () => {
    expect(normalizeOrder(['files'])).toContain('agents' as SidebarView);
    expect(ALL).toContain('agents' as SidebarView);
  });

  it('leaves every rail entry resolvable', () => {
    const rail = resolveRailViews(['wingman', 'claude'] as unknown as SidebarView[], []);
    expect(rail.every((v) => v && v.id && v.label)).toBe(true);
  });
});
