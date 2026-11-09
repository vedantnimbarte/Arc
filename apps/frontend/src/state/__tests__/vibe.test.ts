import { beforeEach, describe, expect, it } from 'vitest';
import { allLeaves, singleLeafLayout, useWorkspace, type Tab } from '../workspace';
import { useFiles } from '../files';
import { useVibe } from '../vibe';

const WS = 'ws-vibe';

function seed(tabs: Tab[]) {
  const ids = tabs.map((t) => t.id);
  const layout = singleLeafLayout(ids, ids[0]!);
  useWorkspace.setState({
    tabs,
    activeTabId: ids[0]!,
    workspaces: [{ id: WS, name: 'Test' }],
    activeWorkspaceId: WS,
    layout,
    focusedPaneId: allLeaves(layout)[0]!.id,
    modeStash: {},
    tabGroups: [],
    maximizedPaneId: null,
    hydrated: false,
    sessionId: null,
  });
}

describe('vibe mode', () => {
  beforeEach(() => {
    useVibe.setState({ vibe: false, restore: null, floatingAgentOpen: true });
    if (useFiles.getState().collapsed) useFiles.getState().toggleCollapsed();
  });

  it('focuses the Claude tab, maximizes it, hides the sidebar, then restores on exit', () => {
    seed([
      { id: 'term', title: 'shell', kind: 'terminal', workspaceId: WS },
      { id: 'cc', title: 'Claude Code', kind: 'claude', workspaceId: WS },
    ]);

    useVibe.getState().enterVibe();
    expect(useWorkspace.getState().activeTabId).toBe('cc');
    expect(useWorkspace.getState().maximizedPaneId).toBe(useWorkspace.getState().focusedPaneId);
    expect(useFiles.getState().collapsed).toBe(true);
    expect(useVibe.getState().floatingAgentOpen).toBe(false);

    useVibe.getState().exitVibe();
    expect(useWorkspace.getState().maximizedPaneId).toBeNull();
    expect(useFiles.getState().collapsed).toBe(false);
    expect(useVibe.getState().vibe).toBe(false);
    expect(useVibe.getState().floatingAgentOpen).toBe(true);
  });

  it('leaves a sidebar the user had already collapsed collapsed', () => {
    seed([{ id: 'cc', title: 'Claude Code', kind: 'claude', workspaceId: WS }]);
    useFiles.getState().toggleCollapsed();

    useVibe.getState().enterVibe();
    useVibe.getState().exitVibe();
    expect(useFiles.getState().collapsed).toBe(true);
  });
});
