import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  isRemotePath,
  makeRemotePath,
  parseRemotePath,
  posixJoin,
  posixParent,
  remoteParent,
} from './remote';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type PtyId = string;

export interface PtySpawnOptions {
  shell?: string | null;
  cwd?: string | null;
  cols: number;
  rows: number;
  /** Extra env vars from the project's `.arc/config.toml`, layered on the
   *  inherited process env. */
  env?: Record<string, string> | null;
  /** Extra arguments passed to the spawned program — used by AI CLI
   *  launchers that run a subcommand (e.g. `wingman pilot run <goal>`). */
  args?: string[] | null;
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

/**
 * Every AI coding-agent CLI the Rust detector probes for, id → display label,
 * in menu order. Must stay in step with `discover_ai_clis` in rust/pty.
 *
 * Single source of truth on this side: the launcher actions in
 * `state/shortcuts.ts` (and therefore the shortcuts dialog and the command
 * palette) are derived from it, so adding a CLI is one row here and one row
 * in Rust. The tab-bar menu, new-tab popover and empty-workspace list already
 * render whatever `ptyListAiClis` returns and need no change at all.
 */
export const AI_CLIS = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'OpenAI Codex',
  'opencode-cli': 'OpenCode',
  'kimi-code-cli': 'Kimi Code',
  'gemini-cli': 'Gemini CLI',
  'qwen-code-cli': 'Qwen Code',
  'cursor-agent-cli': 'Cursor Agent',
  'copilot-cli': 'GitHub Copilot',
  'amp-cli': 'Amp',
  'aider-cli': 'Aider',
  'crush-cli': 'Crush',
  'droid-cli': 'Factory Droid',
  'wingman-cli': 'Wingman',
} as const;

/** Stable id assigned to each AI CLI by the Rust detector. */
export type AiCliId = keyof typeof AI_CLIS;

/** One installed AI coding-agent CLI discovered on PATH. */
export interface AiCliInfo {
  id: AiCliId;
  label: string;
  path: string;
}

/**
 * Enumerate AI coding-agent CLIs installed on the user's PATH — whichever of
 * {@link AI_CLIS} the Rust detector actually found. Used by the launcher UI in
 * TabBar / new-tab popover to spawn the CLI in a terminal tab.
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

// ─── local / remote routing ──────────────────────────────────────────────
//
// A remote workspace addresses its files as `ssh://<hostId>/path` (see
// lib/remote.ts). Rather than teach the file tree, the editor, and every
// other caller about a second path type, the branch lives here — in the
// functions they already call. A remote path goes to SFTP, anything else to
// the local filesystem, and callers stay exactly as they were.
//
// Remote listings are re-stamped with `ssh://` URIs on the way out, so what
// the tree hands back to these functions round-trips.

export async function fsParent(path: string): Promise<string | null> {
  if (isRemotePath(path)) return remoteParent(path);
  return invoke<string | null>('fs_parent', { path });
}

export async function fsReadDir(path: string): Promise<FsEntry[]> {
  const remote = parseRemotePath(path);
  if (remote) {
    const entries = await sshFsReadDir(remote.hostId, remote.path);
    return entries.map((e) => ({
      name: e.name,
      path: makeRemotePath(remote.hostId, e.path),
      kind: e.is_dir ? 'dir' : ('file' as FsKind),
      // Dotfile convention — SFTP reports no hidden attribute of its own.
      hidden: e.name.startsWith('.'),
    }));
  }
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
  ignoreDirs: string[],
): Promise<FileItem[]> {
  return invoke<FileItem[]>('fs_list_files', { root, query, limit, ignoreDirs });
}

export async function fsReadFile(path: string): Promise<string> {
  const remote = parseRemotePath(path);
  if (remote) return sshFsReadFile(remote.hostId, remote.path);
  return invoke<string>('fs_read_file', { path });
}

export async function fsWriteFile(path: string, content: string): Promise<void> {
  const remote = parseRemotePath(path);
  if (remote) return sshFsWriteFile(remote.hostId, remote.path, content);
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

export async function fsSearch(
  root: string,
  query: string,
  limit: number,
  ignoreDirs: string[],
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('fs_search', { root, query, limit, ignoreDirs });
}

// ─── find & replace ──────────────────────────────────────────────────────
//
// Separate from `fsSearch`, which is BM25-ranked and token-based: right for
// "show me relevant files", wrong for a replace, where missing one occurrence
// silently corrupts the refactor. These do an exact literal scan.

export interface ReplaceMatch {
  path: string;
  name: string;
  /** One-based. */
  line: number;
  snippet: string;
  /** Occurrences on this line. */
  count: number;
}

export interface ReplaceSummary {
  files_changed: number;
  replacements: number;
}

/** Preview: every literal match under `root`. */
export async function fsReplaceFind(
  root: string,
  needle: string,
  caseSensitive: boolean,
  limit: number,
  ignoreDirs: string[],
): Promise<ReplaceMatch[]> {
  return invoke<ReplaceMatch[]>('fs_replace_find', {
    root,
    needle,
    caseSensitive,
    limit,
    ignoreDirs,
  });
}

/** Apply: rewrite exactly the `files` the user kept from the preview. Paths
 *  outside `root` are rejected by the Rust side. */
export async function fsReplaceApply(
  root: string,
  files: string[],
  needle: string,
  replacement: string,
  caseSensitive: boolean,
): Promise<ReplaceSummary> {
  return invoke<ReplaceSummary>('fs_replace_apply', {
    root,
    files,
    needle,
    replacement,
    caseSensitive,
  });
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
  const remote = parseRemotePath(path);
  if (remote) {
    const target = posixJoin(posixParent(remote.path), newName);
    await sshFsRename(remote.hostId, remote.path, target);
    return makeRemotePath(remote.hostId, target);
  }
  return invoke<string>('fs_rename', { path, newName });
}

/** Delete a file or directory (recursive for directories, locally).
 *
 *  Remote deletes are NOT recursive: SFTP has no recursive remove, and
 *  walking a remote tree to delete it file-by-file — over a link that can
 *  drop mid-way, with no trash to recover from — is not something to do
 *  behind a single menu click. A non-empty remote directory reports that
 *  it is non-empty. */
export async function fsDelete(path: string, isDir = false): Promise<void> {
  const remote = parseRemotePath(path);
  if (remote) return sshFsRemove(remote.hostId, remote.path, isDir);
  await invoke('fs_delete', { path });
}

/** Reveal `path` in the OS file manager (Finder on macOS, Explorer on Windows, xdg-open on Linux). */
export async function fsReveal(path: string): Promise<void> {
  await invoke('fs_reveal', { path });
}

/** Create a directory (and any missing ancestors) at `path`. */
export async function fsCreateDir(path: string): Promise<void> {
  const remote = parseRemotePath(path);
  if (remote) return sshFsCreateDir(remote.hostId, remote.path);
  await invoke('fs_create_dir', { path });
}

// ----- Network probes ---------------------------------------------------

// Lightweight 127.0.0.1:<port> TCP connect with a 200 ms timeout. Used by the
// Preview pane's port picker to mark which dev-server ports are live.
export async function networkProbePort(port: number): Promise<boolean> {
  return invoke<boolean>('network_probe_port', { port });
}

// Enumerate the font families installed on this machine, sorted and
// de-duplicated. Powers the "System installed fonts" group in Settings →
// Font Family. Returns [] outside Tauri (the frontend-only dev shell).
export async function listSystemFonts(): Promise<string[]> {
  if (!isTauri) return [];
  return invoke<string[]>('fonts_list_system');
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

// ----- LSP client -------------------------------------------------------

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
/** LSP `Diagnostic` (subset). `severity`: 1 error, 2 warning, 3 info, 4 hint. */
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}
/** Payload of `textDocument/publishDiagnostics`. */
export interface LspPublishDiagnostics {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}
/** Server→client notification, tagged with its session id. */
export interface LspEvent {
  session_id: string;
  method: string;
  params: unknown;
}

/** Start (or restart) a language server under `id`. Returns the server's
 *  advertised capabilities. */
export async function lspStart(
  id: string,
  command: string,
  args: string[],
  rootUri?: string | null,
): Promise<unknown> {
  return invoke('lsp_start', { id, command, args, rootUri: rootUri ?? null });
}

export async function lspDidOpen(
  id: string,
  uri: string,
  languageId: string,
  version: number,
  text: string,
): Promise<void> {
  await invoke('lsp_did_open', { id, uri, languageId, version, text });
}

export async function lspDidChange(
  id: string,
  uri: string,
  version: number,
  text: string,
): Promise<void> {
  await invoke('lsp_did_change', { id, uri, version, text });
}

export async function lspDidClose(id: string, uri: string): Promise<void> {
  await invoke('lsp_did_close', { id, uri });
}

export async function lspHover(
  id: string,
  uri: string,
  line: number,
  character: number,
): Promise<unknown> {
  return invoke('lsp_hover', { id, uri, line, character });
}

export async function lspCompletion(
  id: string,
  uri: string,
  line: number,
  character: number,
): Promise<unknown> {
  return invoke('lsp_completion', { id, uri, line, character });
}

export async function lspDefinition(
  id: string,
  uri: string,
  line: number,
  character: number,
): Promise<unknown> {
  return invoke('lsp_definition', { id, uri, line, character });
}

export async function lspReferences(
  id: string,
  uri: string,
  line: number,
  character: number,
): Promise<unknown> {
  return invoke('lsp_references', { id, uri, line, character });
}

export async function lspRename(
  id: string,
  uri: string,
  line: number,
  character: number,
  newName: string,
): Promise<unknown> {
  return invoke('lsp_rename', { id, uri, line, character, newName });
}

export async function lspFormatting(
  id: string,
  uri: string,
  tabSize: number,
  insertSpaces: boolean,
): Promise<unknown> {
  return invoke('lsp_formatting', { id, uri, tabSize, insertSpaces });
}

export async function lspStop(id: string): Promise<void> {
  await invoke('lsp_stop', { id });
}

export async function lspIsRunning(id: string): Promise<boolean> {
  return invoke<boolean>('lsp_is_running', { id });
}

/** Subscribe to a language server's notifications (diagnostics, logs, …).
 *  Returns an unlisten function. */
export async function onLspEvent(
  id: string,
  handler: (ev: LspEvent) => void,
): Promise<UnlistenFn> {
  return listen<LspEvent>(`lsp://event/${id}`, (e) => handler(e.payload));
}

// ----- Session / persistence --------------------------------------------
//
// Nested struct fields (Tab, Workspace, ChatMessage) use snake_case to match
// the Rust DTOs serialized via serde defaults. Outer invoke arguments use
// camelCase — Tauri converts them to snake_case Rust params automatically.

export type TabKind =
  | 'terminal'
  | 'editor'
  | 'preview'
  | 'apiclient'
  | 'ssh'
  | 'diff'
  | 'db'
  | 'merge'
  | 'wingman-board'
  | 'wingman-review';

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

// App settings (non-secret; persisted to SQLite)

/** Shape stored in the `app_settings` table under key `"user_settings"`. */
export interface PersistedSettings {
  defaultShell: string | null;
  /** Named terminal configurations. Validated on load by
   *  `coerceTerminalProfiles` — this row is user-editable on disk. */
  terminalProfiles?: unknown;
  /** Id of the profile new terminals use. `null`/missing → `defaultShell`. */
  defaultProfileId?: string | null;
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
  /** Enable Vim keybindings in the CodeMirror editor. */
  editorVimMode?: boolean;
  /** Enable Language Server Protocol features (diagnostics, hover, completion,
   *  go-to-definition, references, rename, formatting) in the editor. Requires
   *  the relevant language servers on PATH. */
  editorLsp?: boolean;
  /** Run the language server's formatter before every save. Requires
   *  `editorLsp`. */
  editorFormatOnSave?: boolean;
  /** Address of a `wingman serve` daemon. Empty disables the integration.
   *  The token is not persisted here — it lives in the OS credential vault. */
  wingmanUrl?: string;
  /** Claude Code panel preferences. The CLI holds the credentials, so nothing
   *  secret is stored here. */
  claudePermissionMode?: string;
  claudeModel?: string;
  claudeMaxBudgetUsd?: number;
  /** Notify on long-running commands when unfocused (Tier 1.5). */
  notifyLongCommands?: boolean;
  /** Seconds a command must exceed before notifying. */
  notifyThresholdSecs?: number;
  /** Play the OS notification sound. */
  notifySound?: boolean;
  /** Check for a new release on launch (Settings → About). */
  autoUpdateCheck?: boolean;
  /** Model id for the terminal's ⌘K command bar. The API key lives in the
   *  OS credential vault, not here. */
  aiModel?: string;
  /** Folder names excluded from file search. Fully user-editable; seeded with
   *  sensible defaults (node_modules, .venv, target, …). */
  searchIgnoreDirs?: string[];
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

// ─── terminal scrollback ─────────────────────────────────────────────────
// Serialized xterm buffers keyed by tab id, so a terminal restored after a
// relaunch comes back showing its previous output instead of an empty pane.

export async function sessionScrollbackSave(tabId: string, data: string): Promise<void> {
  await invoke('session_scrollback_save', { tabId, data });
}

export async function sessionScrollbackLoad(tabId: string): Promise<string | null> {
  return invoke<string | null>('session_scrollback_load', { tabId });
}

export async function sessionScrollbackDelete(tabId: string): Promise<void> {
  await invoke('session_scrollback_delete', { tabId });
}

/** Drop stored scrollback for every tab not in `keepTabIds`. */
export async function sessionScrollbackPrune(keepTabIds: string[]): Promise<void> {
  await invoke('session_scrollback_prune', { keepTabIds });
}

/** The running app's version, straight from tauri.conf.json. `null` in the
 *  browser-only build, where there is no bundle to ask. */
export async function getAppVersion(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch (err) {
    console.warn('[tauri] version lookup failed:', err);
    return null;
  }
}

// ─── diagnostics ─────────────────────────────────────────────────────────
// Crash log + build facts, for the "Copy diagnostics" button in Settings →
// About. A panic inside a Tauri command never reaches the UI, so the Rust
// side logs it to <data_dir>/arc/crash.log and these read it back.

export interface DiagnosticsSummary {
  /** Epoch-ms of the most recent panic, or null when the log is empty. */
  last_crash_at: number | null;
  crash_count: number;
  log_path: string | null;
}

export async function diagnosticsSummary(): Promise<DiagnosticsSummary | null> {
  if (!isTauri) return null;
  try {
    return await invoke<DiagnosticsSummary>('diagnostics_summary');
  } catch {
    return null;
  }
}

/** The paste-ready report: version, platform, data dir, crash-log tail. */
export async function diagnosticsCollect(): Promise<string> {
  if (!isTauri) return 'ARC (browser build — no diagnostics available)';
  return invoke<string>('diagnostics_collect');
}

export async function diagnosticsClear(): Promise<void> {
  if (!isTauri) return;
  await invoke('diagnostics_clear');
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
  output_excerpt: string | null;
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

// ─── Secrets vault (OS keychain) ─────────────────────────────────────────
// Values are stored in the OS credential vault; only names are enumerable.

/** Names of stored secrets (never the values). */
export async function secretList(): Promise<string[]> {
  if (!isTauri) return [];
  return invoke<string[]>('secret_list');
}

/** Store or overwrite a secret value in the OS keychain. */
export async function secretSet(name: string, value: string): Promise<void> {
  await invoke('secret_set', { name, value });
}

/** Read a secret's value, or null if it isn't set. */
export async function secretGet(name: string): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>('secret_get', { name });
}

/** Remove a secret from the vault. */
export async function secretDelete(name: string): Promise<void> {
  await invoke('secret_delete', { name });
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

// ─── Wingman ───────────────────────────────────────────────────────────────
//
// ARC drives a `wingman serve` daemon over HTTP/SSE (see rust/wingman). The
// whole surface is optional: with no daemon configured or reachable,
// `wingmanHealth` rejects and the UI hides every Wingman affordance. Nothing
// here should be awaited on a path that blocks ARC's own startup.

export interface WingmanHealth {
  ok: boolean;
  version: string;
  uptime_secs: number;
  /** When true, every route but health needs the bearer token. */
  auth_required: boolean;
}

export interface WingmanProject {
  id: string;
  root: string;
  branch: string | null;
  indexd_running: boolean;
  index_age_secs: number | null;
}

/** One planner task inside a pilot run. Projected live from the run's state —
 *  the board never stores these. */
export interface WingmanSubRow {
  task_id: string;
  title: string;
  status: string;
  role: string | null;
  agent_name: string | null;
  model: string | null;
  usd: number;
  attempts: number;
  writes: number;
  elapsed_secs: number | null;
  current_tool: string | null;
  outcome: string | null;
  /** Present once the task has a worktree — what the review queue opens. */
  worktree: string | null;
  session_id: string | null;
  deps: string[];
  blocked_by: string[];
}

export interface WingmanRollUp {
  status: string | null;
  total: number;
  done: number;
  failed: number;
  blocked: number;
  in_progress: number;
  not_started: number;
  review: number;
  usd: number;
  subrows: WingmanSubRow[];
}

/** Typed `{kind,text}` so a renderer can tell a progress badge from a label the
 *  user typed, without parsing formatted text. */
export interface WingmanBadge {
  kind: string;
  text: string;
}

export type WingmanColumn = 'backlog' | 'planned' | 'in_progress' | 'review' | 'done';

export interface WingmanCard {
  id: string;
  short: string | null;
  project: string;
  project_name: string | null;
  /** The board's registry can name repos this daemon doesn't serve; dispatching
   *  one is a 403, so the UI disables it rather than offering it. */
  project_missing: boolean;
  title: string | null;
  goal: string | null;
  notes: string | null;
  column: WingmanColumn;
  archived: boolean;
  labels: string[];
  badges: WingmanBadge[];
  rollup: WingmanRollUp | null;
  run_id: string | null;
  created_at: string | null;
}

export const WINGMAN_COLUMNS: { id: WingmanColumn; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'planned', label: 'Planned' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

export interface WingmanBoardData {
  cards: WingmanCard[];
}

export interface WingmanRunSummary {
  run_id: string;
  goal: string;
  status: string;
  done: number;
  total: number;
  /** Terminal runs never change again, so the UI can stop watching. */
  terminal: boolean;
}

export interface WingmanSessionInfo {
  session_id: string;
  first_prompt: string | null;
  model: string | null;
  provider: string | null;
  turns: number;
  /** Last-modified, epoch seconds. The daemon sorts newest-first already. */
  mtime?: number;
}

/** One block inside an assistant message. Tagged `type`, snake_case.
 *  `image` is accepted but not rendered — ARC's transcript is text-only. */
export type WingmanContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

/** One line of a stored transcript. Tagged `kind`, snake_case.
 *  Wingman writes more variants than ARC renders (compaction recaps, pruned
 *  tool results, system-prompt splices); unknown kinds are skipped. */
export type WingmanSessionRecord =
  | { kind: 'session_start'; ts: string; model: string; provider: string }
  | { kind: 'user'; ts: string; text: string }
  | { kind: 'assistant'; ts: string; blocks: WingmanContentBlock[] }
  | { kind: 'tool_result'; ts: string; id: string; output: string; is_error?: boolean }
  | { kind: 'recap'; ts: string; replaced: number; text: string }
  | { kind: string; [k: string]: unknown };

/** One frame off a stream.
 *
 *  `kind` is the agent event's own `type` (`text_delta`, `thinking_delta`,
 *  `tool_start`, `tool_result`, `usage`, `verification`, `turn_complete`,
 *  `stop`, `error`), or for the run firehose the event name (`run.started`,
 *  `run.finished`, …).
 *
 *  Two more terminators, confirmed against a live 0.2.0 daemon: the daemon
 *  sends `end` when the turn's child process exits, carrying `exit` and (only
 *  on failure) a `stderr` tail — a child that dies without a `stop` sends only
 *  this. ARC then adds its own `done`, or `error` when the request was refused
 *  outright and no stream ever opened. */
export interface WingmanStreamEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export type WingmanPilotAction = 'approve' | 'veto' | 'abort' | 'retry';

export async function wingmanConfigure(baseUrl: string, token?: string | null): Promise<void> {
  return invoke('wingman_configure', { baseUrl, token: token ?? null });
}

export async function wingmanHealth(): Promise<WingmanHealth> {
  return invoke('wingman_health');
}

export async function wingmanProjects(): Promise<WingmanProject[]> {
  return invoke('wingman_projects');
}

export async function wingmanBoard(
  project?: string | null,
  archived = false,
): Promise<WingmanBoardData> {
  return invoke('wingman_board', { project: project ?? null, archived });
}

export async function wingmanBoardAddCard(
  project: string,
  title: string,
  goal?: string | null,
): Promise<unknown> {
  return invoke('wingman_board_add_card', { project, title, goal: goal ?? null });
}

export async function wingmanBoardDispatch(card: string, again = false): Promise<unknown> {
  return invoke('wingman_board_dispatch', { card, again });
}

export async function wingmanBoardArchive(card: string, restore = false): Promise<unknown> {
  return invoke('wingman_board_archive', { card, restore });
}

export async function wingmanBoardDeleteCard(card: string): Promise<unknown> {
  return invoke('wingman_board_delete_card', { card });
}

export async function wingmanPilotRuns(project: string): Promise<WingmanRunSummary[]> {
  return invoke('wingman_pilot_runs', { project });
}

export async function wingmanPilotRun(project: string, run: string): Promise<unknown> {
  return invoke('wingman_pilot_run', { project, run });
}

export async function wingmanPilotControl(
  project: string,
  run: string,
  action: WingmanPilotAction,
  task?: string | null,
): Promise<unknown> {
  return invoke('wingman_pilot_control', { project, run, action, task: task ?? null });
}

export async function wingmanSessions(project: string): Promise<WingmanSessionInfo[]> {
  return invoke('wingman_sessions', { project });
}

export async function wingmanSessionTranscript(
  project: string,
  id: string,
): Promise<WingmanSessionRecord[]> {
  return invoke('wingman_session_transcript', { project, id });
}

export async function wingmanCreateSession(
  project: string,
  model?: string | null,
  mode?: string | null,
): Promise<string> {
  return invoke('wingman_create_session', { project, model: model ?? null, mode: mode ?? null });
}

export async function wingmanDeleteSession(project: string, id: string): Promise<unknown> {
  return invoke('wingman_delete_session', { project, id });
}

export async function wingmanDiff(project: string, file?: string | null): Promise<unknown> {
  return invoke('wingman_diff', { project, file: file ?? null });
}

export async function wingmanExplain(
  project: string,
  base?: string | null,
  staged = false,
): Promise<unknown> {
  return invoke('wingman_explain', { project, base: base ?? null, staged });
}

export async function wingmanCost(project: string, compare = false): Promise<unknown> {
  return invoke('wingman_cost', { project, compare });
}

/**
 * Start a turn. Resolves with the event topic to listen on; the turn runs in
 * the background and emits there.
 *
 * The stream always terminates with exactly one `done` or `error` event, even
 * when the daemon refuses the turn outright — a 409 (session already has a turn
 * in flight), 429 (queue full) or 403 (over the permission ceiling) produce no
 * stream at all. So a caller can always tear down on the first terminal event
 * rather than guessing.
 */
export async function wingmanTurnStart(opts: {
  project: string;
  session?: string | null;
  prompt: string;
  model?: string | null;
  mode?: string | null;
}): Promise<string> {
  return invoke('wingman_turn_start', {
    project: opts.project,
    session: opts.session ?? null,
    prompt: opts.prompt,
    model: opts.model ?? null,
    mode: opts.mode ?? null,
  });
}

/** Listen on a topic returned by `wingmanTurnStart`. */
export async function onWingmanTurn(
  topic: string,
  handler: (ev: WingmanStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<WingmanStreamEvent>(topic, (e) => handler(e.payload));
}

/** Open the daemon's cross-project run firehose. Emits on `wingman://events`. */
export async function wingmanEventsSubscribe(): Promise<void> {
  return invoke('wingman_events_subscribe');
}

export async function onWingmanEvents(
  handler: (ev: WingmanStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<WingmanStreamEvent>('wingman://events', (e) => handler(e.payload));
}

// ─── Claude Code ───────────────────────────────────────────────────────────
//
// Claude Code has no daemon: ARC spawns the user's own `claude` binary in
// headless `stream-json` mode, one child per turn (see rust/claude-code). So
// there is nothing to configure — `claudeAvailable` returning null just means
// the CLI isn't installed, and the UI hides every Claude surface.

/** The CLI's `--permission-mode` values.
 *
 *  ARC answers the CLI's permission requests over the control channel, so the
 *  modes that ask now actually prompt in the panel: `manual` asks before every
 *  tool, `acceptEdits` applies file edits silently but still asks for anything
 *  else (shell commands included), and `plan` never writes at all.
 *  `dontAsk` and `bypassPermissions` never ask. */
export type ClaudePermissionMode =
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'manual'
  | 'dontAsk'
  | 'bypassPermissions';

/** One event from a turn: `init`, `text_delta`, `thinking_delta`, `tool_start`,
 *  `tool_result`, `usage`, `result`, plus ARC's own terminal `done` / `error`.
 *  Payload shapes are the crate's — the store narrows what it renders. */
export interface ClaudeStreamEvent {
  kind: string;
  payload: Record<string, unknown>;
}

/** Absolute path to the Claude Code binary, or null when it isn't installed.
 *  This is the gate for the whole feature. */
export async function claudeAvailable(): Promise<string | null> {
  return invoke<string | null>('claude_available');
}

/** Start a turn. Returns the topic to listen on; `resume` continues a prior
 *  conversation by its session id. */
export async function claudeTurnStart(opts: {
  cwd: string;
  prompt: string;
  resume?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  maxBudgetUsd?: number | null;
}): Promise<string> {
  return invoke<string>('claude_turn_start', {
    cwd: opts.cwd,
    prompt: opts.prompt,
    resume: opts.resume ?? null,
    model: opts.model ?? null,
    permissionMode: opts.permissionMode ?? null,
    maxBudgetUsd: opts.maxBudgetUsd ?? null,
  });
}

/** Answer a `permission_request`. The turn is paused until this lands.
 *  `message` is shown to Claude on a denial so it can adapt rather than retry. */
export async function claudePermissionRespond(opts: {
  topic: string;
  requestId: string;
  allow: boolean;
  message?: string | null;
}): Promise<void> {
  return invoke('claude_permission_respond', {
    topic: opts.topic,
    requestId: opts.requestId,
    allow: opts.allow,
    message: opts.message ?? null,
  });
}

/** Kill a running turn. Unknown topics are a no-op. Also the escape hatch from
 *  a permission prompt the user would rather not answer either way. */
export async function claudeTurnCancel(topic: string): Promise<void> {
  return invoke('claude_turn_cancel', { topic });
}

/** Listen on a topic returned by `claudeTurnStart`. */
export async function onClaudeTurn(
  topic: string,
  handler: (ev: ClaudeStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<ClaudeStreamEvent>(topic, (e) => handler(e.payload));
}

// ─── remote filesystem (SFTP) ────────────────────────────────────────────
//
// The raw transport for remote workspaces. Callers should generally use the
// `fs*` functions above, which route to these on an `ssh://` path — these are
// exported for the connection lifecycle, which has no local equivalent.

export interface RemoteDirEntry {
  name: string;
  /** Absolute POSIX path on the remote host (no `ssh://` prefix). */
  path: string;
  is_dir: boolean;
  size: number;
}

/** Open (or reopen) the remote filesystem for a saved SSH host. Returns the
 *  absolute remote root — the login directory when `path` is omitted. */
export async function sshFsConnect(hostId: string, path?: string): Promise<string> {
  return invoke<string>('ssh_fs_connect', { hostId, path: path ?? null });
}

export async function sshFsDisconnect(hostId: string): Promise<void> {
  await invoke('ssh_fs_disconnect', { hostId });
}

export async function sshFsConnected(hostId: string): Promise<boolean> {
  return invoke<boolean>('ssh_fs_connected', { hostId });
}

export async function sshFsReadDir(hostId: string, path: string): Promise<RemoteDirEntry[]> {
  return invoke<RemoteDirEntry[]>('ssh_fs_read_dir', { hostId, path });
}

export async function sshFsReadFile(hostId: string, path: string): Promise<string> {
  return invoke<string>('ssh_fs_read_file', { hostId, path });
}

export async function sshFsWriteFile(
  hostId: string,
  path: string,
  contents: string,
): Promise<void> {
  await invoke('ssh_fs_write_file', { hostId, path, contents });
}

export async function sshFsCreateDir(hostId: string, path: string): Promise<void> {
  await invoke('ssh_fs_create_dir', { hostId, path });
}

export async function sshFsRename(hostId: string, from: string, to: string): Promise<void> {
  await invoke('ssh_fs_rename', { hostId, from, to });
}

export async function sshFsRemove(hostId: string, path: string, isDir: boolean): Promise<void> {
  await invoke('ssh_fs_remove', { hostId, path, isDir });
}

// ----- Process runner ----------------------------------------------------
//
// Runs a program to completion and returns its captured output. The test
// explorer needs a runner's exit code as *data*; a PTY tab shows it to a
// human but gives the UI nothing to build a pass/fail tree from.

export interface ProcOutput {
  /** Exit status, or null when killed by a signal or the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

export async function procRun(
  cwd: string,
  program: string,
  args: string[],
  timeoutMs?: number,
): Promise<ProcOutput> {
  return invoke<ProcOutput>('proc_run', {
    cwd,
    program,
    args,
    timeoutMs: timeoutMs ?? null,
  });
}

// ----- Database client ---------------------------------------------------

export type DbBackend = 'postgres' | 'mysql' | 'sqlite';

export interface DbConnection {
  id: string;
  name: string;
  backend: DbBackend;
  /** Connection URL with the password removed — the password itself lives in
   *  the OS credential vault, keyed by this connection's id. */
  url: string;
  has_password: boolean;
  created_at: number;
  last_used_at: number | null;
}

export interface DbConnectionInput {
  id?: string | null;
  name: string;
  backend: DbBackend;
  url: string;
  has_password: boolean;
}

export interface DbQueryResult {
  columns: string[];
  /** Row-major cells. `null` is SQL NULL, distinct from an empty string. */
  rows: Array<Array<string | null>>;
  rows_affected: number;
  duration_ms: number;
  truncated: boolean;
}

export async function dbConnList(): Promise<DbConnection[]> {
  return invoke<DbConnection[]>('db_conn_list');
}

export async function dbConnUpsert(input: DbConnectionInput): Promise<DbConnection> {
  return invoke<DbConnection>('db_conn_upsert', { input });
}

export async function dbConnDelete(id: string): Promise<void> {
  await invoke('db_conn_delete', { id });
}

/** Store the connection's password in the OS vault. An empty string clears it. */
export async function dbPasswordSet(id: string, password: string): Promise<void> {
  await invoke('db_password_set', { id, password });
}

export async function dbConnect(id: string): Promise<DbBackend> {
  return invoke<DbBackend>('db_connect', { id });
}

export async function dbDisconnect(id: string): Promise<void> {
  await invoke('db_disconnect', { id });
}

export async function dbIsConnected(id: string): Promise<boolean> {
  return invoke<boolean>('db_is_connected', { id });
}

export async function dbQuery(id: string, sql: string): Promise<DbQueryResult> {
  return invoke<DbQueryResult>('db_query', { id, sql });
}

export async function dbTables(id: string): Promise<string[]> {
  return invoke<string[]>('db_tables', { id });
}

export async function dbPreview(
  id: string,
  table: string,
  limit?: number,
): Promise<DbQueryResult> {
  return invoke<DbQueryResult>('db_preview', { id, table, limit: limit ?? null });
}
