import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet } from '@codemirror/view';
import { pathKey, useDebug } from '../state/debug';
import { MOCHA } from './fileIcons';

/**
 * Editor side of the debugger: a breakpoint gutter (click to toggle) and a
 * highlight on the line the debuggee is stopped at. Both are painted from the
 * debug store, which a small view plugin mirrors into this editor.
 *
 * ponytail: breakpoints are stored by line number, so lines shift under them
 * while you edit a file mid-session. Track them through doc changes if that
 * turns out to bite.
 */

type BpKind = 'set' | 'unverified';

interface Marks {
  breakpoints: Map<number, BpKind>;
  stoppedLine: number | null;
}

class BreakpointMarker extends GutterMarker {
  constructor(readonly kind: BpKind) {
    super();
  }
  override eq(other: BreakpointMarker) {
    return other.kind === this.kind;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = `cm-debug-bp cm-debug-bp-${this.kind}`;
    el.title = this.kind === 'unverified' ? 'Breakpoint (not bound by the debugger)' : 'Breakpoint';
    return el;
  }
}

const SET = new BreakpointMarker('set');
const UNVERIFIED = new BreakpointMarker('unverified');

const setMarks = StateEffect.define<Marks>();

const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const line of [...e.value.breakpoints.keys()].sort((a, b) => a - b)) {
        if (line < 1 || line > tr.state.doc.lines) continue;
        const from = tr.state.doc.line(line).from;
        builder.add(from, from, e.value.breakpoints.get(line) === 'unverified' ? UNVERIFIED : SET);
      }
      value = builder.finish();
    }
    return value;
  },
});

const stoppedDeco = Decoration.line({ class: 'cm-debug-stopped' });

const stoppedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue;
      const line = e.value.stoppedLine;
      value =
        line !== null && line >= 1 && line <= tr.state.doc.lines
          ? Decoration.set([stoppedDeco.range(tr.state.doc.line(line).from)])
          : Decoration.none;
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function marksFor(filePath: string): Marks {
  const s = useDebug.getState();
  const key = pathKey(filePath);
  const file = s.breakpoints[key];
  const breakpoints = new Map<number, BpKind>();
  for (const line of file?.lines ?? []) {
    // Only a live session's explicit "no" reads as unverified.
    breakpoints.set(line, s.sessionId && file?.verified[line] === false ? 'unverified' : 'set');
  }
  const stoppedLine = s.location && pathKey(s.location.path) === key ? s.location.line : null;
  return { breakpoints, stoppedLine };
}

export function debugGutter(filePath: string): Extension {
  const sync = ViewPlugin.define((view) => {
    // Can't dispatch while the view is still being constructed.
    let alive = true;
    queueMicrotask(() => alive && view.dispatch({ effects: setMarks.of(marksFor(filePath)) }));
    const unsubscribe = useDebug.subscribe((s, prev) => {
      if (s.breakpoints === prev.breakpoints && s.location === prev.location && s.sessionId === prev.sessionId) {
        return;
      }
      view.dispatch({ effects: setMarks.of(marksFor(filePath)) });
    });
    return {
      destroy() {
        alive = false;
        unsubscribe();
      },
    };
  });

  return [
    bpField,
    stoppedField,
    sync,
    gutter({
      class: 'cm-debug-gutter',
      markers: (view) => view.state.field(bpField),
      initialSpacer: () => SET,
      domEventHandlers: {
        mousedown(view, line) {
          useDebug.getState().toggleBreakpoint(filePath, view.state.doc.lineAt(line.from).number);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      '.cm-debug-gutter': { width: '14px', cursor: 'pointer' },
      '.cm-debug-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      '.cm-debug-bp': { width: '8px', height: '8px', borderRadius: '50%' },
      '.cm-debug-bp-set': { backgroundColor: MOCHA.red },
      '.cm-debug-bp-unverified': { border: `1.5px solid ${MOCHA.overlay1}`, boxSizing: 'border-box' },
      '.cm-debug-stopped': { backgroundColor: 'rgba(249, 226, 175, 0.14)' },
    }),
  ];
}
