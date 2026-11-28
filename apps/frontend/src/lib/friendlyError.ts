/**
 * Turn a thrown value into a sentence a user can act on, keeping the raw text
 * for a "Details" toggle. Tools used to print `String(e)` straight into the
 * UI, which read as a stack trace to anyone who didn't write the code.
 *
 * Only the causes that recur across tools are mapped; anything else keeps its
 * own first line, trimmed of the `Error:` prefix noise.
 */
export interface FriendlyError {
  /** One plain sentence: what happened and what to do. */
  message: string;
  /** The original text, for the Details toggle. Empty when it adds nothing. */
  detail: string;
}

const RULES: { test: RegExp; message: (m: RegExpMatchArray) => string }[] = [
  {
    test: /rate limit|API rate|secondary rate|\b429\b/i,
    message: () => "GitHub's hourly request limit is used up. Try again in a few minutes.",
  },
  {
    test: /\b401\b|bad credentials|unauthori[sz]ed|requires authentication/i,
    message: () => 'You were signed out. Sign in again.',
  },
  {
    test: /\b403\b|forbidden|permission denied \(publickey\)/i,
    message: () => "You don't have access to this. Check the account or token you signed in with.",
  },
  {
    test: /\b404\b|not found/i,
    message: () => "That wasn't found. It may have been moved or deleted, or you may not have access.",
  },
  {
    test: /keyring|keychain|credential manager|secret service|secret-service/i,
    message: () => "Couldn't use the system keychain. Check that it's unlocked, then try again.",
  },
  {
    test: /timed? ?out|timeout|deadline/i,
    message: () => 'That took too long and was stopped. Check the connection and try again.',
  },
  {
    test: /ECONNREFUSED|connection refused/i,
    message: () => 'Nothing answered at that address. Check that the server is running.',
  },
  {
    test: /ENOTFOUND|getaddrinfo|dns|could not resolve|failed to lookup/i,
    message: () => "That address couldn't be found. Check it for typos.",
  },
  {
    test: /failed to fetch|network|ECONNRESET|offline|error sending request/i,
    message: () => "Can't reach the server. Check the address and that you're online.",
  },
];

/** First non-empty line, without a leading `Error:` / `error:` label. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.replace(/^\s*(?:Error|error|fatal):\s*/, '').trim();
}

export function friendlyError(e: unknown, fallback = 'Something went wrong.'): FriendlyError {
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e ?? '')).trim();
  if (!raw) return { message: fallback, detail: '' };
  for (const rule of RULES) {
    const m = raw.match(rule.test);
    if (m) return { message: rule.message(m), detail: raw };
  }
  const line = firstLine(raw);
  const sentence = line ? line[0]!.toUpperCase() + line.slice(1) : fallback;
  // Only offer Details when there's more than the line already shown.
  return { message: sentence, detail: raw === line ? '' : raw };
}
