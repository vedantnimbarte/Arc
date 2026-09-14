/**
 * Agent usage/credits: run a user-configured command and show whatever it
 * prints. There is no backend crate and there shouldn't be — `proc_run`
 * already captures output with a timeout, so this is just the shell-wrap and
 * the display-formatting glue (same shape as `lib/docker.ts`).
 *
 * The command is a full shell line (e.g. `npx ccusage@latest --json`), not a
 * program + argv, because the user is naming an arbitrary CLI invocation —
 * quoting/piping/`&&` should work the way it would in their own terminal.
 * `proc_run` has no shell of its own, so it's wrapped here.
 *
 * The one exception is Claude's plan limits (the percentages `/usage` shows):
 * no CLI prints those, so `claude_plan_usage` fetches them — see the bottom.
 */

import { claudePlanUsage, procRun } from './tauri';

export interface UsageRow {
  label: string;
  value: string;
}

export interface UsageGroup {
  title: string;
  rows: UsageRow[];
}

export interface UsageSummary {
  rows: UsageRow[];
  groups: UsageGroup[];
  /** Always kept, so a "show raw" toggle works even for parsed JSON. */
  raw: string;
  /** False when stdout wasn't JSON — callers should show `raw` only. */
  json: boolean;
}

const isWindows =
  typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent || '');

/** Wrap a shell command line for `proc_run`, which spawns a program directly
 *  with no shell of its own. */
function shellWrap(command: string): { program: string; args: string[] } {
  return isWindows
    ? { program: 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { program: '/bin/sh', args: ['-c', command] };
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Run `command` in `cwd` and parse its stdout. Throws with the process's
 *  stderr (or a timeout message) on failure. */
export async function runUsage(command: string, cwd: string): Promise<UsageSummary> {
  const { program, args } = shellWrap(command);
  const out = await procRun(cwd, program, args, DEFAULT_TIMEOUT_MS);
  if (out.timed_out) throw new Error('Command timed out.');
  if (out.code !== 0) {
    throw new Error(out.stderr.trim() || `Command exited with code ${out.code ?? '?'}.`);
  }
  return parseUsage(out.stdout);
}

const COST_KEY = /cost|usd|spend|price/i;

/** camelCase / snake_case → "Camel Case". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(key: string, value: number): string {
  // Pinned to 'en-US' rather than the host locale's default grouping (which
  // can be lakh/crore, space-separated, etc.) — this is a token count, not
  // localized prose.
  return COST_KEY.test(key) ? `$${value.toFixed(2)}` : value.toLocaleString('en-US');
}

/** Numeric top-level fields of a plain object, in declaration order. */
function numericRows(obj: Record<string, unknown>): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      rows.push({ label: humanizeKey(k), value: formatValue(k, v) });
    }
  }
  return rows;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Shape-agnostic on purpose: this isn't a ccusage parser, it's "make numbers
 * in a JSON blob readable". `totals`/`summary` is ccusage's own convention
 * for where the grand total lives; anything else falls back to the root.
 * Nested plain objects become one group each (ccusage's `byModel` etc.);
 * arrays and deeper nesting stay out of the summary and are still visible via
 * `raw`.
 */
export function parseUsage(stdout: string): UsageSummary {
  const raw = stdout;
  const trimmed = stdout.trim();
  if (!trimmed) return { rows: [], groups: [], raw, json: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { rows: [], groups: [], raw, json: false };
  }
  if (!isPlainObject(parsed)) return { rows: [], groups: [], raw, json: false };

  const summary = isPlainObject(parsed.totals)
    ? parsed.totals
    : isPlainObject(parsed.summary)
      ? parsed.summary
      : parsed;

  const rows = numericRows(summary);
  const groups: UsageGroup[] = [];
  for (const [k, v] of Object.entries(summary)) {
    if (isPlainObject(v)) {
      const groupRows = numericRows(v);
      if (groupRows.length) groups.push({ title: humanizeKey(k), rows: groupRows });
    }
  }

  return { rows, groups, raw, json: true };
}

// ─── Claude plan limits ────────────────────────────────────────────────────

export interface PlanLimit {
  label: string;
  /** 0–100. */
  percent: number;
  severity: 'normal' | 'warning' | 'critical';
  /** Epoch ms, or null when the window hasn't started. */
  resetsAt: number | null;
  /** Window length in ms, for the elapsed-time tick. Null when unknown. */
  windowMs: number | null;
}

const HOUR = 3_600_000;

/** Fetch and parse the plan limits. Throws the backend's user-facing message. */
export async function fetchPlanLimits(): Promise<PlanLimit[]> {
  return parsePlanLimits(await claudePlanUsage());
}

/**
 * Reads the `limits` array of Claude's (undocumented) plan-usage response.
 * Unknown kinds still render, just with a generic label, so a new limit type
 * shows up instead of vanishing.
 */
export function parsePlanLimits(body: string): PlanLimit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.limits)) return [];

  const out: PlanLimit[] = [];
  for (const l of parsed.limits) {
    if (!isPlainObject(l) || typeof l.percent !== 'number') continue;
    const model = isPlainObject(l.scope) && isPlainObject(l.scope.model)
      ? l.scope.model.display_name
      : null;
    const weekly = l.group === 'weekly';
    const label =
      l.kind === 'session'
        ? 'Current session'
        : weekly && typeof model === 'string'
          ? `${model} this week`
          : weekly
            ? 'All models this week'
            : humanizeKey(String(l.kind ?? 'Limit'));
    const resetsAt = typeof l.resets_at === 'string' ? Date.parse(l.resets_at) : NaN;
    out.push({
      label,
      percent: Math.max(0, Math.min(100, l.percent)),
      severity: l.severity === 'warning' || l.severity === 'critical' ? l.severity : 'normal',
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      windowMs: l.group === 'session' ? 5 * HOUR : weekly ? 168 * HOUR : null,
    });
  }
  return out;
}

/** "Resets in 3h 12m" inside a day, otherwise "Resets Tue 9:00 PM". */
export function formatReset(resetsAt: number, now = Date.now()): string {
  const ms = resetsAt - now;
  if (ms <= 0) return 'Resets now';
  if (ms < 24 * HOUR) {
    const mins = Math.ceil(ms / 60_000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `Resets in ${h}h ${m}m` : `Resets in ${m}m`;
  }
  const d = new Date(resetsAt);
  return `Resets ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
