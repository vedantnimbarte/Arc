import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, FolderTree, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import {
  agentWorktreeDiscard,
  isTauri,
  sessionAgentRunsList,
  type AgentRunRecord,
  type AgentRunStatus,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

const STATUS_DOT: Record<AgentRunStatus, string> = {
  running: 'bg-accent-bright animate-pulse-soft motion-reduce:animate-none',
  completed: 'bg-status-ok',
  failed: 'bg-status-err',
  paused: 'bg-status-warn',
  idle: 'bg-fg-muted/60',
};

/** Title-case a persona id like "task-planner" → "Task Planner". */
function agentLabel(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function duration(run: AgentRunRecord): string | null {
  if (run.finished_at == null) return null;
  const ms = run.finished_at - run.started_at;
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/**
 * Lists persisted agent runs (newest first) via session_agent_runs_list. While
 * a run is still running the list polls so its status flips live; otherwise it
 * refreshes on mount + on demand. Clicking a row reveals its summary.
 */
export function AgentsView() {
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const reqId = useRef(0);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    const id = ++reqId.current;
    setLoading(true);
    try {
      const list = await sessionAgentRunsList();
      if (id === reqId.current) setRuns(list);
    } catch {
      if (id === reqId.current) setRuns([]);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while anything is still running so its status/duration settle live.
  const hasRunning = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunning || !isTauri) return;
    const handle = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(handle);
  }, [hasRunning, refresh]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-hairline px-2.5">
        <span className="min-w-0 flex-1 truncate font-display text-[12px] font-medium tracking-tight text-fg-base/90">
          Agent Runs
        </span>
        {runs.length > 0 && (
          <span className="shrink-0 rounded-full bg-white/[0.05] px-1.5 font-mono text-[9.5px] tabular-nums text-fg-muted">
            {runs.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={!isTauri || loading}
          aria-label="Refresh agent runs"
          title="Refresh"
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-all duration-150 ease-apple',
            'hover:bg-white/[0.08] hover:text-fg-base active:scale-[0.92]',
            'disabled:opacity-40 disabled:hover:bg-transparent',
          )}
        >
          <RefreshCw size={12} strokeWidth={2.1} className={loading ? 'animate-spin-slow' : ''} />
        </button>
      </div>

      {/* List */}
      <div className="selectable flex-1 overflow-auto px-1.5 py-1.5">
        {!isTauri && (
          <p className="px-2 py-1.5 font-display text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-status-warn">web preview</span> — agent runs need the
            desktop app.
          </p>
        )}
        {isTauri && !loading && runs.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Bot size={20} strokeWidth={1.4} className="text-fg-subtle" />
            <p className="font-display text-[12px] font-medium text-fg-base/85">No agent runs yet</p>
            <p className="max-w-[200px] font-display text-[10.5px] leading-relaxed text-fg-subtle">
              Launch one with <span className="font-mono">/agent &lt;goal&gt;</span> in the
              assistant. Runs show up here.
            </p>
          </div>
        )}
        {runs.map((run) => {
          const dur = duration(run);
          const isOpen = expanded === run.id;
          return (
            <div key={run.id} className="mb-0.5">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : run.id)}
                className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.045]"
              >
                <span
                  aria-hidden
                  className={cn('mt-0.5 h-2 w-2 shrink-0 rounded-full', STATUS_DOT[run.status])}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-display text-[12.5px] tracking-tight text-fg-base/90">
                      {agentLabel(run.agent_id)}
                    </span>
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest2 text-fg-subtle">
                      {run.status}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-fg-subtle">
                    {relTime(run.started_at)}
                    {dur ? ` · ${dur}` : ''}
                  </div>
                </div>
              </button>
              {isOpen && run.summary && (
                <p className="selectable mx-2 mb-1.5 mt-0.5 whitespace-pre-wrap rounded-md bg-black/[0.18] px-2.5 py-2 font-display text-[11px] leading-relaxed text-fg-muted">
                  {run.summary}
                </p>
              )}
              {isOpen && !run.summary && (
                <p className="mx-2 mb-1.5 mt-0.5 px-2.5 font-display text-[10.5px] italic text-fg-subtle">
                  No summary recorded.
                </p>
              )}
              {isOpen && run.worktree_path && (
                <WorktreeActions run={run} onAfter={() => void refresh()} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Review affordances for an isolated (worktree-backed) run: shows the branch +
 * worktree path, lets the user reroot the file tree onto the worktree to review
 * the agent's edits via Source Control / the editor, and discard the worktree
 * (force-remove + branch delete) once they're done.
 */
function WorktreeActions({ run, onAfter }: { run: AgentRunRecord; onAfter: () => void }) {
  const setRoot = useFiles((s) => s.setRoot);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const path = run.worktree_path;
  if (!path) return null;

  const discard = async () => {
    setBusy(true);
    setErr(null);
    try {
      await agentWorktreeDiscard(path, run.worktree_branch);
      onAfter();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="mx-2 mb-1.5 mt-0.5 rounded-md border border-border-hairline/70 bg-black/[0.12] px-2.5 py-2">
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-fg-muted">
        <GitBranch size={10} strokeWidth={2.2} className="shrink-0 text-accent" />
        <span className="truncate">{run.worktree_branch ?? 'detached'}</span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[9.5px] text-fg-subtle" title={path}>
        {path}
      </div>
      {err && <div className="mt-1 font-mono text-[10px] text-status-err">{err}</div>}
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setRoot(path)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-display text-[10.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          title="Open this worktree in the file tree to review the changes"
        >
          <FolderTree size={10} strokeWidth={2.1} />
          review changes
        </button>
        {confirming ? (
          <div className="flex items-center gap-1 rounded bg-status-err/[0.12] px-1.5 py-0.5">
            <button
              type="button"
              onClick={() => void discard()}
              disabled={busy}
              className="font-display text-[10.5px] text-status-err hover:opacity-80 disabled:opacity-50"
            >
              {busy ? 'discarding…' : 'confirm discard'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="font-display text-[10.5px] text-fg-subtle hover:text-fg-base disabled:opacity-50"
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-display text-[10.5px] text-fg-subtle transition-colors hover:bg-status-err/[0.12] hover:text-status-err"
            title="Remove the worktree and its branch"
          >
            <Trash2 size={10} strokeWidth={2.1} />
            discard
          </button>
        )}
      </div>
    </div>
  );
}
