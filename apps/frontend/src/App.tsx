import { Component, lazy, Suspense, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from './components/Terminal';
import { Preview } from './components/Preview';
import { useSsh } from './state/ssh';
import { useGitUi } from './state/gitUi';
import { TabBar } from './components/TabBar';
import { WindowResizeHandles } from './components/WindowResizeHandles';
import { CommandPalette } from './components/CommandPalette';
import { CommandHistoryPalette } from './components/CommandHistoryPalette';
import { CommandBlocks } from './components/CommandBlocks';
import { Sidebar, SidebarRail } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { EmptyWorkspace } from './components/EmptyWorkspace';
import { ResizeHandle } from './components/ResizeHandle';
import { SearchPalette } from './components/SearchPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { PaneTreeView } from './components/PaneTreeView';
import { WorkspaceRail } from './components/WorkspaceRail';
import { useWorkspace } from './state/workspace';
import {
  useFiles,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_RAIL_WIDTH_LABELED,
  defaultWidthForView,
} from './state/files';
import {
  actionFor,
  ACTION_META,
  getBinding,
  formatBinding,
  type ActionId,
} from './state/shortcuts';
import { useCommands, type CommandAction, type CommandGroup } from './state/commands';
import { useTaskCommands } from './state/tasks';
import { WingmanPromptDialog } from './components/WingmanPromptDialog';
import {
  Bot,
  FolderOpen,
  FolderTree,
  GitPullRequest,
  Inbox,
  LayoutGrid,
  ListOrdered,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
// Side-effect import: subscribes to file-tree root changes and keeps the
// project-config store fresh. Doesn't render anything itself.
import './state/projectConfig';
import { fsPickFolder, ptyListAiClis, settingsWindowOpen, type AiCliId } from './lib/tauri';
import { PasteWarning } from './components/PasteWarning';
import { TrustPrompt } from './components/TrustPrompt';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Toasts } from './components/Toasts';
import { UpdateToast } from './components/UpdateToast';
import { useSettings, type TerminalProfile } from './state/settings';
import { useAi } from './state/ai';
import { autoConnectWingman, useWingman } from './state/wingman';
import { useClaudeCode } from './state/claudeCode';

// CodeMirror is heavy — defer its bundle until a file is actually opened.
const Editor = lazy(() =>
  import('./components/Editor').then((m) => ({ default: m.Editor })),
);
const DiffView = lazy(() =>
  import('./components/DiffView').then((m) => ({ default: m.DiffView })),
);
const MergeView = lazy(() =>
  import('./components/MergeView').then((m) => ({ default: m.MergeView })),
);
const DbClient = lazy(() =>
  import('./components/DbClient').then((m) => ({ default: m.DbClient })),
);
// Everything below is reachable but rarely on the boot path — a REST client,
// an SSH terminal, the SSH log drawer and the git overlays. Each is only
// rendered behind a tab kind or an open flag, so deferring them keeps the
// entry chunk to what a cold "open a terminal" launch actually needs.
const ApiClient = lazy(() =>
  import('./components/ApiClient').then((m) => ({ default: m.ApiClient })),
);
const SshTab = lazy(() =>
  import('./components/ssh/SshTab').then((m) => ({ default: m.SshTab })),
);
const SshSessionLogPanel = lazy(() =>
  import('./components/ssh/SshSessionLogDrawer').then((m) => ({
    default: m.SshSessionLogPanel,
  })),
);
const GitOverlays = lazy(() =>
  import('./components/git/GitOverlays').then((m) => ({ default: m.GitOverlays })),
);
const WingmanBoard = lazy(() =>
  import('./components/wingman/WingmanBoard').then((m) => ({ default: m.WingmanBoard })),
);
const WingmanReview = lazy(() =>
  import('./components/wingman/WingmanReview').then((m) => ({ default: m.WingmanReview })),
);

export default function App() {
  const { tabs, activeTabId } = useWorkspace();
  const launchAiCli = useWorkspace((s) => s.launchAiCli);
  const launchWingman = useWorkspace((s) => s.launchWingman);
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const hydrate = useWorkspace((s) => s.hydrate);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Register the project's package.json scripts as ⌘K "Run: <script>" commands.
  useTaskCommands();
  useTerminalProfileCommands();

  // Host-div registry — one stable DOM node per tab id. The tab's content
  // (Terminal / Editor) is portaled into its host once and stays there for
  // the tab's lifetime. The host node is reparented between the offscreen
  // stage and whichever pane currently displays the tab, but its React
  // subtree never unmounts. That's what keeps PTYs alive across drag/drop
  // and pane splits.
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const stageRef = useRef<HTMLDivElement>(null);
  // The sidebar's two columns — the always-on icon rail on the window edge
  // and the panel it drives. The panel stays mounted while collapsed so the
  // width transition can play, which means it needs deactivating, not hiding.
  const railAsideRef = useRef<HTMLElement>(null);
  const panelAsideRef = useRef<HTMLElement>(null);

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
        <Suspense fallback={<EditorFallback />}>
          <ApiClient tabId={tab.id} />
        </Suspense>
      ) : tab.kind === 'ssh' && tab.sshHostId ? (
        <Suspense fallback={<EditorFallback />}>
          <SshTab sessionKey={tab.id} hostId={tab.sshHostId} />
        </Suspense>
      ) : tab.kind === 'wingman-board' ? (
        <Suspense fallback={<EditorFallback />}>
          <WingmanBoard />
        </Suspense>
      ) : tab.kind === 'wingman-review' ? (
        <Suspense fallback={<EditorFallback />}>
          <WingmanReview />
        </Suspense>
      ) : tab.kind === 'db' ? (
        <Suspense fallback={<EditorFallback />}>
          <DbClient tabId={tab.id} />
        </Suspense>
      ) : tab.kind === 'merge' && tab.filePath && tab.mergeRoot ? (
        <Suspense fallback={<EditorFallback />}>
          <MergeView filePath={tab.filePath} mergeRoot={tab.mergeRoot} />
        </Suspense>
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
          <span className="font-display text-base tracking-tight">no file</span>
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
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The launcher (EmptyWorkspace) otherwise only appears when a workspace has
  // zero tabs — i.e. once, before you ever open anything. It's the app's best
  // map of what ARC can do, so it stays reachable as an overlay.
  const [launcherOpen, setLauncherOpen] = useState(false);
  const sidebarCollapsed = useFiles((s) => s.collapsed);
  const railLabels = useFiles((s) => s.railLabels);
  // One boolean gates the lazy git-overlay chunk. Each panel still self-gates
  // internally; this only decides whether the chunk is fetched at all.
  const anyGitOverlayOpen = useGitUi(
    (s) =>
      s.worktreeExpanded ||
      s.rebaseExpanded ||
      s.cherryPickTarget !== null ||
      s.prPanelView.kind !== 'closed',
  );
  const sidebarWidth = useFiles((s) => s.sidebarWidth);
  const sidebarView = useFiles((s) => s.sidebarView);
  const toggleSidebar = useFiles((s) => s.toggleCollapsed);
  const setSidebarWidth = useFiles((s) => s.setSidebarWidth);
  const openSettings = () =>
    void settingsWindowOpen().catch((err) =>
      console.error('[settings] open window failed:', err),
    );

  // Load persisted tabs + active tab from SQLite (or legacy localStorage)
  // before the renderer settles. hydrate() is idempotent.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Restore saved SSH hosts + keys. Idempotent — store guards on `hydrated`.
  useEffect(() => {
    void useSsh.getState().hydrate();
  }, []);

  // Connect to the configured Wingman daemon once settings have hydrated.
  // Deliberately fire-and-forget: ARC works fully without Wingman, so a
  // missing or unreachable daemon must never block or error the shell.
  const wingmanUrl = useSettings((s) => s.wingmanUrl);
  const settingsHydrated = useSettings((s) => s.settingsHydrated);
  useEffect(() => {
    if (!settingsHydrated) return;
    void autoConnectWingman(wingmanUrl);
  }, [settingsHydrated, wingmanUrl]);

  // Probe for the Claude Code CLI once on boot. Nothing to connect to — this
  // only decides whether the panel and its palette entries exist at all.
  useEffect(() => {
    void useClaudeCode.getState().detect();
  }, []);

  const sshLogPanelOpen = useSsh((s) => s.logPanelOpen);
  const setSshLogPanelOpen = useSsh((s) => s.setLogPanelOpen);

  // Settings are hydrated by Root in main.tsx (shared across the main and
  // Settings windows).

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
    // AI CLI launchers are derived from AI_CLIS rather than enumerated, so
    // they're dispatched by prefix here; Wingman's extra pilot/headless modes
    // aren't plain launches and fall through to the switch.
    if (
      action.startsWith('launch-') &&
      action !== 'launch-wingman-pilot' &&
      action !== 'launch-wingman-headless'
    ) {
      if (action === 'launch-wingman-cli') void launchWingman('tui');
      else void launchCli(action.slice('launch-'.length) as AiCliId);
      return;
    }
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
      case 'open-command-blocks':
        setBlocksOpen(true);
        return;
      case 'ai-command': {
        // Terminal-only: the bar types into a shell, so there has to be one.
        const tab = useWorkspace.getState().tabs.find((t) => t.id === activeTabId);
        if (tab?.kind === 'terminal') useAi.getState().open(tab.id);
        return;
      }
      case 'open-search':
        setSearchOpen(true);
        return;
      case 'open-shortcuts':
        setShortcutsOpen(true);
        return;
      case 'show-explorer':
        useFiles.getState().showSidebarView('files');
        return;
      case 'show-source-control':
        useFiles.getState().showSidebarView('git');
        return;
      case 'toggle-ssh-panel':
        useFiles.getState().toggleSidebarView('ssh');
        return;
      case 'launch-wingman-pilot':
        void launchWingman('pilot');
        return;
      case 'launch-wingman-headless':
        void launchWingman('headless');
        return;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e);
      if (!action) return;
      // Capture phase + stopPropagation so app shortcuts win over a focused
      // terminal (xterm) or editor (CodeMirror) — otherwise the terminal eats
      // control chars like Ctrl+P (^P) before the app ever sees them.
      e.preventDefault();
      e.stopPropagation();
      dispatchActionRef.current(action);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Deactivate the panel while it's collapsed to zero width. `aria-hidden`
  // alone (what this used to rely on) hides the subtree from the a11y tree
  // but leaves its controls in the tab order, so Tab landed on an invisible
  // panel — a lot more obvious now that focus rings are visible.
  //
  // `inert` covers both, but it does not blur a descendant that is already
  // focused, so collapsing while focus sat in the panel left the user parked
  // on a control the a11y tree says does not exist. Hand focus back to the
  // rail's active tab, which is still on screen.
  useEffect(() => {
    const rail = railAsideRef.current;
    const panel = panelAsideRef.current;
    if (!rail || !panel) return;
    panel.inert = sidebarCollapsed;
    if (sidebarCollapsed && panel.contains(document.activeElement)) {
      rail.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }
  }, [sidebarCollapsed]);

  // Seed the command-palette registry with every ActionId. Other features
  // can register their own ad-hoc actions on top of these.
  useEffect(() => {
    const seed: CommandAction[] = (Object.keys(ACTION_META) as ActionId[]).map((id) => {
      const meta = ACTION_META[id];
      const binding = getBinding(id);
      return {
        id: `shortcut.${id}`,
        title: meta.label,
        description: meta.description,
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
        id: 'workspace.open-folder',
        title: 'Open Folder…',
        group: 'Workspace',
        keywords: ['open', 'folder', 'root', 'project', 'directory', 'workspace'],
        icon: FolderOpen,
        run: () => {
          void fsPickFolder(useFiles.getState().root).then((dir) => {
            if (dir) useFiles.getState().setRoot(dir);
          });
        },
      },
      {
        id: 'workspace.launcher',
        title: 'Show Launcher',
        group: 'Workspace',
        keywords: ['launcher', 'new', 'start', 'tools', 'home', 'welcome', 'recent'],
        icon: LayoutGrid,
        run: () => setLauncherOpen(true),
      },
      {
        id: 'git.manage-worktrees',
        title: 'Manage Worktrees',
        group: 'Git',
        keywords: ['worktree', 'git', 'branch', 'switch'],
        icon: FolderTree,
        run: () => {
          // Lazy import to avoid a circular dependency on App-local state.
          void import('./state/gitUi').then(({ useGitUi }) => {
            useFiles.getState().showSidebarView('git');
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
            useFiles.getState().showSidebarView('git');
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
      // Wingman actions only appear once a daemon is actually connected —
      // offering them otherwise would surface a feature the user can't use.
      {
        id: 'wingman.panel',
        title: 'Wingman: Ask about this repo',
        group: 'Wingman',
        keywords: ['ai', 'agent', 'chat', 'wingman', 'ask'],
        icon: Bot,
        when: () => useWingman.getState().status === 'connected',
        run: () => useFiles.getState().showSidebarView('wingman'),
      },
      {
        id: 'wingman.board',
        title: 'Wingman: Pilot Board',
        group: 'Wingman',
        keywords: ['board', 'kanban', 'pilot', 'agent', 'runs', 'tasks'],
        icon: LayoutGrid,
        when: () => useWingman.getState().status === 'connected',
        run: () => {
          useWorkspace.getState().openWingmanBoard();
        },
      },
      {
        id: 'wingman.review',
        title: 'Wingman: Review Queue',
        group: 'Wingman',
        keywords: ['review', 'queue', 'diff', 'approve', 'agent', 'changes', 'worktree'],
        icon: Inbox,
        when: () => useWingman.getState().status === 'connected',
        run: () => {
          useWorkspace.getState().openWingmanReview();
        },
      },
      {
        id: 'wingman.explain-diff',
        title: 'Wingman: Explain working-tree changes',
        group: 'Wingman',
        keywords: ['explain', 'diff', 'changes', 'summary', 'review'],
        icon: Bot,
        when: () => useWingman.getState().status === 'connected',
        run: () => {
          // Answered by the daemon's `explain` route, not an agent turn — the
          // result lands in the panel transcript either way, but this costs no
          // tokens and returns in one round trip.
          useFiles.getState().showSidebarView('wingman');
          void useWingman.getState().explainChanges();
        },
      },
      // Same rule as Wingman's: only offered once the CLI is actually
      // installed, so the palette never lists a panel that can't answer.
      {
        id: 'claude.panel',
        title: 'Claude Code: Ask about this repo',
        group: 'Claude Code',
        keywords: ['ai', 'agent', 'chat', 'claude', 'ask', 'code'],
        icon: Sparkles,
        when: () => useClaudeCode.getState().status === 'ready',
        run: () => useFiles.getState().showSidebarView('claude'),
      },
      {
        id: 'claude.new-chat',
        title: 'Claude Code: New conversation',
        group: 'Claude Code',
        keywords: ['claude', 'new', 'reset', 'clear', 'chat', 'session'],
        icon: Sparkles,
        when: () => useClaudeCode.getState().status === 'ready',
        run: () => {
          useClaudeCode.getState().newChat();
          useFiles.getState().showSidebarView('claude');
        },
      },
    ];
    return useCommands.getState().registerMany(extras);
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-base text-fg-base">
      <div className="desktop-wash" aria-hidden />

      <div className="relative z-10 flex h-full w-full">
        {/* Discord/Slack-style workspace rail — leftmost full-height column. */}
        <WorkspaceRail onOpenSettings={openSettings} />

        {/* Everything right of the workspace rail. The title bar spans this
            whole column — over the panes *and* the sidebar — so the window
            controls sit flush against the window's right edge. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabBar />

          {/* Layout: main | sidebar panel | sidebar rail (right edge) */}
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className="relative flex min-h-0 min-w-0 flex-1 px-3 pb-2 pt-1">
              <div className="material-content flex min-h-0 w-full overflow-hidden rounded-window shadow-panel ring-1 ring-border-subtle">
                <main className="relative min-w-0 flex-1 overflow-hidden p-1.5">
                  {/* Split-pane tree — each leaf hosts a tab and can be split
                      right/down into a new pane, with draggable dividers. */}
                  <PaneTreeView
                    hostsRef={hostsRef}
                    stageRef={stageRef}
                    onOpenCommandPalette={() => setPaletteOpen(true)}
                  />
                </main>
              </div>

              {sshLogPanelOpen && (
                <Suspense fallback={null}>
                  <SshSessionLogPanel onClose={() => setSshLogPanelOpen(false)} />
                </Suspense>
              )}
            </div>

            {/* Sidebar — columns on the right edge, mirroring the workspace
                rail on the left: the panel, then its activity rail pinned
                outboard against the window edge. They run from under the
                title bar to the bottom of the window. The rail never
                collapses, so there is always a way back to a view. */}
            {!sidebarCollapsed && (
              <ResizeHandle
                edge="right"
                getWidth={() => useFiles.getState().sidebarWidth}
                onResize={setSidebarWidth}
                resetWidth={defaultWidthForView(sidebarView)}
              />
            )}
            <aside
              ref={panelAsideRef}
              className="shrink-0 overflow-hidden transition-[width] duration-300 ease-apple"
              style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
              aria-hidden={sidebarCollapsed}
            >
              <div
                className="material-sidebar h-full border-l border-border-hairline"
                style={{ width: sidebarWidth }}
              >
                <Sidebar />
              </div>
            </aside>
            <aside
              ref={railAsideRef}
              className="material-sidebar shrink-0 border-l border-border-hairline transition-[width] duration-200 ease-apple"
              style={{ width: railLabels ? SIDEBAR_RAIL_WIDTH_LABELED : SIDEBAR_RAIL_WIDTH }}
            >
              <SidebarRail />
            </aside>
          </div>

          <StatusBar />
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <CommandHistoryPalette open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <CommandBlocks open={blocksOpen} onClose={() => setBlocksOpen(false)} />
      <WingmanPromptDialog />
      {anyGitOverlayOpen && (
        <Suspense fallback={null}>
          <GitOverlays />
        </Suspense>
      )}
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {launcherOpen && (
        <LauncherOverlay
          onClose={() => setLauncherOpen(false)}
          onOpenCommandPalette={() => {
            setLauncherOpen(false);
            setPaletteOpen(true);
          }}
        />
      )}
      <PasteWarning />
      <TrustPrompt />
      <ConfirmDialog />
      <Toasts />
      <UpdateToast />

      {/* Offscreen host stack. Tab content lives here until a leaf claims it
          via DOM reparenting. `display:none` keeps the size measurer happy
          (xterm won't try to render to a 0x0 canvas inside a hidden parent)
          and `aria-hidden` keeps screen readers off it. */}
      <div ref={stageRef} className="hidden" aria-hidden />

      {/* Portals: render each tab's content into its dedicated host div.
          The host div is stable across drag/drop and split moves; the React
          subtree below the portal therefore never unmounts. */}
      {portals}

      {/* Frameless-window resize grips — the window has decorations:false, so
          native edge/corner resize is gone (notably on Linux). */}
      <WindowResizeHandles />
    </div>
  );
}

/**
 * The launcher, shown on demand over the workspace. `EmptyWorkspace` already
 * lays itself out centred and full-size, so this only adds the scrim and the
 * dismiss paths — anything the user picks opens a tab, which is a dismissal
 * too, hence the capture-phase click close.
 */
function LauncherOverlay({
  onClose,
  onOpenCommandPalette,
}: {
  onClose: () => void;
  onOpenCommandPalette: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 animate-view-in bg-scrim-2 backdrop-blur-sm motion-reduce:animate-none"
      onClick={onClose}
    >
      {/* Every launcher action either opens a tab or reveals a sidebar view, so
          a click is a dismissal — let it through, then close on the next tick.
          `data-launcher-stay` opts a control out (the workspace-edit chip, whose
          popover would otherwise flash and vanish). */}
      <div
        className="h-full w-full"
        onClickCapture={(e) => {
          if ((e.target as HTMLElement | null)?.closest('[data-launcher-stay]')) return;
          setTimeout(onClose, 0);
        }}
      >
        <EmptyWorkspace onOpenCommandPalette={onOpenCommandPalette} />
      </div>
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
 * xterm.js in particular can throw from its async render loop.
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
            <div className="font-display text-base tracking-tight text-fg-base">
              this tab crashed
            </div>
            <div className="text-xs text-fg-muted">
              {this.state.error.message || 'unknown error'}
            </div>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-md border border-border-subtle px-2.5 py-1 text-xs text-fg-base hover:bg-bg-surface"
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
  'Workspace' | 'Terminal' | 'SSH' | 'AI CLIs' | 'Help',
  CommandGroup
> = {
  Workspace: 'Workspace',
  Terminal: 'Terminal',
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

/**
 * Register one "New terminal: <profile>" palette command per terminal
 * profile, re-registering whenever the profile list changes.
 *
 * Mirrors `useTaskCommands`: the palette is the discovery surface for things
 * that don't earn a keybinding, and profiles are defined in Settings where
 * the palette can't see them without a subscription.
 */
function useTerminalProfileCommands(): void {
  useEffect(() => {
    let unregister: (() => void) | null = null;

    const refresh = (profiles: TerminalProfile[]) => {
      unregister?.();
      unregister = null;
      if (profiles.length === 0) return;
      const actions: CommandAction[] = profiles.map((profile) => ({
        id: `terminal.profile.${profile.id}`,
        title: `New terminal: ${profile.name}`,
        group: 'Terminal',
        keywords: ['terminal', 'shell', 'new', 'profile', profile.name, profile.shell],
        icon: TerminalSquare,
        run: () => {
          void useWorkspace
            .getState()
            .newTerminal({ title: profile.name, profileId: profile.id });
        },
      }));
      unregister = useCommands.getState().registerMany(actions);
    };

    refresh(useSettings.getState().terminalProfiles);
    const unsub = useSettings.subscribe((s, prev) => {
      if (s.terminalProfiles !== prev.terminalProfiles) refresh(s.terminalProfiles);
    });

    return () => {
      unsub();
      unregister?.();
    };
  }, []);
}
