import { describe, expect, it } from 'vitest';
import { expandSlash, parseSlash, slashMatches } from '../slashCommands';

describe('slash commands', () => {
  it('expand into instructions that use the orchestration tools', () => {
    const handoff = expandSlash('/handoff add dark mode to settings');
    expect(handoff).toContain('Hand off this task to another agent: add dark mode to settings');
    expect(handoff).toContain('start_agent');
    expect(handoff).toContain('worktree: true');
    expect(handoff).toContain('wait_for_agent');

    // Read-only patterns keep helpers out of the worktree business.
    expect(expandSlash('/advisor is a queue the right fit?')).toContain('worktree: false');
    const committee = expandSlash('/committee why is CI flaky?');
    expect(committee).toContain('two helpers');
    expect(committee).toContain('worktree: false');
  });

  it('leave everything else alone', () => {
    expect(expandSlash('fix the build')).toBe('fix the build');
    expect(expandSlash('/compact')).toBe('/compact'); // the agent's own command
    expect(expandSlash('/handoff')).toBe('/handoff'); // nothing to hand off
  });

  it('parse case-insensitively and keep a multi-line argument', () => {
    expect(parseSlash('/HandOff do it\nand test it')).toMatchObject({
      cmd: { name: 'handoff' },
      arg: 'do it\nand test it',
    });
  });

  it('suggest commands only while the name is being typed', () => {
    expect(slashMatches('/').map((c) => c.name)).toEqual(['handoff', 'advisor', 'committee']);
    expect(slashMatches('/ad').map((c) => c.name)).toEqual(['advisor']);
    expect(slashMatches('/advisor ')).toEqual([]);
    expect(slashMatches('hi /ad')).toEqual([]);
  });
});
