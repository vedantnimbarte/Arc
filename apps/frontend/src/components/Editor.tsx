import { useCallback, useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { history, historyKeymap, redo, undo } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import {
  AlertCircle,
  FileWarning,
  Save,
  Undo2,
  Redo2,
  CheckCircle2,
} from 'lucide-react';
import { fileIcon, MOCHA } from '../lib/fileIcons';
import { fsReadFile, fsWriteFile, isTauri } from '../lib/tauri';
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

export function Editor({ filePath, tabId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const lastSavedRef = useRef<string>('');
  const setTabDirty = useWorkspace((s) => s.setTabDirty);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [dirty, setDirty] = useState(false);

  /** Stable ref so the keymap closure always sees the latest save fn. */
  const saveRef = useRef<() => Promise<void>>(async () => {});

  saveRef.current = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    if (!isTauri) {
      setStatus({ kind: 'error', message: 'saving requires the Tauri backend' });
      return;
    }
    const content = view.state.doc.toString();
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
              syntaxHighlighting(catppuccinHighlight, { fallback: true }),
              macTheme,
              langCompartment.current.of([]),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                const current = u.state.doc.toString();
                const isDirty = current !== lastSavedRef.current;
                setDirty(isDirty);
                setTabDirty(tabId, isDirty);
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
    };
  }, [filePath, tabId, setTabDirty]);

  const { Icon, color } = fileIcon(basename(filePath));

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
          <button
            onClick={() => viewRef.current && undo(viewRef.current)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40"
            aria-label="Undo"
            title="Undo (⌘Z)"
          >
            <Undo2 size={12} strokeWidth={2} />
          </button>
          <button
            onClick={() => viewRef.current && redo(viewRef.current)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base"
            aria-label="Redo"
            title="Redo (⇧⌘Z)"
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
                ? 'bg-accent text-white hover:bg-accent-muted active:scale-95'
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
        <div
          ref={containerRef}
          className="selectable min-h-0 flex-1 overflow-hidden"
        />
      )}
    </div>
  );
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
 * Map filename → CodeMirror language extension. Each branch dynamic-imports
 * the corresponding `@codemirror/lang-*` package so each language ships as
 * its own chunk — viewing a JSON file never loads the Markdown grammar.
 */
async function loadLanguage(path: string): Promise<Extension | null> {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';

  // Filename overrides for the dotfile-y / no-extension cases.
  if (lower.endsWith('dockerfile') || lower.endsWith('/dockerfile')) {
    return null;
  }
  if (lower.endsWith('makefile') || lower.endsWith('/makefile')) {
    return null;
  }

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: false });
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'json':
    case 'jsonc':
    case 'json5':
      return (await import('@codemirror/lang-json')).json();
    case 'html':
    case 'htm':
      return (await import('@codemirror/lang-html')).html();
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return (await import('@codemirror/lang-css')).css();
    case 'md':
    case 'mdx':
    case 'markdown':
      return (await import('@codemirror/lang-markdown')).markdown();
    case 'py':
      return (await import('@codemirror/lang-python')).python();
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust();
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hpp':
    case 'hh':
      return (await import('@codemirror/lang-cpp')).cpp();
    case 'go':
      return (await import('@codemirror/lang-go')).go();
    case 'yml':
    case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml();
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql();
    case 'xml':
    case 'svg':
      return (await import('@codemirror/lang-xml')).xml();
    case 'php':
      return (await import('@codemirror/lang-php')).php();
    case 'java':
      return (await import('@codemirror/lang-java')).java();
    case 'toml':
      // Toml isn't shipped as a first-class lang-* package; fall back to
      // no syntax for it — basic punctuation + strings still read well.
      return null;
    default:
      return null;
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
    '.cm-content': { caretColor: '#0a84ff', padding: '14px 0' },
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
      borderLeftColor: '#0a84ff',
      borderLeftWidth: '2px',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
      { backgroundColor: 'rgba(10, 132, 255, 0.30)' },
    '.cm-focused': { outline: 'none' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(10, 132, 255, 0.15)',
      outline: '1px solid rgba(10, 132, 255, 0.45)',
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
