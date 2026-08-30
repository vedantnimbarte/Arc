import { httpRequest, isTauri, secretGet } from './tauri';

// Natural-language → shell command, via the Anthropic Messages API.
//
// The request goes through the Rust HTTP engine (`http_request`, the same one
// the API Client uses) rather than `fetch`: the webview's CSP allows no
// outbound `connect-src`, so a direct call from here would be blocked.
// That also rules out the official SDK, which needs a working `fetch` — one
// JSON POST is smaller than a fetch shim over the IPC bridge anyway.

/** Vault key holding the user's Anthropic API key. Never persisted to SQLite. */
export const ANTHROPIC_KEY_SECRET = 'anthropic-api-key';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
/** Generous: `max_tokens` covers thinking tokens too, and a truncated
 *  response is worse than an unused ceiling (billing is on actual usage). */
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 30_000;

/** Thrown for every failure the command bar should show verbatim. */
export class AiError extends Error {}

export interface CommandContext {
  /** Shell binary the tab is running, e.g. `/bin/zsh` or `powershell.exe`. */
  shell: string | null;
  /** The tab's live working directory, when known. */
  cwd: string | null;
}

/** OS name for the prompt — it decides whether `ls` or `Get-ChildItem` is
 *  the right answer. Ambient, so the caller doesn't pass it. */
function platformName(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const p = (navigator.platform || navigator.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac')) return 'macOS';
  if (p.includes('linux')) return 'Linux';
  return 'unknown';
}

const SYSTEM_PROMPT = [
  'You translate a developer\'s plain-English request into a single shell command.',
  '',
  'Reply with the command and nothing else: no explanation, no commentary, no',
  'markdown fences, no leading prompt character. If the request genuinely needs',
  'several commands, join them with the shell\'s own separator on one line.',
  '',
  'Match the syntax of the shell and OS given by the user. Prefer tools that',
  'ship with the OS. Never invent flags — if you are unsure a flag exists, use',
  'a simpler form that you know works.',
].join('\n');

/**
 * Ask Claude for the command matching `request`.
 *
 * Returns the command text, never runs it — the caller puts it on the shell's
 * input line and the user presses Enter themselves.
 */
export async function suggestCommand(
  request: string,
  ctx: CommandContext,
): Promise<string> {
  if (!isTauri) throw new AiError('Command suggestions need the desktop app.');

  let key: string | null = null;
  try {
    key = await secretGet(ANTHROPIC_KEY_SECRET);
  } catch {
    // A locked or unavailable keyring reads the same as an unset key here.
  }
  if (!key) {
    throw new AiError('No API key yet — add one in Settings → Terminal.');
  }

  const model = await resolveModel();
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    // Command translation is not a reasoning-heavy task, and this bar sits in
    // front of someone waiting to type. Low effort keeps thinking short.
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          `Shell: ${ctx.shell ?? 'unknown'}`,
          `OS: ${platformName()}`,
          `Working directory: ${ctx.cwd ?? 'unknown'}`,
          '',
          `Request: ${request}`,
        ].join('\n'),
      },
    ],
  };

  const res = await httpRequest({
    method: 'POST',
    url: API_URL,
    headers: [
      { name: 'x-api-key', value: key },
      { name: 'anthropic-version', value: API_VERSION },
      { name: 'content-type', value: 'application/json' },
    ],
    body: { kind: 'raw', text: JSON.stringify(body), content_type: 'application/json' },
    timeout_ms: TIMEOUT_MS,
  });

  return parseCommand(res.status, res.body_text);
}

/** Read the configured model without importing the settings store at module
 *  scope (it pulls in the theme layer, which the test environment has no DOM
 *  for). */
async function resolveModel(): Promise<string> {
  const { useSettings } = await import('../state/settings');
  return useSettings.getState().aiModel;
}

/**
 * Pull the command out of a Messages API response.
 *
 * Exported for tests. Handles the shapes that actually reach users: an error
 * status with a JSON `error.message`, a refusal, thinking blocks preceding the
 * text (adaptive thinking is on by default), and a model that fenced its
 * answer despite being told not to.
 */
export function parseCommand(status: number, bodyText: string | null): string {
  const parsed = safeJson(bodyText);

  if (status !== 200) {
    const message =
      (parsed?.error as { message?: string } | undefined)?.message ??
      (status === 401 ? 'API key rejected.' : `Request failed (HTTP ${status}).`);
    throw new AiError(message);
  }
  if (!parsed) throw new AiError('Unreadable response from the API.');

  if (parsed.stop_reason === 'refusal') {
    throw new AiError('Claude declined this request.');
  }

  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const command = stripFence(text);
  if (!command) throw new AiError('No command came back — try rephrasing.');
  return command;
}

/** Unwrap a ```fenced``` block, keeping the command inside it. */
function stripFence(text: string): string {
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return (fenced?.[1] ?? text).trim();
}

function safeJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
