import type { HttpFormEntry, HttpHeaderKV, HttpRequestDto } from './tauri';

/**
 * cURL ⇄ request conversion for the API Client. Pure — no DOM, no Tauri —
 * so both directions are unit-tested.
 *
 * The tokenizer follows POSIX shell quoting (single, double, `$'…'`,
 * backslash escapes and line continuations). cmd.exe `^` escaping from
 * "Copy as cURL (cmd)" is not understood.
 */

export interface CurlRequest {
  method: string;
  url: string;
  headers: HttpHeaderKV[];
  /** Joined request body, or null when the command sends none. */
  body: string | null;
  /** `-F` / `--form` / `--form-string` fields; `body` is null when set. */
  form?: HttpFormEntry[];
  /** Set when every data option was `--data-urlencode`: the unencoded
   *  name/value pairs, so they import as form-urlencoded rows. */
  urlencoded?: HttpHeaderKV[];
}

/** Split a shell command line into argv, honouring quotes and escapes. */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      const next = s[i + 1];
      if (next === '\n') {
        i += 2;
      } else if (next === '\r' && s[i + 2] === '\n') {
        i += 3;
      } else if (next !== undefined) {
        cur += next;
        inToken = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error('Unterminated single quote');
      cur += s.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting, as emitted by Chrome's "Copy as cURL".
      i += 2;
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"' };
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          cur += escapes[s[i + 1]!] ?? `\\${s[i + 1]}`;
          i += 2;
        } else {
          cur += s[i];
          i += 1;
        }
      }
      if (i >= s.length) throw new Error('Unterminated $\' quote');
      inToken = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const next = s[i + 1]!;
          if (next === '\n') {
            // continuation inside double quotes
          } else if ('"\\$`'.includes(next)) {
            cur += next;
          } else {
            cur += `\\${next}`;
          }
          i += 2;
        } else {
          cur += s[i];
          i += 1;
        }
      }
      if (i >= s.length) throw new Error('Unterminated double quote');
      inToken = true;
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
      i += 1;
      continue;
    }
    cur += c;
    inToken = true;
    i += 1;
  }
  if (inToken) out.push(cur);
  return out;
}

const DATA_OPTS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode']);

/** Options whose next argument is a value we don't use — skipped so the
 *  value isn't mistaken for the URL. */
const IGNORED_VALUE_OPTS = new Set([
  '-o', '--output', '-x', '--proxy', '-m', '--max-time',
  '--connect-timeout', '-w', '--write-out', '--cacert', '--cert', '-E', '--key', '-r', '--range',
  '-T', '--upload-file', '--resolve', '--retry', '-c', '--cookie-jar', '-K', '--config',
]);

function utf8Base64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

/** Parse a `curl …` command into a request. Throws on anything that isn't one. */
export function parseCurl(command: string): CurlRequest {
  const argv = shellSplit(command.trim());
  if (argv[0] !== 'curl' && argv[0] !== 'curl.exe') {
    throw new Error('Not a curl command');
  }
  let method: string | null = null;
  let url = '';
  let head = false;
  const headers: HttpHeaderKV[] = [];
  const data: string[] = [];
  const form: HttpFormEntry[] = [];
  const urlencoded: HttpHeaderKV[] = [];
  let json = false;

  for (let i = 1; i < argv.length; i++) {
    let arg = argv[i]!;
    let value: string | undefined;
    // --opt=value
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    // -XPOST / -H'Accept: x' (value glued to a short option)
    if (!arg.startsWith('--') && arg.length > 2 && arg.startsWith('-') && 'XHduF'.includes(arg[1]!)) {
      value = arg.slice(2);
      arg = arg.slice(0, 2);
    }
    const takeValue = () => value ?? argv[++i] ?? '';

    if (arg === '-X' || arg === '--request') {
      method = takeValue().toUpperCase();
    } else if (arg === '-H' || arg === '--header') {
      const h = takeValue();
      const colon = h.indexOf(':');
      if (colon > 0) headers.push({ name: h.slice(0, colon).trim(), value: h.slice(colon + 1).trim() });
    } else if (DATA_OPTS.has(arg)) {
      const v = takeValue();
      data.push(v);
      if (arg === '--data-urlencode') {
        // `name=content`; a bare `content` or `=content` has no name.
        const eq = v.indexOf('=');
        urlencoded.push(eq < 0 ? { name: v, value: '' } : { name: v.slice(0, eq), value: v.slice(eq + 1) });
      }
    } else if (arg === '-F' || arg === '--form' || arg === '--form-string') {
      const v = takeValue();
      const eq = v.indexOf('=');
      const name = eq < 0 ? v : v.slice(0, eq);
      const value = eq < 0 ? '' : v.slice(eq + 1);
      if (arg !== '--form-string' && (value.startsWith('@') || value.startsWith('<'))) {
        // `@path;type=…;filename=…` — keep the path, drop the part options.
        form.push({ name, value: value.slice(1).split(';')[0]!, file: true });
      } else {
        form.push({ name, value, file: false });
      }
    } else if (arg === '--json') {
      data.push(takeValue());
      json = true;
    } else if (arg === '-u' || arg === '--user') {
      const cred = takeValue();
      headers.push({
        name: 'Authorization',
        value: `Basic ${utf8Base64(cred.includes(':') ? cred : `${cred}:`)}`,
      });
    } else if (arg === '--url') {
      url = takeValue();
    } else if (arg === '-A' || arg === '--user-agent') {
      headers.push({ name: 'User-Agent', value: takeValue() });
    } else if (arg === '-e' || arg === '--referer') {
      headers.push({ name: 'Referer', value: takeValue() });
    } else if (arg === '-b' || arg === '--cookie') {
      headers.push({ name: 'Cookie', value: takeValue() });
    } else if (arg === '-I' || arg === '--head') {
      head = true;
    } else if (IGNORED_VALUE_OPTS.has(arg)) {
      takeValue();
    } else if (arg.startsWith('-') && arg !== '-') {
      // Unknown flag (-s, -L, --compressed, …) — no request semantics.
    } else if (!url) {
      url = arg;
    }
  }

  if (!url) throw new Error('No URL in curl command');

  if (json) {
    const has = (n: string) => headers.some((h) => h.name.toLowerCase() === n);
    if (!has('content-type')) headers.push({ name: 'Content-Type', value: 'application/json' });
    if (!has('accept')) headers.push({ name: 'Accept', value: 'application/json' });
  }

  const body = form.length === 0 && data.length > 0 ? data.join(json ? '' : '&') : null;
  const out: CurlRequest = {
    method: method ?? (body !== null || form.length > 0 ? 'POST' : head ? 'HEAD' : 'GET'),
    url,
    headers,
    body,
  };
  if (form.length > 0) out.form = form;
  else if (urlencoded.length > 0 && urlencoded.length === data.length) out.urlencoded = urlencoded;
  return out;
}

/** POSIX single-quote a word unless it is plainly safe. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Render a wire request as a multi-line, POSIX-shell-quoted curl command. */
export function toCurl(req: HttpRequestDto): string {
  const parts: string[] = [];
  const method = req.method.toUpperCase();
  const hasBody = req.body.kind !== 'none';
  let first = `curl ${shellQuote(req.url)}`;
  if (method === 'HEAD') first += ' -I';
  else if (method !== 'GET' || hasBody) first += ` -X ${shellQuote(method)}`;
  parts.push(first);

  for (const h of req.headers) parts.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);

  const b = req.body;
  if (b.kind === 'raw') {
    const hasType = req.headers.some((h) => h.name.toLowerCase() === 'content-type');
    if (!hasType && b.content_type) parts.push(`-H ${shellQuote(`Content-Type: ${b.content_type}`)}`);
    parts.push(`--data-raw ${shellQuote(b.text)}`);
  } else if (b.kind === 'formurlencoded') {
    for (const e of b.entries) parts.push(`--data-urlencode ${shellQuote(`${e.name}=${e.value}`)}`);
  } else if (b.kind === 'multipart') {
    for (const e of b.entries) {
      parts.push(
        e.file
          ? `-F ${shellQuote(`${e.name}=@${e.value}`)}`
          : `--form-string ${shellQuote(`${e.name}=${e.value}`)}`,
      );
    }
  }
  return parts.join(' \\\n  ');
}
