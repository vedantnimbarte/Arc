import { cn } from '../../lib/cn';
import type { GitLogEntry } from '../../lib/tauri';
import { colorForAuthor } from './AuthorsSidebar';

interface Props {
  commits: GitLogEntry[];
  emptyHint?: string;
}

export function CommitList({ commits, emptyHint }: Props) {
  if (commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 font-display text-[12px] text-fg-subtle">
        {emptyHint ?? 'No commits match the current filters.'}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <ul className="divide-y divide-border-hairline/60">
        {commits.map((c) => (
          <CommitRow key={c.oid} commit={c} />
        ))}
      </ul>
    </div>
  );
}

function CommitRow({ commit }: { commit: GitLogEntry }) {
  const isMerge = commit.parents.length > 1;
  return (
    <li
      className={cn(
        'group flex cursor-default items-center gap-3 px-4 py-2',
        'transition-colors hover:bg-white/[0.03]',
      )}
      title={commit.oid}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full ring-1 ring-black/40"
        style={{ background: colorForAuthor(commit.author, commit.email) }}
        aria-hidden
      />
      <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{commit.short}</span>
      <span className="min-w-0 flex-1 truncate font-display text-[12.5px] text-fg-base">
        {commit.subject || <span className="italic text-fg-subtle">(no subject)</span>}
      </span>
      {isMerge && (
        <span className="rounded-sm bg-white/[0.05] px-1.5 py-[1px] font-display text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
          merge
        </span>
      )}
      <span className="shrink-0 truncate font-display text-[11px] text-fg-muted" title={commit.email}>
        {commit.author}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle">
        {formatRelative(commit.time)}
      </span>
    </li>
  );
}

function formatRelative(unixSeconds: number): string {
  if (!unixSeconds) return '—';
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)}d`;
  if (diff < 365 * 86_400) return `${Math.floor(diff / (30 * 86_400))}mo`;
  return `${Math.floor(diff / (365 * 86_400))}y`;
}
