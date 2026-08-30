import { toast, toastError } from '../state/toast';

/**
 * Copy with feedback. The bare `navigator.clipboard.writeText` calls this
 * replaces were fire-and-forget: nothing confirmed the copy, and a rejected
 * write (no permission, insecure context) vanished into an unhandled promise.
 *
 * `label` names what landed on the clipboard — "Path", "Commit" — so the
 * toast reads "Copied path" rather than "Copied".
 */
export function copyText(text: string, label = 'Text'): void {
  void navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${label.toLowerCase()}`),
    () => toastError(`Couldn't copy ${label.toLowerCase()} — the clipboard is unavailable.`),
  );
}
