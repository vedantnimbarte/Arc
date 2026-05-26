import { create } from 'zustand';
import type { LucideIcon } from 'lucide-react';

// Unified action registry behind the ⌘K palette. Features (chrome shortcuts,
// git ops, ssh manager, future plugins) register their commands here once; the
// palette renders whatever is currently registered. Source of truth is in-
// memory — actions re-register on mount, so a hot-reloaded module's actions
// stay current.

/** Logical grouping for the palette's section headers. Add to taste. */
export type CommandGroup =
  | 'Workspace'
  | 'Terminal'
  | 'Editor'
  | 'Assistant'
  | 'Git'
  | 'SSH'
  | 'AI CLIs'
  | 'View'
  | 'Help';

export interface CommandAction {
  /** Stable id — use `<area>.<verb>` (e.g. "workspace.new-terminal"). */
  id: string;
  /** Human label shown as the primary row text. */
  title: string;
  group: CommandGroup;
  /** Extra search terms. Lowercased; matched as substrings. */
  keywords?: string[];
  /** Pre-formatted shortcut string (e.g. "⌘T") shown on the right edge. */
  shortcut?: string;
  /** Optional lucide-react icon, e.g. `<Sparkles />`. */
  icon?: LucideIcon;
  /** Gate visibility on app state. Re-evaluated on every palette render. */
  when?: () => boolean;
  /** Side-effecting handler. The palette awaits this before closing. */
  run: () => void | Promise<void>;
}

interface CommandsState {
  actions: Map<string, CommandAction>;
  /** Register one action. Overwrites any prior registration of the same id. */
  register: (action: CommandAction) => void;
  /** Register many — handy for seed sets. Returns a single un-registrar. */
  registerMany: (actions: CommandAction[]) => () => void;
  unregister: (id: string) => void;
}

export const useCommands = create<CommandsState>((set, get) => ({
  actions: new Map(),
  register: (action) =>
    set((s) => {
      const next = new Map(s.actions);
      next.set(action.id, action);
      return { actions: next };
    }),
  registerMany: (actions) => {
    const ids = actions.map((a) => a.id);
    set((s) => {
      const next = new Map(s.actions);
      for (const a of actions) next.set(a.id, a);
      return { actions: next };
    });
    return () => {
      set((s) => {
        const next = new Map(s.actions);
        for (const id of ids) next.delete(id);
        return { actions: next };
      });
    };
  },
  unregister: (id) =>
    set((s) => {
      if (!s.actions.has(id)) return s;
      const next = new Map(s.actions);
      next.delete(id);
      return { actions: next };
    }),
}));

/** Score an action against a lowercased query. Higher = better match. Returns
 *  -1 if it doesn't match at all. Strategy: prefix-on-title beats substring
 *  beats keyword hit beats group hit. */
export function scoreAction(action: CommandAction, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const title = action.title.toLowerCase();
  if (title.startsWith(q)) return 100;
  const titleHit = title.indexOf(q);
  if (titleHit >= 0) return 80 - Math.min(titleHit, 40);
  if (action.keywords?.some((k) => k.toLowerCase().includes(q))) return 40;
  if (action.group.toLowerCase().includes(q)) return 20;
  return -1;
}

/** Run an action by id. No-op if the action isn't registered or its `when`
 *  guard is false. Surfaces errors to the console rather than throwing. */
export async function runCommand(id: string): Promise<void> {
  const action = useCommands.getState().actions.get(id);
  if (!action) {
    console.warn(`[commands] unknown id: ${id}`);
    return;
  }
  if (action.when && !action.when()) return;
  try {
    await action.run();
  } catch (err) {
    console.error(`[commands] ${id} failed:`, err);
  }
}
