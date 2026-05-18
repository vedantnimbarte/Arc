import {
  Plus,
  X,
  Terminal as TerminalIcon,
  FileCode,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

interface Props {
  onOpenSettings: () => void;
}

export function TabBar({ onOpenSettings }: Props) {
  const { tabs, activeTabId, setActive, closeTab, addTab, tabDirty } = useWorkspace();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const sidebarCollapsed = useFiles((s) => s.collapsed);
  const toggleSidebar = useFiles((s) => s.toggleCollapsed);

  const requestClose = (id: string, title: string) => {
    if (tabDirty[id]) {
      const ok = window.confirm(`"${title}" has unsaved changes. Discard them?`);
      if (!ok) return;
    }
    closeTab(id);
  };

  return (
    <div className="material-toolbar relative flex h-11 shrink-0 items-center gap-3 px-3">
      {/* Sidebar toggle — the standard macOS toolbar control. ⌘B is
          the system-wide shortcut for the same action. */}
      <button
        onClick={toggleSidebar}
        className="group flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12]"
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen size={14} strokeWidth={1.9} />
        ) : (
          <PanelLeftClose size={14} strokeWidth={1.9} />
        )}
      </button>

      {/* Centered window title — a quintessential macOS chrome detail.
          Hidden on narrow widths so the tabs always win for space. */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 select-none items-center gap-1.5 md:flex">
        <span className="font-display text-[12px] font-semibold tracking-tight text-fg-base/85">
          arc
        </span>
        <span className="text-fg-subtle">·</span>
        <span className="max-w-[260px] truncate font-display text-[12px] tracking-tight text-fg-muted">
          {activeTab?.title ?? 'shell'}
        </span>
      </div>

      {/* Tabs — Safari/Terminal-style pill tabs aligned to the right of
          the traffic lights, no border between active and inactive. */}
      <div className="scrollbar-none ml-2 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const Icon = tab.kind === 'terminal' ? TerminalIcon : FileCode;
          const dirty = !!tabDirty[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={cn(
                'group relative flex h-7 items-center gap-1.5 rounded-md px-2.5 font-display text-[12px] font-medium tracking-tight transition-all duration-150 ease-apple',
                isActive
                  ? 'bg-white/[0.08] text-fg-base shadow-control'
                  : 'text-fg-muted hover:bg-white/[0.04] hover:text-fg-base/90',
              )}
            >
              <Icon
                size={11}
                strokeWidth={2.2}
                className={cn('shrink-0 transition-colors', isActive ? 'text-accent' : 'text-fg-subtle')}
              />
              <span className="max-w-[160px] truncate">{tab.title}</span>
              {/* macOS pattern: a dirty file shows a colored dot where the
                  close button would be; hovering swaps in the X. */}
              <span
                role="button"
                tabIndex={0}
                aria-label={dirty ? 'Close tab (unsaved changes)' : 'Close tab'}
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(tab.id, tab.title);
                }}
                className={cn(
                  'relative ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full',
                  'transition-all duration-150 hover:bg-white/15 hover:text-fg-base',
                  dirty
                    ? 'text-accent hover:text-fg-base'
                    : 'text-fg-subtle opacity-0 group-hover:opacity-100',
                )}
              >
                {dirty ? (
                  <>
                    <span className="absolute inset-0 m-auto h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm transition-opacity duration-150 group-hover:opacity-0" />
                    <X size={9} strokeWidth={2.5} className="opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                  </>
                ) : (
                  <X size={9} strokeWidth={2.5} />
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Right-side toolbar buttons — borderless circular hit targets,
          the macOS Big Sur+ aesthetic. */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() =>
            addTab({
              id: `term-${Date.now()}`,
              title: 'shell',
              kind: 'terminal',
            })
          }
          className="group flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12]"
          aria-label="New terminal"
          title="New terminal (⌘T)"
        >
          <Plus
            size={14}
            strokeWidth={2}
            className="transition-transform duration-200 ease-apple group-active:scale-90"
          />
        </button>
        <button
          onClick={onOpenSettings}
          className="group flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12]"
          aria-label="Open settings"
          title="Settings (⌘,)"
        >
          <SettingsIcon
            size={13}
            strokeWidth={1.9}
            className="transition-transform duration-500 ease-apple group-hover:rotate-45"
          />
        </button>
      </div>
    </div>
  );
}
