import { describe, expect, it } from 'vitest';
import { formatForward, parseForward } from '../ssh/common';

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
