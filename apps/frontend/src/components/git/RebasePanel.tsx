import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  GitCommitHorizontal,
  ListOrdered,
  Maximize2,
  Pause,
  Pencil,
  Minimize2,
  Minus,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  gitLog,
  gitRebaseAbort,
  gitRebaseInteractive,
  isTauri,
  type GitLogEntry,
  type GitRebaseAction,
  type GitRebaseTodoEntry,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGitUi } from '../../state/gitUi';
import { PanelShell } from './PanelShell';
import { cn } from '../../lib/cn';

/**
 * Interactive rebase UI. Picks the last N commits from HEAD, lets the user
 * reorder + change action per row (pick / drop / squash / fixup), then runs
 * `git rebase -i <base>` via a pre-built TODO file. The Rust side wires
 * GIT_SEQUENCE_EDITOR to a helper script and GIT_EDITOR to a no-op so the
 * rebase never opens a real editor.
 *
 * `reword` types the new message here and rides along as an `exec git commit
 * --amend`, so the rebase still never opens an editor. `edit` is the one
 * action that stops mid-flight: git halts at that commit and the source
 * control panel's "rebase in progress" bar drives continue / abort.
 */
export function RebasePanel({ inline = false }: { inline?: boolean }) {
  const open = useGitUi((s) => s.rebasePanelOpen);
  const onClose = useGitUi((s) => s.setRebasePanelOpen);
  const setExpanded = useGitUi((s) => s.setRebaseExpanded);
  const root = useFiles((s) => s.root);

  const [count, setCount] = useState(10);
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [actions, setActions] = useState<Record<string, GitRebaseAction>>({});
  // Reworded messages, keyed by oid. Seeded from the commit subject the
  // first time a row switches to `reword`.
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<string[]>([]); // oids in display order
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Load the last `count` commits whenever the panel opens or count changes.
  useEffect(() => {
    if (!open || !root || !isTauri) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void gitLog(root, count)
      .then((list) => {
        if (cancelled) return;
        // gitLog returns newest-first. The rebase TODO is oldest-first
        // (matches what `git rebase -i` writes into the editor), so we
        // reverse here and keep that order as the source of truth.
        const ordered = [...list].reverse();
        setCommits(ordered);
        setOrder(ordered.map((c) => c.oid));
        setActions(Object.fromEntries(ordered.map((c) => [c.oid, 'pick' as GitRebaseAction])));
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
  }, [open, root, count]);

  // Esc closes (unless mid-rebase, since aborting needs an explicit click).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, running]);

  // Base for `git rebase -i <base>` is the parent of the OLDEST included
  // commit. We use `<oldest_oid>^` which git interprets as that parent.
  const base = useMemo(() => {
    if (order.length === 0) return null;
    const oldest = order[0];
    return oldest ? `${oldest}^` : null;
  }, [order]);

  const commitMap = useMemo(() => new Map(commits.map((c) => [c.oid, c])), [commits]);

  const setAction = (oid: string, a: GitRebaseAction) => setActions((s) => ({ ...s, [oid]: a }));

  const move = (oid: string, delta: -1 | 1) => {
    setOrder((s) => {
      const idx = s.indexOf(oid);
      if (idx < 0) return s;
      const next = idx + delta;
      if (next < 0 || next >= s.length) return s;
      const out = [...s];
      [out[idx], out[next]] = [out[next]!, out[idx]!];
      return out;
    });
  };

  const submit = async () => {
    if (!root || !base) return;
    // Skip commits the user dropped: the rebase TODO list expresses drop
    // as a `drop` keyword on the row, so we keep them — just emit a TODO
    // entry per visible row.
    const entries: GitRebaseTodoEntry[] = order.map((oid) => {
      const action = actions[oid] ?? 'pick';
      return {
        oid,
        action,
        message: action === 'reword' ? (messages[oid] ?? '').trim() : null,
      };
    });
    const blankReword = entries.find((e) => e.action === 'reword' && !e.message);
    if (blankReword) {
      setErr('A reworded commit needs a message.');
      return;
    }
    // git refuses `fixup` or `squash` as the first row — there's nothing
    // for them to fold into. Surface that early so the rebase doesn't
    // start and leave the repo mid-flight.
    const first = entries[0];
    if (first && (first.action === 'squash' || first.action === 'fixup')) {
      setErr(`The first commit can't be "${first.action}" — it has nothing to fold into.`);
      return;
    }
    setRunning(true);
    setErr(null);
    try {
      await gitRebaseInteractive(root, base, entries);
      onClose(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const abort = async () => {
    if (!root) return;
    try {
      await gitRebaseAbort(root);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!open) return null;

  const dropCount = Object.values(actions).filter((a) => a === 'drop').length;
  const keepCount = order.length - dropCount;

  return (
    <PanelShell inline={inline} width="720px" onClose={() => !running && onClose(false)}>
      <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
        <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
          <ListOrdered size={12} strokeWidth={2.1} className="text-fg-muted" />
          Interactive rebase
          <span className="font-mono text-2xs font-normal text-fg-subtle">
            · last {order.length} {order.length === 1 ? 'commit' : 'commits'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 font-display text-xs text-fg-muted">
            count
            <input
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              className="w-12 rounded border border-border-subtle bg-bg-base/60 px-1 py-0.5 text-center font-mono text-xs text-fg-base focus:border-accent/45 focus:outline-none"
            />
          </label>
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
            onClick={() => !running && onClose(false)}
            disabled={running}
            title="Close (esc)"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-50"
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
          <div className="border-b border-border-hairline bg-bg-base/30 px-4 py-1.5 font-display text-2xs text-fg-subtle">
            Order is oldest-first (top), matching git&rsquo;s rebase TODO. Squash and fixup
            fold into the row above; reword takes a new message here; edit stops the rebase
            at that commit for you to continue from the panel.
          </div>

          <div className={cn('overflow-y-auto', inline ? 'min-h-0 flex-1' : 'max-h-[55vh]')}>
            {loading && (
              <div className="px-4 py-6 text-center font-display text-xs italic text-fg-subtle">
                loading commits…
              </div>
            )}
            {!loading &&
              order.map((oid, idx) => {
                const commit = commitMap.get(oid);
                if (!commit) return null;
                const action = actions[oid] ?? 'pick';
                return (
                  <RebaseRow
                    key={oid}
                    commit={commit}
                    action={action}
                    message={messages[oid] ?? ''}
                    onMessage={(m) => setMessages((s) => ({ ...s, [oid]: m }))}
                    onAction={(a) => setAction(oid, a)}
                    onUp={() => move(oid, -1)}
                    onDown={() => move(oid, 1)}
                    isFirst={idx === 0}
                    isLast={idx === order.length - 1}
                  />
                );
              })}
          </div>

          {err && (
            <div className="border-t border-border-hairline bg-red-500/[0.06] px-4 py-2 font-mono text-xs text-red-300">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={11} strokeWidth={2.2} className="mt-0.5 shrink-0" />
                <div className="flex-1">
                  {err}
                  <div className="mt-1 text-2xs text-red-300/70">
                    If the rebase stopped mid-way for conflicts, resolve them in the diff view, then
                    click &ldquo;continue&rdquo; or &ldquo;abort&rdquo;.
                  </div>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void abort()}
                  className="rounded bg-red-500/[0.18] px-2.5 py-1 font-display text-xs text-red-200 hover:bg-red-500/[0.28]"
                >
                  abort rebase
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/30 px-4 py-2">
            <div className="font-display text-2xs text-fg-subtle">
              {keepCount} commits kept · {dropCount} dropped
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => !running && onClose(false)}
                disabled={running}
                className="rounded px-2.5 py-1 font-display text-xs text-fg-muted hover:bg-surface-1 hover:text-fg-base disabled:opacity-50"
              >
                cancel
              </button>
              <button
                onClick={() => void submit()}
                disabled={running || order.length === 0 || !base}
                className="rounded bg-accent-soft px-3 py-1 font-display text-xs font-medium text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-50"
              >
                {running ? 'rebasing…' : 'start rebase'}
              </button>
            </div>
          </div>
        </>
      )}
    </PanelShell>
  );
}

function RebaseRow({
  commit,
  action,
  message,
  onMessage,
  onAction,
  onUp,
  onDown,
  isFirst,
  isLast,
}: {
  commit: GitLogEntry;
  action: GitRebaseAction;
  message: string;
  onMessage: (m: string) => void;
  onAction: (a: GitRebaseAction) => void;
  onUp: () => void;
  onDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const dropped = action === 'drop';
  return (
    <div className="border-b border-border-hairline/60 last:border-b-0">
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-1.5',
        dropped && 'opacity-50',
      )}
    >
      <div className="flex shrink-0 flex-col">
        <button
          onClick={onUp}
          disabled={isFirst}
          title="Move up (newer in history)"
          className="rounded p-0.5 text-fg-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-fg-base disabled:opacity-30"
        >
          <ArrowUp size={9} strokeWidth={2.4} />
        </button>
        <button
          onClick={onDown}
          disabled={isLast}
          title="Move down (older in history)"
          className="rounded p-0.5 text-fg-subtle transition-colors enabled:hover:bg-surface-2 enabled:hover:text-fg-base disabled:opacity-30"
        >
          <ArrowDown size={9} strokeWidth={2.4} />
        </button>
      </div>

      <ActionPicker value={action} onChange={onAction} />

      <span className="shrink-0 rounded bg-surface-1 px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
        {commit.short}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-display text-sm',
          dropped ? 'text-fg-subtle line-through' : 'text-fg-base/90',
        )}
      >
        {commit.subject || <span className="italic text-fg-subtle">(no subject)</span>}
      </span>
      <span
        className="shrink-0 truncate font-display text-2xs text-fg-subtle"
        style={{ maxWidth: 100 }}
      >
        {commit.author}
      </span>
    </div>
    {action === 'reword' && (
      <div className="px-4 pb-1.5 pl-[52px]">
        <input
          value={message}
          onChange={(e) => onMessage(e.target.value)}
          placeholder="new commit message"
          aria-label={`New message for ${commit.short}`}
          className={cn(
            'w-full rounded border border-border-subtle bg-bg-base/60 px-2 py-1',
            'font-display text-xs text-fg-base placeholder:text-fg-subtle',
            'focus:border-accent/45 focus:outline-none',
          )}
        />
      </div>
    )}
    {action === 'edit' && (
      <div className="px-4 pb-1.5 pl-[52px] font-display text-2xs text-fg-subtle">
        The rebase stops here — change what you like, then hit continue on the
        source control panel&rsquo;s rebase bar.
      </div>
    )}
    </div>
  );
}

const ACTIONS: { id: GitRebaseAction; label: string; icon: typeof Minus; hint: string }[] = [
  { id: 'pick', label: 'pick', icon: GitCommitHorizontal, hint: 'keep this commit as-is' },
  {
    id: 'squash',
    label: 'squash',
    icon: RotateCcw,
    hint: 'fold into the row above, keep both messages',
  },
  {
    id: 'fixup',
    label: 'fixup',
    icon: RotateCcw,
    hint: 'fold into the row above, drop this message',
  },
  {
    id: 'reword',
    label: 'reword',
    icon: Pencil,
    hint: 'keep the commit, replace its message',
  },
  {
    id: 'edit',
    label: 'edit',
    icon: Pause,
    hint: 'stop the rebase here so you can change the tree',
  },
  { id: 'drop', label: 'drop', icon: Minus, hint: 'remove this commit from history' },
];

function ActionPicker({
  value,
  onChange,
}: {
  value: GitRebaseAction;
  onChange: (a: GitRebaseAction) => void;
}) {
  return (
    <div className="flex shrink-0 gap-0.5 rounded bg-bg-base/40 p-0.5 ring-1 ring-border-subtle">
      {ACTIONS.map((a) => (
        <button
          key={a.id}
          onClick={() => onChange(a.id)}
          title={a.hint}
          className={cn(
            'rounded px-1.5 py-0.5 font-display text-2xs font-medium tracking-tight transition-colors',
            value === a.id
              ? 'bg-accent-soft text-fg-base ring-1 ring-accent/45'
              : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-base',
          )}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
