import { lazy, Suspense, useEffect, useState } from 'react';
import { Terminal } from './components/Terminal';
import { TabBar } from './components/TabBar';
import { ChatPanel } from './components/ChatPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { FileTree } from './components/FileTree';
import { ResizeHandle } from './components/ResizeHandle';
import { useWorkspace } from './state/workspace';
import { useFiles } from './state/files';
import { cn } from './lib/cn';

// CodeMirror is heavy — defer its bundle until a file is actually opened.
const Editor = lazy(() =>
  import('./components/Editor').then((m) => ({ default: m.Editor })),
);

export default function App() {
  const { tabs, activeTabId, addTab } = useWorkspace();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sidebarCollapsed = useFiles((s) => s.collapsed);
  const sidebarWidth = useFiles((s) => s.sidebarWidth);
  const chatWidth = useFiles((s) => s.chatWidth);
  const toggleSidebar = useFiles((s) => s.toggleCollapsed);
  const setSidebarWidth = useFiles((s) => s.setSidebarWidth);
  const setChatWidth = useFiles((s) => s.setChatWidth);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        const id = `term-${Date.now()}`;
        addTab({ id, title: 'shell', kind: 'terminal' });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      // ⌘B / Ctrl+B — toggle the file-tree sidebar (macOS convention)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTab, toggleSidebar]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-base text-fg-base">
      <div className="desktop-wash" aria-hidden />

      <div className="relative z-10 flex h-full w-full flex-col">
        <TabBar onOpenSettings={() => setSettingsOpen(true)} />

        {/* Three-pane layout: file tree · terminal · chat. The whole row
            sits in a single rounded window with draggable hairline
            dividers between panes — matching Xcode / Finder docking. */}
        <div className="flex min-h-0 flex-1 px-3 pb-3 pt-1">
          <div className="material-content flex min-h-0 w-full overflow-hidden rounded-window shadow-panel ring-1 ring-border-subtle">
            {/* File-tree wrapper — animates width to 0 on collapse. The
                inner pane keeps its full width so the contents slide
                cleanly instead of reflowing. */}
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
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={cn('h-full w-full')}
                  style={{ display: tab.id === activeTab?.id ? 'block' : 'none' }}
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
              ))}
            </main>

            <ResizeHandle
              edge="right"
              getWidth={() => useFiles.getState().chatWidth}
              onResize={setChatWidth}
            />

            <aside
              className="material-sidebar shrink-0 overflow-hidden border-l border-border-hairline"
              style={{ width: chatWidth }}
            >
              <ChatPanel />
            </aside>
          </div>
        </div>

        <StatusBar />
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
