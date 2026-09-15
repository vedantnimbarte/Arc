/** What other parts of the app may do with a mounted terminal. Deliberately
 *  narrow: `paste` goes through xterm, so bracketed paste and the input
 *  forwarding (waiting-state, broadcast) behave exactly like a real paste. */
export interface TerminalHandle {
  paste: (text: string) => void;
  selection: () => string;
  focus: () => void;
}

const terminals = new Map<string, TerminalHandle>();

/** Register a mounted terminal; returns the unregister function. */
export function registerTerminal(sessionKey: string, handle: TerminalHandle): () => void {
  terminals.set(sessionKey, handle);
  return () => {
    if (terminals.get(sessionKey) === handle) terminals.delete(sessionKey);
  };
}

export function getTerminal(sessionKey: string): TerminalHandle | undefined {
  return terminals.get(sessionKey);
}
