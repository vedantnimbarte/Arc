import {
  Plus,
  X,
  Terminal as TerminalIcon,
  FileCode,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Sparkles,
} from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

interface Props {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onToggleChat: () => void;
  chatOpen: boolean;
}

export function TabBar({ onOpenSettings, onOpenSearch, onToggleChat, chatOpen }: Props) {
  const { tabs, activeTabId, setActive, closeTab, addTab, tabDirty } = useWorkspace();
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
    <div className="material-toolbar relative flex h-11 shrink-0 items-center gap-2 px-3">
      {/* Sidebar toggle — left rail, mirrors macOS toolbar control */}
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

      {/* Tab strip — browser-style pills aligned to the left rail. Subtle
          vertical separator hairline before the row gives the topbar two
          distinct zones (chrome controls / tabs). */}
      <div className="ml-0.5 h-5 w-px bg-white/[0.06]" aria-hidden />

      <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pl-1">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const Icon = tab.kind === 'terminal' ? TerminalIcon : FileCode;
          const dirty = !!tabDirty[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={cn(
                'group relative flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] px-2 font-display text-[12px] font-medium tracking-tight transition-all duration-150 ease-apple',
                isActive
                  ? 'bg-white/[0.09] text-fg-base shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_1px_2px_0_rgba(0,0,0,0.35)]'
                  : 'text-fg-muted hover:bg-white/[0.04] hover:text-fg-base/90',
              )}
            >
              <Icon
                size={11}
                strokeWidth={2.2}
                className={cn(
                  'shrink-0 transition-colors',
                  isActive ? 'text-accent-bright' : 'text-fg-subtle',
                )}
              />
              <span className="max-w-[150px] truncate">{tab.title}</span>
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

        {/* New-tab "+" sits inline with the tab strip, like a browser. */}
        <button
          onClick={() =>
            addTab({
              id: `term-${Date.now()}`,
              title: 'shell',
              kind: 'terminal',
            })
          }
          className="group ml-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-fg-subtle transition-all duration-200 ease-apple hover:bg-white/[0.06] hover:text-fg-base active:bg-white/[0.10]"
          aria-label="New terminal"
          title="New terminal (⌘T)"
        >
          <Plus
            size={13}
            strokeWidth={2}
            className="transition-transform duration-200 ease-apple group-active:scale-90"
          />
        </button>
      </div>

      {/* Right cluster — search affordance, AI toggle, settings. The search
          pill mirrors the Arc/Chrome address-bar shape so it reads as the
          single entry point for "find anything in this workspace". */}
      <button
        onClick={onOpenSearch}
        className={cn(
          'group flex h-[26px] w-[160px] shrink-0 items-center gap-1.5 rounded-[7px] px-2',
          'border border-white/[0.04] bg-black/[0.18] text-fg-subtle',
          'transition-all duration-150 ease-apple',
          'hover:border-white/[0.08] hover:bg-black/[0.28] hover:text-fg-muted',
          'focus-within:border-accent/40 focus-within:bg-black/[0.32] focus-within:shadow-focus',
        )}
        aria-label="Search files"
        title="Search files (⌘P)"
      >
        <Search size={11} strokeWidth={2.1} className="shrink-0" />
        <span className="flex-1 truncate text-left font-display text-[11.5px] tracking-tight">
          Search
        </span>
        <kbd className="hidden font-mono text-[9.5px] tracking-tight text-fg-subtle/70 group-hover:inline">
          ⌘P
        </kbd>
      </button>

      <div className="ml-0.5 flex items-center gap-0.5">
        <button
          onClick={onToggleChat}
          className={cn(
            'group relative flex h-7 w-7 items-center justify-center rounded-md transition-all duration-200 ease-apple',
            chatOpen
              ? 'bg-white/[0.10] text-accent-bright shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]'
              : 'text-fg-muted hover:bg-white/[0.08] hover:text-fg-base',
          )}
          aria-label={chatOpen ? 'Close assistant' : 'Open assistant'}
          aria-pressed={chatOpen}
          title="Assistant"
        >
          <Sparkles
            size={13}
            strokeWidth={2}
            className={cn(
              'transition-transform duration-300 ease-apple',
              chatOpen && 'scale-110 drop-shadow-[0_0_6px_rgba(220,224,232,0.55)]',
            )}
          />
          {chatOpen && (
            <span
              className="pointer-events-none absolute -bottom-0.5 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full bg-accent-bright/80 shadow-glow-sm"
              aria-hidden
            />
          )}
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
