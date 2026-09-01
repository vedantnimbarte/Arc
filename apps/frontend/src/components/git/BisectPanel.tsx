import { useEffect, useState } from 'react';
import {
  Check,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  SkipForward,
  Target,
  X,
} from 'lucide-react';
import {
  gitBisectMark,
  gitBisectReset,
  gitBisectStart,
  gitBisectStatus,
  isTauri,
  type GitBisectStatus,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGit } from '../../state/git';
import { useGitUi } from '../../state/gitUi';
import { askConfirm } from '../../state/confirm';
import { toast } from '../../state/toast';
import { PanelShell } from './PanelShell';
import { cn } from '../../lib/cn';

/**
 * Bisect — binary-search history for the commit that broke something.
 *
 * The panel deliberately shows git's own output verbatim after each mark
 * rather than a rephrased summary. git already prints exactly what you need
 * ("Bisecting: 12 revisions left to test after this (roughly 4 steps)"), and
 * re-deriving those numbers would mean re-implementing the search to be
 * subtly wrong about merges and skipped commits.
 *
 * Marking a commit checks out a different one, so every verdict refreshes the
 * source control panel behind this one.
 */
export function BisectPanel({ inline = false }: { inline?: boolean }) {
  const open = useGitUi((s) => s.bisectPanelOpen);
  const onClose = useGitUi((s) => s.setBisectPanelOpen);
  const setExpanded = useGitUi((s) => s.setBisectExpanded);
  const root = useFiles((s) => s.root);
  const refreshChanges = useGit((s) => s.refresh);

  const [status, setStatus] = useState<GitBisectStatus | null>(null);
  const [message, setMessage] = useState<string>('');
  const [bad, setBad] = useState('');
  const [good, setGood] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    if (!root || !isTauri) {
      setStatus(null);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      setStatus(await gitBisectStatus(root));
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

  /** Run a bisect step, then re-read status and refresh source control —
   *  every step moves HEAD to a different commit. */
  const step = async (fn: () => Promise<string>) => {
    if (!root) return;
    setLoading(true);
    setErr(null);
    try {
      setMessage(await fn());
      setStatus(await gitBisectStatus(root));
      await refreshChanges(root);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const start = () =>
    step(() => gitBisectStart(root!, bad.trim() || undefined, good.trim() || undefined));

  const stop = async () => {
    if (!root) return;
    const ok = await askConfirm({
      title: 'End the bisect?',
      body: 'Puts HEAD back where it was before the bisect started and forgets every mark.',
      confirmLabel: 'Reset',
      destructive: true,
    });
    if (!ok) return;
    try {
      await gitBisectReset(root);
      setMessage('');
      setStatus(await gitBisectStatus(root));
      await refreshChanges(root);
      toast('Bisect ended');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) return null;

  const active = status?.active ?? false;
  const converged = !!status?.first_bad;

  return (
    <PanelShell inline={inline} width="620px" onClose={() => onClose(false)}>
      <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
          <Target size={12} strokeWidth={2.1} className="text-fg-muted" />
          Bisect
          {active && status && status.marks.length > 0 && (
            <span className="font-mono text-2xs font-normal text-fg-subtle">
              · {status.marks.length} marked
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
            {inline ? (
              <Maximize2 size={11} strokeWidth={2.1} />
            ) : (
              <Minimize2 size={11} strokeWidth={2.1} />
            )}
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
        <div className={cn('overflow-y-auto', inline ? 'min-h-0 flex-1' : 'max-h-[60vh]')}>
          {err && (
            <div className="border-b border-border-hairline bg-red-500/[0.06] px-4 py-2 font-mono text-xs text-red-300">
              {err}
            </div>
          )}

          {/* ── Not bisecting: pick the endpoints ───────────────────────── */}
          {!active && (
            <div className="px-4 py-3">
              <p className="mb-3 font-display text-xs leading-relaxed text-fg-muted">
                Binary-search history for the commit that introduced a bug. Name a commit where it
                is broken and one where it worked; git checks out the midpoint and you mark each
                one until it names the culprit.
              </p>
              <div className="mb-2 flex items-center gap-2">
                <label className="w-12 shrink-0 font-mono text-2xs text-fg-subtle">bad</label>
                <input
                  value={bad}
                  onChange={(e) => setBad(e.target.value)}
                  placeholder="HEAD"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded border border-border-hairline bg-surface-1 px-2 py-1 font-mono text-xs text-fg-base outline-none focus:border-accent/50"
                />
              </div>
              <div className="mb-3 flex items-center gap-2">
                <label className="w-12 shrink-0 font-mono text-2xs text-fg-subtle">good</label>
                <input
                  value={good}
                  onChange={(e) => setGood(e.target.value)}
                  placeholder="a tag, branch or sha where it worked"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded border border-border-hairline bg-surface-1 px-2 py-1 font-mono text-xs text-fg-base outline-none focus:border-accent/50"
                />
              </div>
              <p className="mb-3 font-display text-2xs italic text-fg-subtle">
                Leave both blank to start an open bisect and mark commits as you go.
              </p>
              <button
                onClick={() => void start()}
                disabled={loading}
                className="flex items-center gap-1.5 rounded border border-border-hairline bg-surface-1 px-2.5 py-1 font-display text-xs text-fg-base transition hover:bg-surface-2 disabled:opacity-40"
              >
                <Play size={11} strokeWidth={2.1} />
                Start bisect
              </button>
            </div>
          )}

          {/* ── Bisecting: the commit under test + the three verdicts ───── */}
          {active && status && (
            <>
              <div className="border-b border-border-hairline px-4 py-3">
                <div className="mb-1 font-mono text-2xs uppercase tracking-wider text-fg-subtle">
                  {converged ? 'first bad commit' : 'testing'}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-accent/90">{status.head_short}</span>
                  <span className="min-w-0 flex-1 truncate font-display text-xs text-fg-base/90">
                    {status.subject}
                  </span>
                </div>
              </div>

              {!converged && (
                <div className="flex items-center gap-1.5 border-b border-border-hairline px-4 py-2.5">
                  <Verdict
                    label="Good"
                    hint="This commit works — the bug came later"
                    Icon={Check}
                    tone="ok"
                    disabled={loading}
                    onClick={() => void step(() => gitBisectMark(root, 'good'))}
                  />
                  <Verdict
                    label="Bad"
                    hint="This commit is broken"
                    Icon={X}
                    tone="bad"
                    disabled={loading}
                    onClick={() => void step(() => gitBisectMark(root, 'bad'))}
                  />
                  <Verdict
                    label="Skip"
                    hint="Can't test this one — try a neighbour"
                    Icon={SkipForward}
                    tone="muted"
                    disabled={loading}
                    onClick={() => void step(() => gitBisectMark(root, 'skip'))}
                  />
                  <span className="flex-1" />
                  <button
                    onClick={() => void stop()}
                    className="rounded px-2 py-1 font-display text-2xs text-fg-subtle transition hover:bg-surface-2 hover:text-fg-base"
                  >
                    End bisect
                  </button>
                </div>
              )}

              {converged && (
                <div className="flex items-center gap-2 border-b border-border-hairline bg-status-ok/[0.06] px-4 py-2.5">
                  <span className="font-display text-xs text-fg-base/90">
                    Found it — {status.first_bad?.slice(0, 7)} is the first bad commit.
                  </span>
                  <span className="flex-1" />
                  <button
                    onClick={() => void stop()}
                    className="rounded border border-border-hairline px-2 py-1 font-display text-2xs text-fg-base transition hover:bg-surface-2"
                  >
                    End bisect
                  </button>
                </div>
              )}

              {/* git's own words about where the search stands. */}
              {message && (
                <pre className="whitespace-pre-wrap border-b border-border-hairline px-4 py-2 font-mono text-2xs leading-relaxed text-fg-muted">
                  {message}
                </pre>
              )}

              {status.marks.length > 0 && (
                <div className="px-4 py-2">
                  <div className="mb-1 font-mono text-2xs uppercase tracking-wider text-fg-subtle">
                    marks
                  </div>
                  {status.marks.map((m, i) => (
                    <div key={`${m.oid}-${i}`} className="flex items-center gap-2 py-0.5">
                      <span
                        className={cn(
                          'w-10 shrink-0 font-mono text-2xs',
                          m.term === 'good'
                            ? 'text-status-ok'
                            : m.term === 'bad'
                              ? 'text-red-300'
                              : 'text-fg-subtle',
                        )}
                      >
                        {m.term}
                      </span>
                      <span className="font-mono text-2xs text-fg-muted">{m.short}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </PanelShell>
  );
}

function Verdict({
  label,
  hint,
  Icon,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  Icon: typeof Check;
  tone: 'ok' | 'bad' | 'muted';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-label={`${label} — ${hint}`}
      className={cn(
        'flex items-center gap-1.5 rounded border px-2.5 py-1 font-display text-xs transition disabled:opacity-40',
        tone === 'ok' && 'border-status-ok/30 text-status-ok hover:bg-status-ok/10',
        tone === 'bad' && 'border-red-500/30 text-red-300 hover:bg-red-500/10',
        tone === 'muted' && 'border-border-hairline text-fg-muted hover:bg-surface-2',
      )}
    >
      <Icon size={11} strokeWidth={2.2} />
      {label}
    </button>
  );
}
