import { create } from 'zustand';

/**
 * Transient confirmations for actions that otherwise complete in silence —
 * "Copied path", "Clipboard unavailable". Panels that own a visible surface
 * (Source Control, the git page) keep their inline flash instead: feedback
 * next to the thing you clicked beats feedback in the corner.
 */
export type ToastTone = 'info' | 'error';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

/** Matches the Source Control flash so the two read as one behaviour. */
const TTL_MS = 2400;
/** A burst of copies shouldn't wall off the corner of the window. */
const MAX_VISIBLE = 3;

let nextId = 1;

interface ToastState {
  toasts: Toast[];
  push: (text: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }].slice(-MAX_VISIBLE) }));
    setTimeout(() => get().dismiss(id), TTL_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Confirm something happened. Say what happened, not that it succeeded. */
export const toast = (text: string) => useToasts.getState().push(text, 'info');

/** Report something that didn't. Say what went wrong, in the app's voice. */
export const toastError = (text: string) => useToasts.getState().push(text, 'error');
