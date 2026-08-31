import { describe, expect, it, beforeEach } from 'vitest';
import {
  __applyEventForTests as applyEvent,
  __resetClaudeForTests,
  editedPath,
  summarizeToolInput,
  useClaudeCode,
} from '../claudeCode';
import type { ClaudeStreamEvent } from '../../lib/tauri';

/** Drive the reducer the way the IPC listener does. */
function feed(...events: ClaudeStreamEvent[]) {
  for (const ev of events) {
    applyEvent((fn) => useClaudeCode.setState(fn as never), ev);
  }
  return useClaudeCode.getState();
}

const delta = (text: string): ClaudeStreamEvent => ({
  kind: 'text_delta',
  payload: { text },
});

describe('claude code stream folding', () => {
  beforeEach(() => __resetClaudeForTests());

  it('coalesces text deltas into one assistant row', () => {
    // The CLI emits one delta per token with --include-partial-messages.
    // Without coalescing a short answer becomes dozens of transcript rows.
    const s = feed(delta('Hel'), delta('lo'), delta(' there'));
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0]).toEqual({ kind: 'assistant', text: 'Hello there' });
  });

  it('keeps reasoning separate from the answer', () => {
    const s = feed(
      { kind: 'thinking_delta', payload: { text: 'hmm' } },
      delta('answer'),
      { kind: 'thinking_delta', payload: { text: 'more' } },
    );
    expect(s.chat.map((c) => c.kind)).toEqual(['thinking', 'assistant', 'thinking']);
  });

  it('captures the session id so the next turn resumes it', () => {
    // Conversation history lives in the CLI, not in ARC — this id is the
    // whole mechanism, so losing it silently starts a fresh conversation.
    const s = feed({ kind: 'init', payload: { session_id: 'sess-1' } });
    expect(s.sessionId).toBe('sess-1');
  });

  it('attaches a tool result to its own call', () => {
    const s = feed(
      { kind: 'tool_start', payload: { id: 'a', name: 'Read', input: { file_path: 'x' } } },
      { kind: 'tool_start', payload: { id: 'b', name: 'Bash', input: { command: 'ls' } } },
      { kind: 'tool_result', payload: { id: 'b', output: 'ok', is_error: false } },
    );
    expect(s.chat).toHaveLength(2);
    const tools = s.chat.filter((c) => c.kind === 'tool');
    expect(tools[0]?.output).toBeUndefined();
    expect(tools[1]?.output).toBe('ok');
  });

  it('builds the review list from write tools only', () => {
    // The review list answers "what changed". Padding it with every file
    // Claude read would bury the one it edited.
    const s = feed(
      { kind: 'tool_start', payload: { id: '1', name: 'Read', input: { file_path: '/r/a.ts' } } },
      { kind: 'tool_start', payload: { id: '2', name: 'Edit', input: { file_path: '/r/b.ts' } } },
      { kind: 'tool_start', payload: { id: '3', name: 'Write', input: { file_path: '/r/c.ts' } } },
    );
    expect(s.editedFiles.map((f) => f.path)).toEqual(['/r/b.ts', '/r/c.ts']);
  });

  it('counts repeat edits instead of duplicating the row', () => {
    const s = feed(
      { kind: 'tool_start', payload: { id: '1', name: 'Edit', input: { file_path: '/r/b.ts' } } },
      { kind: 'tool_start', payload: { id: '2', name: 'Edit', input: { file_path: '/r/b.ts' } } },
    );
    expect(s.editedFiles).toHaveLength(1);
    expect(s.editedFiles[0]?.edits).toBe(2);
  });

  it('accumulates cost across turns', () => {
    // The CLI bills per turn; the running total is what answers "what has
    // this conversation cost me".
    const s = feed(
      { kind: 'result', payload: { cost_usd: 0.02, session_id: 's' } },
      { kind: 'done', payload: {} },
      { kind: 'result', payload: { cost_usd: 0.03, session_id: 's' } },
    );
    expect(s.costUsd).toBeCloseTo(0.05);
  });

  it('surfaces permission denials by tool name', () => {
    const s = feed({
      kind: 'result',
      payload: { permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Write' }] },
    });
    expect(s.denials).toEqual(['Bash', 'Write']);
  });

  it('reports a turn that failed after producing output', () => {
    const s = feed(
      delta('partial answer'),
      { kind: 'result', payload: { is_error: true, text: 'budget exhausted' } },
    );
    expect(s.chat.at(-1)).toEqual({ kind: 'error', message: 'budget exhausted' });
  });

  it('ends the turn on error and on done', () => {
    useClaudeCode.setState({ streaming: true, activeTopic: 'claude://turn/1' });
    expect(feed({ kind: 'error', payload: { message: 'boom' } }).streaming).toBe(false);

    useClaudeCode.setState({ streaming: true, activeTopic: 'claude://turn/2' });
    const s = feed({ kind: 'done', payload: {} });
    expect(s.streaming).toBe(false);
    expect(s.activeTopic).toBeNull();
  });
});

describe('permission prompts', () => {
  beforeEach(() => __resetClaudeForTests());

  it('blocks the turn on a request and describes what will run', () => {
    const s = feed({
      kind: 'permission_request',
      payload: {
        request_id: 'req-1',
        tool_name: 'Bash',
        input: { command: 'rm -rf build' },
      },
    });
    expect(s.pending?.requestId).toBe('req-1');
    expect(s.pending?.tool).toBe('Bash');
    // The summary is the point: "allow Bash?" is not a decision anyone can make.
    expect(s.pending?.summary).toBe('rm -rf build');
  });

  it('prefers an MCP tool’s own display name', () => {
    const s = feed({
      kind: 'permission_request',
      payload: { request_id: 'r', tool_name: 'mcp__db__query', display_name: 'Database' },
    });
    expect(s.pending?.tool).toBe('Database');
  });

  it('clears the prompt when the turn ends without an answer', () => {
    // A cancelled turn must not leave a prompt that answers into a dead child.
    useClaudeCode.setState({ streaming: true, activeTopic: 'claude://turn/1' });
    feed({ kind: 'permission_request', payload: { request_id: 'r', tool_name: 'Bash' } });
    expect(useClaudeCode.getState().pending).not.toBeNull();

    const s = feed({ kind: 'error', payload: { message: 'turn cancelled' } });
    expect(s.pending).toBeNull();
    expect(s.streaming).toBe(false);
  });

  it('records the answer in the transcript', async () => {
    useClaudeCode.setState({
      activeTopic: 'claude://turn/1',
      pending: {
        requestId: 'r',
        tool: 'Bash',
        input: { command: 'ls' },
        title: null,
        description: null,
        summary: 'ls',
      },
    });
    // The IPC call rejects outside Tauri; what matters is that the prompt is
    // cleared and the decision is logged either way.
    await useClaudeCode.getState().respond(true);
    const s = useClaudeCode.getState();
    expect(s.pending).toBeNull();
    expect(s.chat.some((c) => c.kind === 'decision' && c.allowed)).toBe(true);
  });

  it('does nothing when there is no prompt to answer', async () => {
    await useClaudeCode.getState().respond(true);
    expect(useClaudeCode.getState().chat).toHaveLength(0);
  });
});

describe('summarizeToolInput', () => {
  it('picks the field that carries the substance', () => {
    expect(summarizeToolInput('Bash', { command: 'git push' })).toBe('git push');
    expect(summarizeToolInput('Edit', { file_path: '/r/a.ts' })).toBe('/r/a.ts');
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(summarizeToolInput('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev');
  });

  it('falls back to compact JSON for unknown tools', () => {
    expect(summarizeToolInput('mcp__x__y', { a: 1 })).toBe('{"a":1}');
    expect(summarizeToolInput('Bash', null)).toBe('');
  });

  it('truncates a huge payload rather than flooding the prompt', () => {
    const big = summarizeToolInput('Unknown', { blob: 'x'.repeat(1000) });
    expect(big.length).toBeLessThanOrEqual(301);
    expect(big.endsWith('…')).toBe(true);
  });
});

describe('editedPath', () => {
  it('names the written file for each write tool', () => {
    expect(editedPath('Edit', { file_path: '/r/a.ts' })).toBe('/r/a.ts');
    expect(editedPath('NotebookEdit', { notebook_path: '/r/n.ipynb' })).toBe('/r/n.ipynb');
  });

  it('ignores read-only tools and malformed input', () => {
    expect(editedPath('Read', { file_path: '/r/a.ts' })).toBeNull();
    expect(editedPath('Edit', { file_path: '   ' })).toBeNull();
    expect(editedPath('Edit', undefined)).toBeNull();
  });
});
