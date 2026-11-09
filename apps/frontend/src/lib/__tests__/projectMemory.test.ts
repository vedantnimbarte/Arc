import { describe, expect, it } from 'vitest';
import { firstLine, parseFrontMatter, uniqueByPath } from '../projectMemory';

describe('uniqueByPath', () => {
  it('keeps the first of entries that point at the same file', () => {
    const items = [
      { path: 'C:\\Users\\me\\.claude\\skills\\a\\SKILL.md', scope: 'project' },
      { path: 'C:/Users/me/.claude/skills/a/SKILL.md', scope: 'global' },
    ];
    expect(uniqueByPath(items)).toEqual([items[0]]);
  });
});
import { explainChangesPrompt } from '../agentPrompt';

describe('parseFrontMatter', () => {
  it('reads name and description, unquoting values', () => {
    const text = '---\nname: deploy\ndescription: "Ship it to staging"\n---\n# Deploy\n';
    expect(parseFrontMatter(text)).toEqual({ name: 'deploy', description: 'Ship it to staging' });
  });

  it('returns nothing without front matter', () => {
    expect(parseFrontMatter('# Just a heading')).toEqual({});
  });
});

describe('firstLine', () => {
  it('skips front matter and strips heading markers', () => {
    expect(firstLine('---\nname: x\n---\n\n## Build rules\nmore')).toBe('Build rules');
  });
});

describe('explainChangesPrompt', () => {
  it('lists each changed file with its line counts', () => {
    const prompt = explainChangesPrompt([{ path: 'src/a.ts', added: 3, removed: 1 }]);
    expect(prompt).toContain('- src/a.ts (+3 -1)');
    expect(prompt).toContain('Do not make further edits.');
  });
});
