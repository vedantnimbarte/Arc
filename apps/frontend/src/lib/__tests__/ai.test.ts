import { describe, expect, it } from 'vitest';
import { AiError, parseCommand, parseExplanation } from '../ai';

const message = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'message', stop_reason: 'end_turn', content, ...extra });

describe('parseCommand', () => {
  it('returns the text block', () => {
    expect(parseCommand(200, message([{ type: 'text', text: 'ls -la' }]))).toBe('ls -la');
  });

  it('skips thinking blocks (adaptive thinking is on by default)', () => {
    const body = message([
      { type: 'thinking', thinking: 'the user wants a listing' },
      { type: 'text', text: 'ls -la' },
    ]);
    expect(parseCommand(200, body)).toBe('ls -la');
  });

  it('unwraps a markdown fence the model added anyway', () => {
    const body = message([{ type: 'text', text: '```bash\ngit log --oneline -5\n```' }]);
    expect(parseCommand(200, body)).toBe('git log --oneline -5');
  });

  it('surfaces the API error message on a non-200', () => {
    const body = JSON.stringify({ error: { message: 'credit balance is too low' } });
    expect(() => parseCommand(400, body)).toThrow(/credit balance is too low/);
  });

  it('explains a 401 even when the body is unparseable', () => {
    expect(() => parseCommand(401, 'nope')).toThrow(AiError);
    expect(() => parseCommand(401, 'nope')).toThrow(/key rejected/i);
  });

  it('reports a refusal rather than returning empty text', () => {
    const body = message([{ type: 'text', text: '' }], { stop_reason: 'refusal' });
    expect(() => parseCommand(200, body)).toThrow(/declined/i);
  });

  it('rejects a response with no text block', () => {
    expect(() => parseCommand(200, message([]))).toThrow(/no command/i);
  });
});

describe('parseExplanation', () => {
  const ok = (text: string) =>
    JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

  it('splits a trailing FIX line from the explanation', () => {
    const out = parseExplanation(200, ok('The branch has no upstream.\nFIX: git push -u origin HEAD'));
    expect(out.explanation).toBe('The branch has no upstream.');
    expect(out.fix).toBe('git push -u origin HEAD');
  });

  it('returns no fix when the model omits the line', () => {
    const out = parseExplanation(200, ok('Two people edited the same file; resolve by hand.'));
    expect(out.fix).toBeNull();
    expect(out.explanation).toContain('resolve by hand');
  });

  it('only treats FIX as a marker at the start of a line', () => {
    // An explanation that merely mentions the word must not be truncated.
    const out = parseExplanation(200, ok('The Makefile target named FIX: does not exist.'));
    expect(out.fix).toBeNull();
    expect(out.explanation).toContain('does not exist');
  });

  it('unwraps a fenced fix, which the model is told not to send but sometimes does', () => {
    const out = parseExplanation(200, ok('Missing dependency.\nFIX: ```npm install```'));
    expect(out.fix).toBe('npm install');
  });

  it('still says something when the reply is only a fix', () => {
    const out = parseExplanation(200, ok('FIX: cargo build'));
    expect(out.fix).toBe('cargo build');
    expect(out.explanation).toBeTruthy();
  });

  it('surfaces API errors the same way command parsing does', () => {
    expect(() => parseExplanation(401, JSON.stringify({ error: { message: 'bad key' } }))).toThrow(
      'bad key',
    );
    expect(() => parseExplanation(200, ok(''))).toThrow(AiError);
  });
});
