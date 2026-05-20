import { lazy, Suspense, useEffect, useState } from 'react';
import { Terminal } from './components/Terminal';
import { TabBar } from './components/TabBar';
import { ChatPanel } from './components/ChatPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { FileTree } from './components/FileTree';
import { ResizeHandle } from './components/ResizeHandle';
import { SearchPalette } from './components/SearchPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { useWorkspace } from './state/workspace';
import { useFiles } from './state/files';
import { useSettings } from './state/settings';
import { useChat } from './state/chat';
import { actionFor, type ActionId } from './state/shortcuts';
import { cn } from './lib/cn';
import type { ChatIntent } from './components/ChatPanel';

// CodeMirror is heavy — defer its bundle until a file is actually opened.
const Editor = lazy(() =>
  import('./components/Editor').then((m) => ({ default: m.Editor })),
);

export default function App() {
  const { tabs, activeTabId, addTab } = useWorkspace();
  const hydrate = useWorkspace((s) => s.hydrate);
  const hydrateChat = useChat((s) => s.hydrate);
  const hydrateSecrets = useSettings((s) => s.hydrateSecrets);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Chat panel is now a floating popover instead of a docked sidebar.
  // Default open so it's discoverable on first launch; user can dismiss.
  const [chatOpen, setChatOpen] = useState(true);
  // One-shot action requested from a global keyboard shortcut. The
  // timestamp lets ChatPanel re-fire on consecutive identical intents.
  const [chatIntent, setChatIntent] = useState<ChatIntent | null>(null);
  const sidebarCollapsed = useFiles((s) => s.collapsed);
  const sidebarWidth = useFiles((s) => s.sidebarWidth);
  const toggleSidebar = useFiles((s) => s.toggleCollapsed);
  const setSidebarWidth = useFiles((s) => s.setSidebarWidth);

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

  // Pull API keys out of the OS credential vault into the settings store,
  // and migrate any legacy plaintext keys out of localStorage on the way.
  useEffect(() => {
    void hydrateSecrets();
  }, [hydrateSecrets]);

  useEffect(() => {
    const dispatch = (action: ActionId) => {
      switch (action) {
        case 'new-terminal': {
          const id = `term-${Date.now()}`;
          addTab({ id, title: 'shell', kind: 'terminal' });
          return;
        }
        case 'open-settings':
          setSettingsOpen(true);
          return;
        case 'toggle-sidebar':
          toggleSidebar();
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
      }
    };

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
      dispatch(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTab, toggleSidebar, chatOpen]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-base text-fg-base">
      <div className="desktop-wash" aria-hidden />

      <div className="relative z-10 flex h-full w-full flex-col">
        <TabBar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onToggleChat={() => setChatOpen((o) => !o)}
          chatOpen={chatOpen}
        />

        {/* Two-pane layout (file tree · main). The assistant lives in a
            floating popover that overlays the main pane from the right. */}
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
                <FileTree />
              </div>
            </aside>

            {!sidebarCollapsed && (
              <ResizeHandle
                edge="left"
                getWidth={() => useFiles.getState().sidebarWidth}
                onResize={setSidebarWidth}
              />
            )}

            <main className="dot-grid relative min-w-0 flex-1 overflow-hidden">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTab?.id;
                return (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{
                    visibility: isActive ? 'visible' : 'hidden',
                    pointerEvents: isActive ? 'auto' : 'none',
                  }}
                >
                  {tab.kind === 'terminal' ? (
                    <Terminal sessionKey={tab.id} />
                  ) : tab.filePath ? (
                    <Suspense fallback={<EditorFallback />}>
                      <Editor filePath={tab.filePath} tabId={tab.id} />
                    </Suspense>
                  ) : (
                    <div className="flex h-full items-center justify-center text-fg-muted">
                      <span className="font-display text-[13px] tracking-tight">
                        no file
                      </span>
                    </div>
                  )}
                </div>
                );
              })}
            </main>
          </div>

          {/* Floating assistant popover — anchored to the top-right of the
              content frame, slides in from the right edge. The frame uses
              `material-sheet` for the heaviest blur in the system. */}
          {chatOpen && (
            <div
              className={cn(
                'absolute bottom-2 right-5 z-30',
                'h-[min(calc(100%-1rem),640px)] w-[400px]',
                'animate-popover-in',
              )}
              role="dialog"
              aria-label="Assistant"
            >
              <div
                className={cn(
                  'material-sheet flex h-full w-full flex-col overflow-hidden rounded-window',
                  'ring-1 ring-white/[0.06] shadow-sheet',
                )}
              >
                <ChatPanel
                  onClose={() => setChatOpen(false)}
                  intent={chatIntent}
                  onIntentConsumed={() => setChatIntent(null)}
                />
              </div>
            </div>
          )}
        </div>

        <StatusBar />
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPalette open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

function EditorFallback() {
  return (
    <div className="flex h-full items-center justify-center gap-1.5 text-fg-subtle">
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" />
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.2s' }} />
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.4s' }} />
    </div>
  );
}
