import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  History as HistoryIcon,
  Plus,
  Save,
  Send,
  Settings2,
  Trash2,
  X,
  Globe,
  Sparkles,
} from 'lucide-react';
import { cn } from '../lib/cn';
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
  httpRequest,
  type ApiCollection,
  type ApiEnvironment,
  type ApiHistoryEntry,
  type ApiSavedRequest,
  type HttpBodyDto,
  type HttpHeaderKV,
  type HttpRequestDto,
  type HttpResponseDto,
} from '../lib/tauri';

interface Props {
  tabId: string;
}

// ─── Method palette ──────────────────────────────────────────────────────

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type Method = (typeof METHODS)[number];

/** Method → text colour token. Kept restrained so the UI stays close to
 *  ARC's muted palette; only the method label itself wears colour. */
function methodColour(m: string): string {
  switch (m.toUpperCase()) {
    case 'GET':
      return 'text-sky-300';
    case 'POST':
      return 'text-emerald-300';
    case 'PUT':
      return 'text-amber-300';
    case 'PATCH':
      return 'text-purple-300';
    case 'DELETE':
      return 'text-rose-300';
    default:
      return 'text-fg-subtle';
  }
}

// ─── Per-tab state shape (serialized to apiClientState JSON) ─────────────

type BodyMode = 'none' | 'json' | 'xml' | 'text' | 'form' | 'multipart';

type AuthMode = 'none' | 'bearer' | 'basic' | 'apikey';

interface KV {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
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
  bodyText: string;
  formBody: KV[];
  multipartBody: KV[];
  auth: AuthState;
  /** True while a Send is in flight. Transient — not persisted. */
  pending?: boolean;
  /** Last response received in this sub-tab. Transient — not persisted. */
  response?: HttpResponseDto;
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

type BuilderTab = 'params' | 'headers' | 'body' | 'auth';
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
    drafts: state.drafts.map(({ pending: _p, response: _r, error: _e, ...rest }) => rest),
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
}: {
  rows: KV[];
  onChange: (next: KV[]) => void;
  nameSuggestions?: string[];
  placeholder?: { name?: string; value?: string };
}) {
  const update = (id: string, patch: Partial<KV>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));
  const append = () => onChange([...rows, newKV()]);

  return (
    <div className="overflow-hidden rounded-md border border-white/[0.05]">
      <div className="grid grid-cols-[20px_1fr_1fr_24px] items-center gap-2 border-b border-white/[0.04] bg-black/[0.18] px-2 py-1.5 font-display text-[10.5px] uppercase tracking-wider text-fg-subtle/70">
        <span />
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {rows.length === 0 && (
        <div className="px-3 py-3 font-display text-[11.5px] text-fg-subtle/80">
          No rows yet. Click "+ Add row" below.
        </div>
      )}
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid grid-cols-[20px_1fr_1fr_24px] items-center gap-2 border-b border-white/[0.03] px-2 py-1.5 last:border-b-0 hover:bg-white/[0.02]"
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
            className="bg-transparent font-mono text-[12px] text-fg-base outline-none placeholder:text-fg-subtle/50"
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
            placeholder={placeholder?.value ?? 'value'}
            className="bg-transparent font-mono text-[12px] text-fg-base outline-none placeholder:text-fg-subtle/50"
          />
          <button
            onClick={() => remove(row.id)}
            className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle/70 transition-colors hover:bg-white/[0.06] hover:text-rose-300"
            aria-label="Remove row"
            title="Remove row"
          >
            <X size={11} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button
        onClick={append}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-display text-[11px] text-fg-subtle transition-colors hover:bg-white/[0.04] hover:text-fg-base"
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
  if (status >= 500) return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  if (status >= 400) return 'bg-rose-400/10 text-rose-200 border-rose-400/25';
  if (status >= 300) return 'bg-amber-400/10 text-amber-200 border-amber-400/25';
  if (status >= 200) return 'bg-emerald-400/10 text-emerald-200 border-emerald-400/25';
  return 'bg-white/[0.06] text-fg-base border-white/[0.08]';
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

  // ─── Send action ──────────────────────────────────────────────────────

  const send = useCallback(
    async (draft: RequestDraft) => {
      if (!draft.url.trim()) return;

      // Compose the wire request applying env interpolation everywhere.
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
          body = { kind: 'multipart', entries: interpolateKV(draft.multipartBody, vars) };
          break;
        default:
          body = { kind: 'none' };
      }

      const req: HttpRequestDto = {
        method: draft.method,
        url,
        headers,
        body,
      };

      updateDraft(draft.localId, { pending: true, error: undefined });
      try {
        const response = await httpRequest(req);
        updateDraft(draft.localId, { pending: false, response, error: undefined });
        if (sessionId) {
          try {
            await apiclientAppendHistory(sessionId, {
              method: draft.method,
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
              method: draft.method,
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
    [sessionId, updateDraft, vars],
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
      const proposed = window.prompt('Save request as:', active.url || 'My request');
      if (!proposed) return;
      name = proposed.trim() || 'Untitled request';
    }
    const upserted = await apiclientUpsertRequest(sessionId, {
      id: active.savedId ?? undefined,
      collection_id: collectionId ?? null,
      name,
      method: active.method,
      url: active.url,
      params_json: JSON.stringify(active.params),
      headers_json: JSON.stringify(active.headers),
      body_json: JSON.stringify({
        bodyMode: active.bodyMode,
        bodyText: active.bodyText,
        formBody: active.formBody,
        multipartBody: active.multipartBody,
      }),
      auth_json: JSON.stringify(active.auth),
      position: 0,
    });
    updateDraft(active.localId, { savedId: upserted.id, dirty: false, name });
    void refreshAll();
  };

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full w-full flex-col bg-base">
      {/* Sub-tab strip */}
      <SubTabStrip
        drafts={state.drafts}
        activeId={state.activeLocalId}
        onSelect={(id) => setState((s) => ({ ...s, activeLocalId: id }))}
        onClose={closeSubTab}
        onNew={newSubTab}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        {!state.leftRailCollapsed && (
          <LeftRail
            sessionId={sessionId}
            collections={collections}
            savedRequests={savedRequests}
            history={history}
            envs={envs}
            vars={vars}
            onOpenSaved={openSavedRequest}
            onRefresh={refreshAll}
            onCollapse={() =>
              setState((s) => ({ ...s, leftRailCollapsed: true }))
            }
            onLoadHistory={(h) => {
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
            }}
          />
        )}
        {state.leftRailCollapsed && (
          <button
            onClick={() => setState((s) => ({ ...s, leftRailCollapsed: false }))}
            className="flex w-7 shrink-0 items-center justify-center border-r border-border-hairline bg-base/40 text-fg-subtle transition-colors hover:bg-white/[0.04] hover:text-fg-base"
            title="Show panel"
            aria-label="Show panel"
          >
            <ChevronRight size={13} strokeWidth={2} />
          </button>
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
          />
          <ResponseViewer
            draft={active}
            responseTab={state.responseTab}
            onResponseTab={(t) => setState((s) => ({ ...s, responseTab: t }))}
            onSample={() =>
              updateDraft(active.localId, {
                url: 'https://httpbin.org/get',
                method: 'GET',
              })
            }
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
}: {
  drafts: RequestDraft[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-hairline bg-base/60 px-2">
      {drafts.map((d) => {
        const active = d.localId === activeId;
        const label = d.name && d.name !== 'Untitled request' ? d.name : d.url || 'Untitled';
        return (
          <button
            key={d.localId}
            onClick={() => onSelect(d.localId)}
            className={cn(
              'group flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 font-display text-[11.5px] transition-colors',
              active
                ? 'bg-white/[0.07] text-fg-base'
                : 'text-fg-subtle hover:bg-white/[0.04] hover:text-fg-muted',
            )}
            title={label}
          >
            <span
              className={cn(
                'font-mono text-[10px] font-semibold tracking-tight',
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
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle/60 opacity-0 transition-all hover:bg-white/[0.08] hover:text-fg-base group-hover:opacity-100"
              aria-label="Close request"
            >
              <X size={10} strokeWidth={2.2} />
            </span>
          </button>
        );
      })}
      <button
        onClick={onNew}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base"
        title="New request"
        aria-label="New request"
      >
        <Plus size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}

// ─── Request builder ─────────────────────────────────────────────────────

function RequestBuilder({
  draft,
  builderTab,
  onBuilderTab,
  vars,
  onChange,
  onSend,
  onSave,
}: {
  draft: RequestDraft;
  builderTab: BuilderTab;
  onBuilderTab: (t: BuilderTab) => void;
  vars: Record<string, string>;
  onChange: (patch: Partial<RequestDraft>) => void;
  onSend: () => void;
  onSave: () => void;
}) {
  const [methodOpen, setMethodOpen] = useState(false);
  const methodRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex shrink-0 flex-col border-b border-border-hairline">
      {/* Method + URL + Send */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative">
          <button
            ref={methodRef}
            onClick={() => setMethodOpen((o) => !o)}
            className={cn(
              'flex h-8 items-center gap-1 rounded-md border border-white/[0.06] bg-black/[0.18] px-2.5 font-mono text-[11.5px] font-semibold tracking-tight transition-colors hover:bg-black/[0.24]',
              methodColour(draft.method),
            )}
          >
            {draft.method}
            <ChevronDown size={10} strokeWidth={2} className="text-fg-subtle" />
          </button>
          {methodOpen && (
            <div
              className="material-sheet absolute left-0 top-9 z-20 w-32 overflow-hidden rounded-md shadow-sheet ring-1 ring-white/10"
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
                    'flex w-full items-center px-3 py-1.5 text-left font-mono text-[11px] font-semibold transition-colors hover:bg-white/[0.06]',
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
          vars={vars}
        />

        <button
          onClick={onSend}
          disabled={draft.pending || !draft.url.trim()}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 font-display text-[11.5px] font-medium tracking-tight transition-all duration-150 ease-apple',
            'bg-accent/85 text-fg-base shadow-focus hover:bg-accent disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-fg-subtle/50 disabled:shadow-none',
          )}
          title="Send (⌘↵)"
        >
          {draft.pending ? (
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-r-transparent" />
          ) : (
            <Send size={11} strokeWidth={2.2} />
          )}
          {draft.pending ? 'Sending' : 'Send'}
        </button>

        <button
          onClick={onSave}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          title="Save request"
          aria-label="Save request"
        >
          <Save size={12} strokeWidth={2} />
        </button>
      </div>

      {/* Builder sub-tab strip */}
      <div className="flex items-center gap-0 border-t border-white/[0.04] px-3">
        {(['params', 'headers', 'body', 'auth'] as BuilderTab[]).map((t) => {
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
                  : draft.auth.mode === 'none'
                    ? 0
                    : 1;
          return (
            <button
              key={t}
              onClick={() => onBuilderTab(t)}
              className={cn(
                'relative flex items-center gap-1.5 px-3 py-2 font-display text-[11.5px] capitalize tracking-tight transition-colors',
                active ? 'text-fg-base' : 'text-fg-subtle hover:text-fg-muted',
              )}
            >
              {t}
              {count > 0 && (
                <span className="rounded-sm bg-white/[0.08] px-1 font-mono text-[9px] text-fg-base/80">
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

      <div className="max-h-[42vh] overflow-y-auto border-t border-border-hairline bg-base/40 p-3">
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
            onMode={(m) => onChange({ bodyMode: m })}
            onText={(text) => onChange({ bodyText: text })}
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
      </div>
    </div>
  );
}

// ─── URL input (with inline {{var}} resolution preview) ─────────────────

function UrlInput({
  value,
  onChange,
  onSubmit,
  vars,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  vars: Record<string, string>;
}) {
  // Compute the interpolation preview only for the tooltip; we don't render
  // chip-pill substitution inside the contenteditable because that would
  // require a full input-editor rebuild. The hover-preview is the v1 affordance.
  const resolved = useMemo(() => interpolate(value, vars), [value, vars]);
  const hasVars = VAR_PATTERN.test(value);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/[0.22] px-2.5 transition-colors focus-within:border-accent/40 focus-within:shadow-focus">
      <Globe size={11} strokeWidth={2} className="shrink-0 text-fg-subtle" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="https://api.example.com/v1/{{resource}}"
        className="min-w-0 flex-1 bg-transparent py-1.5 font-mono text-[12px] text-fg-base outline-none placeholder:text-fg-subtle/50"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      {hasVars && (
        <span
          className="shrink-0 rounded-sm bg-white/[0.06] px-1 py-0.5 font-mono text-[9.5px] text-fg-subtle"
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
  onMode,
  onText,
  onForm,
  onMultipart,
}: {
  mode: BodyMode;
  text: string;
  form: KV[];
  multipart: KV[];
  onMode: (m: BodyMode) => void;
  onText: (s: string) => void;
  onForm: (rows: KV[]) => void;
  onMultipart: (rows: KV[]) => void;
}) {
  const radios: { id: BodyMode; label: string }[] = [
    { id: 'none', label: 'none' },
    { id: 'json', label: 'JSON' },
    { id: 'xml', label: 'XML' },
    { id: 'text', label: 'Text' },
    { id: 'form', label: 'form-urlencoded' },
    { id: 'multipart', label: 'multipart' },
  ];
  const isText = mode === 'json' || mode === 'xml' || mode === 'text';

  const prettifyJson = () => {
    const { ok, text: out } = tryPrettyJson(text);
    if (ok) onText(out);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {radios.map((r) => (
          <button
            key={r.id}
            onClick={() => onMode(r.id)}
            className={cn(
              'rounded-sm px-2 py-1 font-display text-[11px] tracking-tight transition-colors',
              mode === r.id
                ? 'bg-accent/20 text-fg-base'
                : 'text-fg-subtle hover:bg-white/[0.04] hover:text-fg-muted',
            )}
          >
            {r.label}
          </button>
        ))}
        {mode === 'json' && (
          <button
            onClick={prettifyJson}
            className="ml-auto flex items-center gap-1 rounded-sm px-2 py-1 font-display text-[11px] text-fg-subtle transition-colors hover:bg-white/[0.04] hover:text-fg-base"
            title="Format JSON"
          >
            <Sparkles size={10} strokeWidth={2} />
            Beautify
          </button>
        )}
      </div>
      {mode === 'none' && (
        <div className="rounded-md border border-dashed border-white/[0.06] p-4 text-center font-display text-[11.5px] text-fg-subtle/80">
          No body for this request.
        </div>
      )}
      {isText && (
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          placeholder={mode === 'json' ? '{ "key": "value" }' : 'request body'}
          className="min-h-[180px] w-full resize-y rounded-md border border-white/[0.05] bg-black/[0.22] p-2.5 font-mono text-[12px] leading-relaxed text-fg-base outline-none transition-colors focus:border-accent/40"
          spellCheck={false}
        />
      )}
      {mode === 'form' && (
        <KvTable rows={form} onChange={onForm} placeholder={{ name: 'field', value: 'value' }} />
      )}
      {mode === 'multipart' && (
        <KvTable
          rows={multipart}
          onChange={onMultipart}
          placeholder={{ name: 'field', value: 'value (text only — v1)' }}
        />
      )}
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

  const computed = useMemo(() => {
    if (auth.mode === 'bearer' && auth.token) {
      return `Authorization: Bearer ${auth.token}`;
    }
    if (auth.mode === 'basic') {
      const enc = btoa(`${auth.username}:${auth.password}`);
      return `Authorization: Basic ${enc}`;
    }
    if (auth.mode === 'apikey' && auth.apiKeyName && auth.apiKeyValue) {
      return auth.apiKeyIn === 'header'
        ? `${auth.apiKeyName}: ${auth.apiKeyValue}  (header)`
        : `?${auth.apiKeyName}=${auth.apiKeyValue}  (query)`;
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
              'rounded-sm px-2 py-1 font-display text-[11px] tracking-tight transition-colors',
              auth.mode === m.id
                ? 'bg-accent/20 text-fg-base'
                : 'text-fg-subtle hover:bg-white/[0.04] hover:text-fg-muted',
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
        />
      )}
      {auth.mode === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
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
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
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
          />
          <div className="flex flex-col gap-1">
            <label className="font-display text-[10px] uppercase tracking-wider text-fg-subtle/70">
              Add to
            </label>
            <select
              value={auth.apiKeyIn}
              onChange={(e) => onChange({ ...auth, apiKeyIn: e.target.value as 'header' | 'query' })}
              className="h-8 rounded-md border border-white/[0.06] bg-black/[0.22] px-2 font-display text-[11.5px] text-fg-base outline-none focus:border-accent/40"
            >
              <option value="header">Header</option>
              <option value="query">Query</option>
            </select>
          </div>
        </div>
      )}

      {computed && (
        <div className="rounded-md border border-white/[0.04] bg-black/[0.18] px-3 py-2 font-mono text-[11px] text-fg-subtle">
          <span className="font-display text-[10px] uppercase tracking-wider text-fg-subtle/70">
            Computed&nbsp;
          </span>
          <span className="text-fg-muted">{computed}</span>
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
  password?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="font-display text-[10px] uppercase tracking-wider text-fg-subtle/70">
        {label}
      </label>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 rounded-md border border-white/[0.06] bg-black/[0.22] px-2.5 font-mono text-[12px] text-fg-base outline-none transition-colors focus:border-accent/40 focus:shadow-focus"
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
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
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-base p-6 text-center">
        <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 font-mono text-[12px] text-rose-200">
          {draft.error}
        </div>
        <div className="font-display text-[11px] text-fg-subtle">
          Check the URL, the network, or any CORS-free origin restrictions.
        </div>
      </div>
    );
  }

  if (!resp) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-base p-6 text-center">
        <Send size={28} strokeWidth={1.5} className="text-fg-subtle/50" />
        <div className="font-display text-[12px] text-fg-muted">
          Hit{' '}
          <kbd className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg-base">
            ⌘↵
          </kbd>{' '}
          to send.
        </div>
        <button
          onClick={onSample}
          className="flex items-center gap-1 rounded-md border border-white/[0.06] px-2.5 py-1 font-display text-[11px] text-fg-subtle transition-colors hover:bg-white/[0.04] hover:text-fg-base"
        >
          <Sparkles size={11} strokeWidth={2} />
          Try a sample request
        </button>
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
      <div className="flex shrink-0 items-center gap-2 border-b border-border-hairline bg-base/60 px-3 py-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold',
            statusTone(resp.status),
          )}
        >
          {resp.status} {resp.status_text}
        </span>
        <span className="font-mono text-[11px] text-fg-subtle">{resp.time_ms} ms</span>
        <span className="font-mono text-[11px] text-fg-subtle">{formatSize(resp.size_bytes)}</span>
        {resp.truncated && (
          <span className="rounded-sm bg-amber-400/10 px-1.5 py-0.5 font-display text-[10px] text-amber-200">
            truncated
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onResponseTab(t.id)}
              className={cn(
                'rounded-sm px-2 py-1 font-display text-[11px] tracking-tight transition-colors',
                responseTab === t.id
                  ? 'bg-white/[0.08] text-fg-base'
                  : 'text-fg-subtle hover:bg-white/[0.04] hover:text-fg-muted',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {responseTab === 'pretty' && (
          <pre className="m-0 p-3 font-mono text-[12px] leading-relaxed text-fg-base">
            {pretty}
          </pre>
        )}
        {responseTab === 'raw' && (
          <pre className="m-0 whitespace-pre-wrap break-all p-3 font-mono text-[12px] text-fg-base">
            {resp.body_text ?? '[binary body — view as Preview]'}
          </pre>
        )}
        {responseTab === 'headers' && (
          <table className="w-full border-collapse text-left font-mono text-[12px]">
            <tbody>
              {resp.headers.map((h, i) => (
                <tr key={`${h.name}-${i}`} className="border-b border-white/[0.03]">
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
              <div className="flex h-full items-center justify-center font-display text-[11.5px] text-fg-subtle">
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
    const name = window.prompt('New collection name?');
    if (!name) return;
    await apiclientUpsertCollection(sessionId, { name, position: collections.length });
    onRefresh();
  };

  const removeCollection = async (id: string) => {
    if (!window.confirm('Delete this collection? Saved requests inside become drafts.')) return;
    await apiclientDeleteCollection(id);
    onRefresh();
  };

  const removeRequest = async (id: string) => {
    if (!window.confirm('Delete this saved request?')) return;
    await apiclientDeleteRequest(id);
    onRefresh();
  };

  const createEnv = async () => {
    if (!sessionId) return;
    const name = window.prompt('New environment name?');
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
    if (!window.confirm('Delete this environment?')) return;
    await apiclientEnvsDelete(id);
    setEditingEnvId(null);
    onRefresh();
  };

  const clearHistory = async () => {
    if (!sessionId) return;
    if (!window.confirm('Clear all history for this workspace?')) return;
    await apiclientClearHistory(sessionId);
    onRefresh();
  };

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border-hairline bg-base/40">
      <div className="flex h-9 items-center justify-between border-b border-border-hairline px-2.5">
        <span className="font-display text-[11px] uppercase tracking-wider text-fg-subtle/80">
          Workspace
        </span>
        <button
          onClick={onCollapse}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-white/[0.06] hover:text-fg-base"
          title="Collapse"
          aria-label="Collapse panel"
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
            <button
              onClick={createCollection}
              className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-white/[0.06] hover:text-fg-base"
              title="New collection"
              aria-label="New collection"
            >
              <Plus size={11} strokeWidth={2.2} />
            </button>
          }
        >
          {collectionsOpen && (
            <div className="pb-1">
              {collections.length === 0 && (grouped.get(null) ?? []).length === 0 && (
                <div className="px-3 py-2 font-display text-[11px] text-fg-subtle/80">
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
                className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-white/[0.06] hover:text-rose-300"
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
                <div className="px-3 py-2 font-display text-[11px] text-fg-subtle/80">
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
              className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-white/[0.06] hover:text-fg-base"
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
                <div className="px-3 py-2 font-display text-[11px] text-fg-subtle/80">
                  No environments. Create one for {`{{var}}`} substitution.
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
    <div className="border-b border-white/[0.04]">
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
        <span className="ml-0.5 flex-1 font-display text-[10.5px] uppercase tracking-wider text-fg-subtle/80">
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
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-white/[0.02]">
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
        <span className="flex-1 truncate font-display text-[11.5px] text-fg-base/90">{name}</span>
        <button
          onClick={onDelete}
          className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 hover:text-rose-300 group-hover:opacity-100"
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
        'group flex items-center gap-2 py-1 pr-2 hover:bg-white/[0.02]',
        indent ? 'pl-7' : 'pl-3',
      )}
    >
      <span
        className={cn(
          'shrink-0 font-mono text-[9.5px] font-semibold',
          methodColour(request.method),
        )}
      >
        {request.method}
      </span>
      <button
        onClick={onOpen}
        className="flex-1 truncate text-left font-display text-[11.5px] text-fg-base/85 hover:text-fg-base"
        title={request.url}
      >
        {request.name || request.url}
      </button>
      <button
        onClick={onDelete}
        className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 hover:text-rose-300 group-hover:opacity-100"
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
      className="group flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-white/[0.02]"
      title={entry.url}
    >
      <span className="shrink-0 font-mono text-[10px] text-fg-subtle/70">{time}</span>
      <span
        className={cn(
          'shrink-0 font-mono text-[9.5px] font-semibold',
          methodColour(entry.method),
        )}
      >
        {entry.method}
      </span>
      <span className="flex-1 truncate font-display text-[11px] text-fg-base/80">{entry.url}</span>
      {entry.status != null && (
        <span
          className={cn(
            'shrink-0 rounded-sm px-1 font-mono text-[9.5px]',
            entry.status >= 400
              ? 'text-rose-300'
              : entry.status >= 300
                ? 'text-amber-300'
                : 'text-emerald-300',
          )}
        >
          {entry.status}
        </span>
      )}
      {entry.error && (
        <span className="shrink-0 rounded-sm px-1 font-mono text-[9.5px] text-rose-300">err</span>
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
      <div className="group flex items-center gap-2 px-3 py-1 hover:bg-white/[0.02]">
        <button
          onClick={onActivate}
          className={cn(
            'h-2 w-2 shrink-0 rounded-full border transition-colors',
            env.is_active
              ? 'border-emerald-400 bg-emerald-400'
              : 'border-fg-subtle/40 hover:border-fg-subtle',
          )}
          aria-label={env.is_active ? 'Deactivate' : 'Activate'}
          title={env.is_active ? 'Active (click to deactivate)' : 'Activate'}
        />
        <button
          onClick={onEdit}
          className="flex-1 truncate text-left font-display text-[11.5px] text-fg-base/85 hover:text-fg-base"
        >
          {env.name}
        </button>
        <button
          onClick={onDelete}
          className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle opacity-0 hover:text-rose-300 group-hover:opacity-100"
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
        className="h-7 rounded-md border border-white/[0.06] bg-black/[0.22] px-2 font-display text-[11.5px] text-fg-base outline-none focus:border-accent/40"
        placeholder="Environment name"
      />
      <textarea
        value={varsRaw}
        onChange={(e) => setVarsRaw(e.target.value)}
        rows={4}
        placeholder={'base_url=https://api.example.com\ntoken=abc'}
        className="resize-y rounded-md border border-white/[0.06] bg-black/[0.22] p-2 font-mono text-[11.5px] text-fg-base outline-none focus:border-accent/40"
        spellCheck={false}
      />
      <div className="flex justify-end gap-1">
        <button
          onClick={save}
          className="rounded-md bg-accent/85 px-2.5 py-1 font-display text-[11px] text-fg-base hover:bg-accent"
        >
          Save
        </button>
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
  let formBody: KV[] = [];
  let multipartBody: KV[] = [];
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
        formBody: KV[];
        multipartBody: KV[];
      };
      bodyMode = b.bodyMode ?? 'none';
      bodyText = b.bodyText ?? '';
      formBody = b.formBody ?? [];
      multipartBody = b.multipartBody ?? [];
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
    formBody,
    multipartBody,
    auth,
  };
}

// silence lint for the imported Copy icon we don't yet use
void Copy;
