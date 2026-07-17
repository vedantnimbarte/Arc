import { describe, expect, it } from 'vitest';
import { changedLinesFromDiff } from '../gitGutter';

const HEADER = ['diff --git a/f.ts b/f.ts', 'index abc..def 100644', '--- a/f.ts', '+++ b/f.ts'].join(
  '\n',
);

describe('changedLinesFromDiff', () => {
  it('marks pure additions as added', () => {
    const diff = `${HEADER}\n@@ -1,2 +1,4 @@\n a\n+b\n+c\n d\n`;
    expect(changedLinesFromDiff(diff)).toEqual(
      new Map([
        [2, 'added'],
        [3, 'added'],
      ]),
    );
  });

  it('marks a replaced line as modified', () => {
    const diff = `${HEADER}\n@@ -1,2 +1,2 @@\n a\n-x\n+y\n`;
    expect(changedLinesFromDiff(diff)).toEqual(new Map([[2, 'modified']]));
  });

  it('ignores pure deletions (no new-file line to mark)', () => {
    const diff = `${HEADER}\n@@ -1,3 +1,2 @@\n a\n-gone\n b\n`;
    expect(changedLinesFromDiff(diff)).toEqual(new Map());
  });

  it('returns an empty map for an empty diff', () => {
    expect(changedLinesFromDiff('')).toEqual(new Map());
  });
});
