import { useEffect, useState } from 'react';
import {
  FolderTree,
  GitBranch,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  fsPickFolder,
  gitWorktreeAdd,
  gitWorktreeList,
  gitWorktreeRemove,
  isTauri,
  type GitWorktreeEntry,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGitUi } from '../../state/gitUi';
import { cn } from '../../lib/cn';

/**
 * Worktree manager — lists `git worktree list` output for the active
 * repository and supports add / remove. The dialog opens from the status
 * bar's worktree button and from the ⌘K palette.
 */
export function WorktreePanel() {
  const open = useGitUi((s) => s.worktreePanelOpen);
  const onClose = useGitUi((s) => s.setWorktreePanelOpen);
  const root = useFiles((s) => s.root);

  const [entries, setEntries] = useState<GitWorktreeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    if (!root || !isTauri) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const list = await gitWorktreeList(root);
      setEntries(list);
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

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => onClose(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[10vh] flex w-[640px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center justify-between border-b border-border-hairline px-4 py-2.5">
          <div className="flex items-center gap-2 font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
            <FolderTree size={12} strokeWidth={2.1} className="text-fg-muted" />
            Worktrees
            {entries.length > 0 && (
              <span className="font-mono text-[10px] font-normal text-fg-subtle">
                · {entries.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refresh()}
              disabled={loading}
              title="Refresh"
              className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base disabled:opacity-35"
            >
              <RefreshCw size={11} strokeWidth={2.1} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => onClose(false)}
              title="Close (esc)"
              className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base"
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        {!root && (
          <div className="px-4 py-6 text-center font-display text-[11.5px] italic text-fg-subtle">
            open a workspace folder first — worktrees attach to a repository.
          </div>
        )}

        {root && (
          <>
            {err && (
              <div className="border-b border-border-hairline bg-red-500/[0.06] px-4 py-2 font-mono text-[11px] text-red-300">
                {err}
              </div>
            )}

            <div className="max-h-[55vh] overflow-y-auto">
              {entries.length === 0 && !loading && !err && (
                <div className="px-4 py-6 text-center font-display text-[11.5px] italic text-fg-subtle">
                  no worktrees — this directory isn&rsquo;t a git repository,
                  or git isn&rsquo;t on PATH.
                </div>
              )}
              {entries.map((w) => (
                <WorktreeRow key={w.path} worktree={w} repoRoot={root} onAfter={() => void refresh()} />
              ))}
            </div>

            {creating ? (
              <AddWorktreeForm
                repoRoot={root}
                onCancel={() => setCreating(false)}
                onDone={() => {
                  setCreating(false);
                  void refresh();
                }}
              />
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex items-center justify-center gap-1.5 border-t border-border-hairline bg-bg-base/30 py-2 font-display text-[11.5px] font-medium text-fg-muted transition-colors hover:bg-accent-soft hover:text-fg-base"
              >
                <Plus size={11} strokeWidth={2.2} />
                Add worktree
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WorktreeRow({
  worktree,
  repoRoot,
  onAfter,
}: {
  worktree: GitWorktreeEntry;
  repoRoot: string;
  onAfter: () => void;
}) {
  const setRoot = useFiles((s) => s.setRoot);
  const setWorktreePanelOpen = useGitUi((s) => s.setWorktreePanelOpen);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const switchTo = () => {
    setRoot(worktree.path);
    setWorktreePanelOpen(false);
  };

  const remove = async (force: boolean) => {
    setRemoving(true);
    setErr(null);
    try {
      await gitWorktreeRemove(repoRoot, worktree.path, force);
      onAfter();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
    } finally {
      setRemoving(false);
      setConfirming(false);
    }
  };

  const isCurrent = worktree.path === repoRoot;

  return (
    <div
      className={cn(
        'border-b border-border-hairline/60 px-4 py-2 last:border-b-0',
        isCurrent && 'bg-accent-soft/40',
      )}
    >
      <div className="flex items-start gap-2.5">
        <GitBranch
          size={11}
          strokeWidth={2.1}
          className={cn('mt-0.5 shrink-0', isCurrent ? 'text-accent' : 'text-fg-muted')}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-display text-[12px] font-medium tracking-tight text-fg-base">
              {worktree.branch ?? <span className="italic text-fg-muted">detached</span>}
            </span>
            {worktree.head_short && (
              <span className="font-mono text-[10px] text-fg-subtle">{worktree.head_short}</span>
            )}
            {worktree.is_main && (
              <span className="rounded bg-bg-hover px-1 font-mono text-[9.5px] text-fg-muted">main</span>
            )}
            {worktree.locked && (
              <Lock size={9} strokeWidth={2.4} className="text-amber-300" />
            )}
            {worktree.prunable && (
              <span className="rounded bg-amber-500/[0.18] px-1 font-mono text-[9.5px] text-amber-300">
                prunable
              </span>
            )}
            {isCurrent && (
              <span className="rounded bg-accent-soft px-1 font-mono text-[9.5px] text-accent">
                active
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-subtle">{worktree.path}</div>
          {err && <div className="mt-1 font-mono text-[10.5px] text-red-300">{err}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!isCurrent && (
            <button
              onClick={switchTo}
              className="rounded px-1.5 py-0.5 font-display text-[10.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
            >
              switch
            </button>
          )}
          {!worktree.is_main && (
            <>
              {confirming ? (
                <div className="flex items-center gap-1 rounded bg-red-500/[0.12] px-1.5 py-0.5">
                  <button
                    onClick={() => void remove(false)}
                    disabled={removing}
                    className="font-display text-[10.5px] text-red-300 hover:text-red-200 disabled:opacity-50"
                  >
                    remove
                  </button>
                  <button
                    onClick={() => void remove(true)}
                    disabled={removing}
                    className="font-display text-[10.5px] text-red-300/80 hover:text-red-200 disabled:opacity-50"
                    title="Remove even if dirty"
                  >
                    force
                  </button>
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={removing}
                    className="font-display text-[10.5px] text-fg-subtle hover:text-fg-base disabled:opacity-50"
                  >
                    cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  title="Remove worktree"
                  className="rounded p-1 text-fg-subtle transition-colors hover:bg-red-500/[0.12] hover:text-red-300"
                >
                  <Trash2 size={11} strokeWidth={2.1} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AddWorktreeForm({
  repoRoot,
  onCancel,
  onDone,
}: {
  repoRoot: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [newPath, setNewPath] = useState('');
  const [branch, setBranch] = useState('');
  const [createBranch, setCreateBranch] = useState(true);
  const [startPoint, setStartPoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickPath = async () => {
    const picked = await fsPickFolder(repoRoot).catch(() => null);
    if (picked) setNewPath(picked);
  };

  const submit = async () => {
    if (!newPath.trim()) {
      setErr('Pick a directory for the new worktree.');
      return;
    }
    if (createBranch && !branch.trim()) {
      setErr('Provide a name for the new branch.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await gitWorktreeAdd(
        repoRoot,
        newPath.trim(),
        branch.trim() || null,
        createBranch,
        startPoint.trim() || null,
      );
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border-hairline bg-bg-base/30 p-3">
      <div className="flex items-center gap-2 font-display text-[11px] font-semibold tracking-tight text-fg-base">
        <Plus size={11} strokeWidth={2.2} className="text-fg-muted" />
        Add worktree
      </div>

      <FieldRow label="Path">
        <input
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder="/path/to/new/worktree"
          className="flex-1 rounded border border-border-subtle bg-bg-base/60 px-2 py-1 font-mono text-[11px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          spellCheck={false}
        />
        <button
          onClick={() => void pickPath()}
          className="rounded border border-border-subtle px-2 py-1 font-display text-[11px] text-fg-muted hover:border-border-strong hover:text-fg-base"
        >
          browse…
        </button>
      </FieldRow>

      <FieldRow label="Branch">
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder={createBranch ? 'new-branch-name' : 'existing-branch-or-ref'}
          className="flex-1 rounded border border-border-subtle bg-bg-base/60 px-2 py-1 font-mono text-[11px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          spellCheck={false}
        />
      </FieldRow>

      <label className="ml-[88px] flex items-center gap-1.5 font-display text-[11px] text-fg-muted">
        <input
          type="checkbox"
          checked={createBranch}
          onChange={(e) => setCreateBranch(e.target.checked)}
          className="accent-accent"
        />
        Create a new branch
      </label>

      {createBranch && (
        <FieldRow label="From">
          <input
            value={startPoint}
            onChange={(e) => setStartPoint(e.target.value)}
            placeholder="HEAD (default)"
            className="flex-1 rounded border border-border-subtle bg-bg-base/60 px-2 py-1 font-mono text-[11px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
            spellCheck={false}
          />
        </FieldRow>
      )}

      {err && <div className="ml-[88px] font-mono text-[10.5px] text-red-300">{err}</div>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded px-2.5 py-1 font-display text-[11px] text-fg-muted hover:bg-white/[0.05] hover:text-fg-base disabled:opacity-50"
        >
          cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded bg-accent-soft px-3 py-1 font-display text-[11px] font-medium text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? 'creating…' : 'create'}
        </button>
      </div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[80px] shrink-0 text-right font-display text-[11px] text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}
