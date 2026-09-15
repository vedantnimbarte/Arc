import { describe, expect, it } from 'vitest';
import { parseCurl, shellQuote, shellSplit, toCurl } from '../curl';

describe('shellSplit', () => {
  it('handles single, double, ANSI-C quotes and continuations', () => {
    expect(shellSplit(`curl 'a b' "c \\"d\\" \\x" $'e\\nf' g\\ h \\\n  -s`)).toEqual([
      'curl',
      'a b',
      'c "d" \\x',
      'e\nf',
      'g h',
      '-s',
    ]);
    expect(shellSplit('a \\\r\n b')).toEqual(['a', 'b']);
    expect(() => shellSplit(`curl 'oops`)).toThrow();
  });
});

describe('parseCurl', () => {
  it('defaults to GET with no body', () => {
    expect(parseCurl('curl https://example.com/x')).toEqual({
      method: 'GET',
      url: 'https://example.com/x',
      headers: [],
      body: null,
    });
  });

  it('parses a multi-line command with headers, data and method', () => {
    const r = parseCurl(`curl -X PUT 'https://api.test/items/1' \\
  -H 'Content-Type: application/json' \\
  --header "X-Trace: a b" \\
  --data-raw '{"name":"it'\\''s"}'`);
    expect(r.method).toBe('PUT');
    expect(r.url).toBe('https://api.test/items/1');
    expect(r.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: 'a b' },
    ]);
    expect(r.body).toBe(`{"name":"it's"}`);
  });

  it('infers POST from a body and joins repeated -d with &', () => {
    const r = parseCurl('curl -s -L https://x.test -d a=1 --data b=2 --data-binary=c=3');
    expect(r.method).toBe('POST');
    expect(r.body).toBe('a=1&b=2&c=3');
  });

  it('supports --json, -u, --url and glued short options', () => {
    const r = parseCurl(`curl -XPATCH --url https://x.test -u user:pa:ss --json '{"a":1}'`);
    expect(r.method).toBe('PATCH');
    expect(r.url).toBe('https://x.test');
    expect(r.body).toBe('{"a":1}');
    expect(r.headers).toEqual([
      { name: 'Authorization', value: `Basic ${btoa('user:pa:ss')}` },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'application/json' },
    ]);
  });

  it('does not take ignored option values as the URL', () => {
    expect(parseCurl('curl -o out.json -m 5 https://x.test').url).toBe('https://x.test');
  });

  it('rejects non-curl input', () => {
    expect(() => parseCurl('wget https://x.test')).toThrow();
    expect(() => parseCurl('curl -s')).toThrow();
  });
});

describe('toCurl', () => {
  it('quotes only when needed', () => {
    expect(shellQuote('https://x.test/a')).toBe('https://x.test/a');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe(`''`);
  });

  it('round-trips through parseCurl', () => {
    const cmd = toCurl({
      method: 'POST',
      url: 'https://x.test/q?a=1&b=2',
      headers: [{ name: 'Authorization', value: 'Bearer $TOKEN' }],
      body: { kind: 'raw', text: `{"q":"it's \\"quoted\\""}`, content_type: 'application/json' },
    });
    expect(parseCurl(cmd)).toEqual({
      method: 'POST',
      url: 'https://x.test/q?a=1&b=2',
      headers: [
        { name: 'Authorization', value: 'Bearer $TOKEN' },
        { name: 'Content-Type', value: 'application/json' },
      ],
      body: `{"q":"it's \\"quoted\\""}`,
    });
  });

  it('omits -X for a plain GET and renders form bodies', () => {
    expect(toCurl({ method: 'GET', url: 'https://x.test', headers: [], body: { kind: 'none' } })).toBe(
      'curl https://x.test',
    );
    expect(
      toCurl({
        method: 'POST',
        url: 'https://x.test',
        headers: [],
        body: { kind: 'formurlencoded', entries: [{ name: 'a', value: 'b c' }] },
      }),
    ).toBe(`curl https://x.test -X POST \\\n  --data-urlencode 'a=b c'`);
  });
});
