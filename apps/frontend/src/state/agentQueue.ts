import { create } from 'zustand';
import { ptyWrite } from '../lib/tauri';
import { getTerminal } from '../lib/terminalRegistry';
import { useWorkspace, type Tab } from './workspace';
import { toast } from './toast';

/**
 * Follow-up prompts waiting for an agent to finish its turn.
 *
 * Each agent tab gets a queue. When the tab turns *waiting* (see
 * `agentWaiting` in the workspace store) the head of the queue is typed into
 * the agent and submitted — one prompt per waiting transition, never while
 * the agent is still working.
 *
 * "Waiting" cannot tell a finished turn from a permission prompt, and a queued
 * prompt typed into an approval question would answer it. So the guards are
 * explicit rather than clever: a Pause toggle, and an automatic pause the
 * moment the user types into a tab that still has prompts queued — typing is
 * the sign they are handling something by hand.
 *
 * In memory only: a restored tab is a fresh agent session, and replaying
 * prompts written for the old conversation into it would be wrong.
 */

export interface QueuedPrompt {
  id: string;
  text: string;
}

export interface AgentQueue {
  items: QueuedPrompt[];
  paused: boolean;
}

interface AgentQueueState {
  queues: Record<string, AgentQueue>;
  /** Append a prompt. False when `tabId` is not a live agent tab. */
  add: (tabId: string, text: string) => boolean;
  remove: (tabId: string, id: string) => void;
  /** Swap a prompt with its neighbour: -1 earlier, +1 later. */
  move: (tabId: string, id: string, dir: -1 | 1) => void;
  setPaused: (tabId: string, paused: boolean) => void;
  /** Send the head now, paused or not — the user asked for it. False when
   *  there is nothing to send or nowhere to send it. */
  sendNext: (tabId: string) => boolean;
  clear: (tabId: string) => void;
  /** The user typed into `tabId`. Pauses a non-empty queue. */
  noteInput: (tabId: string) => void;
}

/** Long enough for the pasted text to reach the PTY and a TUI to see the
 *  bracketed paste close before Enter arrives; an Enter inside the paste
 *  burst is taken as a newline by most agent CLIs rather than as submit. */
export const SUBMIT_DELAY_MS = 150;

/** Only agents: a plain shell would run a queued prompt as a command. */
function agentTab(tabId: string): Tab | null {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  return tab?.kind === 'terminal' && tab.shellOverride && tab.ptyId ? tab : null;
}

let nextId = 1;

const EMPTY: AgentQueue = { items: [], paused: false };

export const useAgentQueue = create<AgentQueueState>((set, get) => {
  const update = (tabId: string, fn: (q: AgentQueue) => AgentQueue) =>
    set((s) => ({ queues: { ...s.queues, [tabId]: fn(s.queues[tabId] ?? EMPTY) } }));

  return {
    queues: {},

    add: (tabId, text) => {
      if (!text.trim() || !agentTab(tabId)) return false;
      update(tabId, (q) => ({ ...q, items: [...q.items, { id: String(nextId++), text }] }));
      return true;
    },

    remove: (tabId, id) => update(tabId, (q) => ({ ...q, items: q.items.filter((i) => i.id !== id) })),

    move: (tabId, id, dir) =>
      update(tabId, (q) => {
        const i = q.items.findIndex((x) => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= q.items.length) return q;
        const items = [...q.items];
        [items[i], items[j]] = [items[j]!, items[i]!];
        return { ...q, items };
      }),

    setPaused: (tabId, paused) => update(tabId, (q) => ({ ...q, paused })),

    sendNext: (tabId) => {
      const head = get().queues[tabId]?.items[0];
      const tab = agentTab(tabId);
      const term = getTerminal(tabId);
      if (!head || !tab || !term) return false;
      term.paste(head.text);
      const ptyId = tab.ptyId!;
      setTimeout(() => void ptyWrite(ptyId, '\r').catch(() => {}), SUBMIT_DELAY_MS);
      update(tabId, (q) => ({ ...q, items: q.items.slice(1) }));
      return true;
    },

    clear: (tabId) =>
      set((s) => {
        if (!s.queues[tabId]) return s;
        const { [tabId]: _gone, ...rest } = s.queues;
        return { queues: rest };
      }),

    noteInput: (tabId) => {
      const q = get().queues[tabId];
      if (!q || q.paused || q.items.length === 0) return;
      update(tabId, (x) => ({ ...x, paused: true }));
      toast('Prompt queue paused — you typed into the agent');
    },
  };
});

// Drive the queue from the workspace store: a tab that has just started
// waiting gets one prompt, and a closed tab takes its queue with it.
useWorkspace.subscribe((s, prev) => {
  const queue = useAgentQueue.getState();
  for (const id of Object.keys(s.agentWaiting)) {
    if (prev.agentWaiting[id]) continue;
    const q = queue.queues[id];
    if (q && !q.paused && q.items.length > 0) queue.sendNext(id);
  }
  if (s.tabs !== prev.tabs) {
    const open = new Set(s.tabs.map((t) => t.id));
    for (const id of Object.keys(queue.queues)) if (!open.has(id)) queue.clear(id);
  }
});

// Keystrokes, not `onData`: our own paste goes through xterm's input path
// too, and must not count as the user taking over. App shortcuts stop
// propagation in the window's capture phase, so they never reach here.
if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      const host = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tab-host]');
      const tabId = host?.dataset.tabHost;
      if (tabId) useAgentQueue.getState().noteInput(tabId);
    },
    true,
  );
}
