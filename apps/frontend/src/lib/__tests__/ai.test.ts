import { describe, expect, it } from 'vitest';
import { AiError, parseCommand } from '../ai';

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
