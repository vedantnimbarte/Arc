import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type PtyId = string;

export interface PtySpawnOptions {
  shell?: string | null;
  cwd?: string | null;
  cols: number;
  rows: number;
}

export interface PtyDataEvent {
  id: PtyId;
  bytes: number[];
}

export interface PtyExitEvent {
  id: PtyId;
  code: number | null;
}

export async function ptySpawn(opts: PtySpawnOptions): Promise<PtyId> {
  return invoke<PtyId>('pty_spawn', { opts });
}

export async function ptyWrite(id: PtyId, data: string): Promise<void> {
  await invoke('pty_write', { id, data });
}

export async function ptyResize(id: PtyId, cols: number, rows: number): Promise<void> {
  await invoke('pty_resize', { id, cols, rows });
}

export async function ptyKill(id: PtyId): Promise<void> {
  await invoke('pty_kill', { id });
}

export async function onPtyData(
  id: PtyId,
  handler: (chunk: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<PtyDataEvent>(`pty://data/${id}`, (event) => {
    handler(new Uint8Array(event.payload.bytes));
  });
}

export async function onPtyExit(
  id: PtyId,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>(`pty://exit/${id}`, (event) => {
    handler(event.payload.code);
  });
}

// ----- Filesystem (file tree panel) --------------------------------------

export type FsKind = 'dir' | 'file' | 'symlink';

export interface FsEntry {
  name: string;
  path: string;
  kind: FsKind;
  hidden: boolean;
}

export async function fsDefaultRoot(): Promise<string> {
  return invoke<string>('fs_default_root');
}

export async function fsParent(path: string): Promise<string | null> {
  return invoke<string | null>('fs_parent', { path });
}

export async function fsReadDir(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('fs_read_dir', { path });
}

export async function fsPickFolder(starting?: string | null): Promise<string | null> {
  return invoke<string | null>('fs_pick_folder', { starting: starting ?? null });
}

export async function fsReadFile(path: string): Promise<string> {
  return invoke<string>('fs_read_file', { path });
}

export async function fsWriteFile(path: string, content: string): Promise<void> {
  return invoke<void>('fs_write_file', { path, content });
}

/**
 * Start watching `path` recursively. Returns a `watchId` and an
 * `UnlistenFn` for the change-event listener; debounced "something
 * changed" events fire on `fs://change/<watchId>`. Caller is responsible
 * for both unlistening AND invoking `fsWatchStop(id)` to release the
 * notify watcher on the Rust side.
 */
export async function fsWatchStart(
  path: string,
  onChange: () => void,
): Promise<{ watchId: string; unlisten: UnlistenFn }> {
  const watchId = await invoke<string>('fs_watch_start', { path });
  const unlisten = await listen(`fs://change/${watchId}`, () => onChange());
  return { watchId, unlisten };
}

export async function fsWatchStop(watchId: string): Promise<void> {
  await invoke('fs_watch_stop', { watchId });
}

// ----- Secrets (OS credential vault) ------------------------------------

export async function secretsSetApiKey(provider: LlmProvider, key: string): Promise<void> {
  await invoke('secrets_set_api_key', { provider, key });
}

export async function secretsGetApiKey(provider: LlmProvider): Promise<string | null> {
  return invoke<string | null>('secrets_get_api_key', { provider });
}

export async function secretsDeleteApiKey(provider: LlmProvider): Promise<void> {
  await invoke('secrets_delete_api_key', { provider });
}

// ----- LLM streaming -----------------------------------------------------

export type LlmProvider = 'openai' | 'anthropic' | 'ollama';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmStreamReq {
  id: string;
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
  api_key?: string;
  base_url?: string;
}

export interface LlmChunk {
  text: string;
  done: boolean;
}

export interface LlmDoneEvent {
  ok?: true;
  cancelled?: true;
  error?: string;
}

/**
 * Start a streaming LLM completion. Returns a cancel function. `onChunk`
 * fires for every text delta, `onDone` fires exactly once with the final
 * status. Both happen on the main thread.
 */
export async function llmStream(
  req: LlmStreamReq,
  onChunk: (chunk: LlmChunk) => void,
  onDone: (ev: LlmDoneEvent) => void,
): Promise<() => Promise<void>> {
  const unlistenChunk = await listen<LlmChunk>(`llm://chunk/${req.id}`, (e) => onChunk(e.payload));
  const unlistenDone = await listen<LlmDoneEvent>(`llm://done/${req.id}`, (e) => {
    unlistenChunk();
    unlistenDone();
    onDone(e.payload);
  });

  try {
    await invoke('llm_stream', { req });
  } catch (err) {
    unlistenChunk();
    unlistenDone();
    onDone({ error: String(err) });
  }

  return async () => {
    unlistenChunk();
    unlistenDone();
    try {
      await invoke('llm_cancel', { id: req.id });
    } catch {
      /* already gone */
    }
  };
}

// ----- Session / persistence --------------------------------------------
//
// Nested struct fields (Tab, Workspace, ChatMessage) use snake_case to match
// the Rust DTOs serialized via serde defaults. Outer invoke arguments use
// camelCase — Tauri converts them to snake_case Rust params automatically.

export type TabKind = 'terminal' | 'editor';

export interface TabInput {
  id: string;
  title: string;
  kind: TabKind;
  file_path?: string | null;
}

export interface PersistedTab extends TabInput {
  session_id: string;
  position: number;
}

export interface PersistedSession {
  id: string;
  workspace_id: string | null;
  active_tab_id: string | null;
  created_at: number;
  last_active_at: number;
}

export interface SessionState {
  session: PersistedSession;
  tabs: PersistedTab[];
}

export interface Workspace {
  id: string;
  name: string;
  root: string;
  created_at: number;
  last_opened_at: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatConversation {
  id: string;
  workspace_id: string | null;
  title: string | null;
  created_at: number;
  last_message_at: number;
}

export interface PersistedChatMessage {
  id: string;
  conversation_id: string;
  role: ChatRole;
  content: string;
  created_at: number;
}

export interface ChatLoad {
  conversation: ChatConversation;
  messages: PersistedChatMessage[];
}

// Sessions / tabs

export async function sessionLoad(): Promise<SessionState> {
  return invoke<SessionState>('session_load');
}

export async function sessionSaveTabs(
  sessionId: string,
  tabs: TabInput[],
  activeTabId: string | null,
): Promise<void> {
  await invoke('session_save_tabs', { sessionId, tabs, activeTabId });
}

export async function sessionSetWorkspace(
  sessionId: string,
  workspaceId: string | null,
): Promise<void> {
  await invoke('session_set_workspace', { sessionId, workspaceId });
}

// Workspaces

export async function sessionWorkspacesList(): Promise<Workspace[]> {
  return invoke<Workspace[]>('session_workspaces_list');
}

export async function sessionWorkspaceUpsert(
  name: string,
  root: string,
): Promise<Workspace> {
  return invoke<Workspace>('session_workspace_upsert', { name, root });
}

export async function sessionWorkspaceDelete(id: string): Promise<void> {
  await invoke('session_workspace_delete', { id });
}

// Chat history

export async function sessionChatLoad(
  workspaceId?: string | null,
): Promise<ChatLoad> {
  return invoke<ChatLoad>('session_chat_load', { workspaceId: workspaceId ?? null });
}

export async function sessionChatAppend(
  conversationId: string,
  role: ChatRole,
  content: string,
): Promise<PersistedChatMessage> {
  return invoke<PersistedChatMessage>('session_chat_append', {
    conversationId,
    role,
    content,
  });
}

export async function sessionChatClear(conversationId: string): Promise<void> {
  await invoke('session_chat_clear', { conversationId });
}

// ----- Git introspection ------------------------------------------------

export interface GitInfo {
  branch: string | null;
  head_short: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

/** Returns null when `path` isn't inside a git repo (or git is unavailable). */
export async function gitStatus(path: string): Promise<GitInfo | null> {
  return invoke<GitInfo | null>('git_status', { path });
}
