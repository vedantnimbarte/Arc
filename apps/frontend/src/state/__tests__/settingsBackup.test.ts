import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/tauri', () => ({
  isTauri: false,
  sessionSettingsLoad: vi.fn(async () => null),
  sessionSettingsSave: vi.fn(async () => {}),
  settingsBroadcastChanged: vi.fn(async () => {}),
  AI_CLI_COMMANDS: { 'claude-cli': 'claude' },
  AI_CLIS: { 'claude-cli': 'Claude Code' },
}));
vi.mock('../../themes', () => ({
  applyFontFamily: vi.fn(),
  applyTheme: vi.fn(),
  resolveActiveTheme: vi.fn(() => 'dark'),
  onSystemAppearanceChange: vi.fn(),
  DEFAULT_APPEARANCE: 'system',
  DEFAULT_FONT_ID: 'sf-mono',
  DEFAULT_FONT_SIZE: 13,
  MAX_FONT_SIZE: 24,
  MIN_FONT_SIZE: 9,
}));
vi.mock('../../lib/themeMarketplace', () => ({ loadInstalledThemes: vi.fn(async () => {}) }));

const { useSettings, exportSettingsJson, importSettingsJson, coerceHighlightRules } =
  await import('../settings');

describe('settings backup', () => {
  it('round-trips through export and import', () => {
    useSettings.setState({
      defaultShell: '/bin/zsh',
      fontSize: 15,
      relaunchAgentTabs: true,
      highlightRules: [{ id: 'r1', pattern: 'error', color: '#ff0000', notify: true, enabled: true }],
    });
    const file = exportSettingsJson();
    useSettings.setState({ defaultShell: null, fontSize: 13, relaunchAgentTabs: false, highlightRules: [] });

    importSettingsJson(file);
    const s = useSettings.getState();
    expect(s.defaultShell).toBe('/bin/zsh');
    expect(s.fontSize).toBe(15);
    expect(s.relaunchAgentTabs).toBe(true);
    expect(s.highlightRules).toHaveLength(1);
  });

  it('rejects files that are not an ARC export', () => {
    expect(() => importSettingsJson('nope')).toThrow('Not valid JSON.');
    expect(() => importSettingsJson('{"fontSize": 20}')).toThrow('Not an ARC settings export.');
  });

  it('coerces bad highlight rules', () => {
    const rules = coerceHighlightRules(
      [{ id: 'a', pattern: 'x', color: 'javascript:1' }, { pattern: 'no id' }, 'junk'],
      [],
    );
    expect(rules).toEqual([{ id: 'a', pattern: 'x', color: '#e5534b', notify: false, enabled: true }]);
    expect(coerceHighlightRules('not an array', [])).toEqual([]);
  });
});
