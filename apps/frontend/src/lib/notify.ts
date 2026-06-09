import { isTauri } from './tauri';

// Thin wrapper over @tauri-apps/plugin-notification for long-command alerts
// (Tier 1.5). Lazy-imports the plugin so the web-only build doesn't pull it
// in, and caches the permission check so we don't re-prompt on every command.

let permission: 'granted' | 'denied' | 'default' | null = null;

async function ensurePermission(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { isPermissionGranted, requestPermission } = await import(
      '@tauri-apps/plugin-notification'
    );
    if (permission === null) {
      permission = (await isPermissionGranted()) ? 'granted' : await requestPermission();
    }
    return permission === 'granted';
  } catch (err) {
    console.warn('[notify] permission check failed:', err);
    return false;
  }
}

export interface CommandNotifyArgs {
  command: string;
  exitCode: number | null;
  durationMs: number;
  sound: boolean;
}

/** Fire a system notification summarizing a finished command. Best-effort —
 *  silently no-ops if permission is denied or the plugin is unavailable. */
export async function notifyCommandFinished(args: CommandNotifyArgs): Promise<void> {
  if (!(await ensurePermission())) return;
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    const ok = args.exitCode === 0 || args.exitCode === null;
    const secs = Math.round(args.durationMs / 1000);
    const title = ok
      ? `✓ Command finished (${formatDuration(secs)})`
      : `✗ Command failed — exit ${args.exitCode} (${formatDuration(secs)})`;
    const body = args.command.length > 120 ? `${args.command.slice(0, 120)}…` : args.command;
    sendNotification({ title, body, ...(args.sound ? { sound: 'default' } : {}) });
  } catch (err) {
    console.warn('[notify] send failed:', err);
  }
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
