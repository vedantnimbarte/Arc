import { describe, expect, it } from 'vitest';
import {
  allLeaves,
  appendTabToLeaf,
  countLayoutTabs,
  findLeaf,
  findLeafContaining,
  insertTabIntoLeaf,
  layoutCoversTabs,
  normalizeLeafOrder,
  pruneEmptyGroups,
  pruneLayout,
  reorderLeafTabs,
  setLeafActiveTab,
  splitLeafForTab,
  updateSplitSizes,
  type PaneLeaf,
  type PaneNode,
  type Tab,
  type TabGroup,
} from '../workspace';

// The pane tree is the state that, when it drifts, leaves the user staring at
// an empty pane or a tab that exists in two places at once — and it is
// persisted, so a bad edit survives a restart. These are its pure reducers.

const leaf = (id: string, tabIds: string[], activeTabId?: string | null): PaneLeaf => ({
  kind: 'leaf',
  id,
  tabIds,
  activeTabId: activeTabId === undefined ? (tabIds[0] ?? null) : activeTabId,
});

const split = (
  id: string,
  direction: 'horizontal' | 'vertical',
  children: PaneNode[],
  sizes?: number[],
): PaneNode => ({
  kind: 'split',
  id,
  direction,
  children,
  sizes: sizes ?? children.map(() => 100 / children.length),
});

const tab = (id: string, groupId?: string): Tab => ({
  id,
  title: id,
  kind: 'terminal',
  ...(groupId ? { groupId } : {}),
});

describe('findLeaf / findLeafContaining / allLeaves', () => {
  const tree = split('s1', 'horizontal', [leaf('a', ['t1', 't2']), leaf('b', ['t3'])]);

  it('finds a leaf by id and a leaf by the tab it holds', () => {
    expect(findLeaf(tree, 'b')?.tabIds).toEqual(['t3']);
    expect(findLeafContaining(tree, 't2')?.id).toBe('a');
  });

  it('returns null for ids that are not present', () => {
    expect(findLeaf(tree, 'nope')).toBeNull();
    expect(findLeafContaining(tree, 'nope')).toBeNull();
  });

  it('collects every leaf in DFS order', () => {
    const nested = split('s0', 'vertical', [tree, leaf('c', ['t4'])]);
    expect(allLeaves(nested).map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(countLayoutTabs(nested)).toBe(4);
  });
});

describe('pruneLayout', () => {
  it('removes the tab and keeps the leaf when others remain', () => {
    const out = pruneLayout(leaf('a', ['t1', 't2']), new Set(['t1'])) as PaneLeaf;
    expect(out.tabIds).toEqual(['t2']);
    expect(out.activeTabId).toBe('t2');
  });

  it('picks a surviving tab when the active one was the one removed', () => {
    const out = pruneLayout(leaf('a', ['t1', 't2'], 't1'), new Set(['t1'])) as PaneLeaf;
    expect(out.activeTabId).toBe('t2');
  });

  it('collapses a split to its remaining child when a leaf empties', () => {
    const tree = split('s1', 'horizontal', [leaf('a', ['t1']), leaf('b', ['t2'])]);
    const out = pruneLayout(tree, new Set(['t1']));
    // The sibling replaces the split entirely — no split with one child.
    expect(out).toMatchObject({ kind: 'leaf', id: 'b' });
  });

  it('returns null when the whole tree empties, so the caller can re-seed', () => {
    expect(pruneLayout(leaf('a', ['t1']), new Set(['t1']))).toBeNull();
  });

  it('renormalizes sizes to ~100 after dropping a child', () => {
    const tree = split(
      's1',
      'horizontal',
      [leaf('a', ['t1']), leaf('b', ['t2']), leaf('c', ['t3'])],
      [20, 30, 50],
    );
    const out = pruneLayout(tree, new Set(['t1']));
    expect(out).toMatchObject({ kind: 'split' });
    const sizes = (out as { sizes: number[] }).sizes;
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    // The survivors keep their 30:50 ratio.
    expect(sizes[0]! / sizes[1]!).toBeCloseTo(30 / 50);
  });

  it('returns the identical node when nothing changed', () => {
    const l = leaf('a', ['t1']);
    expect(pruneLayout(l, new Set(['other']))).toBe(l);
  });
});

describe('appendTabToLeaf / setLeafActiveTab', () => {
  it('appends and activates', () => {
    const out = appendTabToLeaf(leaf('a', ['t1']), 'a', 't2') as PaneLeaf;
    expect(out.tabIds).toEqual(['t1', 't2']);
    expect(out.activeTabId).toBe('t2');
  });

  it('activates without duplicating a tab the leaf already holds', () => {
    const out = appendTabToLeaf(leaf('a', ['t1', 't2'], 't1'), 'a', 't2') as PaneLeaf;
    expect(out.tabIds).toEqual(['t1', 't2']);
    expect(out.activeTabId).toBe('t2');
  });

  it('refuses to activate a tab the leaf does not hold', () => {
    const l = leaf('a', ['t1']);
    expect(setLeafActiveTab(l, 'a', 'elsewhere')).toBe(l);
  });
});

describe('insertTabIntoLeaf', () => {
  const tree = split('s1', 'horizontal', [leaf('a', ['t1', 't2']), leaf('b', ['t3'])]);

  it('inserts before a named tab', () => {
    const out = insertTabIntoLeaf(tree, 'a', 't3', 't2');
    expect(findLeaf(out, 'a')?.tabIds).toEqual(['t1', 't3', 't2']);
  });

  it('appends when no anchor is given', () => {
    const out = insertTabIntoLeaf(tree, 'a', 't3', null);
    expect(findLeaf(out, 'a')?.tabIds).toEqual(['t1', 't2', 't3']);
  });

  it('moves rather than copies — the source leaf loses the tab', () => {
    // A tab appearing in two leaves at once would mount its component twice
    // and spawn a second PTY for one terminal.
    const out = insertTabIntoLeaf(tree, 'a', 't3', null);
    expect(findLeaf(out, 'b')?.tabIds).toEqual([]);
  });

  it('repoints the source leaf active tab when it loses the active one', () => {
    const t = split('s1', 'horizontal', [leaf('a', ['t1']), leaf('b', ['t2', 't3'], 't2')]);
    const out = insertTabIntoLeaf(t, 'a', 't2', null);
    expect(findLeaf(out, 'b')?.activeTabId).toBe('t3');
  });

  it('reorders within one leaf without duplicating', () => {
    const out = insertTabIntoLeaf(leaf('a', ['t1', 't2', 't3']), 'a', 't3', 't1') as PaneLeaf;
    expect(out.tabIds).toEqual(['t3', 't1', 't2']);
  });
});

describe('splitLeafForTab', () => {
  const base = leaf('a', ['t1', 't2'], 't1');

  it('puts the new leaf second for right/bottom and first for left/top', () => {
    const right = splitLeafForTab(base, 'a', 'right', 't2') as { children: PaneNode[] };
    expect((right.children[1] as PaneLeaf).tabIds).toEqual(['t2']);
    const left = splitLeafForTab(base, 'a', 'left', 't2') as { children: PaneNode[] };
    expect((left.children[0] as PaneLeaf).tabIds).toEqual(['t2']);
  });

  it('maps left/right to a horizontal split and top/bottom to vertical', () => {
    expect(splitLeafForTab(base, 'a', 'right', 't2')).toMatchObject({
      direction: 'horizontal',
    });
    expect(splitLeafForTab(base, 'a', 'bottom', 't2')).toMatchObject({
      direction: 'vertical',
    });
  });

  it('removes the moved tab from the leaf it came from', () => {
    const out = splitLeafForTab(base, 'a', 'right', 't2') as { children: PaneNode[] };
    expect((out.children[0] as PaneLeaf).tabIds).toEqual(['t1']);
  });

  it('strips the tab from a foreign leaf that held it', () => {
    const tree = split('s1', 'horizontal', [leaf('a', ['t1']), leaf('b', ['t2'])]);
    const out = splitLeafForTab(tree, 'a', 'right', 't2');
    // 't2' now lives only in the newly created leaf.
    const holders = allLeaves(out).filter((l) => l.tabIds.includes('t2'));
    expect(holders).toHaveLength(1);
    expect(holders[0]!.id).not.toBe('b');
  });

  it('repoints the source active tab when the moved tab was active', () => {
    const out = splitLeafForTab(base, 'a', 'right', 't1') as { children: PaneNode[] };
    expect((out.children[0] as PaneLeaf).activeTabId).toBe('t2');
  });
});

describe('normalizeLeafOrder', () => {
  const groupOf = (map: Record<string, string>) => (id: string) => map[id];

  it('gathers a fragmented group at its earliest member position', () => {
    const order = normalizeLeafOrder(
      ['t1', 't2', 't3', 't4'],
      groupOf({ t1: 'g1', t3: 'g1' }),
    );
    expect(order).toEqual(['t1', 't3', 't2', 't4']);
  });

  it('is stable — normalizing an already-normal order changes nothing', () => {
    const map = groupOf({ t1: 'g1', t2: 'g1' });
    const once = normalizeLeafOrder(['t1', 't2', 't3'], map);
    expect(normalizeLeafOrder(once, map)).toEqual(once);
  });

  it('leaves ungrouped tabs in their slots', () => {
    expect(normalizeLeafOrder(['a', 'b', 'c'], () => undefined)).toEqual(['a', 'b', 'c']);
  });

  it('keeps two groups apart', () => {
    const order = normalizeLeafOrder(
      ['t1', 't2', 't3', 't4'],
      groupOf({ t1: 'g1', t2: 'g2', t3: 'g1', t4: 'g2' }),
    );
    expect(order).toEqual(['t1', 't3', 't2', 't4']);
  });
});

describe('reorderLeafTabs', () => {
  it('replaces one leaf ordering and leaves siblings alone', () => {
    const tree = split('s1', 'horizontal', [leaf('a', ['t1', 't2']), leaf('b', ['t3'])]);
    const out = reorderLeafTabs(tree, 'a', ['t2', 't1']);
    expect(findLeaf(out, 'a')?.tabIds).toEqual(['t2', 't1']);
    expect(findLeaf(out, 'b')?.tabIds).toEqual(['t3']);
  });
});

describe('pruneEmptyGroups', () => {
  const groups: TabGroup[] = [
    { id: 'g1', name: 'one', color: 'blue', collapsed: false },
    { id: 'g2', name: 'two', color: 'red', collapsed: false },
  ];

  it('drops groups with no remaining members', () => {
    expect(pruneEmptyGroups(groups, [tab('t1', 'g1')]).map((g) => g.id)).toEqual(['g1']);
  });

  it('returns the same array when every group still has a member', () => {
    const tabs = [tab('t1', 'g1'), tab('t2', 'g2')];
    expect(pruneEmptyGroups(groups, tabs)).toBe(groups);
  });
});

describe('updateSplitSizes', () => {
  const tree = split('s1', 'horizontal', [leaf('a', ['t1']), leaf('b', ['t2'])], [50, 50]);

  it('applies new sizes to the named split', () => {
    expect(updateSplitSizes(tree, 's1', [30, 70])).toMatchObject({ sizes: [30, 70] });
  });

  it('ignores a size array of the wrong length rather than corrupting the tree', () => {
    expect(updateSplitSizes(tree, 's1', [100])).toBe(tree);
  });

  it('no-ops on sub-0.01 deltas, so a drag does not write on every pointer move', () => {
    expect(updateSplitSizes(tree, 's1', [50.001, 49.999])).toBe(tree);
  });

  it('reaches a nested split', () => {
    const nested = split('s0', 'vertical', [tree, leaf('c', ['t3'])]);
    const out = updateSplitSizes(nested, 's1', [20, 80]);
    expect((out as { children: PaneNode[] }).children[0]).toMatchObject({ sizes: [20, 80] });
  });
});

describe('layoutCoversTabs', () => {
  it('accepts a layout referencing exactly the loaded tabs', () => {
    expect(layoutCoversTabs(leaf('a', ['t1', 't2']), [tab('t1'), tab('t2')])).toBe(true);
  });

  it('rejects a layout referencing a tab that no longer exists', () => {
    // This is the drift that would leave the user staring at an empty pane.
    expect(layoutCoversTabs(leaf('a', ['t1', 'gone']), [tab('t1')])).toBe(false);
  });

  it('rejects a layout that misses a loaded tab', () => {
    expect(layoutCoversTabs(leaf('a', ['t1']), [tab('t1'), tab('t2')])).toBe(false);
  });
});
