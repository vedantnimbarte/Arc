import { isTauri } from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

export function StatusBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.activeTabId);

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-border-subtle px-4 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-1.5 w-1.5 animate-pulse-soft rounded-full',
              isTauri
                ? 'bg-status-ok shadow-[0_0_10px_rgb(134_208_153_/_0.7)]'
                : 'bg-status-warn shadow-[0_0_10px_rgb(245_169_127_/_0.5)]',
            )}
          />
          <span className={isTauri ? 'text-fg-muted' : 'text-status-warn'}>
            {isTauri ? 'tauri' : 'web-only'}
          </span>
        </div>
        <span className="text-fg-subtle/70">arc · v0.0.1</span>
      </div>

      <div className="flex items-center gap-4">
        <span>
          {tabs.length} tab{tabs.length === 1 ? '' : 's'}
        </span>
        <span className="max-w-[200px] truncate normal-case tracking-normal text-fg-muted">
          {active ?? '—'}
        </span>
      </div>
    </footer>
  );
}
