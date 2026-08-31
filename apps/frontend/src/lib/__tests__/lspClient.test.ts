import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  cmCompletionType,
  cmSeverityFor,
  fileUriToPath,
  hoverContentsToText,
  locationsToTargets,
  lspEditsToChanges,
  lspItemsToCompletions,
  lspPositionToOffset,
  offsetToLspPosition,
  normalizeUri,
  pathToFileUri,
  workspaceEditToFileEdits,
} from '../lspClient';

describe('pathToFileUri', () => {
  it('builds a POSIX file URI', () => {
    expect(pathToFileUri('/home/u/a.ts')).toBe('file:///home/u/a.ts');
  });
  it('builds a Windows file URI with a leading slash before the drive', () => {
    expect(pathToFileUri('C:\\Users\\u\\a.ts')).toBe('file:///C:/Users/u/a.ts');
  });
  it('encodes spaces in segments but keeps slashes', () => {
    expect(pathToFileUri('/a b/c.ts')).toBe('file:///a%20b/c.ts');
  });
});

describe('normalizeUri', () => {
  it('lowercases and decodes for comparison', () => {
    expect(normalizeUri('file:///C:/A%20B/x.TS')).toBe(normalizeUri('file:///c:/a b/x.ts'));
  });
});

describe('cmSeverityFor', () => {
  it('maps LSP severities', () => {
    expect(cmSeverityFor(1)).toBe('error');
    expect(cmSeverityFor(2)).toBe('warning');
    expect(cmSeverityFor(3)).toBe('info');
    expect(cmSeverityFor(undefined)).toBe('info');
  });
});

describe('position conversion', () => {
  const doc = Text.of(['abc', 'defgh', '']); // offsets: a0 b1 c2 \n3 d4...

  it('converts an LSP position to an offset', () => {
    expect(lspPositionToOffset(doc, 0, 0)).toBe(0);
    expect(lspPositionToOffset(doc, 1, 2)).toBe(6); // line 2 ('defgh'), char 2
  });

  it('clamps an out-of-range character to line end', () => {
    expect(lspPositionToOffset(doc, 0, 99)).toBe(3); // end of 'abc'
  });

  it('round-trips offset → position → offset', () => {
    const pos = offsetToLspPosition(doc, 6);
    expect(pos).toEqual({ line: 1, character: 2 });
    expect(lspPositionToOffset(doc, pos.line, pos.character)).toBe(6);
  });
});

describe('hoverContentsToText', () => {
  it('handles a plain string', () => {
    expect(hoverContentsToText({ contents: 'hello' })).toBe('hello');
  });
  it('handles MarkupContent', () => {
    expect(hoverContentsToText({ contents: { kind: 'markdown', value: '**x**' } })).toBe('**x**');
  });
  it('joins an array of MarkedStrings', () => {
    expect(
      hoverContentsToText({ contents: ['one', { language: 'ts', value: 'two' }] }),
    ).toBe('one\n\ntwo');
  });
  it('returns empty for null / malformed', () => {
    expect(hoverContentsToText(null)).toBe('');
    expect(hoverContentsToText({})).toBe('');
  });
});

describe('cmCompletionType', () => {
  it('maps common kinds', () => {
    expect(cmCompletionType(3)).toBe('function');
    expect(cmCompletionType(6)).toBe('variable');
    expect(cmCompletionType(7)).toBe('class');
    expect(cmCompletionType(undefined)).toBe('text');
  });
});

describe('lspItemsToCompletions', () => {
  it('maps a CompletionItem[] using insertText then label', () => {
    const out = lspItemsToCompletions([
      { label: 'foo', kind: 3, insertText: 'foo()' },
      { label: 'bar', kind: 6 },
    ]);
    expect(out).toEqual([
      { label: 'foo', type: 'function', detail: undefined, apply: 'foo()' },
      { label: 'bar', type: 'variable', detail: undefined, apply: 'bar' },
    ]);
  });
  it('unwraps a CompletionList', () => {
    expect(lspItemsToCompletions({ items: [{ label: 'x' }] })).toHaveLength(1);
  });
  it('tolerates junk', () => {
    expect(lspItemsToCompletions(null)).toEqual([]);
    expect(lspItemsToCompletions({})).toEqual([]);
  });
});

describe('fileUriToPath', () => {
  it('round-trips a POSIX path', () => {
    expect(fileUriToPath(pathToFileUri('/home/u/a.ts'))).toBe('/home/u/a.ts');
  });
  it('round-trips a Windows path back to drive form', () => {
    expect(fileUriToPath(pathToFileUri('C:\\Users\\u\\a.ts'))).toBe('C:/Users/u/a.ts');
  });
  it('decodes percent-escaped segments', () => {
    expect(fileUriToPath('file:///a%20b/c.ts')).toBe('/a b/c.ts');
  });
  it('passes a non-file value through untouched', () => {
    expect(fileUriToPath('/already/a/path')).toBe('/already/a/path');
  });
});

describe('locationsToTargets', () => {
  const loc = (uri: string, line: number, character = 0) => ({
    uri,
    range: { start: { line, character }, end: { line, character: character + 3 } },
  });

  it('handles a single Location (not wrapped in an array)', () => {
    expect(locationsToTargets(loc('file:///a.ts', 4, 2))).toEqual([
      { path: '/a.ts', line: 4, character: 2 },
    ]);
  });

  it('handles an array of Locations', () => {
    expect(locationsToTargets([loc('file:///a.ts', 1), loc('file:///b.ts', 7)])).toEqual([
      { path: '/a.ts', line: 1, character: 0 },
      { path: '/b.ts', line: 7, character: 0 },
    ]);
  });

  it('handles LocationLinks, preferring the selection range over the full range', () => {
    // rust-analyzer's shape: targetRange spans the whole item (including its
    // doc comment), targetSelectionRange is the identifier itself. Landing on
    // the comment instead of the name is the bug this guards.
    const link = {
      targetUri: 'file:///src/lib.rs',
      targetRange: { start: { line: 10, character: 0 }, end: { line: 20, character: 1 } },
      targetSelectionRange: { start: { line: 14, character: 7 }, end: { line: 14, character: 12 } },
    };
    expect(locationsToTargets([link])).toEqual([
      { path: '/src/lib.rs', line: 14, character: 7 },
    ]);
  });

  it('returns nothing for null, empty, or malformed results', () => {
    expect(locationsToTargets(null)).toEqual([]);
    expect(locationsToTargets([])).toEqual([]);
    expect(locationsToTargets([{ nope: true }])).toEqual([]);
  });
});

describe('workspaceEditToFileEdits', () => {
  const edit = (line: number, newText: string) => ({
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    newText,
  });

  it('reads the `changes` map encoding', () => {
    const we = { changes: { 'file:///a.ts': [edit(0, 'x')] } };
    expect(workspaceEditToFileEdits(we)).toEqual([
      { path: '/a.ts', edits: [edit(0, 'x')] },
    ]);
  });

  it('reads the `documentChanges` encoding', () => {
    const we = {
      documentChanges: [
        { textDocument: { uri: 'file:///a.ts', version: 1 }, edits: [edit(2, 'y')] },
      ],
    };
    expect(workspaceEditToFileEdits(we)).toEqual([
      { path: '/a.ts', edits: [edit(2, 'y')] },
    ]);
  });

  it('skips create/rename/delete file operations, which carry no edits', () => {
    const we = {
      documentChanges: [
        { kind: 'rename', oldUri: 'file:///a.ts', newUri: 'file:///b.ts' },
        { textDocument: { uri: 'file:///b.ts', version: 1 }, edits: [edit(0, 'z')] },
      ],
    };
    expect(workspaceEditToFileEdits(we)).toEqual([
      { path: '/b.ts', edits: [edit(0, 'z')] },
    ]);
  });

  it('returns nothing for an empty or malformed edit', () => {
    expect(workspaceEditToFileEdits(null)).toEqual([]);
    expect(workspaceEditToFileEdits({})).toEqual([]);
    expect(workspaceEditToFileEdits({ changes: { 'file:///a.ts': 'nope' } })).toEqual([]);
  });
});

describe('lspEditsToChanges', () => {
  const doc = Text.of(['aaaa', 'bbbb', 'cccc']);
  const range = (l1: number, c1: number, l2: number, c2: number) => ({
    start: { line: l1, character: c1 },
    end: { line: l2, character: c2 },
  });

  it('converts positions to absolute offsets against the original doc', () => {
    // Line 1 starts at offset 5 ("aaaa\n").
    expect(lspEditsToChanges(doc, [{ range: range(1, 0, 1, 4), newText: 'X' }])).toEqual([
      { from: 5, to: 9, insert: 'X' },
    ]);
  });

  it('sorts edits ascending — CodeMirror requires it, servers do not promise it', () => {
    const edits = [
      { range: range(2, 0, 2, 1), newText: 'C' },
      { range: range(0, 0, 0, 1), newText: 'A' },
    ];
    expect(lspEditsToChanges(doc, edits).map((c) => c.insert)).toEqual(['A', 'C']);
  });

  it('drops an overlapping edit rather than throwing away the whole rename', () => {
    const edits = [
      { range: range(0, 0, 0, 3), newText: 'A' },
      { range: range(0, 1, 0, 4), newText: 'B' },
    ];
    expect(lspEditsToChanges(doc, edits)).toEqual([{ from: 0, to: 3, insert: 'A' }]);
  });

  it('normalizes a reversed range instead of producing a negative-width change', () => {
    expect(lspEditsToChanges(doc, [{ range: range(0, 3, 0, 1), newText: 'X' }])).toEqual([
      { from: 3, to: 3, insert: 'X' },
    ]);
  });

  it('keeps a pure insertion (zero-width range)', () => {
    expect(lspEditsToChanges(doc, [{ range: range(0, 2, 0, 2), newText: '!' }])).toEqual([
      { from: 2, to: 2, insert: '!' },
    ]);
  });
});
