import { describe, expect, it } from 'vitest';
import { classifyMarkdownLink, resolveMarkdownPath } from '../markdownLinks';

describe('resolveMarkdownPath', () => {
  it('resolves against the file directory', () => {
    expect(resolveMarkdownPath('/repo/docs/guide.md', './img/a.png')).toBe('/repo/docs/img/a.png');
    expect(resolveMarkdownPath('/repo/docs/guide.md', '../README.md')).toBe('/repo/README.md');
  });

  it('handles Windows paths and percent-encoding', () => {
    expect(resolveMarkdownPath('C:\\repo\\docs\\guide.md', 'my%20shot.png')).toBe(
      'C:\\repo\\docs\\my shot.png',
    );
  });

  it('strips fragments and queries', () => {
    expect(resolveMarkdownPath('/repo/a.md', 'b.md#setup')).toBe('/repo/b.md');
    expect(resolveMarkdownPath('/repo/a.md', '#setup')).toBeNull();
  });

  it('ignores URLs and remote files', () => {
    expect(resolveMarkdownPath('/repo/a.md', 'https://x.dev/a.png')).toBeNull();
    expect(resolveMarkdownPath('/repo/a.md', 'data:image/png;base64,AA')).toBeNull();
    expect(resolveMarkdownPath('/repo/a.md', '//cdn.dev/a.png')).toBeNull();
    expect(resolveMarkdownPath('ssh://h/repo/a.md', 'b.png')).toBeNull();
  });
});

describe('classifyMarkdownLink', () => {
  it('sends http(s) to the browser', () => {
    expect(classifyMarkdownLink('/repo/a.md', 'https://arc.dev')).toEqual({
      kind: 'external',
      url: 'https://arc.dev',
    });
  });

  it('opens relative markdown files in ARC', () => {
    expect(classifyMarkdownLink('/repo/docs/a.md', '../CHANGELOG.markdown')).toEqual({
      kind: 'file',
      path: '/repo/CHANGELOG.markdown',
    });
  });

  it('does nothing for other schemes, anchors and non-markdown files', () => {
    expect(classifyMarkdownLink('/repo/a.md', 'javascript:alert(1)').kind).toBe('none');
    expect(classifyMarkdownLink('/repo/a.md', '#top').kind).toBe('none');
    expect(classifyMarkdownLink('/repo/a.md', 'src/main.rs').kind).toBe('none');
  });
});
