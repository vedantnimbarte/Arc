import { create } from 'zustand';

/**
 * Which terminal tab has the ⌘K command bar open, if any.
 *
 * The shortcut is global (App owns the keydown listener, in capture phase so
 * xterm never sees the combo), but the bar belongs to one tab — it needs that
 * tab's shell, cwd and PTY. App puts the active tab's id here; each Terminal
 * renders the bar when it sees its own key.
 */
import type { CommandFailure } from '../lib/ai';

interface AiState {
  openFor: string | null;
  open: (sessionKey: string) => void;
  close: () => void;
  /**
   * The last command that exited non-zero in each tab, captured from the
   * shell's OSC 133 markers. The ⌘K bar offers to explain it, so the user
   * never retypes the command or pastes the error back.
   *
   * Only the most recent failure per tab is kept: this answers "what just went
   * wrong", and a list of older failures is what the command history already
   * is. Not persisted — a failure from three days ago is not the one you are
   * looking at.
   */
  failures: Record<string, CommandFailure>;
  recordFailure: (sessionKey: string, failure: CommandFailure) => void;
  /** Forget a tab's failure once it is explained or superseded. */
  clearFailure: (sessionKey: string) => void;
}

export const useAi = create<AiState>()((set) => ({
  openFor: null,
  open: (sessionKey) => set({ openFor: sessionKey }),
  close: () => set({ openFor: null }),
  failures: {},
  recordFailure: (sessionKey, failure) =>
    set((s) => ({ failures: { ...s.failures, [sessionKey]: failure } })),
  clearFailure: (sessionKey) =>
    set((s) => {
      if (!(sessionKey in s.failures)) return s;
      const { [sessionKey]: _gone, ...rest } = s.failures;
      return { failures: rest };
    }),
}));
