import {
  fsCreateDir,
  fsDefaultRoot,
  fsReadDir,
  fsReadFile,
  fsWriteFile,
  httpRequest,
  isTauri,
} from './tauri';
import { registerTheme, validateThemeJson, type ThemeDef } from '../themes';

// User-installed themes live in `<home>/.arc/themes/*.json` (Tier 1.7). These
// load on boot and any "Install from URL" theme is written here so it sticks.

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
      const raw = await fsReadFile(e.path);
      const parsed = validateThemeJson(JSON.parse(raw));
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

/**
 * Fetch a theme JSON from a URL, validate it, register it, and persist it to
 * `~/.arc/themes/<id>.json` so it survives a restart. Returns the theme on
 * success or an error string on any failure (bad URL, non-2xx, invalid JSON,
 * schema violation).
 */
export async function installThemeFromUrl(
  url: string,
): Promise<{ ok: true; theme: ThemeDef } | { ok: false; error: string }> {
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

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: 'response was not valid JSON' };
  }
  const parsed = validateThemeJson(json);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  registerTheme(parsed.theme);

  // Persist — failure here doesn't undo the in-memory registration, the theme
  // just won't survive a restart.
  const dir = await themesDir();
  if (dir) {
    try {
      await fsCreateDir(dir);
      const sep = dir.includes('\\') ? '\\' : '/';
      const slug = parsed.theme.id.replace(/[^\w.-]/g, '_');
      await fsWriteFile(`${dir}${sep}${slug}.json`, JSON.stringify(parsed.theme, null, 2));
    } catch (err) {
      console.warn('[themes] could not persist installed theme:', err);
    }
  }
  return { ok: true, theme: parsed.theme };
}
