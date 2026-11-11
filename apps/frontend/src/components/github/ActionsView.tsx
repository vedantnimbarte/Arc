import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RotateCcw, Square, User, Zap } from 'lucide-react';
import {
  gitHostRunCancel,
  gitHostRunJobs,
  gitHostRunList,
  gitHostRunRerun,
  shellOpenExternal,
  type GitHostJob,
  type GitHostWorkflowRun,
} from '../../lib/tauri';
import { splitRepoKey, useGitHub } from '../../state/github';
import { cn } from '../../lib/cn';
import { ListRow, laneEnds } from './ListRow';
import { runGlyph } from './stateGlyph';
import {
  BranchChip,
  Count,
  DetailHeader,
  EmptyNote,
  ErrorTray,
  Fact,
  Loading,
  RefreshButton,
  SplitPane,
  ago,
  buttonGhost,
  buttonQuiet,
} from './parts';

export function ActionsView() {
  const repoKey = useGitHub((s) => s.repo);
  const parts = repoKey ? splitRepoKey(repoKey) : null;

  const [runs, setRuns] = useState<GitHostWorkflowRun[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!parts) return;
    setLoading(true);
    setError(null);
    try {
      setRuns(await gitHostRunList(parts.owner, parts.name));
    } catch (e) {
      setError(String(e));
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [parts?.owner, parts?.name]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!parts) return null;

  return (
    <SplitPane
      toolbar={
        <>
          {!loading && <Count n={runs.length} one="recent run" many="recent runs" />}
          <div className="flex-1" />
          <RefreshButton loading={loading} onClick={() => void load()} />
        </>
      }
      list={
        <>
          {error && <ErrorTray message={error} />}
          {runs.length === 0 && loading && <Loading />}
          {runs.length === 0 && !loading && !error ? (
            <EmptyNote>
              No workflow runs yet. Push a commit, or add a workflow under
              <span className="font-mono"> .github/workflows</span>.
            </EmptyNote>
          ) : (
            <div className={laneEnds}>
              {runs.map((r) => {
                const g = runGlyph(r.status, r.conclusion);
                return (
                  <ListRow
                    key={r.id}
                    glyph={g.icon}
                    glyphClass={g.className}
                    title={r.title || r.name}
                    number={`#${r.run_number}`}
                    title_={`${g.label}: ${r.name}`}
                    meta={
                      <>
                        {r.branch && <BranchChip name={r.branch} />}
                        <Fact icon={Zap}>{r.name}</Fact>
                        <Fact>{ago(r.created_at)}</Fact>
                      </>
                    }
                    selected={selected === r.id}
                    onClick={() => setSelected(r.id)}
                  />
                );
              })}
            </div>
          )}
        </>
      }
      detail={
        selected === null ? (
          <div className="flex h-full items-center justify-center px-8">
            <p className="max-w-xs text-center font-display text-xs text-fg-subtle">
              Pick a run to see which job and step decided its outcome.
            </p>
          </div>
        ) : (
          <RunDetail
            key={selected}
            owner={parts.owner}
            name={parts.name}
            run={runs.find((r) => r.id === selected)!}
            onChanged={() => void load()}
          />
        )
      }
    />
  );
}

function RunDetail({
  owner,
  name,
  run,
  onChanged,
}: {
  owner: string;
  name: string;
  run: GitHostWorkflowRun;
  onChanged: () => void;
}) {
  const [jobs, setJobs] = useState<GitHostJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setJobs(null);
    setError(null);
    gitHostRunJobs(owner, name, run.id)
      .then((j) => !cancelled && setJobs(j))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [owner, name, run.id]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const g = runGlyph(run.status, run.conclusion);
  const running = run.status !== 'completed';
  const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out';

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        glyph={g}
        number={`${run.name} #${run.run_number}`}
        title={run.title || run.name}
        facts={
          <>
            {run.branch && <BranchChip name={run.branch} />}
            <Fact icon={Zap}>{run.event}</Fact>
            <Fact icon={User}>{run.actor}</Fact>
            <Fact>started {ago(run.created_at)}</Fact>
          </>
        }
        htmlUrl={run.html_url}
        actions={
          running ? (
            <button
              onClick={() => void act(() => gitHostRunCancel(owner, name, run.id))}
              disabled={busy}
              className={buttonGhost}
            >
              <Square size={12} strokeWidth={2} />
              Cancel run
            </button>
          ) : (
            <button
              onClick={() => void act(() => gitHostRunRerun(owner, name, run.id, failed))}
              disabled={busy}
              title={failed ? 'Re-run only the jobs that failed' : 'Re-run every job'}
              className={buttonQuiet}
            >
              <RotateCcw size={12} strokeWidth={2} />
              {failed ? 'Re-run failed jobs' : 'Re-run'}
            </button>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && <ErrorTray message={error} />}
        {jobs === null && !error && <Loading />}
        {jobs?.length === 0 && <EmptyNote>This run has no jobs.</EmptyNote>}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {jobs?.map((j) => <JobCard key={j.id} job={j} />)}
        </div>
      </div>
    </div>
  );
}

/** One job as a pipeline card: its result on top, its steps as a lane below,
 *  so the step that broke the job is the one red node in the column. */
function JobCard({ job }: { job: GitHostJob }) {
  const jg = runGlyph(job.status, job.conclusion);
  const JIcon = jg.icon;
  return (
    <div className="flex flex-col overflow-hidden rounded-lg bg-surface-1 ring-1 ring-inset ring-edge-1">
      <div className="flex items-center gap-2 border-b border-edge-1 px-3 py-2.5">
        <JIcon size={14} strokeWidth={2.2} className={cn('shrink-0', jg.className)} />
        <span className="min-w-0 flex-1 truncate font-display text-xs font-semibold text-fg-base">
          {job.name}
        </span>
        <span className={cn('shrink-0 font-display text-2xs', jg.className)}>{jg.label}</span>
        <button
          onClick={() => void shellOpenExternal(job.html_url)}
          aria-label={`Open the ${job.name} log on GitHub`}
          title="Open the log on GitHub"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
        >
          <ExternalLink size={12} strokeWidth={2} />
        </button>
      </div>
      <ol className="px-3 py-2">
        {job.steps.map((s, i) => {
          const sg = runGlyph(s.status, s.conclusion);
          const SIcon = sg.icon;
          const last = i === job.steps.length - 1;
          return (
            <li key={`${s.number}-${s.name}`} className="flex gap-2">
              <span className="flex w-3 shrink-0 flex-col items-center" aria-hidden>
                <span className={cn('h-1 w-px', i === 0 ? 'bg-transparent' : 'bg-edge-2')} />
                <SIcon size={11} strokeWidth={2.2} className={cn('shrink-0', sg.className)} />
                <span className={cn('w-px flex-1', last ? 'bg-transparent' : 'bg-edge-2')} />
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate py-[3px] font-display text-2xs',
                  sg.label === 'Failed' ? 'font-medium text-status-err' : 'text-fg-muted',
                )}
                title={`${sg.label}: ${s.name}`}
              >
                {s.name}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
