import { parsePathToken, resolveWorkspacePath } from './links';

/** Fence names agents write that aren't already a file extension
 *  `pathToLanguageId` knows (`typescript`, `python`, `golang`, …). */
const FENCE_ALIASES: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  python3: 'py',
  rust: 'rs',
  golang: 'go',
  'c++': 'cpp',
  markdown: 'md',
  yml: 'yaml',
  jsonc: 'json',
};

/**
 * A stand-in filename for a fenced code block's language (```` ```ts ```` →
 * `snippet.ts`), so the editor's own extension table picks the grammar and
 * the two never disagree. The info string may carry more than the name
 * (```` ```rust title="x" ````); only the first word counts.
 */
export function fenceLanguageFile(info: string): string {
  const name = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return `snippet.${FENCE_ALIASES[name] ?? name}`;
}

export interface ChatPathTarget {
  /** Absolute path the text resolves to. */
  path: string;
  line?: number;
  column?: number;
}

/**
 * Whether an inline code span like `src/app.ts:42` names a file, and where it
 * resolves against the workspace root. Only whole spans count: `` `cd src` ``
 * or `` `npm run build` `` are commands, not paths, and a URL is a link.
 * Existence is checked separately — this only says what the text would mean.
 */
export function inlineCodeTarget(text: string, root: string | null): ChatPathTarget | null {
  const trimmed = text.trim();
  if (!root || !trimmed || /\s/.test(trimmed)) return null;
  const parsed = parsePathToken(trimmed);
  if (!parsed) return null;
  const path = resolveWorkspacePath(root, parsed.path);
  if (!path) return null;
  return { path, line: parsed.line, column: parsed.column };
}

/** Split an absolute path into its directory and file name, either separator. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut) || path.slice(0, 1), name: path.slice(cut + 1) };
}
