import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { history, historyKeymap, redo, undo } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { pathToLanguageId } from '@arc/editor';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  AlertCircle,
  FileWarning,
  Save,
  Undo2,
  Redo2,
  CheckCircle2,
  Code2,
  Eye,
  Columns2,
} from 'lucide-react';
import { fileIcon, MOCHA } from '../lib/fileIcons';
import { fsReadFile, fsWriteFile, isTauri } from '../lib/tauri';
import { useSelection } from '../state/selection';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  filePath: string;
  /** Workspace tab id — used to publish dirty state for the tab indicator. */
  tabId: string;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'saved'; at: number };

type Mode = 'code' | 'preview' | 'split';

export function Editor({ filePath, tabId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const lastSavedRef = useRef<string>('');
  /** Live mirror of the file's text. The CodeMirror update listener writes
   *  to it on every doc change; saves and preview renders both read from
   *  it. The preview pane is read-only, so this only flows one direction. */
  const currentSourceRef = useRef<string>('');
  /** Mirrors `mode` for the CodeMirror update listener, whose closure is
   *  captured at mount time. Lets the listener re-render the preview pane
   *  on doc changes when we're in preview or split mode without recreating
   *  the editor. */
  const modeRef = useRef<Mode>('code');
  /** Coalesces preview re-renders across bursts of CM keystrokes. */
  const previewFrameRef = useRef<number | null>(null);
  const setTabDirty = useWorkspace((s) => s.setTabDirty);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [dirty, setDirty] = useState(false);
  const [mode, setModeState] = useState<Mode>('code');

  const isMarkdown = useMemo(() => /\.(md|markdown|mdx)$/i.test(filePath), [filePath]);

  /** Render `currentSourceRef` into the preview pane (no-op if the pane
   *  isn't mounted). Safe to call every keystroke — synchronous marked +
   *  DOMPurify takes well under a frame for typical .md files. */
  const renderPreview = useCallback(() => {
    if (!previewRef.current) return;
    previewRef.current.innerHTML = markdownToSafeHtml(currentSourceRef.current);
  }, []);

  /** rAF-throttled preview render — used by the CodeMirror update
   *  listener so a burst of keystrokes only re-renders once per frame. */
  const schedulePreviewRender = useCallback(() => {
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      renderPreview();
    });
  }, [renderPreview]);

  /** Mode setter that handles the side effect of seeding the preview pane
   *  when we enter a mode that shows it. */
  const setMode = useCallback(
    (next: Mode) => {
      modeRef.current = next;
      setModeState(next);
      if (next === 'preview' || next === 'split') {
        // Render synchronously on enter so the pane doesn't flash empty.
        renderPreview();
      }
    },
    [renderPreview],
  );

  /** Stable ref so the keymap closure always sees the latest save fn. */
  const saveRef = useRef<() => Promise<void>>(async () => {});

  saveRef.current = useCallback(async () => {
    if (!isTauri) {
      setStatus({ kind: 'error', message: 'saving requires the Tauri backend' });
      return;
    }
    const content = currentSourceRef.current;
    setStatus({ kind: 'saving' });
    try {
      await fsWriteFile(filePath, content);
      lastSavedRef.current = content;
      setDirty(false);
      setTabDirty(tabId, false);
      setStatus({ kind: 'saved', at: Date.now() });
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) });
    }
  }, [filePath, tabId, setTabDirty]);

  // Mount: read file → build editor.
  useEffect(() => {
    let disposed = false;
    setStatus({ kind: 'loading' });
    setDirty(false);
    modeRef.current = 'code';
    setModeState('code');
    setTabDirty(tabId, false);

    const boot = async () => {
      if (!isTauri) {
        setStatus({ kind: 'error', message: 'File loading requires the Tauri backend.' });
        return;
      }
      try {
        const content = await fsReadFile(filePath);
        if (disposed || !containerRef.current) return;

        viewRef.current?.destroy();
        lastSavedRef.current = content;
        currentSourceRef.current = content;

        const saveKeymap = keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void saveRef.current();
              return true;
            },
          },
        ]);

        viewRef.current = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              basicSetup, // includes history (undo/redo), defaultKeymap
              history(),  // explicit — basicSetup already includes it but
                          // being explicit makes intent clear
              keymap.of(historyKeymap),
              saveKeymap,
              EditorView.lineWrapping,
              // Register as the PRIMARY (non-fallback) highlighter. basicSetup
              // also ships `defaultHighlightStyle` as a fallback; if ours were
              // also `{ fallback: true }` the two would tie and the
              // higher-precedence default (light-theme #708/#a11 colors) would
              // win, rendering dim, unreadable text on our dark background.
              // A non-fallback highlighter makes CodeMirror ignore every
              // fallback, so the Mocha palette below is what actually paints.
              syntaxHighlighting(catppuccinHighlight),
              macTheme,
              langCompartment.current.of([]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  const current = u.state.doc.toString();
                  currentSourceRef.current = current;
                  const isDirty = current !== lastSavedRef.current;
                  setDirty(isDirty);
                  setTabDirty(tabId, isDirty);
                  // Keep the preview pane live in preview / split modes.
                  if (modeRef.current !== 'code') schedulePreviewRender();
                }
                if (u.selectionSet || u.docChanged) {
                  const sel = u.state.selection.main;
                  if (sel.empty) {
                    useSelection.getState().clear('editor', tabId);
                  } else {
                    const text = u.state.sliceDoc(sel.from, sel.to);
                    // Anchor the floating pill to the selection head — that's
                    // where the cursor lives after a drag-select, so it
                    // matches the user's gaze.
                    const coords = u.view.coordsAtPos(sel.head);
                    const rect = coords
                      ? {
                          left: coords.left,
                          top: coords.top,
                          width: 0,
                          height: Math.max(0, coords.bottom - coords.top),
                        }
                      : null;
                    const fileName =
                      filePath.split(/[\\/]/).pop() || filePath;
                    useSelection.getState().set({
                      source: 'editor',
                      sourceId: tabId,
                      label: `Editor · ${fileName}`,
                      text,
                      rect,
                    });
                  }
                }
              }),
            ],
          }),
          parent: containerRef.current,
        });

        // Load the language extension (dynamic import for code-splitting).
        const langExt = await loadLanguage(filePath);
        if (!disposed && langExt && viewRef.current) {
          viewRef.current.dispatch({
            effects: langCompartment.current.reconfigure(langExt),
          });
        }

        if (!disposed) setStatus({ kind: 'ready' });
      } catch (err) {
        if (!disposed) setStatus({ kind: 'error', message: String(err) });
      }
    };

    void boot();

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      useSelection.getState().clear('editor', tabId);
    };
  }, [filePath, tabId, setTabDirty]);

  useEffect(() => {
    return () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    };
  }, []);

  /** Bidirectional, ratio-based scroll sync between the code and preview
   *  panes while in split mode. We don't try to map markdown lines to
   *  rendered blocks (that's a lot more code for a marginal accuracy win
   *  on most docs) — instead each side scrolls to the same fractional
   *  position within its own scroll range. */
  useEffect(() => {
    if (mode !== 'split') return;
    const cm = viewRef.current;
    const codeEl = cm?.scrollDOM ?? null;
    const previewEl = previewRef.current;
    if (!codeEl || !previewEl) return;

    let syncing = false;
    const syncFrom = (src: HTMLElement, dst: HTMLElement) => {
      if (syncing) return;
      const srcRange = src.scrollHeight - src.clientHeight;
      const dstRange = dst.scrollHeight - dst.clientHeight;
      if (srcRange <= 0 || dstRange <= 0) return;
      const ratio = src.scrollTop / srcRange;
      syncing = true;
      dst.scrollTop = ratio * dstRange;
      // The flag is cleared on the next frame — long enough for the
      // browser to fire the resulting scroll event without bouncing back.
      requestAnimationFrame(() => {
        syncing = false;
      });
    };

    const onCodeScroll = () => syncFrom(codeEl, previewEl);
    const onPreviewScroll = () => syncFrom(previewEl, codeEl);
    codeEl.addEventListener('scroll', onCodeScroll, { passive: true });
    previewEl.addEventListener('scroll', onPreviewScroll, { passive: true });
    return () => {
      codeEl.removeEventListener('scroll', onCodeScroll);
      previewEl.removeEventListener('scroll', onPreviewScroll);
    };
  }, [mode, status.kind]);

  const { Icon, color } = fileIcon(basename(filePath));
  const showCode = mode === 'code' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <div className="flex h-full flex-col">
      {/* Header: file icon · name · path · undo · redo · save status · save button */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-hairline bg-bg-chrome/40 px-3 backdrop-blur-md">
        <Icon size={12} strokeWidth={1.8} style={{ color }} />
        <span className="font-display text-[12px] font-medium tracking-tight text-fg-base">
          {basename(filePath)}
        </span>
        {dirty && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm"
            title="Unsaved changes"
          />
        )}
        <span className="hidden truncate font-mono text-[10px] text-fg-subtle md:inline" title={filePath}>
          · {filePath}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {isMarkdown && (
            <div
              role="tablist"
              aria-label="Markdown view"
              className="mr-1 flex items-center gap-0.5 rounded-md bg-white/[0.05] p-0.5"
            >
              {(
                [
                  { id: 'code', label: 'code', Icon: Code2, title: 'Edit markdown source' },
                  { id: 'split', label: 'split', Icon: Columns2, title: 'Source + rendered side-by-side' },
                  { id: 'preview', label: 'preview', Icon: Eye, title: 'Rendered preview (read-only)' },
                ] as const
              ).map(({ id, label, Icon: TabIcon, title }) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={mode === id}
                  onClick={() => mode !== id && setMode(id)}
                  className={cn(
                    'flex h-5 items-center gap-1 rounded px-1.5 font-display text-[10.5px] font-medium tracking-tight transition-colors duration-150',
                    mode === id
                      ? 'bg-white/[0.10] text-fg-base'
                      : 'text-fg-muted hover:text-fg-base',
                  )}
                  title={title}
                >
                  <TabIcon size={10} strokeWidth={2.1} />
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => viewRef.current && undo(viewRef.current)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40"
            aria-label="Undo"
            title="Undo (⌘Z)"
            disabled={mode === 'preview'}
          >
            <Undo2 size={12} strokeWidth={2} />
          </button>
          <button
            onClick={() => viewRef.current && redo(viewRef.current)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40"
            aria-label="Redo"
            title="Redo (⇧⌘Z)"
            disabled={mode === 'preview'}
          >
            <Redo2 size={12} strokeWidth={2} />
          </button>

          <StatusLabel status={status} dirty={dirty} />

          <button
            onClick={() => void saveRef.current()}
            disabled={!dirty || status.kind === 'saving'}
            className={cn(
              'ml-1 flex h-6 items-center gap-1 rounded-md px-2 font-display text-[11px] font-medium tracking-tight transition-colors duration-150',
              dirty && status.kind !== 'saving'
                ? 'surface-silver active:scale-[0.97]'
                : 'bg-white/[0.05] text-fg-subtle',
            )}
            aria-label="Save"
            title="Save (⌘S)"
          >
            <Save size={11} strokeWidth={2.1} />
            save
          </button>
        </div>
      </div>

      {status.kind === 'error' && !viewRef.current ? (
        <ErrorBlock filePath={filePath} message={status.message} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Code pane — always mounted so the CodeMirror view, scroll,
              cursor, and history survive mode switches. We just toggle
              width (hidden when in preview-only mode). */}
          <div
            ref={containerRef}
            className={cn(
              'selectable min-h-0 overflow-hidden',
              showCode ? 'flex-1 basis-0' : 'hidden',
            )}
          />
          {isMarkdown && mode === 'split' && (
            <div className="w-px shrink-0 bg-border-hairline" aria-hidden />
          )}
          {isMarkdown && (
            <div
              ref={previewRef}
              className={cn(
                'md-preview selectable min-h-0 overflow-auto',
                showPreview ? 'flex-1 basis-0' : 'hidden',
              )}
              aria-readonly="true"
              aria-label="Markdown preview"
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render markdown to HTML, then sanitize. We force a sync `marked.parse`
 * call (it returns string with default options) and DOMPurify keeps the
 * surface safe even though the source is local-disk content — a malicious
 * .md could still embed e.g. `<script>` and we don't want that running.
 */
function markdownToSafeHtml(md: string): string {
  const rawHtml = marked.parse(md, { async: false, breaks: false, gfm: true }) as string;
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}

function StatusLabel({ status, dirty }: { status: Status; dirty: boolean }) {
  let label: string;
  let color: string;
  let Icon: typeof CheckCircle2 | null = null;
  switch (status.kind) {
    case 'loading':
      label = 'loading…';
      color = 'text-fg-subtle';
      break;
    case 'saving':
      label = 'saving…';
      color = 'text-accent';
      break;
    case 'error':
      label = 'save failed';
      color = 'text-status-err';
      Icon = AlertCircle;
      break;
    case 'saved':
      label = 'saved';
      color = 'text-status-ok';
      Icon = CheckCircle2;
      break;
    case 'ready':
    default:
      label = dirty ? 'modified' : 'up to date';
      color = dirty ? 'text-fg-base/80' : 'text-fg-subtle';
      break;
  }
  return (
    <span
      className={cn('flex items-center gap-1 px-1.5 font-mono text-[10px]', color)}
      title={status.kind === 'error' ? status.message : undefined}
    >
      {Icon && <Icon size={10} strokeWidth={2.2} />}
      {label}
    </span>
  );
}

function ErrorBlock({ filePath, message }: { filePath: string; message: string }) {
  const isBinary = /binary/i.test(message);
  const Icon = isBinary ? FileWarning : AlertCircle;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon size={28} strokeWidth={1.6} className="text-fg-subtle" />
      <span className="font-display text-[13px] font-medium tracking-tight text-fg-base">
        {isBinary ? "Can't preview this file" : 'Failed to open'}
      </span>
      <span className="max-w-md font-mono text-[11px] leading-relaxed text-fg-muted">
        {message}
      </span>
      <span className="mt-1 max-w-md truncate font-mono text-[10px] text-fg-subtle" title={filePath}>
        {filePath}
      </span>
    </div>
  );
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Map filename → CodeMirror language extension. The `pathToLanguageId`
 * helper (in `@arc/editor`) does the pure extension→id mapping; this
 * function lazy-imports the matching `@codemirror/lang-*` package so each
 * language ships as its own Vite chunk.
 */
async function loadLanguage(path: string): Promise<Extension | null> {
  const id = pathToLanguageId(path);
  if (id === null || id === 'plain') return null;
  switch (id) {
    case 'javascript':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: false });
    case 'javascript-jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'typescript':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'typescript-jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'json':
      return (await import('@codemirror/lang-json')).json();
    case 'html':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
      return (await import('@codemirror/lang-css')).css();
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'python':
      return (await import('@codemirror/lang-python')).python();
    case 'rust':
      return (await import('@codemirror/lang-rust')).rust();
    case 'cpp':
      return (await import('@codemirror/lang-cpp')).cpp();
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'xml':
      return (await import('@codemirror/lang-xml')).xml();
    case 'php':
      return (await import('@codemirror/lang-php')).php();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
  }
}

/**
 * Catppuccin Mocha syntax highlight — uses the same palette as the file
 * icons, so editor + tree share one visual identity.
 */
const catppuccinHighlight = HighlightStyle.define([
  { tag: t.keyword, color: MOCHA.mauve },
  { tag: t.controlKeyword, color: MOCHA.mauve, fontStyle: 'italic' },
  { tag: t.moduleKeyword, color: MOCHA.mauve },
  { tag: t.operatorKeyword, color: MOCHA.mauve },
  { tag: t.definitionKeyword, color: MOCHA.mauve },

  { tag: [t.string, t.special(t.string)], color: MOCHA.green },
  { tag: t.regexp, color: MOCHA.peach },
  { tag: t.escape, color: MOCHA.pink },

  { tag: [t.number, t.bool, t.null, t.atom], color: MOCHA.peach },

  { tag: t.comment, color: MOCHA.overlay1, fontStyle: 'italic' },
  { tag: t.lineComment, color: MOCHA.overlay1, fontStyle: 'italic' },
  { tag: t.blockComment, color: MOCHA.overlay1, fontStyle: 'italic' },

  { tag: [t.variableName, t.standard(t.variableName)], color: MOCHA.text },
  { tag: t.definition(t.variableName), color: MOCHA.text },
  { tag: t.local(t.variableName), color: MOCHA.text },

  { tag: t.propertyName, color: MOCHA.blue },
  { tag: t.definition(t.propertyName), color: MOCHA.blue },

  { tag: t.function(t.variableName), color: MOCHA.blue },
  { tag: t.function(t.propertyName), color: MOCHA.blue },
  { tag: t.definition(t.function(t.variableName)), color: MOCHA.blue },

  { tag: [t.className, t.definition(t.className), t.typeName, t.definition(t.typeName)], color: MOCHA.yellow },
  { tag: t.namespace, color: MOCHA.yellow },

  { tag: t.tagName, color: MOCHA.mauve },
  { tag: t.attributeName, color: MOCHA.yellow },
  { tag: t.attributeValue, color: MOCHA.green },

  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.brace, t.paren, t.squareBracket, t.angleBracket], color: MOCHA.overlay2 },

  // Markdown
  { tag: t.heading, color: MOCHA.red, fontWeight: '600' },
  { tag: t.link, color: MOCHA.sapphire, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic', color: MOCHA.text },
  { tag: t.strong, fontWeight: '600', color: MOCHA.text },
  { tag: t.url, color: MOCHA.sapphire },
  { tag: t.monospace, color: MOCHA.peach, fontFamily: 'inherit' },

  { tag: t.invalid, color: MOCHA.red, textDecoration: 'underline' },
]);

const macTheme: Extension = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      height: '100%',
      color: MOCHA.text,
      fontSize: '13px',
      fontFamily: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Monaco, 'Cascadia Code', Consolas, monospace",
    },
    '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
    '.cm-content': { caretColor: '#d4d6dc', padding: '14px 0' },
    '.cm-line': { padding: '0 14px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: MOCHA.overlay0,
      border: 'none',
      paddingRight: '4px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 10px',
      minWidth: '28px',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(255,255,255,0.025)',
      color: MOCHA.subtext1,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#d4d6dc',
      borderLeftWidth: '2px',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: 'rgba(200, 210, 225, 0.30)' },
    '.cm-focused': { outline: 'none' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(200, 210, 225, 0.18)',
      outline: '1px solid rgba(200, 210, 225, 0.42)',
    },
    '.cm-tooltip': {
      backgroundColor: 'rgba(38,38,40,0.92)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '8px',
      backdropFilter: 'blur(20px)',
      color: MOCHA.text,
    },
  },
  { dark: true },
);
