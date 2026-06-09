import { create } from 'zustand';

/** A pattern flagged in pasted text, surfaced in the warning dialog. */
export interface PasteFlag {
  /** Short human label, e.g. "Recursive force delete". */
  label: string;
  /** The matched snippet, shown inline so the user sees exactly what tripped it. */
  match: string;
}

interface PendingPaste {
  text: string;
  flags: PasteFlag[];
  /** Resolves the awaiting `request()` call — `true` = paste anyway. */
  resolve: (ok: boolean) => void;
}

interface PasteState {
  pending: PendingPaste | null;
  /** Park a risky paste and return a promise that resolves when the user
   *  decides. A second request while one is pending auto-cancels the first. */
  request: (text: string, flags: PasteFlag[]) => Promise<boolean>;
  /** Resolve the pending request with the user's decision and clear it. */
  respond: (ok: boolean) => void;
}

export const usePaste = create<PasteState>((set, get) => ({
  pending: null,
  request: (text, flags) => {
    // Cancel any in-flight prompt so we never strand a dangling promise.
    get().pending?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({ pending: { text, flags, resolve } });
    });
  },
  respond: (ok) => {
    const p = get().pending;
    if (!p) return;
    p.resolve(ok);
    set({ pending: null });
  },
}));

interface RiskyRule {
  label: string;
  test: RegExp;
}

/** Patterns worth a second look before they hit the shell. Order matters only
 *  for display — all matching rules are reported. */
const RISKY_RULES: RiskyRule[] = [
  { label: 'Recursive force delete (rm -rf)', test: /\brm\s+(?:-\w*\s+)*-\w*r\w*f|\brm\s+(?:-\w*\s+)*-\w*f\w*r/i },
  { label: 'Runs as root (sudo)', test: /\bsudo\b/i },
  { label: 'Pipes a download into a shell', test: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|d?a)?sh\b/i },
  { label: 'Recursive permission change (chmod -R)', test: /\bchmod\s+(?:-\w*\s+)*-\w*R/i },
  { label: 'Recursive ownership change (chown -R)', test: /\bchown\s+(?:-\w*\s+)*-\w*R/i },
  { label: 'Overwrites a disk/device (dd)', test: /\bdd\s+[^\n]*\bof=\/dev\//i },
];

const MIN_NEWLINES = 2;

/**
 * Inspect pasted text and return any flags worth warning about. Empty array
 * means "safe to paste silently". A multi-line paste is flagged on its own
 * (a common footgun: pasting a block of commands that auto-run line by line).
 */
export function detectRiskyPaste(text: string): PasteFlag[] {
  const flags: PasteFlag[] = [];

  const newlines = (text.match(/\n/g) ?? []).length;
  if (newlines >= MIN_NEWLINES) {
    flags.push({ label: `Multiple lines (${newlines + 1})`, match: '' });
  }

  for (const rule of RISKY_RULES) {
    const m = rule.test.exec(text);
    if (m) flags.push({ label: rule.label, match: m[0].trim() });
  }

  return flags;
}
