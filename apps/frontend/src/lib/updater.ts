import { isTauri } from './tauri';

// Thin wrapper over @tauri-apps/plugin-updater. Lazy-imports the plugin so the
// browser-only build never pulls it in (same pattern as `notify.ts`).
//
// Trust model: the Rust side verifies every downloaded bundle against the
// minisign `pubkey` in tauri.conf.json before installing. An endpoint that
// serves a tampered artifact fails signature verification, so `install()`
// rejects rather than running it.

export interface UpdateInfo {
  /** Version being offered, e.g. "0.2.0". */
  version: string;
  /** Version currently running. */
  currentVersion: string;
  /** Release notes from `latest.json`, when the release supplied any. */
  notes?: string;
  /** Publish date string from `latest.json`, when present. */
  date?: string;
}

// The plugin's `Update` handle can only be downloaded once and isn't
// serialisable, so we hold the live object here and hand the UI a plain
// summary. Cleared after a successful install or a failed check.
let pending: { version: string; downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> } | null =
  null;

/**
 * Ask the update endpoint whether a newer version exists.
 *
 * Returns `null` when up to date, outside Tauri, or when the check fails
 * (offline, endpoint down, malformed manifest) — an update check is never
 * important enough to surface an error to someone trying to use their
 * terminal. Failures are logged.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri) return null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      pending = null;
      return null;
    }
    pending = update;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body || undefined,
      date: update.date || undefined,
    };
  } catch (err) {
    console.warn('[updater] check failed:', err);
    pending = null;
    return null;
  }
}

/** The download lifecycle the plugin reports while streaming the bundle. */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/**
 * Turn the plugin's chunk-by-chunk download events into a 0–100 percentage.
 *
 * Stays at 0 for the whole download when the server sends no Content-Length
 * (we can't know the total), and clamps: a redirect or retry can push the
 * summed chunk lengths past the advertised total.
 */
export function createProgressTracker(
  onProgress?: (percent: number) => void,
): (event: DownloadEvent) => void {
  let total = 0;
  let downloaded = 0;
  return (e) => {
    if (e.event === 'Started') {
      total = e.data.contentLength ?? 0;
      downloaded = 0;
      onProgress?.(0);
    } else if (e.event === 'Progress') {
      downloaded += e.data.chunkLength;
      if (total > 0) onProgress?.(Math.min(100, Math.round((downloaded / total) * 100)));
    } else if (e.event === 'Finished') {
      onProgress?.(100);
    }
  };
}

/**
 * Download and install the update found by the last `checkForUpdate()`, then
 * relaunch into it. `onProgress` receives 0–100 as bytes arrive.
 *
 * Throws on failure — unlike the check, this one is user-initiated, so the
 * caller shows the error.
 */
export async function installUpdate(
  onProgress?: (percent: number) => void,
): Promise<void> {
  if (!pending) throw new Error('No update has been checked for.');

  await pending.downloadAndInstall(createProgressTracker(onProgress) as (e: unknown) => void);

  pending = null;

  // Windows' NSIS/MSI installer exits the app itself; macOS and Linux need an
  // explicit restart to pick up the swapped bundle.
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
