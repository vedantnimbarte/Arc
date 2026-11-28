import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  FileJson,
  Folder,
  History as HistoryIcon,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
  X,
  Globe,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  Sparkles,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { Select } from './Select';
import { useWorkspace } from '../state/workspace';
import {
  apiclientAppendHistory,
  apiclientClearHistory,
  apiclientDeleteCollection,
  apiclientDeleteRequest,
  apiclientEnvsDelete,
  apiclientEnvsList,
  apiclientEnvsSetActive,
  apiclientEnvsUpsert,
  apiclientHistory,
  apiclientListCollections,
  apiclientListRequests,
  apiclientUpsertCollection,
  apiclientUpsertRequest,
  fsPickFiles,
  httpRequest,
  type ApiCollection,
  type ApiEnvironment,
  type ApiHistoryEntry,
  type ApiSavedRequest,
  type ApiSavedRequestInput,
  type HttpBodyDto,
  type HttpHeaderKV,
  type HttpRequestDto,
  type HttpResponseDto,
} from '../lib/tauri';
import { askConfirm, askText } from '../state/confirm';
import { toastError } from '../state/toast';
import { MOD_ENTER } from '../state/shortcuts';
import { Button, EmptyState, ErrorNote } from './ui';
import { copyText } from '../lib/clipboard';
import { parseCurl, toCurl } from '../lib/curl';
import { parseOpenApi } from '../lib/openapi';
import { extractVariables, type PostVarResult, type PostVarRule } from '../lib/responseVars';

interface Props {
  tabId: string;
}

// ─── Method palette ──────────────────────────────────────────────────────

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type Method = (typeof METHODS)[number];

/** Method → text colour token. Only the method label itself wears colour. */
function methodColour(m: string): string {
  switch (m.toUpperCase()) {
    case 'GET':
      return 'text-status-ok';
    case 'POST':
      return 'text-accent';
    case 'PUT':
    case 'PATCH':
      return 'text-status-warn';
    case 'DELETE':
      return 'text-status-err';
    default:
      return 'text-fg-muted';
  }
}

// ─── Per-tab state shape (serialized to apiClientState JSON) ─────────────

type BodyMode = 'none' | 'json' | 'xml' | 'text' | 'form' | 'multipart' | 'graphql';

type AuthMode = 'none' | 'bearer' | 'basic' | 'apikey';

interface KV {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
  /** Multipart rows only: `value` is a local file path, uploaded by Rust. */
  file?: boolean;
}

interface AuthState {
  mode: AuthMode;
  token: string;
  username: string;
  password: string;
  apiKeyName: string;
  apiKeyValue: string;
  apiKeyIn: 'header' | 'query';
}

interface RequestDraft {
  /** Local sub-tab id; not necessarily the saved-request id. */
  localId: string;
  /** When present, mirrors a row in `api_requests`. */
  savedId: string | null;
  name: string;
  method: Method;
  url: string;
  params: KV[];
  headers: KV[];
  bodyMode: BodyMode;
  /** Raw body text; the query in GraphQL mode. */
  bodyText: string;
  /** GraphQL variables JSON. Optional — older persisted drafts lack it. */
  graphqlVariables?: string;
  formBody: KV[];
  multipartBody: KV[];
  auth: AuthState;
  /** Post-response rules that set environment variables. Optional — older
   *  persisted drafts lack it. */
  postVars?: PostVarRule[];
  /** True while a Send is in flight. Transient — not persisted. */
  pending?: boolean;
  /** Last response received in this sub-tab. Transient — not persisted. */
  response?: HttpResponseDto;
  /** What the post-response rules did with `response`. Transient. */
  setVars?: PostVarResult[];
  /** Send error string when the last attempt failed. Transient. */
  error?: string;
  /** Dirty since the last save into the linked saved request. */
  dirty?: boolean;
}

interface TabState {
  drafts: RequestDraft[];
  activeLocalId: string;
  leftRailCollapsed: boolean;
  responseTab: ResponseTab;
  builderTab: BuilderTab;
}

type BuilderTab = 'params' | 'headers' | 'body' | 'auth' | 'post';
type ResponseTab = 'pretty' | 'raw' | 'headers' | 'preview';

// ─── State helpers ───────────────────────────────────────────────────────

function newLocalId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function emptyAuth(): AuthState {
  return {
    mode: 'none',
    token: '',
    username: '',
    password: '',
    apiKeyName: '',
    apiKeyValue: '',
    apiKeyIn: 'header',
  };
}

function emptyDraft(name = 'Untitled request'): RequestDraft {
  return {
    localId: newLocalId(),
    savedId: null,
    name,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    bodyMode: 'none',
    bodyText: '',
    formBody: [],
    multipartBody: [],
    auth: emptyAuth(),
  };
}

function emptyTabState(): TabState {
  const d = emptyDraft();
  return {
    drafts: [d],
    activeLocalId: d.localId,
    leftRailCollapsed: false,
    responseTab: 'pretty',
    builderTab: 'params',
  };
}

/** Parse the per-tab state JSON. Fails closed: any decode error returns a
 *  fresh empty state instead of throwing. */
function parseTabState(raw: string | undefined): TabState {
  if (!raw) return emptyTabState();
  try {
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.drafts) || v.drafts.length === 0) return emptyTabState();
    // Strip transient fields if a previous version accidentally persisted them.
    const drafts: RequestDraft[] = v.drafts.map((d: RequestDraft) => ({
      ...d,
      pending: false,
      response: undefined,
      error: undefined,
      setVars: undefined,
    }));
    return {
      drafts,
      activeLocalId:
        typeof v.activeLocalId === 'string' && drafts.some((d) => d.localId === v.activeLocalId)
          ? v.activeLocalId
          : (drafts[0]?.localId ?? newLocalId()),
      leftRailCollapsed: !!v.leftRailCollapsed,
      responseTab: v.responseTab ?? 'pretty',
      builderTab: v.builderTab ?? 'params',
    };
  } catch {
    return emptyTabState();
  }
}

/** Strip transient fields before stringifying for persistence. */
function serializeTabState(state: TabState): string {
  return JSON.stringify({
    ...state,
    drafts: state.drafts.map(
      ({ pending: _p, response: _r, error: _e, setVars: _v, ...rest }) => rest,
    ),
  });
}

// ─── Variable interpolation ──────────────────────────────────────────────

function activeEnvVars(envs: ApiEnvironment[]): Record<string, string> {
  const active = envs.find((e) => e.is_active);
  if (!active) return {};
  try {
    const parsed = JSON.parse(active.vars_json);
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
      );
    }
  } catch {
    // fall through — empty vars
  }
  return {};
}

const VAR_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

function interpolate(input: string, vars: Record<string, string>): string {
  return input.replace(VAR_PATTERN, (_, name: string) => vars[name] ?? '');
}

function interpolateKV(list: KV[], vars: Record<string, string>): HttpHeaderKV[] {
  return list
    .filter((kv) => kv.enabled && kv.name.trim().length > 0)
    .map((kv) => ({
      name: interpolate(kv.name, vars),
      value: interpolate(kv.value, vars),
    }));
}

// ─── Auth → header injection ─────────────────────────────────────────────

function applyAuth(headers: HttpHeaderKV[], queryUrl: string, auth: AuthState): {
  headers: HttpHeaderKV[];
  url: string;
} {
  if (auth.mode === 'none') return { headers, url: queryUrl };
  const next = [...headers];
  let url = queryUrl;
  if (auth.mode === 'bearer' && auth.token) {
    next.push({ name: 'Authorization', value: `Bearer ${auth.token}` });
  } else if (auth.mode === 'basic' && (auth.username || auth.password)) {
    const enc = btoa(`${auth.username}:${auth.password}`);
    next.push({ name: 'Authorization', value: `Basic ${enc}` });
  } else if (auth.mode === 'apikey' && auth.apiKeyName && auth.apiKeyValue) {
    if (auth.apiKeyIn === 'header') {
      next.push({ name: auth.apiKeyName, value: auth.apiKeyValue });
    } else {
      // Append to URL as a query parameter (after any existing ones).
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${encodeURIComponent(auth.apiKeyName)}=${encodeURIComponent(auth.apiKeyValue)}`;
    }
  }
  return { headers: next, url };
}

// ─── Draft → wire request ────────────────────────────────────────────────

/** Compose the wire request, applying env interpolation everywhere. Shared
 *  by Send and Copy as cURL so both see the same resolved request. Throws
 *  when GraphQL variables aren't valid JSON. */
function buildWireRequest(draft: RequestDraft, vars: Record<string, string>): HttpRequestDto {
  const interpolatedUrl = interpolate(draft.url, vars);
  const baseHeaders = interpolateKV(draft.headers, vars);
  const finalParams = interpolateKV(draft.params, vars);
  // If the URL already has a query, leave it alone; otherwise build
  // from the Params table. (Users syncing via the Params tab edit the
  // URL directly via setQueryOnUrl in the Params handler.)
  const urlWithParams = interpolatedUrl.includes('?')
    ? interpolatedUrl
    : finalParams.length > 0
      ? setQueryOnUrl(
          interpolatedUrl,
          finalParams.map((p) => ({ ...p, id: '', enabled: true })),
        )
      : interpolatedUrl;
  const { headers, url } = applyAuth(baseHeaders, urlWithParams, draft.auth);

  let method: string = draft.method;
  let body: HttpBodyDto = { kind: 'none' };
  switch (draft.bodyMode) {
    case 'json':
      body = {
        kind: 'raw',
        text: interpolate(draft.bodyText, vars),
        content_type: 'application/json',
      };
      break;
    case 'xml':
      body = {
        kind: 'raw',
        text: interpolate(draft.bodyText, vars),
        content_type: 'application/xml',
      };
      break;
    case 'text':
      body = {
        kind: 'raw',
        text: interpolate(draft.bodyText, vars),
        content_type: 'text/plain',
      };
      break;
    case 'form':
      body = { kind: 'formurlencoded', entries: interpolateKV(draft.formBody, vars) };
      break;
    case 'multipart':
      body = {
        kind: 'multipart',
        entries: draft.multipartBody
          .filter((kv) => kv.enabled && kv.name.trim().length > 0)
          .map((kv) => ({
            name: interpolate(kv.name, vars),
            value: interpolate(kv.value, vars),
            file: !!kv.file,
          })),
      };
      break;
    case 'graphql': {
      const rawVars = interpolate(draft.graphqlVariables ?? '', vars).trim();
      let variables: unknown = {};
      if (rawVars) {
        try {
          variables = JSON.parse(rawVars);
        } catch {
          throw new Error('GraphQL variables are not valid JSON');
        }
      }
      // GraphQL over HTTP is always a JSON POST, whatever the method picker says.
      method = 'POST';
      body = {
        kind: 'raw',
        text: JSON.stringify({ query: interpolate(draft.bodyText, vars), variables }),
        content_type: 'application/json',
      };
      break;
    }
    default:
      body = { kind: 'none' };
  }

  return { method, url, headers, body };
}

/** Serialize a draft into the saved-request row shape. */
function draftToSavedInput(
  d: RequestDraft,
  name: string,
  collectionId: string | null,
  position = 0,
): ApiSavedRequestInput {
  return {
    id: d.savedId ?? undefined,
    collection_id: collectionId,
    name,
    method: d.method,
    url: d.url,
    params_json: JSON.stringify(d.params),
    headers_json: JSON.stringify(d.headers),
    body_json: JSON.stringify({
      bodyMode: d.bodyMode,
      bodyText: d.bodyText,
      graphqlVariables: d.graphqlVariables ?? '',
      formBody: d.formBody,
      multipartBody: d.multipartBody,
      // Rides in body_json so saved requests keep their rules without a
      // schema change.
      postVars: d.postVars ?? [],
    }),
    auth_json: JSON.stringify(d.auth),
    position,
  };
}

/** Guess the body mode for an imported raw body from its Content-Type. */
function bodyModeFor(body: string | null, headers: HttpHeaderKV[]): BodyMode {
  if (body === null) return 'none';
  const ct = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  return 'text';
}

// ─── KV table helpers ────────────────────────────────────────────────────

function newKV(): KV {
  return { id: newLocalId(), name: '', value: '', enabled: true };
}

/** Render a key/value table — used for Params / Headers / Form body etc. */
function KvTable({
  rows,
  onChange,
  nameSuggestions,
  placeholder,
  allowFiles,
}: {
  rows: KV[];
  onChange: (next: KV[]) => void;
  nameSuggestions?: string[];
  placeholder?: { name?: string; value?: string };
  /** Multipart: each row can switch its value to a file picked from disk. */
  allowFiles?: boolean;
}) {
  const update = (id: string, patch: Partial<KV>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));
  const append = () => onChange([...rows, newKV()]);
  const toggleFile = async (row: KV) => {
    if (row.file) {
      update(row.id, { file: false, value: '' });
      return;
    }
    try {
      const [path] = await fsPickFiles();
      if (path) update(row.id, { file: true, value: path });
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  };
  const cols = allowFiles
    ? 'grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_24px_24px]'
    : 'grid-cols-[20px_minmax(0,1fr)_minmax(0,1fr)_24px]';

  return (
    <div className="overflow-hidden rounded-md border border-edge-1">
      <div className={cn('grid items-center gap-2 border-b border-edge-1 bg-scrim-1 px-2 py-1.5 font-display text-2xs text-fg-subtle', cols)}>
        <span />
        <span>Key</span>
        <span>Value</span>
        {allowFiles && <span />}
        <span />
      </div>
      {rows.length === 0 && (
        <div className="px-3 py-3 font-display text-xs text-fg-subtle/80">
          No rows yet.
        </div>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn('grid items-center gap-2 border-b border-edge-1 px-2 py-1.5 last:border-b-0 hover:bg-surface-1', cols)}
        >
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(e) => update(row.id, { enabled: e.target.checked })}
            className="h-3 w-3 accent-accent"
            aria-label="Enabled"
          />
          <input
            list={nameSuggestions ? `kv-suggest-${row.id}` : undefined}
            value={row.name}
            onChange={(e) => update(row.id, { name: e.target.value })}
            placeholder={placeholder?.name ?? 'key'}
            className="min-w-0 bg-transparent font-mono text-sm text-fg-base outline-none placeholder:text-fg-subtle/50"
          />
          {nameSuggestions && (
            <datalist id={`kv-suggest-${row.id}`}>
              {nameSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          <input
            value={row.value}
            onChange={(e) => update(row.id, { value: e.target.value })}
            readOnly={row.file}
            title={row.file ? row.value : undefined}
            placeholder={placeholder?.value ?? 'value'}
            className={cn(
              'min-w-0 bg-transparent font-mono text-sm text-fg-base outline-none placeholder:text-fg-subtle/50',
              row.file && 'text-accent',
            )}
          />
          {allowFiles && (
            <button
              onClick={() => void toggleFile(row)}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-surface-2',
                row.file ? 'text-accent' : 'text-fg-subtle/70 hover:text-fg-base',
              )}
              aria-label={row.file ? 'Use a text value' : 'Pick a file'}
              title={row.file ? 'File — click to use a text value instead' : 'Pick a file to upload'}
            >
              <Paperclip size={11} strokeWidth={2} />
            </button>
          )}
          <button
            onClick={() => remove(row.id)}
            className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle/70 transition-colors hover:bg-surface-2 hover:text-status-err"
            aria-label="Remove row"
            title="Remove row"
          >
            <X size={11} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button
        onClick={append}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-display text-xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-base"
      >
        <Plus size={11} strokeWidth={2.2} />
        Add row
      </button>
    </div>
  );
}

// ─── URL ↔ params sync ───────────────────────────────────────────────────

/** Read the query portion of a URL into KV rows. Preserves order. */
function urlToParams(url: string): KV[] {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return [];
  const qs = url.slice(qIdx + 1);
  if (!qs) return [];
  return qs.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    return {
      id: newLocalId(),
      name: safeDecode(name),
      value: safeDecode(value),
      enabled: true,
    };
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function paramsToQuery(params: KV[]): string {
  const out: string[] = [];
  for (const p of params) {
    if (!p.enabled || !p.name) continue;
    out.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`);
  }
  return out.join('&');
}

function setQueryOnUrl(url: string, params: KV[]): string {
  const qIdx = url.indexOf('?');
  const base = qIdx < 0 ? url : url.slice(0, qIdx);
  const qs = paramsToQuery(params);
  return qs ? `${base}?${qs}` : base;
}

// ─── Pretty-print helpers ────────────────────────────────────────────────

function tryPrettyJson(s: string): { ok: boolean; text: string } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(s), null, 2) };
  } catch {
    return { ok: false, text: s };
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function statusTone(status: number): string {
  if (status >= 500) return 'bg-status-err/15 text-status-err';
  if (status >= 400) return 'bg-status-warn/15 text-status-warn';
  if (status >= 300) return 'bg-accent/15 text-accent';
  if (status >= 200) return 'bg-status-ok/15 text-status-ok';
  return 'bg-surface-2 text-fg-base';
}

/** Status → text colour only, for the compact history rows. */
function statusText(status: number): string {
  return statusTone(status).split(' ')[1]!;
}

const COMMON_HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Cookie',
  'Origin',
  'Referer',
  'User-Agent',
  'X-Api-Key',
  'X-Requested-With',
];

// ─── Main component ──────────────────────────────────────────────────────

/** Pane width below which the requests rail becomes an overlay. */
const NARROW_PX = 640;

export function ApiClient({ tabId }: Props) {
  const sessionId = useWorkspace((s) => s.sessionId);
  const tabRaw = useWorkspace((s) => s.tabs.find((t) => t.id === tabId)?.apiClientState);
  const setApiClientState = useWorkspace((s) => s.setApiClientState);

  // Local state hydrated once from the persisted blob. We never set local
  // state from `tabRaw` after mount — that would clobber in-flight edits.
  const [state, setState] = useState<TabState>(() => parseTabState(tabRaw));

  // Persist on local change (debounced via React batching + the workspace
  // store's own 250 ms debounce).
  useEffect(() => {
    setApiClientState(tabId, serializeTabState(state));
    // We intentionally exclude setApiClientState/tabId from the dep list — they
    // are stable references for the lifetime of the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const active = useMemo(
    () => state.drafts.find((d) => d.localId === state.activeLocalId) ?? state.drafts[0]!,
    [state.drafts, state.activeLocalId],
  );

  const updateDraft = useCallback(
    (id: string, patch: Partial<RequestDraft>) => {
      setState((s) => ({
        ...s,
        drafts: s.drafts.map((d) => (d.localId === id ? { ...d, ...patch, dirty: true } : d)),
      }));
    },
    [],
  );

  // ─── Left-rail data (collections, history, environments) ──────────────
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [savedRequests, setSavedRequests] = useState<ApiSavedRequest[]>([]);
  const [history, setHistory] = useState<ApiHistoryEntry[]>([]);
  const [envs, setEnvs] = useState<ApiEnvironment[]>([]);
  const vars = useMemo(() => activeEnvVars(envs), [envs]);

  const refreshAll = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [c, r, h, e] = await Promise.all([
        apiclientListCollections(sessionId),
        apiclientListRequests(sessionId),
        apiclientHistory(sessionId, 50),
        apiclientEnvsList(sessionId),
      ]);
      setCollections(c);
      setSavedRequests(r);
      setHistory(h);
      setEnvs(e);
    } catch (err) {
      console.warn('[ApiClient] left-rail load failed:', err);
    }
  }, [sessionId]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // ─── Post-response variables ──────────────────────────────────────────

  /** Run a draft's post-response rules and write what they found into the
   *  active environment — the same layer `{{var}}` reads from, so the next
   *  request sees it. Returns per-rule results for the response pane. */
  const applyPostVars = useCallback(
    async (rules: PostVarRule[], response: HttpResponseDto): Promise<PostVarResult[]> => {
      const results = extractVariables(rules, response);
      const found = results.filter((r) => r.value !== undefined);
      if (found.length === 0) return results;
      const env = envs.find((e) => e.is_active);
      const fail = (error: string) =>
        results.map((r) => (r.value === undefined ? r : { variable: r.variable, error }));
      if (!sessionId || !env) return fail('no active environment');
      try {
        let current: Record<string, unknown> = {};
        try {
          current = JSON.parse(env.vars_json) as Record<string, unknown>;
        } catch {
          // Unreadable vars are replaced, same as saving the editor would.
        }
        for (const r of found) current[r.variable] = r.value;
        const saved = await apiclientEnvsUpsert(sessionId, {
          id: env.id,
          name: env.name,
          varsJson: JSON.stringify(current),
        });
        setEnvs((list) => list.map((e) => (e.id === saved.id ? { ...saved, is_active: e.is_active } : e)));
        return results;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
    [envs, sessionId],
  );

  // ─── Send action ──────────────────────────────────────────────────────

  const send = useCallback(
    async (draft: RequestDraft) => {
      if (!draft.url.trim()) return;

      let req: HttpRequestDto;
      try {
        req = buildWireRequest(draft, vars);
      } catch (err) {
        updateDraft(draft.localId, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const { url } = req;

      updateDraft(draft.localId, { pending: true, error: undefined, setVars: undefined });
      try {
        const response = await httpRequest(req);
        // Chaining only follows a 2xx — a 401's body has no token worth keeping.
        const setVars =
          response.status >= 200 && response.status < 300 && draft.postVars?.length
            ? await applyPostVars(draft.postVars, response)
            : undefined;
        updateDraft(draft.localId, { pending: false, response, error: undefined, setVars });
        if (sessionId) {
          try {
            await apiclientAppendHistory(sessionId, {
              method: req.method,
              url,
              request_snapshot_json: JSON.stringify(req),
              status: response.status,
              time_ms: response.time_ms,
              size_bytes: response.size_bytes,
              response_excerpt: response.body_text ?? null,
            });
            const h = await apiclientHistory(sessionId, 50);
            setHistory(h);
          } catch (err) {
            console.warn('[ApiClient] history append failed:', err);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateDraft(draft.localId, { pending: false, error: msg });
        if (sessionId) {
          try {
            await apiclientAppendHistory(sessionId, {
              method: req.method,
              url,
              request_snapshot_json: JSON.stringify(req),
              status: null,
              time_ms: null,
              size_bytes: null,
              response_excerpt: null,
              error: msg,
            });
            const h = await apiclientHistory(sessionId, 50);
            setHistory(h);
          } catch {
            // best-effort
          }
        }
      }
    },
    [applyPostVars, sessionId, updateDraft, vars],
  );

  // Cmd/Ctrl+Enter shortcut to send
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (active && !active.pending) void send(active);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, send]);

  // ─── Sub-tab actions ──────────────────────────────────────────────────

  const newSubTab = () => {
    const d = emptyDraft();
    setState((s) => ({ ...s, drafts: [...s.drafts, d], activeLocalId: d.localId }));
  };
  const closeSubTab = (localId: string) => {
    setState((s) => {
      const next = s.drafts.filter((d) => d.localId !== localId);
      if (next.length === 0) {
        const d = emptyDraft();
        return { ...s, drafts: [d], activeLocalId: d.localId };
      }
      const wasActive = s.activeLocalId === localId;
      return {
        ...s,
        drafts: next,
        activeLocalId: wasActive ? next[next.length - 1]!.localId : s.activeLocalId,
      };
    });
  };

  // ─── Saved-request load ───────────────────────────────────────────────

  const openSavedRequest = (saved: ApiSavedRequest) => {
    setState((s) => {
      // If already open, just focus it.
      const existing = s.drafts.find((d) => d.savedId === saved.id);
      if (existing) return { ...s, activeLocalId: existing.localId };
      const d = savedToDraft(saved);
      return { ...s, drafts: [...s.drafts, d], activeLocalId: d.localId };
    });
  };

  const saveCurrent = async (collectionId?: string | null) => {
    if (!sessionId || !active) return;
    let name = (active.name || 'Untitled request').trim();
    if (!name || name === 'Untitled request') {
      const proposed = await askText(
        'Save request',
        { label: 'Name', value: active.url || 'My request' },
        'Save',
      );
      if (!proposed) return;
      name = proposed.trim() || 'Untitled request';
    }
    const upserted = await apiclientUpsertRequest(
      sessionId,
      draftToSavedInput(active, name, collectionId ?? null),
    );
    updateDraft(active.localId, { savedId: upserted.id, dirty: false, name });
    void refreshAll();
  };

  // ─── cURL import / export ─────────────────────────────────────────────

  const copyAsCurl = () => {
    try {
      copyText(toCurl(buildWireRequest(active, vars)), 'cURL command');
    } catch (err) {
      toastError(err instanceof Error ? err.message : String(err));
    }
  };

  const importCurl = async () => {
    const cmd = await askText(
      'Import from cURL',
      { label: 'cURL command', placeholder: "curl -X POST 'https://…' -H '…' -d '…'", multiline: true },
      'Import',
    );
    if (cmd) importCurlText(cmd);
  };

  /** Parse a cURL command into a draft. An untouched blank draft is filled in
   *  place (the paste-into-URL case); otherwise it opens in a new sub-tab. */
  const importCurlText = (cmd: string) => {
    try {
      const parsed = parseCurl(cmd);
      const d = emptyDraft();
      d.method = (METHODS as readonly string[]).includes(parsed.method)
        ? (parsed.method as Method)
        : 'GET';
      d.url = parsed.url;
      d.params = urlToParams(parsed.url);
      d.headers = parsed.headers.map((h) => ({ ...newKV(), name: h.name, value: h.value }));
      d.bodyMode = bodyModeFor(parsed.body, parsed.headers);
      d.bodyText = parsed.body ?? '';
      if (parsed.form) {
        d.bodyMode = 'multipart';
        d.multipartBody = parsed.form.map((f) => ({ ...newKV(), name: f.name, value: f.value, file: f.file }));
      } else if (parsed.urlencoded) {
        d.bodyMode = 'form';
        d.bodyText = '';
        d.formBody = parsed.urlencoded.map((f) => ({ ...newKV(), name: f.name, value: f.value }));
      }
      setState((s) => {
        const cur = s.drafts.find((x) => x.localId === s.activeLocalId);
        if (cur && !cur.url.trim() && !cur.savedId) {
          return { ...s, drafts: s.drafts.map((x) => (x === cur ? { ...d, localId: cur.localId } : x)) };
        }
        return { ...s, drafts: [...s.drafts, d], activeLocalId: d.localId };
      });
    } catch (err) {
      toastError(`Couldn't import cURL: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ─── Narrow pane ──────────────────────────────────────────────────────
  // Below NARROW_PX the 256px rail would crush the builder, so it hides by
  // default and opens as an overlay. The wide-mode collapse is persisted;
  // the overlay is transient.
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_PX);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const railVisible = narrow ? overlayOpen : !state.leftRailCollapsed;
  const toggleRail = () =>
    narrow
      ? setOverlayOpen((o) => !o)
      : setState((s) => ({ ...s, leftRailCollapsed: !s.leftRailCollapsed }));
  /** In overlay mode, picking something from the rail closes it. */
  const fromRail =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      fn(...a);
      if (narrow) setOverlayOpen(false);
    };

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div ref={rootRef} className="flex h-full w-full flex-col bg-bg-base">
      {/* Sub-tab strip */}
      <SubTabStrip
        drafts={state.drafts}
        activeId={state.activeLocalId}
        onSelect={(id) => setState((s) => ({ ...s, activeLocalId: id }))}
        onClose={closeSubTab}
        onNew={newSubTab}
        railVisible={railVisible}
        onToggleRail={toggleRail}
      />

      <div className="relative flex min-h-0 flex-1">
        {narrow && overlayOpen && (
          <div className="absolute inset-0 z-20" onClick={() => setOverlayOpen(false)} aria-hidden />
        )}
        {/* Left rail */}
        {railVisible && (
          <LeftRail
            overlay={narrow}
            sessionId={sessionId}
            collections={collections}
            savedRequests={savedRequests}
            history={history}
            envs={envs}
            vars={vars}
            onOpenSaved={fromRail(openSavedRequest)}
            onRefresh={refreshAll}
            onCollapse={toggleRail}
            onLoadHistory={fromRail((h: ApiHistoryEntry) => {
              try {
                const snap = JSON.parse(h.request_snapshot_json) as HttpRequestDto;
                const d = emptyDraft(h.url);
                d.method = (snap.method as Method) ?? 'GET';
                d.url = snap.url;
                d.headers = (snap.headers ?? []).map((kv) => ({
                  id: newLocalId(),
                  name: kv.name,
                  value: kv.value,
                  enabled: true,
                }));
                // body kind → body mode
                const b = snap.body;
                if (b && b.kind === 'raw') {
                  d.bodyText = b.text;
                  d.bodyMode = b.content_type.includes('json')
                    ? 'json'
                    : b.content_type.includes('xml')
                      ? 'xml'
                      : 'text';
                } else if (b && b.kind === 'formurlencoded') {
                  d.bodyMode = 'form';
                  d.formBody = b.entries.map((kv) => ({
                    id: newLocalId(),
                    name: kv.name,
                    value: kv.value,
                    enabled: true,
                  }));
                } else if (b && b.kind === 'multipart') {
                  d.bodyMode = 'multipart';
                  d.multipartBody = b.entries.map((kv) => ({
                    id: newLocalId(),
                    name: kv.name,
                    value: kv.value,
                    enabled: true,
                    file: kv.file,
                  }));
                }
                setState((s) => ({
                  ...s,
                  drafts: [...s.drafts, d],
                  activeLocalId: d.localId,
                }));
              } catch (err) {
                console.warn('[ApiClient] history snapshot decode failed:', err);
              }
            })}
          />
        )}

        {/* Right side — request builder + response viewer */}
        <div className="flex min-w-0 flex-1 flex-col">
          <RequestBuilder
            draft={active}
            builderTab={state.builderTab}
            onBuilderTab={(t) => setState((s) => ({ ...s, builderTab: t }))}
            vars={vars}
            onChange={(patch) => updateDraft(active.localId, patch)}
            onSend={() => void send(active)}
            onSave={() => void saveCurrent()}
            onCopyCurl={copyAsCurl}
            onImportCurl={() => void importCurl()}
            onPasteCurl={importCurlText}
          />
          <ResponseViewer
            draft={active}
            responseTab={state.responseTab}
            onResponseTab={(t) => setState((s) => ({ ...s, responseTab: t }))}
            onSample={() => {
              const sample = { ...active, url: 'https://httpbin.org/get', method: 'GET' as const };
              updateDraft(active.localId, { url: sample.url, method: sample.method });
              void send(sample);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-tab strip ───────────────────────────────────────────────────────

function SubTabStrip({
  drafts,
  activeId,
  onSelect,
  onClose,
  onNew,
  railVisible,
  onToggleRail,
}: {
  drafts: RequestDraft[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  railVisible: boolean;
  onToggleRail: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto bg-bg-chrome px-2">
      <button
        onClick={onToggleRail}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-2 hover:text-fg-base',
          railVisible ? 'text-fg-base' : 'text-fg-subtle',
        )}
        title={railVisible ? 'Hide requests' : 'Show requests'}
        aria-label={railVisible ? 'Hide requests' : 'Show requests'}
        aria-pressed={railVisible}
      >
        <PanelLeft size={13} strokeWidth={2} />
      </button>
      {drafts.map((d) => {
        const active = d.localId === activeId;
        const label = d.name && d.name !== 'Untitled request' ? d.name : d.url || 'Untitled';
        return (
          <button
            key={d.localId}
            onClick={() => onSelect(d.localId)}
            className={cn(
              'group flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 font-display text-xs transition-colors',
              active
                ? 'bg-surface-2 text-fg-base'
                : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted',
            )}
            title={label}
          >
            <span
              className={cn(
                'font-mono text-2xs font-semibold tracking-tight',
                methodColour(d.method),
              )}
            >
              {d.method}
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {d.dirty && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80" aria-label="Unsaved changes" />
            )}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onClose(d.localId);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle/60 opacity-0 transition-all hover:bg-surface-2 hover:text-fg-base group-hover:opacity-100"
              aria-label="Close request"
            >
              <X size={10} strokeWidth={2.2} />
            </span>
          </button>
        );
      })}
      <button
        onClick={onNew}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        title="New request"
        aria-label="New request"
      >
        <Plus size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}

// ─── Request builder ─────────────────────────────────────────────────────

const BUILDER_TAB_LABEL: Record<BuilderTab, string> = {
  params: 'Query',
  headers: 'Headers',
  body: 'Body',
  auth: 'Auth',
  post: 'After response',
};

function RequestBuilder({
  draft,
  builderTab,
  onBuilderTab,
  vars,
  onChange,
  onSend,
  onSave,
  onCopyCurl,
  onImportCurl,
  onPasteCurl,
}: {
  draft: RequestDraft;
  builderTab: BuilderTab;
  onBuilderTab: (t: BuilderTab) => void;
  vars: Record<string, string>;
  onChange: (patch: Partial<RequestDraft>) => void;
  onSend: () => void;
  onSave: () => void;
  onCopyCurl: () => void;
  onImportCurl: () => void;
  onPasteCurl: (cmd: string) => void;
}) {
  const [methodOpen, setMethodOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const methodRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex shrink-0 flex-col border-b border-edge-1 bg-bg-base">
      {/* Method + URL + Send */}
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <div className="relative shrink-0">
          <button
            ref={methodRef}
            onClick={() => setMethodOpen((o) => !o)}
            className={cn(
              'flex h-8 items-center gap-1 rounded-md border border-edge-1 bg-scrim-1 px-2.5 font-mono text-xs font-semibold tracking-tight transition-colors hover:bg-scrim-1',
              methodColour(draft.method),
            )}
          >
            {draft.method}
            <ChevronDown size={10} strokeWidth={2} className="text-fg-subtle" />
          </button>
          {methodOpen && (
            <div
              className="material-sheet absolute left-0 top-9 z-20 w-32 overflow-hidden rounded-md shadow-sheet ring-1 ring-edge-2"
              onMouseLeave={() => setMethodOpen(false)}
            >
              {METHODS.map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    onChange({ method: m });
                    setMethodOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center px-3 py-1.5 text-left font-mono text-xs font-semibold transition-colors hover:bg-surface-2',
                    methodColour(m),
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        <UrlInput
          value={draft.url}
          onChange={(v) => onChange({ url: v })}
          onSubmit={onSend}
          onPasteCurl={onPasteCurl}
          vars={vars}
        />

        <Button
          variant="primary"
          onClick={onSend}
          disabled={draft.pending || !draft.url.trim()}
          title={`Send (${MOD_ENTER})`}
        >
          {draft.pending ? (
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent" />
          ) : (
            <Send size={12} strokeWidth={2.2} />
          )}
          {draft.pending ? 'Sending' : 'Send'}
        </Button>

        <button
          onClick={onSave}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          title="Save request"
          aria-label="Save request"
        >
          <Save size={12} strokeWidth={2} />
        </button>
        <div className="relative shrink-0">
          <button
            onClick={() => setMoreOpen((o) => !o)}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-surface-2 hover:text-fg-base',
              moreOpen ? 'bg-surface-2 text-fg-base' : 'text-fg-subtle',
            )}
            title="More"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal size={14} strokeWidth={2} />
          </button>
          {moreOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMoreOpen(false)} aria-hidden />
              <div
                role="menu"
                className="material-sheet absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-md py-1 shadow-sheet ring-1 ring-edge-2"
              >
                {[
                  { label: 'Copy as cURL', Icon: Copy, run: onCopyCurl, disabled: !draft.url.trim() },
                  { label: 'Import from cURL', Icon: ClipboardPaste, run: onImportCurl, disabled: false },
                ].map(({ label, Icon, run, disabled }) => (
                  <button
                    key={label}
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      setMoreOpen(false);
                      run();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-display text-xs text-fg-base transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Icon size={12} strokeWidth={2} className="text-fg-subtle" />
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Builder sub-tab strip */}
      <div className="flex items-center gap-0 overflow-x-auto border-t border-edge-1 px-3">
        {(['params', 'headers', 'body', 'auth', 'post'] as BuilderTab[]).map((t) => {
          const active = builderTab === t;
          const count =
            t === 'params'
              ? draft.params.filter((p) => p.enabled && p.name).length
              : t === 'headers'
                ? draft.headers.filter((p) => p.enabled && p.name).length
                : t === 'body'
                  ? draft.bodyMode === 'none'
                    ? 0
                    : 1
                  : t === 'post'
                    ? (draft.postVars ?? []).filter((r) => r.enabled && r.variable).length
                    : draft.auth.mode === 'none'
                      ? 0
                      : 1;
          return (
            <button
              key={t}
              onClick={() => onBuilderTab(t)}
              className={cn(
                'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 font-display text-xs tracking-tight transition-colors',
                active ? 'text-fg-base' : 'text-fg-subtle hover:text-fg-muted',
              )}
            >
              {BUILDER_TAB_LABEL[t]}
              {count > 0 && (
                <span className="rounded-sm bg-surface-2 px-1 font-mono text-2xs text-fg-base/80">
                  {count}
                </span>
              )}
              {active && (
                <span className="absolute inset-x-2.5 -bottom-px h-px bg-accent/80" aria-hidden />
              )}
            </button>
          );
        })}
      </div>

      <div className="max-h-[42vh] overflow-y-auto p-3">
        {builderTab === 'params' && (
          <KvTable
            rows={draft.params}
            onChange={(next) => {
              onChange({ params: next, url: setQueryOnUrl(draft.url, next) });
            }}
            placeholder={{ name: 'param', value: 'value' }}
          />
        )}
        {builderTab === 'headers' && (
          <KvTable
            rows={draft.headers}
            onChange={(next) => onChange({ headers: next })}
            nameSuggestions={COMMON_HEADERS}
            placeholder={{ name: 'Header-Name', value: 'value' }}
          />
        )}
        {builderTab === 'body' && (
          <BodyEditor
            mode={draft.bodyMode}
            text={draft.bodyText}
            form={draft.formBody}
            multipart={draft.multipartBody}
            graphqlVariables={draft.graphqlVariables ?? ''}
            onMode={(m) => onChange(m === 'graphql' ? { bodyMode: m, method: 'POST' } : { bodyMode: m })}
            onText={(text) => onChange({ bodyText: text })}
            onGraphqlVariables={(v) => onChange({ graphqlVariables: v })}
            onForm={(rows) => onChange({ formBody: rows })}
            onMultipart={(rows) => onChange({ multipartBody: rows })}
          />
        )}
        {builderTab === 'auth' && (
          <AuthEditor
            auth={draft.auth}
            onChange={(auth) => onChange({ auth })}
          />
        )}
        {builderTab === 'post' && (
          <PostVarsEditor rules={draft.postVars ?? []} onChange={(postVars) => onChange({ postVars })} />
        )}
      </div>
    </div>
  );
}

// ─── URL input (with inline {{var}} resolution preview) ─────────────────

function UrlInput({
  value,
  onChange,
  onSubmit,
  onPasteCurl,
  vars,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onPasteCurl: (cmd: string) => void;
  vars: Record<string, string>;
}) {
  // Compute the interpolation preview only for the tooltip; we don't render
  // chip-pill substitution inside the contenteditable because that would
  // require a full input-editor rebuild. The hover-preview is the v1 affordance.
  const resolved = useMemo(() => interpolate(value, vars), [value, vars]);
  const hasVars = VAR_PATTERN.test(value);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-edge-1 bg-scrim-1 px-2.5 transition-colors focus-within:border-accent/40 focus-within:shadow-focus">
      <Globe size={11} strokeWidth={2} className="shrink-0 text-fg-subtle" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (/^\s*curl\s/i.test(text)) {
            e.preventDefault();
            onPasteCurl(text);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="https://api.example.com/v1/{{resource}}, or paste a cURL command"
        className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-sm text-fg-base outline-none placeholder:text-fg-subtle/50"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {hasVars && (
        <span
          className="shrink-0 rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-2xs text-fg-subtle"
          title={resolved}
        >
          {resolved.length > 28 ? `${resolved.slice(0, 26)}…` : resolved}
        </span>
      )}
    </div>
  );
}

// ─── Body editor ─────────────────────────────────────────────────────────

function BodyEditor({
  mode,
  text,
  form,
  multipart,
  graphqlVariables,
  onMode,
  onText,
  onForm,
  onMultipart,
  onGraphqlVariables,
}: {
  mode: BodyMode;
  text: string;
  form: KV[];
  multipart: KV[];
  graphqlVariables: string;
  onMode: (m: BodyMode) => void;
  onText: (s: string) => void;
  onGraphqlVariables: (s: string) => void;
  onForm: (rows: KV[]) => void;
  onMultipart: (rows: KV[]) => void;
}) {
  const radios: { id: BodyMode; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'json', label: 'JSON' },
    { id: 'xml', label: 'XML' },
    { id: 'text', label: 'Text' },
    { id: 'form', label: 'Form' },
    { id: 'multipart', label: 'Form with files' },
    { id: 'graphql', label: 'GraphQL' },
  ];
  const isText = mode === 'json' || mode === 'xml' || mode === 'text';

  const prettifyJson = () => {
    const { ok, text: out } = tryPrettyJson(text);
    if (ok) onText(out);
  };
  const prettifyVariables = () => {
    const { ok, text: out } = tryPrettyJson(graphqlVariables);
    if (ok) onGraphqlVariables(out);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {radios.map((r) => (
          <button
            key={r.id}
            onClick={() => onMode(r.id)}
            className={cn(
              'rounded-sm px-2 py-1 font-display text-xs tracking-tight transition-colors',
              mode === r.id
                ? 'bg-accent/20 text-fg-base'
                : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted',
            )}
          >
            {r.label}
          </button>
        ))}
        {(mode === 'json' || mode === 'graphql') && (
          <button
            onClick={mode === 'json' ? prettifyJson : prettifyVariables}
            className="ml-auto flex items-center gap-1 rounded-sm px-2 py-1 font-display text-xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-base"
            title={mode === 'json' ? 'Format JSON' : 'Format variables JSON'}
          >
            <Sparkles size={10} strokeWidth={2} />
            Beautify
          </button>
        )}
      </div>
      {mode === 'none' && (
        <div className="rounded-md border border-dashed border-edge-1 p-4 text-center font-display text-xs text-fg-subtle/80">
          No body for this request.
        </div>
      )}
      {isText && (
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={mode === 'json' ? '{ "key": "value" }' : 'request body'}
          className="min-h-[180px] w-full resize-y rounded-md border border-edge-1 bg-scrim-1 p-2.5 font-mono text-sm leading-relaxed text-fg-base outline-none transition-colors focus:border-accent/40"
          spellCheck={false}
        />
      )}
      {mode === 'graphql' && (
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-[3fr_2fr]">
          <div className="flex flex-col gap-1">
            <label className="font-display text-xs text-fg-subtle">
              Query
            </label>
            <textarea
              value={text}
              onChange={(e) => onText(e.target.value)}
              placeholder={'query ($id: ID!) {\n  user(id: $id) { name }\n}'}
              className="min-h-[180px] w-full resize-y rounded-md border border-edge-1 bg-scrim-1 p-2.5 font-mono text-sm leading-relaxed text-fg-base outline-none transition-colors focus:border-accent/40"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-display text-xs text-fg-subtle">
              Variables (JSON)
            </label>
            <textarea
              value={graphqlVariables}
              onChange={(e) => onGraphqlVariables(e.target.value)}
              placeholder={'{ "id": "1" }'}
              className="min-h-[180px] w-full resize-y rounded-md border border-edge-1 bg-scrim-1 p-2.5 font-mono text-sm leading-relaxed text-fg-base outline-none transition-colors focus:border-accent/40"
              spellCheck={false}
            />
          </div>
        </div>
      )}
      {mode === 'form' && (
        <KvTable rows={form} onChange={onForm} placeholder={{ name: 'field', value: 'value' }} />
      )}
      {mode === 'multipart' && (
        <KvTable
          rows={multipart}
          onChange={onMultipart}
          allowFiles
          placeholder={{ name: 'field', value: 'value — or pick a file' }}
        />
      )}
    </div>
  );
}

// ─── Post-response variables editor ─────────────────────────────────────

const POST_VAR_SOURCES: { value: PostVarRule['source']; label: string; hint: string }[] = [
  { value: 'json', label: 'JSON path', hint: 'e.g. $.data.accessToken, $.items[0].id' },
  { value: 'header', label: 'Header', hint: 'A response header, by name.' },
  { value: 'status', label: 'Status', hint: 'The status code.' },
];

function PostVarsEditor({
  rules,
  onChange,
}: {
  rules: PostVarRule[];
  onChange: (next: PostVarRule[]) => void;
}) {
  const update = (id: string, patch: Partial<PostVarRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () =>
    onChange([...rules, { id: newLocalId(), enabled: true, variable: '', source: 'json', path: '$.' }]);

  return (
    <div className="flex flex-col gap-2">
      <div className="font-display text-xs text-fg-subtle">
        After a 2xx response, set variables in the active environment.
      </div>
      <div className="overflow-hidden rounded-md border border-edge-1">
        {rules.length === 0 && (
          <div className="px-3 py-3 font-display text-xs text-fg-subtle/80">No rules yet.</div>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[20px_minmax(0,1fr)_16px_130px_minmax(0,1fr)_24px] items-center gap-2 border-b border-edge-1 px-2 py-1.5 hover:bg-surface-1"
          >
            <input
              type="checkbox"
              checked={r.enabled}
              onChange={(e) => update(r.id, { enabled: e.target.checked })}
              className="h-3 w-3 accent-accent"
              aria-label="Enabled"
            />
            <input
              value={r.variable}
              onChange={(e) => update(r.id, { variable: e.target.value })}
              placeholder="variable"
              className="min-w-0 bg-transparent font-mono text-sm text-fg-base outline-none placeholder:text-fg-subtle/50"
            />
            <span className="text-center font-mono text-xs text-fg-subtle">←</span>
            <Select
              value={r.source}
              onChange={(source) => update(r.id, { source })}
              ariaLabel="Value source"
              className="h-7 py-0"
              options={POST_VAR_SOURCES}
            />
            <input
              value={r.source === 'status' ? '' : r.path}
              disabled={r.source === 'status'}
              onChange={(e) => update(r.id, { path: e.target.value })}
              placeholder={r.source === 'header' ? 'Header-Name' : r.source === 'json' ? '$.data.token' : ''}
              className="min-w-0 bg-transparent font-mono text-sm text-fg-base outline-none placeholder:text-fg-subtle/50 disabled:opacity-40"
            />
            <button
              onClick={() => onChange(rules.filter((x) => x.id !== r.id))}
              className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle/70 transition-colors hover:bg-surface-2 hover:text-status-err"
              aria-label="Remove rule"
              title="Remove rule"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        ))}
        <button
          onClick={add}
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-display text-xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-base"
        >
          <Plus size={11} strokeWidth={2.2} />
          Add rule
        </button>
      </div>
    </div>
  );
}

// ─── Auth editor ─────────────────────────────────────────────────────────

function AuthEditor({
  auth,
  onChange,
}: {
  auth: AuthState;
  onChange: (a: AuthState) => void;
}) {
  const modes: { id: AuthMode; label: string }[] = [
    { id: 'none', label: 'None' },
    { id: 'bearer', label: 'Bearer' },
    { id: 'basic', label: 'Basic' },
    { id: 'apikey', label: 'API Key' },
  ];

  // Never print the secret itself: this line sits on screen during demos and
  // screen shares.
  const computed = useMemo(() => {
    if (auth.mode === 'bearer' && auth.token) {
      return `Authorization: Bearer ${maskSecret(auth.token)}`;
    }
    if (auth.mode === 'basic' && (auth.username || auth.password)) {
      return 'Authorization: Basic ••••';
    }
    if (auth.mode === 'apikey' && auth.apiKeyName && auth.apiKeyValue) {
      return auth.apiKeyIn === 'header'
        ? `${auth.apiKeyName}: ${maskSecret(auth.apiKeyValue)}  (header)`
        : `?${auth.apiKeyName}=${maskSecret(auth.apiKeyValue)}  (query)`;
    }
    return null;
  }, [auth]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => onChange({ ...auth, mode: m.id })}
            className={cn(
              'rounded-sm px-2 py-1 font-display text-xs tracking-tight transition-colors',
              auth.mode === m.id
                ? 'bg-accent/20 text-fg-base'
                : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {auth.mode === 'bearer' && (
        <FieldInput
          label="Token"
          value={auth.token}
          onChange={(v) => onChange({ ...auth, token: v })}
          placeholder="eyJhbGciOi..."
          password
        />
      )}
      {auth.mode === 'basic' && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <FieldInput
            label="Username"
            value={auth.username}
            onChange={(v) => onChange({ ...auth, username: v })}
            placeholder="user"
          />
          <FieldInput
            label="Password"
            value={auth.password}
            onChange={(v) => onChange({ ...auth, password: v })}
            placeholder="••••••"
            password
          />
        </div>
      )}
      {auth.mode === 'apikey' && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
          <FieldInput
            label="Key"
            value={auth.apiKeyName}
            onChange={(v) => onChange({ ...auth, apiKeyName: v })}
            placeholder="X-Api-Key"
          />
          <FieldInput
            label="Value"
            value={auth.apiKeyValue}
            onChange={(v) => onChange({ ...auth, apiKeyValue: v })}
            placeholder="secret"
            password
          />
          <div className="flex flex-col gap-1">
            <label className="font-display text-xs text-fg-subtle">
              Add to
            </label>
            <Select
              value={auth.apiKeyIn}
              onChange={(v) => onChange({ ...auth, apiKeyIn: v })}
              ariaLabel="Send the API key in"
              className="h-8 py-0"
              options={[
                { value: 'header', label: 'Header', hint: 'Sent as a request header.' },
                { value: 'query', label: 'Query', hint: 'Appended to the URL as a query parameter.' },
              ]}
            />
          </div>
        </div>
      )}

      {computed && (
        <div className="flex min-w-0 items-baseline gap-2 rounded-md bg-scrim-1 px-3 py-2">
          <span className="shrink-0 font-display text-xs text-fg-subtle">Sends</span>
          <span className="min-w-0 truncate font-mono text-xs text-fg-muted">{computed}</span>
        </div>
      )}
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Secret: hidden by default, with a show/hide toggle. */
  password?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="font-display text-xs text-fg-subtle">{label}</label>
      <div className="relative">
        <input
          type={password && !shown ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className={cn(
            'h-8 w-full min-w-0 rounded-md border border-edge-1 bg-scrim-1 px-2.5 font-mono text-sm text-fg-base outline-none transition-colors focus:border-accent/40',
            password && 'pr-8',
          )}
          spellCheck={false}
          autoComplete="off"
        />
        {password && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
            aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            title={shown ? 'Hide' : 'Show'}
          >
            {shown ? <EyeOff size={12} strokeWidth={2} /> : <Eye size={12} strokeWidth={2} />}
          </button>
        )}
      </div>
    </div>
  );
}

/** `••••` plus the last four characters, so a user can tell tokens apart
 *  without the value being readable. Short secrets show no tail at all. */
function maskSecret(secret: string): string {
  return secret.length > 8 ? `••••${secret.slice(-4)}` : '••••';
}

// ─── Response viewer ─────────────────────────────────────────────────────

function ResponseViewer({
  draft,
  responseTab,
  onResponseTab,
  onSample,
}: {
  draft: RequestDraft;
  responseTab: ResponseTab;
  onResponseTab: (t: ResponseTab) => void;
  onSample: () => void;
}) {
  const resp = draft.response;
  const tabs: { id: ResponseTab; label: string }[] = [
    { id: 'pretty', label: 'Pretty' },
    { id: 'raw', label: 'Raw' },
    { id: 'headers', label: 'Headers' },
    { id: 'preview', label: 'Preview' },
  ];

  if (draft.error) {
    return (
      <div className="flex min-h-0 flex-1 justify-center bg-bg-base p-6">
        <ErrorNote error={draft.error} className="h-fit w-full max-w-lg" />
      </div>
    );
  }

  if (!resp) {
    return (
      <div className="flex min-h-0 flex-1 bg-bg-base">
        <EmptyState
          icon={Send}
          title="No response yet"
          body={`Enter a URL above, then press Send (${MOD_ENTER}).`}
        >
          <Button icon={Sparkles} onClick={onSample} disabled={draft.pending}>
            Send a sample request
          </Button>
        </EmptyState>
      </div>
    );
  }

  const contentType =
    resp.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const isJson = contentType.includes('json');
  const isHtml = contentType.includes('html');
  const isImage = contentType.startsWith('image/');
  const pretty = isJson && resp.body_text ? tryPrettyJson(resp.body_text).text : resp.body_text ?? '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Status strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-bg-chrome px-3 py-2">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-xs font-semibold',
            statusTone(resp.status),
          )}
        >
          {resp.status} {resp.status_text}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs text-fg-subtle">{resp.time_ms} ms</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs text-fg-subtle">
          {formatSize(resp.size_bytes)}
        </span>
        {resp.truncated && (
          <span
            className="shrink-0 rounded-sm bg-status-warn/15 px-1.5 py-0.5 font-display text-2xs text-status-warn"
            title="The response was too large to show in full."
          >
            Cut short
          </span>
        )}
        {draft.setVars?.map((v) => (
          <span
            key={v.variable}
            className={cn(
              'max-w-[200px] truncate rounded-sm px-1.5 py-0.5 font-mono text-2xs',
              v.error ? 'bg-status-err/15 text-status-err' : 'bg-status-ok/15 text-status-ok',
            )}
            title={v.error ? `${v.variable} not set: ${v.error}` : `${v.variable} = ${v.value}`}
          >
            {v.error ? `${v.variable} ✕` : `${v.variable} ← ${v.value}`}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onResponseTab(t.id)}
              className={cn(
                'shrink-0 rounded-sm px-2 py-1 font-display text-xs tracking-tight transition-colors',
                responseTab === t.id
                  ? 'bg-surface-2 text-fg-base'
                  : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {responseTab === 'pretty' && (
          <pre className="m-0 p-3 font-mono text-sm leading-relaxed text-fg-base">
            {pretty}
          </pre>
        )}
        {responseTab === 'raw' && (
          <pre className="m-0 whitespace-pre-wrap break-all p-3 font-mono text-sm text-fg-base">
            {resp.body_text ?? '[binary body — view as Preview]'}
          </pre>
        )}
        {responseTab === 'headers' && (
          <table className="w-full border-collapse text-left font-mono text-sm">
            <tbody>
              {resp.headers.map((h, i) => (
                <tr key={`${h.name}-${i}`} className="border-b border-edge-1">
                  <td className="px-3 py-1.5 align-top text-fg-subtle">{h.name}</td>
                  <td className="break-all px-3 py-1.5 text-fg-base">{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {responseTab === 'preview' && (
          <div className="h-full">
            {isHtml && resp.body_text ? (
              <iframe
                title="response preview"
                srcDoc={resp.body_text}
                sandbox=""
                className="h-full w-full bg-white"
              />
            ) : isImage ? (
              <div className="flex h-full items-center justify-center p-4">
                <img
                  alt="response preview"
                  src={`data:${contentType};base64,${resp.body_base64}`}
                  className="max-h-full max-w-full"
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center font-display text-xs text-fg-subtle">
                No preview available for {contentType || 'this content type'}.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Left rail ───────────────────────────────────────────────────────────

function LeftRail({
  overlay,
  sessionId,
  collections,
  savedRequests,
  history,
  envs,
  vars: _vars,
  onOpenSaved,
  onLoadHistory,
  onRefresh,
  onCollapse,
}: {
  sessionId: string | null;
  collections: ApiCollection[];
  savedRequests: ApiSavedRequest[];
  history: ApiHistoryEntry[];
  envs: ApiEnvironment[];
  vars: Record<string, string>;
  onOpenSaved: (r: ApiSavedRequest) => void;
  onLoadHistory: (h: ApiHistoryEntry) => void;
  onRefresh: () => void;
  onCollapse: () => void;
  /** Narrow pane: float over the builder instead of taking width. */
  overlay?: boolean;
}) {
  const [collectionsOpen, setCollectionsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [envsOpen, setEnvsOpen] = useState(false);
  const [editingEnvId, setEditingEnvId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const byCollection = new Map<string | null, ApiSavedRequest[]>();
    for (const r of savedRequests) {
      const k = r.collection_id ?? null;
      const arr = byCollection.get(k) ?? [];
      arr.push(r);
      byCollection.set(k, arr);
    }
    return byCollection;
  }, [savedRequests]);

  const createCollection = async () => {
    if (!sessionId) return;
    const name = await askText('New collection', { label: 'Name', placeholder: 'e.g. Billing API' }, 'Create');
    if (!name) return;
    await apiclientUpsertCollection(sessionId, { name, position: collections.length });
    onRefresh();
  };

  const openApiInputRef = useRef<HTMLInputElement>(null);

  /** OpenAPI 3.x (JSON or YAML) → a new collection with one saved request per operation. */
  const importOpenApi = async (file: File) => {
    if (!sessionId) return;
    try {
      const spec = parseOpenApi(await file.text());
      const collection = await apiclientUpsertCollection(sessionId, {
        name: spec.name,
        position: collections.length,
      });
      for (const [i, r] of spec.requests.entries()) {
        const d = emptyDraft(r.name);
        d.method = r.method as Method;
        d.url = r.url;
        // Parameters without an example start disabled rather than sending `q=`.
        d.params = r.params.map((p) => ({ ...newKV(), ...p, enabled: p.value !== '' }));
        d.headers = r.headers.map((h) => ({ ...newKV(), ...h, enabled: h.value !== '' }));
        if (r.body !== null) {
          d.bodyMode = 'json';
          d.bodyText = r.body;
        }
        await apiclientUpsertRequest(sessionId, draftToSavedInput(d, r.name, collection.id, i));
      }
    } catch (err) {
      toastError(`Couldn't import OpenAPI: ${err instanceof Error ? err.message : String(err)}`);
    }
    onRefresh();
  };

  const removeCollection = async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this collection?',
      body: 'The requests saved inside it become drafts.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await apiclientDeleteCollection(id);
    onRefresh();
  };

  const removeRequest = async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this saved request?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await apiclientDeleteRequest(id);
    onRefresh();
  };

  const createEnv = async () => {
    if (!sessionId) return;
    const name = await askText('New environment', { label: 'Name', placeholder: 'e.g. Staging' }, 'Create');
    if (!name) return;
    const env = await apiclientEnvsUpsert(sessionId, { name, varsJson: '{}' });
    setEditingEnvId(env.id);
    onRefresh();
  };

  const setActiveEnv = async (id: string | null) => {
    if (!sessionId) return;
    await apiclientEnvsSetActive(sessionId, id);
    onRefresh();
  };

  const deleteEnv = async (id: string) => {
    const ok = await askConfirm({
      title: 'Delete this environment?',
      body: 'Requests using its variables fall back to unset values.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await apiclientEnvsDelete(id);
    setEditingEnvId(null);
    onRefresh();
  };

  const clearHistory = async () => {
    if (!sessionId) return;
    const ok = await askConfirm({
      title: 'Clear all history for this workspace?',
      body: 'Past responses are removed. Saved requests are untouched.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    await apiclientClearHistory(sessionId);
    onRefresh();
  };

  return (
    <div
      className={cn(
        'flex w-64 shrink-0 flex-col bg-bg-chrome',
        overlay && 'absolute inset-y-0 left-0 z-30 shadow-sheet',
      )}
    >
      <div className="flex h-9 items-center justify-between px-2.5">
        <span className="font-display text-xs font-medium text-fg-muted">Requests</span>
        <button
          onClick={onCollapse}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
          title="Hide requests"
          aria-label="Hide requests"
        >
          <ChevronDown size={11} strokeWidth={2} className="-rotate-90" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Collections */}
        <Section
          icon={<Folder size={11} strokeWidth={2} />}
          title="Collections"
          open={collectionsOpen}
          onToggle={() => setCollectionsOpen((o) => !o)}
          actions={
            <>
              <input
                ref={openApiInputRef}
                type="file"
                accept=".json,.yaml,.yml,application/json,application/yaml"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importOpenApi(file);
                }}
              />
              <button
                onClick={() => openApiInputRef.current?.click()}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
                title="Import OpenAPI 3.x (JSON or YAML)"
                aria-label="Import OpenAPI"
              >
                <FileJson size={11} strokeWidth={2} />
              </button>
              <button
                onClick={createCollection}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
                title="New collection"
                aria-label="New collection"
              >
                <Plus size={11} strokeWidth={2.2} />
              </button>
            </>
          }
        >
          {collectionsOpen && (
            <div className="pb-1">
              {collections.length === 0 && (grouped.get(null) ?? []).length === 0 && (
                <div className="px-3 py-2 font-display text-xs text-fg-subtle/80">
                  No saved requests yet.
                </div>
              )}
              {collections.map((c) => {
                const inside = grouped.get(c.id) ?? [];
                return (
                  <CollectionRow
                    key={c.id}
                    name={c.name}
                    requests={inside}
                    onOpen={onOpenSaved}
                    onDelete={() => removeCollection(c.id)}
                    onDeleteRequest={removeRequest}
                  />
                );
              })}
              {(grouped.get(null) ?? []).map((r) => (
                <SavedRequestRow
                  key={r.id}
                  request={r}
                  onOpen={() => onOpenSaved(r)}
                  onDelete={() => removeRequest(r.id)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* History */}
        <Section
          icon={<HistoryIcon size={11} strokeWidth={2} />}
          title="History"
          open={historyOpen}
          onToggle={() => setHistoryOpen((o) => !o)}
          actions={
            history.length > 0 && (
              <button
                onClick={clearHistory}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-status-err"
                title="Clear history"
                aria-label="Clear history"
              >
                <Trash2 size={11} strokeWidth={2} />
              </button>
            )
          }
        >
          {historyOpen && (
            <div className="pb-1">
              {history.length === 0 && (
                <div className="px-3 py-2 font-display text-xs text-fg-subtle/80">
                  No requests yet.
                </div>
              )}
              {history.map((h) => (
                <HistoryRow key={h.id} entry={h} onClick={() => onLoadHistory(h)} />
              ))}
            </div>
          )}
        </Section>

        {/* Environments */}
        <Section
          icon={<Settings2 size={11} strokeWidth={2} />}
          title="Environments"
          open={envsOpen}
          onToggle={() => setEnvsOpen((o) => !o)}
          actions={
            <button
              onClick={createEnv}
              className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
              title="New environment"
              aria-label="New environment"
            >
              <Plus size={11} strokeWidth={2.2} />
            </button>
          }
        >
          {envsOpen && (
            <div className="pb-1">
              {envs.length === 0 && (
                <div className="px-3 py-2 font-display text-xs text-fg-subtle/80">
                  No environments. Add one to reuse values like {'{{baseUrl}}'}.
                </div>
              )}
              {envs.map((e) => (
                <EnvRow
                  key={e.id}
                  env={e}
                  editing={editingEnvId === e.id}
                  onActivate={() => setActiveEnv(e.is_active ? null : e.id)}
                  onEdit={() => setEditingEnvId(e.id === editingEnvId ? null : e.id)}
                  onSave={async (name, vars_json) => {
                    if (!sessionId) return;
                    await apiclientEnvsUpsert(sessionId, { id: e.id, name, varsJson: vars_json });
                    setEditingEnvId(null);
                    onRefresh();
                  }}
                  onDelete={() => deleteEnv(e.id)}
                />
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex h-7 items-center gap-1 px-2">
        <button
          onClick={onToggle}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:text-fg-base"
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronRight
            size={10}
            strokeWidth={2.4}
            className={cn('transition-transform', open && 'rotate-90')}
          />
        </button>
        <span className="text-fg-subtle">{icon}</span>
        <span className="ml-0.5 flex-1 font-display text-xs text-fg-subtle">
          {title}
        </span>
        {actions}
      </div>
      {children}
    </div>
  );
}

function CollectionRow({
  name,
  requests,
  onOpen,
  onDelete,
  onDeleteRequest,
}: {
  name: string;
  requests: ApiSavedRequest[];
  onOpen: (r: ApiSavedRequest) => void;
  onDelete: () => void;
  onDeleteRequest: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-surface-1">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle hover:text-fg-base"
        >
          <ChevronRight
            size={9}
            strokeWidth={2.4}
            className={cn('transition-transform', open && 'rotate-90')}
          />
        </button>
        <Folder size={10} strokeWidth={2} className="text-fg-subtle" />
        <span className="flex-1 truncate font-display text-xs text-fg-base/90">{name}</span>
        <button
          onClick={onDelete}
          className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 hover:text-status-err group-hover:opacity-100"
          title="Delete collection"
          aria-label="Delete collection"
        >
          <Trash2 size={10} strokeWidth={2} />
        </button>
      </div>
      {open &&
        requests.map((r) => (
          <SavedRequestRow
            key={r.id}
            request={r}
            indent
            onOpen={() => onOpen(r)}
            onDelete={() => onDeleteRequest(r.id)}
          />
        ))}
    </div>
  );
}

function SavedRequestRow({
  request,
  indent,
  onOpen,
  onDelete,
}: {
  request: ApiSavedRequest;
  indent?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-2 py-1 pr-2 hover:bg-surface-1',
        indent ? 'pl-7' : 'pl-3',
      )}
    >
      <span
        className={cn(
          'shrink-0 font-mono text-2xs font-semibold',
          methodColour(request.method),
        )}
      >
        {request.method}
      </span>
      <button
        onClick={onOpen}
        className="flex-1 truncate text-left font-display text-xs text-fg-base/85 hover:text-fg-base"
        title={request.url}
      >
        {request.name || request.url}
      </button>
      <button
        onClick={onDelete}
        className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 hover:text-status-err group-hover:opacity-100"
        title="Delete request"
        aria-label="Delete request"
      >
        <Trash2 size={9} strokeWidth={2} />
      </button>
    </div>
  );
}

function HistoryRow({
  entry,
  onClick,
}: {
  entry: ApiHistoryEntry;
  onClick: () => void;
}) {
  const time = useMemo(() => {
    const d = new Date(entry.executed_at);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [entry.executed_at]);
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-surface-1"
      title={entry.url}
    >
      <span className="shrink-0 font-mono text-2xs text-fg-subtle/70">{time}</span>
      <span
        className={cn(
          'shrink-0 font-mono text-2xs font-semibold',
          methodColour(entry.method),
        )}
      >
        {entry.method}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-base/80">{entry.url}</span>
      {entry.status != null && (
        <span
          className={cn('shrink-0 rounded-sm px-1 font-mono text-2xs', statusText(entry.status))}
        >
          {entry.status}
        </span>
      )}
      {entry.error && (
        <span className="shrink-0 rounded-sm px-1 font-display text-2xs text-status-err">Failed</span>
      )}
    </button>
  );
}

function EnvRow({
  env,
  editing,
  onActivate,
  onEdit,
  onSave,
  onDelete,
}: {
  env: ApiEnvironment;
  editing: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onSave: (name: string, varsJson: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(env.name);
  const [varsRaw, setVarsRaw] = useState(() => {
    try {
      const obj = JSON.parse(env.vars_json) as Record<string, string>;
      return Object.entries(obj)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    } catch {
      return '';
    }
  });

  if (!editing) {
    return (
      <div className="group flex items-center gap-2 px-3 py-1 hover:bg-surface-1">
        <button
          onClick={onActivate}
          className={cn(
            'h-2 w-2 shrink-0 rounded-full border transition-colors',
            env.is_active
              ? 'border-status-ok bg-status-ok'
              : 'border-fg-subtle/40 hover:border-fg-subtle',
          )}
          aria-label={env.is_active ? 'Deactivate' : 'Activate'}
          title={env.is_active ? 'Active (click to deactivate)' : 'Activate'}
        />
        <button
          onClick={onEdit}
          className="flex-1 truncate text-left font-display text-xs text-fg-base/85 hover:text-fg-base"
        >
          {env.name}
        </button>
        <button
          onClick={onDelete}
          className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 hover:text-status-err group-hover:opacity-100"
          title="Delete environment"
          aria-label="Delete environment"
        >
          <Trash2 size={10} strokeWidth={2} />
        </button>
      </div>
    );
  }

  const save = () => {
    const obj: Record<string, string> = {};
    for (const line of varsRaw.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      if (!k) continue;
      obj[k] = v;
    }
    void onSave(name.trim() || env.name, JSON.stringify(obj));
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 rounded-md border border-edge-1 bg-scrim-1 px-2 font-display text-xs text-fg-base outline-none focus:border-accent/40"
        placeholder="Environment name"
      />
      <textarea
        value={varsRaw}
        onChange={(e) => setVarsRaw(e.target.value)}
        rows={4}
        placeholder={'base_url=https://api.example.com\ntoken=abc'}
        className="resize-y rounded-md border border-edge-1 bg-scrim-1 p-2 font-mono text-xs text-fg-base outline-none focus:border-accent/40"
        spellCheck={false}
      />
      <div className="flex justify-end gap-1">
        <Button variant="primary" size="sm" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ─── Adapters ────────────────────────────────────────────────────────────

function savedToDraft(saved: ApiSavedRequest): RequestDraft {
  let params: KV[] = [];
  let headers: KV[] = [];
  let bodyMode: BodyMode = 'none';
  let bodyText = '';
  let graphqlVariables = '';
  let formBody: KV[] = [];
  let multipartBody: KV[] = [];
  let postVars: PostVarRule[] = [];
  let auth = emptyAuth();
  try {
    if (saved.params_json) params = JSON.parse(saved.params_json) as KV[];
  } catch {
    /* ignore */
  }
  try {
    if (saved.headers_json) headers = JSON.parse(saved.headers_json) as KV[];
  } catch {
    /* ignore */
  }
  try {
    if (saved.body_json) {
      const b = JSON.parse(saved.body_json) as {
        bodyMode: BodyMode;
        bodyText: string;
        graphqlVariables?: string;
        formBody: KV[];
        multipartBody: KV[];
        postVars?: PostVarRule[];
      };
      bodyMode = b.bodyMode ?? 'none';
      bodyText = b.bodyText ?? '';
      graphqlVariables = b.graphqlVariables ?? '';
      formBody = b.formBody ?? [];
      multipartBody = b.multipartBody ?? [];
      postVars = b.postVars ?? [];
    }
  } catch {
    /* ignore */
  }
  try {
    if (saved.auth_json) auth = { ...emptyAuth(), ...(JSON.parse(saved.auth_json) as AuthState) };
  } catch {
    /* ignore */
  }
  return {
    localId: newLocalId(),
    savedId: saved.id,
    name: saved.name,
    method: (saved.method as Method) ?? 'GET',
    url: saved.url,
    params,
    headers,
    bodyMode,
    bodyText,
    graphqlVariables,
    formBody,
    multipartBody,
    auth,
    postVars,
  };
}
