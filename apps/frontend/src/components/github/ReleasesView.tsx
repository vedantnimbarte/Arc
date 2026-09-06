import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, FlaskConical, PencilLine, RefreshCw, Tag } from 'lucide-react';
import { gitHostReleaseList, shellOpenExternal, type GitHostRelease } from '../../lib/tauri';
import { splitRepoKey, useGitHub } from '../../state/github';
import { cn } from '../../lib/cn';
import { ListRow } from './ListRow';
import { meta, relative } from './format';
import { ErrorTray, SplitPane } from './parts';

export function ReleasesView() {
  const repoKey = useGitHub((s) => s.repo);
  const parts = repoKey ? splitRepoKey(repoKey) : null;

  const [releases, setReleases] = useState<GitHostRelease[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!parts) return;
    setLoading(true);
    setError(null);
    try {
      setReleases(await gitHostReleaseList(parts.owner, parts.name));
    } catch (e) {
      setError(String(e));
      setReleases([]);
    } finally {
      setLoading(false);
    }
  }, [parts?.owner, parts?.name]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!parts) return null;

  const active = releases.find((r) => r.tag === selected) ?? null;

  return (
    <SplitPane
      toolbar={
        <>
          <span className="font-display text-2xs text-fg-subtle">
            {releases.length} releases
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
          {releases.length === 0 && !loading && !error ? (
            <p className="px-2 py-8 text-center font-display text-xs text-fg-subtle">
              No releases published from this repository.
            </p>
          ) : (
            releases.map((r) => (
              <ListRow
                key={r.tag}
                glyph={r.draft ? PencilLine : r.prerelease ? FlaskConical : Tag}
                glyphClass={
                  r.draft
                    ? 'text-fg-subtle'
                    : r.prerelease
                      ? 'text-status-warn'
                      : 'text-status-ok'
                }
                title={r.name}
                title_={r.name}
                meta={meta(
                  r.tag,
                  r.author,
                  r.published_at ? relative(r.published_at) : 'unpublished',
                  r.draft && 'draft',
                  r.prerelease && 'pre-release',
                )}
                selected={selected === r.tag}
                onClick={() => setSelected(r.tag)}
              />
            ))
          )}
        </>
      }
      detail={
        !active ? (
          <div className="flex h-full items-center justify-center px-8">
            <p className="max-w-xs text-center font-display text-xs text-fg-subtle">
              Pick a release to read its notes.
            </p>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="shrink-0 px-4 pb-2 pt-3.5">
              <h2 className="font-display text-sm font-semibold tracking-tight text-fg-base">
                {active.name}
              </h2>
              <p className="mt-1 font-mono text-2xs tabular-nums text-fg-subtle">
                {meta(
                  active.tag,
                  active.author,
                  active.published_at ? relative(active.published_at) : 'unpublished',
                )}
              </p>
              <button
                onClick={() => void shellOpenExternal(active.html_url)}
                className="mt-1 flex items-center gap-1 font-display text-2xs text-fg-subtle transition-colors hover:text-accent-bright focus-visible:outline-none focus-visible:shadow-focus"
              >
                <ExternalLink size={10} strokeWidth={2} />
                Open on github.com
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-edge-1 px-4 py-3">
              {active.body.trim() ? (
                <p className="whitespace-pre-wrap break-words font-display text-xs leading-relaxed text-fg-base/90">
                  {active.body}
                </p>
              ) : (
                <p className="font-display text-xs italic text-fg-subtle">
                  This release has no notes.
                </p>
              )}
            </div>
          </div>
        )
      }
    />
  );
}
