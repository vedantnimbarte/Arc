// Built-in registry mapping a CodeMirror language id (from `@arc/editor`'s
// `pathToLanguageId`) to the language server that handles it. Pure + data-only
// so it can be unit-tested and reasoned about without the editor.
//
// These are the conventional stdio servers; the user must have them installed
// and on PATH. LSP is opt-in (Settings → Editor) precisely because it depends
// on external binaries. Servers are keyed by a stable `sessionId` so every
// file of a family (e.g. .ts/.tsx/.js/.jsx) shares one running server.

export interface LspServerConfig {
  /** Stable session key — shared by all CM language ids this server handles,
   *  so one server process serves the whole family. */
  sessionId: string;
  /** Executable to spawn (looked up on PATH). */
  command: string;
  /** Arguments — typically the server's stdio flag. */
  args: string[];
  /** LSP `languageId` to advertise in `textDocument/didOpen` (NOT the CM id). */
  languageId: string;
}

function tsServer(languageId: string): LspServerConfig {
  return {
    sessionId: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId,
  };
}

/** CM language id → server. Absent entries mean "no LSP for this language". */
const REGISTRY: Record<string, LspServerConfig> = {
  typescript: tsServer('typescript'),
  'typescript-jsx': tsServer('typescriptreact'),
  javascript: tsServer('javascript'),
  'javascript-jsx': tsServer('javascriptreact'),
  python: {
    sessionId: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    languageId: 'python',
  },
  rust: { sessionId: 'rust-analyzer', command: 'rust-analyzer', args: [], languageId: 'rust' },
  go: { sessionId: 'gopls', command: 'gopls', args: [], languageId: 'go' },
  cpp: { sessionId: 'clangd', command: 'clangd', args: [], languageId: 'cpp' },
};

/** Resolve the language server for a CM language id, or null if none is known.
 *  `overrides` (from settings, keyed by sessionId) can swap the command/args
 *  so a user can point at a differently-named or wrapped binary. */
export function lspServerFor(
  cmLanguageId: string | null,
  overrides?: Record<string, { command?: string; args?: string[] }>,
): LspServerConfig | null {
  if (!cmLanguageId) return null;
  const base = REGISTRY[cmLanguageId];
  if (!base) return null;
  const ov = overrides?.[base.sessionId];
  if (!ov) return base;
  return {
    ...base,
    command: ov.command ?? base.command,
    args: ov.args ?? base.args,
  };
}

/** All language ids that have a registered server — for docs / settings UI. */
export function lspSupportedLanguages(): string[] {
  return Object.keys(REGISTRY);
}
