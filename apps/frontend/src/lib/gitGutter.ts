import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';
import { MOCHA } from './fileIcons';

/**
 * Editor git gutter (Tier: git-in-editor). Renders a thin colored bar in a
 * dedicated gutter for lines that differ from HEAD — added (green) or modified
 * (yellow). Change info is computed by parsing `git_diff` (HEAD scope) for the
 * open file and pushed in via the `setGitChanges` effect.
 *
 * ponytail: added + modified only; pure-deletion carets between lines are
 * skipped — add a triangle marker if anyone asks for it.
 */

export type ChangeKind = 'added' | 'modified';

/**
 * Parse a unified diff into a map of new-file line number → change kind.
 * Pure. A run of `+` lines with no preceding `-` in the same run is an
 * addition; a `+` run preceded by `-` lines is a modification.
 */
export function changedLinesFromDiff(diff: string): Map<number, ChangeKind> {
  const result = new Map<number, ChangeKind>();
  let newLine = 0;
  let inHunk = false;
  let sawDeleteInRun = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        newLine = Number.parseInt(m[1]!, 10);
        inHunk = true;
        sawDeleteInRun = false;
      }
      continue;
    }
    if (!inHunk) continue;
    // A new file header ends the current hunk.
    if (raw.startsWith('diff --git') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      inHunk = false;
      continue;
    }
    if (raw === '' || raw.startsWith('\\')) continue; // trailing split / "No newline"

    const c = raw[0];
    if (c === '+') {
      result.set(newLine, sawDeleteInRun ? 'modified' : 'added');
      newLine++;
    } else if (c === '-') {
      sawDeleteInRun = true; // deletion consumes no new-file line
    } else {
      sawDeleteInRun = false;
      newLine++;
    }
  }
  return result;
}

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: ChangeKind) {
    super();
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = `cm-git-change cm-git-${this.kind}`;
    return el;
  }
}

const ADDED = new ChangeMarker('added');
const MODIFIED = new ChangeMarker('modified');

/** Replace the gutter's change markers. */
export const setGitChanges = StateEffect.define<Map<number, ChangeKind>>();

const gitChangeField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setGitChanges)) continue;
      const doc = tr.state.doc;
      const builder = new RangeSetBuilder<GutterMarker>();
      // Ascending line order → ascending positions (required by the builder).
      for (const lineNo of [...e.value.keys()].sort((a, b) => a - b)) {
        if (lineNo < 1 || lineNo > doc.lines) continue;
        const from = doc.line(lineNo).from;
        builder.add(from, from, e.value.get(lineNo) === 'modified' ? MODIFIED : ADDED);
      }
      value = builder.finish();
    }
    return value;
  },
});

const gitChangeGutter = gutter({
  class: 'cm-git-gutter',
  markers: (view) => view.state.field(gitChangeField),
  initialSpacer: () => ADDED,
});

const gitGutterTheme = EditorView.baseTheme({
  '.cm-git-gutter': { width: '3px', padding: '0' },
  '.cm-git-change': { width: '3px', height: '100%', borderRadius: '1px' },
  '.cm-git-added': { backgroundColor: MOCHA.green },
  '.cm-git-modified': { backgroundColor: MOCHA.yellow },
});

/** The full gutter extension: state field + gutter + theme. */
export function gitDiffGutter(): Extension {
  return [gitChangeField, gitChangeGutter, gitGutterTheme];
}
