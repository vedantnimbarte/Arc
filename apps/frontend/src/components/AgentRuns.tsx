import { useCallback, useEffect, useRef, useState } from 'react';
import { GitMerge, RefreshCw, Trash2, Trophy } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  gitBranchDelete,
  gitChanges,
  gitCommit,
  gitDiffTrees,
  gitMerge,
  gitMergeBase,
  gitRevCount,
  gitSnapshotTree,
  gitStage,
  gitStatus,
  gitWorktreeList,
  gitWorktreeRemove,
} from '../lib/tauri';
import {
  groupRaceRuns,
  loadRaceMeta,
  mergeStrategy,
  parseNumstat,
  runStatus,
  type NumstatSummary,
  type RaceGroup,
  type RaceRun,
  type RunStatus,
} from '../lib/agentRuns';
import { useFiles } from '../state/files';
import { useGit } from '../state/git';
import { useWorkspace } from '../state/workspace';
import { askConfirm, askText } from '../state/confirm';
import { toast, toastError } from '../state/toast';
import { HunkBlock, parseDiff } from './DiffView';
import { Select } from './Select';

/**
 * Agent runs: every race `createRaceWorktrees` started, side by side.
 *
 * The point of racing agents is choosing between their results, and the
 * results live in sibling worktrees that nothing else in ARC shows together.
 * This lists each race's runs with what they changed, diffs any two of them
 * (or one against the base) as they stand on disk — uncommitted work
 * included — and merges the one you pick back into the base branch.
 */

/** What a run has done, measured against the base it was cut from. */
interface RunStats {
  /** Snapshot tree of the checkout, uncommitted and untracked work included. */
  tree: string;
  /** Where the run branched from the base. Null without a base branch. */
  base: string | null;
  changes: NumstatSummary | null;
  /** Commits on the run branch the base does not have. */
  ahead: number;
}

type StatsEntry = RunStats | { error: string };

async function loadStats(group: RaceGroup, run: RaceRun): Promise<RunStats> {
  const tree = await gitSnapshotTree(run.path);
  if (!group.baseBranch) return { tree, base: null, changes: null, ahead: 0 };
  const [base, ahead] = await Promise.all([
    gitMergeBase(group.repo, group.baseBranch, run.branch),
    gitRevCount(group.repo, group.baseBranch, run.branch),
  ]);
  const changes = parseNumstat(await gitDiffTrees(group.repo, base, tree, null, true));
  return { tree, base, changes, ahead };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AgentRuns() {
  const root = useFiles((s) => s.root);
  const tabs = useWorkspace((s) => s.tabs);
  const waiting = useWorkspace((s) => s.agentWaiting);

  const [groups, setGroups] = useState<RaceGroup[] | null>(null);
  const [stats, setStats] = useState<Record<string, StatsEntry>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!root) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const found = groupRaceRuns(await gitWorktreeList(root), loadRaceMeta());
      if (mine !== seq.current) return;
      setGroups(found);
      const entries = await Promise.all(
        found.flatMap((g) =>
          g.runs
            .filter((r) => !r.prunable)
            .map(async (r) =>
              [r.path, await loadStats(g, r).catch((e) => ({ error: errorText(e) }))] as const,
            ),
        ),
      );
      if (mine === seq.current) setStats(Object.fromEntries(entries));
    } catch (err) {
      if (mine === seq.current) setError(errorText(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const group = groups?.find((g) => g.id === selectedGroup) ?? groups?.[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-base">
      <div className="flex shrink-0 items-baseline justify-between gap-2 border-b border-border-hairline px-3 py-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-xs font-medium tracking-tight text-fg-base">
            Agent runs
          </span>
          <span className="font-mono text-2xs tabular-nums text-fg-subtle">
            {groups ? `${groups.length} race${groups.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh agent runs"
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <RefreshCw size={11} strokeWidth={2} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <p className="border-b border-border-hairline bg-red-900/20 px-3 py-1.5 font-sans text-xs text-red-400">
          {error}
        </p>
      )}

      {!root ? (
        <Empty title="No folder open" body="Open a git repository to see its agent runs." />
      ) : groups && groups.length === 0 ? (
        <Empty
          title="No agent runs"
          body="Launch agents with “Give each its own checkout” and their worktrees appear here to compare."
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-[380px] shrink-0 overflow-y-auto border-r border-border-hairline">
            {groups?.map((g) => (
              <GroupBlock
                key={g.id}
                group={g}
                selected={g.id === group?.id}
                stats={stats}
                statusOf={(path) => runStatus(path, tabs, waiting)}
                onSelect={() => setSelectedGroup(g.id)}
                onChanged={() => void refresh()}
              />
            ))}
          </ul>
          <div className="min-w-0 flex-1">
            {group && <Compare key={group.id} group={group} stats={stats} />}
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <Trophy size={18} strokeWidth={1.6} className="text-fg-subtle" />
      <p className="font-display text-xs text-fg-muted">{title}</p>
      <p className="max-w-sm font-display text-2xs leading-relaxed text-fg-subtle">{body}</p>
    </div>
  );
}

const STATUS_LABEL: Record<RunStatus, { text: string; tone: string }> = {
  running: { text: 'running', tone: 'text-accent-bright' },
  waiting: { text: 'waiting on you', tone: 'text-status-warn' },
  exited: { text: 'exited', tone: 'text-fg-subtle' },
};

function GroupBlock({
  group,
  selected,
  stats,
  statusOf,
  onSelect,
  onChanged,
}: {
  group: RaceGroup;
  selected: boolean;
  stats: Record<string, StatsEntry>;
  statusOf: (path: string) => ReturnType<typeof runStatus>;
  onSelect: () => void;
  onChanged: () => void;
}) {
  return (
    <li className={cn('border-b border-border-hairline', selected && 'bg-surface-1/60')}>
      <button type="button" onClick={onSelect} className="block w-full px-3 pb-1 pt-2 text-left">
        <p className="truncate font-display text-xs text-fg-base" title={group.label}>
          {group.label}
        </p>
        <p className="truncate font-mono text-2xs text-fg-subtle">
          {[
            group.agent,
            group.baseBranch ? `from ${group.baseBranch}` : 'no base branch',
            group.createdAt ? new Date(group.createdAt).toLocaleString() : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </button>
      <ul className="pb-1.5">
        {group.runs.map((run) => {
          const { status, tab } = statusOf(run.path);
          const s = stats[run.path];
          const label = STATUS_LABEL[status];
          return (
            <li key={run.path} className="group/run flex items-center gap-2 px-3 py-1">
              <span className={cn('shrink-0 font-mono text-2xs', label.tone)} title={label.text}>
                ●
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-xs text-fg-base/90">
                  {tab?.title ?? `${group.agent ?? 'Agent'} ${run.index}`}
                  <span className={cn('ml-1.5 font-mono text-2xs', label.tone)}>{label.text}</span>
                </p>
                <p className="truncate font-mono text-2xs text-fg-subtle" title={run.path}>
                  {run.branch} ·{' '}
                  {run.prunable ? (
                    'checkout missing'
                  ) : !s ? (
                    'reading…'
                  ) : 'error' in s ? (
                    <span className="text-status-err" title={s.error}>
                      unreadable
                    </span>
                  ) : (
                    <>
                      {s.changes ? `${s.changes.files.length} files ` : ''}
                      {s.changes && (
                        <>
                          <span className="text-status-ok">+{s.changes.insertions}</span>{' '}
                          <span className="text-status-err">−{s.changes.deletions}</span>{' '}
                        </>
                      )}
                      · {s.ahead} commit{s.ahead === 1 ? '' : 's'} ahead
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover/run:opacity-100">
                {group.baseBranch && !run.prunable && (
                  <IconButton
                    label={`Merge into ${group.baseBranch}`}
                    onClick={() => void mergeRun(group, run).finally(onChanged)}
                  >
                    <GitMerge size={11} strokeWidth={2} />
                  </IconButton>
                )}
                <IconButton
                  label="Remove this worktree and branch"
                  onClick={() => void removeRuns(group, [run]).finally(onChanged)}
                >
                  <Trash2 size={11} strokeWidth={2} />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
    >
      {children}
    </button>
  );
}

const BASE = 'base';

/** Two pickers, a changed-file list, and the selected file's side-by-side diff. */
function Compare({ group, stats }: { group: RaceGroup; stats: Record<string, StatsEntry> }) {
  const runs = group.runs.filter((r) => !r.prunable);
  const [left, setLeft] = useState<string>(runs.length > 1 ? runs[0]!.path : BASE);
  const [right, setRight] = useState<string>(runs[runs.length > 1 ? 1 : 0]?.path ?? BASE);
  const [files, setFiles] = useState<NumstatSummary | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = [
    ...(group.baseBranch ? [{ value: BASE, label: `${group.baseBranch} (base)` }] : []),
    ...runs.map((r) => ({ value: r.path, label: r.branch })),
  ];

  /** The revision a side stands for. The base is where the *other* side
   *  branched off, so a run is only ever charged with its own changes. */
  const statsOf = (side: string) => {
    const s = stats[side];
    return s && !('error' in s) ? s : null;
  };
  const rev = (side: string, other: string) =>
    side === BASE ? statsOf(other)?.base ?? null : statsOf(side)?.tree ?? null;
  // Plain strings, so a refresh that finds the same trees reloads nothing.
  const from = rev(left, right);
  const to = rev(right, left);

  useEffect(() => {
    setFiles(null);
    setFile(null);
    setError(null);
    if (!from || !to) return;
    let live = true;
    gitDiffTrees(group.repo, from, to, null, true)
      .then((text) => {
        if (!live) return;
        const summary = parseNumstat(text);
        setFiles(summary);
        setFile(summary.files[0]?.path ?? null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [group.repo, from, to]);

  useEffect(() => {
    setDiff(null);
    if (!from || !to || !file) return;
    let live = true;
    gitDiffTrees(group.repo, from, to, file, false)
      .then((text) => live && setDiff(text))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [group.repo, from, to, file]);

  const hunks = diff ? parseDiff(diff).flatMap((f) => f.hunks) : [];
  const labelOf = (side: string) => options.find((o) => o.value === side)?.label ?? side;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <Select value={left} options={options} onChange={setLeft} ariaLabel="Compare from" mono size="compact" className="w-56" />
        <span className="font-display text-2xs text-fg-subtle">→</span>
        <Select value={right} options={options} onChange={setRight} ariaLabel="Compare to" mono size="compact" className="w-56" />
        {files && (
          <span className="ml-auto font-mono text-2xs tabular-nums text-fg-subtle">
            {files.files.length} files <span className="text-status-ok">+{files.insertions}</span>{' '}
            <span className="text-status-err">−{files.deletions}</span>
          </span>
        )}
      </div>

      {error && (
        <p className="border-b border-border-hairline bg-red-900/20 px-3 py-1.5 font-sans text-xs text-red-400">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <ul className="w-56 shrink-0 overflow-y-auto border-r border-border-hairline py-1">
          {!from || !to ? (
            <li className="px-3 py-1 font-mono text-2xs text-fg-subtle">
              {left === right ? 'pick two different sides' : 'reading checkouts…'}
            </li>
          ) : files?.files.length === 0 ? (
            <li className="px-3 py-1 font-mono text-2xs text-fg-subtle">identical</li>
          ) : (
            files?.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setFile(f.path)}
                  title={f.path}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-2xs',
                    f.path === file ? 'bg-surface-2 text-fg-base' : 'text-fg-muted hover:bg-surface-1',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <span className="shrink-0 tabular-nums text-status-ok">+{f.insertions}</span>
                  <span className="shrink-0 tabular-nums text-status-err">−{f.deletions}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="min-w-0 flex-1 overflow-auto text-sm">
          {file && (
            <div className="flex border-b border-border-hairline bg-surface-1">
              <div className="w-1/2 truncate border-r border-border-hairline px-3 py-1 font-mono text-2xs text-fg-subtle/80">
                {labelOf(left)}
              </div>
              <div className="w-1/2 truncate px-3 py-1 font-mono text-2xs text-fg-subtle/80">{labelOf(right)}</div>
            </div>
          )}
          {file && diff !== null && hunks.length === 0 && (
            <p className="px-3 py-3 font-sans text-xs text-fg-subtle">No text changes (binary or mode only)</p>
          )}
          {hunks.map((hunk, i) => (
            // `head` scope: a comparison is read-only, so no stage/discard.
            <HunkBlock key={`${file}-${i}`} hunk={hunk} file={file ?? ''} scope="head" busy={false} onApply={() => {}} />
          ))}
        </div>
      </div>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Label a run the way its row does. */
function runName(group: RaceGroup, run: RaceRun): string {
  return `${group.agent ?? 'Agent'} ${run.index}`;
}

/**
 * Make `run` the winner: commit what it left uncommitted, merge its branch
 * into the base (git fast-forwards when it can), open conflicts in the merge
 * view, then offer to clear away the other runs.
 */
async function mergeRun(group: RaceGroup, run: RaceRun): Promise<void> {
  const base = group.baseBranch;
  if (!base) return;
  try {
    // The merge happens in the main checkout, so that is what must be on the
    // base — switching it for the user would move their own work around.
    const main = await gitStatus(group.repo);
    if (main?.branch !== base) {
      toastError(`Check out ${base} in the main checkout first (it is on ${main?.branch ?? 'a detached HEAD'})`);
      return;
    }
    if (main.in_progress) {
      toastError(`Finish the ${main.in_progress} in progress in the main checkout first`);
      return;
    }

    if ((await gitChanges(run.path)).length > 0) {
      const message = await askText(
        `Commit ${runName(group, run)}'s uncommitted changes`,
        { label: 'Commit message', value: `${group.label} (${runName(group, run)})` },
        'commit',
      );
      if (message === null) return;
      await gitStage(run.path, ['.']);
      await gitCommit(run.path, message);
    }

    const [ahead, behind] = await Promise.all([
      gitRevCount(group.repo, base, run.branch),
      gitRevCount(group.repo, run.branch, base),
    ]);
    const strategy = mergeStrategy(ahead, behind);
    if (strategy === 'up-to-date') {
      toast(`${base} already has everything on ${run.branch}`);
    } else {
      const ok = await askConfirm({
        title: `Merge ${run.branch} into ${base}?`,
        body:
          strategy === 'fast-forward'
            ? `${plural(ahead, 'commit')}, fast-forwarded — ${base} has not moved since the race started.`
            : `${plural(ahead, 'commit')}. ${base} has ${plural(behind, 'new commit')} since, so this makes a merge commit.`,
        confirmLabel: 'merge',
      });
      if (!ok) return;
      const result = await gitMerge(group.repo, run.branch);
      void useGit.getState().refresh(useFiles.getState().root ?? group.repo);
      if (result.conflicts) {
        const conflicted = (await gitChanges(group.repo)).filter((e) => e.kind === 'conflict');
        const sep = group.repo.includes('\\') ? '\\' : '/';
        for (const c of conflicted) {
          useWorkspace.getState().openMerge(`${group.repo}${sep}${c.path.replace(/\//g, sep)}`, group.repo);
        }
        toastError(`Merge stopped on ${plural(conflicted.length, 'conflict')} — resolve them, then commit`);
        return;
      }
      toast(`Merged ${run.branch} into ${base}`);
    }

    const others = group.runs.filter((r) => r !== run);
    if (others.length > 0) await removeRuns(group, others);
  } catch (err) {
    toastError(`Merge failed: ${errorText(err)}`);
  }
}

/**
 * Delete `runs`' worktrees and branches after one confirmation that names
 * every run whose work is not in the base — nothing unmerged goes silently.
 */
async function removeRuns(group: RaceGroup, runs: RaceRun[]): Promise<void> {
  const ws = useWorkspace.getState();
  const details = await Promise.all(
    runs.map(async (run) => {
      // Unknown counts as unmerged: better a warning too many than lost work.
      const ahead = group.baseBranch
        ? await gitRevCount(group.repo, group.baseBranch, run.branch).catch(() => 1)
        : 1;
      const dirty = run.prunable
        ? false
        : (await gitChanges(run.path).catch(() => [])).length > 0;
      return { run, ahead, dirty };
    }),
  );
  const unmerged = details.filter((d) => d.ahead > 0 || d.dirty);
  const lost = unmerged.map(
    (d) =>
      `${runName(group, d.run)} (${[
        d.ahead > 0 ? `${plural(d.ahead, 'unmerged commit')}` : null,
        d.dirty ? 'uncommitted changes' : null,
      ]
        .filter(Boolean)
        .join(', ')})`,
  );
  const ok = await askConfirm({
    title: runs.length === 1 ? `Remove ${runName(group, runs[0]!)}?` : `Remove the other ${runs.length} runs?`,
    body:
      (lost.length > 0
        ? `This deletes work that is not in ${group.baseBranch ?? 'the base'}: ${lost.join('; ')}.`
        : `Everything they did is already in ${group.baseBranch}.`) +
      ' Their worktrees, branches and any open agent tabs go too.',
    confirmLabel: 'remove',
    destructive: lost.length > 0,
  });
  if (!ok) return;

  let closed = false;
  for (const { run } of details) {
    const { tab } = runStatus(run.path, ws.tabs, {});
    if (tab) {
      ws.closeTab(tab.id);
      closed = true;
    }
  }
  // A shell still exiting holds its directory open on Windows.
  if (closed) await new Promise((r) => setTimeout(r, 800));

  const failed: string[] = [];
  for (const { run } of details) {
    try {
      // Forced: the confirmation above already named what is lost.
      await gitWorktreeRemove(group.repo, run.path, true).catch((err) => {
        if (!run.prunable) throw err;
      });
      await gitBranchDelete(group.repo, run.branch, true);
    } catch (err) {
      failed.push(`${run.branch}: ${errorText(err)}`);
    }
  }
  if (failed.length > 0) toastError(`Could not remove ${failed.join('; ')}`);
  else toast(`Removed ${plural(runs.length, 'run')}`);
}
