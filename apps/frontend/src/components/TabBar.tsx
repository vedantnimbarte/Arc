import { Plus, X, Terminal as TerminalIcon, FileCode, Settings as SettingsIcon } from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  onOpenSettings: () => void;
}

export function TabBar({ onOpenSettings }: Props) {
  const { tabs, activeTabId, setActive, closeTab, addTab } = useWorkspace();

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 px-4 pt-1">
      {/* Brand mark */}
      <div className="flex select-none items-center gap-2.5 pr-1">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent-muted font-display text-[11px] font-semibold text-bg-base shadow-glow-sm ring-1 ring-white/10">
          A
        </div>
        <span className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-muted">
          arc
        </span>
      </div>

      <div className="h-4 w-px bg-border-subtle" />

      {/* Tabs */}
      <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const Icon = tab.kind === 'terminal' ? TerminalIcon : FileCode;
          return (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              className={cn(
                'group relative flex h-8 items-center gap-2 rounded-lg px-3 font-display text-[12px] font-medium tracking-tight transition-all duration-200 ease-out-soft',
                isActive
                  ? 'bg-bg-hover/70 text-fg-base shadow-soft'
                  : 'text-fg-muted hover:bg-bg-subtle/50 hover:text-fg-base',
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-r-full bg-accent shadow-glow-sm" />
              )}
              <Icon
                size={12}
                strokeWidth={2}
                className={cn('shrink-0 transition-colors', isActive && 'text-accent')}
              />
              <span className="max-w-[200px] truncate">{tab.title}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                className="ml-1 flex h-4 w-4 items-center justify-center rounded-md text-fg-subtle opacity-0 transition-all duration-200 hover:bg-bg-base hover:text-fg-base group-hover:opacity-100"
              >
                <X size={11} strokeWidth={2.25} />
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onOpenSettings}
          className="group flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-all duration-300 ease-out-soft hover:bg-bg-hover/70 hover:text-accent"
          aria-label="Open settings"
          title="Settings"
        >
          <SettingsIcon
            size={13}
            strokeWidth={2}
            className="transition-transform duration-500 ease-out-soft group-hover:rotate-90"
          />
        </button>
        <button
          onClick={() =>
            addTab({
              id: `term-${Date.now()}`,
              title: 'shell',
              kind: 'terminal',
            })
          }
          className="group flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-all duration-300 ease-out-soft hover:bg-bg-hover/70 hover:text-accent"
          aria-label="New terminal"
          title="New terminal (Ctrl+T)"
        >
          <Plus
            size={14}
            strokeWidth={2.25}
            className="transition-transform duration-300 ease-out-soft group-hover:rotate-90"
          />
        </button>
      </div>
    </div>
  );
}
