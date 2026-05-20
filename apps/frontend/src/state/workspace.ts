import { create } from 'zustand';
import { isTauri, sessionLoad, sessionSaveTabs, type TabInput } from '../lib/tauri';

export interface Tab {
  id: string;
  title: string;
  kind: 'terminal' | 'editor';
  /** PTY id for terminal tabs. Transient — stripped from persisted state. */
  ptyId?: string;
  /** Absolute path for editor tabs (read on mount). */
  filePath?: string;
}

interface WorkspaceState {
  tabs: Tab[];
  activeTabId: string | null;
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
  /** Find an existing editor tab for `path`, or create one and focus it. */
  openFile: (path: string, title?: string) => string;
  /** One-time load from SQLite at app startup. Idempotent. */
  hydrate: () => Promise<void>;
}

const LEGACY_LS_KEY = 'arc-workspace';
const DEBOUNCE_MS = 250;

/** A single default tab — used when neither SQLite nor localStorage has any. */
const DEFAULT_TAB: Tab = { id: 'term-1', title: 'shell', kind: 'terminal' };

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  tabDirty: {},
  sessionId: null,
  hydrated: false,
  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    })),
  closeTab: (id) =>
    set((s) => {
      // Always leave at least one tab open — the workspace has no
      // "no-tab" empty state, and callers (X button, future keymap)
      // shouldn't have to enforce this themselves.
      if (s.tabs.length <= 1) return s;
      const remaining = s.tabs.filter((t) => t.id !== id);
      const wasActive = s.activeTabId === id;
      const { [id]: _omit, ...nextDirty } = s.tabDirty;
      return {
        tabs: remaining,
        activeTabId: wasActive ? (remaining[0]?.id ?? null) : s.activeTabId,
        tabDirty: nextDirty,
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
        tabs: legacy?.tabs ?? [DEFAULT_TAB],
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
        tabs,
        activeTabId,
        sessionId: loaded.session.id,
        hydrated: true,
      });
    } catch (err) {
      // Don't block the UI on a DB failure — fall back to in-memory state.
      console.error('[workspace] hydrate failed; running in-memory only:', err);
      set({
        tabs: [DEFAULT_TAB],
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
