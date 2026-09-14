import { beforeEach, describe, expect, it } from 'vitest';
import { singleLeafLayout, useWorkspace, type Tab } from '../workspace';

// Ctrl+Shift+T: closing a tab should be undoable within the workspace it
// happened in, capped so a long session doesn't grow the stack forever, and
// "cold" on the way back — no dead ptyId, no stale one-off launch args.

const WS_A = 'ws-a';
const WS_B = 'ws-b';

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return { id, title: id, kind: 'terminal', workspaceId: WS_A, ...overrides };
}

/** Seed a single tab in a single leaf, active workspace `WS_A` unless
 *  overridden — enough for `addTab`/`closeTab` to have somewhere to work. */
function seed(tabs: Tab[], activeWorkspaceId = WS_A) {
  const ids = tabs.map((t) => t.id);
  const layout = singleLeafLayout(ids, ids[0] ?? null);
  useWorkspace.setState({
    tabs,
    activeTabId: ids[0] ?? null,
    workspaces: [{ id: WS_A, name: 'A' }, { id: WS_B, name: 'B' }],
    activeWorkspaceId,
    layout,
    focusedPaneId: layout.id,
    layoutStash: {},
    modeStash: {},
    tabGroups: [],
    tabDirty: {},
    closedTabs: [],
    maximizedPaneId: null,
    hydrated: false,
    sessionId: null,
  });
}

beforeEach(() => {
  seed([tab('t1')]);
});

describe('closeTab / reopenClosedTab', () => {
  it('reopens the tab it just closed, as the active tab', () => {
    useWorkspace.getState().closeTab('t1');
    expect(useWorkspace.getState().tabs.map((t) => t.id)).toEqual([]);

    useWorkspace.getState().reopenClosedTab();
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(s.activeTabId).toBe('t1');
    expect(s.closedTabs).toEqual([]);
  });

  it('is a no-op when nothing has been closed in the active workspace', () => {
    const before = useWorkspace.getState().tabs;
    useWorkspace.getState().reopenClosedTab();
    expect(useWorkspace.getState().tabs).toBe(before);
  });

  it('only reopens tabs closed in the currently active workspace', () => {
    seed([tab('a1', { workspaceId: WS_A })], WS_A);
    useWorkspace.getState().closeTab('a1');

    // Switch to workspace B with its own empty layout — reopening here
    // should find nothing, even though A has a closed tab waiting.
    const layoutB = singleLeafLayout([], null);
    useWorkspace.setState({
      activeWorkspaceId: WS_B,
      tabs: [],
      layout: layoutB,
      focusedPaneId: layoutB.id,
    });
    useWorkspace.getState().reopenClosedTab();
    expect(useWorkspace.getState().tabs).toEqual([]);

    // Back in A, the closed tab is still there.
    const layoutA = singleLeafLayout([], null);
    useWorkspace.setState({
      activeWorkspaceId: WS_A,
      tabs: [],
      layout: layoutA,
      focusedPaneId: layoutA.id,
    });
    useWorkspace.getState().reopenClosedTab();
    expect(useWorkspace.getState().tabs.map((t) => t.id)).toEqual(['a1']);
  });

  it('strips transient fields so a reopened terminal spawns fresh', () => {
    seed([
      tab('term1', {
        profileId: 'p1',
        ptyId: 'pty-dead',
        launchCwd: '/some/dir',
        cwd: '/some/dir',
        shellOverride: '/bin/zsh',
        shellArgs: ['-l'],
      }),
    ]);
    useWorkspace.getState().closeTab('term1');
    useWorkspace.getState().reopenClosedTab();

    const reopened = useWorkspace.getState().tabs.find((t) => t.id === 'term1');
    expect(reopened?.profileId).toBe('p1'); // identity — kept
    expect(reopened?.ptyId).toBeUndefined();
    expect(reopened?.launchCwd).toBeUndefined();
    expect(reopened?.cwd).toBeUndefined();
    expect(reopened?.shellOverride).toBeUndefined();
    expect(reopened?.shellArgs).toBeUndefined();
  });

  it('caps the closed-tab stack per workspace, dropping the oldest first', () => {
    const tabs = Array.from({ length: 11 }, (_, i) => tab(`t${i + 1}`));
    seed(tabs);
    for (const t of tabs) useWorkspace.getState().closeTab(t.id);

    const closedIds = useWorkspace.getState().closedTabs.map((t) => t.id);
    expect(closedIds).toHaveLength(10);
    expect(closedIds).not.toContain('t1'); // oldest, evicted
    expect(closedIds).toContain('t11'); // newest, kept

    // Reopening walks back newest-first, same as closing order in reverse.
    useWorkspace.getState().reopenClosedTab();
    expect(useWorkspace.getState().tabs.some((t) => t.id === 't11')).toBe(true);
  });
});
