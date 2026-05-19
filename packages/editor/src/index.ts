// Editor package — file→language detection + (eventually) the
// CodeMirror wrapper itself.
//
// The actual `@codemirror/lang-*` imports stay in apps/frontend so each
// language ships as its own Vite chunk. This package only owns the
// extension→id mapping so a second consumer (e.g. a diff view) can
// resolve the same language id without duplicating the table.

/**
 * Stable identifier for the language a CodeMirror lang-* package would
 * produce. Matches the package suffix (`'rust'` for `@codemirror/lang-rust`).
 *
 * Specific notable cases:
 *  - `'javascript-jsx'` / `'typescript-jsx'` distinguish JSX/TSX from plain
 *    JS/TS, because the lang-javascript package takes flags for them.
 *  - `'plain'` is returned for files we recognise but don't have a grammar
 *    for (Dockerfile, Makefile, TOML…). The Editor renders them with
 *    syntax-free highlighting.
 *  - `null` means "no opinion" — defer to the Editor's default.
 */
export type LanguageId =
  | 'javascript'
  | 'javascript-jsx'
  | 'typescript'
  | 'typescript-jsx'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'python'
  | 'rust'
  | 'cpp'
  | 'go'
  | 'yaml'
  | 'sql'
  | 'xml'
  | 'php'
  | 'java'
  | 'plain';

/**
 * Resolve a file path to its language id. Returns `null` for files the
 * Editor should treat as plain text (no language hint).
 */
export function pathToLanguageId(path: string): LanguageId | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('dockerfile') || lower.endsWith('/dockerfile')) return 'plain';
  if (lower.endsWith('makefile') || lower.endsWith('/makefile')) return 'plain';

  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot + 1);

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascript-jsx';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'typescript-jsx';
    case 'json':
    case 'jsonc':
    case 'json5':
      return 'json';
    case 'html':
    case 'htm':
      return 'html';
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return 'css';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hpp':
    case 'hh':
      return 'cpp';
    case 'go':
      return 'go';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sql':
      return 'sql';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'php':
      return 'php';
    case 'java':
      return 'java';
    case 'toml':
      return 'plain';
    default:
      return null;
  }
}
