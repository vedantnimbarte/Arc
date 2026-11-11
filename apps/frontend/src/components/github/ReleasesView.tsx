import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, PencilLine, Tag, User } from 'lucide-react';
import { gitHostReleaseList, type GitHostRelease } from '../../lib/tauri';
import { splitRepoKey, useGitHub } from '../../state/github';
import { ListRow, laneEnds } from './ListRow';
import type { Glyph } from './stateGlyph';
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
} from './parts';

/** Draft, pre-release or published — the three states a release can be in. */
function releaseGlyph(r: GitHostRelease): Glyph {
  if (r.draft) return { icon: PencilLine, className: 'text-fg-subtle', label: 'Draft' };
  if (r.prerelease) return { icon: FlaskConical, className: 'text-status-warn', label: 'Pre-release' };
  return { icon: Tag, className: 'text-status-ok', label: 'Published' };
}

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
          {!loading && <Count n={releases.length} one="release" many="releases" />}
          <div className="flex-1" />
          <RefreshButton loading={loading} onClick={() => void load()} />
        </>
      }
      list={
        <>
          {error && <ErrorTray message={error} />}
          {releases.length === 0 && loading && <Loading />}
          {releases.length === 0 && !loading && !error ? (
            <EmptyNote>No releases published from this repository.</EmptyNote>
          ) : (
            <div className={laneEnds}>
              {releases.map((r) => {
                const g = releaseGlyph(r);
                return (
                  <ListRow
                    key={r.tag}
                    glyph={g.icon}
                    glyphClass={g.className}
                    title={r.name || r.tag}
                    title_={`${g.label}: ${r.name || r.tag}`}
                    meta={
                      <>
                        <BranchChip name={r.tag} icon={Tag} />
                        <Fact>{r.published_at ? ago(r.published_at) : 'not published'}</Fact>
                        {(r.draft || r.prerelease) && (
                          <span className={`font-display text-2xs ${g.className}`}>{g.label}</span>
                        )}
                      </>
                    }
                    selected={selected === r.tag}
                    onClick={() => setSelected(r.tag)}
                  />
                );
              })}
            </div>
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
            <DetailHeader
              glyph={releaseGlyph(active)}
              number={active.tag}
              title={active.name || active.tag}
              facts={
                <>
                  <BranchChip name={active.tag} icon={Tag} />
                  <Fact icon={User}>{active.author}</Fact>
                  <Fact>{active.published_at ? `published ${ago(active.published_at)}` : 'not published'}</Fact>
                </>
              }
              htmlUrl={active.html_url}
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {active.body.trim() ? (
                <p className="max-w-[72ch] whitespace-pre-wrap break-words font-display text-xs leading-relaxed text-fg-base/90">
                  {active.body}
                </p>
              ) : (
                <p className="font-display text-xs italic text-fg-subtle">This release has no notes.</p>
              )}
            </div>
          </div>
        )
      }
    />
  );
}
