import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { gitStatus, isTauri, type GitInfo } from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

export function StatusBar() {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.activeTabId);
  const root = useFiles((s) => s.root);

  const [git, setGit] = useState<GitInfo | null>(null);

  useEffect(() => {
    if (!isTauri || !root) {
      setGit(null);
      return;
    }
    let cancelled = false;
    void gitStatus(root)
      .then((info) => {
        if (!cancelled) setGit(info);
      })
      .catch(() => {
        if (!cancelled) setGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

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
                ? 'bg-status-ok shadow-[0_0_8px_rgba(58,210,138,0.7)]'
                : 'bg-status-warn shadow-[0_0_8px_rgba(240,169,88,0.6)]',
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
        {git?.branch && <BranchIndicator info={git} />}
        {git?.branch && <span className="text-fg-subtle">·</span>}
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

function BranchIndicator({ info }: { info: GitInfo }) {
  return (
    <div
      className="flex items-center gap-1.5 font-mono text-[10px]"
      title={
        info.upstream
          ? `${info.branch} → ${info.upstream}${info.ahead || info.behind ? ` (+${info.ahead}/-${info.behind})` : ''}${info.dirty ? ' · dirty' : ''}`
          : `${info.branch}${info.dirty ? ' · dirty' : ''}`
      }
    >
      <GitBranch
        size={10}
        strokeWidth={2}
        className={info.dirty ? 'text-accent-bright' : 'text-fg-subtle'}
      />
      <span className={info.dirty ? 'text-fg-base/90' : 'text-fg-muted'}>{info.branch}</span>
      {info.dirty && (
        <span
          className="h-[5px] w-[5px] rounded-full bg-accent-bright shadow-[0_0_6px_rgba(220,224,232,0.55)]"
          aria-label="dirty"
        />
      )}
      {info.ahead > 0 && (
        <span className="tabular-nums text-fg-subtle">↑{info.ahead}</span>
      )}
      {info.behind > 0 && (
        <span className="tabular-nums text-fg-subtle">↓{info.behind}</span>
      )}
    </div>
  );
}
