import { create } from 'zustand';
import {
  isTauri,
  sessionSettingsLoad,
  sessionSettingsSave,
  settingsBroadcastChanged,
  type PersistedSettings,
} from '../lib/tauri';
import {
  applyTheme,
  DEFAULT_APPEARANCE,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  onSystemAppearanceChange,
  resolveActiveTheme,
  type Appearance,
} from '../themes';
import { loadInstalledThemes } from '../lib/themeMarketplace';

export interface Settings {
  /** Path to the shell binary new terminals should spawn. `null` means
   *  "let the Rust side pick the OS default" (COMSPEC on Windows,
   *  `$SHELL` elsewhere). Applies to newly-opened tabs only; in-flight
   *  PTYs aren't restarted. */
  defaultShell: string | null;
  /** User's appearance preference. `'system'` follows the OS color scheme. */
  appearance: Appearance;
  /** Specific theme id (e.g. 'catppuccin-mocha'). When set + registered, it
   *  overrides the dark/light resolution from `appearance`. */
  themeId: string | null;
  /** Mono font id from `FONT_OPTIONS`. */
  fontId: string;
  /** Terminal / editor font size in px. */
  fontSize: number;
  /** Auto-launch ARC at OS login. Mirrors the autostart plugin's state. */
  launchAtLogin: boolean;
  /** Persist the main window's last position and size across launches. The
   *  Rust side reads this at startup; toggling takes effect after restart. */
  restoreWindowState: boolean;
  /** Enable Vim keybindings in the CodeMirror editor. Multi-cursor is always
   *  on; this gates the modal Vim layer specifically. */
  editorVimMode: boolean;
  /** Enable LSP features (diagnostics, hover, completion) in the editor.
   *  Off by default — requires the relevant language servers on PATH. */
  editorLsp: boolean;
  /** Fire a system notification when an OSC133-tracked command runs longer
   *  than `notifyThresholdSecs` and the window is unfocused (Tier 1.5). */
  notifyLongCommands: boolean;
  /** Duration (seconds) a command must exceed to notify. */
  notifyThresholdSecs: number;
  /** Play the OS notification sound alongside the toast. */
  notifySound: boolean;
  /** True once hydrateSettings() has applied stored values. */
  settingsHydrated: boolean;
  setDefaultShell: (shell: string | null) => void;
  setAppearance: (a: Appearance) => void;
  /** Pick a specific theme id, or pass `null` to fall back to the dark/light
   *  pair from `appearance`. */
  setThemeId: (id: string | null) => void;
  setFontId: (id: string) => void;
  setFontSize: (size: number) => void;
  /** Toggle autostart at login. Also syncs the OS-level registration via
   *  `tauri-plugin-autostart` — failures are logged but don't block the
   *  in-app preference flip. */
  setLaunchAtLogin: (on: boolean) => Promise<void>;
  setRestoreWindowState: (on: boolean) => void;
  setEditorVimMode: (on: boolean) => void;
  setEditorLsp: (on: boolean) => void;
  setNotifyLongCommands: (on: boolean) => void;
  setNotifyThresholdSecs: (secs: number) => void;
  setNotifySound: (on: boolean) => void;
  hydrateSettings: () => Promise<void>;
}

const DEFAULTS = {
  defaultShell: null as string | null,
  appearance: DEFAULT_APPEARANCE,
  themeId: null as string | null,
  fontId: DEFAULT_FONT_ID,
  fontSize: DEFAULT_FONT_SIZE,
  launchAtLogin: false,
  restoreWindowState: true,
  editorVimMode: false,
  editorLsp: false,
  notifyLongCommands: true,
  notifyThresholdSecs: 30,
  notifySound: false,
};

const MIN_NOTIFY_SECS = 5;
const MAX_NOTIFY_SECS = 3600;
const clampNotifySecs = (n: number): number =>
  Math.max(MIN_NOTIFY_SECS, Math.min(MAX_NOTIFY_SECS, Math.round(n)));

const clampFontSize = (n: number): number =>
  Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(n)));

const isAppearance = (v: unknown): v is Appearance =>
  v === 'dark' || v === 'light' || v === 'system';

export const useSettings = create<Settings>()((set, get) => ({
  ...DEFAULTS,
  settingsHydrated: false,

  setDefaultShell: (shell) => set({ defaultShell: shell }),

  setAppearance: (a) => {
    set({ appearance: a });
    applyTheme(resolveActiveTheme(a, get().themeId));
    if (isTauri) {
      const snapshot = toPersistedSettings(get());
      void sessionSettingsSave(snapshot)
        .then(() => settingsBroadcastChanged().catch(() => {}))
        .catch((err) => console.error('[settings] appearance save failed:', err));
    }
  },
  setThemeId: (id) => {
    set({ themeId: id });
    applyTheme(resolveActiveTheme(get().appearance, id));
    // Persist + broadcast via the debounced subscribe handler — no need to
    // fire a save here ourselves.
  },
  setFontId: (id) => set({ fontId: id }),
  setFontSize: (size) => set({ fontSize: clampFontSize(size) }),

  setLaunchAtLogin: async (on) => {
    set({ launchAtLogin: on });
    if (!isTauri) return;
    try {
      // Lazy-import so the web-only build doesn't try to load the Tauri
      // bridge module.
      const { enable, disable } = await import('@tauri-apps/plugin-autostart');
      if (on) await enable();
      else await disable();
    } catch (err) {
      console.error('[settings] autostart toggle failed:', err);
    }
  },
  setRestoreWindowState: (on) => set({ restoreWindowState: on }),
  setEditorVimMode: (on) => set({ editorVimMode: on }),
  setEditorLsp: (on) => set({ editorLsp: on }),
  setNotifyLongCommands: (on) => set({ notifyLongCommands: on }),
  setNotifyThresholdSecs: (secs) => set({ notifyThresholdSecs: clampNotifySecs(secs) }),
  setNotifySound: (on) => set({ notifySound: on }),

  hydrateSettings: async () => {
    if (get().settingsHydrated) return;
    set({ settingsHydrated: true });

    // Register user-installed themes (Tier 1.7) before resolving, so a stored
    // themeId pointing at one applies on first paint instead of falling back.
    if (isTauri) {
      try {
        await loadInstalledThemes();
      } catch (err) {
        console.error('[settings] installed themes load failed:', err);
      }
    }

    applyTheme(resolveActiveTheme(get().appearance, get().themeId));
    if (!isTauri) return;

    // Reconcile launchAtLogin with the OS: the user may have disabled
    // autostart from System Preferences or Task Manager directly, in which
    // case the stored preference would be a lie. The plugin's `isEnabled`
    // is the source of truth.
    try {
      const { isEnabled } = await import('@tauri-apps/plugin-autostart');
      const osEnabled = await isEnabled();
      if (osEnabled !== get().launchAtLogin) {
        suppressSave = true;
        set({ launchAtLogin: osEnabled });
        queueMicrotask(() => {
          suppressSave = false;
        });
      }
    } catch (err) {
      console.error('[settings] autostart probe failed:', err);
    }

    try {
      const stored = await sessionSettingsLoad();
      if (stored) {
        suppressSave = true;
        set((s) => applyStored(s, stored));
        applyTheme(resolveActiveTheme(get().appearance, get().themeId));
        queueMicrotask(() => {
          suppressSave = false;
        });
        return;
      }
    } catch (err) {
      console.error('[settings] SQLite load failed:', err);
    }

    // One-shot migration: legacy localStorage from the pre-keyring days.
    try {
      const raw = localStorage.getItem('arc-settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { state?: Partial<PersistedSettings> };
        const legacy = parsed.state ?? {};
        suppressSave = true;
        set((s) => applyStored(s, legacy));
        applyTheme(resolveActiveTheme(get().appearance, get().themeId));
        queueMicrotask(() => {
          suppressSave = false;
        });
        const next = useSettings.getState();
        await sessionSettingsSave(toPersistedSettings(next)).catch((err) =>
          console.error('[settings] SQLite migration save failed:', err),
        );
        localStorage.removeItem('arc-settings');
      }
    } catch (err) {
      console.error('[settings] localStorage migration failed:', err);
    }
  },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

/** Merge a stored settings blob into the current store state. */
function applyStored(
  current: Settings,
  stored: Partial<PersistedSettings>,
): Partial<Settings> {
  return {
    defaultShell: stored.defaultShell ?? current.defaultShell,
    appearance: isAppearance(stored.appearance) ? stored.appearance : current.appearance,
    themeId:
      stored.themeId === null
        ? null
        : typeof stored.themeId === 'string'
          ? stored.themeId
          : current.themeId,
    fontId: stored.fontId ?? current.fontId,
    fontSize:
      typeof stored.fontSize === 'number'
        ? clampFontSize(stored.fontSize)
        : current.fontSize,
    launchAtLogin:
      typeof stored.launchAtLogin === 'boolean'
        ? stored.launchAtLogin
        : current.launchAtLogin,
    restoreWindowState:
      typeof stored.restoreWindowState === 'boolean'
        ? stored.restoreWindowState
        : current.restoreWindowState,
    editorVimMode:
      typeof stored.editorVimMode === 'boolean'
        ? stored.editorVimMode
        : current.editorVimMode,
    editorLsp:
      typeof stored.editorLsp === 'boolean' ? stored.editorLsp : current.editorLsp,
    notifyLongCommands:
      typeof stored.notifyLongCommands === 'boolean'
        ? stored.notifyLongCommands
        : current.notifyLongCommands,
    notifyThresholdSecs:
      typeof stored.notifyThresholdSecs === 'number'
        ? clampNotifySecs(stored.notifyThresholdSecs)
        : current.notifyThresholdSecs,
    notifySound:
      typeof stored.notifySound === 'boolean' ? stored.notifySound : current.notifySound,
  };
}

function toPersistedSettings(s: Settings): PersistedSettings {
  return {
    defaultShell: s.defaultShell,
    appearance: s.appearance,
    themeId: s.themeId,
    fontId: s.fontId,
    fontSize: s.fontSize,
    launchAtLogin: s.launchAtLogin,
    restoreWindowState: s.restoreWindowState,
    editorVimMode: s.editorVimMode,
    editorLsp: s.editorLsp,
    notifyLongCommands: s.notifyLongCommands,
    notifyThresholdSecs: s.notifyThresholdSecs,
    notifySound: s.notifySound,
  };
}

// Suppress save during programmatic hydrate. Set true around set(), cleared
// next microtask.
let suppressSave = false;

let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined;
useSettings.subscribe((state) => {
  if (!isTauri || suppressSave) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    void sessionSettingsSave(toPersistedSettings(state))
      .then(() => settingsBroadcastChanged().catch(() => {}))
      .catch((err) => console.error('[settings] SQLite save failed:', err));
  }, 500);
});

/** Flush any pending debounced save immediately. The Settings window is
 *  destroyed (not hidden) on close, which drops the 500ms `setTimeout` — a
 *  quick toggle-then-close would otherwise never persist. Call this and await
 *  it before closing the window. */
export async function flushSettingsSave(): Promise<void> {
  if (!isTauri || suppressSave || settingsSaveTimer === undefined) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = undefined;
  await sessionSettingsSave(toPersistedSettings(useSettings.getState()));
  await settingsBroadcastChanged().catch(() => {});
}

/** Re-pull settings from SQLite without writing back. Called when the
 *  other window broadcasts a change. */
export async function rehydrateSettingsFromBroadcast(): Promise<void> {
  if (!isTauri) return;
  try {
    const stored = await sessionSettingsLoad();
    if (!stored) return;
    const current = useSettings.getState();
    const sameAppearance =
      (isAppearance(stored.appearance) ? stored.appearance : current.appearance) ===
      current.appearance;
    const incomingThemeId =
      stored.themeId === null
        ? null
        : typeof stored.themeId === 'string'
          ? stored.themeId
          : current.themeId;
    const sameTheme = incomingThemeId === current.themeId;
    const sameFont =
      (stored.fontId ?? current.fontId) === current.fontId &&
      (typeof stored.fontSize === 'number'
        ? clampFontSize(stored.fontSize)
        : current.fontSize) === current.fontSize;
    const sameShell = (stored.defaultShell ?? current.defaultShell) === current.defaultShell;
    const sameStartup =
      (stored.launchAtLogin ?? current.launchAtLogin) === current.launchAtLogin &&
      (stored.restoreWindowState ?? current.restoreWindowState) === current.restoreWindowState &&
      (stored.editorVimMode ?? current.editorVimMode) === current.editorVimMode;
    if (sameAppearance && sameTheme && sameFont && sameShell && sameStartup) return;

    suppressSave = true;
    useSettings.setState((s) => applyStored(s, stored));
    const next = useSettings.getState();
    applyTheme(resolveActiveTheme(next.appearance, next.themeId));
    queueMicrotask(() => {
      suppressSave = false;
    });
  } catch (err) {
    console.error('[settings] rehydrate broadcast failed:', err);
  }
}

// Re-paint when the OS color scheme changes — only matters when the user
// picked `'system'`.
if (typeof window !== 'undefined') {
  onSystemAppearanceChange(() => {
    const s = useSettings.getState();
    // Only repaint when nothing else has nailed the theme down. A specific
    // themeId means the user explicitly picked that look — OS color-scheme
    // flips shouldn't override it.
    if (s.appearance === 'system' && !s.themeId) {
      applyTheme(resolveActiveTheme('system', null));
    }
  });
}
