import { create } from 'zustand';

/**
 * App-owned replacement for `window.confirm` / `window.prompt`.
 *
 * ARC is a frameless window with its own material system; the native dialogs
 * break out of it entirely (and on Windows the WebView2 one is modal to the
 * whole app). This keeps the same call shape but resolves a promise instead
 * of blocking, and renders inside our own chrome — see `ConfirmDialog`.
 */
export interface AskRequest {
  title: string;
  /** Optional second line: what actually happens if they go ahead. */
  body?: string;
  /** Label on the affirmative button. Says what it does, not "OK". */
  confirmLabel?: string;
  /** Paints the affirmative button as a warning. */
  destructive?: boolean;
  /** Present means the dialog collects text — the `window.prompt` case. */
  input?: { label: string; value?: string; placeholder?: string };
}

type Pending = AskRequest & { resolve: (value: string | null) => void };

interface ConfirmState {
  pending: Pending | null;
  /** Resolves the entered text (`''` when there is no input), or `null`
   *  if the user cancelled. */
  request: (req: AskRequest) => Promise<string | null>;
  settle: (value: string | null) => void;
}

export const useConfirm = create<ConfirmState>((set, get) => ({
  pending: null,
  request: (req) =>
    new Promise((resolve) => {
      // A second ask while one is open supersedes it. Cancel the loser
      // rather than leaving its caller awaiting a promise nobody settles.
      get().pending?.resolve(null);
      set({ pending: { ...req, resolve } });
    }),
  settle: (value) => {
    const p = get().pending;
    if (!p) return;
    set({ pending: null });
    p.resolve(value);
  },
}));

/** Yes/no. Drop-in for `window.confirm`, minus the blocking. */
export const askConfirm = (req: Omit<AskRequest, 'input'>): Promise<boolean> =>
  useConfirm
    .getState()
    .request(req)
    .then((v) => v !== null);

/** Single field. Drop-in for `window.prompt`; `null` means cancelled. */
export const askText = (
  title: string,
  input: NonNullable<AskRequest['input']>,
  confirmLabel = 'save',
): Promise<string | null> => useConfirm.getState().request({ title, input, confirmLabel });
