/**
 * One shared interval per period instead of one per subscriber. Every open
 * terminal used to run its own scrollback-save and agent-idle intervals, so
 * twenty tabs meant forty timers waking the webview; now each period has a
 * single timer that exists only while something is subscribed.
 */
const groups = new Map<number, { id: ReturnType<typeof setInterval>; fns: Set<() => void> }>();

/** Call `fn` every `ms`. Returns the unsubscribe. A subscriber that throws
 *  doesn't stop the others. */
export function every(ms: number, fn: () => void): () => void {
  let group = groups.get(ms);
  if (!group) {
    const fns = new Set<() => void>();
    const id = setInterval(() => {
      for (const f of [...fns]) {
        try {
          f();
        } catch (err) {
          console.error('[ticker] subscriber failed:', err);
        }
      }
    }, ms);
    group = { id, fns };
    groups.set(ms, group);
  }
  const g = group;
  g.fns.add(fn);
  return () => {
    g.fns.delete(fn);
    if (g.fns.size === 0 && groups.get(ms) === g) {
      clearInterval(g.id);
      groups.delete(ms);
    }
  };
}
