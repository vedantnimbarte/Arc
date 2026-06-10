import { describe, expect, it } from 'vitest';
import { extractOutline } from '../outline';

describe('extractOutline', () => {
  it('returns nothing for empty input or unknown language', () => {
    expect(extractOutline('', 'typescript')).toEqual([]);
    expect(extractOutline('whatever', null)).toEqual([]);
    expect(extractOutline('x = 1', 'json')).toEqual([]);
  });

  it('extracts TypeScript declarations with 1-based lines', () => {
    const src = [
      'import x from "y";', // 1
      'export class Foo {}', // 2
      'interface Bar {}', // 3
      'type Baz = number;', // 4
      'export function doThing() {}', // 5
      'const handler = (a: number) => a + 1;', // 6
      'const notAFn = items.map((i) => i);', // 7 — must NOT match
    ].join('\n');
    const out = extractOutline(src, 'typescript');
    expect(out).toEqual([
      { name: 'Foo', kind: 'class', line: 2, depth: 0 },
      { name: 'Bar', kind: 'interface', line: 3, depth: 0 },
      { name: 'Baz', kind: 'type', line: 4, depth: 0 },
      { name: 'doThing', kind: 'function', line: 5, depth: 0 },
      { name: 'handler', kind: 'function', line: 6, depth: 0 },
    ]);
  });

  it('distinguishes Python methods from top-level functions by indent', () => {
    const src = ['class A:', '    def method(self):', '        pass', 'def top():', '    pass'].join('\n');
    const out = extractOutline(src, 'python');
    expect(out).toEqual([
      { name: 'A', kind: 'class', line: 1, depth: 0 },
      { name: 'method', kind: 'method', line: 2, depth: 1 },
      { name: 'top', kind: 'function', line: 4, depth: 0 },
    ]);
  });

  it('reads markdown headings with depth from level, skipping fenced code', () => {
    const src = ['# Title', '## Section', '```', '# not a heading', '```', '### Sub'].join('\n');
    const out = extractOutline(src, 'markdown');
    expect(out).toEqual([
      { name: 'Title', kind: 'heading', line: 1, depth: 0 },
      { name: 'Section', kind: 'heading', line: 2, depth: 1 },
      { name: 'Sub', kind: 'heading', line: 6, depth: 2 },
    ]);
  });

  it('extracts Rust items', () => {
    const src = ['pub struct S;', 'enum E {}', 'pub async fn run() {}', 'trait T {}'].join('\n');
    const kinds = extractOutline(src, 'rust').map((s) => `${s.kind}:${s.name}`);
    expect(kinds).toContain('struct:S');
    expect(kinds).toContain('enum:E');
    expect(kinds).toContain('function:run');
    expect(kinds).toContain('trait:T');
  });

  it('extracts Go funcs, methods, and types', () => {
    const src = ['func Plain() {}', 'func (r *R) Method() {}', 'type T struct {', 'type I interface {'].join(
      '\n',
    );
    const out = extractOutline(src, 'go');
    expect(out).toEqual([
      { name: 'Plain', kind: 'function', line: 1, depth: 0 },
      { name: 'Method', kind: 'method', line: 2, depth: 0 },
      { name: 'T', kind: 'struct', line: 3, depth: 0 },
      { name: 'I', kind: 'interface', line: 4, depth: 0 },
    ]);
  });
});
