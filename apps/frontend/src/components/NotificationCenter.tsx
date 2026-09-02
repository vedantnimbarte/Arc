import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellOff, Check, Settings2, X } from 'lucide-react';
import {
  NOTIFICATION_SOURCES,
  SOURCE_LABELS,
  unreadCount,
  useNotifications,
  type ArcNotification,
  type NotificationSource,
} from '../state/notifications';
import { useSettings } from '../state/settings';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { Tooltip } from './Tooltip';
import { cn } from '../lib/cn';

const PANEL_W = 340;
/** Approximate rendered height, used only to keep the panel on screen. */
const PANEL_H = 460;

/** Per-source accent, drawn from the same palette everything else uses. */
const SOURCE_HUE: Record<NotificationSource, string> = {
  agent: '#ff8a5b',
  command: '#9aa3b5',
  checks: '#f0b056',
  git: '#5b9dff',
  update: '#3ad28a',
};

/** "just now", "4m", "2h" — a notification list is read by recency, not clock
 *  time, and a timestamp would be the widest column for the least information. */
export function relativeTime(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The bell in the top bar and the panel behind it.
 *
 * Notifications are session-only by design: this answers "what happened while
 * I was looking elsewhere", and an agent run from three days ago is not that.
 */
export function NotificationCenter() {
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const markRead = useNotifications((s) => s.markRead);
  const dismiss = useNotifications((s) => s.dismiss);
  const clear = useNotifications((s) => s.clear);
  const setActive = useWorkspace((s) => s.setActive);
  const showSidebarView = useFiles((s) => s.showSidebarView);

  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = unreadCount(items);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      setManaging(false);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - PANEL_H - 8)),
        // Right-aligned to the bell: it sits near the window's right edge, so
        // anchoring left would run the panel off-screen.
        left: Math.max(8, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 8)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (managing) setManaging(false);
      else setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, managing]);

  // Opening the panel is reading it. Deferred a beat so the unread accents are
  // still visible on the frame the user actually looks at.
  useEffect(() => {
    if (!open || unread === 0) return;
    const t = setTimeout(markAllRead, 1200);
    return () => clearTimeout(t);
  }, [open, unread, markAllRead]);

  /** Go to whatever the notification is about, and close. */
  const goTo = (n: ArcNotification) => {
    markRead(n.id);
    if (n.target?.kind === 'tab') setActive(n.target.tabId);
    else if (n.target?.kind === 'sidebar') showSidebarView(n.target.view);
    setOpen(false);
  };

  return (
    <>
      <Tooltip
        align="end"
        label={unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
      >
        <button
          ref={btnRef}
          onClick={() => setOpen((o) => !o)}
          aria-label="Notifications"
          aria-expanded={open}
          className={cn(
            'group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
            'transition-all duration-200 ease-apple',
            open
              ? 'bg-surface-3 text-fg-base'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg-base active:bg-surface-3',
          )}
        >
          <Bell size={14} strokeWidth={1.9} />
          {unread > 0 && (
            // A count past nine stops being a number you read and becomes a
            // shape you notice, so it caps.
            <span
              className={cn(
                'absolute -right-0.5 -top-0.5 flex h-[13px] min-w-[13px] items-center justify-center',
                'rounded-full bg-accent px-[3px] font-display text-[9px] font-bold leading-none',
                'text-bg-base tabular-nums',
              )}
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </Tooltip>

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W }}
            className="material-sheet z-50 flex max-h-[calc(100vh-16px)] animate-popover-in flex-col overflow-hidden rounded-lg bg-bg-panel shadow-sheet ring-1 ring-edge-2"
          >
            <header className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline px-3 py-2">
              <h2 className="flex-1 font-display text-sm font-semibold tracking-tight text-fg-base">
                Notifications
              </h2>
              <button
                onClick={() => setManaging((m) => !m)}
                aria-label="Manage notifications"
                aria-pressed={managing}
                title="Choose what notifies you"
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
                  managing
                    ? 'bg-surface-3 text-fg-base'
                    : 'text-fg-subtle hover:bg-surface-2 hover:text-fg-base',
                )}
              >
                <Settings2 size={12} strokeWidth={2} />
              </button>
              {items.length > 0 && (
                <button
                  onClick={clear}
                  className="rounded-md px-1.5 py-0.5 font-display text-2xs text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
                >
                  Clear
                </button>
              )}
            </header>

            {managing ? (
              <SourceSettings />
            ) : items.length === 0 ? (
              <p className="px-3 py-8 text-center font-display text-xs text-fg-subtle">
                Nothing yet. Agent turns, slow commands, checker runs and git
                operations show up here.
              </p>
            ) : (
              <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto py-1">
                {items.map((n) => (
                  <Row key={n.id} n={n} onGo={goTo} onDismiss={dismiss} />
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function Row({
  n,
  onGo,
  onDismiss,
}: {
  n: ArcNotification;
  onGo: (n: ArcNotification) => void;
  onDismiss: (id: number) => void;
}) {
  const clickable = !!n.target;
  return (
    <div
      className={cn(
        'group/row flex items-start gap-2 px-3 py-2 transition-colors',
        clickable && 'cursor-pointer hover:bg-surface-2',
      )}
      onClick={clickable ? () => onGo(n) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onGo(n);
              }
            }
          : undefined
      }
    >
      {/* Unread is carried by a filled dot in the source's hue; read rows keep
          the hue but hollow, so the list stays scannable by source either way. */}
      <span
        aria-hidden
        className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
        style={
          n.read
            ? { boxShadow: `inset 0 0 0 1.5px ${SOURCE_HUE[n.source]}88` }
            : { background: n.tone === 'error' ? '#ff6f8d' : SOURCE_HUE[n.source] }
        }
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'font-display text-xs leading-snug tracking-tight',
            n.read ? 'text-fg-muted' : 'text-fg-base',
          )}
        >
          {n.title}
        </div>
        {n.body && (
          <div className="truncate font-mono text-2xs text-fg-subtle">{n.body}</div>
        )}
      </div>
      <span className="shrink-0 pt-0.5 font-display text-2xs tabular-nums text-fg-subtle/80 group-hover/row:hidden">
        {relativeTime(n.at)}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(n.id);
        }}
        aria-label="Dismiss"
        className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg-base group-hover/row:flex"
      >
        <X size={10} strokeWidth={2.4} />
      </button>
    </div>
  );
}

/** Which sources notify, and which may interrupt with an OS notification. */
function SourceSettings() {
  const muted = useSettings((s) => s.notifyMuted);
  const os = useSettings((s) => s.notifyOs);
  const setSourceMuted = useSettings((s) => s.setSourceMuted);
  const setSourceOs = useSettings((s) => s.setSourceOs);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <p className="pb-2 font-display text-2xs leading-relaxed text-fg-subtle">
        Everything unmuted lands in this panel. The bell column also raises a
        system notification, but only while ARC is in the background.
      </p>
      {/* No wide tracking on the column heads: at 32px they would overrun
          their boxes and run into each other. */}
      <div className="flex items-center gap-2 pb-1 font-display text-2xs uppercase text-fg-subtle/70">
        <span className="flex-1 tracking-[0.14em]">Source</span>
        <span className="w-8 text-center">Panel</span>
        <span className="w-8 text-center">Alert</span>
      </div>
      {NOTIFICATION_SOURCES.map((source) => {
        const isMuted = muted.includes(source);
        const isOs = os.includes(source);
        return (
          <div key={source} className="flex items-center gap-2 py-1">
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ background: SOURCE_HUE[source] }}
              />
            </span>
            <span className="flex-1 font-display text-xs text-fg-base/90">
              {SOURCE_LABELS[source]}
            </span>
            <Toggle
              on={!isMuted}
              onClick={() => setSourceMuted(source, !isMuted)}
              label={`${SOURCE_LABELS[source]} in the panel`}
              icon={isMuted ? <BellOff size={11} strokeWidth={2} /> : <Check size={11} strokeWidth={2.4} />}
            />
            <Toggle
              on={isOs && !isMuted}
              disabled={isMuted}
              onClick={() => setSourceOs(source, !isOs)}
              label={`${SOURCE_LABELS[source]} as a system notification`}
              icon={<Bell size={10} strokeWidth={2.2} />}
            />
          </div>
        );
      })}
    </div>
  );
}

function Toggle({
  on,
  disabled,
  onClick,
  label,
  icon,
}: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={on}
      className={cn(
        'flex h-6 w-8 items-center justify-center rounded-md transition-all duration-150 ease-apple',
        'disabled:opacity-30',
        on
          ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30'
          : 'text-fg-subtle hover:bg-surface-2 hover:text-fg-muted',
      )}
    >
      {icon}
    </button>
  );
}
