import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Book, Download, GitFork, Lock, Search, X } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  fsPickFolder,
  gitHostClone,
  gitHostOrgList,
  gitHostRepoList,
  gitHostRepoSearch,
  onGitHostClone,
  type GitHostOrg,
  type GitHostRepoScope,
  type GitHostRepoSummary,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGitHub } from '../../state/github';
import { cn } from '../../lib/cn';
import { ListRow } from './ListRow';
import { meta, relative } from './format';

/** A clone in flight, or the result of the last one. */
type Clone =
  | { state: 'running'; repo: string; line: string }
  | { state: 'done'; repo: string; path: string }
  | { state: 'failed'; repo: string; message: string };

export function ReposView() {
  const activeRepo = useGitHub((s) => s.repo);
  const setRepo = useGitHub((s) => s.setRepo);
  const setSection = useGitHub((s) => s.setSection);

  const [scope, setScope] = useState<GitHostRepoScope>({ kind: 'mine' });
  const [orgs, setOrgs] = useState<GitHostOrg[]>([]);
  const [repos, setRepos] = useState<GitHostRepoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** True while showing results from a global search rather than `scope`. */
  const [searched, setSearched] = useState(false);
  const [clone, setClone] = useState<Clone | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    void gitHostOrgList()
      .then(setOrgs)
      .catch(() => {
        /* read:org may not be granted — the scope switcher just shows fewer options */
      });
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  const load = useCallback(async (next: GitHostRepoScope) => {
    setLoading(true);
    setError(null);
    setSearched(false);
    try {
      setRepos(await gitHostRepoList(next));
    } catch (e) {
      setError(String(e));
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  const searchAll = async () => {
    const q = filter.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      setRepos(await gitHostRepoSearch(q));
      setSearched(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const startClone = async (repo: GitHostRepoSummary) => {
    const parent = await fsPickFolder(useFiles.getState().root).catch(() => null);
    if (!parent) return;
    const sep = parent.includes('\\') ? '\\' : '/';
    const dest = `${parent.replace(/[\\/]+$/, '')}${sep}${repo.name}`;

    setClone({ state: 'running', repo: repo.full_name, line: 'Starting…' });
    try {
      const topic = await gitHostClone(repo.clone_url, dest);
      unlistenRef.current?.();
      unlistenRef.current = await onGitHostClone(topic, (ev) => {
        if (ev.kind === 'progress') {
          setClone({ state: 'running', repo: repo.full_name, line: ev.payload.line });
        } else if (ev.kind === 'done') {
          unlistenRef.current?.();
          unlistenRef.current = null;
          setClone({ state: 'done', repo: repo.full_name, path: ev.payload.path });
        } else {
          unlistenRef.current?.();
          unlistenRef.current = null;
          setClone({ state: 'failed', repo: repo.full_name, message: ev.payload.message });
        }
      });
    } catch (e) {
      setClone({ state: 'failed', repo: repo.full_name, message: String(e) });
    }
  };

  // Local filtering only applies to a scope listing; search results are
  // already the answer to what was typed.
  const needle = filter.trim().toLowerCase();
  const shown =
    searched || !needle
      ? repos
      : repos.filter(
          (r) =>
            r.full_name.toLowerCase().includes(needle) ||
            r.description.toLowerCase().includes(needle),
        );

  return (
    <div className="flex h-full flex-col">
      <FilterBar
        scope={scope}
        orgs={orgs}
        onScope={setScope}
        filter={filter}
        onFilter={setFilter}
        onSearchAll={() => void searchAll()}
        searched={searched}
        onClearSearch={() => {
          setFilter('');
          void load(scope);
        }}
        loading={loading}
      />

      {clone && <CloneBanner clone={clone} onDismiss={() => setClone(null)} />}

      {error && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-xl bg-status-err/[0.08] px-3 py-2 font-display text-xs text-status-err/90 ring-1 ring-inset ring-status-err/20">
          <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-status-err" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {shown.length === 0 && !loading && !error ? (
          <p className="px-2 py-8 text-center font-display text-xs text-fg-subtle">
            {searched
              ? `Nothing on GitHub matches "${filter.trim()}".`
              : needle
                ? `No repository here matches "${filter.trim()}". Press Enter to search all of GitHub.`
                : 'No repositories in this scope.'}
          </p>
        ) : (
          shown.map((r) => (
            <ListRow
              key={r.full_name}
              glyph={r.archived ? Archive : r.private ? Lock : r.fork ? GitFork : Book}
              title={r.full_name}
              title_={r.description || r.full_name}
              meta={metaLine(r)}
              selected={activeRepo === r.full_name}
              onClick={() => {
                setRepo(r.full_name);
                setSection('issues');
              }}
              hoverRight
              right={
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void startClone(r);
                  }}
                  aria-label={`Clone ${r.full_name}`}
                  title="Clone"
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 font-display text-2xs text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <Download size={11} strokeWidth={2} />
                  Clone
                </button>
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

/** The mono second line: language, stars, and when it was last pushed. */
function metaLine(r: GitHostRepoSummary): string {
  return meta(
    r.language,
    r.stars > 0 && `★ ${r.stars}`,
    r.pushed_at && relative(r.pushed_at),
    r.archived && 'archived',
  );
}

function FilterBar({
  scope,
  orgs,
  onScope,
  filter,
  onFilter,
  onSearchAll,
  searched,
  onClearSearch,
  loading,
}: {
  scope: GitHostRepoScope;
  orgs: GitHostOrg[];
  onScope: (s: GitHostRepoScope) => void;
  filter: string;
  onFilter: (v: string) => void;
  onSearchAll: () => void;
  searched: boolean;
  onClearSearch: () => void;
  loading: boolean;
}) {
  const chips: { key: string; label: string; scope: GitHostRepoScope }[] = [
    { key: 'mine', label: 'Yours', scope: { kind: 'mine' } },
    { key: 'starred', label: 'Starred', scope: { kind: 'starred' } },
    ...orgs.map((o) => ({
      key: `org:${o.login}`,
      label: o.login,
      scope: { kind: 'org' as const, name: o.login },
    })),
  ];
  const activeKey =
    scope.kind === 'org' ? `org:${scope.name}` : scope.kind;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => onScope(c.scope)}
            className={cn(
              'shrink-0 rounded-full px-2.5 py-1 font-display text-2xs transition-colors',
              'focus-visible:outline-none focus-visible:shadow-focus',
              !searched && activeKey === c.key
                ? 'bg-surface-2 text-fg-base'
                : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="relative w-52 shrink-0">
        <Search
          size={11}
          strokeWidth={2}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
        <input
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSearchAll()}
          placeholder="Filter, or Enter to search GitHub"
          spellCheck={false}
          className="h-7 w-full rounded-md bg-surface-1 pl-7 pr-7 font-display text-xs text-fg-base ring-1 ring-inset ring-edge-1 placeholder:text-fg-subtle/70 focus:outline-none focus:shadow-focus"
        />
        {searched && (
          <button
            onClick={onClearSearch}
            aria-label="Clear search"
            title="Back to your repositories"
            className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={10} strokeWidth={2.4} />
          </button>
        )}
      </div>

      {loading && <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />}
    </div>
  );
}

function CloneBanner({ clone, onDismiss }: { clone: Clone; onDismiss: () => void }) {
  const setRoot = useFiles((s) => s.setRoot);

  return (
    <div
      className={cn(
        'mx-3 mt-2 flex items-center gap-2.5 rounded-xl px-3 py-2 ring-1 ring-inset',
        clone.state === 'failed'
          ? 'bg-status-err/[0.08] ring-status-err/20'
          : 'bg-surface-1 ring-edge-1',
      )}
    >
      {clone.state === 'running' && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />
      )}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate font-display text-xs',
            clone.state === 'failed' ? 'text-status-err/90' : 'text-fg-base/90',
          )}
        >
          {clone.state === 'running' && `Cloning ${clone.repo}`}
          {clone.state === 'done' && `Cloned ${clone.repo}`}
          {clone.state === 'failed' && `Couldn't clone ${clone.repo}`}
        </p>
        <p className="truncate font-mono text-2xs text-fg-subtle">
          {clone.state === 'running' && clone.line}
          {clone.state === 'done' && clone.path}
          {clone.state === 'failed' && clone.message}
        </p>
      </div>

      {clone.state === 'done' && (
        <button
          onClick={() => {
            setRoot(clone.path);
            onDismiss();
          }}
          className="h-6 shrink-0 rounded-md bg-surface-2 px-2 font-display text-2xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-95 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Open workspace
        </button>
      )}

      {clone.state !== 'running' && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
        >
          <X size={11} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
