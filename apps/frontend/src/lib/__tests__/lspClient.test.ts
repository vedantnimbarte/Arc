import { describe, expect, it } from 'vitest';
import { Text } from '@codemirror/state';
import {
  cmCompletionType,
  cmSeverityFor,
  hoverContentsToText,
  lspItemsToCompletions,
  lspPositionToOffset,
  offsetToLspPosition,
  normalizeUri,
  pathToFileUri,
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
