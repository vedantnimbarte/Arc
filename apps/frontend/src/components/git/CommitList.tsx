import { useState } from 'react';
import { GitMerge, RotateCcw, Scissors } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { GitLogEntry, GitResetMode } from '../../lib/tauri';
import { colorForAuthor } from './AuthorsSidebar';

interface Props {
  commits: GitLogEntry[];
  emptyHint?: string;
  onCherryPick?: (oid: string) => void;
  onRevert?: (oid: string) => void;
  onReset?: (oid: string, mode: GitResetMode) => void;
}

export function CommitList({ commits, emptyHint, onCherryPick, onRevert, onReset }: Props) {
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
          <CommitRow
            key={c.oid}
            commit={c}
            onCherryPick={onCherryPick}
            onRevert={onRevert}
            onReset={onReset}
          />
        ))}
      </ul>
    </div>
  );
}

function CommitRow({
  commit,
  onCherryPick,
  onRevert,
  onReset,
}: {
  commit: GitLogEntry;
  onCherryPick?: (oid: string) => void;
  onRevert?: (oid: string) => void;
  onReset?: (oid: string, mode: GitResetMode) => void;
}) {
  const isMerge = commit.parents.length > 1;
  const dotColor = colorForAuthor(commit.author, commit.email);
  const [resetMenuOpen, setResetMenuOpen] = useState(false);
  const hasActions = onCherryPick || onRevert || onReset;

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

      {/* Commit action buttons — visible on hover */}
      {hasActions && (
        <span className="relative flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onCherryPick && (
            <ActionBtn
              title="Cherry-pick this commit onto HEAD"
              onClick={() => onCherryPick(commit.oid)}
            >
              <Scissors size={11} strokeWidth={2} />
            </ActionBtn>
          )}
          {onRevert && (
            <ActionBtn
              title="Revert: create an undo commit"
              onClick={() => onRevert(commit.oid)}
            >
              <RotateCcw size={11} strokeWidth={2} />
            </ActionBtn>
          )}
          {onReset && (
            <div className="relative">
              <ActionBtn
                title="Reset HEAD to this commit"
                onClick={() => setResetMenuOpen((o) => !o)}
              >
                <span className="font-mono text-[9px] font-bold">↩</span>
              </ActionBtn>
              {resetMenuOpen && (
                <div
                  className="absolute right-0 top-full z-50 mt-1 w-32 rounded-lg border border-border-hairline bg-bg-surface shadow-xl ring-1 ring-white/[0.04]"
                  onMouseLeave={() => setResetMenuOpen(false)}
                >
                  {(['soft', 'mixed', 'hard'] as GitResetMode[]).map((m) => (
                    <button
                      key={m}
                      onClick={() => { onReset(commit.oid, m); setResetMenuOpen(false); }}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 font-sans text-[11px] text-fg-base transition hover:bg-white/[0.06]',
                        m === 'hard' && 'text-red-400 hover:text-red-300',
                      )}
                    >
                      <span className="w-10 font-mono text-[10px] text-fg-subtle">{m}</span>
                      <span className="text-fg-muted text-[10px]">
                        {m === 'soft' ? 'keep staged' : m === 'mixed' ? 'keep files' : 'discard all'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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

function ActionBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-white/[0.1] hover:text-fg-base"
    >
      {children}
    </button>
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
