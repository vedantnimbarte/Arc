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
 */

import { procRun } from './tauri';

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
