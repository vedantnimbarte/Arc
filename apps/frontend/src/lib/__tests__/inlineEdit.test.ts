import { describe, expect, it } from 'vitest';
import {
  buildInlineEditMessages,
  INLINE_EDIT_SYSTEM,
  isUsableInstruction,
  lineDiff,
  stripCodeFence,
} from '../inlineEdit';

describe('buildInlineEditMessages', () => {
  it('embeds the instruction, code, file name, and language hint', () => {
    const { system, messages } = buildInlineEditMessages({
      code: 'const x = 1;',
      instruction: '  make it a let  ',
      fileName: 'foo.ts',
      language: 'typescript',
    });
    expect(system).toBe(INLINE_EDIT_SYSTEM);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const content = messages[0].content;
    expect(content).toContain('foo.ts (typescript)');
    // Instruction is trimmed.
    expect(content).toContain('Instruction: make it a let');
    expect(content).toContain('const x = 1;');
  });

  it('omits the language hint when language is null', () => {
    const { messages } = buildInlineEditMessages({
      code: 'x',
      instruction: 'do thing',
      fileName: 'plain.txt',
      language: null,
    });
    expect(messages[0].content).toContain('File: plain.txt\n');
    expect(messages[0].content).not.toContain('(null)');
  });
});

describe('stripCodeFence', () => {
  it('peels a fully-fenced response with a language token', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(stripCodeFence(input)).toBe('const x = 1;');
  });

  it('peels a fenced response with no language token', () => {
    expect(stripCodeFence('```\nhello\n```')).toBe('hello');
  });

  it('tolerates leading/trailing whitespace around the fence', () => {
    expect(stripCodeFence('\n\n```js\nfoo()\n```  ')).toBe('foo()');
  });

  it('leaves unfenced text untouched', () => {
    expect(stripCodeFence('const x = 1;')).toBe('const x = 1;');
  });

  it('does not strip an interior fence when the whole thing is not fenced', () => {
    const input = 'before\n```\ncode\n```\nafter';
    expect(stripCodeFence(input)).toBe(input);
  });
});

describe('lineDiff', () => {
  it('marks every line same for identical input', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'same', text: 'b' },
    ]);
  });

  it('detects a single changed line as del + add', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'same', text: 'c' },
    ]);
  });

  it('detects pure additions', () => {
    expect(lineDiff('a', 'a\nb')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'add', text: 'b' },
    ]);
  });

  it('detects pure deletions', () => {
    expect(lineDiff('a\nb', 'a')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
    ]);
  });
});

describe('isUsableInstruction', () => {
  it('rejects empty and whitespace-only instructions', () => {
    expect(isUsableInstruction('')).toBe(false);
    expect(isUsableInstruction('   \n\t')).toBe(false);
  });
  it('accepts a real instruction', () => {
    expect(isUsableInstruction('rename to bar')).toBe(true);
  });
});
