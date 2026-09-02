import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRepeatOf,
  MAX_NOTIFICATIONS,
  unreadCount,
  useNotifications,
  type NewNotification,
} from '../notifications';

const n = (over: Partial<NewNotification> = {}): NewNotification => ({
  source: 'agent',
  title: 'Claude Code is waiting',
  ...over,
});

beforeEach(() => useNotifications.setState({ items: [] }));

describe('push', () => {
  it('puts the newest first, unread', () => {
    useNotifications.getState().push(n({ title: 'first' }));
    useNotifications.getState().push(n({ title: 'second' }));
    const { items } = useNotifications.getState();
    expect(items.map((i) => i.title)).toEqual(['second', 'first']);
    expect(items.every((i) => !i.read)).toBe(true);
  });

  it('collapses an immediate repeat instead of stacking rows', () => {
    // An agent that rings the bell three times should not produce three rows.
    useNotifications.getState().push(n());
    useNotifications.getState().push(n());
    useNotifications.getState().push(n());
    expect(useNotifications.getState().items).toHaveLength(1);
  });

  it('re-marks a collapsed repeat unread, so it still draws the eye', () => {
    useNotifications.getState().push(n());
    useNotifications.getState().markAllRead();
    useNotifications.getState().push(n());
    expect(useNotifications.getState().items[0]!.read).toBe(false);
  });

  it('treats an interleaved repeat as its own event', () => {
    useNotifications.getState().push(n({ title: 'a' }));
    useNotifications.getState().push(n({ title: 'b' }));
    useNotifications.getState().push(n({ title: 'a' }));
    expect(useNotifications.getState().items.map((i) => i.title)).toEqual(['a', 'b', 'a']);
  });

  it('separates same-title events from different sources', () => {
    useNotifications.getState().push(n({ source: 'agent', title: 'Done' }));
    useNotifications.getState().push(n({ source: 'checks', title: 'Done' }));
    expect(useNotifications.getState().items).toHaveLength(2);
  });

  it('caps the list, dropping the oldest', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 20; i++) {
      useNotifications.getState().push(n({ title: `t${i}` }));
    }
    const { items } = useNotifications.getState();
    expect(items).toHaveLength(MAX_NOTIFICATIONS);
    expect(items[0]!.title).toBe(`t${MAX_NOTIFICATIONS + 19}`);
    expect(items.at(-1)!.title).toBe('t20');
  });
});

describe('isRepeatOf', () => {
  const head = {
    id: 1,
    source: 'agent' as const,
    title: 'x',
    body: 'y',
    at: 0,
    read: false,
  };

  it('is false against an empty list', () => {
    expect(isRepeatOf(undefined, n())).toBe(false);
  });

  it('requires the body to match too', () => {
    expect(isRepeatOf(head, { source: 'agent', title: 'x', body: 'y' })).toBe(true);
    expect(isRepeatOf(head, { source: 'agent', title: 'x', body: 'z' })).toBe(false);
  });
});

describe('read state', () => {
  it('counts only unread', () => {
    useNotifications.getState().push(n({ title: 'a' }));
    useNotifications.getState().push(n({ title: 'b' }));
    const first = useNotifications.getState().items[0]!.id;
    useNotifications.getState().markRead(first);
    expect(unreadCount(useNotifications.getState().items)).toBe(1);
    useNotifications.getState().markAllRead();
    expect(unreadCount(useNotifications.getState().items)).toBe(0);
  });

  it('dismisses one and clears all', () => {
    useNotifications.getState().push(n({ title: 'a' }));
    useNotifications.getState().push(n({ title: 'b' }));
    useNotifications.getState().dismiss(useNotifications.getState().items[0]!.id);
    expect(useNotifications.getState().items).toHaveLength(1);
    useNotifications.getState().clear();
    expect(useNotifications.getState().items).toHaveLength(0);
  });
});
