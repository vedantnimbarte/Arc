import { useSettings } from '../state/settings';
import { useNotifications, type NewNotification } from '../state/notifications';
import { notifyOs } from './notify';

/**
 * Record something worth knowing about, and interrupt only if it earns it.
 *
 * Every event lands in the notification panel unless its source is muted; the
 * OS notification is a separate, narrower decision. Two guards on that: the
 * source has to be one the user allowed to interrupt, and the window has to be
 * unfocused — raising a system notification about something the user is
 * looking at is noise, and that rule already governs long-command alerts.
 *
 * Lives outside `state/notifications` so that store stays a leaf: `settings`
 * imports the source list from it, and a value import back would close a cycle.
 */
export function notifyEvent(n: NewNotification): void {
  const s = useSettings.getState();
  if (s.notifyMuted.includes(n.source)) return;

  useNotifications.getState().push(n);

  const focused = typeof document === 'undefined' || !document.hasFocus();
  if (s.notifyOs.includes(n.source) && focused) {
    void notifyOs(n.title, n.body ?? '', s.notifySound);
  }
}
