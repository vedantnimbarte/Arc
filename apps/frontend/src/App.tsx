import { Component, lazy, Suspense, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from './components/Terminal';
import { Preview } from './components/Preview';
import { ApiClient } from './components/ApiClient';
import { SshTab } from './components/ssh/SshTab';
import { SshSessionLogPanel } from './components/ssh/SshSessionLogDrawer';
import { useSsh } from './state/ssh';
import { TabBar } from './components/TabBar';
import { ChatPanel } from './components/ChatPanel';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { CommandHistoryPalette } from './components/CommandHistoryPalette';
import { Sidebar } from './components/Sidebar';
import { ResizeHandle } from './components/ResizeHandle';
import { SearchPalette } from './components/SearchPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { PaneTreeView } from './components/PaneTreeView';
import { useWorkspace } from './state/workspace';
import { useFiles, CHAT_DEFAULT } from './state/files';
import { useChat } from './state/chat';
import { useSelection, type SelectionInfo } from './state/selection';
import {
  actionFor,
  ACTION_META,
  getBinding,
  formatBinding,
  type ActionId,
} from './state/shortcuts';
import { useCommands, type CommandAction, type CommandGroup } from './state/commands';
import { WorktreePanel } from './components/git/WorktreePanel';
import { CherryPickDialog } from './components/git/CherryPickDialog';
import { RebasePanel } from './components/git/RebasePanel';
import { PrPanel } from './components/git/PrPanel';
import { FolderTree, GitPullRequest, ListOrdered } from 'lucide-react';
// Side-effect import: subscribes to file-tree root changes and keeps the
// project-config store fresh. Doesn't render anything itself.
import './state/projectConfig';
import { ptyListAiClis, settingsWindowOpen, type AiCliId } from './lib/tauri';
import type { ChatIntent } from './components/ChatPanel';
import { AskAiFloater } from './components/AskAiFloater';
import { PasteWarning } from './components/PasteWarning';

// CodeMirror is heavy — defer its bundle until a file is actually opened.
const Editor = lazy(() =>
  import('./components/Editor').then((m) => ({ default: m.Editor })),
);
const DiffView = lazy(() =>
  import('./components/DiffView').then((m) => ({ default: m.DiffView })),
);

export default function App() {
  const { tabs, activeTabId } = useWorkspace();
  const launchAiCli = useWorkspace((s) => s.launchAiCli);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const hydrate = useWorkspace((s) => s.hydrate);
  const hydrateChat = useChat((s) => s.hydrate);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Host-div registry — one stable DOM node per tab id. The tab's content
  // (Terminal / Editor) is portaled into its host once and stays there for
  // the tab's lifetime. The host node is reparented between the offscreen
  // stage and whichever pane currently displays the tab, but its React
  // subtree never unmounts. That's what keeps PTYs alive across drag/drop
  // and pane splits.
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const stageRef = useRef<HTMLDivElement>(null);

  // Lazily create host divs *during render* so they exist before child
  // layout effects run. PaneLeafView's `useLayoutEffect` reparents the
  // active host into its leaf — child layout effects run before parent
  // effects, so any "create the host in an effect" approach leaves the
  // first render's PaneLeafView with nothing to reparent. The host stays
  // stranded in the hidden stage, xterm opens into a 0x0 container, and
  // RenderService crashes on the next frame.
  //
  // Creating DOM nodes in render is a side effect, but it's idempotent
  // here: the ref-backed cache means Strict Mode's double-render produces
  // exactly one node per tab id. We don't append to the stage yet — that
  // happens in the layout effect below so the DOM stays consistent.
  for (const tab of tabs) {
    if (!hostsRef.current.has(tab.id)) {
      const div = document.createElement('div');
      div.dataset.tabHost = tab.id;
      div.style.position = 'absolute';
      div.style.inset = '0';
      hostsRef.current.set(tab.id, div);
    }
  }

  // Stage-parent any orphan hosts and GC closed tabs' hosts. Runs in a
  // layout effect so the DOM mutation happens before paint and before
  // PaneLeafView would observe a detached host.
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    const map = hostsRef.current;
    for (const t of tabs) {
      const div = map.get(t.id);
      if (div && !div.parentElement && stageRef.current) {
        stageRef.current.appendChild(div);
      }
    }
    for (const id of Array.from(map.keys())) {
      if (!ids.has(id)) {
        const node = map.get(id);
        node?.parentElement?.removeChild(node);
        map.delete(id);
      }
    }
  }, [tabs]);

  // Build the portal list on every render. createPortal is virtual — React
  // reconciles each portal by its `key={tab.id}` so the underlying Terminal
  // / Editor components stay mounted across renders, drag/drop, and pane
  // moves.
  const portals: React.ReactNode[] = [];
  for (const tab of tabs) {
    const host = hostsRef.current.get(tab.id);
    if (!host) continue;
    const child =
      tab.kind === 'terminal' ? (
        <Terminal sessionKey={tab.id} />
      ) : tab.kind === 'preview' ? (
        <Preview tabId={tab.id} />
      ) : tab.kind === 'apiclient' ? (
        <ApiClient tabId={tab.id} />
      ) : tab.kind === 'ssh' && tab.sshHostId ? (
        <SshTab sessionKey={tab.id} hostId={tab.sshHostId} />
      ) : tab.kind === 'diff' && tab.filePath && tab.diffRoot ? (
        <Suspense fallback={<EditorFallback />}>
          <DiffView
            filePath={tab.filePath}
            diffRoot={tab.diffRoot}
            diffScope={tab.diffScope ?? 'worktree'}
          />
        </Suspense>
      ) : tab.filePath ? (
        <Suspense fallback={<EditorFallback />}>
          <Editor filePath={tab.filePath} tabId={tab.id} />
        </Suspense>
      ) : (
        <div className="flex h-full items-center justify-center text-fg-muted">
          <span className="font-display text-[13px] tracking-tight">no file</span>
        </div>
      );
    portals.push(
      <PortalSlot key={tab.id} host={host}>
        <TabErrorBoundary tabId={tab.id}>{child}</TabErrorBoundary>
      </PortalSlot>,
    );
  }
  void activeTab;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Chat panel is now a floating popover instead of a docked sidebar.
  const [chatOpen, setChatOpen] = useState(false);
  // One-shot action requested from a global keyboard shortcut. The
  // timestamp lets ChatPanel re-fire on consecutive identical intents.
  const [chatIntent, setChatIntent] = useState<ChatIntent | null>(null);
  const sidebarCollapsed = useFiles((s) => s.collapsed);
  const sidebarWidth = useFiles((s) => s.sidebarWidth);
  const toggleSidebar = useFiles((s) => s.toggleCollapsed);
  const setSidebarWidth = useFiles((s) => s.setSidebarWidth);
  const chatWidth = useFiles((s) => s.chatWidth);
  const setChatWidth = useFiles((s) => s.setChatWidth);

  // Load persisted tabs + active tab from SQLite (or legacy localStorage)
  // before the renderer settles. hydrate() is idempotent.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Restore chat sessions + messages from SQLite (with one-shot legacy
  // localStorage migration). Idempotent.
  useEffect(() => {
    void hydrateChat();
  }, [hydrateChat]);

  // Restore saved SSH hosts + keys. Idempotent — store guards on `hydrated`.
  useEffect(() => {
    void useSsh.getState().hydrate();
  }, []);

  const sshLogPanelOpen = useSsh((s) => s.logPanelOpen);
  const setSshLogPanelOpen = useSsh((s) => s.setLogPanelOpen);

  // Settings + secrets are hydrated by Root in main.tsx (shared across
  // the main and Settings windows).

  // Shared action for the "Ask ARC AI" floating button + ⌘⇧A shortcut.
  // Reads the current selection from `useSelection`, stages it as a
  // `pendingContext` for the next chat send, opens the chat popover, and
  // starts a fresh session if the chat was closed.
  const askArcAi = useRef<(info?: SelectionInfo) => void>(() => {});
  askArcAi.current = (info?: SelectionInfo) => {
    const sel = info ?? useSelection.getState().current;
    if (!sel || !sel.text.trim()) return;
    const wasClosed = !chatOpen;
    setChatOpen(true);
    if (wasClosed) setChatIntent({ type: 'new-session', at: Date.now() });
    useChat.getState().addPendingContext({
      source: sel.source,
      label: sel.label,
      text: sel.text,
    });
    // The chip now owns the snapshot; clearing the live selection also
    // hides the floating pill.
    useSelection.getState().clear();
  };

  // Single dispatch table for ActionId — shared between global keyboard
  // shortcuts and the ⌘K command palette so adding an action in shortcuts.ts
  // automatically gives it both a key combo and a palette entry. Lifted to a
  // ref so the palette-registration effect (which runs once) can call the
  // latest closure without re-registering on every render.
  const dispatchActionRef = useRef<(action: ActionId) => void>(() => {});
  dispatchActionRef.current = (action: ActionId) => {
    const launchCli = async (id: AiCliId) => {
      try {
        const installed = await ptyListAiClis();
        const cli = installed.find((c) => c.id === id);
        if (!cli) {
          console.warn(`[shortcut] ${id} not detected on PATH`);
          return;
        }
        await launchAiCli(cli);
      } catch (err) {
        console.error(`[shortcut] launch ${id} failed:`, err);
      }
    };
    switch (action) {
      case 'new-terminal':
        void newTerminal();
        return;
      case 'open-settings':
        void settingsWindowOpen().catch((err) =>
          console.error('[shortcut] open settings window failed:', err),
        );
        return;
      case 'toggle-sidebar':
        toggleSidebar();
        return;
      case 'open-command-palette':
        setPaletteOpen(true);
        return;
      case 'open-command-history':
        setHistoryOpen(true);
        return;
      case 'open-search':
        setSearchOpen(true);
        return;
      case 'open-shortcuts':
        setShortcutsOpen(true);
        return;
      case 'toggle-chat':
        setChatOpen((o) => !o);
        return;
      case 'new-chat':
        setChatOpen(true);
        setChatIntent({ type: 'new-session', at: Date.now() });
        return;
      case 'toggle-agent-picker':
        setChatOpen(true);
        setChatIntent({ type: 'toggle-agents', at: Date.now() });
        return;
      case 'open-chat-sessions':
        setChatOpen(true);
        setChatIntent({ type: 'toggle-sessions', at: Date.now() });
        return;
      case 'toggle-ssh-panel':
        useFiles.getState().toggleSidebarView('ssh');
        return;
      case 'ask-arc-ai':
        askArcAi.current();
        return;
      case 'launch-claude-cli':
        void launchCli('claude-cli');
        return;
      case 'launch-codex-cli':
        void launchCli('codex-cli');
        return;
      case 'launch-opencode-cli':
        void launchCli('opencode-cli');
        return;
      case 'launch-kimi-code-cli':
        void launchCli('kimi-code-cli');
        return;
    }
  };

  // Open the chat popover on request from components that don't hold
  // setChatOpen — e.g. FileTree's "Attach to Agent", which also dispatches
  // `arc:attach-file` for ChatPanel to stage the file as a context chip.
  useEffect(() => {
    const onOpenChat = () => setChatOpen(true);
    window.addEventListener('arc:open-chat', onOpenChat);
    return () => window.removeEventListener('arc:open-chat', onOpenChat);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the chat popover when it has focus / is visible
      if (e.key === 'Escape' && chatOpen) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          setChatOpen(false);
          return;
        }
      }
      const action = actionFor(e);
      if (!action) return;
      e.preventDefault();
      dispatchActionRef.current(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatOpen]);

  // Seed the command-palette registry with every ActionId. Other features
  // can register their own ad-hoc actions on top of these.
  useEffect(() => {
    const seed: CommandAction[] = (Object.keys(ACTION_META) as ActionId[]).map((id) => {
      const meta = ACTION_META[id];
      const binding = getBinding(id);
      return {
        id: `shortcut.${id}`,
        title: meta.label,
        group: CATEGORY_TO_GROUP[meta.category],
        keywords: [meta.description, meta.category],
        shortcut: binding ? formatBinding(binding) : undefined,
        run: () => dispatchActionRef.current(id),
      };
    });
    return useCommands.getState().registerMany(seed);
  }, []);

  // Register palette actions that don't have a corresponding ActionId
  // (no global key binding yet). These can be promoted to first-class
  // ActionIds later if they earn a shortcut.
  useEffect(() => {
    const extras: CommandAction[] = [
      {
        id: 'git.manage-worktrees',
        title: 'Manage Worktrees',
        group: 'Git',
        keywords: ['worktree', 'git', 'branch', 'switch'],
        icon: FolderTree,
        run: () => {
          // Lazy import to avoid a circular dependency on App-local state.
          void import('./state/gitUi').then(({ useGitUi }) => {
            useGitUi.getState().setWorktreePanelOpen(true);
          });
        },
      },
      {
        id: 'git.interactive-rebase',
        title: 'Interactive Rebase',
        group: 'Git',
        keywords: ['rebase', 'reorder', 'squash', 'fixup', 'drop', 'history'],
        icon: ListOrdered,
        run: () => {
          void import('./state/gitUi').then(({ useGitUi }) => {
            useGitUi.getState().setRebasePanelOpen(true);
          });
        },
      },
      {
        id: 'git.pull-requests',
        title: 'Pull Requests',
        group: 'Git',
        keywords: ['pr', 'pull', 'request', 'github', 'review', 'merge'],
        icon: GitPullRequest,
        run: () => {
          void import('./state/gitUi').then(({ useGitUi }) => {
            useGitUi.getState().openPrList();
          });
        },
      },
    ];
    return useCommands.getState().registerMany(extras);
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-base text-fg-base">
      <div className="desktop-wash" aria-hidden />

      <div className="relative z-10 flex h-full w-full flex-col">
        <TabBar
          onOpenSettings={() =>
            void settingsWindowOpen().catch((err) =>
              console.error('[settings] open window failed:', err),
            )
          }
          onOpenSearch={() => setSearchOpen(true)}
        />

        {/* Layout: file-tree | main | chat sidebar | SSH sidebar */}
        <div className="relative flex min-h-0 flex-1 px-3 pb-3 pt-1">
          <div className="material-content flex min-h-0 w-full overflow-hidden rounded-window shadow-panel ring-1 ring-border-subtle">
            {/* File-tree wrapper — animates width to 0 on collapse. */}
            <aside
              className="shrink-0 overflow-hidden transition-[width] duration-300 ease-apple"
              style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
              aria-hidden={sidebarCollapsed}
            >
              <div
                className="material-sidebar h-full border-r border-border-hairline"
                style={{ width: sidebarWidth }}
              >
                <Sidebar />
              </div>
            </aside>

            {!sidebarCollapsed && (
              <ResizeHandle
                edge="left"
                getWidth={() => useFiles.getState().sidebarWidth}
                onResize={setSidebarWidth}
              />
            )}

            <main className="relative min-w-0 flex-1 overflow-hidden">
              {/* Recursive pane tree — splits become PanelGroups, leaves
                  get a tab strip plus a content slot that reparents the
                  active tab's host div in. */}
              <PaneTreeView hostsRef={hostsRef} stageRef={stageRef} />
            </main>

            {/* AI chat secondary sidebar — same pattern as SSH sidebar. */}
            {chatOpen && (
              <ResizeHandle
                edge="right"
                getWidth={() => useFiles.getState().chatWidth}
                onResize={setChatWidth}
                resetWidth={CHAT_DEFAULT}
              />
            )}
            <aside
              className="shrink-0 overflow-hidden transition-[width] duration-300 ease-apple"
              style={{ width: chatOpen ? chatWidth : 0 }}
              aria-hidden={!chatOpen}
            >
              <div
                className="material-sidebar h-full border-l border-border-hairline"
                style={{ width: chatWidth }}
              >
                <ChatPanel
                  onClose={() => setChatOpen(false)}
                  intent={chatIntent}
                  onIntentConsumed={() => setChatIntent(null)}
                />
              </div>
            </aside>
          </div>

          {sshLogPanelOpen && <SshSessionLogPanel onClose={() => setSshLogPanelOpen(false)} />}
        </div>

        <StatusBar
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((o) => !o)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <CommandHistoryPalette open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <WorktreePanel />
      <CherryPickDialog />
      <RebasePanel />
      <PrPanel />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <AskAiFloater onAsk={() => askArcAi.current()} />
      <PasteWarning />

      {/* Offscreen host stack. Tab content lives here until a leaf claims it
          via DOM reparenting. `display:none` keeps the size measurer happy
          (xterm won't try to render to a 0x0 canvas inside a hidden parent)
          and `aria-hidden` keeps screen readers off it. */}
      <div ref={stageRef} className="hidden" aria-hidden />

      {/* Portals: render each tab's content into its dedicated host div.
          The host div is stable across drag/drop and split moves; the React
          subtree below the portal therefore never unmounts. */}
      {portals}
    </div>
  );
}

/** Tiny wrapper so we can use `createPortal` inside the memoized list. */
function PortalSlot({ host, children }: { host: HTMLDivElement; children: React.ReactNode }) {
  return createPortal(children, host);
}

/**
 * Catches render-time exceptions from a tab's content (Terminal / Editor) so
 * one crashing pane can't unmount the whole portal list and blank the app.
 * xterm.js in particular can throw from its async render loop when the WebGL
 * renderer is left in a broken state.
 */
class TabErrorBoundary extends Component<
  { tabId: string; children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[tab ${this.props.tabId}] crashed:`, error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center px-6 text-center">
          <div className="max-w-sm space-y-2">
            <div className="font-display text-[13px] tracking-tight text-fg-base">
              this tab crashed
            </div>
            <div className="text-[11px] text-fg-muted">
              {this.state.error.message || 'unknown error'}
            </div>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-md border border-border-subtle px-2.5 py-1 text-[11px] text-fg-base hover:bg-bg-surface"
            >
              retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const CATEGORY_TO_GROUP: Record<
  'Workspace' | 'Terminal' | 'Assistant' | 'SSH' | 'AI CLIs' | 'Help',
  CommandGroup
> = {
  Workspace: 'Workspace',
  Terminal: 'Terminal',
  Assistant: 'Assistant',
  SSH: 'SSH',
  'AI CLIs': 'AI CLIs',
  Help: 'Help',
};

function EditorFallback() {
  return (
    <div className="flex h-full items-center justify-center gap-1.5 text-fg-subtle">
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" />
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.2s' }} />
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.4s' }} />
    </div>
  );
}
