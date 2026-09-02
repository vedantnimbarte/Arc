import { describe, expect, it } from 'vitest';
import { parseCommand } from '../AgentLauncher';
import { AI_CLI_COMMANDS, AI_CLIS } from '../../lib/tauri';

// The start command is user-editable and its first token becomes the binary
// that gets spawned, so mis-splitting it is how you launch the wrong program.

describe('parseCommand', () => {
  it('splits a bare command and its flags', () => {
    expect(parseCommand('claude')).toEqual(['claude']);
    expect(parseCommand('claude --model opus')).toEqual(['claude', '--model', 'opus']);
  });

  it('keeps a quoted argument together', () => {
    expect(parseCommand('claude --system "be terse"')).toEqual([
      'claude',
      '--system',
      'be terse',
    ]);
  });

  it('collapses surrounding and repeated whitespace', () => {
    expect(parseCommand('   aider   --yes  ')).toEqual(['aider', '--yes']);
    expect(parseCommand('\tcodex\n--full-auto')).toEqual(['codex', '--full-auto']);
  });

  it('returns nothing for blank input, which is what disables Launch', () => {
    expect(parseCommand('')).toEqual([]);
    expect(parseCommand('    ')).toEqual([]);
  });
});

describe('AI_CLI_COMMANDS', () => {
  // The launcher prefills from this table for all thirteen agents, including
  // ones the detector never returns, so a missing row is an empty command box.
  it('names a command for every supported agent', () => {
    for (const id of Object.keys(AI_CLIS) as (keyof typeof AI_CLIS)[]) {
      expect(AI_CLI_COMMANDS[id], `no command for ${id}`).toBeTruthy();
    }
    expect(Object.keys(AI_CLI_COMMANDS).sort()).toEqual(Object.keys(AI_CLIS).sort());
  });

  it('uses the binary stem, not the id, where the two differ', () => {
    // The two that break the `id.replace(/-cli$/, '')` shortcut — the reason
    // this table is written out rather than derived.
    expect(AI_CLI_COMMANDS['kimi-code-cli']).toBe('kimi');
    expect(AI_CLI_COMMANDS['qwen-code-cli']).toBe('qwen');
  });

  it('carries every agent the Rust detector probes for', () => {
    // These two tables and the `candidates` list in rust/pty/src/lib.rs have to
    // move together; the Rust side cannot import this one, so the check is a
    // spot assertion on the entries most recently added.
    expect(AI_CLIS['grok-cli']).toBe('Grok');
    expect(AI_CLIS['pi-cli']).toBe('Pi');
    expect(AI_CLI_COMMANDS['grok-cli']).toBe('grok');
    expect(AI_CLI_COMMANDS['pi-cli']).toBe('pi');
  });

  it('is a single token per agent — a stem, not a command line', () => {
    for (const cmd of Object.values(AI_CLI_COMMANDS)) {
      expect(cmd.trim()).toBe(cmd);
      expect(cmd.split(/\s/)).toHaveLength(1);
    }
  });
});
