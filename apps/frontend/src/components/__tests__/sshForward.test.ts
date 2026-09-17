import { describe, expect, it } from 'vitest';
import { formatForward, parseForward, sameForward, withForward } from '../ssh/common';

describe('parseForward', () => {
  it('reads ssh -L order: listen port, then destination', () => {
    expect(parseForward('local', '8080:localhost:80')).toEqual({
      kind: 'local',
      bind_port: 8080,
      dest_host: 'localhost',
      dest_port: 80,
    });
  });

  it('accepts a bracketed IPv6 destination and round-trips it', () => {
    const spec = parseForward('remote', '9000:[::1]:3000');
    expect(spec).toEqual({ kind: 'remote', bind_port: 9000, dest_host: '::1', dest_port: 3000 });
    expect(formatForward(spec as Exclude<typeof spec, string>)).toBe('R 9000 → [::1]:3000');
  });

  it('returns a message for bad input instead of a spec', () => {
    expect(typeof parseForward('local', '8080')).toBe('string');
    expect(typeof parseForward('local', '0:localhost:80')).toBe('string');
    expect(typeof parseForward('local', '8080:localhost:70000')).toBe('string');
    expect(typeof parseForward('local', '8080: :80')).toBe('string');
  });
});

describe('dynamic forwards', () => {
  it('reads a bare port or ssh -D form', () => {
    const want = { kind: 'dynamic', bind_port: 1080, dest_host: '', dest_port: 0 };
    expect(parseForward('dynamic', '1080')).toEqual(want);
    expect(parseForward('dynamic', '-D 1080')).toEqual(want);
    expect(formatForward(want as Exclude<ReturnType<typeof parseForward>, string>)).toBe(
      'D 1080 → SOCKS5',
    );
  });

  it('rejects anything but a valid port', () => {
    expect(typeof parseForward('dynamic', '0')).toBe('string');
    expect(typeof parseForward('dynamic', '70000')).toBe('string');
    expect(typeof parseForward('dynamic', '1080:localhost:80')).toBe('string');
  });
});

describe('withForward', () => {
  const l = { kind: 'local', bind_port: 8080, dest_host: 'localhost', dest_port: 80 } as const;

  it('appends a bare spec and skips duplicates', () => {
    const live = { ...l, id: 'x', state: 'active', error: null, active_conns: 1, total_conns: 3 };
    const saved = withForward([], live);
    expect(saved).toEqual([l]);
    expect(withForward(saved, live)).toBe(saved);
  });

  it('treats a different kind or destination as a different forward', () => {
    expect(sameForward(l, { ...l, kind: 'remote' })).toBe(false);
    expect(sameForward(l, { ...l, dest_port: 81 })).toBe(false);
    expect(withForward([l], { ...l, dest_host: 'db' })).toHaveLength(2);
  });
});
