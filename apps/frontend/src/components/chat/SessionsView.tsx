import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  MessageSquarePlus,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { useChat, type ChatSession } from '../../state/chat';
import {
  AGENT_ICONS,
  AGENT_TINTS,
  getAgentById,
} from '../../state/agents';
import { cn } from '../../lib/cn';

interface Props {
  /** Called when the user picks a session or hits Back. */
  onBack: () => void;
  /** New chat with the current/active agent. */
  onNewSession: () => void;
}

const ONE_DAY = 24 * 60 * 60 * 1000;

function groupKey(session: ChatSession, now: number): string {
  const ageMs = now - session.updatedAt;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday.getTime() - ONE_DAY;
  if (session.updatedAt >= startOfToday.getTime()) return 'Today';
  if (session.updatedAt >= startOfYesterday) return 'Yesterday';
  if (ageMs < 7 * ONE_DAY) return 'This week';
  if (ageMs < 30 * ONE_DAY) return 'This month';
  return 'Older';
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

function formatTime(ts: number, now: number): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function previewOf(session: ChatSession): string {
  // Skip system rows; show whichever side spoke first that has content.
  const m = session.messages.find((x) => x.role !== 'system' && x.content);
  return m ? m.content.replace(/\s+/g, ' ').slice(0, 96) : 'No messages yet';
}

export function SessionsView({ onBack, onNewSession }: Props) {
  const sessions = useChat((s) => s.sessions);
  const activeId = useChat((s) => s.activeSessionId);
  const setActive = useChat((s) => s.setActiveSession);
  const deleteSession = useChat((s) => s.deleteSession);
  const renameSession = useChat((s) => s.renameSession);

  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const grouped = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ChatSession[]>();
    for (const s of filtered) {
      const key = groupKey(s, now);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    // Sessions within a bucket: newest first.
    for (const list of map.values()) {
      list.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    // Order buckets explicitly so visual rhythm is predictable.
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      label: g,
      items: map.get(g)!,
    }));
  }, [filtered]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sub-header — back button on the left, new-chat CTA on the right.
          Keeps the popover anchored to one "primary action" so the user
          never has to hunt for "how do I start a fresh thread". */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-hairline/70 px-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-display text-[11.5px] tracking-tight text-fg-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg-base"
          aria-label="Back to chat"
        >
          <ArrowLeft size={12} strokeWidth={2.2} />
          <span>Conversations</span>
        </button>
        <button
          onClick={onNewSession}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 font-display text-[11px] font-medium tracking-tight',
            'bg-white/[0.06] text-fg-base ring-1 ring-white/[0.06]',
            'transition-all duration-150 ease-apple',
            'hover:bg-white/[0.10] hover:ring-white/[0.12]',
            'active:scale-[0.97]',
          )}
        >
          <MessageSquarePlus size={11} strokeWidth={2.2} />
          New chat
        </button>
      </div>

      {/* Search */}
      <div className="shrink-0 px-3 pb-2 pt-3">
        <div className="flex items-center gap-1.5 rounded-md border border-white/[0.05] bg-black/[0.22] px-2 py-1.5 focus-within:border-accent/40 focus-within:shadow-focus">
          <Search size={11} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="selectable min-w-0 flex-1 bg-transparent font-display text-[12px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
          />
        </div>
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {grouped.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="font-display text-[12px] tracking-tight text-fg-muted">
              {query ? 'No matches.' : 'No conversations yet.'}
            </p>
          </div>
        ) : (
          grouped.map((group, gi) => (
            <div key={group.label} className={cn(gi > 0 && 'mt-3')}>
              <div className="px-2 pb-1 pt-1 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
                {group.label}
              </div>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeId}
                    renaming={renamingId === s.id}
                    onPick={() => {
                      setActive(s.id);
                      onBack();
                    }}
                    onStartRename={() => setRenamingId(s.id)}
                    onCommitRename={(title) => {
                      renameSession(s.id, title);
                      setRenamingId(null);
                    }}
                    onCancelRename={() => setRenamingId(null)}
                    onDelete={() => deleteSession(s.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  renaming,
  onPick,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  renaming: boolean;
  onPick: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const agent = getAgentById(session.agentId);
  const tint = AGENT_TINTS[agent.tint];
  const Icon = AGENT_ICONS[agent.iconKey];
  const now = Date.now();
  return (
    <li
      className={cn(
        'group relative flex items-start gap-2 rounded-md px-2 py-2',
        'transition-colors duration-150',
        active
          ? 'bg-white/[0.07] ring-1 ring-inset ring-white/[0.07]'
          : 'hover:bg-white/[0.04]',
      )}
    >
      <button
        onClick={renaming ? undefined : onPick}
        onDoubleClick={onStartRename}
        disabled={renaming}
        className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-default"
      >
        <span
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1',
            tint.chipBg,
            tint.chipFg,
            tint.chipRing,
          )}
        >
          <Icon size={10} strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            {renaming ? (
              <RenameInput
                initial={session.title}
                onCommit={onCommitRename}
                onCancel={onCancelRename}
              />
            ) : (
              <span
                className={cn(
                  'truncate font-display text-[12px] font-medium tracking-tight',
                  active ? 'text-fg-base' : 'text-fg-base/90',
                )}
              >
                {session.title}
              </span>
            )}
            <span className="shrink-0 font-mono text-[9.5px] text-fg-subtle">
              {formatTime(session.updatedAt, now)}
            </span>
          </div>
          <p className="mt-0.5 truncate font-display text-[11px] tracking-tight text-fg-muted">
            {previewOf(session)}
          </p>
        </div>
      </button>
      {!renaming && (
        <div className="mt-0.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStartRename();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-white/[0.10] hover:text-fg-base"
            aria-label={`Rename "${session.title}"`}
            title="Rename"
          >
            <Pencil size={10} strokeWidth={2.1} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-status-err/15 hover:text-status-err"
            aria-label={`Delete "${session.title}"`}
            title="Delete conversation"
          >
            <Trash2 size={11} strokeWidth={2.1} />
          </button>
        </div>
      )}
    </li>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  // Select-on-mount so the user can just type to replace.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === initial) {
      onCancel();
      return;
    }
    onCommit(next);
  };

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="min-w-0 flex-1 rounded-sm border border-accent/40 bg-bg-base/70 px-1 py-px font-display text-[12px] font-medium tracking-tight text-fg-base outline-none shadow-focus"
    />
  );
}
