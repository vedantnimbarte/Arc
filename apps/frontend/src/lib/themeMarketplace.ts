import {
  fsCreateDir,
  fsDefaultRoot,
  fsPickFiles,
  fsReadDir,
  fsReadFile,
  fsWriteFile,
  httpRequest,
  isTauri,
} from './tauri';
import { registerTheme, validateThemeJson, type ThemeDef } from '../themes';
import { convertVscodeTheme, looksLikeVscodeTheme, parseJsonc } from './vscodeTheme';

// User-installed themes live in `<home>/.arc/themes/*.json` (Tier 1.7). These
// load on boot and any installed theme is written here so it sticks.
//
// Two input formats are accepted everywhere: ARC's own `ThemeDef` JSON, and a
// VS Code colour theme, which is converted on the way in (see
// `lib/vscodeTheme.ts`). Sniffing the format rather than asking means "install
// this file" works for whatever the user actually has.

function joinHome(home: string, ...parts: string[]): string {
  const sep = home.includes('\\') ? '\\' : '/';
  return [home.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

/** Absolute path to the user theme directory, or null outside Tauri. */
async function themesDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const home = await fsDefaultRoot();
    return joinHome(home, '.arc', 'themes');
  } catch {
    return null;
  }
}

export type InstallResult =
  | { ok: true; theme: ThemeDef }
  | { ok: false; error: string };

/** Parse raw JSON in either supported format into a validated `ThemeDef`. */
function parseEitherFormat(raw: string): InstallResult {
  let json: unknown;
  try {
    json = parseJsonc(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  return looksLikeVscodeTheme(json) ? convertVscodeTheme(json) : validateThemeJson(json);
}

/**
 * Load every `*.json` theme from `~/.arc/themes` and register the valid ones.
 * Best-effort: a missing directory or a malformed file is skipped silently
 * (the warning is logged). Returns the ids that registered successfully.
 */
export async function loadInstalledThemes(): Promise<string[]> {
  const dir = await themesDir();
  if (!dir) return [];
  let entries;
  try {
    entries = await fsReadDir(dir);
  } catch {
    return []; // directory doesn't exist yet — nothing installed
  }
  const ids: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.toLowerCase().endsWith('.json')) continue;
    try {
      const parsed = parseEitherFormat(await fsReadFile(e.path));
      if (parsed.ok) {
        registerTheme(parsed.theme);
        ids.push(parsed.theme.id);
      } else {
        console.warn(`[themes] ${e.name}: ${parsed.error}`);
      }
    } catch (err) {
      console.warn(`[themes] failed to load ${e.name}:`, err);
    }
  }
  return ids;
}

/** Write a registered theme to `~/.arc/themes/<id>.json`.
 *
 *  Best-effort: a failure here doesn't undo the in-memory registration — the
 *  theme just won't survive a restart. */
async function persistTheme(theme: ThemeDef): Promise<void> {
  const dir = await themesDir();
  if (!dir) return;
  try {
    await fsCreateDir(dir);
    const sep = dir.includes('\\') ? '\\' : '/';
    const slug = theme.id.replace(/[^\w.-]/g, '_');
    await fsWriteFile(`${dir}${sep}${slug}.json`, JSON.stringify(theme, null, 2));
  } catch (err) {
    console.warn('[themes] could not persist installed theme:', err);
  }
}

/** Validate raw theme JSON, register it, and persist it for next launch. */
export async function installThemeJson(raw: string): Promise<InstallResult> {
  const parsed = parseEitherFormat(raw);
  if (!parsed.ok) return parsed;
  registerTheme(parsed.theme);
  await persistTheme(parsed.theme);
  return parsed;
}

/**
 * Pick theme files from disk and install them.
 *
 * Returns the last one installed, so the caller can select it — or the first
 * failure, so the message names the file that broke. Cancelling the picker
 * returns null, which is not an error.
 */
export async function installThemeFromFile(): Promise<InstallResult | null> {
  if (!isTauri) return { ok: false, error: 'theme install requires the Tauri backend' };
  let paths: string[];
  try {
    paths = await fsPickFiles(null);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  if (paths.length === 0) return null;

  let last: InstallResult | null = null;
  for (const path of paths) {
    try {
      last = await installThemeJson(await fsReadFile(path));
    } catch (err) {
      const name = path.split(/[\\/]/).pop() ?? path;
      last = { ok: false, error: `${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (last && !last.ok) return last;
  }
  return last;
}

/**
 * Fetch a theme JSON from a URL, install it, and persist it to
 * `~/.arc/themes/<id>.json` so it survives a restart. Returns the theme on
 * success or an error string on any failure (bad URL, non-2xx, invalid JSON,
 * schema violation).
 */
export async function installThemeFromUrl(url: string): Promise<InstallResult> {
  if (!isTauri) return { ok: false, error: 'theme install requires the Tauri backend' };
  let body: string | null;
  try {
    const res = await httpRequest({
      method: 'GET',
      url,
      headers: [],
      body: { kind: 'none' },
      timeout_ms: 15_000,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `fetch failed: HTTP ${res.status} ${res.status_text}` };
    }
    body = res.body_text;
  } catch (err) {
    return { ok: false, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!body) return { ok: false, error: 'response had no text body' };
  return installThemeJson(body);
}
