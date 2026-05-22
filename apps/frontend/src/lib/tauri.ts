import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { McpNotification, McpTool } from '@arc/mcp';

export type { McpNotification, McpTool };

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

/** One shell discovered on `PATH`. `is_default` flags the OS default
 *  (COMSPEC on Windows, `$SHELL` elsewhere). */
export interface ShellInfo {
  label: string;
  path: string;
  is_default: boolean;
}

/**
 * Enumerate known shells available on the user's PATH. Used by the
 * settings UI to populate the shell picker. The list may be empty on
 * stripped environments — the picker still allows a custom path.
 */
export async function ptyListShells(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>('pty_list_shells');
}

/** Stable id assigned to each AI CLI by the Rust detector. */
export type AiCliId = 'claude-cli' | 'codex-cli' | 'opencode-cli';

/** One installed AI coding-agent CLI discovered on PATH. */
export interface AiCliInfo {
  id: AiCliId;
  label: string;
  path: string;
}

/**
 * Enumerate AI coding-agent CLIs installed on the user's PATH (Claude Code,
 * OpenAI Codex, OpenCode). Used by the launcher UI in TabBar / new-tab popover
 * and by the chat panel to gate `local-cli` providers behind "is it installed".
 */
export async function ptyListAiClis(): Promise<AiCliInfo[]> {
  return invoke<AiCliInfo[]>('pty_list_ai_clis');
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

export interface SearchHit {
  path: string;
  name: string;
  line: number;
  snippet: string;
  score: number;
}

export async function fsSearch(root: string, query: string, limit: number): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('fs_search', { root, query, limit });
}

/**
 * Build (or rebuild) the persistent tantivy index for `root`. Returns the
 * number of documents indexed. Subsequent `fsSearch` calls will use the
 * index automatically — no flag to flip.
 */
export async function fsIndexRebuild(root: string): Promise<number> {
  return invoke<number>('fs_index_rebuild', { root });
}

/** True when a tantivy index exists on disk for this root. */
export async function fsIndexStatus(root: string): Promise<boolean> {
  return invoke<boolean>('fs_index_status', { root });
}

/** Rename `path` to `newName` (basename only, within the same directory). Returns the new absolute path. */
export async function fsRename(path: string, newName: string): Promise<string> {
  return invoke<string>('fs_rename', { path, newName });
}

/** Delete a file or directory (recursive for directories). */
export async function fsDelete(path: string): Promise<void> {
  await invoke('fs_delete', { path });
}

/** Reveal `path` in the OS file manager (Finder on macOS, Explorer on Windows, xdg-open on Linux). */
export async function fsReveal(path: string): Promise<void> {
  await invoke('fs_reveal', { path });
}

/** Create a directory (and any missing ancestors) at `path`. */
export async function fsCreateDir(path: string): Promise<void> {
  await invoke('fs_create_dir', { path });
}

// ----- Secrets (OS credential vault) ------------------------------------

// Provider id here is a preset id (e.g. `'openai'`, `'deepseek'`, `'lmstudio'`)
// — the Rust side stores per arbitrary string under the same keyring service,
// so the typing stays loose on purpose.
export async function secretsSetApiKey(provider: string, key: string): Promise<void> {
  await invoke('secrets_set_api_key', { provider, key });
}

export async function secretsGetApiKey(provider: string): Promise<string | null> {
  return invoke<string | null>('secrets_get_api_key', { provider });
}

export async function secretsDeleteApiKey(provider: string): Promise<void> {
  await invoke('secrets_delete_api_key', { provider });
}

// ----- Agent runtime ----------------------------------------------------

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_start'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean; output: string }
  | {
      kind: 'approval_request';
      approval_id: string;
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  | { kind: 'done'; summary: string }
  | { kind: 'error'; message: string };

export interface AgentRunReq {
  id: string;
  goal: string;
  api_key: string;
  model: string;
  workspace_root: string | null;
  workspace_id: string | null;
  /** Persona prompt layered on top of the runtime's default agent prompt. */
  system_prompt?: string | null;
}

/**
 * Kick off a coding-agent run. Events stream via `agent://event/<id>`;
 * the promise resolves as soon as the run is queued (not when it finishes).
 */
export async function agentRun(
  req: AgentRunReq,
  onEvent: (ev: AgentEvent) => void,
): Promise<UnlistenFn> {
  const unlisten = await listen<AgentEvent>(`agent://event/${req.id}`, (e) => {
    onEvent(e.payload);
    if (e.payload.kind === 'done' || e.payload.kind === 'error') {
      // Tear down on terminal events. We capture the unlisten function
      // into a self-clearing reference below to support both the
      // immediate await and this auto-cleanup path.
      autoCleanup?.();
    }
  });
  let autoCleanup: (() => void) | null = unlisten;
  await invoke('agent_run', { req });
  return () => {
    autoCleanup = null;
    unlisten();
  };
}

/** Resolve a pending tool-approval prompt. Idempotent on the second call
 *  for the same `approvalId` (e.g. double-click on Approve): the backend
 *  will reject the duplicate but we swallow the error here. */
export async function agentDecide(approvalId: string, approve: boolean): Promise<void> {
  try {
    await invoke('agent_decide', { approvalId, approve });
  } catch (err) {
    // Stale approval id is not user-actionable.
    console.warn('[agent] decide ignored:', err);
  }
}

// ----- MCP client -------------------------------------------------------
//
// `McpTool` and `McpNotification` shapes are imported from `@arc/mcp` and
// re-exported above so existing consumers keep importing from this module.

export async function mcpConnect(id: string, command: string, args: string[]): Promise<void> {
  await invoke('mcp_connect', { id, command, args });
}

/**
 * Connect over MCP's Streamable HTTP transport (2025-03-26 spec). The
 * server URL is POSTed to with JSON-RPC; responses may come back as either
 * plain `application/json` or an SSE stream — both are handled.
 */
export async function mcpConnectHttp(
  id: string,
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  await invoke('mcp_connect_http', {
    id,
    url,
    headers: headers ?? null,
  });
}

export async function mcpListTools(id: string): Promise<McpTool[]> {
  return invoke<McpTool[]>('mcp_list_tools', { id });
}

export async function mcpCallTool(id: string, name: string, args: unknown): Promise<string> {
  return invoke<string>('mcp_call_tool', { id, name, args });
}

export async function mcpDisconnect(id: string): Promise<void> {
  await invoke('mcp_disconnect', { id });
}

/**
 * Subscribe to server-initiated notifications from `id`. Fires for every
 * notification the transport sees: log messages, progress updates,
 * resource/tool list-changed pings, etc. Returns an unlisten function.
 * Payload shape is `McpNotification` (see `@arc/mcp`).
 */
export async function onMcpNotification(
  id: string,
  handler: (notif: McpNotification) => void,
): Promise<UnlistenFn> {
  return listen<McpNotification>(`mcp://notification/${id}`, (e) => handler(e.payload));
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

/** One row from the provider's model catalog. `id` is what's sent back in
 *  chat requests; `label` is a friendlier name when available. */
export interface ModelInfo {
  id: string;
  label?: string;
  context_window?: number;
  kind?: string;
}

/** Live-fetch the model catalog for a provider kind. */
export async function llmListModels(
  provider: LlmProvider,
  apiKey?: string,
  baseUrl?: string,
): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('llm_list_models', {
    provider,
    apiKey: apiKey ?? null,
    baseUrl: baseUrl ?? null,
  });
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
  /** UI agent persona id; NULL means the default "Chat Assistant". */
  agent_id: string | null;
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

// App settings (non-secret; persisted to SQLite)

/** Shape stored in the `app_settings` table under key `"user_settings"`.
 *
 *  Provider entries are keyed by preset id (a string — see
 *  `state/providers.ts`), not by the backend `LlmProvider` kind. The legacy
 *  `activeProvider` field is still written for forward-compat with older
 *  binaries opening the same DB; new code reads `activePresetId`. */
export interface PersistedSettings {
  /** Current preset id (e.g. `'openai'`, `'deepseek'`, `'lmstudio'`). */
  activePresetId?: string;
  /** Model id paired with the active preset. */
  currentModel?: string;
  /** Preset ids the user has enabled — listed in the model picker. */
  enabledPresetIds?: string[];
  /** Backend kind mirror — kept so older builds don't end up with an
   *  undefined provider when they read the same blob. */
  activeProvider?: LlmProvider;
  providers: Record<string, { model: string; baseUrl?: string }>;
  systemPrompt: string;
  defaultShell: string | null;
  /** Appearance preference: 'dark' | 'light' | 'system'. */
  appearance?: 'dark' | 'light' | 'system';
  /** Mono font id from `FONT_OPTIONS`. */
  fontId?: string;
  /** Terminal / editor font size in px. */
  fontSize?: number;
}

/** Returns the stored settings blob, or `null` on first launch. */
export async function sessionSettingsLoad(): Promise<PersistedSettings | null> {
  const raw = await invoke<string | null>('session_settings_load');
  if (!raw) return null;
  return JSON.parse(raw) as PersistedSettings;
}

/** Serialise and persist `settings` to SQLite. */
export async function sessionSettingsSave(settings: PersistedSettings): Promise<void> {
  await invoke('session_settings_save', { value: JSON.stringify(settings) });
}

/** Open (or focus, if already open) the standalone Settings window. */
export async function settingsWindowOpen(): Promise<void> {
  await invoke('settings_window_open');
}

/** Broadcast a `settings://changed` event so the other window re-hydrates
 *  its store. Fire-and-forget — the listener (if any) re-reads SQLite. */
export async function settingsBroadcastChanged(): Promise<void> {
  await invoke('settings_broadcast_changed');
}

/** Listen for cross-window settings updates. */
export async function onSettingsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen('settings://changed', () => handler());
}

// Chat sessions (multi-conversation)

export async function sessionChatSessionsList(
  workspaceId?: string | null,
): Promise<ChatConversation[]> {
  return invoke<ChatConversation[]>('session_chat_sessions_list', {
    workspaceId: workspaceId ?? null,
  });
}

export async function sessionChatSessionCreate(
  workspaceId: string | null,
  agentId: string | null,
  title: string | null,
): Promise<ChatConversation> {
  return invoke<ChatConversation>('session_chat_session_create', {
    workspaceId,
    agentId,
    title,
  });
}

export async function sessionChatSessionUpdate(
  id: string,
  patch: { title?: string | null; agentId?: string | null },
): Promise<void> {
  await invoke('session_chat_session_update', {
    id,
    title: patch.title ?? null,
    agentId: patch.agentId ?? null,
  });
}

export async function sessionChatSessionDelete(id: string): Promise<void> {
  await invoke('session_chat_session_delete', { id });
}

export async function sessionChatMessagesLoad(
  conversationId: string,
): Promise<PersistedChatMessage[]> {
  return invoke<PersistedChatMessage[]>('session_chat_messages_load', {
    conversationId,
  });
}

// Command history

export interface CommandRecord {
  id: number;
  session_id: string | null;
  tab_id: string | null;
  workspace_id: string | null;
  cwd: string | null;
  command: string;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
}

export interface CommandLogReq {
  sessionId: string | null;
  tabId: string | null;
  workspaceId: string | null;
  cwd: string | null;
  command: string;
}

export async function sessionCommandLog(req: CommandLogReq): Promise<number> {
  // Spread into a plain object so TS sees the Record<string, unknown> shape
  // that Tauri's invoke args require.
  return invoke<number>('session_command_log', { ...req });
}

export async function sessionCommandsRecent(
  limit: number,
  query?: string | null,
): Promise<CommandRecord[]> {
  return invoke<CommandRecord[]>('session_commands_recent', {
    limit,
    query: query ?? null,
  });
}

/**
 * Mark a previously-logged command finished. Called when the terminal sees
 * an OSC 133 `D[;<exit>]` sequence (shell integration). Output excerpt is
 * an optional buffer of what flowed between OSC 133 `C` and `D`, capped
 * Rust-side at 4 KiB.
 */
export async function sessionCommandFinish(
  id: number,
  exitCode: number | null,
  outputExcerpt: string | null,
): Promise<void> {
  await invoke('session_command_finish', {
    id,
    exitCode,
    outputExcerpt,
  });
}

// ----- Memory subsystem (workspace-scoped notes) ------------------------
//
// `workspaceId` semantics on the Rust side:
//   undefined / null  → entries with NULL workspace_id (global / unscoped)
//   "__all__"         → every entry, regardless of workspace
//   any other string  → filter to that workspace

export interface MemoryEntry {
  id: string;
  workspace_id: string | null;
  kind: string;
  title: string | null;
  content: string;
  /** Comma-separated; normalized to lowercase + sorted on save. */
  tags: string | null;
  source: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryHit {
  entry: MemoryEntry;
  /** FTS5 bm25 score — lower is more relevant. */
  score: number;
  /** `content` excerpt with matches wrapped in `[` … `]`. */
  snippet: string;
}

export interface MemorySaveReq {
  workspaceId?: string | null;
  kind?: string | null;
  title?: string | null;
  content: string;
  tags?: string | null;
  source?: string | null;
}

export async function memorySave(req: MemorySaveReq): Promise<MemoryEntry> {
  return invoke<MemoryEntry>('memory_save', {
    workspaceId: req.workspaceId ?? null,
    kind: req.kind ?? null,
    title: req.title ?? null,
    content: req.content,
    tags: req.tags ?? null,
    source: req.source ?? null,
  });
}

export async function memoryUpdate(
  id: string,
  patch: { title?: string | null; content?: string | null; tags?: string | null },
): Promise<void> {
  await invoke('memory_update', {
    id,
    title: patch.title ?? null,
    content: patch.content ?? null,
    tags: patch.tags ?? null,
  });
}

export async function memoryDelete(id: string): Promise<void> {
  await invoke('memory_delete', { id });
}

export async function memoryGet(id: string): Promise<MemoryEntry | null> {
  return invoke<MemoryEntry | null>('memory_get', { id });
}

export async function memoryList(
  workspaceId: string | null | undefined,
  limit: number,
): Promise<MemoryEntry[]> {
  return invoke<MemoryEntry[]>('memory_list', {
    workspaceId: workspaceId ?? null,
    limit,
  });
}

export async function memorySearch(
  workspaceId: string | null | undefined,
  query: string,
  limit: number,
): Promise<MemoryHit[]> {
  return invoke<MemoryHit[]>('memory_search', {
    workspaceId: workspaceId ?? null,
    query,
    limit,
  });
}

// ----- Memory vector search (V1) ----------------------------------------

export type EmbedProvider = 'openai' | 'ollama';

export interface MemoryEmbedReq {
  id: string;
  provider: EmbedProvider;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  /** Text to embed — typically the entry's `content` (caller decides). */
  text: string;
}

export interface MemoryVectorSearchReq {
  workspaceId?: string | null;
  provider: EmbedProvider;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  query: string;
  limit: number;
}

export interface VectorHit {
  entry: MemoryEntry;
  /** Cosine similarity in [-1, 1]; higher = more relevant. */
  similarity: number;
}

/** Compute an embedding for `text` and attach it to an existing entry. */
export async function memoryEmbedEntry(req: MemoryEmbedReq): Promise<void> {
  await invoke('memory_embed_entry', {
    id: req.id,
    provider: req.provider,
    model: req.model,
    apiKey: req.apiKey ?? null,
    baseUrl: req.baseUrl ?? null,
    text: req.text,
  });
}

/** Embed `query` and rank existing entries by cosine similarity. */
export async function memoryVectorSearch(req: MemoryVectorSearchReq): Promise<VectorHit[]> {
  return invoke<VectorHit[]>('memory_vector_search', {
    workspaceId: req.workspaceId ?? null,
    provider: req.provider,
    model: req.model,
    apiKey: req.apiKey ?? null,
    baseUrl: req.baseUrl ?? null,
    query: req.query,
    limit: req.limit,
  });
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

export type GitChangeKind = 'staged' | 'unstaged' | 'both' | 'untracked' | 'conflict';

export interface GitChangeEntry {
  /** Repository-relative path. */
  path: string;
  /** Original path for rename/copy entries. */
  orig_path: string | null;
  kind: GitChangeKind;
  /** Single-letter porcelain status (M / A / D / R / C / U / ?). */
  status: string;
}

/** Per-file working-copy status. Returns [] when not in a repo. */
export async function gitChanges(path: string): Promise<GitChangeEntry[]> {
  return invoke<GitChangeEntry[]>('git_changes', { path });
}

export interface GitLogEntry {
  oid: string;
  short: string;
  author: string;
  email: string;
  /** Unix seconds (author time). */
  time: number;
  subject: string;
  /** Full-SHA parent OIDs. Empty for the root commit; multiple for merges. */
  parents: string[];
}

export interface GitLogOptions {
  /** Restrict to commits touching this workspace-relative path. */
  pathFilter?: string | null;
  /** Unix seconds. Drop commits authored before this instant. */
  since?: number | null;
  /** Unix seconds. Drop commits authored after this instant. */
  until?: number | null;
  /** Case-insensitive substring matched against name OR email. */
  author?: string | null;
  /** Include merge commits — defaults to false everywhere except the graph view. */
  includeMerges?: boolean;
}

export async function gitLog(
  path: string,
  limit: number,
  options?: GitLogOptions | null,
): Promise<GitLogEntry[]> {
  // The Rust side derives serde defaults via #[serde(default)] only when the
  // *outer* options object is None, so we always send a struct — but with
  // nulls filtered to `undefined` so serde swallows them on the other end.
  const o = options ?? {};
  const payload = {
    path_filter: o.pathFilter ?? null,
    since: o.since ?? null,
    until: o.until ?? null,
    author: o.author ?? null,
    include_merges: o.includeMerges ?? false,
  };
  return invoke<GitLogEntry[]>('git_log', {
    path,
    limit,
    options: payload,
  });
}

export type GitDiffScope = 'worktree' | 'staged' | 'head';

/** Returns the unified-diff text. Empty string when nothing differs. */
export async function gitDiff(
  path: string,
  scope: GitDiffScope,
  pathFilter?: string | null,
): Promise<string> {
  return invoke<string>('git_diff', {
    path,
    scope,
    pathFilter: pathFilter ?? null,
  });
}

export interface GitBlameLine {
  line_number: number;
  oid: string;
  short: string;
  author: string;
  /** Unix seconds (author time). */
  time: number;
  content: string;
}

export async function gitBlame(
  path: string,
  file: string,
  range?: { start: number; end: number } | null,
): Promise<GitBlameLine[]> {
  return invoke<GitBlameLine[]>('git_blame', {
    path,
    file,
    startLine: range?.start ?? null,
    endLine: range?.end ?? null,
  });
}

export interface GitBranchInfo {
  /** Local: `main`. Remote: `origin/main`. */
  name: string;
  /** True for the current HEAD. */
  current: boolean;
  /** True for `refs/remotes/...`. */
  remote: boolean;
  /** Tracked upstream short name for locals (e.g. `origin/main`). */
  upstream: string | null;
  /** Short HEAD oid (7 chars). */
  head_short: string | null;
  /** Tip commit subject line. */
  subject: string | null;
  /** Committer time, unix seconds. */
  time: number;
}

/** List local + remote branches, sorted by recency. Empty when not a repo. */
export async function gitBranches(path: string): Promise<GitBranchInfo[]> {
  return invoke<GitBranchInfo[]>('git_branches', { path });
}

export interface GitCheckoutResult {
  branch: string | null;
  created_tracking: boolean;
}

/** Switch to `name`. Remote short names ("origin/foo") create a tracking local. */
export async function gitCheckout(
  path: string,
  name: string,
): Promise<GitCheckoutResult> {
  return invoke<GitCheckoutResult>('git_checkout', { path, name });
}

export interface GitAuthorInfo {
  name: string;
  email: string;
  commits: number;
}

/** Every committer reachable from any ref, ranked by commit count desc. */
export async function gitAuthors(path: string): Promise<GitAuthorInfo[]> {
  return invoke<GitAuthorInfo[]>('git_authors', { path });
}

/** Open (or focus, if already open) the standalone Git history window. */
export async function gitWindowOpen(): Promise<void> {
  await invoke('git_window_open');
}

/** Stage repository-relative paths. Empty array no-ops. */
export async function gitStage(path: string, paths: string[]): Promise<void> {
  await invoke('git_stage', { path, paths });
}

/** Unstage repository-relative paths (reset to working tree). */
export async function gitUnstage(path: string, paths: string[]): Promise<void> {
  await invoke('git_unstage', { path, paths });
}

export interface GitCommitResult {
  /** Short SHA of the newly-created commit. */
  short: string;
  subject: string;
}

/** Commit whatever is currently staged with `message`. */
export async function gitCommit(
  path: string,
  message: string,
): Promise<GitCommitResult> {
  return invoke<GitCommitResult>('git_commit', { path, message });
}

/**
 * Discard local changes. `trackedPaths` are restored from HEAD; `untrackedPaths`
 * are deleted from disk. Either list may be empty.
 */
export async function gitDiscard(
  path: string,
  trackedPaths: string[],
  untrackedPaths: string[],
): Promise<void> {
  await invoke('git_discard', {
    path,
    trackedPaths,
    untrackedPaths,
  });
}
