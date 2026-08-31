// Conflict-marker parsing for the merge view.
//
// Git leaves a conflicted file annotated in place:
//
//   <<<<<<< HEAD
//   our lines
//   ||||||| merged common ancestors      <- diff3 style only
//   base lines
//   =======
//   their lines
//   >>>>>>> feature/x
//
// `checkout --ours` / `--theirs` (what Source Control offered before this)
// resolve the whole *file* one way. That's a coin flip on any file where both
// sides changed something real, so this module gives the UI what it needs to
// resolve one hunk at a time.
//
// Everything here is pure: parse text → segments, then segments + choices →
// text. The component owns nothing but the choices.

/** A run of lines both sides agree on. */
export interface ContextSegment {
  kind: 'context';
  lines: string[];
}

/** One conflicted region. `base` is present only for diff3-style markers
 *  (`merge.conflictStyle = diff3` / `zdiff3`). */
export interface ConflictSegment {
  kind: 'conflict';
  /** Zero-based index among conflicts only — the UI's stable hunk key. */
  index: number;
  ourLabel: string;
  theirLabel: string;
  ours: string[];
  theirs: string[];
  base: string[] | null;
}

export type Segment = ContextSegment | ConflictSegment;

/** How the user resolved one conflict. `custom` carries edited text. */
export type Choice =
  | { kind: 'ours' }
  | { kind: 'theirs' }
  | { kind: 'both' }
  | { kind: 'custom'; lines: string[] };

const OURS = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const SPLIT = /^={7}$/;
const THEIRS = /^>{7}(?: (.*))?$/;

/** Quick check used to decide whether a file still needs the merge view. */
export function hasConflictMarkers(text: string): boolean {
  return text.split(/\r?\n/).some((l) => OURS.test(l));
}

/**
 * Split a conflicted file into alternating context and conflict segments.
 *
 * Markers that never close (a truncated or hand-mangled file) are emitted as
 * plain context rather than swallowed — losing the user's lines to a parse
 * failure would be far worse than showing them a hunk we can't resolve.
 */
export function parseConflicts(text: string): Segment[] {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  let context: string[] = [];
  let conflictIndex = 0;

  const flushContext = () => {
    if (context.length > 0) {
      segments.push({ kind: 'context', lines: context });
      context = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const start = lines[i]!;
    const openMatch = OURS.exec(start);
    if (!openMatch) {
      context.push(start);
      continue;
    }

    // Scan forward for the rest of the marker set. `side` tracks which
    // bucket the lines we're reading belong to.
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let side: 'ours' | 'base' | 'theirs' = 'ours';
    let sawBase = false;
    let theirLabel = '';
    let closed = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      if (side === 'ours' && BASE.test(line)) {
        sawBase = true;
        side = 'base';
        continue;
      }
      if (side !== 'theirs' && SPLIT.test(line)) {
        side = 'theirs';
        continue;
      }
      const close = THEIRS.exec(line);
      if (close) {
        theirLabel = close[1] ?? '';
        closed = true;
        break;
      }
      (side === 'ours' ? ours : side === 'base' ? base : theirs).push(line);
    }

    if (!closed || side !== 'theirs') {
      // Unterminated: keep the raw text, including the marker line.
      context.push(start);
      continue;
    }

    flushContext();
    segments.push({
      kind: 'conflict',
      index: conflictIndex++,
      ourLabel: openMatch[1] ?? 'ours',
      theirLabel: theirLabel || 'theirs',
      ours,
      theirs,
      base: sawBase ? base : null,
    });
    i = j; // resume after the closing marker
  }

  flushContext();
  return segments;
}

/** Total conflicts in a parse. */
export function conflictCount(segments: Segment[]): number {
  return segments.reduce((n, s) => n + (s.kind === 'conflict' ? 1 : 0), 0);
}

/** The lines a choice contributes for one conflict. */
export function resolveSegment(seg: ConflictSegment, choice: Choice): string[] {
  switch (choice.kind) {
    case 'ours':
      return seg.ours;
    case 'theirs':
      return seg.theirs;
    case 'both':
      return [...seg.ours, ...seg.theirs];
    case 'custom':
      return choice.lines;
  }
}

/**
 * Rebuild the file from its segments and the user's choices.
 *
 * A conflict with no choice yet keeps its original markers, so a partial save
 * is still a valid conflicted file — the UI can offer "save progress" without
 * silently dropping either side. `eol` preserves the file's original line
 * ending (see [`detectEol`]).
 */
export function applyChoices(
  segments: Segment[],
  choices: Record<number, Choice | undefined>,
  eol: '\n' | '\r\n' = '\n',
): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === 'context') {
      out.push(...seg.lines);
      continue;
    }
    const choice = choices[seg.index];
    if (!choice) {
      out.push(`<<<<<<< ${seg.ourLabel}`);
      out.push(...seg.ours);
      if (seg.base) {
        out.push('||||||| base');
        out.push(...seg.base);
      }
      out.push('=======');
      out.push(...seg.theirs);
      out.push(`>>>>>>> ${seg.theirLabel}`);
      continue;
    }
    out.push(...resolveSegment(seg, choice));
  }
  return out.join(eol);
}

/** CRLF if the file uses it anywhere, else LF. Writing a merged file back
 *  with the wrong ending would show up as a whole-file diff. */
export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
