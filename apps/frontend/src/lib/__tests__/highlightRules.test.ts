import { describe, expect, it } from 'vitest';
import { compileRules, isValidPattern, matchLine, type HighlightRule } from '../highlightRules';

const rule = (id: string, pattern: string, extra: Partial<HighlightRule> = {}): HighlightRule => ({
  id,
  pattern,
  color: 'red',
  notify: false,
  enabled: true,
  ...extra,
});

describe('highlight rules', () => {
  it('matches case-insensitively, first rule wins', () => {
    const c = compileRules([rule('err', 'error'), rule('any', '.')]);
    expect(matchLine(c, 'Build ERROR: nope')?.id).toBe('err');
    expect(matchLine(c, 'fine')?.id).toBe('any');
    expect(matchLine(c, '')).toBeNull();
  });

  it('skips disabled, blank and invalid patterns', () => {
    const c = compileRules([
      rule('off', 'x', { enabled: false }),
      rule('blank', '  '),
      rule('bad', '(unclosed'),
      rule('port', 'listening on :\\d+'),
    ]);
    expect(c.map((x) => x.rule.id)).toEqual(['port']);
    expect(matchLine(c, 'Server listening on :3000')?.id).toBe('port');
    expect(isValidPattern('(unclosed')).toBe(false);
  });
});
