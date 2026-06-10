// Posted per-token pricing for the chat models ARC talks to, used by the
// chat cost meter (Tier 1.6). Values are USD per 1,000,000 tokens and reflect
// each provider's public list price — they drift, so treat the meter as an
// estimate, not a billing source of truth. Local models (Ollama, *-cli) have
// no per-token cost and are intentionally absent.

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
}

/** Keyed by a model-id substring. Lookup picks the longest key contained in
 *  the requested model id, so dated variants (`gpt-4o-2024-08-06`) resolve to
 *  their family price without an exhaustive table. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── OpenAI ──────────────────────────────────────────────────────────────
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1-mini': { input: 1.1, output: 4.4 },
  'o1': { input: 15, output: 60 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o3': { input: 2, output: 8 },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // ── Google (OpenAI-compatible endpoint) ───────────────────────────────────
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
};

const PRICING_KEYS = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/**
 * Resolve list pricing for a model id, or `null` when we don't have a price
 * (local models, or a model not in the table). Matches the longest known key
 * contained in the (lower-cased) model id.
 */
export function lookupPricing(model: string): ModelPricing | null {
  const m = model.toLowerCase();
  for (const key of PRICING_KEYS) {
    if (m.includes(key)) return MODEL_PRICING[key]!;
  }
  return null;
}

/**
 * Estimate the USD cost of a turn given its token counts. Returns `null` when
 * the model has no known price, so callers can hide the dollar figure rather
 * than show a misleading $0.00.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = lookupPricing(model);
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Compact USD formatter for the meter — sub-cent costs keep more precision so
 *  a cheap turn doesn't read as "$0.00". */
export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
