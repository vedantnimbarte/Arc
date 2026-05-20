import { create } from 'zustand';
import { isTauri, sessionLoad, sessionSaveTabs, type TabInput } from '../lib/tauri';

export interface Tab {
  id: string;
  title: string;
  kind: 'terminal' | 'editor';
  /** PTY id of the *active* pane in this tab, mirrored here so other panes
   *  (file tree click-to-paste, command palette) can keep writing into "the
   *  active terminal" without knowing about the pane tree. Transient —
   *  stripped from persisted state since PTYs don't survive reload. */
  ptyId?: string;
  /** Absolute path for editor tabs (read on mount). */
  filePath?: string;
  /** Pane tree (terminal tabs only). Lazily created on first render so that
   *  hydrated tabs from SQLite get a fresh tree. Transient. */
  paneTree?: PaneNode;
  /** Id of the currently-focused leaf pane inside `paneTree`. Transient. */
  activePaneId?: string;
}

/** A binary tree of terminal panes. Leaves own a real PTY; splits arrange
 *  two children either side-by-side ('vertical' — like `tmux split-window -h`)
 *  or stacked ('horizontal' — like `tmux split-window -v`). The naming
 *  matches tmux's mental model of "how is the split line drawn". */
export type PaneNode =
  | { kind: 'leaf'; id: string }
  | {
      kind: 'split';
      direction: 'horizontal' | 'vertical';
      /** Fraction of the parent occupied by `a` (0..1). */
      ratio: number;
      a: PaneNode;
      b: PaneNode;
    };

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Per-tab dirty flag — set by the Editor when its buffer diverges
   *  from the last-saved content on disk. Kept off the Tab itself so
   *  it doesn't get accidentally persisted. */
  tabDirty: Record<string, boolean>;
  /** Map of pane id → live PTY id. Lookup is by pane (not tab) because a
   *  terminal tab may have several panes. The active-pane's value is
   *  mirrored onto `Tab.ptyId` for legacy consumers. Transient. */
  panePtyIds: Record<string, string>;
  /** SQLite session id; null until `hydrate()` has run. Used as the key for
   *  every persistence write. */
  sessionId: string | null;
  /** Becomes true after the first hydrate() call (success or failure).
   *  Components can use this to delay any "write" side effects. */
  hydrated: boolean;
  addTab: (tab: Tab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  /** @deprecated kept for the few callers that still set the PTY at the
   *  tab level — internally routes through `setPanePtyId`. */
  setTabPtyId: (id: string, ptyId: string | undefined) => void;
  /** Register / clear the PTY id owned by a single pane. */
  setPanePtyId: (paneId: string, ptyId: string | undefined) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  /** Find an existing editor tab for `path`, or create one and focus it. */
  openFile: (path: string, title?: string) => string;
  /** Make `paneId` the focused pane in `tabId`, and mirror its PTY onto
   *  the tab so existing palette/file-tree code keeps working. */
  setActivePane: (tabId: string, paneId: string) => void;
  /** Split the active pane of `tabId` in the given direction. The new pane
   *  becomes the active pane. */
  splitActivePane: (tabId: string, direction: 'horizontal' | 'vertical') => void;
  /** Close the active pane. If only one pane remains, closes the tab. */
  closeActivePane: (tabId: string) => void;
  /** Cycle focus through the panes of a tab (depth-first leaf order). */
  cyclePane: (tabId: string, dir: 1 | -1) => void;
  /** Resize the split that owns a particular pane edge. */
  setSplitRatio: (tabId: string, splitPath: SplitPath, ratio: number) => void;
  /** One-time load from SQLite at app startup. Idempotent. */
  hydrate: () => Promise<void>;
}

/** A path from the root of a pane tree to a split node. Each step picks
 *  the `a` or `b` child. Used so the renderer can identify *which* split
 *  is being resized when multiple splits share a direction. */
export type SplitPath = ('a' | 'b')[];

const LEGACY_LS_KEY = 'arc-workspace';
const DEBOUNCE_MS = 250;

/** A single default tab — used when neither SQLite nor localStorage has any. */
const DEFAULT_TAB: Tab = { id: 'term-1', title: 'shell', kind: 'terminal' };

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  tabDirty: {},
  panePtyIds: {},
  sessionId: null,
  hydrated: false,
  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, ensurePaneTree(tab)],
      activeTabId: tab.id,
    })),
  closeTab: (id) =>
    set((s) => {
      const target = s.tabs.find((t) => t.id === id);
      const remaining = s.tabs.filter((t) => t.id !== id);
      const wasActive = s.activeTabId === id;
      const { [id]: _omit, ...nextDirty } = s.tabDirty;
      // Drop every pane-PTY entry that belonged to this tab so the map
      // doesn't leak entries forever.
      let nextPty = s.panePtyIds;
      if (target?.paneTree) {
        nextPty = { ...s.panePtyIds };
        for (const leaf of leafIds(target.paneTree)) delete nextPty[leaf];
      }
      return {
        tabs: remaining,
        activeTabId: wasActive ? (remaining[0]?.id ?? null) : s.activeTabId,
        tabDirty: nextDirty,
        panePtyIds: nextPty,
      };
    }),
  setActive: (id) => set({ activeTabId: id }),
  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
  setTabPtyId: (id, ptyId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ptyId } : t)),
    })),
  setPanePtyId: (paneId, ptyId) =>
    set((s) => {
      const next: Record<string, string> = { ...s.panePtyIds };
      if (ptyId) next[paneId] = ptyId;
      else delete next[paneId];
      // If this pane is the active pane of any tab, mirror onto Tab.ptyId.
      const tabs = s.tabs.map((t) =>
        t.activePaneId === paneId ? { ...t, ptyId: ptyId } : t,
      );
      return { panePtyIds: next, tabs };
    }),
  setActivePane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, activePaneId: paneId, ptyId: s.panePtyIds[paneId] }
          : t,
      ),
    })),
  splitActivePane: (tabId, direction) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== 'terminal') return s;
      const tree = tab.paneTree ?? { kind: 'leaf', id: tab.id };
      const activeId = tab.activePaneId ?? firstLeaf(tree);
      const newPaneId = `pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const next = splitLeaf(tree, activeId, direction, newPaneId);
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, paneTree: next, activePaneId: newPaneId, ptyId: undefined }
            : t,
        ),
      };
    }),
  closeActivePane: (tabId) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const tree = tab.paneTree;
    const activeId = tab.activePaneId;
    if (!tree || !activeId) {
      // No tree (or never focused) — just close the tab.
      get().closeTab(tabId);
      return;
    }
    const leaves = leafIds(tree);
    if (leaves.length <= 1) {
      // Last pane in the tab — close the whole tab.
      get().closeTab(tabId);
      return;
    }
    const nextTree = removeLeaf(tree, activeId);
    if (!nextTree) {
      get().closeTab(tabId);
      return;
    }
    // Pick the nearest surviving leaf as the new active pane.
    const newActive = firstLeaf(nextTree);
    set((curr) => {
      const nextPty: Record<string, string> = { ...curr.panePtyIds };
      delete nextPty[activeId];
      return {
        tabs: curr.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                paneTree: nextTree,
                activePaneId: newActive,
                ptyId: nextPty[newActive],
              }
            : t,
        ),
        panePtyIds: nextPty,
      };
    });
  },
  cyclePane: (tabId, dir) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab?.paneTree || !tab.activePaneId) return s;
      const leaves = leafIds(tab.paneTree);
      if (leaves.length < 2) return s;
      const idx = leaves.indexOf(tab.activePaneId);
      const nextIdx = (idx + dir + leaves.length) % leaves.length;
      const nextId = leaves[nextIdx]!;
      return {
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? { ...t, activePaneId: nextId, ptyId: s.panePtyIds[nextId] }
            : t,
        ),
      };
    }),
  setSplitRatio: (tabId, splitPath, ratio) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab?.paneTree) return s;
      const next = setRatio(tab.paneTree, splitPath, clamp01(ratio));
      return {
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, paneTree: next } : t)),
      };
    }),
  setTabDirty: (id, dirty) =>
    set((s) => {
      if (!!s.tabDirty[id] === dirty) return s; // no-op
      const next = { ...s.tabDirty };
      if (dirty) next[id] = true;
      else delete next[id];
      return { tabDirty: next };
    }),
  openFile: (path, title) => {
    const existing = get().tabs.find((t) => t.kind === 'editor' && t.filePath === path);
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const id = `edit-${Date.now()}`;
    const tab: Tab = {
      id,
      title: title ?? basename(path),
      kind: 'editor',
      filePath: path,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },
  hydrate: async () => {
    if (get().hydrated) return;

    // Browser fallback (pnpm dev, no Tauri): seed a default tab so the UI
    // doesn't render empty, but skip SQLite entirely.
    if (!isTauri) {
      const legacy = readLegacyLocalStorage();
      set({
        tabs: withPaneTrees(legacy?.tabs ?? [DEFAULT_TAB]),
        activeTabId: legacy?.activeTabId ?? DEFAULT_TAB.id,
        sessionId: null,
        hydrated: true,
      });
      return;
    }

    try {
      const loaded = await sessionLoad();
      const legacy = readLegacyLocalStorage();

      // Three states to handle:
      //   1. SQLite has tabs → use them (regular reopen).
      //   2. SQLite is empty + legacy LS exists → migrate, persist, use.
      //   3. SQLite is empty + nothing legacy → seed a default tab and persist.
      let tabs: Tab[];
      let activeTabId: string | null;

      if (loaded.tabs.length > 0) {
        tabs = loaded.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          filePath: t.file_path ?? undefined,
        }));
        activeTabId =
          loaded.session.active_tab_id && tabs.some((t) => t.id === loaded.session.active_tab_id)
            ? loaded.session.active_tab_id
            : (tabs[0]?.id ?? null);
      } else if (legacy && legacy.tabs.length > 0) {
        tabs = legacy.tabs;
        activeTabId =
          legacy.activeTabId && tabs.some((t) => t.id === legacy.activeTabId)
            ? legacy.activeTabId
            : (tabs[0]?.id ?? null);
        await persistTabs(loaded.session.id, tabs, activeTabId);
      } else {
        tabs = [DEFAULT_TAB];
        activeTabId = DEFAULT_TAB.id;
        await persistTabs(loaded.session.id, tabs, activeTabId);
      }

      // Migration's done — never read the LS key again.
      if (legacy) localStorage.removeItem(LEGACY_LS_KEY);

      set({
        tabs: withPaneTrees(tabs),
        activeTabId,
        sessionId: loaded.session.id,
        hydrated: true,
      });
    } catch (err) {
      // Don't block the UI on a DB failure — fall back to in-memory state.
      console.error('[workspace] hydrate failed; running in-memory only:', err);
      set({
        tabs: withPaneTrees([DEFAULT_TAB]),
        activeTabId: DEFAULT_TAB.id,
        sessionId: null,
        hydrated: true,
      });
    }
  },
}));

// ---- Auto-save: debounce writes whenever the persisted slice changes -----

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useWorkspace.subscribe((state, prev) => {
  if (!state.hydrated || !state.sessionId || !isTauri) return;
  // Only fire if the persisted slice actually changed. Dirty flags and
  // transient ptyIds shouldn't trigger writes.
  if (tabSliceEqual(state, prev)) return;

  if (saveTimer) clearTimeout(saveTimer);
  const sessionId = state.sessionId;
  const tabs = toTabInputs(state.tabs);
  const activeTabId = state.activeTabId;
  saveTimer = setTimeout(() => {
    void persistTabs(sessionId, tabs as Tab[], activeTabId).catch((err) =>
      console.error('[workspace] persist failed:', err),
    );
  }, DEBOUNCE_MS);
});

function toTabInputs(tabs: Tab[]): TabInput[] {
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    file_path: t.filePath ?? null,
  }));
}

async function persistTabs(sessionId: string, tabs: Tab[], activeTabId: string | null) {
  await sessionSaveTabs(sessionId, toTabInputs(tabs), activeTabId);
}

function tabSliceEqual(a: WorkspaceState, b: WorkspaceState): boolean {
  if (a.activeTabId !== b.activeTabId) return false;
  if (a.tabs.length !== b.tabs.length) return false;
  for (let i = 0; i < a.tabs.length; i++) {
    const x = a.tabs[i]!;
    const y = b.tabs[i]!;
    if (x.id !== y.id || x.title !== y.title || x.kind !== y.kind || x.filePath !== y.filePath) {
      return false;
    }
  }
  return true;
}

/** Read the pre-SQLite zustand-persist blob, if any. Returns null on
 *  any parse failure — migration shouldn't be the thing that wedges launch. */
function readLegacyLocalStorage(): { tabs: Tab[]; activeTabId: string | null } | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(LEGACY_LS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: { tabs?: Tab[]; activeTabId?: string | null } };
    const tabs = parsed.state?.tabs ?? [];
    if (!Array.isArray(tabs)) return null;
    const cleaned: Tab[] = tabs
      .filter((t) => t && typeof t.id === 'string' && (t.kind === 'terminal' || t.kind === 'editor'))
      .map((t) => ({
        id: t.id,
        title: typeof t.title === 'string' ? t.title : 'untitled',
        kind: t.kind,
        filePath: typeof t.filePath === 'string' ? t.filePath : undefined,
      }));
    return { tabs: cleaned, activeTabId: parsed.state?.activeTabId ?? null };
  } catch {
    return null;
  }
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

// ---- Pane-tree helpers (pure) -------------------------------------------

/** Lazily attach a single-pane tree to a fresh terminal tab. Editor tabs
 *  and tabs that already have a tree pass through unchanged. */
function ensurePaneTree(tab: Tab): Tab {
  if (tab.kind !== 'terminal') return tab;
  if (tab.paneTree) return tab;
  const paneId = tab.id; // first pane re-uses the tab id for backwards compat
  return {
    ...tab,
    paneTree: { kind: 'leaf', id: paneId },
    activePaneId: paneId,
  };
}

/** Make sure every terminal tab has a pane tree. Called after hydration. */
export function withPaneTrees(tabs: Tab[]): Tab[] {
  return tabs.map(ensurePaneTree);
}

function firstLeaf(node: PaneNode): string {
  return node.kind === 'leaf' ? node.id : firstLeaf(node.a);
}

function leafIds(node: PaneNode): string[] {
  if (node.kind === 'leaf') return [node.id];
  return [...leafIds(node.a), ...leafIds(node.b)];
}

function splitLeaf(
  node: PaneNode,
  targetId: string,
  direction: 'horizontal' | 'vertical',
  newPaneId: string,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== targetId) return node;
    return {
      kind: 'split',
      direction,
      ratio: 0.5,
      a: node,
      b: { kind: 'leaf', id: newPaneId },
    };
  }
  return {
    ...node,
    a: splitLeaf(node.a, targetId, direction, newPaneId),
    b: splitLeaf(node.b, targetId, direction, newPaneId),
  };
}

/** Remove the leaf with `targetId`; the sibling collapses into its place. */
function removeLeaf(node: PaneNode, targetId: string): PaneNode | null {
  if (node.kind === 'leaf') return node.id === targetId ? null : node;
  const a = removeLeaf(node.a, targetId);
  const b = removeLeaf(node.b, targetId);
  if (a && b) return { ...node, a, b };
  if (a) return a;
  if (b) return b;
  return null;
}

function setRatio(node: PaneNode, path: SplitPath, ratio: number): PaneNode {
  if (node.kind === 'leaf') return node;
  if (path.length === 0) return { ...node, ratio };
  const [head, ...rest] = path;
  if (head === 'a') return { ...node, a: setRatio(node.a, rest, ratio) };
  return { ...node, b: setRatio(node.b, rest, ratio) };
}

function clamp01(n: number): number {
  return Math.max(0.1, Math.min(0.9, n));
}
