import { describe, expect, it, beforeEach } from 'vitest';
import { __applyEventForTests as applyEvent, __resetWingmanForTests, useWingman } from '../wingman';
import type { WingmanStreamEvent } from '../../lib/tauri';

/** Drive the reducer the way the IPC listener does. */
function feed(...events: WingmanStreamEvent[]) {
  for (const ev of events) {
    applyEvent((fn) => useWingman.setState(fn as never), ev);
  }
  return useWingman.getState();
}

const delta = (text: string): WingmanStreamEvent => ({ kind: 'text_delta', payload: { text } });

describe('wingman stream folding', () => {
  beforeEach(() => __resetWingmanForTests());

  it('coalesces text deltas into one assistant row', () => {
    // The whole point: a turn emits one delta per token. Without coalescing a
    // short answer becomes dozens of transcript rows.
    const s = feed(delta('Hel'), delta('lo'), delta(' there'));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toEqual({ kind: 'assistant', text: 'Hello there' });
  });

  it('keeps thinking separate from the answer', () => {
    const s = feed(
      { kind: 'thinking_delta', payload: { text: 'hmm' } },
      delta('answer'),
      { kind: 'thinking_delta', payload: { text: 'more' } },
    );
    expect(s.chat.map((c) => c.kind)).toEqual(['thinking', 'assistant', 'thinking']);
  });

  it('attaches a tool result to its own call', () => {
    const s = feed(
      { kind: 'tool_start', payload: { id: 'a', name: 'read_file', input: { path: 'x' } } },
      { kind: 'tool_start', payload: { id: 'b', name: 'run_shell', input: { cmd: 'ls' } } },
      { kind: 'tool_result', payload: { id: 'b', output: 'ok', is_error: false } },
    );
    expect(s.chat).toHaveLength(2);
    const tools = s.chat.filter((c) => c.kind === 'tool');
    expect(tools[0]?.output).toBeUndefined();
    expect(tools[1]?.output).toBe('ok');
    expect(tools[1]?.isError).toBe(false);
  });

  it('ignores a tool result with no matching call', () => {
    // A reconnect mid-turn can deliver a result whose start we never saw.
    // Dropping it beats pushing an orphan row.
    const s = feed({ kind: 'tool_result', payload: { id: 'ghost', output: 'x' } });
    expect(s.chat).toHaveLength(0);
  });

  it('records cumulative usage including cache fields', () => {
    const s = feed({
      kind: 'usage',
      payload: {
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        },
      },
    });
    expect(s.usage).toEqual({ input: 10, output: 4, cacheRead: 900, cacheWrite: 50 });
  });

  it('stops streaming on stop, done, and error', () => {
    for (const kind of ['stop', 'done', 'error']) {
      __resetWingmanForTests();
      useWingman.setState({ streaming: true });
      feed({ kind, payload: { message: 'boom' } });
      expect(useWingman.getState().streaming, `${kind} must end the turn`).toBe(false);
    }
  });

  it('keeps streaming through turn_complete', () => {
    // turn_complete is one provider round-trip inside a user turn, not the end
    // of it — the composer must stay disabled through a multi-step tool loop.
    __resetWingmanForTests();
    useWingman.setState({ streaming: true });
    feed({ kind: 'turn_complete', payload: {} });
    expect(useWingman.getState().streaming).toBe(true);
  });

  it('surfaces a verification result as its own row', () => {
    const s = feed({
      kind: 'verification',
      payload: { passed: false, summary: '2 tests failed' },
    });
    expect(s.chat[0]).toEqual({
      kind: 'verification',
      passed: false,
      summary: '2 tests failed',
    });
  });

  it('drops empty deltas rather than creating blank rows', () => {
    const s = feed(delta(''), { kind: 'text_delta', payload: {} });
    expect(s.chat).toHaveLength(0);
  });

  it('ignores unknown event kinds', () => {
    // Wingman can add events; an older ARC must not break on them.
    const s = feed({ kind: 'something_new', payload: { whatever: 1 } });
    expect(s.chat).toHaveLength(0);
  });
});
