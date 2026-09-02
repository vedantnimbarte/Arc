import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store only writes when it believes it is running under Tauri, so the
// module has to be mocked before it is imported.
const saved: string[] = [];
let stored: Record<string, unknown> | null = null;

vi.mock('../../lib/tauri', () => ({
  isTauri: true,
  sessionSettingsLoad: vi.fn(async () => stored),
  sessionSettingsSave: vi.fn(async (s: unknown) => {
    saved.push(JSON.stringify(s));
  }),
  settingsBroadcastChanged: vi.fn(async () => {}),
  AI_CLI_COMMANDS: { 'claude-cli': 'claude' },
  AI_CLIS: { 'claude-cli': 'Claude Code' },
}));

vi.mock('../../themes', () => ({
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
vi.mock('@tauri-apps/plugin-autostart', () => ({
  isEnabled: vi.fn(async () => false),
  enable: vi.fn(async () => {}),
  disable: vi.fn(async () => {}),
}));

const { useSettings, flushSettingsSave } = await import('../settings');

const FISH = '/usr/bin/fish';

beforeEach(() => {
  saved.length = 0;
  stored = null;
  useSettings.setState({ defaultShell: null, settingsHydrated: false });
});

describe('settings persistence', () => {
  /**
   * The launch-time race this guards.
   *
   * `hydrateSettings` used to set a flag before loading anything, which queued
   * a debounced write holding pristine defaults. The stored values then landed
   * under `suppressSave`, and that early return never cancelled the pending
   * timer — so 500ms later the stale snapshot was written over the user's row.
   * Every setting reverted on the next launch; the shell most visibly, since
   * it is the one you notice every time a terminal opens.
   *
   * Two changes in a row would not reproduce it: each reschedules the timer
   * with fresh state. It needs the second change to be a *suppressed* one,
   * which is why this drives the real hydrate rather than poking the store.
   */
  it('never writes pre-hydrate defaults over the loaded settings', async () => {
    stored = { defaultShell: FISH };

    vi.useFakeTimers();
    try {
      const hydrating = useSettings.getState().hydrateSettings();
      // Run out every debounce the boot sequence may have queued.
      await vi.advanceTimersByTimeAsync(1000);
      await hydrating;
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      vi.useRealTimers();
    }

    expect(useSettings.getState().defaultShell).toBe(FISH);
    // The assertion that matters: nothing ever wrote the pre-hydrate value.
    for (const write of saved) {
      expect((JSON.parse(write) as { defaultShell: string | null }).defaultShell).toBe(FISH);
    }
  });

  it('round-trips a chosen shell through the persisted shape', async () => {
    useSettings.getState().setDefaultShell(FISH);
    await flushSettingsSave();
    const written = JSON.parse(saved.at(-1)!) as { defaultShell: string | null };
    expect(written.defaultShell).toBe(FISH);
  });

  it('persists an explicit "system default" rather than dropping the key', async () => {
    useSettings.getState().setDefaultShell(FISH);
    await flushSettingsSave();
    useSettings.getState().setDefaultShell(null);
    await flushSettingsSave();

    const written = JSON.parse(saved.at(-1)!) as Record<string, unknown>;
    expect('defaultShell' in written).toBe(true);
    expect(written.defaultShell).toBeNull();
  });
});
