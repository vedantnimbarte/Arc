import { create } from 'zustand';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  isTauri,
  onWingmanEvents,
  onWingmanTurn,
  wingmanBoard,
  wingmanBoardAddCard,
  wingmanBoardArchive,
  wingmanBoardDispatch,
  wingmanConfigure,
  wingmanCreateSession,
  wingmanEventsSubscribe,
  wingmanHealth,
  wingmanPilotControl,
  wingmanProjects,
  wingmanTurnStart,
  type WingmanCard,
  type WingmanHealth,
  type WingmanPilotAction,
  type WingmanProject,
  type WingmanStreamEvent,
} from '../lib/tauri';
import { useFiles } from './files';
import { useGit } from './git';

/**
 * Wingman integration state.
 *
 * Everything here is gated on `status === 'connected'`. ARC works fully without
 * a daemon, so every surface that reads this store must render nothing (not an
 * error) while disconnected — see `WingmanPanel`.
 */

/** Connection lifecycle. `unconfigured` and `error` are both "hide the UI",
 *  but they're distinct so Settings can explain *why* it isn't showing. */
export type WingmanStatus = 'unconfigured' | 'connecting' | 'connected' | 'error';

/** One rendered item in a chat transcript.
 *
 *  Assistant text and thinking are separate rows rather than one row with a
 *  flag: thinking is the model's working-out and folds away independently, and
 *  a turn can interleave the two. */
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'verification'; passed: boolean; summary: string }
  | { kind: 'error'; message: string };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface WingmanState {
  status: WingmanStatus;
  /** Populated on a failed connect, shown in Settings. */
  lastError: string | null;
  health: WingmanHealth | null;

  baseUrl: string;
  projects: WingmanProject[];
  /** Which allowlisted project the panel and board act on. */
  activeProject: string | null;

  cards: WingmanCard[];
  boardLoading: boolean;

  /** Server-held conversation id. Null until the first turn creates one. */
  sessionId: string | null;
  chat: ChatItem[];
  streaming: boolean;
  usage: TokenUsage | null;

  connect: (baseUrl: string, token?: string | null) => Promise<void>;
  disconnect: () => Promise<void>;
  setActiveProject: (id: string) => void;
  refreshBoard: () => Promise<void>;
  addCard: (title: string, goal?: string) => Promise<void>;
  dispatchCard: (cardId: string, again?: boolean) => Promise<void>;
  archiveCard: (cardId: string, restore?: boolean) => Promise<void>;
  pilotControl: (
    run: string,
    action: WingmanPilotAction,
    task?: string | null,
  ) => Promise<void>;
  send: (prompt: string) => Promise<void>;
  newChat: () => void;
  /** Point ARC's file tree and Source Control at a pilot task's worktree, so
   *  the agent's changes get reviewed in ARC's own diff viewer. This is the
   *  review queue — it reuses the whole existing git stack rather than adding
   *  a second diff surface. */
  openWorktree: (path: string) => void;
}


/** Teardown handles for the two live subscriptions. Kept outside the store so
 *  they never land in a React render path or a devtools snapshot. */
let unlistenEvents: UnlistenFn | null = null;
let unlistenTurn: UnlistenFn | null = null;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export const useWingman = create<WingmanState>((set, get) => ({
  status: 'unconfigured',
  lastError: null,
  health: null,
  baseUrl: '',
  projects: [],
  activeProject: null,
  cards: [],
  boardLoading: false,
  sessionId: null,
  chat: [],
  streaming: false,
  usage: null,

  connect: async (baseUrl, token) => {
    // Browser-only dev build has no IPC; stay unconfigured rather than
    // throwing on every keystroke in Settings.
    if (!isTauri || !baseUrl.trim()) {
      set({ status: 'unconfigured', baseUrl, health: null, lastError: null });
      return;
    }
    set({ status: 'connecting', baseUrl, lastError: null });
    try {
      await wingmanConfigure(baseUrl, token ?? null);
      const health = await wingmanHealth();
      const projects = await wingmanProjects();
      set({
        status: 'connected',
        health,
        projects,
        // Keep the current project when reconnecting, but only if the daemon
        // still serves it — the allowlist can change between runs.
        activeProject:
          projects.find((p) => p.id === get().activeProject)?.id ?? projects[0]?.id ?? null,
        lastError: null,
      });

      // The run firehose keeps the board live without polling. Re-subscribing
      // on every connect is why the old handle is torn down first.
      unlistenEvents?.();
      unlistenEvents = await onWingmanEvents((ev) => {
        // Any run transition can change a card's derived column or roll-up.
        if (ev.kind.startsWith('run.')) void get().refreshBoard();
      });
      await wingmanEventsSubscribe();
      await get().refreshBoard();
    } catch (e) {
      set({
        status: 'error',
        health: null,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  disconnect: async () => {
    unlistenEvents?.();
    unlistenEvents = null;
    unlistenTurn?.();
    unlistenTurn = null;
    if (isTauri) await wingmanConfigure('').catch(() => {});
    set({
      status: 'unconfigured',
      health: null,
      projects: [],
      activeProject: null,
      cards: [],
      sessionId: null,
      chat: [],
      streaming: false,
      usage: null,
      lastError: null,
    });
  },

  setActiveProject: (id) => {
    // Switching project invalidates the conversation: sessions are per-project
    // on the daemon, so carrying the id across would 404 on the next turn.
    set({ activeProject: id, sessionId: null, chat: [], usage: null });
    void get().refreshBoard();
  },

  refreshBoard: async () => {
    if (get().status !== 'connected') return;
    set({ boardLoading: true });
    try {
      const board = await wingmanBoard(null, false);
      set({ cards: board.cards ?? [] });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ boardLoading: false });
    }
  },

  addCard: async (title, goal) => {
    const project = get().activeProject;
    if (!project || !title.trim()) return;
    await wingmanBoardAddCard(project, title.trim(), goal ?? null);
    await get().refreshBoard();
  },

  dispatchCard: async (cardId, again = false) => {
    await wingmanBoardDispatch(cardId, again);
    await get().refreshBoard();
  },

  archiveCard: async (cardId, restore = false) => {
    await wingmanBoardArchive(cardId, restore);
    await get().refreshBoard();
  },

  pilotControl: async (run, action, task) => {
    const project = get().activeProject;
    if (!project) return;
    await wingmanPilotControl(project, run, action, task ?? null);
    await get().refreshBoard();
  },

  openWorktree: (path) => {
    // Reuse ARC's git stack wholesale: retarget the tree, then reveal Source
    // Control. Every changed file, diff and stage action then works exactly as
    // it does for a normal repo, because to ARC this *is* one.
    useFiles.getState().setRoot(path);
    useFiles.getState().showSidebarView('git');
    void useGit.getState().refresh(path);
  },

  newChat: () => {
    unlistenTurn?.();
    unlistenTurn = null;
    set({ sessionId: null, chat: [], usage: null, streaming: false });
  },

  send: async (prompt) => {
    const { activeProject, status, streaming } = get();
    // One turn at a time: the daemon returns 409 for a second turn on the same
    // session, so refusing here keeps that out of the transcript.
    if (status !== 'connected' || !activeProject || streaming || !prompt.trim()) return;

    set((s) => ({
      chat: [...s.chat, { kind: 'user', text: prompt }],
      streaming: true,
    }));

    try {
      let session = get().sessionId;
      if (!session) {
        session = await wingmanCreateSession(activeProject, null, null);
        set({ sessionId: session });
      }

      const topic = await wingmanTurnStart({ project: activeProject, session, prompt });

      unlistenTurn?.();
      unlistenTurn = await onWingmanTurn(topic, (ev) => applyEvent(set, ev));
    } catch (e) {
      set((s) => ({
        chat: [
          ...s.chat,
          { kind: 'error', message: e instanceof Error ? e.message : String(e) },
        ],
        streaming: false,
      }));
    }
  },
}));

/**
 * Fold one stream event into the transcript.
 *
 * Text and thinking deltas append to the trailing row of the same kind rather
 * than pushing a new one — otherwise a turn produces one row per token. Every
 * other event pushes its own row.
 */
function applyEvent(
  set: (fn: (s: WingmanState) => Partial<WingmanState>) => void,
  ev: WingmanStreamEvent,
): void {
  const p = ev.payload ?? {};

  switch (ev.kind) {
    case 'text_delta':
    case 'thinking_delta': {
      const kind = ev.kind === 'text_delta' ? 'assistant' : 'thinking';
      const text = str(p.text);
      if (!text) return;
      set((s) => {
        const last = s.chat[s.chat.length - 1];
        if (last && last.kind === kind) {
          const chat = s.chat.slice(0, -1);
          chat.push({ kind, text: last.text + text } as ChatItem);
          return { chat };
        }
        return { chat: [...s.chat, { kind, text } as ChatItem] };
      });
      return;
    }

    case 'tool_start':
      set((s) => ({
        chat: [
          ...s.chat,
          { kind: 'tool', id: str(p.id), name: str(p.name), input: p.input },
        ],
      }));
      return;

    case 'tool_result':
      // Match the result back onto its call so the UI shows one row per tool,
      // not a call row and an orphaned result row.
      set((s) => {
        const id = str(p.id);
        const idx = s.chat.findIndex((c) => c.kind === 'tool' && c.id === id);
        if (idx === -1) return {};
        const chat = [...s.chat];
        const row = chat[idx] as Extract<ChatItem, { kind: 'tool' }>;
        chat[idx] = { ...row, output: str(p.output), isError: Boolean(p.is_error) };
        return { chat };
      });
      return;

    case 'usage': {
      const u = (p.usage ?? {}) as Record<string, unknown>;
      set(() => ({
        usage: {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
        },
      }));
      return;
    }

    case 'verification':
      set((s) => ({
        chat: [
          ...s.chat,
          { kind: 'verification', passed: Boolean(p.passed), summary: str(p.summary) },
        ],
      }));
      return;

    case 'error':
      // Both a recoverable agent error and ARC's own terminal error land here.
      // Either way the turn is over as far as the composer is concerned.
      set((s) => ({
        chat: [...s.chat, { kind: 'error', message: str(p.message) || 'stream failed' }],
        streaming: false,
      }));
      return;

    case 'stop':
    case 'done':
      set(() => ({ streaming: false }));
      return;

    // `turn_complete` is one provider round-trip inside a user turn, not the
    // end of it — deliberately ignored so the composer stays disabled through
    // a multi-step tool loop.
    default:
      return;
  }
}

/** Keyring entry holding the daemon's bearer token. Settings live in plain
 *  SQLite rows, so the token deliberately doesn't go there. */
export const WINGMAN_TOKEN_KEY = 'wingman-token';

/**
 * Connect on boot from persisted settings, if any.
 *
 * Fire-and-forget by design: ARC must not wait on a daemon that may not exist.
 * Failures land in `lastError` for Settings to explain and are otherwise silent.
 */
export async function autoConnectWingman(url: string): Promise<void> {
  if (!isTauri || !url.trim()) return;
  let token: string | null = null;
  try {
    const { secretGet } = await import('../lib/tauri');
    token = await secretGet(WINGMAN_TOKEN_KEY);
  } catch {
    // A locked or unavailable keyring is not fatal — a loopback daemon with
    // `auth = none` needs no token at all, which is the default setup.
  }
  await useWingman.getState().connect(url, token);
}

/** Reset for tests. Not used by the app. */
export function __resetWingmanForTests(): void {
  unlistenEvents?.();
  unlistenTurn?.();
  unlistenEvents = null;
  unlistenTurn = null;
  useWingman.setState({
    status: 'unconfigured',
    chat: [],
    streaming: false,
    usage: null,
    sessionId: null,
    cards: [],
  });
}

export { applyEvent as __applyEventForTests };
