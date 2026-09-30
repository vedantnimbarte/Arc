import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  claudeAvailable,
  claudePermissionRespond,
  claudeSessionLoad,
  claudeTurnCancel,
  claudeTurnStart,
  isTauri,
  onClaudeTurn,
  type ClaudePermissionMode,
  type ClaudeStreamEvent,
} from '../lib/tauri';
import { useFiles } from './files';
import { useSettings } from './settings';
import { useWorkspace } from './workspace';

/**
 * Claude Code integration state.
 *
 * The shape deliberately mirrors `state/wingman.ts` — same transcript rows,
 * same event vocabulary — because the two panels do the same job and ARC
 * shouldn't grow two mental models for "an agent said something". What differs
 * is underneath: there is no daemon and no connection. ARC spawns the user's
 * own `claude` binary per turn, so the only gate is whether it's installed.
 *
 * Conversation history lives in the CLI, not here: each turn reports a
 * `sessionId`, and passing it back as `resume` continues the same thread.
 *
 * There is one session per surface: `useClaudeCode` carries the sidebar
 * panel's, and every Claude Code window gets its own store from
 * `claudeWindow(tabId)`. All of them share `sessionSlice` and `applyEvent`.
 */

/** Feature gate. `unavailable` means the CLI isn't on PATH — the common case
 *  for users who don't have it, and never an error. */
export type ClaudeStatus = 'checking' | 'ready' | 'unavailable';

/** One rendered transcript row. Identical vocabulary to the Wingman panel's. */
export type ClaudeChatItem =
  | { kind: 'user'; text: string; attachments?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'error'; message: string }
  /** A permission the user answered. Kept in the transcript so the record of
   *  what was allowed sits next to what it then did. */
  | { kind: 'decision'; tool: string; allowed: boolean; summary: string };

/** A tool call the CLI is waiting on. The turn is genuinely paused while this
 *  is set — Claude is blocked on the answer, not merely slow. */
export interface ClaudePermission {
  requestId: string;
  tool: string;
  input: unknown;
  /** MCP tools can supply their own display block; plain tools have neither. */
  title: string | null;
  description: string | null;
  /** One-line rendering of what will actually run. */
  summary: string;
}

export interface ClaudeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A file Claude wrote during this conversation, in the order first touched.
 *  This is the review queue: Claude Code edits the working tree directly, so
 *  the diff is already there — all ARC has to remember is which paths to open. */
export interface ClaudeEditedFile {
  /** Absolute path, as the tool call gave it. */
  path: string;
  /** Which tool wrote it — `Write` is a whole-file replacement, `Edit` a patch. */
  tool: string;
  /** Bumped when a later turn touches the same file again. */
  edits: number;
}

/** A file attached to a prompt: text is inlined, images go as image blocks. */
export type ClaudeAttachment =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'image'; name: string; mediaType: string; data: string };

/** One conversation: its transcript, the live turn, and the actions on it. */
export interface ClaudeSession {
  /** CLI-held conversation id, from the turn's `init`. Null until the first turn. */
  sessionId: string | null;
  chat: ClaudeChatItem[];
  streaming: boolean;
  /** Topic of the in-flight turn, so it can be cancelled. */
  activeTopic: string | null;

  usage: ClaudeUsage | null;
  /** Cumulative USD across this conversation. The CLI bills per turn; the
   *  running total is the number that actually answers "what has this cost me". */
  costUsd: number;
  /** Tools Claude asked for and the permission mode refused, from the last
   *  turn's result. Surfaced because a denial otherwise looks like Claude
   *  simply choosing not to do the work. */
  denials: string[];

  editedFiles: ClaudeEditedFile[];

  /** The permission prompt currently blocking the turn, if any.
   *
   *  Only ever one: the CLI asks for a tool, waits, then asks for the next. A
   *  queue would imply a concurrency the protocol doesn't have. */
  pending: ClaudePermission | null;

  /** Answer the pending permission prompt and unblock the turn. */
  respond: (allow: boolean, message?: string) => Promise<void>;
  send: (prompt: string, attachments?: ClaudeAttachment[]) => Promise<void>;
  /** Stop the in-flight turn. */
  cancel: () => Promise<void>;
  /** Drop the conversation and start a fresh session on the next turn. */
  newChat: () => void;
  /** Replace the transcript with a recorded conversation, continued from the
   *  next turn. */
  loadSession: (cwd: string, id: string) => Promise<void>;
  /** Open one of Claude's edits in ARC's diff viewer, against the working tree. */
  openEditedFile: (path: string) => void;
}

interface ClaudeState extends ClaudeSession {
  status: ClaudeStatus;
  /** Resolved binary path — shown in Settings so "not installed" is diagnosable. */
  binary: string | null;
  /** Probe for the CLI. Safe to call repeatedly; called on boot. */
  detect: () => Promise<void>;
}

/** A Claude Code window's own settings, persisted with its tab. */
export interface ClaudeWindowPrefs {
  cwd: string | null;
  model: string;
  permissionMode: ClaudePermissionMode;
  sidebarHidden: boolean;
}

export type ClaudeWindowSession = ClaudeSession & ClaudeWindowPrefs;

/** Any session store's hook — the panel's `useClaudeCode` or a window's. */
export type ClaudeSessionHook = <T>(selector: (s: ClaudeSession) => T) => T;

/** Where and how a session's turns run. Read at send time, so a window's
 *  dropdowns apply from the next turn. */
interface TurnConfig {
  cwd: string | null;
  model: string;
  permissionMode: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Tools whose input names a file Claude is about to write.
 *
 *  Read-only tools are deliberately absent: the review list exists to answer
 *  "what changed", and padding it with every file Claude looked at would bury
 *  the two it edited. */
const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Pull the written path out of a tool call, or null if it wrote nothing. */
export function editedPath(name: string, input: unknown): string | null {
  const key = WRITE_TOOLS[name];
  if (!key || !input || typeof input !== 'object') return null;
  const path = (input as Record<string, unknown>)[key];
  return typeof path === 'string' && path.trim() ? path : null;
}

type SessionSet = (
  patch: Partial<ClaudeSession> | ((s: ClaudeSession) => Partial<ClaudeSession>),
) => void;

/** Every live session store, so a send can see whether the same conversation
 *  is already running in another window. */
const registry = new Set<StoreApi<ClaudeSession>>();

/** True when a session other than `self` is streaming conversation `id`.
 *
 *  ponytail: only sees ARC's own sessions; a `claude` running in a terminal on
 *  the same conversation isn't detectable from here. */
export function sessionBusyElsewhere(id: string, self?: StoreApi<ClaudeSession>): boolean {
  for (const s of registry) {
    const st = s.getState();
    if (s !== self && st.streaming && st.sessionId === id) return true;
  }
  return false;
}

const EMPTY_SESSION = {
  sessionId: null,
  chat: [] as ClaudeChatItem[],
  streaming: false,
  activeTopic: null,
  usage: null,
  costUsd: 0,
  denials: [] as string[],
  editedFiles: [] as ClaudeEditedFile[],
  pending: null,
};

/** The conversation half of a store, shared by the panel and every window.
 *  `set`/`get`/`api` are the owning store's; `cfg` says where turns run. */
function sessionSlice(
  rawSet: unknown,
  rawGet: unknown,
  api: unknown,
  cfg: () => TurnConfig,
): ClaudeSession {
  const set = rawSet as SessionSet;
  const get = rawGet as () => ClaudeSession;
  const self = api as StoreApi<ClaudeSession>;
  registry.add(self);
  /** Teardown handle for this session's live turn. Outside the store so it
   *  never lands in a React render path or a devtools snapshot. */
  let unlisten: UnlistenFn | null = null;
  /** Bumped per load so a slow load can't land over a later one. */
  let loadSeq = 0;
  const fail = (e: unknown) =>
    set((s) => ({
      chat: [...s.chat, { kind: 'error', message: e instanceof Error ? e.message : String(e) }],
    }));

  return {
    ...EMPTY_SESSION,

    newChat: () => {
      unlisten?.();
      unlisten = null;
      loadSeq++;
      set({ ...EMPTY_SESSION });
    },

    loadSession: async (cwd, id) => {
      if (get().streaming) return;
      const seq = ++loadSeq;
      let events: ClaudeStreamEvent[];
      try {
        events = await claudeSessionLoad(cwd, id);
      } catch (e) {
        if (seq === loadSeq) fail(e);
        return;
      }
      if (seq !== loadSeq || get().streaming) return;
      // Fold into a local copy and commit once: a long transcript is
      // thousands of events, and one render beats thousands.
      let acc: ClaudeSession = { ...get(), ...EMPTY_SESSION };
      for (const ev of events) {
        applyEvent((fn) => {
          acc = { ...acc, ...fn(acc) };
        }, ev);
      }
      set({
        ...EMPTY_SESSION,
        sessionId: id,
        chat: acc.chat,
        editedFiles: acc.editedFiles,
        usage: acc.usage,
      });
    },

    respond: async (allow, message) => {
      const { pending, activeTopic } = get();
      if (!pending || !activeTopic) return;
      // Clear before the call, not after: the CLI resumes the moment it reads
      // the answer, and a prompt still on screen would invite a second click
      // that lands on a request id the turn has already moved past.
      set((s) => ({
        pending: null,
        chat: [
          ...s.chat,
          { kind: 'decision', tool: pending.tool, allowed: allow, summary: pending.summary },
        ],
      }));
      try {
        await claudePermissionRespond({
          topic: activeTopic,
          requestId: pending.requestId,
          allow,
          message: message ?? null,
        });
      } catch (e) {
        fail(e);
      }
    },

    cancel: async () => {
      const topic = get().activeTopic;
      if (!topic) return;
      // The turn's own terminal event flips `streaming` — killing the child
      // produces one, so there's nothing to reset here.
      await claudeTurnCancel(topic).catch(() => {});
    },

    openEditedFile: (path) => {
      // Claude Code edits the working tree in place, so the diff against HEAD is
      // exactly what ARC's Source Control already renders. Root at the session's
      // folder, not at the file — that's what the git stack expects.
      const root = cfg().cwd;
      if (!root) return;
      useWorkspace.getState().openDiff(path, root, 'worktree');
    },

    send: async (prompt, attachments = []) => {
      const { streaming, sessionId } = get();
      const { cwd, model, permissionMode } = cfg();
      // One turn at a time: a second child would be a second conversation, and
      // both would race to resume the same session id.
      if (useClaudeCode.getState().status !== 'ready' || streaming) return;
      if (!prompt.trim() && attachments.length === 0) return;
      if (!cwd) {
        fail(new Error('Open a folder before asking Claude about it.'));
        return;
      }
      if (sessionId && sessionBusyElsewhere(sessionId, self)) {
        fail(new Error('This conversation is running in another window.'));
        return;
      }

      set((s) => ({
        chat: [
          ...s.chat,
          attachments.length
            ? { kind: 'user', text: prompt, attachments: attachments.map((a) => a.name) }
            : { kind: 'user', text: prompt },
        ],
        streaming: true,
        denials: [],
        pending: null,
      }));

      try {
        const topic = await claudeTurnStart({
          cwd,
          content: buildContent(prompt, attachments),
          resume: sessionId,
          model: model || null,
          permissionMode,
          maxBudgetUsd: useSettings.getState().claudeMaxBudgetUsd || null,
        });
        set({ activeTopic: topic });

        unlisten?.();
        unlisten = await onClaudeTurn(topic, (ev) => applyEvent(set, ev));
      } catch (e) {
        fail(e);
        set({ streaming: false, activeTopic: null });
      }
    },
  };
}

export const useClaudeCode = create<ClaudeState>((set, get, api) => ({
  status: 'checking',
  binary: null,

  detect: async () => {
    // Browser-only dev build has no IPC. Report unavailable rather than
    // throwing — the panel's disconnected state is already the right UI.
    if (!isTauri) {
      set({ status: 'unavailable', binary: null });
      return;
    }
    try {
      const binary = await claudeAvailable();
      set({ status: binary ? 'ready' : 'unavailable', binary });
    } catch {
      set({ status: 'unavailable', binary: null });
    }
  },

  // The sidebar panel follows the file tree and the Settings defaults.
  ...sessionSlice(set, get, api, () => {
    const settings = useSettings.getState();
    return {
      cwd: useFiles.getState().root,
      model: settings.claudeModel,
      permissionMode: settings.claudePermissionMode,
    };
  }),
}));

const windows = new Map<string, UseBoundStore<StoreApi<ClaudeWindowSession>>>();

/** The store for one Claude Code window, created on first use. `prefs` only
 *  seeds a new store; an existing one keeps its state. */
export function claudeWindow(
  tabId: string,
  prefs: ClaudeWindowPrefs,
): UseBoundStore<StoreApi<ClaudeWindowSession>> {
  let store = windows.get(tabId);
  if (!store) {
    store = create<ClaudeWindowSession>()((set, get, api) => ({
      ...sessionSlice(set, get, api, () => get()),
      ...prefs,
    }));
    windows.set(tabId, store);
  }
  return store;
}

/** Tear down a closed window: kill its turn and forget its store. */
export function disposeClaudeWindow(tabId: string): void {
  const store = windows.get(tabId);
  if (!store) return;
  void store.getState().cancel();
  store.getState().newChat();
  registry.delete(store as unknown as StoreApi<ClaudeSession>);
  windows.delete(tabId);
}

/** The user message's content blocks. Text files are inlined into the prompt
 *  (the CLI takes no document block for local text); images go as image blocks. */
export function buildContent(prompt: string, attachments: ClaudeAttachment[]): unknown[] {
  let text = prompt;
  for (const a of attachments) {
    if (a.kind === 'text') text += `\n\n<file name="${a.name}">\n${a.text}\n</file>`;
  }
  const blocks: unknown[] = [];
  if (text.trim()) blocks.push({ type: 'text', text: text.trim() });
  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data: a.data },
      });
    }
  }
  return blocks;
}

/** Lines added / removed by a write tool call, or null for anything else. */
export function diffStat(name: string, input: unknown): { add: number; del: number } | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const lines = (v: unknown) => (typeof v === 'string' && v ? v.split('\n').length : 0);
  switch (name) {
    case 'Edit':
      return { add: lines(o.new_string), del: lines(o.old_string) };
    case 'MultiEdit': {
      const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [];
      return edits.reduce<{ add: number; del: number }>(
        (acc, e) => ({ add: acc.add + lines(e?.new_string), del: acc.del + lines(e?.old_string) }),
        { add: 0, del: 0 },
      );
    }
    case 'Write':
      return { add: lines(o.content), del: 0 };
    default:
      return null;
  }
}

/**
 * Fold one stream event into the transcript.
 *
 * Text and thinking deltas append to the trailing row of the same kind rather
 * than pushing a new one — otherwise a turn produces one row per token.
 */
function applyEvent(
  set: (fn: (s: ClaudeSession) => Partial<ClaudeSession>) => void,
  ev: ClaudeStreamEvent,
): void {
  const p = ev.payload ?? {};

  switch (ev.kind) {
    // The CLI mints the session id, so ARC learns it from the first turn and
    // replays it as `resume` from then on.
    case 'init':
      set(() => ({ sessionId: str(p.session_id) || null }));
      return;

    // A typed prompt, from a replayed transcript.
    case 'user':
      set((s) => ({ chat: [...s.chat, { kind: 'user', text: str(p.text) }] }));
      return;

    case 'text_delta':
    case 'thinking_delta': {
      const kind = ev.kind === 'text_delta' ? 'assistant' : 'thinking';
      const text = str(p.text);
      if (!text) return;
      set((s) => {
        const last = s.chat[s.chat.length - 1];
        if (last && last.kind === kind) {
          const chat = s.chat.slice(0, -1);
          chat.push({ kind, text: last.text + text } as ClaudeChatItem);
          return { chat };
        }
        return { chat: [...s.chat, { kind, text } as ClaudeChatItem] };
      });
      return;
    }

    // The turn is now blocked on the user. Nothing else arrives until
    // `respond` answers it or the turn is cancelled.
    case 'permission_request': {
      const tool = str(p.display_name) || str(p.tool_name) || 'tool';
      set(() => ({
        pending: {
          requestId: str(p.request_id),
          tool,
          input: p.input,
          title: str(p.title) || null,
          description: str(p.description) || null,
          summary: summarizeToolInput(str(p.tool_name), p.input),
        },
      }));
      return;
    }

    case 'tool_start': {
      const name = str(p.name);
      const path = editedPath(name, p.input);
      set((s) => ({
        chat: [...s.chat, { kind: 'tool', id: str(p.id), name, input: p.input }],
        // Record the edit at call time, not on the result: a tool that fails
        // still leaves the file worth looking at, and the reviewer is better
        // served by a diff that turns out empty than by a missing entry.
        editedFiles: path ? withEdit(s.editedFiles, path, name) : s.editedFiles,
      }));
      return;
    }

    case 'tool_result':
      // Match the result onto its call so the UI shows one row per tool, not a
      // call row and an orphaned result row.
      set((s) => {
        const id = str(p.id);
        const idx = s.chat.findIndex((c) => c.kind === 'tool' && c.id === id);
        if (idx === -1) return {};
        const chat = [...s.chat];
        const row = chat[idx] as Extract<ClaudeChatItem, { kind: 'tool' }>;
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

    // The CLI's terminal line for a turn. `done` still follows (the child has
    // to exit), so this only records the turn's outcome and leaves `streaming`
    // to the process teardown.
    case 'result': {
      const denials = Array.isArray(p.permission_denials)
        ? p.permission_denials
            .map((d) =>
              typeof d === 'object' && d !== null
                ? str((d as Record<string, unknown>).tool_name)
                : str(d),
            )
            .filter(Boolean)
        : [];
      set((s) => ({
        sessionId: str(p.session_id) || s.sessionId,
        costUsd: s.costUsd + num(p.cost_usd),
        denials,
        // A turn can fail after producing output (budget exhausted, API error
        // mid-stream). The row makes that visible instead of leaving a reply
        // that just stops.
        chat:
          p.is_error === true
            ? [...s.chat, { kind: 'error', message: str(p.text) || 'the turn failed' }]
            : s.chat,
      }));
      return;
    }

    // Both terminal paths drop `pending`: a cancelled turn leaves a prompt
    // on screen that answers into a dead process otherwise.
    case 'error':
      set((s) => ({
        chat: [...s.chat, { kind: 'error', message: str(p.message) || 'the turn failed' }],
        streaming: false,
        activeTopic: null,
        pending: null,
      }));
      return;

    case 'done':
      set(() => ({ streaming: false, activeTopic: null, pending: null }));
      return;

    default:
      return;
  }
}

/**
 * One line describing what a tool call will actually do.
 *
 * This is the whole value of an approval prompt: "allow Bash?" is not a
 * decision anyone can make, and `rm -rf build` is. Each known tool has one
 * field that carries the substance; everything else falls back to compact JSON
 * rather than showing nothing.
 */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
      return first('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return first('file_path');
    case 'NotebookEdit':
      return first('notebook_path');
    case 'Glob':
    case 'Grep':
      return first('pattern');
    case 'WebFetch':
    case 'WebSearch':
      return first('url', 'query');
    default: {
      const json = JSON.stringify(o);
      return json.length > 300 ? `${json.slice(0, 300)}…` : json;
    }
  }
}

/** Add or bump one entry in the edited-file list, preserving first-touch order. */
function withEdit(
  files: ClaudeEditedFile[],
  path: string,
  tool: string,
): ClaudeEditedFile[] {
  const at = files.findIndex((f) => f.path === path);
  const prev = at === -1 ? undefined : files[at];
  if (!prev) return [...files, { path, tool, edits: 1 }];
  const next = [...files];
  next[at] = { ...prev, tool, edits: prev.edits + 1 };
  return next;
}

/** Reset for tests. Not used by the app. */
export function __resetClaudeForTests(): void {
  for (const id of [...windows.keys()]) disposeClaudeWindow(id);
  useClaudeCode.getState().newChat();
  useClaudeCode.setState({ status: 'ready' });
}

export { applyEvent as __applyEventForTests };
