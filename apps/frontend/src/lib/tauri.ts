import { Channel, invoke } from '@tauri-apps/api/core';
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

export interface PtyExitEvent {
  id: PtyId;
  code: number | null;
}

/**
 * Spawn a PTY and stream its output to `onData`.
 *
 * Output flows over a per-spawn `Channel` carrying raw bytes — point-to-point
 * (not broadcast to every window) and without serializing each byte as a JSON
 * number. The channel callback is registered synchronously here, before the
 * `pty_spawn` command runs, so no early output can be dropped.
 */
export async function ptySpawn(
  opts: PtySpawnOptions,
  onData: (chunk: Uint8Array) => void,
): Promise<PtyId> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => {
    // Raw-byte channel messages arrive as an ArrayBuffer regardless of size
    // (large chunks via the fetch path, small ones via an inline buffer).
    onData(new Uint8Array(message));
  };
  return invoke<PtyId>('pty_spawn', { opts, onData: channel });
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
export type AiCliId = 'claude-cli' | 'codex-cli' | 'opencode-cli' | 'kimi-code-cli';

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

export async function onPtyExit(
  id: PtyId,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>(`pty://exit/${id}`, (event) => {
    handler(event.payload.code);
  });
}

// ----- Filesystem (file tree panel) --------------------------------------

// ─── Per-project .arc/ config ──────────────────────────────────────────────

/** Mirrors `arc_project_config::ProjectConfig`. Every field is optional or
 *  has a sensible default so an empty `.arc/config.toml` still parses. */
export interface ProjectConfig {
  schema: number;
  workspace?: { name?: string };
  env: Record<string, string>;
  agents: Array<{ id: string; label: string; prompt: string; model?: string }>;
  mcp_servers: Array<{
    id: string;
    command?: string[];
    url?: string;
    env: Record<string, string>;
    headers: Record<string, string>;
  }>;
  terminal?: { default_shell?: string };
  theme?: { id?: string };
}

/** Load `<workspaceRoot>/.arc/config.toml`. Resolves to `null` when the file
 *  is absent — that's not an error, just the common case. Throws when the
 *  file exists but is malformed or declares an unsupported schema. */
export async function projectConfigLoad(workspaceRoot: string): Promise<ProjectConfig | null> {
  if (!isTauri) return null;
  return await invoke<ProjectConfig | null>('project_config_load', { workspaceRoot });
}

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

/** Native multi-file picker. Returns an empty array when the user cancels. */
export async function fsPickFiles(starting?: string | null): Promise<string[]> {
  return invoke<string[]>('fs_pick_files', { starting: starting ?? null });
}

export interface FileItem {
  path: string;
  name: string;
  /** Path relative to the listing root, forward slashes. */
  rel: string;
}

/** Walks `root` and returns up to `limit` files whose name or relative path
 *  contains `query` (case-insensitive). Empty query returns shallow files. */
export async function fsListFiles(
  root: string,
  query: string,
  limit: number,
): Promise<FileItem[]> {
  return invoke<FileItem[]>('fs_list_files', { root, query, limit });
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

// ----- Network probes ---------------------------------------------------

// Lightweight 127.0.0.1:<port> TCP connect with a 200 ms timeout. Used by the
// Preview pane's port picker to mark which dev-server ports are live.
export async function networkProbePort(port: number): Promise<boolean> {
  return invoke<boolean>('network_probe_port', { port });
}

// Open a URL in the user's default OS handler (system browser for http/https).
// Inside a Tauri webview `window.open` does NOT reliably hop to the system
// browser, so anything that needs to escape the embedded webview routes here.
export async function shellOpenExternal(url: string): Promise<void> {
  await invoke('shell_open_external', { url });
}

// ----- HTTP client (API Client tab) -------------------------------------

export interface HttpHeaderKV {
  name: string;
  value: string;
}

export type HttpBodyDto =
  | { kind: 'none' }
  | { kind: 'raw'; text: string; content_type: string }
  | { kind: 'formurlencoded'; entries: HttpHeaderKV[] }
  | { kind: 'multipart'; entries: HttpHeaderKV[] };

export interface HttpRequestDto {
  method: string;
  url: string;
  headers: HttpHeaderKV[];
  body: HttpBodyDto;
  timeout_ms?: number;
}

export interface HttpResponseDto {
  status: number;
  status_text: string;
  headers: HttpHeaderKV[];
  /** UTF-8 text if the body decoded cleanly, otherwise null. */
  body_text: string | null;
  /** Base64-encoded raw bytes. Always present. */
  body_base64: string;
  size_bytes: number;
  time_ms: number;
  truncated: boolean;
  final_url: string;
}

/**
 * Execute an HTTP request from Rust via reqwest. Bypasses browser CORS, so
 * the API Client can hit arbitrary endpoints. 10 MiB response cap; bigger
 * responses get `truncated: true`.
 */
export async function httpRequest(req: HttpRequestDto): Promise<HttpResponseDto> {
  return invoke<HttpResponseDto>('http_request', { req });
}

// ----- API Client persistence -------------------------------------------

export interface ApiCollection {
  id: string;
  session_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: number;
}

export interface ApiSavedRequest {
  id: string;
  session_id: string;
  collection_id: string | null;
  name: string;
  method: string;
  url: string;
  params_json: string | null;
  headers_json: string | null;
  body_json: string | null;
  auth_json: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

export interface ApiSavedRequestInput {
  id?: string | null;
  collection_id?: string | null;
  name: string;
  method: string;
  url: string;
  params_json?: string | null;
  headers_json?: string | null;
  body_json?: string | null;
  auth_json?: string | null;
  position?: number;
}

export interface ApiHistoryEntry {
  id: string;
  session_id: string;
  method: string;
  url: string;
  request_snapshot_json: string;
  status: number | null;
  time_ms: number | null;
  size_bytes: number | null;
  response_excerpt: string | null;
  error: string | null;
  executed_at: number;
}

export interface ApiHistoryInput {
  method: string;
  url: string;
  request_snapshot_json: string;
  status?: number | null;
  time_ms?: number | null;
  size_bytes?: number | null;
  response_excerpt?: string | null;
  error?: string | null;
}

export interface ApiEnvironment {
  id: string;
  session_id: string;
  name: string;
  vars_json: string;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export async function apiclientListCollections(sessionId: string): Promise<ApiCollection[]> {
  return invoke<ApiCollection[]>('apiclient_list_collections', { sessionId });
}

export async function apiclientUpsertCollection(
  sessionId: string,
  args: { id?: string | null; parentId?: string | null; name: string; position: number },
): Promise<ApiCollection> {
  return invoke<ApiCollection>('apiclient_upsert_collection', {
    sessionId,
    id: args.id ?? null,
    parentId: args.parentId ?? null,
    name: args.name,
    position: args.position,
  });
}

export async function apiclientDeleteCollection(id: string): Promise<void> {
  await invoke('apiclient_delete_collection', { id });
}

export async function apiclientListRequests(sessionId: string): Promise<ApiSavedRequest[]> {
  return invoke<ApiSavedRequest[]>('apiclient_list_requests', { sessionId });
}

export async function apiclientUpsertRequest(
  sessionId: string,
  input: ApiSavedRequestInput,
): Promise<ApiSavedRequest> {
  return invoke<ApiSavedRequest>('apiclient_upsert_request', { sessionId, input });
}

export async function apiclientDeleteRequest(id: string): Promise<void> {
  await invoke('apiclient_delete_request', { id });
}

export async function apiclientAppendHistory(
  sessionId: string,
  input: ApiHistoryInput,
): Promise<ApiHistoryEntry> {
  return invoke<ApiHistoryEntry>('apiclient_append_history', { sessionId, input });
}

export async function apiclientHistory(
  sessionId: string,
  limit?: number,
): Promise<ApiHistoryEntry[]> {
  return invoke<ApiHistoryEntry[]>('apiclient_history', {
    sessionId,
    limit: limit ?? 100,
  });
}

export async function apiclientClearHistory(sessionId: string): Promise<void> {
  await invoke('apiclient_clear_history', { sessionId });
}

export async function apiclientEnvsList(sessionId: string): Promise<ApiEnvironment[]> {
  return invoke<ApiEnvironment[]>('apiclient_envs_list', { sessionId });
}

export async function apiclientEnvsUpsert(
  sessionId: string,
  args: { id?: string | null; name: string; varsJson: string },
): Promise<ApiEnvironment> {
  return invoke<ApiEnvironment>('apiclient_envs_upsert', {
    sessionId,
    id: args.id ?? null,
    name: args.name,
    varsJson: args.varsJson,
  });
}

export async function apiclientEnvsDelete(id: string): Promise<void> {
  await invoke('apiclient_envs_delete', { id });
}

export async function apiclientEnvsSetActive(
  sessionId: string,
  id: string | null,
): Promise<void> {
  await invoke('apiclient_envs_set_active', { sessionId, id });
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
  /** Cumulative prompt-token count, present on the chunk(s) where the
   *  provider reports usage (OpenAI's trailing usage chunk, Anthropic's
   *  message_start). Absent for providers without usage (Ollama, local CLI). */
  input_tokens?: number;
  /** Cumulative completion-token count — OpenAI's usage chunk, or Anthropic's
   *  latest message_delta. */
  output_tokens?: number;
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

export type TabKind = 'terminal' | 'editor' | 'preview' | 'apiclient' | 'ssh' | 'diff';

export interface TabInput {
  id: string;
  title: string;
  kind: TabKind;
  file_path?: string | null;
  preview_url?: string | null;
  /** Opaque JSON blob owned by the frontend for API Client tabs — holds
   *  open sub-tabs, drafts, left-rail collapsed flag, etc. */
  apiclient_state_json?: string | null;
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
  /** Serialized pane-layout tree (JSON). Null when the session predates the
   *  layout feature — hydration synthesizes a single-leaf layout in that case. */
  pane_layout: string | null;
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
  paneLayout: string | null,
): Promise<void> {
  await invoke('session_save_tabs', { sessionId, tabs, activeTabId, paneLayout });
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
  /** Active theme id (e.g. 'catppuccin-mocha'). When set + registered,
   *  overrides the dark/light pair from `appearance`. `null` (or missing)
   *  means "follow appearance" — the legacy behavior. */
  themeId?: string | null;
  /** Mono font id from `FONT_OPTIONS`. */
  fontId?: string;
  /** Terminal / editor font size in px. */
  fontSize?: number;
  /** Start ARC on OS login. Wired to `tauri-plugin-autostart`. */
  launchAtLogin?: boolean;
  /** Re-open the main window at its last position/size (handled by
   *  `tauri-plugin-window-state`). The Rust side reads this on launch. */
  restoreWindowState?: boolean;
  /** Use the WebGL renderer for newly-opened terminal tabs. Falls back to
   *  the default canvas/DOM renderer on context-loss or when WebGL is
   *  unsupported. */
  terminalWebgl?: boolean;
  /** Enable Vim keybindings in the CodeMirror editor. */
  editorVimMode?: boolean;
  /** Notify on long-running commands when unfocused (Tier 1.5). */
  notifyLongCommands?: boolean;
  /** Seconds a command must exceed before notifying. */
  notifyThresholdSecs?: number;
  /** Play the OS notification sound. */
  notifySound?: boolean;
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

export interface GitDiffStat {
  files_changed: number;
  insertions: number;
  deletions: number;
}

/** Aggregate +/- line counts vs HEAD (staged + unstaged + untracked).
 *  Returns null when `path` isn't inside a git repo. */
export async function gitDiffStat(path: string): Promise<GitDiffStat | null> {
  return invoke<GitDiffStat | null>('git_diff_stat', { path });
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

/** Absolute path to the repo root containing `path` (`git rev-parse
 *  --show-toplevel`). `null` when `path` isn't inside a repo. Used to map the
 *  repo-relative paths from `gitChanges` to absolute file-tree paths. */
export async function gitRoot(path: string): Promise<string | null> {
  return invoke<string | null>('git_root', { path });
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
  /** Lines added across all files in this commit. */
  additions: number;
  /** Lines removed across all files in this commit. */
  deletions: number;
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

/** Apply a unified-diff patch to the repo.
 *  `cached` → apply to the index; `reverse` → apply in reverse. */
export async function gitApply(
  path: string,
  patch: string,
  cached: boolean,
  reverse: boolean,
): Promise<void> {
  return invoke<void>('git_apply', { path, patch, cached, reverse });
}

// ── Remotes ──────────────────────────────────────────────────────────────────

export interface GitRemoteInfo {
  name: string;
  fetch_url: string;
  push_url: string;
}

export async function gitRemotes(path: string): Promise<GitRemoteInfo[]> {
  return invoke<GitRemoteInfo[]>('git_remotes', { path });
}

export interface GitRemoteOpResult {
  message: string;
}

export async function gitFetch(
  path: string,
  remote?: string | null,
): Promise<GitRemoteOpResult> {
  return invoke<GitRemoteOpResult>('git_fetch', { path, remote: remote ?? null });
}

export async function gitPull(path: string, rebase: boolean): Promise<GitRemoteOpResult> {
  return invoke<GitRemoteOpResult>('git_pull', { path, rebase });
}

export async function gitPushRemote(
  path: string,
  remote?: string | null,
  branch?: string | null,
  force?: boolean,
  setUpstream?: boolean,
): Promise<GitRemoteOpResult> {
  return invoke<GitRemoteOpResult>('git_push', {
    path,
    remote: remote ?? null,
    branch: branch ?? null,
    force: force ?? false,
    setUpstream: setUpstream ?? false,
  });
}

// ── Stash ─────────────────────────────────────────────────────────────────────

export interface GitStashEntry {
  index: number;
  oid: string;
  message: string;
}

export async function gitStashList(path: string): Promise<GitStashEntry[]> {
  return invoke<GitStashEntry[]>('git_stash_list', { path });
}

export async function gitStashPush(path: string, message?: string | null): Promise<void> {
  return invoke<void>('git_stash_push', { path, message: message ?? null });
}

export async function gitStashPop(path: string, index?: number | null): Promise<void> {
  return invoke<void>('git_stash_pop', { path, index: index ?? null });
}

export async function gitStashDrop(path: string, index: number): Promise<void> {
  return invoke<void>('git_stash_drop', { path, index });
}

// ── Branch management ─────────────────────────────────────────────────────────

export async function gitBranchCreate(
  path: string,
  name: string,
  checkout: boolean,
): Promise<void> {
  return invoke<void>('git_branch_create', { path, name, checkout });
}

export async function gitBranchRename(
  path: string,
  oldName: string,
  newName: string,
): Promise<void> {
  return invoke<void>('git_branch_rename', { path, oldName, newName });
}

export async function gitBranchDelete(
  path: string,
  name: string,
  force: boolean,
): Promise<void> {
  return invoke<void>('git_branch_delete', { path, name, force });
}

export interface GitMergeResult {
  message: string;
  conflicts: boolean;
}

export async function gitMerge(path: string, branch: string): Promise<GitMergeResult> {
  return invoke<GitMergeResult>('git_merge', { path, branch });
}

// ── Commit operations ─────────────────────────────────────────────────────────

export async function gitCommitAmend(path: string, message: string): Promise<GitCommitResult> {
  return invoke<GitCommitResult>('git_commit_amend', { path, message });
}

export async function gitRevert(path: string, oid: string): Promise<GitCommitResult> {
  return invoke<GitCommitResult>('git_revert', { path, oid });
}

export async function gitCherryPick(path: string, oid: string): Promise<void> {
  return invoke<void>('git_cherry_pick', { path, oid });
}

export type GitResetMode = 'soft' | 'mixed' | 'hard';

export async function gitReset(
  path: string,
  oid: string,
  mode: GitResetMode,
): Promise<void> {
  return invoke<void>('git_reset', { path, oid, mode });
}

export async function gitLastMessage(path: string): Promise<string> {
  return invoke<string>('git_last_message', { path });
}

// ── Conflict resolution ───────────────────────────────────────────────────────

export async function gitCheckoutOurs(path: string, paths: string[]): Promise<void> {
  return invoke<void>('git_checkout_ours', { path, paths });
}

export async function gitCheckoutTheirs(path: string, paths: string[]): Promise<void> {
  return invoke<void>('git_checkout_theirs', { path, paths });
}

/** Mirrors `arc_git::WorktreeEntry`. */
export interface GitWorktreeEntry {
  path: string;
  head_short: string | null;
  branch: string | null;
  is_main: boolean;
  locked: boolean;
  prunable: boolean;
}

export async function gitWorktreeList(path: string): Promise<GitWorktreeEntry[]> {
  return invoke<GitWorktreeEntry[]>('git_worktree_list', { path });
}

/** Add a new worktree.
 *  - `createBranch=true` + `branch` → create that NEW branch at `startPoint`
 *    (defaults to HEAD).
 *  - `createBranch=false` + `branch` → check out an existing branch/ref.
 *  - `createBranch=false` + `branch=null` → detached HEAD at `startPoint`. */
export async function gitWorktreeAdd(
  path: string,
  newPath: string,
  branch: string | null,
  createBranch: boolean,
  startPoint?: string | null,
): Promise<void> {
  await invoke('git_worktree_add', {
    path,
    newPath,
    branch,
    createBranch,
    startPoint: startPoint ?? null,
  });
}

export async function gitWorktreeRemove(
  path: string,
  targetPath: string,
  force: boolean,
): Promise<void> {
  await invoke('git_worktree_remove', { path, targetPath, force });
}

/** Mirrors `arc_git::RebaseAction`. */
export type GitRebaseAction = 'pick' | 'drop' | 'squash' | 'fixup';

export interface GitRebaseTodoEntry {
  /** Full commit oid — order in the array = new history order (oldest first). */
  oid: string;
  action: GitRebaseAction;
}

/** Run `git rebase -i <base>` with a pre-built TODO. Never opens an editor;
 *  squash/fixup combined-message dialogs auto-accept their defaults. Throws
 *  on conflict — the repo is left mid-rebase and the caller must drive the
 *  user to either `gitRebaseContinue` or `gitRebaseAbort`. */
export async function gitRebaseInteractive(
  path: string,
  base: string,
  entries: GitRebaseTodoEntry[],
): Promise<void> {
  await invoke('git_rebase_interactive', { path, base, entries });
}

export async function gitRebaseAbort(path: string): Promise<void> {
  await invoke('git_rebase_abort', { path });
}

export async function gitRebaseContinue(path: string): Promise<void> {
  await invoke('git_rebase_continue', { path });
}

// ─── Git host (GitHub PRs) ────────────────────────────────────────────────

export interface GitHostRepoSlug {
  owner: string;
  name: string;
}

export type GitHostPrState = 'open' | 'closed' | 'merged';
export type GitHostPrListFilter = 'open' | 'closed' | 'all';

export interface GitHostPrSummary {
  number: number;
  title: string;
  state: GitHostPrState;
  author: string;
  author_avatar: string;
  head: string;
  base: string;
  html_url: string;
  draft: boolean;
  updated_at: string;
}

export interface GitHostPrCommit {
  oid: string;
  short: string;
  message: string;
  author: string;
}

export interface GitHostPrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface GitHostPrDetail {
  number: number;
  title: string;
  body: string;
  state: GitHostPrState;
  author: string;
  author_avatar: string;
  head: string;
  base: string;
  html_url: string;
  draft: boolean;
  commits: GitHostPrCommit[];
  files: GitHostPrFile[];
  mergeable: boolean | null;
}

export interface GitHostCreatePrRequest {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

/** Detect `owner/name` from `origin` remote. `null` when not a GitHub repo. */
export async function gitHostDetect(path: string): Promise<GitHostRepoSlug | null> {
  if (!isTauri) return null;
  return invoke<GitHostRepoSlug | null>('git_host_detect', { path });
}

export async function gitHostTokenSet(provider: string, token: string): Promise<void> {
  await invoke('git_host_token_set', { provider, token });
}

export async function gitHostTokenGet(provider: string): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>('git_host_token_get', { provider });
}

export async function gitHostTokenDelete(provider: string): Promise<void> {
  await invoke('git_host_token_delete', { provider });
}

export async function gitHostPrList(
  path: string,
  filter: GitHostPrListFilter,
): Promise<GitHostPrSummary[]> {
  return invoke<GitHostPrSummary[]>('git_host_pr_list', { path, filter });
}

export async function gitHostPrGet(path: string, number: number): Promise<GitHostPrDetail> {
  return invoke<GitHostPrDetail>('git_host_pr_get', { path, number });
}

export async function gitHostPrCreate(
  path: string,
  req: GitHostCreatePrRequest,
): Promise<GitHostPrSummary> {
  return invoke<GitHostPrSummary>('git_host_pr_create', { path, req });
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

/** Open (or focus) the Agent-editor window pointed at `agentId`. If the
 *  window already exists it's refocused and a navigation ping is emitted
 *  so the page can swap to the new id without a full reload. */
export async function agentEditorWindowOpen(agentId: string): Promise<void> {
  await invoke('agent_editor_window_open', { agentId });
}

/** Subscribe to agent-editor navigation pings (fires when a second `Edit`
 *  click from the Settings grid hits a window that's already open). */
export async function onAgentEditorNavigate(
  handler: (agentId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>('agent-editor://navigate', (e) => handler(e.payload));
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

// ----- SSH ----------------------------------------------------------------

export type SshId = string;

export interface SshHost {
  id: string;
  workspace_id: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  identity_id: string | null;
  keepalive_secs: number;
  startup_cmd: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface SshHostInput {
  id?: string;
  workspace_id?: string | null;
  name: string;
  host: string;
  port?: number;
  username: string;
  identity_id?: string | null;
  keepalive_secs?: number;
  startup_cmd?: string | null;
}

export interface SshKey {
  id: string;
  name: string;
  path: string;
  kind: string;
  fingerprint: string;
  has_passphrase: boolean;
  created_at: number;
}

export interface SshKeyWithPublic extends SshKey {
  public_openssh: string;
}

/** One handshake-step or lifecycle event surfaced by the SSH driver. */
export interface SshLogEvent {
  at: number;
  level: string;
  msg: string;
}

export interface SshLogEventPayload {
  id: SshId;
  entry: SshLogEvent;
}


export interface SshExitEvent {
  id: SshId;
  code: number | null;
}

export interface SshSessionLogRow {
  id: number;
  host_id: string;
  session_uuid: string;
  at: number;
  level: string;
  msg: string;
}

export interface SshConnectInvoke {
  hostId: string;
  cols: number;
  rows: number;
}

export interface SshGenerateKeyOpts {
  name: string;
  algorithm: 'ed25519' | 'rsa';
  comment?: string;
  passphrase?: string;
}

export interface SshImportKeyOpts {
  name: string;
  path: string;
  passphrase?: string;
}

/** Open an SSH session against a previously-saved host. Shell output streams
 *  to `onData` over a per-connect raw `Channel` (registered before the command
 *  runs, so no early output is dropped); `ssh://log/<id>` and `ssh://exit/<id>`
 *  stay on the event bus. Returns the session id. */
export async function sshConnect(
  payload: SshConnectInvoke,
  onData: (chunk: Uint8Array) => void,
): Promise<SshId> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (message) => {
    onData(new Uint8Array(message));
  };
  return invoke<SshId>('ssh_connect', { payload, onData: channel });
}

export async function sshWrite(id: SshId, data: string): Promise<void> {
  await invoke('ssh_write', { id, data });
}

export async function sshResize(id: SshId, cols: number, rows: number): Promise<void> {
  await invoke('ssh_resize', { id, cols, rows });
}

export async function sshClose(id: SshId): Promise<void> {
  await invoke('ssh_close', { id });
}

export async function onSshLog(
  id: SshId,
  handler: (entry: SshLogEvent) => void,
): Promise<UnlistenFn> {
  return listen<SshLogEventPayload>(`ssh://log/${id}`, (event) => {
    handler(event.payload.entry);
  });
}

export async function onSshExit(
  id: SshId,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<SshExitEvent>(`ssh://exit/${id}`, (event) => {
    handler(event.payload.code);
  });
}

export async function sshHostList(workspaceId?: string | null): Promise<SshHost[]> {
  return invoke<SshHost[]>('ssh_host_list', { workspaceId: workspaceId ?? null });
}

export async function sshHostUpsert(input: SshHostInput): Promise<SshHost> {
  return invoke<SshHost>('ssh_host_upsert', { input });
}

export async function sshHostDelete(id: string): Promise<void> {
  await invoke('ssh_host_delete', { id });
}

export async function sshKeyList(): Promise<SshKey[]> {
  return invoke<SshKey[]>('ssh_key_list');
}

export async function sshKeyGenerate(opts: SshGenerateKeyOpts): Promise<SshKeyWithPublic> {
  return invoke<SshKeyWithPublic>('ssh_key_generate', { opts });
}

export async function sshKeyImport(opts: SshImportKeyOpts): Promise<SshKey> {
  return invoke<SshKey>('ssh_key_import', { opts });
}

export async function sshKeyDelete(id: string, deleteFiles = false): Promise<void> {
  await invoke('ssh_key_delete', { id, deleteFiles });
}

export async function sshSessionLogs(
  hostId: string,
  limit?: number,
): Promise<SshSessionLogRow[]> {
  return invoke<SshSessionLogRow[]>('ssh_session_logs', {
    hostId,
    limit: limit ?? null,
  });
}
