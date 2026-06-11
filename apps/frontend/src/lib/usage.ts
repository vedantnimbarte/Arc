// Best-effort parsers for AI-CLI usage output (Settings → Usage).
//
// CLI usage formats are unstable: `codex status --json` emits JSON whose shape
// drifts between versions, and `claude -p "/usage"` may print free text (or
// nothing parseable). So these helpers are deliberately tolerant — they pull
// whatever recognisable token/limit fields they can find and report `ok:false`
// when they find nothing, at which point the UI falls back to the raw output.

export interface UsageField {
  label: string;
  value: string;
  /** Optional secondary line (e.g. a reset time) shown under the value. */
  note?: string;
}

export interface ParsedUsage {
  fields: UsageField[];
  /** False → caller should show the raw output instead of `fields`. */
  ok: boolean;
}

/** Group thousands so big token counts stay readable. */
export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

// Key-name fragment → friendly label. First match wins; order matters
// (specific before generic). Matched against object keys anywhere in the tree.
const KEY_LABELS: { match: RegExp; label: string }[] = [
  { match: /^(input|prompt)_?tokens$/i, label: 'Input tokens' },
  { match: /^(output|completion)_?tokens$/i, label: 'Output tokens' },
  { match: /^(total_?tokens|tokens_?used)$/i, label: 'Total tokens' },
  { match: /^tokens$/i, label: 'Total tokens' },
  { match: /^(num_?)?requests?(_count)?$/i, label: 'Requests' },
  { match: /(token_?limit|rate_?limit|^limit$)/i, label: 'Limit' },
  { match: /^remaining/i, label: 'Remaining' },
  { match: /(resets?_?at|^resets?$|reset_?time)/i, label: 'Resets' },
  { match: /^(plan|tier)$/i, label: 'Plan' },
  { match: /(cost|amount|spend)/i, label: 'Cost' },
];

function scalarToString(v: number | string | boolean): string {
  return typeof v === 'number' ? formatTokens(v) : String(v);
}

// Walk the parsed JSON, collecting scalar leaves whose key matches a known
// label. Depth-bounded so a pathological payload can't blow the stack.
function collect(value: unknown, out: Map<string, string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        collect(v, out, depth + 1);
        continue;
      }
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        const spec = KEY_LABELS.find((s) => s.match.test(k));
        if (spec && !out.has(spec.label)) out.set(spec.label, scalarToString(v));
      }
    }
  }
}

/**
 * Parse JSON usage output (used directly for Codex). Returns `ok:false` when
 * the text isn't JSON or contains no recognisable fields.
 */
export function parseUsageJson(text: string): ParsedUsage {
  const t = text.trim();
  if (!t) return { fields: [], ok: false };
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    return { fields: [], ok: false };
  }
  const map = new Map<string, string>();
  collect(data, map);
  const fields = [...map].map(([label, value]) => ({ label, value }));
  return { fields, ok: fields.length > 0 };
}

/** Codex emits JSON, so its parser is the JSON parser. */
export const parseCodexUsage = parseUsageJson;

/** Friendly label for a Claude `/usage` "Current <x>:" line. */
function claudeLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.startsWith('session')) return 'Session';
  if (lower.startsWith('week')) {
    const qualifier = raw.match(/\(([^)]+)\)/);
    return qualifier ? `Weekly (${qualifier[1]})` : 'Weekly';
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Drop a trailing parenthetical (e.g. the timezone) to keep reset times short. */
function stripTrailingParen(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Parse Claude Code usage. The CLI prints one line per window, e.g.
 *   Current session: 23% used · resets Jun 11, 7:10pm (Asia/Calcutta)
 *   Current week (all models): 41% used · resets Jun 15, 11:29pm (...)
 *   Current week (Sonnet only): 0% used
 * We surface each as a field with the percent as the value and the reset time
 * as a note. Falls back to JSON, then a loose token/percent scan, then
 * `ok:false` (raw output) when nothing matches.
 */
export function parseClaudeUsage(stdout: string): ParsedUsage {
  const fields: UsageField[] = [];
  const re =
    /Current\s+([^:\n]+):\s*(\d+(?:\.\d+)?)\s*%(?:\s*used)?(?:[^\n]*?resets?\s+([^\n]+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    const label = claudeLabel(m[1]!.trim());
    const value = `${m[2]}% used`;
    const note = m[3] ? `resets ${stripTrailingParen(m[3].trim())}` : undefined;
    fields.push(note ? { label, value, note } : { label, value });
  }
  if (fields.length > 0) return { fields, ok: true };

  const json = parseUsageJson(stdout);
  if (json.ok) return json;

  const tok = stdout.match(/([\d,]+)\s+tokens/i);
  if (tok?.[1]) fields.push({ label: 'Tokens', value: tok[1] });
  const pct = stdout.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct?.[1]) fields.push({ label: 'Used', value: `${pct[1]}%` });
  return { fields, ok: fields.length > 0 };
}

/** Dispatch to the right parser by CLI id. */
export function parseCliUsage(id: string, stdout: string): ParsedUsage {
  if (id === 'claude-cli') return parseClaudeUsage(stdout);
  return parseUsageJson(stdout);
}
