import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, GitBranch, Scissors, Search, X } from 'lucide-react';
import {
  gitBranches,
  gitCheckout,
  gitCherryPick,
  isTauri,
  type GitBranchInfo,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGitUi } from '../../state/gitUi';
import { cn } from '../../lib/cn';

/**
 * Cherry-pick across branches. Opens with a target commit pre-selected via
 * `useGitUi.openCherryPick(...)`. User picks a target branch; on confirm we
 * `git checkout <branch>` then `git cherry-pick <oid>`. Conflicts surface
 * the stderr text — resolution then happens in the existing diff/conflict UI.
 */
export function CherryPickDialog() {
  const target = useGitUi((s) => s.cherryPickTarget);
  const close = useGitUi((s) => s.closeCherryPick);
  const root = useFiles((s) => s.root);

  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Load branches on open.
  useEffect(() => {
    if (!target || !root || !isTauri) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setFilter('');
    setPick(null);
    gitBranches(root)
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        // Auto-select the first non-current local branch as a sensible
        // default — the typical cherry-pick target is "something else."
        const local = list.find((b) => !b.remote && !b.current);
        setPick(local?.name ?? null);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target, root]);

  // Focus the filter once the dialog is on screen.
  useEffect(() => {
    if (target) requestAnimationFrame(() => filterRef.current?.focus());
  }, [target]);

  // Esc closes.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target, close, running]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = branches.filter((b) => !b.remote);
    if (!q) return all;
    return all.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, filter]);

  const submit = async () => {
    if (!target || !root || !pick) return;
    setRunning(true);
    setErr(null);
    try {
      // Refuse to checkout away from the current branch when the user
      // is already on the target — that's a no-op checkout and the
      // cherry-pick would behave like the existing on-HEAD action.
      const current = branches.find((b) => b.current);
      if (!current || current.name !== pick) {
        await gitCheckout(root, pick);
      }
      await gitCherryPick(root, target.oid);
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (!target) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => !running && close()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[12vh] flex w-[520px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
          <div className="flex items-center gap-2 font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
            <Scissors size={12} strokeWidth={2.1} className="text-fg-muted" />
            Cherry-pick to branch
          </div>
          <button
            onClick={() => !running && close()}
            disabled={running}
            title="Close (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base disabled:opacity-50"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>

        <div className="border-b border-border-hairline px-4 py-2">
          <div className="font-display text-[10.5px] uppercase tracking-wider text-fg-subtle">
            commit
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] text-fg-base">
              {target.shortOid}
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-[12px] text-fg-base/90">
              {target.subject}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-border-hairline px-4 py-2">
          <Search size={11} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter branches…"
            className="flex-1 bg-transparent font-display text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="max-h-[40vh] overflow-y-auto py-1">
          {loading && (
            <div className="px-4 py-4 text-center font-display text-[11.5px] italic text-fg-subtle">
              loading branches…
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div className="px-4 py-4 text-center font-display text-[11.5px] italic text-fg-subtle">
              {filter ? `no branches match "${filter}"` : 'no local branches found'}
            </div>
          )}
          {visible.map((b) => (
            <button
              key={b.name}
              onClick={() => setPick(b.name)}
              className={cn(
                'flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors',
                pick === b.name
                  ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
                  : 'hover:bg-white/[0.045]',
              )}
            >
              <GitBranch
                size={11}
                strokeWidth={2.1}
                className={cn('shrink-0', b.current ? 'text-accent' : 'text-fg-muted')}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-base/90">
                {b.name}
              </span>
              {b.current && (
                <span className="rounded bg-accent-soft px-1 font-mono text-[9.5px] text-accent">
                  current
                </span>
              )}
              {b.upstream && (
                <span className="font-mono text-[10px] text-fg-subtle">→ {b.upstream}</span>
              )}
            </button>
          ))}
        </div>

        {err && (
          <div className="border-t border-border-hairline bg-red-500/[0.06] px-4 py-2 font-mono text-[11px] text-red-300">
            {err}
            <div className="mt-1 text-[10px] text-red-300/70">
              On conflict, resolve it in the side-by-side diff view, then run{' '}
              <span className="font-mono">git cherry-pick --continue</span> in a terminal.
            </div>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/30 px-4 py-2">
          <div className="font-display text-[10.5px] text-fg-subtle">
            checkout target → cherry-pick → stay on target
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => !running && close()}
              disabled={running}
              className="rounded px-2.5 py-1 font-display text-[11px] text-fg-muted hover:bg-white/[0.05] hover:text-fg-base disabled:opacity-50"
            >
              cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={running || !pick}
              className="flex items-center gap-1.5 rounded bg-accent-soft px-3 py-1 font-display text-[11px] font-medium text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-50"
            >
              {running ? 'picking…' : 'cherry-pick'}
              <ArrowRight size={10} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
