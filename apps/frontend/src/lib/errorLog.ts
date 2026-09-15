import { diagnosticsLogError, isTauri } from './tauri';

/** Most errors forwarded per minute. A render loop that throws every frame
 *  would otherwise hammer the IPC bridge and fill the log with one line. */
const MAX_PER_MINUTE = 20;

/** Turn whatever was thrown or logged into one readable line. */
export function describeError(parts: readonly unknown[]): string {
  return parts
    .map((p) => {
      if (p instanceof Error) return p.stack || `${p.name}: ${p.message}`;
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
}

/**
 * Forward uncaught errors, unhandled rejections and `console.error` calls to
 * `<data_dir>/arc/frontend.log`, which "Copy diagnostics" includes. Before
 * this, anything that went wrong in the webview was gone with the devtools
 * console — the restore bug was reported as "sometimes I can't type".
 */
export function installErrorLog(win: Window = window): void {
  if (!isTauri) return;
  let windowStart = Date.now();
  let sent = 0;
  // Re-entrancy guard: a failing IPC call that logs its own failure must not
  // loop back into another IPC call.
  let sending = false;
  const send = (parts: readonly unknown[]) => {
    if (sending) return;
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      sent = 0;
    }
    if (++sent > MAX_PER_MINUTE) return;
    sending = true;
    try {
      void diagnosticsLogError(describeError(parts)).catch(() => {});
    } finally {
      sending = false;
    }
  };

  win.addEventListener('error', (e) => send([e.error ?? e.message]));
  win.addEventListener('unhandledrejection', (e) => send(['unhandled rejection:', e.reason]));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    send(args);
  };
}
