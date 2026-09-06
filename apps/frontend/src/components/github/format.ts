/** Compact relative age — "2m", "5h", "3d", "7mo", "2y".
 *
 *  Short on purpose: it sits in a mono meta line under a dense row, where a
 *  full "3 days ago" would push out the branch name next to it. */
export function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d`;
  if (secs < 31536000) return `${Math.floor(secs / 2592000)}mo`;
  return `${Math.floor(secs / 31536000)}y`;
}

/** Join meta fragments, dropping the empty ones so a missing field doesn't
 *  leave a dangling separator. */
export function meta(...parts: (string | number | false | null | undefined)[]): string {
  return parts.filter((p) => p !== '' && p !== false && p != null).join(' · ');
}
