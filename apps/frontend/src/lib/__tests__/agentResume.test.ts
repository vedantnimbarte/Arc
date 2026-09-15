import { describe, expect, it } from 'vitest';
import { isTerminalReply } from '../agentResume';

describe('isTerminalReply', () => {
  it('recognises the answers xterm sends by itself', () => {
    for (const reply of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[I', '\x1b[O', '\x1b]11;rgb:0000/0000/0000\x07']) {
      expect(isTerminalReply(reply)).toBe(true);
    }
  });

  it('passes real keystrokes through', () => {
    for (const key of ['ls\r', 'a', '\x1b[A', '\x1b[1;5C', '\x03', '\x1b']) {
      expect(isTerminalReply(key)).toBe(false);
    }
  });
});
