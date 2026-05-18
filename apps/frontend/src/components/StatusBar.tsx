import { isTauri } from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

export function StatusBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.activeTabId);

  return (
    <footer
      className={cn(
        'flex h-6 shrink-0 items-center justify-between px-3.5',
        'border-t border-border-hairline bg-bg-chrome/60 backdrop-blur-md',
        'font-display text-[10.5px] tracking-tight text-fg-muted',
      )}
    >
      <div className="flex items-center gap-3.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'h-[6px] w-[6px] rounded-full',
              isTauri
                ? 'bg-status-ok shadow-[0_0_8px_rgba(48,209,88,0.7)]'
                : 'bg-status-warn shadow-[0_0_8px_rgba(255,159,10,0.6)]',
            )}
          />
          <span className={isTauri ? 'text-fg-base/85' : 'text-status-warn'}>
            {isTauri ? 'connected' : 'web preview'}
          </span>
        </div>
        <span className="text-fg-subtle">·</span>
        <span className="font-mono text-[10px] text-fg-subtle">arc 0.0.1</span>
      </div>

      <div className="flex items-center gap-3.5">
        <span className="tabular-nums">
          {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
        </span>
        <span className="text-fg-subtle">·</span>
        <span className="max-w-[220px] truncate font-mono text-[10px] text-fg-subtle">
          {active ?? '—'}
        </span>
      </div>
    </footer>
  );
}
