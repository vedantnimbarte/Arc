import { beforeEach, describe, expect, it } from 'vitest';
import {
  allLeaves,
  countLayoutTabs,
  findLeafContaining,
  flattenTabIds,
  layoutModeOf,
  singleLeafLayout,
  splitLeafForTab,
  tileAll,
  useWorkspace,
  type PaneNode,
  type Tab,
} from '../workspace';

// Switching layout mode rewrites the pane tree in place. The failure that
// matters is a tab surviving in `tabs[]` while dropping out of the tree — in
// tiling mode there is no tab strip, so an orphaned tab is simply unreachable.
// Every case below is really asking "can the user still get to all of them?".

const WS = 'ws-test';

function tab(id: string): Tab {
  return { id, title: id, kind: 'terminal', workspaceId: WS };
}

/** Seed the store with `n` tiled tabs, as `addTab` would have built them. */
function seed(n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `t${i + 1}`);
  useWorkspace.setState({
    tabs: ids.map(tab),
    activeTabId: ids[0]!,
    workspaces: [{ id: WS, name: 'Test' }],
    activeWorkspaceId: WS,
    layout: tileAll(ids, ids[0]!),
    focusedPaneId: allLeaves(tileAll(ids, ids[0]!))[0]!.id,
    modeStash: {},
    tabGroups: [],
    maximizedPaneId: null,
    hydrated: false,
    sessionId: null,
  });
  // Re-anchor focus on the tree we actually stored.
  const s = useWorkspace.getState();
  useWorkspace.setState({ focusedPaneId: findLeafContaining(s.layout, ids[0]!)!.id });
  return ids;
}

/** Structural equality ignoring generated ids — what "same layout" means to
 *  the user is the shape and the tab placement, not the pane id strings. */
function shape(node: PaneNode): unknown {
  return node.kind === 'leaf'
    ? { kind: 'leaf', tabIds: node.tabIds }
    : { kind: 'split', direction: node.direction, children: node.children.map(shape) };
}

beforeEach(() => {
  useWorkspace.setState({ modeStash: {} });
});

describe('tileAll', () => {
  it('gives every tab its own pane', () => {
    const tree = tileAll(['a', 'b', 'c', 'd'], 'a');
    expect(allLeaves(tree)).toHaveLength(4);
    expect(allLeaves(tree).every((l) => l.tabIds.length === 1)).toBe(true);
    expect(countLayoutTabs(tree)).toBe(4);
  });

  it('preserves order and honours the requested active tab', () => {
    const tree = tileAll(['a', 'b', 'c'], 'c');
    expect(flattenTabIds(tree)).toEqual(['a', 'b', 'c']);
    expect(findLeafContaining(tree, 'c')!.activeTabId).toBe('c');
  });

  it('handles the degenerate sizes', () => {
    expect(countLayoutTabs(tileAll([], null))).toBe(0);
    expect(allLeaves(tileAll(['solo'], 'solo'))).toHaveLength(1);
  });

  it('falls back to the first tab when the active one is not in the list', () => {
    const tree = tileAll(['a', 'b'], 'gone');
    expect(findLeafContaining(tree, 'a')!.activeTabId).toBe('a');
  });
});

describe('layoutModeOf', () => {
  it('reads an absent mode as tiling, so old sessions do not migrate', () => {
    expect(layoutModeOf([{ id: 'w', name: 'W' }], 'w')).toBe('tiling');
    expect(layoutModeOf([{ id: 'w', name: 'W', mode: 'standard' }], 'w')).toBe('standard');
  });

  it('reads an unknown workspace as tiling rather than throwing', () => {
    expect(layoutModeOf([], 'nope')).toBe('tiling');
  });
});

describe('setLayoutMode', () => {
  it('flattens every pane into one leaf when entering standard', () => {
    const ids = seed(3);
    useWorkspace.getState().setLayoutMode('standard');
    const s = useWorkspace.getState();
    expect(layoutModeOf(s.workspaces, WS)).toBe('standard');
    expect(allLeaves(s.layout)).toHaveLength(1);
    expect(allLeaves(s.layout)[0]!.tabIds).toEqual(ids);
  });

  it('restores the exact tree it left on the way back to tiling', () => {
    seed(3);
    const before = shape(useWorkspace.getState().layout);
    useWorkspace.getState().setLayoutMode('standard');
    useWorkspace.getState().setLayoutMode('tiling');
    expect(shape(useWorkspace.getState().layout)).toEqual(before);
  });

  it('keeps hand-dragged pane sizes across a round trip', () => {
    seed(3);
    // Simulate a resize: the stash must carry the sizes back, not re-tile.
    const root = useWorkspace.getState().layout;
    expect(root.kind).toBe('split');
    if (root.kind !== 'split') return;
    useWorkspace.setState({ layout: { ...root, sizes: [70, 30] } });
    useWorkspace.getState().setLayoutMode('standard');
    useWorkspace.getState().setLayoutMode('tiling');
    const back = useWorkspace.getState().layout;
    expect(back.kind === 'split' ? back.sizes : null).toEqual([70, 30]);
  });

  it('is a no-op when already in the requested mode', () => {
    seed(2);
    const before = useWorkspace.getState().layout;
    useWorkspace.getState().setLayoutMode('tiling');
    expect(useWorkspace.getState().layout).toBe(before);
  });

  it('re-tiles rather than collapsing when the stash no longer fits', () => {
    // The case that actually strands tabs: tabs opened while in standard mode
    // make the parked tiling tree stale, so it must be rebuilt — a single leaf
    // here would hide every tab but the active one.
    const ids = seed(2);
    useWorkspace.getState().setLayoutMode('standard');
    const extra = tab('t3');
    useWorkspace.setState((s) => ({
      tabs: [...s.tabs, extra],
      layout: singleLeafLayout([...ids, extra.id], extra.id),
      activeTabId: extra.id,
    }));
    useWorkspace.setState((s) => ({
      focusedPaneId: allLeaves(s.layout)[0]!.id,
    }));

    useWorkspace.getState().setLayoutMode('tiling');
    const s = useWorkspace.getState();
    expect(countLayoutTabs(s.layout)).toBe(3);
    expect(allLeaves(s.layout)).toHaveLength(3);
    expect(new Set(flattenTabIds(s.layout))).toEqual(new Set(['t1', 't2', 't3']));
  });

  it('leaves focus on a leaf that exists in the new tree', () => {
    seed(3);
    useWorkspace.getState().setLayoutMode('standard');
    const s = useWorkspace.getState();
    expect(allLeaves(s.layout).some((l) => l.id === s.focusedPaneId)).toBe(true);
    expect(s.activeTabId).not.toBeNull();
  });

  it('drops the maximized pane, whose leaf does not survive the rewrite', () => {
    seed(3);
    const paneId = allLeaves(useWorkspace.getState().layout)[0]!.id;
    useWorkspace.setState({ maximizedPaneId: paneId });
    useWorkspace.getState().setLayoutMode('standard');
    expect(useWorkspace.getState().maximizedPaneId).toBeNull();
  });

  it('round-trips a standard-mode split too, not just the tiling tree', () => {
    seed(2);
    useWorkspace.getState().setLayoutMode('standard');
    // Split by hand — standard mode still allows it (VS Code style).
    const leafId = allLeaves(useWorkspace.getState().layout)[0]!.id;
    useWorkspace.setState((s) => ({
      layout: splitLeafForTab(s.layout, leafId, 'right', 't2'),
    }));
    const before = shape(useWorkspace.getState().layout);
    useWorkspace.getState().setLayoutMode('tiling');
    useWorkspace.getState().setLayoutMode('standard');
    expect(shape(useWorkspace.getState().layout)).toEqual(before);
  });
});

describe('addTab', () => {
  it('appends into the focused pane in standard mode', () => {
    seed(2);
    useWorkspace.getState().setLayoutMode('standard');
    useWorkspace.getState().addTab(tab('t3'));
    const s = useWorkspace.getState();
    expect(allLeaves(s.layout)).toHaveLength(1);
    expect(allLeaves(s.layout)[0]!.tabIds).toEqual(['t1', 't2', 't3']);
    expect(s.activeTabId).toBe('t3');
  });

  it('splits into a new pane in tiling mode', () => {
    seed(2);
    useWorkspace.getState().addTab(tab('t3'));
    const s = useWorkspace.getState();
    expect(allLeaves(s.layout)).toHaveLength(3);
    expect(findLeafContaining(s.layout, 't3')!.tabIds).toEqual(['t3']);
  });
});
