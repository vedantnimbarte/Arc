import { create } from 'zustand';
import type { SidebarView } from './files';

/**
 * Where a notification came from. Each is independently mutable and can
 * independently raise an OS notification, so the set is deliberately small —
 * a taxonomy with fifteen entries is one nobody configures.
 */
export type NotificationSource = 'agent' | 'command' | 'checks' | 'git' | 'update';

export const NOTIFICATION_SOURCES: NotificationSource[] = [
  'agent',
  'command',
  'checks',
  'git',
  'update',
];

/** Label for the mute list. Named for what the user recognises, not the store. */
export const SOURCE_LABELS: Record<NotificationSource, string> = {
  agent: 'Agents',
  command: 'Commands',
  checks: 'Checkers',
  git: 'Git',
  update: 'Updates',
};

/** What clicking a notification focuses. Absent when there is nowhere to go. */
export type NotificationTarget =
  | { kind: 'tab'; tabId: string }
  | { kind: 'sidebar'; view: SidebarView };

export interface ArcNotification {
  id: number;
  source: NotificationSource;
  /** One line. Says what happened, not that something happened. */
  title: string;
  /** Optional detail — a command, a file count, an error. */
  body?: string;
  at: number;
  read: boolean;
  target?: NotificationTarget;
  /** Whether this one is a problem. Drives the row's accent only. */
  tone?: 'error';
}

/** What a caller supplies; the store owns id, timestamp and read state. */
export type NewNotification = Omit<ArcNotification, 'id' | 'at' | 'read'>;

/**
 * How many are kept. Past this the oldest fall off: the panel answers "what
 * happened while I was away", and nobody scrolls to the two hundredth entry.
 */
export const MAX_NOTIFICATIONS = 100;

/**
 * Collapse a repeat of the most recent notification into it.
 *
 * An agent that rings the bell three times in a row, or a checker re-run that
 * reports the same thing, should not push three identical rows. Only the head
 * is considered — a genuinely interleaved repeat is a separate event and reads
 * as one.
 *
 * Exported for tests: the dedupe window is the difference between a useful
 * panel and a wall of "Claude Code finished".
 */
export function isRepeatOf(head: ArcNotification | undefined, next: NewNotification): boolean {
  return (
    !!head &&
    head.source === next.source &&
    head.title === next.title &&
    head.body === next.body
  );
}

interface NotificationState {
  /** Newest first. */
  items: ArcNotification[];
  push: (n: NewNotification) => void;
  markAllRead: () => void;
  markRead: (id: number) => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;

export const useNotifications = create<NotificationState>((set) => ({
  items: [],

  push: (n) =>
    set((s) => {
      const [head, ...rest] = s.items;
      if (isRepeatOf(head, n)) {
        // Refresh the timestamp and re-mark unread, so a repeat still draws
        // the eye without adding a row.
        return { items: [{ ...head!, at: Date.now(), read: false }, ...rest] };
      }
      const item: ArcNotification = { ...n, id: nextId++, at: Date.now(), read: false };
      return { items: [item, ...s.items].slice(0, MAX_NOTIFICATIONS) };
    }),

  markAllRead: () =>
    set((s) => ({ items: s.items.map((i) => (i.read ? i : { ...i, read: true })) })),
  markRead: (id) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, read: true } : i)) })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Unread count for the icon badge. */
export function unreadCount(items: ArcNotification[]): number {
  return items.reduce((n, i) => (i.read ? n : n + 1), 0);
}

