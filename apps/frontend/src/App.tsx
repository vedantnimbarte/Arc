import { useEffect, useState } from 'react';
import { Terminal } from './components/Terminal';
import { TabBar } from './components/TabBar';
import { ChatPanel } from './components/ChatPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { useWorkspace } from './state/workspace';

export default function App() {
  const { tabs, activeTabId, addTab } = useWorkspace();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+T → new terminal tab
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        const id = `term-${Date.now()}`;
        addTab({ id, title: 'shell', kind: 'terminal' });
      }
      // Ctrl/Cmd+, → open settings
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTab]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg-base text-fg-base">
      {/* Soft gradient mesh behind everything */}
      <div className="atmosphere" aria-hidden />

      <div className="relative z-10 flex h-full w-full flex-col">
        <TabBar onOpenSettings={() => setSettingsOpen(true)} />

        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-2">
          <main className="dot-grid relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-bg-panel/55 shadow-panel ring-1 ring-border-subtle">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className="h-full w-full"
                style={{ display: tab.id === activeTab?.id ? 'block' : 'none' }}
              >
                {tab.kind === 'terminal' ? (
                  <Terminal sessionKey={tab.id} />
                ) : (
                  <div className="flex h-full items-center justify-center text-fg-muted">
                    <span className="font-display text-[13px] tracking-tight">
                      editor · coming soon
                    </span>
                  </div>
                )}
              </div>
            ))}
          </main>

          <aside className="w-[380px] shrink-0 overflow-hidden rounded-2xl shadow-panel ring-1 ring-border-subtle">
            <ChatPanel />
          </aside>
        </div>

        <StatusBar />
      </div>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
