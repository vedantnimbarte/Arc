import { describe, expect, it } from 'vitest';
import { scoreAction, type CommandAction } from '../commands';

const action = (overrides: Partial<CommandAction>): CommandAction => ({
  id: 'test.action',
  title: 'New Terminal',
  group: 'Terminal',
  run: () => {},
  ...overrides,
});

describe('scoreAction', () => {
  it('ranks a title prefix above a mid-title substring', () => {
    const prefix = action({ title: 'Terminal: New' });
    const mid = action({ title: 'Open New Terminal' });
    expect(scoreAction(prefix, 'terminal')).toBeGreaterThan(scoreAction(mid, 'terminal'));
  });

  it('ranks a title match above a keyword-only match', () => {
    const titleHit = action({ title: 'New Terminal' });
    const keywordHit = action({ title: 'Launch Codex', keywords: ['terminal'] });
    expect(scoreAction(titleHit, 'term')).toBeGreaterThan(scoreAction(keywordHit, 'term'));
  });

  it('ranks a keyword match above a group-only match', () => {
    const keywordHit = action({ title: 'Launch Codex', keywords: ['ai clis'] });
    const groupHit = action({ title: 'Launch Codex', group: 'AI CLIs' });
    expect(scoreAction(keywordHit, 'ai clis')).toBeGreaterThan(scoreAction(groupHit, 'ai clis'));
  });

  it('does not search description text — only title, keywords, and group', () => {
    // Regression for the command-palette flood: every "Launch X" action's
    // description says "...running a new terminal tab...", so if this ever
    // scores a hit, "term" surfaces all of them again ahead of "New Terminal"
    // itself. `description` must stay display-only.
    const a = action({
      title: 'Launch Codex',
      group: 'AI CLIs',
      description: 'Open a new terminal tab running OpenAI Codex.',
    });
    expect(scoreAction(a, 'terminal')).toBe(-1);
  });

  it('returns -1 for no match at all', () => {
    expect(scoreAction(action({}), 'xyz')).toBe(-1);
  });
});
