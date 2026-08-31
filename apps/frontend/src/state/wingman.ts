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
  wingmanCost,
  wingmanCreateSession,
  wingmanDeleteSession,
  fsReadDir,
  gitChanges,
  wingmanEventsSubscribe,
  wingmanExplain,
  wingmanHealth,
  wingmanPilotControl,
  wingmanPilotRun,
  wingmanProjects,
  wingmanSessions,
  wingmanSessionTranscript,
  wingmanTurnStart,
  type WingmanCard,
  type WingmanContentBlock,
  type WingmanHealth,
  type WingmanPilotAction,
  type WingmanProject,
  type WingmanSessionInfo,
  type WingmanSessionRecord,
  type WingmanSubRow,
  type GitChangeEntry,
  type WingmanStreamEvent,
} from '../lib/tauri';
import { useFiles } from './files';
import { useGit } from './git';
import { useWorkspace } from './workspace';

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

  /** Stored conversations for the active project, newest first. */
  sessions: WingmanSessionInfo[];
  sessionsLoading: boolean;

  /** Cumulative spend for the active project, as `wingman cost --json` reports
   *  it. Shape is the daemon's, so it stays a Value — ARC only reads a total. */
  cost: unknown | null;

  /** Full `RunState` for the run being inspected on the board. */
  runDetail: { runId: string; state: unknown } | null;
  runDetailLoading: boolean;

  /** Changed files per agent worktree, keyed by absolute worktree path.
   *
   *  Three non-list states, because they mean different things to a reviewer:
   *  `'loading'` is still counting, `'missing'` is a worktree Wingman has
   *  already torn down (the common case once a run ends), and an empty array
   *  is an agent that ran and genuinely changed nothing. Collapsing the last
   *  two would report most finished tasks as "no changes", which is wrong. */
  worktreeChanges: Record<string, GitChangeEntry[] | 'loading' | 'missing'>;

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
  /** List stored conversations for the active project. */
  loadSessions: () => Promise<void>;
  /** Reopen a stored conversation: replays its transcript into the panel and
   *  points the next turn at it, so the daemon continues the same history. */
  resumeSession: (id: string) => Promise<void>;
  /** Forget a conversation — deletes the transcript and de-indexes it. */
  forgetSession: (id: string) => Promise<void>;
  loadCost: () => Promise<void>;
  openRunDetail: (runId: string) => Promise<void>;
  closeRunDetail: () => void;
  /** Ask Wingman to summarise the working tree. Goes through the daemon's
   *  `explain` route rather than burning an agent turn on it. */
  explainChanges: () => Promise<void>;
  /** Read the changed files in one agent worktree. Cached — a worktree that
   *  has finished doesn't change again, and the queue re-renders often. */
  loadWorktreeChanges: (worktree: string) => Promise<void>;
  /** Open one file from an agent worktree in ARC's diff viewer, rooted at that
   *  worktree so the diff is against the agent's own base. */
  openWorktreeFile: (worktree: string, relPath: string) => void;
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
  sessions: [],
  sessionsLoading: false,
  cost: null,
  runDetail: null,
  runDetailLoading: false,
  worktreeChanges: {},

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
      sessions: [],
      cost: null,
      runDetail: null,
      lastError: null,
    });
  },

  setActiveProject: (id) => {
    // Switching project invalidates the conversation: sessions are per-project
    // on the daemon, so carrying the id across would 404 on the next turn.
    // The session list and cost are per-project too — leaving them would show
    // one project's history under another's name.
    set({
      activeProject: id,
      sessionId: null,
      chat: [],
      usage: null,
      sessions: [],
      cost: null,
    });
    void get().refreshBoard();
    void get().loadSessions();
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

  loadWorktreeChanges: async (worktree) => {
    if (!isTauri || !worktree) return;
    // Already loaded or in flight — the queue re-renders on every board
    // refresh and these are filesystem reads.
    if (get().worktreeChanges[worktree]) return;
    set((s) => ({ worktreeChanges: { ...s.worktreeChanges, [worktree]: 'loading' } }));
    const put = (v: GitChangeEntry[] | 'missing') =>
      set((s) => ({ worktreeChanges: { ...s.worktreeChanges, [worktree]: v } }));
    try {
      // Probe the directory first. `gitChanges` returns [] both for "nothing
      // changed" and for "not a repo", so without this a torn-down worktree
      // would be reported as a clean one — and Wingman removes worktrees when
      // a run ends, so that's the majority of finished tasks.
      await fsReadDir(worktree);
    } catch {
      put('missing');
      return;
    }
    try {
      put(await gitChanges(worktree));
    } catch {
      put('missing');
    }
  },

  openWorktreeFile: (worktree, relPath) => {
    // Root the diff at the worktree, not the user's workspace: the agent
    // branched from its own base, and diffing against the user's checkout
    // would show unrelated local edits as part of the agent's work.
    const sep = worktree.includes('\\') ? '\\' : '/';
    const abs = `${worktree}${sep}${relPath.split('/').join(sep)}`;
    useWorkspace.getState().openDiff(abs, worktree, 'worktree');
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

  loadSessions: async () => {
    const project = get().activeProject;
    if (get().status !== 'connected' || !project) return;
    set({ sessionsLoading: true });
    try {
      set({ sessions: await wingmanSessions(project) });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ sessionsLoading: false });
    }
  },

  resumeSession: async (id) => {
    const project = get().activeProject;
    if (!project) return;
    // Stop following the previous turn before swapping the transcript out —
    // a late delta would otherwise append to the conversation we just loaded.
    unlistenTurn?.();
    unlistenTurn = null;
    try {
      const records = await wingmanSessionTranscript(project, id);
      set({
        sessionId: id,
        chat: transcriptToChat(records),
        // Usage is per-turn and not stored in the transcript; showing the last
        // live turn's numbers against a resumed conversation would be a lie.
        usage: null,
        streaming: false,
      });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  forgetSession: async (id) => {
    const project = get().activeProject;
    if (!project) return;
    await wingmanDeleteSession(project, id);
    // Drop the panel's view of it too if that's what was open.
    if (get().sessionId === id) get().newChat();
    await get().loadSessions();
  },

  loadCost: async () => {
    const project = get().activeProject;
    if (get().status !== 'connected' || !project) return;
    try {
      set({ cost: await wingmanCost(project, false) });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    }
  },

  openRunDetail: async (runId) => {
    const project = get().activeProject;
    if (!project) return;
    set({ runDetail: { runId, state: null }, runDetailLoading: true });
    try {
      const state = await wingmanPilotRun(project, runId);
      // Guard against a race: the user may have closed the overlay, or opened
      // a different run, while this was in flight.
      if (get().runDetail?.runId === runId) set({ runDetail: { runId, state } });
    } catch (e) {
      set({ lastError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ runDetailLoading: false });
    }
  },

  closeRunDetail: () => set({ runDetail: null, runDetailLoading: false }),

  explainChanges: async () => {
    const project = get().activeProject;
    if (get().status !== 'connected' || !project) return;
    set((s) => ({
      chat: [...s.chat, { kind: 'user', text: 'Explain the working-tree changes.' }],
      streaming: true,
    }));
    try {
      const result = await wingmanExplain(project, null, false);
      // The route answers directly; no agent turn, no tokens billed. Output is
      // JSON when the subcommand emits it and `{stdout,...}` when it doesn't.
      const r = result as { stdout?: unknown; summary?: unknown };
      const text = str(r.summary) || str(r.stdout) || JSON.stringify(result, null, 2);
      set((s) => ({ chat: [...s.chat, { kind: 'assistant', text }], streaming: false }));
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

    // The daemon's own stream terminator, carrying the turn child's exit code
    // and — only on failure — a tail of its stderr. A clean turn sends `stop`
    // first and this is redundant; a child that dies without one (worker
    // crash, hard provider failure) sends only this, and without surfacing it
    // the composer would simply re-enable with nothing shown.
    case 'end': {
      const exit = num(p.exit);
      if (exit !== 0) {
        const detail = str(p.stderr).trim();
        set((s) => ({
          chat: [
            ...s.chat,
            {
              kind: 'error',
              message: detail
                ? `agent exited ${exit}\n${detail}`
                : `agent exited ${exit}`,
            },
          ],
          streaming: false,
        }));
        return;
      }
      set(() => ({ streaming: false }));
      return;
    }

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

/** One agent-authored change set awaiting a human. Flattens the board's
 *  card → run → task nesting into the unit a reviewer actually works in: a
 *  worktree with a diff in it. */
export interface ReviewItem {
  cardId: string;
  cardTitle: string;
  project: string;
  runId: string | null;
  task: WingmanSubRow;
  /** Non-null by construction — a task without a worktree has nothing to
   *  review and never reaches the queue. */
  worktree: string;
}

/** Tasks needing a decision sort first. Everything else is context. */
const REVIEW_PRIORITY: Record<string, number> = {
  review: 0,
  failed: 1,
  in_progress: 2,
  done: 3,
};

/**
 * Build the review queue from the board.
 *
 * The board is organised for *dispatching* work — by card, by column. Review
 * is the opposite job: you want every change set an agent produced, across
 * every card and run, ordered by what needs a decision. So this flattens the
 * hierarchy and re-sorts it rather than reusing the board's shape.
 *
 * Only tasks with a worktree qualify: no worktree means no diff, and a queue
 * entry you can't act on is noise.
 */
export function reviewQueue(cards: WingmanCard[]): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const card of cards ?? []) {
    for (const task of card.rollup?.subrows ?? []) {
      if (!task.worktree) continue;
      items.push({
        cardId: card.id,
        cardTitle: card.title || card.goal || card.short || card.id,
        project: card.project,
        runId: card.run_id,
        task,
        worktree: task.worktree,
      });
    }
  }
  return items.sort((a, b) => {
    const pa = REVIEW_PRIORITY[a.task.status] ?? 9;
    const pb = REVIEW_PRIORITY[b.task.status] ?? 9;
    if (pa !== pb) return pa - pb;
    // Within a status, most expensive first — the costliest work is the most
    // wasteful to leave unreviewed.
    return b.task.usd - a.task.usd;
  });
}

/**
 * How many change sets are waiting on a human right now. Every entry point
 * into the review queue badges this same number, so it derives in one place.
 */
export function pendingReviewCount(cards: WingmanCard[]): number {
  return reviewQueue(cards).filter((i) => ['review', 'failed'].includes(i.task.status)).length;
}

/**
 * Replay a stored transcript into panel rows.
 *
 * Two shapes have to reconcile. A live turn arrives as a flat event stream
 * where `tool_start` and `tool_result` are separate events matched by id. A
 * stored transcript nests tool *calls* inside an assistant message's `blocks`
 * and records each tool *result* as its own top-level record, keyed by the same
 * id. So the call rows are built first and results are folded onto them
 * afterwards — exactly what `applyEvent` does for `tool_result`, which is why
 * a resumed conversation looks identical to one you just watched stream.
 *
 * Unknown record kinds are skipped rather than rendered: Wingman writes
 * variants ARC has no row for (compaction recaps, pruned tool results,
 * per-turn system-prompt splices), and an older ARC must not break on a newer
 * daemon's log.
 */
export function transcriptToChat(records: WingmanSessionRecord[]): ChatItem[] {
  const chat: ChatItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const rec of records ?? []) {
    switch (rec.kind) {
      case 'user': {
        const text = str((rec as { text?: unknown }).text);
        if (text) chat.push({ kind: 'user', text });
        break;
      }

      case 'assistant': {
        const blocks = (rec as { blocks?: WingmanContentBlock[] }).blocks ?? [];
        for (const b of blocks) {
          if (b.type === 'text') {
            const text = str((b as { text?: unknown }).text);
            // Coalesce with a preceding assistant row: one stored message can
            // hold several text blocks, and they read as one answer.
            const last = chat[chat.length - 1];
            if (text && last && last.kind === 'assistant') last.text += text;
            else if (text) chat.push({ kind: 'assistant', text });
          } else if (b.type === 'thinking') {
            const text = str((b as { text?: unknown }).text);
            if (text) chat.push({ kind: 'thinking', text });
          } else if (b.type === 'tool_use') {
            const id = str((b as { id?: unknown }).id);
            toolIndex.set(id, chat.length);
            chat.push({
              kind: 'tool',
              id,
              name: str((b as { name?: unknown }).name),
              input: (b as { input?: unknown }).input,
            });
          }
          // `image` and any future block type: no row.
        }
        break;
      }

      case 'tool_result': {
        const id = str((rec as { id?: unknown }).id);
        const at = toolIndex.get(id);
        if (at === undefined) break; // result without a call — drop it
        const row = chat[at];
        if (row?.kind !== 'tool') break;
        row.output = str((rec as { output?: unknown }).output);
        row.isError = Boolean((rec as { is_error?: unknown }).is_error);
        break;
      }

      default:
        break;
    }
  }
  return chat;
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
