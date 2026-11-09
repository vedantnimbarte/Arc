import { create } from 'zustand';
import {
  claudeUsageHistory,
  isTauri,
  sessionUsageLogLoad,
  sessionUsageLogSave,
  type ClaudeUsageRecord,
} from '../lib/tauri';

/**
 * Agent token and cost usage, kept by ARC itself.
 *
 * The CLI reports a turn's cost once and then forgets it, so without this the
 * only record of spend is whatever an external tool reconstructs. Entries are
 * bucketed by day, model and session rather than stored per turn: a busy month
 * is thousands of turns, and nothing here needs finer grain than a day.
 */

export type UsageSource = 'claude' | 'claude-history';

export interface UsageBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  source: UsageSource;
  model: string;
  sessionId: string;
  cwd: string;
  turns: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Null when the source doesn't report cost (imported history). */
  costUsd: number | null;
}

export interface UsageLog {
  version: 1;
  buckets: UsageBucket[];
  historyImportedAt: number | null;
}

export interface UsageEntry {
  at: number;
  source: UsageSource;
  model: string;
  sessionId: string;
  cwd: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number | null;
}

export const EMPTY_LOG: UsageLog = { version: 1, buckets: [], historyImportedAt: null };

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

const keyOf = (b: Pick<UsageBucket, 'day' | 'source' | 'model' | 'sessionId'>) =>
  `${b.day}|${b.source}|${b.model}|${b.sessionId}`;

/** Fold entries into the log, merging into existing day/model/session buckets. */
export function addEntries(log: UsageLog, entries: readonly UsageEntry[]): UsageLog {
  if (entries.length === 0) return log;
  const buckets = new Map(log.buckets.map((b) => [keyOf(b), { ...b }]));
  for (const e of entries) {
    const day = dayKey(e.at);
    const key = keyOf({ day, source: e.source, model: e.model, sessionId: e.sessionId });
    const existing = buckets.get(key);
    if (existing) {
      existing.turns += 1;
      existing.input += e.input;
      existing.output += e.output;
      existing.cacheWrite += e.cacheWrite;
      existing.cacheRead += e.cacheRead;
      if (e.costUsd !== null) existing.costUsd = (existing.costUsd ?? 0) + e.costUsd;
    } else {
      buckets.set(key, {
        day,
        source: e.source,
        model: e.model,
        sessionId: e.sessionId,
        cwd: e.cwd,
        turns: 1,
        input: e.input,
        output: e.output,
        cacheWrite: e.cacheWrite,
        cacheRead: e.cacheRead,
        costUsd: e.costUsd,
      });
    }
  }
  return { ...log, buckets: [...buckets.values()] };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Turn Claude Code transcript usage rows into entries. The CLI writes a message
 * once per streamed content block, each carrying the same usage, so rows are
 * deduped by message id.
 */
export function entriesFromHistory(rows: readonly ClaudeUsageRecord[]): UsageEntry[] {
  const seen = new Set<string>();
  const entries: UsageEntry[] = [];
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at)) continue;
    entries.push({
      at,
      source: 'claude-history',
      model: row.model,
      sessionId: row.session_id,
      cwd: row.cwd,
      input: row.input_tokens,
      output: row.output_tokens,
      cacheWrite: row.cache_creation_input_tokens,
      cacheRead: row.cache_read_input_tokens,
      costUsd: null,
    });
  }
  return entries;
}

export interface UsageSummary {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  turns: number;
  sessions: number;
  /** Null when no bucket reports cost. */
  costUsd: number | null;
  /** Oldest first, one entry per day in the window, zero-filled. */
  byDay: { day: string; tokens: number }[];
  byModel: { model: string; tokens: number; costUsd: number | null }[];
  topSessions: { sessionId: string; cwd: string; tokens: number; costUsd: number | null }[];
}

const tokensOf = (b: UsageBucket) => b.input + b.output + b.cacheWrite + b.cacheRead;

const addCost = (a: number | null, b: number | null) =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

export function summarize(log: UsageLog, days: number, now: number): UsageSummary {
  const byDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) byDay.set(dayKey(now - i * 86_400_000), 0);

  const byModel = new Map<string, { tokens: number; costUsd: number | null }>();
  const bySession = new Map<string, { cwd: string; tokens: number; costUsd: number | null }>();
  const summary: UsageSummary = {
    totalTokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    turns: 0,
    sessions: 0,
    costUsd: null,
    byDay: [],
    byModel: [],
    topSessions: [],
  };

  for (const b of log.buckets) {
    const tokens = tokensOf(b);
    summary.totalTokens += tokens;
    summary.input += b.input;
    summary.output += b.output;
    summary.cacheRead += b.cacheRead;
    summary.turns += b.turns;
    summary.costUsd = addCost(summary.costUsd, b.costUsd);
    if (byDay.has(b.day)) byDay.set(b.day, byDay.get(b.day)! + tokens);

    const model = byModel.get(b.model) ?? { tokens: 0, costUsd: null };
    model.tokens += tokens;
    model.costUsd = addCost(model.costUsd, b.costUsd);
    byModel.set(b.model, model);

    const sessionKey = b.sessionId || `${b.cwd}|${b.day}`;
    const session = bySession.get(sessionKey) ?? { cwd: b.cwd, tokens: 0, costUsd: null };
    session.tokens += tokens;
    session.costUsd = addCost(session.costUsd, b.costUsd);
    bySession.set(sessionKey, session);
  }

  summary.sessions = bySession.size;
  summary.byDay = [...byDay].map(([day, tokens]) => ({ day, tokens }));
  summary.byModel = [...byModel]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.tokens - a.tokens);
  summary.topSessions = [...bySession]
    .map(([sessionId, v]) => ({ sessionId, ...v }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);
  return summary;
}

interface UsageLogState {
  log: UsageLog;
  loaded: boolean;
  importing: boolean;
  importError: string | null;
  load: () => Promise<void>;
  record: (entry: UsageEntry) => void;
  importClaudeHistory: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Shared by concurrent `load` calls, so the stored log is merged in once. */
let loadPromise: Promise<void> | null = null;

function scheduleSave(log: UsageLog) {
  if (!isTauri) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void sessionUsageLogSave(JSON.stringify(log)).catch((e) =>
      console.error('[usage] save failed:', e),
    );
  }, 1000);
}

export const useUsageLog = create<UsageLogState>((set, get) => ({
  log: EMPTY_LOG,
  loaded: false,
  importing: false,
  importError: null,
  load: () => {
    if (get().loaded) return Promise.resolve();
    loadPromise ??= (async () => {
      let log = EMPTY_LOG;
      if (isTauri) {
        try {
          const raw = await sessionUsageLogLoad();
          if (raw) log = { ...EMPTY_LOG, ...(JSON.parse(raw) as UsageLog) };
        } catch (e) {
          console.error('[usage] load failed:', e);
        }
      }
      // Anything recorded before the load finished is kept, not overwritten.
      const pending = get().log;
      const merged = addEntriesFromBuckets(log, pending);
      set({ log: merged, loaded: true });
      if (pending.buckets.length > 0) scheduleSave(merged);
    })();
    return loadPromise;
  },
  record: (entry) => {
    const log = addEntries(get().log, [entry]);
    set({ log });
    // Saving before the stored log is loaded would overwrite it with just
    // this session's turns; `load` merges and saves instead.
    if (get().loaded) scheduleSave(log);
    else void get().load();
  },
  importClaudeHistory: async () => {
    if (!isTauri || get().importing) return;
    set({ importing: true, importError: null });
    try {
      await get().load();
      const entries = entriesFromHistory(await claudeUsageHistory());
      // Re-import replaces earlier history rather than doubling it.
      const withoutHistory: UsageLog = {
        ...get().log,
        buckets: get().log.buckets.filter((b) => b.source !== 'claude-history'),
      };
      const log = { ...addEntries(withoutHistory, entries), historyImportedAt: Date.now() };
      set({ log });
      scheduleSave(log);
    } catch (e) {
      set({ importError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ importing: false });
    }
  },
}));

function addEntriesFromBuckets(base: UsageLog, extra: UsageLog): UsageLog {
  if (extra.buckets.length === 0) return base;
  const merged = new Map(base.buckets.map((b) => [keyOf(b), { ...b }]));
  for (const b of extra.buckets) {
    const existing = merged.get(keyOf(b));
    if (!existing) {
      merged.set(keyOf(b), { ...b });
      continue;
    }
    existing.turns += b.turns;
    existing.input += b.input;
    existing.output += b.output;
    existing.cacheWrite += b.cacheWrite;
    existing.cacheRead += b.cacheRead;
    existing.costUsd = addCost(existing.costUsd, b.costUsd);
  }
  return { ...base, buckets: [...merged.values()] };
}

/** Turn one Claude turn's event stream into a usage entry. The CLI's final
 *  `result` line is preceded by a `usage` event carrying the turn's totals. */
export function claudeUsageRecorder(context: { cwd: string; model: string }) {
  let usage: Record<string, unknown> | null = null;
  return (event: { kind: string; payload?: Record<string, unknown> | null }) => {
    const payload = event.payload ?? {};
    if (event.kind === 'usage') {
      usage = (payload.usage ?? null) as Record<string, unknown> | null;
      return;
    }
    if (event.kind !== 'result') return;
    useUsageLog.getState().record({
      at: Date.now(),
      source: 'claude',
      model: context.model || 'default',
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : '',
      cwd: context.cwd,
      input: num(usage?.input_tokens),
      output: num(usage?.output_tokens),
      cacheWrite: num(usage?.cache_creation_input_tokens),
      cacheRead: num(usage?.cache_read_input_tokens),
      costUsd: typeof payload.cost_usd === 'number' ? payload.cost_usd : null,
    });
    usage = null;
  };
}
