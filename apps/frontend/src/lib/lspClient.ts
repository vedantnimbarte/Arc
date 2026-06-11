// CodeMirror ⇄ LSP glue. Connects the editor to a language server (via the
// `lsp_*` Tauri commands) and surfaces three IDE features: diagnostics
// (squiggles + gutter), hover tooltips, and completion. Position conversion,
// URI building, and content flattening are split into pure helpers so they can
// be unit-tested without a server or the DOM.

import type { Text } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import {
  autocompletion,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  lspCompletion,
  lspDidChange,
  lspDidClose,
  lspDidOpen,
  lspHover,
  lspIsRunning,
  lspStart,
  onLspEvent,
  type LspDiagnostic,
  type LspPublishDiagnostics,
} from './tauri';
import type { LspServerConfig } from './lspServers';

// ─── pure helpers (unit-tested) ─────────────────────────────────────────────

/** Convert a filesystem path to a `file://` URI. Handles Windows drive paths
 *  (`C:\a\b` → `file:///C:/a/b`) and POSIX paths (`/a/b` → `file:///a/b`). */
export function pathToFileUri(path: string): string {
  let p = path.replace(/\\/g, '/');
  // Windows drive path: ensure a leading slash before the drive letter.
  if (/^[a-zA-Z]:\//.test(p)) p = '/' + p;
  // Encode each segment but keep slashes and the drive colon readable.
  const encoded = p
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return 'file://' + encoded;
}

/** Normalize a file URI for comparison — lowercases the scheme/drive and
 *  decodes, so two spellings of the same file match. */
export function normalizeUri(uri: string): string {
  try {
    return decodeURIComponent(uri).replace(/\\/g, '/').toLowerCase();
  } catch {
    return uri.replace(/\\/g, '/').toLowerCase();
  }
}

/** LSP severity (1 error … 4 hint) → CodeMirror lint severity. */
export function cmSeverityFor(sev?: number): Diagnostic['severity'] {
  switch (sev) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    default:
      return 'info';
  }
}

/** 0-based LSP position → document offset, clamped to valid bounds. */
export function lspPositionToOffset(doc: Text, line: number, character: number): number {
  const lineNo = Math.max(1, Math.min(line + 1, doc.lines));
  const l = doc.line(lineNo);
  return Math.min(l.from + Math.max(0, character), l.to);
}

/** Document offset → 0-based LSP position. */
export function offsetToLspPosition(doc: Text, offset: number): { line: number; character: number } {
  const clamped = Math.max(0, Math.min(offset, doc.length));
  const l = doc.lineAt(clamped);
  return { line: l.number - 1, character: clamped - l.from };
}

/** Flatten an LSP `Hover.contents` (string | MarkedString | MarkupContent |
 *  array thereof) into plain display text. */
export function hoverContentsToText(hover: unknown): string {
  if (!hover || typeof hover !== 'object') return '';
  const contents = (hover as { contents?: unknown }).contents;
  return markupToText(contents).trim();
}

function markupToText(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(markupToText).filter(Boolean).join('\n\n');
  if (typeof c === 'object') {
    const o = c as { value?: unknown };
    if (typeof o.value === 'string') return o.value;
  }
  return '';
}

/** LSP CompletionItemKind → CodeMirror completion `type` (drives the icon). */
export function cmCompletionType(kind?: number): string {
  // 2 method, 3 function, 4 constructor → function; 5 field, 6 variable →
  // variable/property; 7 class, 8 interface → class/interface; 14 keyword.
  switch (kind) {
    case 2:
    case 3:
    case 4:
      return 'function';
    case 5:
      return 'property';
    case 6:
      return 'variable';
    case 7:
      return 'class';
    case 8:
      return 'interface';
    case 9:
      return 'namespace';
    case 10:
      return 'property';
    case 13:
      return 'enum';
    case 14:
      return 'keyword';
    case 21:
      return 'constant';
    default:
      return 'text';
  }
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  sortText?: string;
}

/** Map an LSP completion result (CompletionItem[] | CompletionList) to CM
 *  completions. Pure so the shaping is testable. */
export function lspItemsToCompletions(result: unknown): Completion[] {
  const items: LspCompletionItem[] = Array.isArray(result)
    ? (result as LspCompletionItem[])
    : ((result as { items?: LspCompletionItem[] })?.items ?? []);
  return items
    .filter((it) => it && typeof it.label === 'string')
    .slice(0, 200)
    .map((it) => ({
      label: it.label,
      type: cmCompletionType(it.kind),
      detail: it.detail,
      apply: it.insertText ?? it.label,
    }));
}

// ─── live integration ───────────────────────────────────────────────────────

/** A guard against starting the same server twice when several files of one
 *  language open at once within a window. */
const starting = new Set<string>();

/** A handle on a document's LSP attachment. */
export interface LspAttachment {
  /** CM extensions to install (via a compartment) — lint, hover, completion. */
  extensions: Extension[];
  /** Push a full-document change to the server (debounce upstream). */
  didChange: (text: string) => void;
  /** Detach: stop listening + notify the server the document closed. */
  dispose: () => void;
}

/**
 * Connect `view` (showing `filePath`) to its language `server`. Starts the
 * server if needed, opens the document, wires diagnostics → the editor, and
 * returns the CM extensions for hover + completion plus a lifecycle handle.
 */
export async function attachLsp(
  view: EditorView,
  server: LspServerConfig,
  filePath: string,
  rootUri: string | null,
): Promise<LspAttachment> {
  const uri = pathToFileUri(filePath);
  const sid = server.sessionId;
  let version = 1;

  try {
    if (!(await lspIsRunning(sid)) && !starting.has(sid)) {
      starting.add(sid);
      try {
        await lspStart(sid, server.command, server.args, rootUri);
      } finally {
        starting.delete(sid);
      }
    }
    await lspDidOpen(sid, uri, server.languageId, version, view.state.doc.toString());
  } catch (err) {
    // Server missing / not on PATH / crashed on init — degrade to a plain
    // editor rather than throwing into the mount path.
    console.warn(`[lsp] ${sid} unavailable:`, err);
    return { extensions: [], didChange: () => {}, dispose: () => {} };
  }

  const unlisten = await onLspEvent(sid, (ev) => {
    if (ev.method !== 'textDocument/publishDiagnostics') return;
    const p = ev.params as LspPublishDiagnostics;
    if (!p || normalizeUri(p.uri) !== normalizeUri(uri)) return;
    const diags = (p.diagnostics ?? []).map((d) => toCmDiagnostic(view, d));
    view.dispatch(setDiagnostics(view.state, diags));
  });

  const extensions: Extension[] = [
    lintGutter(),
    hoverTooltip(async (v, pos) => {
      const { line, character } = offsetToLspPosition(v.state.doc, pos);
      let res: unknown;
      try {
        res = await lspHover(sid, uri, line, character);
      } catch {
        return null;
      }
      const text = hoverContentsToText(res);
      if (!text) return null;
      return {
        pos,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-lsp-hover';
          dom.textContent = text;
          return { dom };
        },
      };
    }),
    autocompletion({ override: [makeCompletionSource(sid, uri)] }),
  ];

  return {
    extensions,
    didChange: (text: string) => {
      version += 1;
      void lspDidChange(sid, uri, version, text).catch(() => {});
    },
    dispose: () => {
      unlisten();
      void lspDidClose(sid, uri).catch(() => {});
    },
  };
}

function toCmDiagnostic(view: EditorView, d: LspDiagnostic): Diagnostic {
  const doc = view.state.doc;
  const from = lspPositionToOffset(doc, d.range.start.line, d.range.start.character);
  const to = lspPositionToOffset(doc, d.range.end.line, d.range.end.character);
  return {
    from,
    to: Math.max(from, to),
    severity: cmSeverityFor(d.severity),
    message: d.source ? `${d.message}  (${d.source})` : d.message,
    source: d.source,
  };
}

function makeCompletionSource(sid: string, uri: string): CompletionSource {
  return async (context) => {
    const word = context.matchBefore(/[\w$]+/);
    // Only auto-trigger on a word or an explicit invocation — avoids a request
    // on every keystroke in whitespace.
    if (!context.explicit && !word) return null;
    const { line, character } = offsetToLspPosition(context.state.doc, context.pos);
    let res: unknown;
    try {
      res = await lspCompletion(sid, uri, line, character);
    } catch {
      return null;
    }
    const options = lspItemsToCompletions(res);
    if (options.length === 0) return null;
    return {
      from: word ? word.from : context.pos,
      options,
      validFor: /[\w$]*/,
    };
  };
}
