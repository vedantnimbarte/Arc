import { describe, expect, it } from 'vitest';
import { agentTouched, type AgentBaseline } from '../agentRun';

/**
 * The whole review surface reduces to this predicate, so it is the one thing
 * worth pinning: get it wrong and the panel either hides the agent's work or
 * claims your own edits as its.
 */
describe('agentTouched', () => {
  const before: AgentBaseline['before'] = {
    'src/mine.ts': 'M',
    'src/staged.ts': 'M',
  };

  it('counts a file the agent created', () => {
    expect(agentTouched(before, { path: 'src/new.ts', status: '?' })).toBe(true);
  });

  it('ignores an edit that was already there when the agent started', () => {
    expect(agentTouched(before, { path: 'src/mine.ts', status: 'M' })).toBe(false);
  });

  it('counts a file whose status moved under the agent', () => {
    // Was modified-in-worktree at launch, now staged.
    expect(agentTouched(before, { path: 'src/staged.ts', status: 'A' })).toBe(true);
  });

  it('treats every change as the agent on a clean tree', () => {
    expect(agentTouched({}, { path: 'anything.ts', status: 'M' })).toBe(true);
  });
});
