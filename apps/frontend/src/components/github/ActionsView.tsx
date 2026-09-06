import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, RotateCcw, Square } from 'lucide-react';
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
import { ListRow } from './ListRow';
import { runGlyph } from './stateGlyph';
import { meta, relative } from './format';
import { ErrorTray, SplitPane } from './parts';

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
          <span className="font-display text-2xs text-fg-subtle">
            Latest {runs.length} runs
          </span>
          <div className="flex-1" />
          <button
            onClick={() => void load()}
            aria-label="Refresh"
            title="Refresh"
            className="flex h-6 w-6 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
          >
            <RefreshCw size={12} strokeWidth={2} className={cn(loading && 'animate-spin')} />
          </button>
        </>
      }
      list={
        <>
          {error && <ErrorTray message={error} />}
          {runs.length === 0 && !loading && !error ? (
            <p className="px-2 py-8 text-center font-display text-xs text-fg-subtle">
              No workflow runs yet. Push a commit, or add a workflow under
              <span className="font-mono"> .github/workflows</span>.
            </p>
          ) : (
            runs.map((r) => {
              const g = runGlyph(r.status, r.conclusion);
              return (
                <ListRow
                  key={r.id}
                  glyph={g.icon}
                  glyphClass={g.className}
                  title={r.title || r.name}
                  title_={`${g.label} · ${r.name}`}
                  meta={meta(
                    r.name,
                    `#${r.run_number}`,
                    r.branch,
                    r.actor,
                    relative(r.created_at),
                  )}
                  selected={selected === r.id}
                  onClick={() => setSelected(r.id)}
                />
              );
            })
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
  const Icon = g.icon;
  const running = run.status !== 'completed';
  const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out';

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-4 pb-2 pt-3.5">
        <div className="flex items-start gap-2">
          <span className="mt-[3px] flex w-5 shrink-0 justify-center">
            <Icon size={15} strokeWidth={2} className={g.className} />
            <span className="sr-only">{g.label}</span>
          </span>
          <h2 className="min-w-0 flex-1 font-display text-sm font-semibold leading-snug tracking-tight text-fg-base">
            {run.title || run.name}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {running ? (
              <button
                onClick={() => void act(() => gitHostRunCancel(owner, name, run.id))}
                disabled={busy}
                className="flex h-7 items-center gap-1 rounded-lg px-2 font-display text-xs text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
              >
                <Square size={11} strokeWidth={2} />
                Cancel
              </button>
            ) : (
              <button
                onClick={() => void act(() => gitHostRunRerun(owner, name, run.id, failed))}
                disabled={busy}
                title={failed ? 'Re-run only the jobs that failed' : 'Re-run every job'}
                className="flex h-7 items-center gap-1 rounded-lg bg-surface-2 px-2.5 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40"
              >
                <RotateCcw size={11} strokeWidth={2} />
                {failed ? 'Re-run failed jobs' : 'Re-run'}
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 pl-7 font-mono text-2xs tabular-nums text-fg-subtle">
          {meta(run.name, `#${run.run_number}`, run.branch, run.event, run.actor, relative(run.created_at))}
        </p>
        <button
          onClick={() => void shellOpenExternal(run.html_url)}
          className="mt-1 ml-7 flex items-center gap-1 font-display text-2xs text-fg-subtle transition-colors hover:text-accent-bright focus-visible:outline-none focus-visible:shadow-focus"
        >
          <ExternalLink size={10} strokeWidth={2} />
          Open the full log on github.com
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-edge-1 px-2 py-1.5">
        {error && (
          <div className="px-1">
            <ErrorTray message={error} />
          </div>
        )}
        {jobs === null && !error && (
          <div className="flex justify-center py-8">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
          </div>
        )}
        {jobs?.map((j) => {
          const jg = runGlyph(j.status, j.conclusion);
          return (
            <div key={j.id} className="mb-1">
              <ListRow
                glyph={jg.icon}
                glyphClass={jg.className}
                title={j.name}
                title_={`${jg.label} · ${j.name}`}
                meta={meta(jg.label.toLowerCase(), `${j.steps.length} steps`)}
                onClick={() => void shellOpenExternal(j.html_url)}
              />
              <ol className="ml-9 border-l border-edge-1 pl-3">
                {j.steps.map((s) => {
                  const sg = runGlyph(s.status, s.conclusion);
                  const SIcon = sg.icon;
                  return (
                    <li
                      key={`${s.number}-${s.name}`}
                      className="flex items-center gap-1.5 py-0.5"
                    >
                      <SIcon size={10} strokeWidth={2} className={cn('shrink-0', sg.className)} />
                      <span className="truncate font-display text-2xs text-fg-muted">
                        {s.name}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>
    </div>
  );
}
