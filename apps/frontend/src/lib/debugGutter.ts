import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet } from '@codemirror/view';
import { pathKey, useDebug, type Breakpoint, type BreakpointOption } from '../state/debug';
import { askText } from '../state/confirm';
import { MOCHA } from './fileIcons';

/**
 * Editor side of the debugger: a breakpoint gutter (click to toggle,
 * right-click for conditions and log messages) and a highlight on the line
 * the debuggee is stopped at. Both are painted from the debug store, which a
 * small view plugin mirrors into this editor; edits flow back the other way,
 * so breakpoints follow their lines (see `mapBreakpoints`).
 */

type BpShape = 'plain' | 'conditional' | 'log';

interface Marks {
  breakpoints: Map<number, BreakpointMarker>;
  stoppedLine: number | null;
}

class BreakpointMarker extends GutterMarker {
  constructor(
    readonly shape: BpShape,
    readonly unverified: boolean,
    readonly title: string,
  ) {
    super();
  }
  override eq(other: BreakpointMarker) {
    return other.shape === this.shape && other.unverified === this.unverified && other.title === this.title;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = `cm-debug-bp cm-debug-bp-${this.shape}${this.unverified ? ' cm-debug-bp-unverified' : ''}`;
    el.title = this.title;
    return el;
  }
}

function markerFor(bp: Breakpoint, unverified: boolean): BreakpointMarker {
  const shape: BpShape = bp.logMessage ? 'log' : bp.condition || bp.hitCondition ? 'conditional' : 'plain';
  const title = [
    bp.logMessage ? `Logpoint: ${bp.logMessage}` : 'Breakpoint',
    bp.condition && `when ${bp.condition}`,
    bp.hitCondition && `hit count ${bp.hitCondition}`,
    unverified && '(not bound by the debugger)',
  ]
    .filter(Boolean)
    .join(' ');
  return new BreakpointMarker(shape, unverified, title);
}

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
        builder.add(from, from, e.value.breakpoints.get(line)!);
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
  const breakpoints = new Map<number, BreakpointMarker>();
  for (const bp of s.breakpoints[key]?.breakpoints ?? []) {
    // Only a live session's explicit "no" reads as unverified.
    breakpoints.set(bp.line, markerFor(bp, !!s.sessionId && bp.verified === false));
  }
  const stoppedLine = s.location && pathKey(s.location.path) === key ? s.location.line : null;
  return { breakpoints, stoppedLine };
}

const EDITS: { option: BreakpointOption; label: string; title: string; field: string; placeholder: string }[] = [
  { option: 'condition', label: 'Edit condition…', title: 'Breakpoint condition', field: 'Break when this expression is true', placeholder: 'x > 5' },
  { option: 'hitCondition', label: 'Edit hit count…', title: 'Breakpoint hit count', field: 'Break when the hit count matches', placeholder: '>= 3' },
  { option: 'logMessage', label: 'Edit log message…', title: 'Logpoint message', field: 'Log this instead of breaking; {expressions} are interpolated', placeholder: 'x is {x}' },
];

/** The gutter's right-click menu. Plain DOM with the file tree menu's
 *  classes, since CodeMirror owns this corner of the page, not React. */
function openBreakpointMenu(event: MouseEvent, filePath: string, line: number) {
  const bp = useDebug.getState().breakpoints[pathKey(filePath)]?.breakpoints.find((b) => b.line === line);
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Breakpoint actions');
  menu.className =
    'fixed z-[9999] min-w-[180px] rounded-xl border border-edge-2 bg-[#1b1b1d] p-1.5 shadow-2xl shadow-black/70';

  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  const items: [string, () => void][] = EDITS.map(({ option, label, title, field, placeholder }) => [
    label,
    async () => {
      const value = await askText(title, { label: field, value: bp?.[option] ?? '', placeholder });
      if (value !== null) useDebug.getState().editBreakpoint(filePath, line, { [option]: value });
    },
  ]);
  if (bp) items.push(['Remove breakpoint', () => useDebug.getState().toggleBreakpoint(filePath, line)]);

  for (const [label, run] of items) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    item.className =
      'flex w-full items-center rounded-md px-3 py-[5px] font-display text-sm tracking-tight text-fg-base/90 transition-colors duration-100 hover:bg-surface-2 hover:text-fg-base focus:bg-surface-2 focus:outline-none';
    // `pointerdown` for the same WebKit reason as `TabContextMenu`; `click`
    // with no detail is the keyboard path.
    item.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      close();
      run();
    });
    item.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      close();
      run();
    });
    menu.append(item);
  }

  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8))}px`;
  menu.querySelector('button')?.focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
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
    // Listeners run once the update is done, so the store's echo back into
    // `setMarks` may dispatch.
    EditorView.updateListener.of((u) => {
      if (u.docChanged) useDebug.getState().moveBreakpoints(filePath, u.changes, u.startState.doc, u.state.doc);
    }),
    gutter({
      class: 'cm-debug-gutter',
      markers: (view) => view.state.field(bpField),
      initialSpacer: () => new BreakpointMarker('plain', false, ''),
      domEventHandlers: {
        mousedown(view, line, event) {
          if ((event as MouseEvent).button !== 0) return false;
          useDebug.getState().toggleBreakpoint(filePath, view.state.doc.lineAt(line.from).number);
          return true;
        },
        contextmenu(view, line, event) {
          event.preventDefault();
          openBreakpointMenu(event as MouseEvent, filePath, view.state.doc.lineAt(line.from).number);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      '.cm-debug-gutter': { width: '14px', cursor: 'pointer' },
      '.cm-debug-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center' },
      '.cm-debug-bp': { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: MOCHA.red },
      // A dot with a bar through it, and a diamond, as in VS Code.
      '.cm-debug-bp-conditional': {
        background: `linear-gradient(rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.7)) center / 4px 2px no-repeat ${MOCHA.red}`,
      },
      '.cm-debug-bp-log': { width: '7px', height: '7px', borderRadius: '1px', transform: 'rotate(45deg)' },
      '.cm-debug-bp-unverified': {
        background: 'transparent',
        border: `1.5px solid ${MOCHA.overlay1}`,
        boxSizing: 'border-box',
      },
      '.cm-debug-stopped': { backgroundColor: 'rgba(249, 226, 175, 0.14)' },
    }),
  ];
}
