// Terminal highlight rules: user-authored patterns that tint matching output
// lines and, optionally, raise a notification ("ERROR", "listening on :3000").

export interface HighlightRule {
  id: string;
  /** Regex source, matched case-insensitively against one rendered line. */
  pattern: string;
  /** CSS colour for the line tint. */
  color: string;
  /** Also raise a notification when a line matches. */
  notify: boolean;
  enabled: boolean;
}

export interface CompiledRule {
  rule: HighlightRule;
  re: RegExp;
}

/** Compile enabled rules, skipping any whose pattern isn't a valid regex —
 *  a typo in Settings must not take the terminal down. */
export function compileRules(rules: readonly HighlightRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of rules) {
    if (!rule.enabled || !rule.pattern.trim()) continue;
    try {
      out.push({ rule, re: new RegExp(rule.pattern, 'i') });
    } catch {
      /* invalid pattern — ignored */
    }
  }
  return out;
}

/** First rule that matches `line`, or null. First wins so the list order in
 *  Settings is the priority order. */
export function matchLine(compiled: readonly CompiledRule[], line: string): HighlightRule | null {
  if (!line) return null;
  for (const c of compiled) if (c.re.test(line)) return c.rule;
  return null;
}

export function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
