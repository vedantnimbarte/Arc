import { describe, expect, it } from 'vitest';
import {
  formatTokens,
  parseClaudeUsage,
  parseCodexUsage,
  parseUsageJson,
} from '../usage';

describe('parseUsageJson', () => {
  it('pulls token fields out of flat JSON', () => {
    const out = parseUsageJson(
      JSON.stringify({ input_tokens: 1234, output_tokens: 56, num_requests: 7 }),
    );
    expect(out.ok).toBe(true);
    expect(out.fields).toEqual([
      { label: 'Input tokens', value: '1,234' },
      { label: 'Output tokens', value: '56' },
      { label: 'Requests', value: '7' },
    ]);
  });

  it('finds fields nested under a usage object', () => {
    const out = parseUsageJson(
      JSON.stringify({ account: { plan: 'pro' }, usage: { total_tokens: 9000, limit: 100000 } }),
    );
    expect(out.ok).toBe(true);
    const byLabel = Object.fromEntries(out.fields.map((f) => [f.label, f.value]));
    expect(byLabel['Total tokens']).toBe('9,000');
    expect(byLabel['Limit']).toBe('100,000');
    expect(byLabel['Plan']).toBe('pro');
  });

  it('returns ok:false for malformed JSON', () => {
    expect(parseUsageJson('not json {')).toEqual({ fields: [], ok: false });
  });

  it('returns ok:false for empty input', () => {
    expect(parseUsageJson('   ')).toEqual({ fields: [], ok: false });
  });

  it('returns ok:false when JSON has no recognised fields', () => {
    expect(parseUsageJson(JSON.stringify({ foo: 'bar', nested: { baz: 1 } })).ok).toBe(false);
  });
});

describe('parseCodexUsage', () => {
  it('is the JSON parser', () => {
    expect(parseCodexUsage).toBe(parseUsageJson);
  });
});

describe('parseClaudeUsage', () => {
  it('parses JSON when claude emits it', () => {
    const out = parseClaudeUsage(JSON.stringify({ total_tokens: 42 }));
    expect(out.ok).toBe(true);
    expect(out.fields[0]).toEqual({ label: 'Total tokens', value: '42' });
  });

  it('parses the real /usage session + weekly lines with reset times', () => {
    const stdout = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 23% used · resets Jun 11, 7:10pm (Asia/Calcutta)',
      'Current week (all models): 41% used · resets Jun 15, 11:29pm (Asia/Calcutta)',
      'Current week (Sonnet only): 0% used',
    ].join('\n');
    const out = parseClaudeUsage(stdout);
    expect(out.ok).toBe(true);
    expect(out.fields).toEqual([
      { label: 'Session', value: '23% used', note: 'resets Jun 11, 7:10pm' },
      { label: 'Weekly (all models)', value: '41% used', note: 'resets Jun 15, 11:29pm' },
      { label: 'Weekly (Sonnet only)', value: '0% used' },
    ]);
  });

  it('falls back to scanning free text for tokens and percent', () => {
    const out = parseClaudeUsage('You have used 12,000 tokens this session.');
    expect(out.ok).toBe(true);
    const byLabel = Object.fromEntries(out.fields.map((f) => [f.label, f.value]));
    expect(byLabel['Tokens']).toBe('12,000');
  });

  it('returns ok:false on unparseable text', () => {
    expect(parseClaudeUsage('Opening usage panel…').ok).toBe(false);
  });
});

describe('formatTokens', () => {
  it('groups thousands', () => {
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});
