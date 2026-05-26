import { GitMerge } from 'lucide-react';
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
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
        <span className="mb-3 h-10 w-10 rounded-full bg-white/[0.03] ring-1 ring-white/[0.04]" aria-hidden />
        <p className="font-display text-[12px] text-fg-subtle">
          {emptyHint ?? 'No commits match the current filters.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1.5">
      <ul className="flex flex-col gap-px">
        {commits.map((c) => (
          <CommitRow key={c.oid} commit={c} />
        ))}
      </ul>
    </div>
  );
}

function CommitRow({ commit }: { commit: GitLogEntry }) {
  const isMerge = commit.parents.length > 1;
  const dotColor = colorForAuthor(commit.author, commit.email);
  return (
    <li
      className={cn(
        'group relative flex cursor-default items-center gap-3 rounded-lg px-3 py-2',
        'transition-all duration-150 hover:bg-white/[0.035] hover:ring-1 hover:ring-inset hover:ring-white/[0.04]',
      )}
      title={commit.oid}
    >
      <span className="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden>
        <span
          className="absolute h-3 w-3 rounded-full opacity-30 blur-[3px] transition-opacity duration-200 group-hover:opacity-60"
          style={{ background: dotColor }}
        />
        <span
          className="relative h-2 w-2 rounded-full ring-1 ring-black/50"
          style={{ background: dotColor }}
        />
      </span>
      <span className="shrink-0 rounded-md bg-white/[0.035] px-1.5 py-[1px] font-mono text-[10.5px] text-fg-muted ring-1 ring-inset ring-white/[0.03] transition-colors group-hover:bg-white/[0.06] group-hover:text-fg-base">
        {commit.short}
      </span>
      <span className="min-w-0 flex-1 truncate font-display text-[12.5px] text-fg-base">
        {commit.subject || <span className="italic text-fg-subtle">(no subject)</span>}
      </span>
      <DiffStat additions={commit.additions} deletions={commit.deletions} />
      {isMerge && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/[0.05] px-2 py-[1px] font-display text-[9.5px] uppercase tracking-widest2 text-fg-subtle ring-1 ring-inset ring-white/[0.04]">
          <GitMerge size={9} strokeWidth={2.2} />
          merge
        </span>
      )}
      <span
        className="shrink-0 truncate font-display text-[11px] text-fg-muted"
        title={commit.email}
        style={{ maxWidth: 140 }}
      >
        {commit.author}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle">
        {formatRelative(commit.time)}
      </span>
    </li>
  );
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums">
      {additions > 0 && (
        <span className="rounded px-1 py-[1px] text-[#3ad28a] ring-1 ring-inset ring-[#3ad28a]/20 bg-[#3ad28a]/[0.07]">
          +{additions}
        </span>
      )}
      {deletions > 0 && (
        <span className="rounded px-1 py-[1px] text-[#ff5252] ring-1 ring-inset ring-[#ff5252]/20 bg-[#ff5252]/[0.07]">
          -{deletions}
        </span>
      )}
    </span>
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
