import { describe, expect, it, beforeEach } from 'vitest';
import {
  __applyEventForTests as applyEvent,
  __resetWingmanForTests,
  reviewQueue,
  transcriptToChat,
  useWingman,
} from '../wingman';
import type { WingmanCard, WingmanStreamEvent, WingmanSubRow } from '../../lib/tauri';

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

describe('review queue', () => {
  const task = (over: Partial<WingmanSubRow> & { task_id: string }): WingmanSubRow => ({
    title: over.task_id,
    status: 'done',
    role: null,
    agent_name: null,
    model: null,
    usd: 0,
    attempts: 0,
    writes: 0,
    elapsed_secs: null,
    current_tool: null,
    outcome: null,
    worktree: `/wt/${over.task_id}`,
    session_id: null,
    deps: [],
    blocked_by: [],
    ...over,
  });

  const card = (id: string, subrows: WingmanSubRow[]): WingmanCard => ({
    id,
    short: null,
    project: 'proj',
    project_name: 'Proj',
    project_missing: false,
    title: `card ${id}`,
    goal: null,
    notes: null,
    column: 'in_progress',
    archived: false,
    labels: [],
    badges: [],
    rollup: {
      status: null,
      total: subrows.length,
      done: 0,
      failed: 0,
      blocked: 0,
      in_progress: 0,
      not_started: 0,
      review: 0,
      usd: 0,
      subrows,
    },
    run_id: `run-${id}`,
    created_at: null,
  });

  it('flattens every card and run into one list', () => {
    const q = reviewQueue([
      card('a', [task({ task_id: 't1' }), task({ task_id: 't2' })]),
      card('b', [task({ task_id: 't3' })]),
    ]);
    expect(q).toHaveLength(3);
    expect(q.map((i) => i.task.task_id).sort()).toEqual(['t1', 't2', 't3']);
    // Each entry carries the context needed to act without re-querying.
    expect(q[0]?.cardTitle).toMatch(/^card /);
    expect(q[0]?.runId).toMatch(/^run-/);
  });

  it('drops tasks with no worktree', () => {
    // No worktree means no diff. A queue entry you can't act on is noise.
    const q = reviewQueue([
      card('a', [task({ task_id: 'pending', worktree: null }), task({ task_id: 'real' })]),
    ]);
    expect(q.map((i) => i.task.task_id)).toEqual(['real']);
  });

  it('orders by what needs a decision, then by cost', () => {
    const q = reviewQueue([
      card('a', [
        task({ task_id: 'done-cheap', status: 'done', usd: 0.1 }),
        task({ task_id: 'running', status: 'in_progress' }),
        task({ task_id: 'review-cheap', status: 'review', usd: 0.5 }),
        task({ task_id: 'failed', status: 'failed' }),
        task({ task_id: 'review-pricey', status: 'review', usd: 9.0 }),
      ]),
    ]);
    expect(q.map((i) => i.task.task_id)).toEqual([
      // review first, priciest first within it — the costliest work is the
      // most wasteful to leave unreviewed
      'review-pricey',
      'review-cheap',
      'failed',
      'running',
      'done-cheap',
    ]);
  });

  it('puts unknown statuses last rather than dropping them', () => {
    const q = reviewQueue([
      card('a', [
        task({ task_id: 'weird', status: 'some_new_status' }),
        task({ task_id: 'normal', status: 'review' }),
      ]),
    ]);
    expect(q.map((i) => i.task.task_id)).toEqual(['normal', 'weird']);
  });

  it('handles an empty board', () => {
    expect(reviewQueue([])).toEqual([]);
    expect(reviewQueue(undefined as never)).toEqual([]);
    // A card whose run has not produced a rollup yet.
    expect(reviewQueue([{ ...card('a', []), rollup: null }])).toEqual([]);
  });
});

describe('transcript replay', () => {
  it('produces the same rows a live turn would', () => {
    // The point of the mapper: a resumed conversation must be
    // indistinguishable from one you watched stream. Stored transcripts nest
    // tool calls inside an assistant message and record results separately,
    // so this reconciles two different shapes onto one row set.
    const rows = transcriptToChat([
      { kind: 'session_start', ts: 't', model: 'm', provider: 'p' },
      { kind: 'user', ts: 't', text: 'what changed?' },
      {
        kind: 'assistant',
        ts: 't',
        blocks: [
          { type: 'thinking', text: 'consider the diff' },
          { type: 'text', text: 'Let me look. ' },
          { type: 'text', text: 'One moment.' },
          { type: 'tool_use', id: 'c1', name: 'git_diff', input: { staged: false } },
        ],
      },
      { kind: 'tool_result', ts: 't', id: 'c1', output: '3 files', is_error: false },
      { kind: 'assistant', ts: 't', blocks: [{ type: 'text', text: 'Three files changed.' }] },
    ]);

    expect(rows.map((r) => r.kind)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool',
      'assistant',
    ]);
    // Sibling text blocks in one message read as a single answer.
    expect(rows[2]).toEqual({ kind: 'assistant', text: 'Let me look. One moment.' });
    const tool = rows.find((r) => r.kind === 'tool');
    expect(tool?.output).toBe('3 files');
    expect(tool?.isError).toBe(false);
    expect(tool?.name).toBe('git_diff');
  });

  it('skips record kinds ARC has no row for', () => {
    // Compaction recaps, pruned tool results and system-prompt splices are all
    // written to the log. An older ARC must not break on a newer daemon's.
    const rows = transcriptToChat([
      { kind: 'recap', ts: 't', replaced: 12, text: 'earlier turns folded' },
      { kind: 'tool_result_pruned', ts: 't', id: 'x', content: 'shrunk' },
      { kind: 'something_new_entirely', ts: 't' },
      { kind: 'user', ts: 't', text: 'still here' },
    ]);
    expect(rows).toEqual([{ kind: 'user', text: 'still here' }]);
  });

  it('drops a tool result whose call is missing', () => {
    // Compaction can fold away the assistant message that made the call while
    // leaving the result behind.
    const rows = transcriptToChat([
      { kind: 'tool_result', ts: 't', id: 'orphan', output: 'x' },
    ]);
    expect(rows).toHaveLength(0);
  });

  it('handles an empty or absent transcript', () => {
    expect(transcriptToChat([])).toEqual([]);
    expect(transcriptToChat(undefined as never)).toEqual([]);
  });

  it('ignores image blocks without losing the surrounding text', () => {
    const rows = transcriptToChat([
      {
        kind: 'assistant',
        ts: 't',
        blocks: [
          { type: 'text', text: 'see this' },
          { type: 'image', data: 'base64…', media_type: 'image/png' },
        ],
      },
    ]);
    expect(rows).toEqual([{ kind: 'assistant', text: 'see this' }]);
  });
});
