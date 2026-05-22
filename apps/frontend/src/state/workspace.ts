import { create } from 'zustand';
import {
  fsDefaultRoot,
  isTauri,
  sessionLoad,
  sessionSaveTabs,
  type AiCliInfo,
  type TabInput,
} from '../lib/tauri';
import { useFiles } from './files';

export interface Tab {
  id: string;
  title: string;
  kind: 'terminal' | 'editor';
  /** PTY id for terminal tabs. Transient — stripped from persisted state. */
  ptyId?: string;
  /** Absolute path for editor tabs (read on mount). */
  filePath?: string;
  /** Override the default shell binary for a terminal tab — used by the
   *  AI CLI launchers (Claude Code / Codex / OpenCode). Transient: not
   *  persisted across restarts (the tab would come back as a regular shell). */
  shellOverride?: string;
}

// ─── Pane layout tree ─────────────────────────────────────────────────────
//
// The recursive structure that describes how tabs are arranged into split
// panes. The `tabs[]` array stays flat (the source of truth for "what's
// open"); the tree only references tabs by id. Moving a tab between panes
// is therefore a pure tree edit — the underlying React component (and PTY)
// never unmounts.

/** A terminal pane holding an ordered list of tabs and one active pick. */
export interface PaneLeaf {
  kind: 'leaf';
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

/** A split node containing two-or-more children laid out horizontally
 *  (left↔right) or vertically (top↔bottom). `sizes` are percentages that
 *  sum to ~100; `react-resizable-panels` clamps them in the UI. */
export interface PaneSplit {
  kind: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: PaneNode[];
  sizes: number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** Versioned envelope for the JSON column. Bump when the shape changes
 *  incompatibly so older binaries can degrade gracefully. */
export interface SerializedLayout {
  v: 1;
  root: PaneNode;
  focusedPaneId: string;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Root of the pane-layout tree. Always non-null after hydrate. */
  layout: PaneNode;
  /** Which leaf currently has keyboard focus. Mirrors the leaf's
   *  `activeTabId` into `activeTabId` above for legacy consumers. */
  focusedPaneId: string;
  /** Per-tab dirty flag — set by the Editor when its buffer diverges
   *  from the last-saved content on disk. Kept off the Tab itself so
   *  it doesn't get accidentally persisted. */
  tabDirty: Record<string, boolean>;
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
  setTabPtyId: (id: string, ptyId: string | undefined) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  /** Find an existing editor tab for `path`, or create one and focus it.
   *  When `forceNew` is true a new tab is always created (used by the
   *  Duplicate-tab action so the user gets a second view of the file). */
  openFile: (path: string, title?: string, opts?: { forceNew?: boolean }) => string;
  /** Spawn a new terminal tab that runs an AI CLI (Claude Code / Codex /
   *  OpenCode) directly instead of the default shell. Anchors the new tab
   *  (and the file tree) at the user's home directory. */
  launchAiCli: (cli: AiCliInfo) => Promise<string>;
  /** Open a new terminal tab anchored at the user's home directory.
   *  Resets the file-tree root to home first so the spawning PTY inherits
   *  it as CWD and both panes stay in sync. */
  newTerminal: (override?: Partial<Pick<Tab, 'title' | 'shellOverride'>>) => Promise<string>;
  /** Focus a leaf. Mirrors the leaf's `activeTabId` into the global
   *  `activeTabId` for legacy consumers (FileTree paste, ChatPanel). */
  setFocusedPane: (paneId: string) => void;
  /** Split the leaf containing `fromTabId`. Duplicates the source tab into
   *  a new leaf next to it: editors → same `filePath` in a new tab, terminals
   *  → a new shell with the same `shellOverride`. The new tab becomes
   *  active in the new sub-leaf. */
  splitPane: (fromTabId: string, direction: 'horizontal' | 'vertical') => Promise<string>;
  /** Move `tabId` into `targetPaneId`, optionally before `beforeTabId`.
   *  Pure layout edit; the underlying React subtree stays mounted. */
  moveTabToPane: (tabId: string, targetPaneId: string, beforeTabId?: string | null) => void;
  /** Split `targetPaneId` on `side` and place `tabId` in the new sub-leaf.
   *  Used by the drag-drop edge-drop UX. */
  splitPaneWithTab: (
    targetPaneId: string,
    side: 'top' | 'bottom' | 'left' | 'right',
    tabId: string,
  ) => void;
  /** Persist the result of a resize-handle drag. Receives the split node's
   *  id and new sizes in child order. */
  setSplitSizes: (splitId: string, sizes: number[]) => void;
  /** One-time load from SQLite at app startup. Idempotent. */
  hydrate: () => Promise<void>;
}

const LEGACY_LS_KEY = 'arc-workspace';
const DEBOUNCE_MS = 250;

/** A single default tab — used when neither SQLite nor localStorage has any. */
const DEFAULT_TAB: Tab = { id: 'term-1', title: 'shell', kind: 'terminal' };

// ─── Pure layout helpers ─────────────────────────────────────────────────
//
// Kept pure (no Zustand access) so they're trivially unit-testable and we
// can use them from both the store reducer and ad-hoc UI logic.

let paneIdCounter = 0;
/** Generate a stable but unique pane id. The counter is a fallback for
 *  environments without `crypto.randomUUID()` (older test runners). */
function newPaneId(prefix = 'pane'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  paneIdCounter += 1;
  return `${prefix}-${Date.now()}-${paneIdCounter}`;
}

/** Build a single-leaf layout containing `tabIds` with `activeTabId` selected.
 *  Used for fresh installs and as the synthesized layout when SQLite has tabs
 *  but no `pane_layout` JSON yet. */
function singleLeafLayout(tabIds: string[], activeTabId: string | null): PaneLeaf {
  return {
    kind: 'leaf',
    id: newPaneId('leaf'),
    tabIds: [...tabIds],
    activeTabId,
  };
}

/** Depth-first search for a leaf with the given id. */
export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.id === paneId ? node : null;
  for (const child of node.children) {
    const hit = findLeaf(child, paneId);
    if (hit) return hit;
  }
  return null;
}

/** Depth-first search for the leaf that owns a given tab id. */
export function findLeafContaining(node: PaneNode, tabId: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.tabIds.includes(tabId) ? node : null;
  for (const child of node.children) {
    const hit = findLeafContaining(child, tabId);
    if (hit) return hit;
  }
  return null;
}

/** Collect every leaf in the tree in DFS order. Useful for iteration. */
export function allLeaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node];
  const out: PaneLeaf[] = [];
  for (const child of node.children) out.push(...allLeaves(child));
  return out;
}

/**
 * Walk the tree and produce a layout with `removedTabIds` removed from every
 * leaf's `tabIds`. Any leaf left empty is dropped from its parent split. A
 * split that's left with one child is replaced by that child (collapsed).
 * Returns the new root; if the entire tree would be empty, returns null —
 * the caller must handle that case by re-seeding a default leaf.
 */
export function pruneLayout(node: PaneNode, removedTabIds: Set<string>): PaneNode | null {
  if (node.kind === 'leaf') {
    const tabIds = node.tabIds.filter((id) => !removedTabIds.has(id));
    if (tabIds.length === 0) return null;
    const activeTabId =
      node.activeTabId && tabIds.includes(node.activeTabId) ? node.activeTabId : tabIds[0]!;
    if (tabIds.length === node.tabIds.length && activeTabId === node.activeTabId) return node;
    return { kind: 'leaf', id: node.id, tabIds, activeTabId };
  }
  const newChildren: PaneNode[] = [];
  const newSizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = pruneLayout(node.children[i]!, removedTabIds);
    if (child) {
      newChildren.push(child);
      newSizes.push(node.sizes[i] ?? 50);
    }
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0]!;
  // Re-normalize sizes so they sum to ~100 after a child drop.
  const total = newSizes.reduce((s, n) => s + n, 0) || 100;
  const normalized = newSizes.map((n) => (n / total) * 100);
  return { kind: 'split', id: node.id, direction: node.direction, children: newChildren, sizes: normalized };
}

/** Append `tabId` to `paneId`'s `tabIds` and make it active. No-op if the
 *  pane doesn't exist (caller should re-seed in that case). */
export function appendTabToLeaf(node: PaneNode, paneId: string, tabId: string): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== paneId) return node;
    if (node.tabIds.includes(tabId)) return { ...node, activeTabId: tabId };
    return { ...node, tabIds: [...node.tabIds, tabId], activeTabId: tabId };
  }
  return {
    ...node,
    children: node.children.map((c) => appendTabToLeaf(c, paneId, tabId)),
  };
}

/** Set the active tab inside a specific leaf. */
export function setLeafActiveTab(node: PaneNode, paneId: string, tabId: string): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== paneId) return node;
    if (!node.tabIds.includes(tabId)) return node;
    return { ...node, activeTabId: tabId };
  }
  return { ...node, children: node.children.map((c) => setLeafActiveTab(c, paneId, tabId)) };
}

/** Replace `splitId`'s `sizes` with `sizes`. Used after a resize-handle
 *  drag so the new pane ratios survive across restarts. */
function updateSplitSizes(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.kind === 'leaf') return node;
  if (node.id === splitId) {
    // Defensive: if the caller passed the wrong number of sizes, leave the
    // node untouched rather than corrupting the tree.
    if (sizes.length !== node.children.length) return node;
    // Skip the update if the sizes haven't moved meaningfully — avoids a
    // persistence write per pointer-move from `react-resizable-panels`.
    let changed = false;
    for (let i = 0; i < sizes.length; i++) {
      if (Math.abs(sizes[i]! - (node.sizes[i] ?? 0)) > 0.01) {
        changed = true;
        break;
      }
    }
    if (!changed) return node;
    return { ...node, sizes: [...sizes] };
  }
  return {
    ...node,
    children: node.children.map((c) => updateSplitSizes(c, splitId, sizes)),
  };
}

/** Insert a tab into a leaf at a specific position. Pulls from any other
 *  leaf that already had it (move semantics). */
function insertTabIntoLeaf(
  node: PaneNode,
  paneId: string,
  tabId: string,
  beforeTabId: string | null,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id === paneId) {
      const without = node.tabIds.filter((id) => id !== tabId);
      const idx = beforeTabId ? without.indexOf(beforeTabId) : -1;
      const tabIds = idx >= 0 ? [...without.slice(0, idx), tabId, ...without.slice(idx)] : [...without, tabId];
      return { ...node, tabIds, activeTabId: tabId };
    }
    // Drop the tab from this leaf if it's a foreign holder.
    if (node.tabIds.includes(tabId)) {
      const tabIds = node.tabIds.filter((id) => id !== tabId);
      const activeTabId =
        node.activeTabId === tabId ? (tabIds[0] ?? null) : node.activeTabId;
      return { ...node, tabIds, activeTabId };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((c) => insertTabIntoLeaf(c, paneId, tabId, beforeTabId)),
  };
}

/** Replace the leaf with `targetPaneId` with a split node containing the
 *  original leaf (with `tabId` removed if it was there) and a new leaf
 *  holding only `tabId`. `side` decides direction + which child the new
 *  leaf becomes — `right`/`bottom` → new leaf is second; `left`/`top` →
 *  new leaf is first. */
function splitLeafForTab(
  node: PaneNode,
  targetPaneId: string,
  side: 'top' | 'bottom' | 'left' | 'right',
  tabId: string,
): PaneNode {
  if (node.kind === 'leaf') {
    if (node.id !== targetPaneId) {
      // Strip the tab from a foreign holder so it only lives in the new leaf.
      if (node.tabIds.includes(tabId)) {
        const tabIds = node.tabIds.filter((id) => id !== tabId);
        const activeTabId =
          node.activeTabId === tabId ? (tabIds[0] ?? null) : node.activeTabId;
        return { ...node, tabIds, activeTabId };
      }
      return node;
    }
    // Target leaf — split it.
    const tabIds = node.tabIds.filter((id) => id !== tabId);
    const activeTabId =
      node.activeTabId === tabId ? (tabIds[0] ?? null) : node.activeTabId;
    const sourceLeaf: PaneLeaf = { ...node, tabIds, activeTabId };
    const newLeaf: PaneLeaf = {
      kind: 'leaf',
      id: newPaneId('leaf'),
      tabIds: [tabId],
      activeTabId: tabId,
    };
    const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
    const newFirst = side === 'left' || side === 'top';
    const children: PaneNode[] = newFirst ? [newLeaf, sourceLeaf] : [sourceLeaf, newLeaf];
    return {
      kind: 'split',
      id: newPaneId('split'),
      direction,
      children,
      sizes: [50, 50],
    };
  }
  return {
    ...node,
    children: node.children.map((c) => splitLeafForTab(c, targetPaneId, side, tabId)),
  };
}

// ─── Store ───────────────────────────────────────────────────────────────

/** Initial state used before hydrate. The single seed tab lives in a single
 *  seed leaf so the rest of the code never has to handle a null layout. */
function seedState(): Pick<WorkspaceState, 'tabs' | 'activeTabId' | 'layout' | 'focusedPaneId'> {
  const leaf = singleLeafLayout([DEFAULT_TAB.id], DEFAULT_TAB.id);
  return {
    tabs: [DEFAULT_TAB],
    activeTabId: DEFAULT_TAB.id,
    layout: leaf,
    focusedPaneId: leaf.id,
  };
}

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  ...seedState(),
  tabs: [],
  activeTabId: null,
  tabDirty: {},
  sessionId: null,
  hydrated: false,
  addTab: (tab) =>
    set((s) => {
      // New tab always lands in the currently-focused leaf so opening a
      // file while a split pane is focused keeps the new tab adjacent to
      // the user's attention.
      const leaf = findLeaf(s.layout, s.focusedPaneId);
      if (!leaf) {
        // Shouldn't happen post-hydrate, but be defensive: re-seed.
        const reseeded = singleLeafLayout([tab.id], tab.id);
        return {
          tabs: [...s.tabs, tab],
          activeTabId: tab.id,
          layout: reseeded,
          focusedPaneId: reseeded.id,
        };
      }
      return {
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        layout: appendTabToLeaf(s.layout, leaf.id, tab.id),
      };
    }),
  closeTab: (id) =>
    set((s) => {
      // Layout-aware close. Refuse if this is the last tab in the entire
      // workspace — the original UX was to keep at least one tab open and
      // we honor that here. With splits, closing the last tab in a *leaf*
      // collapses the leaf (its sibling expands to fill the parent split)
      // but the workspace as a whole never goes empty.
      if (s.tabs.length <= 1) return s;
      const remaining = s.tabs.filter((t) => t.id !== id);
      const pruned = pruneLayout(s.layout, new Set([id]));
      const { [id]: _omit, ...nextDirty } = s.tabDirty;
      if (!pruned) {
        // Shouldn't happen given the `tabs.length <= 1` guard above, but
        // belt-and-suspenders: if the prune nuked the tree, re-seed.
        const fresh = singleLeafLayout(remaining.map((t) => t.id), remaining[0]?.id ?? null);
        return {
          tabs: remaining,
          activeTabId: remaining[0]?.id ?? null,
          layout: fresh,
          focusedPaneId: fresh.id,
          tabDirty: nextDirty,
        };
      }
      const focusedExists = !!findLeaf(pruned, s.focusedPaneId);
      const newFocusedPaneId = focusedExists ? s.focusedPaneId : allLeaves(pruned)[0]!.id;
      const newFocusedLeaf = findLeaf(pruned, newFocusedPaneId)!;
      return {
        tabs: remaining,
        // Mirror the focused leaf's active tab into the global activeTabId so
        // legacy consumers (FileTree paste, ChatPanel) keep working.
        activeTabId: newFocusedLeaf.activeTabId,
        layout: pruned,
        focusedPaneId: newFocusedPaneId,
        tabDirty: nextDirty,
      };
    }),
  setActive: (id) =>
    set((s) => {
      const owningLeaf = findLeafContaining(s.layout, id);
      if (!owningLeaf) return { activeTabId: id };
      return {
        activeTabId: id,
        layout: setLeafActiveTab(s.layout, owningLeaf.id, id),
        focusedPaneId: owningLeaf.id,
      };
    }),
  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),
  setTabPtyId: (id, ptyId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ptyId } : t)),
    })),
  setTabDirty: (id, dirty) =>
    set((s) => {
      if (!!s.tabDirty[id] === dirty) return s; // no-op
      const next = { ...s.tabDirty };
      if (dirty) next[id] = true;
      else delete next[id];
      return { tabDirty: next };
    }),
  openFile: (path, title, opts) => {
    if (!opts?.forceNew) {
      const existing = get().tabs.find((t) => t.kind === 'editor' && t.filePath === path);
      if (existing) {
        get().setActive(existing.id);
        return existing.id;
      }
    }
    const id = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tab: Tab = {
      id,
      title: title ?? basename(path),
      kind: 'editor',
      filePath: path,
    };
    get().addTab(tab);
    return id;
  },
  launchAiCli: async (cli) => {
    await resetRootToHome();
    const id = `${cli.id}-${Date.now()}`;
    const tab: Tab = {
      id,
      title: cli.label,
      kind: 'terminal',
      shellOverride: cli.path,
    };
    get().addTab(tab);
    return id;
  },
  newTerminal: async (override) => {
    await resetRootToHome();
    const id = `term-${Date.now()}`;
    const tab: Tab = {
      id,
      title: override?.title ?? 'shell',
      kind: 'terminal',
      shellOverride: override?.shellOverride,
    };
    get().addTab(tab);
    return id;
  },
  setFocusedPane: (paneId) =>
    set((s) => {
      const leaf = findLeaf(s.layout, paneId);
      if (!leaf) return s;
      return {
        focusedPaneId: paneId,
        activeTabId: leaf.activeTabId ?? s.activeTabId,
      };
    }),
  splitPane: async (fromTabId, direction) => {
    const source = get().tabs.find((t) => t.id === fromTabId);
    if (!source) return '';
    const sourceLeaf = findLeafContaining(get().layout, fromTabId);
    if (!sourceLeaf) return '';
    // Build the duplicate tab. For editors we open the same file in a new
    // tab id (forceNew). For terminals we spawn a fresh shell that
    // inherits the same shellOverride.
    let newTabId: string;
    if (source.kind === 'editor' && source.filePath) {
      newTabId = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newTab: Tab = {
        id: newTabId,
        title: source.title,
        kind: 'editor',
        filePath: source.filePath,
      };
      set((s) => ({ tabs: [...s.tabs, newTab] }));
    } else {
      newTabId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const newTab: Tab = {
        id: newTabId,
        title: source.title,
        kind: 'terminal',
        shellOverride: source.shellOverride,
      };
      set((s) => ({ tabs: [...s.tabs, newTab] }));
    }
    // Now split the leaf around the new tab. `right` for horizontal puts
    // the new leaf on the right; `bottom` for vertical puts it underneath.
    const side: 'right' | 'bottom' = direction === 'horizontal' ? 'right' : 'bottom';
    set((s) => {
      const newLayout = splitLeafForTab(s.layout, sourceLeaf.id, side, newTabId);
      const newLeaf = findLeafContaining(newLayout, newTabId);
      return {
        layout: newLayout,
        focusedPaneId: newLeaf?.id ?? s.focusedPaneId,
        activeTabId: newTabId,
      };
    });
    return newTabId;
  },
  moveTabToPane: (tabId, targetPaneId, beforeTabId) =>
    set((s) => {
      const target = findLeaf(s.layout, targetPaneId);
      if (!target) return s;
      const sourceLeaf = findLeafContaining(s.layout, tabId);
      if (!sourceLeaf) return s;
      // Same leaf, no reposition requested → no-op.
      if (sourceLeaf.id === target.id && !beforeTabId) return s;
      const moved = insertTabIntoLeaf(s.layout, target.id, tabId, beforeTabId ?? null);
      // Prune empties (the source leaf may be empty now). pruneLayout
      // collapses single-child splits as a side effect, which is exactly
      // what we want when a leaf becomes empty.
      const cleaned = pruneLayout(moved, new Set()) ?? moved;
      // After prune, anchor focus to the leaf that owns the moved tab.
      const focusedLeaf = findLeafContaining(cleaned, tabId);
      return {
        layout: cleaned,
        focusedPaneId: focusedLeaf?.id ?? s.focusedPaneId,
        activeTabId: tabId,
      };
    }),
  splitPaneWithTab: (targetPaneId, side, tabId) =>
    set((s) => {
      const target = findLeaf(s.layout, targetPaneId);
      if (!target) return s;
      const newLayout = splitLeafForTab(s.layout, targetPaneId, side, tabId);
      const cleaned = pruneLayout(newLayout, new Set()) ?? newLayout;
      const focusedLeaf = findLeafContaining(cleaned, tabId);
      return {
        layout: cleaned,
        focusedPaneId: focusedLeaf?.id ?? s.focusedPaneId,
        activeTabId: tabId,
      };
    }),
  setSplitSizes: (splitId, sizes) =>
    set((s) => ({
      layout: updateSplitSizes(s.layout, splitId, sizes),
    })),
  hydrate: async () => {
    if (get().hydrated) return;

    // Browser fallback (pnpm dev, no Tauri): seed a default tab so the UI
    // doesn't render empty, but skip SQLite entirely.
    if (!isTauri) {
      const legacy = readLegacyLocalStorage();
      const tabs = legacy?.tabs ?? [DEFAULT_TAB];
      const activeTabId = legacy?.activeTabId ?? tabs[0]?.id ?? null;
      const leaf = singleLeafLayout(
        tabs.map((t) => t.id),
        activeTabId,
      );
      set({
        tabs,
        activeTabId,
        layout: leaf,
        focusedPaneId: leaf.id,
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
      } else {
        tabs = [DEFAULT_TAB];
        activeTabId = DEFAULT_TAB.id;
      }

      // Layout: prefer the persisted JSON, else synthesize a single-leaf
      // layout containing every loaded tab in order.
      let layout: PaneNode;
      let focusedPaneId: string;
      const parsed = parsePersistedLayout(loaded.session.pane_layout);
      if (parsed && layoutCoversTabs(parsed.root, tabs)) {
        layout = parsed.root;
        focusedPaneId = parsed.focusedPaneId;
        if (!findLeaf(layout, focusedPaneId)) {
          focusedPaneId = allLeaves(layout)[0]!.id;
        }
      } else {
        const leaf = singleLeafLayout(
          tabs.map((t) => t.id),
          activeTabId,
        );
        layout = leaf;
        focusedPaneId = leaf.id;
      }

      // Migration's done — never read the LS key again.
      if (legacy) localStorage.removeItem(LEGACY_LS_KEY);

      const needsWriteBack =
        loaded.tabs.length === 0 ||
        (legacy && legacy.tabs.length > 0 && loaded.tabs.length === 0) ||
        loaded.session.pane_layout == null;
      if (needsWriteBack) {
        await persistTabs(loaded.session.id, tabs, activeTabId, serializeLayout(layout, focusedPaneId));
      }

      set({
        tabs,
        activeTabId,
        layout,
        focusedPaneId,
        sessionId: loaded.session.id,
        hydrated: true,
      });
    } catch (err) {
      // Don't block the UI on a DB failure — fall back to in-memory state.
      console.error('[workspace] hydrate failed; running in-memory only:', err);
      const fresh = singleLeafLayout([DEFAULT_TAB.id], DEFAULT_TAB.id);
      set({
        tabs: [DEFAULT_TAB],
        activeTabId: DEFAULT_TAB.id,
        layout: fresh,
        focusedPaneId: fresh.id,
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
  const tabs = state.tabs;
  const activeTabId = state.activeTabId;
  const layoutJson = serializeLayout(state.layout, state.focusedPaneId);
  saveTimer = setTimeout(() => {
    void persistTabs(sessionId, tabs, activeTabId, layoutJson).catch((err) =>
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

async function persistTabs(
  sessionId: string,
  tabs: Tab[],
  activeTabId: string | null,
  paneLayout: string | null,
) {
  await sessionSaveTabs(sessionId, toTabInputs(tabs), activeTabId, paneLayout);
}

function tabSliceEqual(a: WorkspaceState, b: WorkspaceState): boolean {
  if (a.activeTabId !== b.activeTabId) return false;
  if (a.focusedPaneId !== b.focusedPaneId) return false;
  if (a.tabs.length !== b.tabs.length) return false;
  for (let i = 0; i < a.tabs.length; i++) {
    const x = a.tabs[i]!;
    const y = b.tabs[i]!;
    if (x.id !== y.id || x.title !== y.title || x.kind !== y.kind || x.filePath !== y.filePath) {
      return false;
    }
  }
  return layoutEqual(a.layout, b.layout);
}

/** Cheap structural compare so the debounce subscriber only fires the
 *  write when the persisted slice actually changes. */
function layoutEqual(a: PaneNode, b: PaneNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.id !== b.id) return false;
  if (a.kind === 'leaf' && b.kind === 'leaf') {
    if (a.activeTabId !== b.activeTabId) return false;
    if (a.tabIds.length !== b.tabIds.length) return false;
    for (let i = 0; i < a.tabIds.length; i++) {
      if (a.tabIds[i] !== b.tabIds[i]) return false;
    }
    return true;
  }
  if (a.kind === 'split' && b.kind === 'split') {
    if (a.direction !== b.direction) return false;
    if (a.children.length !== b.children.length) return false;
    for (let i = 0; i < a.children.length; i++) {
      if (Math.abs((a.sizes[i] ?? 0) - (b.sizes[i] ?? 0)) > 0.01) return false;
      if (!layoutEqual(a.children[i]!, b.children[i]!)) return false;
    }
    return true;
  }
  return false;
}

function serializeLayout(layout: PaneNode, focusedPaneId: string): string {
  const env: SerializedLayout = { v: 1, root: layout, focusedPaneId };
  return JSON.stringify(env);
}

/** Parse a persisted JSON blob, validate the version, and coerce the shape
 *  into in-memory types. Returns null on any structural failure — the caller
 *  falls back to a synthesized single-leaf layout. */
function parsePersistedLayout(
  raw: string | null,
): { root: PaneNode; focusedPaneId: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SerializedLayout> & {
      root?: unknown;
      focusedPaneId?: unknown;
    };
    if (parsed.v !== 1 || !parsed.root || typeof parsed.focusedPaneId !== 'string') return null;
    const root = coercePaneNode(parsed.root);
    if (!root) return null;
    return { root, focusedPaneId: parsed.focusedPaneId };
  } catch {
    return null;
  }
}

function coercePaneNode(raw: unknown): PaneNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'leaf') {
    if (typeof r.id !== 'string') return null;
    if (!Array.isArray(r.tabIds)) return null;
    const tabIds = r.tabIds.filter((s): s is string => typeof s === 'string');
    const activeTabId = typeof r.activeTabId === 'string' ? r.activeTabId : (tabIds[0] ?? null);
    return { kind: 'leaf', id: r.id, tabIds, activeTabId };
  }
  if (r.kind === 'split') {
    if (typeof r.id !== 'string') return null;
    if (r.direction !== 'horizontal' && r.direction !== 'vertical') return null;
    if (!Array.isArray(r.children) || !Array.isArray(r.sizes)) return null;
    const children: PaneNode[] = [];
    for (const c of r.children) {
      const child = coercePaneNode(c);
      if (!child) return null;
      children.push(child);
    }
    if (children.length < 2) return null;
    const sizes = r.sizes
      .map((n) => (typeof n === 'number' ? n : 0))
      .slice(0, children.length);
    while (sizes.length < children.length) sizes.push(100 / children.length);
    return { kind: 'split', id: r.id, direction: r.direction, children, sizes };
  }
  return null;
}

/** Sanity check that a persisted layout still references the tab ids we
 *  actually loaded. Drift here would leave the user staring at empty panes,
 *  so we fall back to a synthesized layout in that case. */
function layoutCoversTabs(layout: PaneNode, tabs: Tab[]): boolean {
  const have = new Set(tabs.map((t) => t.id));
  const referenced = new Set<string>();
  for (const leaf of allLeaves(layout)) {
    for (const id of leaf.tabIds) referenced.add(id);
  }
  // Every referenced id must exist; missing entries kill the layout. Extra
  // tabs (i.e. tabs[] has ids the layout doesn't reference) are recoverable
  // — we'd just dock them in the focused leaf — but for v1 we play it safe
  // and resynthesize from scratch.
  for (const id of referenced) {
    if (!have.has(id)) return false;
  }
  return referenced.size === have.size;
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

async function resetRootToHome(): Promise<void> {
  if (!isTauri) return;
  try {
    const home = await fsDefaultRoot();
    if (home) useFiles.getState().setRoot(home);
  } catch {
    // Best-effort — fall through and let the terminal spawn with whatever
    // root the tree currently has.
  }
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
