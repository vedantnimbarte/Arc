import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

/**
 * Terminal path links (Tier 1.1). Registers an xterm LinkProvider that turns
 * file paths in terminal output (compiler errors, `ls`, test runners) into
 * clickable links that open in the editor — `@xterm/addon-web-links` already
 * handles http(s) URLs, so this deliberately ignores those.
 *
 * Scope of V1: matches within a single (non-wrapped) buffer row. Paths are
 * effectively ASCII, so we map string indices to 1-cell columns directly
 * rather than walking cells for wide-char correction the way web-links does.
 */

export interface ParsedPath {
  /** The path with any trailing `:line:col` stripped. */
  path: string;
  line?: number;
  column?: number;
}

// One token = a run of non-separating chars. Whitespace, quotes, brackets,
// parens, commas and semicolons end a token (they wrap or follow paths in
// real output). Colons are kept so a Windows drive (`C:\`) and a trailing
// `:line:col` survive into parsing.
const TOKEN_RE = /[^\s'"`()[\]<>,;]+/g;
const LINE_COL_RE = /:(\d+)(?::(\d+))?$/;
const URL_RE = /^[a-z][\w+.-]*:\/\//i;
// Accept a token as a path if it contains a separator or ends in a
// letter-led file extension (`.ts`, `.tar.gz`). Requiring the extension to
// start with a letter rejects version-like tokens (`1.2.3`).
const HAS_SEP = /[/\\]/;
const HAS_EXT = /\.[A-Za-z]\w*$/;

/**
 * Parse a single output token into a path + optional line/col, or `null` if
 * it doesn't look like a file path (or is a URL handled elsewhere).
 */
export function parsePathToken(raw: string): ParsedPath | null {
  // Trim trailing sentence punctuation a path wouldn't really end with.
  const token = raw.replace(/[.]+$/, '');
  if (token.length < 2) return null;
  if (URL_RE.test(token)) return null;

  let path = token;
  let line: number | undefined;
  let column: number | undefined;
  const lc = token.match(LINE_COL_RE);
  // Don't treat a bare `C:` drive colon as a line number — the match must
  // leave a real path behind it.
  if (lc && lc.index !== undefined && lc.index >= 2) {
    path = token.slice(0, lc.index);
    line = Number(lc[1]);
    if (lc[2]) column = Number(lc[2]);
  }

  if (!HAS_SEP.test(path) && !HAS_EXT.test(path)) return null;
  return { path, line, column };
}

/**
 * Resolve a (possibly relative) path against the shell's working directory.
 * Returns `null` for `~`-anchored paths we can't expand without a home dir.
 * Collapses `.`/`..` and keeps the separator flavour of whichever side looks
 * Windows-ish.
 */
export function resolveWorkspacePath(base: string | null, target: string): string | null {
  if (target.startsWith('~')) return null;
  const winLike =
    /^[A-Za-z]:[\\/]/.test(target) ||
    (base !== null && (/\\/.test(base) || /^[A-Za-z]:/.test(base)));
  const sep = winLike ? '\\' : '/';
  const isAbs = /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\');
  const abs = isAbs ? target : base ? `${base}${sep}${target}` : null;
  if (!abs) return null;

  let prefix = '';
  let rest = abs;
  const drive = /^([A-Za-z]:)[\\/](.*)$/.exec(abs);
  if (drive) {
    prefix = `${drive[1]}${sep}`;
    rest = drive[2]!;
  } else if (abs.startsWith('/') || abs.startsWith('\\')) {
    prefix = sep;
    rest = abs.slice(1);
  }
  const parts = rest.split(/[\\/]+/).filter((p) => p && p !== '.');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else out.push(p);
  }
  return prefix + out.join(sep);
}

/**
 * Build an xterm LinkProvider for file paths. `getCwd` supplies the base for
 * relative paths; `openPath` is invoked with the resolved absolute path (and
 * the parsed line, when present) on click.
 */
export function createPathLinkProvider(
  term: Terminal,
  getCwd: () => string | null,
  openPath: (absPath: string, line?: number) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const bufferLine = term.buffer.active.getLine(y - 1);
      if (!bufferLine) {
        callback(undefined);
        return;
      }
      const text = bufferLine.translateToString(true);
      const links: ILink[] = [];
      TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN_RE.exec(text)) !== null) {
        const raw = m[0];
        const parsed = parsePathToken(raw);
        if (!parsed) continue;
        const startX = m.index + 1; // 1-based, inclusive
        const endX = m.index + raw.length; // 1-based, inclusive of last cell
        links.push({
          text: raw,
          range: { start: { x: startX, y }, end: { x: endX, y } },
          activate: () => {
            const abs = resolveWorkspacePath(getCwd(), parsed.path);
            if (abs) openPath(abs, parsed.line);
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
