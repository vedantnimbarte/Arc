import { describe, expect, it } from 'vitest';
import {
  applyChoices,
  conflictCount,
  detectEol,
  hasConflictMarkers,
  parseConflicts,
  type ConflictSegment,
} from '../mergeConflict';

const TWO_SIDED = [
  'top',
  '<<<<<<< HEAD',
  'ours a',
  'ours b',
  '=======',
  'theirs a',
  '>>>>>>> feature/x',
  'bottom',
].join('\n');

const DIFF3 = [
  '<<<<<<< HEAD',
  'ours',
  '||||||| merged common ancestors',
  'base',
  '=======',
  'theirs',
  '>>>>>>> other',
].join('\n');

describe('parseConflicts', () => {
  it('splits context from a two-sided conflict and keeps the labels', () => {
    const segs = parseConflicts(TWO_SIDED);
    expect(segs.map((s) => s.kind)).toEqual(['context', 'conflict', 'context']);
    const c = segs[1] as ConflictSegment;
    expect(c.ourLabel).toBe('HEAD');
    expect(c.theirLabel).toBe('feature/x');
    expect(c.ours).toEqual(['ours a', 'ours b']);
    expect(c.theirs).toEqual(['theirs a']);
    expect(c.base).toBeNull();
    expect(conflictCount(segs)).toBe(1);
  });

  it('captures the ancestor section in diff3 style', () => {
    const c = parseConflicts(DIFF3)[0] as ConflictSegment;
    expect(c.ours).toEqual(['ours']);
    expect(c.base).toEqual(['base']);
    expect(c.theirs).toEqual(['theirs']);
  });

  it('numbers conflicts independently of context segments', () => {
    const doubled = `${TWO_SIDED}\n${TWO_SIDED}`;
    const conflicts = parseConflicts(doubled).filter(
      (s): s is ConflictSegment => s.kind === 'conflict',
    );
    expect(conflicts.map((c) => c.index)).toEqual([0, 1]);
  });

  it('keeps an unterminated marker as plain text instead of eating the file', () => {
    const broken = 'a\n<<<<<<< HEAD\nb\nc';
    const segs = parseConflicts(broken);
    expect(conflictCount(segs)).toBe(0);
    expect(applyChoices(segs, {})).toBe(broken);
  });

  it('ignores a file with no markers', () => {
    expect(hasConflictMarkers('nothing here')).toBe(false);
    expect(hasConflictMarkers(TWO_SIDED)).toBe(true);
  });
});

describe('applyChoices', () => {
  const segs = parseConflicts(TWO_SIDED);

  it('takes one side', () => {
    expect(applyChoices(segs, { 0: { kind: 'ours' } })).toBe(
      'top\nours a\nours b\nbottom',
    );
    expect(applyChoices(segs, { 0: { kind: 'theirs' } })).toBe('top\ntheirs a\nbottom');
  });

  it('concatenates both sides in ours-then-theirs order', () => {
    expect(applyChoices(segs, { 0: { kind: 'both' } })).toBe(
      'top\nours a\nours b\ntheirs a\nbottom',
    );
  });

  it('takes hand-edited lines verbatim', () => {
    expect(applyChoices(segs, { 0: { kind: 'custom', lines: ['merged'] } })).toBe(
      'top\nmerged\nbottom',
    );
  });

  it('round-trips an unresolved conflict back to the original markers', () => {
    expect(applyChoices(segs, {})).toBe(TWO_SIDED);
    expect(applyChoices(parseConflicts(DIFF3), {})).toBe(
      DIFF3.replace('||||||| merged common ancestors', '||||||| base'),
    );
  });

  it('writes back with the file’s own line ending', () => {
    const crlf = TWO_SIDED.replace(/\n/g, '\r\n');
    expect(detectEol(crlf)).toBe('\r\n');
    expect(detectEol(TWO_SIDED)).toBe('\n');
    const out = applyChoices(parseConflicts(crlf), { 0: { kind: 'ours' } }, detectEol(crlf));
    expect(out).toBe('top\r\nours a\r\nours b\r\nbottom');
  });

  it('preserves a trailing newline', () => {
    const withNl = `${TWO_SIDED}\n`;
    expect(applyChoices(parseConflicts(withNl), {})).toBe(withNl);
  });
});
