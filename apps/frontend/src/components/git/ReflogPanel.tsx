import { useEffect, useState } from 'react';
import { History, Maximize2, Minimize2, RefreshCw, RotateCcw, X } from 'lucide-react';
import { gitReflog, gitReset, isTauri, type GitReflogEntry } from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGit } from '../../state/git';
import { useGitUi } from '../../state/gitUi';
import { askConfirm } from '../../state/confirm';
import { toast } from '../../state/toast';
import { PanelShell } from './PanelShell';
import { cn } from '../../lib/cn';

/**
 * Reflog — every position HEAD has held, newest first. This is the undo net
 * behind reset, rebase and discard: a row's selector (`HEAD@{3}`) is a real
 * revision, so restoring is a hard reset back to it.
 */
export function ReflogPanel({ inline = false }: { inline?: boolean }) {
  const open = useGitUi((s) => s.reflogPanelOpen);
  const onClose = useGitUi((s) => s.setReflogPanelOpen);
  const setExpanded = useGitUi((s) => s.setReflogExpanded);
  const root = useFiles((s) => s.root);
  const refreshChanges = useGit((s) => s.refresh);

  const [entries, setEntries] = useState<GitReflogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    if (!root || !isTauri) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      setEntries(await gitReflog(root, 100));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, root]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const restore = async (entry: GitReflogEntry) => {
    if (!root) return;
    const ok = await askConfirm({
      title: `Reset to ${entry.selector}?`,
      body: `Moves HEAD to ${entry.head_short} and discards everything in the working tree that isn't committed.`,
      confirmLabel: 'Reset --hard',
      destructive: true,
    });
    if (!ok) return;
    try {
      await gitReset(root, entry.selector, 'hard');
      toast(`Reset to ${entry.head_short}`);
      await refreshChanges(root);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) return null;

  return (
    <PanelShell inline={inline} width="680px" onClose={() => onClose(false)}>
      <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
          <History size={12} strokeWidth={2.1} className="text-fg-muted" />
          Reflog
          {entries.length > 0 && (
            <span className="font-mono text-2xs font-normal text-fg-subtle">
              · {entries.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(inline)}
            title={inline ? 'Expand to a window' : 'Show in the source control panel'}
            aria-label={inline ? 'Expand to a window' : 'Show in the source control panel'}
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            {inline ? <Maximize2 size={11} strokeWidth={2.1} /> : <Minimize2 size={11} strokeWidth={2.1} />}
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-35"
          >
            <RefreshCw size={11} strokeWidth={2.1} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => onClose(false)}
            title="Close (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {!root && (
        <div className="px-4 py-6 text-center font-display text-xs italic text-fg-subtle">
          open a repository first
        </div>
      )}

      {root && (
        <>
          {err && (
            <div className="border-b border-border-hairline bg-red-500/[0.06] px-4 py-2 font-mono text-xs text-red-300">
              {err}
            </div>
          )}
          <div className={cn('overflow-y-auto', inline ? 'min-h-0 flex-1' : 'max-h-[55vh]')}>
            {entries.length === 0 && !loading && !err && (
              <div className="px-4 py-6 text-center font-display text-xs italic text-fg-subtle">
                no reflog entries — a fresh clone has nothing to undo yet.
              </div>
            )}
            {entries.map((e) => (
              <div
                key={e.selector}
                className="group flex items-center gap-2 border-b border-border-hairline/60 px-3 py-1.5 last:border-b-0 hover:bg-surface-1"
              >
                <span className="w-16 shrink-0 truncate font-mono text-2xs text-fg-subtle" title={e.selector}>
                  {e.selector.replace('HEAD@', '@')}
                </span>
                <span className="w-14 shrink-0 font-mono text-2xs text-accent/90">{e.head_short}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-xs text-fg-base/90" title={e.subject}>
                    {e.subject || e.action}
                  </span>
                  <span className="block truncate font-mono text-2xs text-fg-subtle">
                    {e.action}
                    {e.when && ` · ${e.when}`}
                  </span>
                </span>
                <button
                  onClick={() => void restore(e)}
                  title={`Reset --hard to ${e.selector}`}
                  aria-label={`Reset to ${e.selector}`}
                  className="hidden shrink-0 rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-red-300 group-hover:block"
                >
                  <RotateCcw size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </PanelShell>
  );
}
