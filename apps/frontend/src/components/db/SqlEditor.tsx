import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt, tooltips } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { basicSetup } from 'codemirror';
import { MySQL, PostgreSQL, SQLite, sql, type SQLNamespace } from '@codemirror/lang-sql';
import type { DbBackend } from '../../lib/tauri';
import { catppuccinHighlight } from '../../lib/codeLanguages';
import { MOCHA } from '../../lib/fileIcons';
import { getFont } from '../../themes';
import { useSettings } from '../../state/settings';

export interface SqlEditorHandle {
  /** The selected text, or the whole editor when nothing is selected. */
  selectionOrAll(): string;
  focus(): void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** ⌘/Ctrl+Enter, with the selection (or everything). */
  onRun: (sql: string) => void;
  backend: DbBackend | null;
  /** table → column names, for completion. Tables may be `schema.table`. */
  completion: Record<string, string[]>;
  disabled: boolean;
  placeholder: string;
}

/**
 * Completion namespace for lang-sql. Postgres names arrive as `schema.table`;
 * nesting them lets `public.us…` and bare `us…` (via `defaultSchema`) both
 * complete.
 */
function namespace(backend: DbBackend | null, tables: Record<string, string[]>): SQLNamespace {
  if (backend !== 'postgres') return tables;
  const out: Record<string, Record<string, string[]>> = {};
  for (const [name, cols] of Object.entries(tables)) {
    const dot = name.indexOf('.');
    const schema = dot > 0 ? name.slice(0, dot) : 'public';
    (out[schema] ??= {})[dot > 0 ? name.slice(dot + 1) : name] = cols;
  }
  return out;
}

function language(backend: DbBackend | null, tables: Record<string, string[]>): Extension {
  const dialect = backend === 'mysql' ? MySQL : backend === 'sqlite' ? SQLite : PostgreSQL;
  return sql({
    dialect,
    schema: namespace(backend, tables),
    defaultSchema: backend === 'postgres' ? 'public' : undefined,
    upperCaseKeywords: true,
  });
}

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: MOCHA.text },
  // Scoped to .cm-editor: the tooltip container appended to <body> also gets
  // these theme classes, and a 100% height there doubles the page height.
  '&.cm-editor': { height: '100%' },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
  '.cm-content': { caretColor: '#d4d6dc', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', color: MOCHA.overlay0, border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.025)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#d4d6dc', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'rgba(200, 210, 225, 0.30)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: MOCHA.overlay0 },
  '.cm-tooltip': {
    backgroundColor: 'rgb(var(--bg-panel, 40 40 42))',
    border: '1px solid var(--border-strong, rgba(220, 224, 232, 0.14))',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--surface-3, rgba(255, 255, 255, 0.11))',
    color: MOCHA.text,
  },
});

function fontTheme(stack: string, size: number): Extension {
  return EditorView.theme({
    '&': { fontFamily: stack, fontSize: `${size}px` },
    '.cm-scroller': { fontFamily: 'inherit' },
  });
}

/**
 * The DB client's query box: CodeMirror with the connection's SQL dialect and
 * completion from its schema. ⌘/Ctrl+Enter runs the selection, or the whole
 * text when nothing is selected.
 */
export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { value, onChange, onRun, backend, completion, disabled, placeholder },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const editableC = useRef(new Compartment());
  const placeholderC = useRef(new Compartment());
  const fontC = useRef(new Compartment());
  // Latest callbacks, read by the long-lived extensions.
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;
  const fontId = useSettings((s) => s.fontId);
  const fontSize = useSettings((s) => s.fontSize);

  const selectionOrAll = (state: EditorState) => {
    const { from, to } = state.selection.main;
    return from === to ? state.doc.toString() : state.sliceDoc(from, to);
  };

  useImperativeHandle(ref, () => ({
    selectionOrAll: () => (view.current ? selectionOrAll(view.current.state) : value),
    focus: () => view.current?.focus(),
  }));

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                preventDefault: true,
                run: (ed) => {
                  onRunRef.current(selectionOrAll(ed.state));
                  return true;
                },
              },
            ]),
          ),
          basicSetup,
          // The editor sits in a resizable, overflow-hidden box; completion
          // popups would be clipped by it.
          tooltips({ parent: document.body }),
          EditorView.lineWrapping,
          syntaxHighlighting(catppuccinHighlight),
          theme,
          fontC.current.of(fontTheme(getFont(fontId).stack, fontSize)),
          langC.current.of(language(backend, completion)),
          editableC.current.of([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]),
          placeholderC.current.of(placeholderExt(placeholder)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Built once; the effects below keep it in sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside changes (history, saved queries, a table preview) replace the text.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langC.current.reconfigure(language(backend, completion)) });
  }, [backend, completion]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        editableC.current.reconfigure([EditorView.editable.of(!disabled), EditorState.readOnly.of(disabled)]),
        placeholderC.current.reconfigure(placeholderExt(placeholder)),
      ],
    });
  }, [disabled, placeholder]);

  useEffect(() => {
    view.current?.dispatch({ effects: fontC.current.reconfigure(fontTheme(getFont(fontId).stack, fontSize)) });
  }, [fontId, fontSize]);

  return <div ref={host} className="h-full min-h-0" />;
});
