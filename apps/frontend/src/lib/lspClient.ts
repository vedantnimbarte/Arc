// CodeMirror ⇄ LSP glue. Connects the editor to a language server (via the
// `lsp_*` Tauri commands) and surfaces three IDE features: diagnostics
// (squiggles + gutter), hover tooltips, and completion. Position conversion,
// URI building, and content flattening are split into pure helpers so they can
// be unit-tested without a server or the DOM.

import type { Text } from '@codemirror/state';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, showPanel, type Panel } from '@codemirror/view';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import {
  autocompletion,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  lspCompletion,
  lspDefinition,
  lspDidChange,
  lspDidClose,
  lspDidOpen,
  lspFormatting,
  lspHover,
  lspIsRunning,
  lspReferences,
  lspRename,
  lspStart,
  onLspEvent,
  type LspDiagnostic,
  type LspPublishDiagnostics,
} from './tauri';
import type { LspServerConfig } from './lspServers';
import { askText } from '../state/confirm';
import { toast, toastError } from '../state/toast';

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
  /** CM extensions to install (via a compartment) — lint, hover, completion,
   *  navigation keymap, references panel. */
  extensions: Extension[];
  /** Push a full-document change to the server (debounce upstream). */
  didChange: (text: string) => void;
  /** Format the whole buffer in place. Resolves `true` when the server
   *  returned edits that were applied — used by format-on-save, which must
   *  not write the file until formatting has landed in the doc. */
  format: () => Promise<boolean>;
  /** Detach: stop listening + notify the server the document closed. */
  dispose: () => void;
}

/** What the editor must supply for jump-to-file to work: only the caller
 *  knows which pane a target should open in. */
export interface LspNavigator {
  /** `line`/`character` are zero-based, as LSP reports them. */
  (target: LspTarget): void;
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
  navigate: LspNavigator,
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
    return {
      extensions: [],
      didChange: () => {},
      format: async () => false,
      dispose: () => {},
    };
  }

  const unlisten = await onLspEvent(sid, (ev) => {
    if (ev.method !== 'textDocument/publishDiagnostics') return;
    const p = ev.params as LspPublishDiagnostics;
    if (!p || normalizeUri(p.uri) !== normalizeUri(uri)) return;
    const diags = (p.diagnostics ?? []).map((d) => toCmDiagnostic(view, d));
    view.dispatch(setDiagnostics(view.state, diags));
  });

  // ─── actions ────────────────────────────────────────────────────────────
  // Each one is guarded: a server that doesn't implement the request answers
  // with an error, and an editor action failing must never throw into
  // CodeMirror's command dispatch — that leaves the keymap wedged.

  const cursorPosition = (v: EditorView) =>
    offsetToLspPosition(v.state.doc, v.state.selection.main.head);

  const goToDefinition = (v: EditorView): boolean => {
    const { line, character } = cursorPosition(v);
    void (async () => {
      let targets: LspTarget[] = [];
      try {
        targets = locationsToTargets(await lspDefinition(sid, uri, line, character));
      } catch (err) {
        toastError(`Go to definition failed: ${err}`);
        return;
      }
      if (targets.length === 0) {
        toast('No definition found');
        return;
      }
      // Multiple definitions (overloads, a trait plus its impls) are rare
      // enough that the first is the useful answer; the references panel is
      // the surface for "show me all of them".
      navigate(targets[0]!);
    })();
    return true;
  };

  const findReferences = (v: EditorView): boolean => {
    const { line, character } = cursorPosition(v);
    void (async () => {
      let targets: LspTarget[] = [];
      try {
        targets = locationsToTargets(await lspReferences(sid, uri, line, character));
      } catch (err) {
        toastError(`Find references failed: ${err}`);
        return;
      }
      if (targets.length === 0) {
        toast('No references found');
        return;
      }
      v.dispatch({ effects: setReferences.of(targets) });
    })();
    return true;
  };

  const renameSymbol = (v: EditorView): boolean => {
    const { line, character } = cursorPosition(v);
    // The word under the cursor seeds the prompt, so the common case is
    // "edit a few characters" rather than "retype the whole identifier".
    const word = v.state.wordAt(v.state.selection.main.head);
    const current = word ? v.state.sliceDoc(word.from, word.to) : '';
    void (async () => {
      const next = await askText(
        'Rename symbol',
        { label: 'New name', value: current, placeholder: current },
        'rename',
      );
      if (next === null || next === '' || next === current) return;
      let edit: unknown;
      try {
        edit = await lspRename(sid, uri, line, character, next);
      } catch (err) {
        toastError(`Rename failed: ${err}`);
        return;
      }
      const files = workspaceEditToFileEdits(edit);
      if (files.length === 0) {
        toast('Nothing to rename');
        return;
      }
      // ARC applies edits to the buffer it owns. A rename that reaches other
      // files is reported rather than silently half-applied: writing files
      // that aren't even open, behind the user's back and with no diff to
      // look at, is not something an editor should do on an F2 press.
      const here = files.find((f) => normalizeUri(pathToFileUri(f.path)) === normalizeUri(uri));
      const elsewhere = files.filter((f) => f !== here);
      if (here) {
        const changes = lspEditsToChanges(v.state.doc, here.edits);
        if (changes.length > 0) v.dispatch({ changes });
      }
      if (elsewhere.length > 0) {
        const names = elsewhere.map((f) => baseName(f.path)).join(', ');
        toast(`Renamed here. ${elsewhere.length} other file(s) reference it: ${names}`);
      }
    })();
    return true;
  };

  const format = async (): Promise<boolean> => {
    let edits: LspTextEdit[] = [];
    try {
      edits = coerceTextEdits(await lspFormatting(sid, uri, FORMAT_TAB_SIZE, true));
    } catch {
      // No formatting provider, or the server errored — leave the buffer be.
      return false;
    }
    if (edits.length === 0) return false;
    const changes = lspEditsToChanges(view.state.doc, edits);
    if (changes.length === 0) return false;
    view.dispatch({ changes });
    return true;
  };

  // References panel state. Defined per attachment so each editor owns its
  // own list and `navigate` stays in scope.
  const setReferences = StateEffect.define<LspTarget[] | null>();
  const referencesField = StateField.define<LspTarget[] | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setReferences)) return e.value;
      }
      return value;
    },
    provide: (f) =>
      showPanel.from(f, (targets) =>
        targets ? (v: EditorView) => referencesPanel(v, targets, navigate, setReferences) : null,
      ),
  });

  const extensions: Extension[] = [
    referencesField,
    keymap.of([
      { key: 'F12', run: goToDefinition },
      { key: 'Shift-F12', run: findReferences },
      { key: 'F2', run: renameSymbol },
      {
        key: 'Shift-Alt-f',
        run: (v) => {
          void format().then((ok) => {
            if (!ok) toast('No formatter available for this file');
            v.focus();
          });
          return true;
        },
      },
      {
        key: 'Escape',
        run: (v) => {
          // Only claim Escape while the panel is open, so it keeps closing
          // autocomplete and clearing selections the rest of the time.
          if (v.state.field(referencesField, false) == null) return false;
          v.dispatch({ effects: setReferences.of(null) });
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, v) {
        // ⌘/Ctrl+click → definition, the gesture everyone expects. Left
        // button only, and on macOS the modifier is ⌘ specifically: ctrl+click
        // there is a right-click, which must keep opening the context menu.
        if (event.button !== 0) return false;
        const isMod = isMacPlatform() ? event.metaKey : event.ctrlKey;
        if (!isMod) return false;
        const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        v.dispatch({ selection: { anchor: pos } });
        goToDefinition(v);
        return true;
      },
    }),
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
    format,
    dispose: () => {
      unlisten();
      void lspDidClose(sid, uri).catch(() => {});
    },
  };
}

/** Indentation reported to the server's formatter. ARC has no per-language
 *  indent setting and CodeMirror's default `indentUnit` is two spaces.
 *  ponytail: hardcoded; read the `indentUnit` facet instead if a per-language
 *  indent setting ever lands. */
const FORMAT_TAB_SIZE = 2;

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac/i.test(navigator.platform);
}

/** Last path segment, for either separator. */
function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** The references list, rendered as a CodeMirror bottom panel. Clicking a row
 *  jumps to it and leaves the panel open, so the next one is one click away. */
function referencesPanel(
  view: EditorView,
  targets: LspTarget[],
  navigate: LspNavigator,
  setReferences: ReturnType<typeof StateEffect.define<LspTarget[] | null>>,
): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-lsp-references';

  const header = document.createElement('div');
  header.className = 'cm-lsp-references-header';
  const count = document.createElement('span');
  count.textContent = `${targets.length} reference${targets.length === 1 ? '' : 's'}`;
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Close (esc)';
  close.setAttribute('aria-label', 'Close references');
  close.onclick = () => view.dispatch({ effects: setReferences.of(null) });
  header.append(count, close);
  dom.appendChild(header);

  const list = document.createElement('div');
  list.className = 'cm-lsp-references-list';
  for (const t of targets) {
    const row = document.createElement('button');
    row.className = 'cm-lsp-references-row';
    const name = document.createElement('span');
    name.className = 'cm-lsp-references-file';
    // Displayed one-based; LSP counts lines from zero.
    name.textContent = `${baseName(t.path)}:${t.line + 1}`;
    const dir = document.createElement('span');
    dir.className = 'cm-lsp-references-dir';
    dir.textContent = t.path;
    row.append(name, dir);
    row.onclick = () => navigate(t);
    list.appendChild(row);
  }
  dom.appendChild(list);

  // Panels dock to the bottom unless `top` is set — which is where a
  // references list belongs, out of the way of the code.
  return { dom };
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

// ─── navigation / rename / formatting ───────────────────────────────────────
//
// The transport for these has existed since the LSP client landed; what was
// missing is the shaping between LSP's several result encodings and the flat
// structures the editor wants. All of it is pure, so the awkward parts (three
// shapes of "definition", two shapes of WorkspaceEdit) are unit-tested.

/** A resolved jump target: an absolute path plus a zero-based position. */
export interface LspTarget {
  path: string;
  line: number;
  character: number;
}

/** One LSP TextEdit. */
export interface LspTextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

/** Inverse of `pathToFileUri`. Returns the input unchanged when it isn't a
 *  file URI, so callers can pass either form. */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let p = decodeURIComponent(uri.slice('file://'.length));
  // Drop an authority component: file://host/path -> /path
  const slash = p.indexOf('/');
  if (slash > 0) p = p.slice(slash);
  // Windows: /C:/Users/... -> C:/Users/...
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

/**
 * Flatten a `textDocument/definition` (or `references`) result.
 *
 * Servers return any of three shapes for definition — a single Location, an
 * array of Locations, or an array of LocationLinks (which name the range
 * `targetSelectionRange`/`targetRange` and the uri `targetUri`). rust-analyzer
 * sends LocationLinks, tsserver sends Locations; both have to work.
 */
export function locationsToTargets(result: unknown): LspTarget[] {
  if (!result) return [];
  const raw = Array.isArray(result) ? result : [result];
  const out: LspTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const uri = typeof r.uri === 'string' ? r.uri : typeof r.targetUri === 'string' ? r.targetUri : null;
    if (!uri) continue;
    // Prefer the selection range (the identifier itself) over the full target
    // range (the whole item, which would land the cursor on a doc comment).
    const range = (r.targetSelectionRange ?? r.targetRange ?? r.range) as
      | { start?: { line?: unknown; character?: unknown } }
      | undefined;
    const start = range?.start;
    const line = typeof start?.line === 'number' ? start.line : 0;
    const character = typeof start?.character === 'number' ? start.character : 0;
    out.push({ path: fileUriToPath(uri), line, character });
  }
  return out;
}

/**
 * Flatten a `WorkspaceEdit` into per-file edit lists.
 *
 * Two encodings exist and servers pick either: the `changes` map (uri → edits)
 * or the newer `documentChanges` array of TextDocumentEdits. `documentChanges`
 * may also carry create/rename/delete file operations, which have no `edits`
 * array — those are skipped rather than mis-parsed, since ARC only applies
 * edits to files it has open.
 */
export function workspaceEditToFileEdits(
  result: unknown,
): Array<{ path: string; edits: LspTextEdit[] }> {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const out: Array<{ path: string; edits: LspTextEdit[] }> = [];

  const docChanges = r.documentChanges;
  if (Array.isArray(docChanges)) {
    for (const dc of docChanges) {
      if (!dc || typeof dc !== 'object') continue;
      const d = dc as Record<string, unknown>;
      // File operations (`kind: 'create' | 'rename' | 'delete'`) have no edits.
      if (!Array.isArray(d.edits)) continue;
      const uri = (d.textDocument as Record<string, unknown> | undefined)?.uri;
      if (typeof uri !== 'string') continue;
      const edits = coerceTextEdits(d.edits);
      if (edits.length > 0) out.push({ path: fileUriToPath(uri), edits });
    }
    if (out.length > 0) return out;
  }

  const changes = r.changes;
  if (changes && typeof changes === 'object') {
    for (const [uri, edits] of Object.entries(changes as Record<string, unknown>)) {
      const coerced = coerceTextEdits(edits);
      if (coerced.length > 0) out.push({ path: fileUriToPath(uri), edits: coerced });
    }
  }
  return out;
}

function coerceTextEdits(raw: unknown): LspTextEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: LspTextEdit[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const range = r.range as LspTextEdit['range'] | undefined;
    if (
      typeof range?.start?.line !== 'number' ||
      typeof range?.start?.character !== 'number' ||
      typeof range?.end?.line !== 'number' ||
      typeof range?.end?.character !== 'number'
    ) {
      continue;
    }
    // An AnnotatedTextEdit adds `annotationId` but is otherwise a TextEdit.
    out.push({ range, newText: typeof r.newText === 'string' ? r.newText : '' });
  }
  return out;
}

/**
 * Convert LSP edits into CodeMirror changes against `doc`.
 *
 * Offsets are all computed against the *original* document — that's the
 * coordinate system CodeMirror's changeset expects, so the edits must not be
 * pre-applied one at a time. They're sorted ascending because CodeMirror
 * requires that, and any edit overlapping its predecessor is dropped: LSP
 * forbids overlaps within one edit list, and applying one anyway would throw
 * and lose the whole rename.
 */
export function lspEditsToChanges(
  doc: Text,
  edits: LspTextEdit[],
): Array<{ from: number; to: number; insert: string }> {
  const mapped = edits
    .map((e) => ({
      from: lspPositionToOffset(doc, e.range.start.line, e.range.start.character),
      to: lspPositionToOffset(doc, e.range.end.line, e.range.end.character),
      insert: e.newText,
    }))
    .map((c) => (c.to < c.from ? { ...c, to: c.from } : c))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const out: Array<{ from: number; to: number; insert: string }> = [];
  let lastTo = -1;
  for (const c of mapped) {
    if (c.from < lastTo) continue; // overlaps the previous edit — skip it
    out.push(c);
    lastTo = c.to;
  }
  return out;
}
