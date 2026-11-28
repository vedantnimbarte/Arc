import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../jsonc';

describe('parseJsonc', () => {
  it('strips comments and trailing commas', () => {
    const src = `{
      // a line comment
      "a": 1, /* and a block one */
      "b": [1, 2,],
    }`;
    expect(parseJsonc(src)).toEqual({ a: 1, b: [1, 2] });
  });

  it('leaves comment-like text inside strings alone', () => {
    expect(parseJsonc('{"url": "https://x.dev/y", "s": "a /* b */ c"}')).toEqual({
      url: 'https://x.dev/y',
      s: 'a /* b */ c',
    });
  });

  it('handles an escaped quote inside a string', () => {
    expect(parseJsonc('{"a": "he said \\"hi\\" // not a comment"}')).toEqual({
      a: 'he said "hi" // not a comment',
    });
  });
});
