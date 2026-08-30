import { create } from 'zustand';

/**
 * Which terminal tab has the ⌘K command bar open, if any.
 *
 * The shortcut is global (App owns the keydown listener, in capture phase so
 * xterm never sees the combo), but the bar belongs to one tab — it needs that
 * tab's shell, cwd and PTY. App puts the active tab's id here; each Terminal
 * renders the bar when it sees its own key.
 */
interface AiState {
  openFor: string | null;
  open: (sessionKey: string) => void;
  close: () => void;
}

export const useAi = create<AiState>()((set) => ({
  openFor: null,
  open: (sessionKey) => set({ openFor: sessionKey }),
  close: () => set({ openFor: null }),
}));
