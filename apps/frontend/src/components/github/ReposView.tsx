import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CircleDot, Download, FolderOpen, GitFork, Lock, Search, Star, X } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  fsPickFolder,
  gitHostClone,
  gitHostOrgList,
  gitHostRepoList,
  gitHostRepoSearch,
  gitStatus,
  onGitHostClone,
  type GitHostOrg,
  type GitHostRepoScope,
  type GitHostRepoSummary,
} from '../../lib/tauri';
import { useFiles } from '../../state/files';
import { useGitHub } from '../../state/github';
import { cn } from '../../lib/cn';
import { Select } from '../Select';
import { languageColor } from './format';
import {
  BranchChip,
  Count,
  EmptyNote,
  ErrorTray,
  Fact,
  Loading,
  StateFilter,
  Toolbar,
  ago,
  buttonGhost,
  buttonQuiet,
} from './parts';

/** A clone in flight, or the result of the last one. */
type Clone =
  | { state: 'running'; repo: string; line: string }
  | { state: 'done'; repo: string; path: string }
  | { state: 'failed'; repo: string; message: string };

type Sort = 'pushed' | 'name' | 'stars';

export function ReposView() {
  const activeRepo = useGitHub((s) => s.repo);
  const setRepo = useGitHub((s) => s.setRepo);
  const setSection = useGitHub((s) => s.setSection);
  const clones = useGitHub((s) => s.clones);

  const [scope, setScope] = useState<GitHostRepoScope>({ kind: 'mine' });
  const [orgs, setOrgs] = useState<GitHostOrg[]>([]);
  const [repos, setRepos] = useState<GitHostRepoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort>('pushed');
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
          useGitHub.getState().rememberClone(repo.full_name, ev.payload.path);
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

  /** Open a known clone as the workspace — after checking it's still there,
   *  since the folder may have been moved or deleted outside Arc. */
  const openClone = async (repo: GitHostRepoSummary, path: string) => {
    const info = await gitStatus(path).catch(() => null);
    if (!info) {
      useGitHub.getState().forgetClone(repo.full_name);
      setError(`${repo.full_name} is no longer at ${path}. Clone it again to work on it here.`);
      return;
    }
    setRepo(repo.full_name);
    useFiles.getState().setRoot(path);
  };

  // Local filtering only applies to a scope listing; search results are
  // already the answer to what was typed.
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    const list =
      searched || !needle
        ? repos
        : repos.filter(
            (r) =>
              r.full_name.toLowerCase().includes(needle) ||
              r.description.toLowerCase().includes(needle),
          );
    if (searched) return list; // GitHub's own relevance order
    const sorted = [...list];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'stars') sorted.sort((a, b) => b.stars - a.stars);
    else sorted.sort((a, b) => Date.parse(b.pushed_at || '0') - Date.parse(a.pushed_at || '0'));
    return sorted;
  }, [repos, needle, searched, sort]);

  const scopes = [
    { value: 'mine', label: 'Yours' },
    { value: 'starred', label: 'Starred' },
    ...orgs.map((o) => ({ value: `org:${o.login}`, label: o.login })),
  ];
  const scopeKey = scope.kind === 'org' ? `org:${scope.name}` : scope.kind;

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <div className="min-w-0 overflow-x-auto">
          <StateFilter
            value={searched ? '' : scopeKey}
            onChange={(v) =>
              setScope(
                v.startsWith('org:')
                  ? { kind: 'org', name: v.slice(4) }
                  : { kind: v as 'mine' | 'starred' },
              )
            }
            options={scopes}
          />
        </div>
        {!loading && <Count n={shown.length} one="repository" many="repositories" />}

        <div className="flex-1" />

        {!searched && (
          <Select
            value={sort}
            onChange={setSort}
            ariaLabel="Sort repositories"
            size="compact"
            className="w-auto"
            options={[
              { value: 'pushed', label: 'Recently pushed' },
              { value: 'name', label: 'Name' },
              { value: 'stars', label: 'Stars' },
            ]}
          />
        )}

        <div className="relative w-64 shrink-0">
          <Search
            size={12}
            strokeWidth={2}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void searchAll()}
            placeholder="Filter, or Enter to search GitHub"
            aria-label="Filter repositories"
            spellCheck={false}
            className="h-7 w-full rounded-md bg-surface-1 pl-8 pr-7 font-display text-xs text-fg-base ring-1 ring-inset ring-edge-1 placeholder:text-fg-subtle/70 focus:outline-none focus:shadow-focus"
          />
          {searched && (
            <button
              onClick={() => {
                setFilter('');
                void load(scope);
              }}
              aria-label="Clear search"
              title="Back to your repositories"
              className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
            >
              <X size={10} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </Toolbar>

      {(clone || error) && (
        <div className="space-y-2 px-4 pt-3">
          {clone && <CloneBanner clone={clone} onDismiss={() => setClone(null)} />}
          {error && <ErrorTray message={error} />}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {shown.length === 0 ? (
          loading ? (
            <Loading />
          ) : (
            !error && (
              <EmptyNote>
                {searched
                  ? `Nothing on GitHub matches "${filter.trim()}".`
                  : needle
                    ? `No repository here matches "${filter.trim()}". Press Enter to search all of GitHub.`
                    : 'No repositories in this scope.'}
              </EmptyNote>
            )
          )
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
            {shown.map((r) => (
              <RepoCard
                key={r.full_name}
                repo={r}
                active={activeRepo === r.full_name}
                localPath={clones[r.full_name.toLowerCase()]}
                cloning={clone?.state === 'running' && clone.repo === r.full_name}
                onPick={() => {
                  setRepo(r.full_name);
                  setSection('issues');
                }}
                onClone={() => void startClone(r)}
                onOpen={(path) => void openClone(r, path)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One repository, drawn as a branch lane: a stripe in the repo's language
 * colour with a node at the top, the way a git client draws a branch. The
 * whole card picks the repo; the one button does the local thing — open the
 * clone if Arc knows where it is, clone it if not.
 */
function RepoCard({
  repo,
  active,
  localPath,
  cloning,
  onPick,
  onClone,
  onOpen,
}: {
  repo: GitHostRepoSummary;
  active: boolean;
  localPath: string | undefined;
  cloning: boolean;
  onPick: () => void;
  onClone: () => void;
  onOpen: (path: string) => void;
}) {
  const color = languageColor(repo.language);
  const viewerLogin = useGitHub((s) => s.viewer?.login);

  return (
    <div
      className={cn(
        'group relative flex min-h-[148px] rounded-lg ring-1 ring-inset transition-colors duration-150',
        active
          ? 'bg-surface-2 ring-accent/50'
          : 'bg-surface-1 ring-edge-1 hover:bg-surface-2 hover:ring-edge-2',
        repo.archived && 'opacity-60',
      )}
    >
      {/* The card's main action covers it; the clone button sits above. */}
      <button
        onClick={onPick}
        aria-label={`Show issues for ${repo.full_name}`}
        title={repo.description || repo.full_name}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:shadow-focus"
      />

      <span className="flex w-8 shrink-0 flex-col items-center pt-[18px]" aria-hidden>
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color, boxShadow: `0 0 0 3px ${color}33` }}
        />
        <span
          className="mt-1.5 mb-3.5 w-[2px] flex-1 rounded-full"
          style={{ background: `linear-gradient(${color}aa, ${color}26)` }}
        />
      </span>

      <div className="pointer-events-none flex min-w-0 flex-1 flex-col py-3.5 pr-3.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {/* The owner only says something when it isn't you. */}
            {repo.owner !== viewerLogin && (
              <p className="truncate font-mono text-2xs text-fg-subtle">{repo.owner}</p>
            )}
            <h3 className="truncate pt-0.5 font-display text-sm font-semibold tracking-tight text-fg-base">
              {repo.name}
            </h3>
          </div>

          <div className="pointer-events-auto relative">
            {cloning ? (
              <span className={cn(buttonGhost, 'pointer-events-none')}>
                <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent" />
                Cloning
              </span>
            ) : localPath ? (
              <button
                onClick={() => onOpen(localPath)}
                title={`Open ${localPath}`}
                className={buttonQuiet}
              >
                <FolderOpen size={12} strokeWidth={2} />
                Open
              </button>
            ) : (
              <button onClick={onClone} title={`Clone ${repo.full_name}`} className={buttonGhost}>
                <Download size={12} strokeWidth={2} />
                Clone
              </button>
            )}
          </div>
        </div>

        <p
          className={cn(
            'mt-1.5 line-clamp-2 font-display text-xs leading-relaxed',
            repo.description ? 'text-fg-muted' : 'italic text-fg-subtle',
          )}
        >
          {repo.description || 'No description'}
        </p>
        <div className="flex-1" />

        <div className="mt-3 flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap">
          {repo.default_branch && (
            <span className="flex shrink-0">
              <BranchChip name={repo.default_branch} />
            </span>
          )}
          {repo.language && (
            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-2xs text-fg-muted">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              {repo.language}
            </span>
          )}
          {repo.stars > 0 && <Fact icon={Star}>{repo.stars}</Fact>}
          {repo.open_issues > 0 && <Fact icon={CircleDot}>{repo.open_issues}</Fact>}
          {repo.pushed_at && <Fact>{ago(repo.pushed_at)}</Fact>}
          <div className="flex-1" />
          <Visibility repo={repo} />
          {localPath && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-ok"
              title={`Cloned at ${localPath}`}
              aria-label="Cloned on this machine"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Visibility({ repo }: { repo: GitHostRepoSummary }) {
  const [Icon, label] = repo.archived
    ? [Archive, 'Archived']
    : repo.private
      ? [Lock, 'Private']
      : repo.fork
        ? [GitFork, 'Fork']
        : [null, null];
  if (!Icon) return null;
  return (
    <span className="inline-flex shrink-0 text-fg-subtle" title={label} aria-label={label}>
      <Icon size={12} strokeWidth={2} />
    </span>
  );
}

function CloneBanner({ clone, onDismiss }: { clone: Clone; onDismiss: () => void }) {
  const setRoot = useFiles((s) => s.setRoot);

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-3 py-2 ring-1 ring-inset',
        clone.state === 'failed'
          ? 'bg-status-err/[0.08] ring-status-err/20'
          : clone.state === 'done'
            ? 'bg-status-ok/[0.07] ring-status-ok/20'
            : 'bg-surface-1 ring-edge-1',
      )}
    >
      {clone.state === 'running' && (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent" />
      )}
      {clone.state === 'done' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-ok" />}

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate font-display text-xs font-medium',
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
          className={buttonQuiet}
        >
          <FolderOpen size={12} strokeWidth={2} />
          Open workspace
        </button>
      )}

      {clone.state !== 'running' && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
