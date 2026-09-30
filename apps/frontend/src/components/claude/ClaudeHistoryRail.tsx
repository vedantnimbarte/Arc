import { useMemo, useState } from 'react';
import { PanelLeftClose, Plus, Search, Trash2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { claudeSessionDelete, type ClaudeSessionMeta } from '../../lib/tauri';
import { sessionBusyElsewhere } from '../../state/claudeCode';
import { askConfirm } from '../../state/confirm';
import { toastError } from '../../state/toast';

export interface SessionGroup {
  label: string;
  items: ClaudeSessionMeta[];
}

/** Bucket conversations by local calendar day, newest group first. Input is
 *  already newest-first, so each bucket stays in order. */
export function groupByDate(items: ClaudeSessionMeta[], now: Date): SessionGroup[] {
  const day = 86_400_000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const labels = ['Today', 'Yesterday', 'Last 7 days', 'Older'] as const;
  const buckets: ClaudeSessionMeta[][] = [[], [], [], []];
  for (const s of items) {
    const i =
      s.updatedAt >= today ? 0 : s.updatedAt >= today - day ? 1 : s.updatedAt >= today - 7 * day ? 2 : 3;
    buckets[i]!.push(s);
  }
  return labels
    .map((label, i) => ({ label, items: buckets[i]! }))
    .filter((g) => g.items.length > 0);
}

export function sessionLabel(s: ClaudeSessionMeta): string {
  return s.title || s.firstPrompt || 'Untitled conversation';
}

/**
 * The window's conversation list: every session the CLI recorded for this
 * folder, including ones started from a terminal. Search is client-side — a
 * folder rarely holds more than a few hundred sessions.
 */
export function ClaudeHistoryRail({
  cwd,
  sessions,
  activeId,
  busy,
  onOpen,
  onNew,
  onDeleted,
  onHide,
}: {
  cwd: string | null;
  sessions: ClaudeSessionMeta[];
  activeId: string | null;
  /** This window is mid-turn: switching conversation would orphan it. */
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDeleted: (id: string) => void;
  onHide: () => void;
}) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? sessions.filter((s) =>
          `${s.title ?? ''}\n${s.firstPrompt ?? ''}`.toLowerCase().includes(q),
        )
      : sessions;
    return groupByDate(hits, new Date());
  }, [sessions, query]);

  const remove = async (s: ClaudeSessionMeta) => {
    if (!cwd) return;
    if (sessionBusyElsewhere(s.id) || (busy && s.id === activeId)) return;
    const ok = await askConfirm({
      title: 'Delete conversation?',
      body: `“${sessionLabel(s)}” is removed from ~/.claude. \`claude --resume\` won't find it either.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await claudeSessionDelete(cwd, s.id);
      onDeleted(s.id);
    } catch (e) {
      toastError(`Couldn't delete the conversation: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <aside
      aria-label="Conversations"
      className="flex w-64 shrink-0 flex-col border-r border-border-hairline bg-bg-chrome"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-surface-1 px-2 ring-1 ring-edge-1 focus-within:ring-accent/40">
          <Search size={12} strokeWidth={2} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search conversations"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-display text-sm text-fg-base placeholder:text-fg-subtle focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide conversations"
          title="Hide conversations"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <PanelLeftClose size={14} strokeWidth={1.9} />
        </button>
      </div>

      <button
        type="button"
        onClick={onNew}
        disabled={busy}
        className="mx-2 mt-2 flex h-8 shrink-0 items-center gap-2 rounded-md px-2 font-display text-sm text-fg-base transition-colors hover:bg-surface-2 disabled:opacity-40"
      >
        <Plus size={14} strokeWidth={2} className="text-fg-muted" />
        New chat
      </button>

      <nav className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && (
          <p className="px-2 py-4 font-display text-xs leading-relaxed text-fg-subtle">
            {query ? 'No conversation matches.' : 'No conversations in this folder yet.'}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.label} className="mt-3 first:mt-2">
            <h3 className="px-2 pb-1 font-display text-2xs text-fg-subtle">{g.label}</h3>
            <ul>
              {g.items.map((s) => {
                const active = s.id === activeId;
                return (
                  <li key={s.id} className="group/row relative">
                    <button
                      type="button"
                      onClick={() => onOpen(s.id)}
                      disabled={busy && !active}
                      aria-current={active ? 'true' : undefined}
                      title={s.firstPrompt ?? undefined}
                      className={cn(
                        'flex h-8 w-full items-center rounded-md pl-2 pr-8 text-left font-display text-sm transition-colors disabled:opacity-50',
                        active
                          ? 'bg-surface-3 text-fg-base shadow-[inset_2px_0_0_rgb(var(--accent,200_202_208))]'
                          : 'text-fg-muted hover:bg-surface-2 hover:text-fg-base',
                      )}
                    >
                      <span className="truncate">{sessionLabel(s)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(s)}
                      aria-label={`Delete ${sessionLabel(s)}`}
                      title="Delete conversation"
                      className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-status-err/15 hover:text-status-err focus-visible:flex group-hover/row:flex"
                    >
                      <Trash2 size={12} strokeWidth={1.9} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
    </aside>
  );
}
