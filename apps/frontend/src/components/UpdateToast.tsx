import { useEffect, useState } from 'react';
import { ArrowUpCircle, Loader2, X } from 'lucide-react';
import { useSettings } from '../state/settings';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../lib/updater';

// Wait for the app to finish booting before hitting the network — a terminal
// should be usable instantly, and nobody is waiting on an update check.
const CHECK_DELAY_MS = 4000;
const NOTES_CAP = 240;

/**
 * Corner card offering an available update (Tier 1.8). Deliberately not a
 * modal: an update is never urgent enough to block the terminal underneath.
 *
 * Checks once per launch, gated on the `autoUpdateCheck` setting. Dismissing
 * hides it until the next launch; Settings → About has a manual check.
 *
 * ponytail: launch-only check. Add an interval if long-lived sessions turn
 * out to miss releases for days.
 */
export function UpdateToast() {
  const autoUpdateCheck = useSettings((s) => s.autoUpdateCheck);
  const settingsHydrated = useSettings((s) => s.settingsHydrated);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Hydration flips `autoUpdateCheck` to its stored value — checking before
    // that would ignore a user who turned it off.
    if (!settingsHydrated || !autoUpdateCheck) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void checkForUpdate().then((info) => {
        if (!cancelled) setUpdate(info);
      });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [settingsHydrated, autoUpdateCheck]);

  if (!update || dismissed) return null;

  const installing = progress !== null;

  const onInstall = async () => {
    setError(null);
    setProgress(0);
    try {
      // Resolves into a relaunch, so there is normally no "after" here.
      await installUpdate(setProgress);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const notes =
    update.notes && update.notes.length > NOTES_CAP
      ? `${update.notes.slice(0, NOTES_CAP)}…`
      : update.notes;

  return (
    <div className="material-sheet fixed bottom-4 right-4 z-[55] w-[340px] max-w-[92vw] animate-sheet-in overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2">
      <div className="flex items-center justify-between border-b border-border-hairline px-3.5 py-2">
        <div className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-fg-base">
          <ArrowUpCircle size={12} strokeWidth={2.1} className="text-accent" />
          ARC {update.version} is available
        </div>
        {!installing && (
          <button
            onClick={() => setDismissed(true)}
            title="Dismiss"
            className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <X size={11} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="px-3.5 py-2.5">
        <p className="font-display text-xs leading-relaxed text-fg-muted">
          You&apos;re on {update.currentVersion}.
          {notes ? ` ${notes}` : ' ARC will restart to finish installing.'}
        </p>
        {error && (
          <p className="mt-2 font-display text-2xs leading-relaxed text-red-400">
            Update failed: {error}
          </p>
        )}
      </div>

      {installing && (
        <div className="mx-3.5 mb-2.5 h-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border-hairline bg-bg-base/30 px-3.5 py-2">
        {!installing && (
          <button
            onClick={() => setDismissed(true)}
            className="rounded px-2.5 py-1 font-display text-xs text-fg-muted hover:bg-surface-1 hover:text-fg-base"
          >
            later
          </button>
        )}
        <button
          onClick={() => void onInstall()}
          disabled={installing}
          className="flex items-center gap-1.5 rounded bg-accent/15 px-3 py-1 font-display text-xs font-medium text-accent ring-1 ring-accent/40 transition-colors hover:bg-accent/25 disabled:opacity-70"
        >
          {installing && <Loader2 size={10} strokeWidth={2.2} className="animate-spin" />}
          {installing ? `installing… ${progress}%` : 'install & restart'}
        </button>
      </div>
    </div>
  );
}
