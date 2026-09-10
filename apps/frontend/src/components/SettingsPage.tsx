import { useEffect, useMemo, useRef, useState } from 'react';
import { WingmanSettings } from './wingman/WingmanSettings';
import { ClaudeSettings } from './claude/ClaudeSettings';
import {
  Cpu,
  Keyboard,
  Terminal as TerminalIcon,
  Palette,
  Eye,
  EyeOff,
  Check,
  Minus,
  Plus,
  X,
  Info,
  Sun,
  Moon,
  Monitor,
  Search,
  RotateCcw,
  AlertTriangle,
  Github,
  ExternalLink,
  Lock,
  FileCode2,
  PanelLeft,
  ArrowUp,
  ArrowDown,
  KeyRound,
  Bot,
  Sparkles,
  ArrowUpCircle,
  Loader2,
  ClipboardCopy,
  Trash2,
} from 'lucide-react';
import {
  DEFAULT_AI_MODEL,
  DEFAULT_SEARCH_IGNORE_DIRS,
  flushSettingsSave,
  useSettings,
  type TerminalProfile,
} from '../state/settings';
import { checkForUpdate, installUpdate, type UpdateInfo } from '../lib/updater';
import {
  diagnosticsClear,
  diagnosticsCollect,
  diagnosticsSummary,
  getAppVersion,
  type DiagnosticsSummary,
} from '../lib/tauri';
import { copyText } from '../lib/clipboard';
import { ANTHROPIC_KEY_SECRET } from '../lib/ai';
import { FontPicker } from './FontPicker';
import { useFiles, type SidebarView } from '../state/files';
import type { LayoutMode } from '../state/workspace';
import { useSidebarLayout } from '../state/sidebarLayout';
import { normalizeOrder, PINNED_VIEW, SIDEBAR_VIEW_BY_ID } from '../lib/sidebarViews';
import {
  isTauri,
  ptyListShells,
  secretDelete,
  secretGet,
  secretList,
  secretSet,
  type ShellInfo,
} from '../lib/tauri';
import { cn } from '../lib/cn';
import {
  listThemes,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type Appearance,
  type ThemeDef,
} from '../themes';
import {
  installThemeFromFile,
  installThemeFromUrl,
  loadInstalledThemes,
} from '../lib/themeMarketplace';
import {
  ACTION_META,
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  REFERENCE_CATEGORIES,
  REFERENCE_SHORTCUTS,
  bindingFromEvent,
  findConflict,
  formatBinding,
  useShortcuts,
  type ActionCategory,
  type ActionId,
  type KeyBinding,
} from '../state/shortcuts';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Pane =
  | 'appearance'
  | 'editor'
  | 'terminal'
  | 'sidebar'
  | 'shortcuts'
  | 'wingman'
  | 'claude'
  | 'startup'
  | 'secrets'
  | 'about';

/**
 * The rail, in clusters.
 *
 * Ten flat rows made you read every label to find one setting. Grouped, the
 * eye picks a cluster first and scans three or four rows instead of ten.
 * Appearance sits above the first label, ungrouped — it is where the window
 * opens, so it reads as the home row rather than a member of a set.
 */
const NAV: { label?: string; items: { id: Pane; icon: typeof Cpu; label: string }[] }[] = [
  { items: [{ id: 'appearance', icon: Palette, label: 'Appearance' }] },
  {
    label: 'Workspace',
    items: [
      { id: 'editor', icon: FileCode2, label: 'Editor' },
      { id: 'terminal', icon: TerminalIcon, label: 'Terminal' },
      { id: 'sidebar', icon: PanelLeft, label: 'Sidebar' },
      { id: 'shortcuts', icon: Keyboard, label: 'Shortcuts' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { id: 'wingman', icon: Bot, label: 'Wingman' },
      { id: 'claude', icon: Sparkles, label: 'Claude Code' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'startup', icon: Monitor, label: 'Startup' },
      { id: 'secrets', icon: KeyRound, label: 'Secrets' },
      { id: 'about', icon: Info, label: 'About' },
    ],
  },
];

export function SettingsPage() {
  const {
    defaultShell,
    appearance,
    themeId,
    fontId,
    fontSize,
    launchAtLogin,
    restoreWindowState,
    editorVimMode,
    editorLsp,
    editorFormatOnSave,
    notifyLongCommands,
    notifyThresholdSecs,
    notifySound,
    setDefaultShell,
    setAppearance,
    defaultLayoutMode,
    setDefaultLayoutMode,
    setThemeId,
    setFontId,
    setFontSize,
    setLaunchAtLogin,
    setRestoreWindowState,
    setEditorVimMode,
    setEditorFormatOnSave,
    setEditorLsp,
    setNotifyLongCommands,
    setNotifyThresholdSecs,
    setNotifySound,
  } = useSettings();

  const [pane, setPane] = useState<Pane>('appearance');
  const [shells, setShells] = useState<ShellInfo[] | null>(null);

  useEffect(() => {
    if (!isTauri || shells !== null) return;
    let cancelled = false;
    void ptyListShells()
      .then((list) => !cancelled && setShells(list))
      .catch(() => !cancelled && setShells([]));
    return () => {
      cancelled = true;
    };
  }, [shells]);

  const close = () => {
    if (!isTauri) return;
    // Persist any pending (debounced) change before the window is destroyed,
    // otherwise a quick toggle-then-close is lost.
    void flushSettingsSave()
      .catch(() => {})
      .finally(() => void getCurrentWindow().close().catch(() => {}));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-bg-base text-fg-base">
      {/* Title bar — frameless window needs an explicit drag region. */}
      <div
        data-tauri-drag-region
        className="material-toolbar relative flex h-9 items-center justify-center px-3"
      >
        <span className="font-display text-sm font-semibold tracking-tight text-fg-base">
          Settings
        </span>
        <button
          onClick={close}
          className="group absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-all duration-200 ease-out hover:bg-red-500/[0.18] hover:text-red-300 active:scale-95"
          aria-label="Close settings"
          title="Close (esc)"
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="material-sidebar flex w-[228px] shrink-0 flex-col border-r border-border-hairline">
          <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
            {NAV.map((group, i) => (
              <div key={group.label ?? i}>
                {group.label && (
                  <div className="mb-1 px-2.5 font-display text-2xs font-semibold uppercase tracking-widest2 text-fg-subtle">
                    {group.label}
                  </div>
                )}
                <div className="flex flex-col gap-px">
                  {group.items.map((item) => (
                    <SidebarRow
                      key={item.id}
                      icon={item.icon}
                      label={item.label}
                      active={pane === item.id}
                      onClick={() => setPane(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="border-t border-edge-1 px-4 py-3 font-display text-2xs text-fg-subtle">
            Changes save as you make them.
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* One measure for every pane. At the default window width this
              sits just inside the padding; widen the window and it centres
              rather than stretching the line length past readable. */}
          <div className="mx-auto w-full max-w-[660px] px-10 py-9">
            {pane === 'appearance' && (
              <AppearancePane
                appearance={appearance}
                themeId={themeId}
                onThemeChange={setThemeId}
                fontId={fontId}
                fontSize={fontSize}
                onAppearanceChange={setAppearance}
                onFontChange={setFontId}
                onFontSizeChange={setFontSize}
              />
            )}
            {pane === 'shortcuts' && <ShortcutsPane />}
            {pane === 'terminal' && (
              <TerminalPane
                shells={shells}
                defaultShell={defaultShell}
                onPickShell={setDefaultShell}
                notifyLongCommands={notifyLongCommands}
                notifyThresholdSecs={notifyThresholdSecs}
                notifySound={notifySound}
                onNotifyLongCommandsChange={setNotifyLongCommands}
                onNotifyThresholdChange={setNotifyThresholdSecs}
                onNotifySoundChange={setNotifySound}
              />
            )}
            {pane === 'editor' && (
              <EditorPane
                vimMode={editorVimMode}
                onVimModeChange={setEditorVimMode}
                lsp={editorLsp}
                onLspChange={setEditorLsp}
                formatOnSave={editorFormatOnSave}
                onFormatOnSaveChange={setEditorFormatOnSave}
              />
            )}
            {pane === 'sidebar' && <SidebarSettingsPane />}
            {pane === 'startup' && (
              <StartupPane
                launchAtLogin={launchAtLogin}
                restoreWindowState={restoreWindowState}
                defaultLayoutMode={defaultLayoutMode}
                onDefaultLayoutModeChange={setDefaultLayoutMode}
                onLaunchAtLoginChange={setLaunchAtLogin}
                onRestoreWindowStateChange={setRestoreWindowState}
              />
            )}
            {pane === 'secrets' && <SecretsPane />}
            {pane === 'wingman' && <WingmanPane />}
            {pane === 'claude' && <ClaudePane />}
            {pane === 'about' && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Appearance ────────────────────────────────────────────

/**
 * Everything about how ARC looks, in one pane. Colour mode, theme and type
 * used to be split across two rail rows, which made picking a look a two-stop
 * trip for settings that are read together.
 */
function AppearancePane({
  appearance,
  themeId,
  onThemeChange,
  fontId,
  fontSize,
  onAppearanceChange,
  onFontChange,
  onFontSizeChange,
}: {
  appearance: Appearance;
  themeId: string | null;
  onThemeChange: (id: string | null) => void;
  fontId: string;
  fontSize: number;
  onAppearanceChange: (a: Appearance) => void;
  onFontChange: (id: string) => void;
  onFontSizeChange: (size: number) => void;
}) {
  return (
    <>
      <PaneHeader
        title="Appearance"
        blurb="Colour, theme and type. Changes apply to every ARC window as you make them."
      />

      <Group title="Colour mode" hint="System follows your OS setting and switches with it.">
        <div className="grid grid-cols-3 gap-3">
          <AppearanceCard
            label="Light"
            icon={Sun}
            active={appearance === 'light'}
            onPick={() => onAppearanceChange('light')}
            preview="light"
          />
          <AppearanceCard
            label="Dark"
            icon={Moon}
            active={appearance === 'dark'}
            onPick={() => onAppearanceChange('dark')}
            preview="dark"
          />
          <AppearanceCard
            label="System"
            icon={Monitor}
            active={appearance === 'system'}
            onPick={() => onAppearanceChange('system')}
            preview="system"
          />
        </div>
      </Group>

      <ThemeGroup themeId={themeId} onThemeChange={onThemeChange} />

      <Group
        title="Type"
        hint="One family across the terminal, the editor and the interface. Size applies everywhere too."
      >
        <div className="space-y-3">
          <FontPicker value={fontId} onChange={onFontChange} />
          <Rows>
            <Row
              label="Font size"
              control={
                <div className="inline-flex items-stretch overflow-hidden rounded-md border border-edge-2">
                  <button
                    onClick={() => onFontSizeChange(fontSize - 1)}
                    disabled={fontSize <= MIN_FONT_SIZE}
                    className="flex h-8 w-8 items-center justify-center text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-30 disabled:hover:bg-transparent"
                    aria-label="Decrease font size"
                  >
                    <Minus size={12} />
                  </button>
                  <div className="flex h-8 w-14 items-center justify-center border-x border-edge-2 font-mono text-sm text-fg-base">
                    {fontSize}px
                  </div>
                  <button
                    onClick={() => onFontSizeChange(fontSize + 1)}
                    disabled={fontSize >= MAX_FONT_SIZE}
                    className="flex h-8 w-8 items-center justify-center text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-30 disabled:hover:bg-transparent"
                    aria-label="Increase font size"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              }
            />
          </Rows>
        </div>
      </Group>
    </>
  );
}

// ─── Themes ───────────────────────────────────────────────

/**
 * Theme picker plus the two install paths, folded into the Appearance pane.
 * Installing is the rare half, so it sits behind a disclosure - the common
 * case (pick one of the themes I already have) stays one glance.
 */
function ThemeGroup({
  themeId,
  onThemeChange,
}: {
  themeId: string | null;
  onThemeChange: (id: string | null) => void;
}) {
  const [themes, setThemes] = useState<ThemeDef[]>(() => listThemes());
  const [url, setUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const reload = () => setThemes(listThemes());

  // The Settings window is a separate JS context, so register the user's
  // installed themes here too (the main window does this on boot).
  useEffect(() => {
    void loadInstalledThemes().then(reload).catch(() => {});
  }, []);

  // Both install paths land here so success and failure read the same way
  // whichever button you pressed. A null result means the file picker was
  // cancelled - nothing happened, so nothing is reported.
  const applyResult = (res: Awaited<ReturnType<typeof installThemeFromUrl>> | null) => {
    setInstalling(false);
    if (!res) return;
    if (res.ok) {
      reload();
      onThemeChange(res.theme.id);
      setUrl('');
      setMsg({ kind: 'ok', text: `Installed “${res.theme.name}”.` });
    } else {
      setMsg({ kind: 'err', text: res.error });
    }
  };

  const onInstall = async () => {
    const trimmed = url.trim();
    if (!trimmed || installing) return;
    setInstalling(true);
    setMsg(null);
    applyResult(await installThemeFromUrl(trimmed));
  };

  const onImportFile = async () => {
    if (installing) return;
    setInstalling(true);
    setMsg(null);
    applyResult(await installThemeFromFile());
  };

  return (
    <Group
      title="Theme"
      hint="A specific palette, or the default dark/light pair that follows the colour mode above."
      action={
        <button
          onClick={() => setAddOpen((v) => !v)}
          aria-expanded={addOpen}
          className="rounded-md px-2 py-1 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          {addOpen ? 'Done' : 'Add a theme'}
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <ThemeCard
          label="Default"
          description="Follow the colour mode"
          active={themeId === null}
          onPick={() => onThemeChange(null)}
          swatches={['var(--bg-base)', 'var(--bg-panel)', 'var(--accent)']}
        />
        {themes.map((t) => (
          <ThemeCard
            key={t.id}
            label={t.name}
            description={t.author ? `by ${t.author}` : t.mode}
            active={themeId === t.id}
            onPick={() => onThemeChange(t.id)}
            swatches={[
              `rgb(${t.tokens.bgBase})`,
              `rgb(${t.tokens.bgPanel})`,
              `rgb(${t.tokens.accent})`,
            ]}
          />
        ))}
      </div>

      {addOpen && (
        <Panel className="mt-3 animate-view-in space-y-3">
          <p className="font-display text-xs leading-relaxed text-fg-muted">
            Paste a link to a theme JSON, or load one from disk. VS Code colour themes
            work too - the workbench palette is converted to ARC’s, with the text ramp
            re-solved for contrast. Installed themes are saved to{' '}
            <code className="font-mono text-fg-subtle">~/.arc/themes</code>.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onInstall();
              }}
              placeholder="https://…/my-theme.json"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-edge-2 bg-bg-base/50 px-3 py-2 font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
            />
            <button
              onClick={() => void onInstall()}
              disabled={installing || !url.trim()}
              className="shrink-0 rounded-md bg-accent-soft px-3 py-2 font-display text-xs font-medium text-fg-base ring-1 ring-accent/40 transition-colors hover:bg-accent/20 disabled:opacity-50"
            >
              {installing ? 'Installing…' : 'Install'}
            </button>
            <button
              onClick={() => void onImportFile()}
              disabled={installing}
              className="shrink-0 rounded-md border border-edge-2 px-3 py-2 font-display text-xs font-medium text-fg-base transition-colors hover:bg-surface-2 disabled:opacity-50"
            >
              Choose file…
            </button>
          </div>
          {/* One result line for both install paths - whichever you used last. */}
          {msg && (
            <p
              className={cn(
                'font-display text-xs leading-relaxed',
                msg.kind === 'ok' ? 'text-status-ok' : 'text-status-err',
              )}
            >
              {msg.text}
            </p>
          )}
        </Panel>
      )}
    </Group>
  );
}

// ─── Startup ────────────────────────────────────────────

/** What ARC does when it opens: whether it opens at all, where the window
 *  lands, and how new workspaces are arranged. */
function StartupPane({
  launchAtLogin,
  restoreWindowState,
  defaultLayoutMode,
  onDefaultLayoutModeChange,
  onLaunchAtLoginChange,
  onRestoreWindowStateChange,
}: {
  launchAtLogin: boolean;
  restoreWindowState: boolean;
  defaultLayoutMode: LayoutMode;
  onDefaultLayoutModeChange: (m: LayoutMode) => void;
  onLaunchAtLoginChange: (on: boolean) => void;
  onRestoreWindowStateChange: (on: boolean) => void;
}) {
  return (
    <>
      <PaneHeader
        title="Startup"
        blurb="How ARC opens, and how new workspaces are laid out. Window changes take effect next launch."
      />

      <Group title="Launching">
        <Rows>
          <ToggleRow
            label="Open ARC at login"
            hint="Starts ARC when you sign in to your computer."
            checked={launchAtLogin}
            onChange={() => onLaunchAtLoginChange(!launchAtLogin)}
          />
          <ToggleRow
            label="Restore window position and size"
            hint="Re-opens where and how big it was when you last closed it."
            checked={restoreWindowState}
            onChange={() => onRestoreWindowStateChange(!restoreWindowState)}
          />
        </Rows>
      </Group>

      <Group
        title="Default workspace layout"
        hint="Applies to workspaces you create from now on. Existing ones keep their layout, and the top bar switches any workspace at any time."
      >
        <div className="grid grid-cols-2 gap-3">
          <LayoutModeCard
            label="Tiles"
            hint="Each tab gets its own pane"
            mode="tiling"
            active={defaultLayoutMode === 'tiling'}
            onPick={() => onDefaultLayoutModeChange('tiling')}
          />
          <LayoutModeCard
            label="Tabs"
            hint="One pane, tabs in a strip"
            mode="standard"
            active={defaultLayoutMode === 'standard'}
            onPick={() => onDefaultLayoutModeChange('standard')}
          />
        </div>
      </Group>
    </>
  );
}

/** A boolean setting. Lives inside a `Rows` container, which supplies the
 *  border and the hairline above it. */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
  /** Dims the row and blocks the switch - for a setting that only means
   *  something while another one is on. */
  disabled?: boolean;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      disabled={disabled}
      control={
        <Switch checked={checked} onChange={onChange} ariaLabel={label} disabled={disabled} />
      }
    />
  );
}

/** A read-only keys -> action row. Used where the feature has no toggle of its
 *  own and the useful thing to show is how to invoke it. */
function ShortcutHint({ keys, label }: { keys: string; label: string }) {
  return (
    <Row
      label={label}
      control={
        <kbd className="rounded-md border border-edge-2 bg-bg-base/40 px-2 py-1 font-mono text-xs text-fg-muted">
          {keys}
        </kbd>
      }
    />
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full border transition-colors duration-150 ease-apple',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer',
        checked
          ? 'border-accent/50 bg-accent/80'
          : 'border-border-subtle bg-bg-base/60 hover:bg-bg-base/80',
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-[14px] w-[14px] transform rounded-full bg-white shadow-sm transition-transform duration-150 ease-apple',
          checked ? 'translate-x-[17px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

/** Picker card for the default workspace layout. The preview draws the same
 *  arrangement the two modes actually produce — tiled panes versus one pane
 *  under a tab strip — so the choice is legible without reading the label. */
function LayoutModeCard({
  label,
  hint,
  mode,
  active,
  onPick,
}: {
  label: string;
  hint: string;
  mode: LayoutMode;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      aria-pressed={active}
      className={cn(
        'group flex flex-col items-stretch overflow-hidden rounded-lg border text-left transition-all duration-150 ease-apple',
        active
          ? 'border-accent/60 shadow-glow-sm ring-1 ring-accent/40'
          : 'border-border-subtle hover:border-border-strong',
      )}
    >
      <div className="flex h-20 items-center justify-center bg-bg-base/40">
        <svg viewBox="0 0 48 30" className="h-[46px] w-[74px]" aria-hidden>
          {mode === 'tiling' ? (
            <>
              <rect x="1" y="1" width="21.5" height="28" rx="2.5" fill="currentColor" opacity={0.5} />
              <rect x="25.5" y="1" width="21.5" height="13" rx="2.5" fill="currentColor" opacity={0.5} />
              <rect x="25.5" y="16" width="21.5" height="13" rx="2.5" fill="currentColor" opacity={0.5} />
            </>
          ) : (
            <>
              <rect x="1" y="1" width="15" height="6" rx="1.5" fill="currentColor" opacity={0.75} />
              <rect x="17.5" y="1" width="15" height="6" rx="1.5" fill="currentColor" opacity={0.28} />
              <rect x="34" y="1" width="13" height="6" rx="1.5" fill="currentColor" opacity={0.28} />
              <rect x="1" y="9" width="46" height="20" rx="2.5" fill="currentColor" opacity={0.5} />
            </>
          )}
        </svg>
      </div>
      <div className="flex items-center justify-between border-t border-border-subtle bg-bg-base/40 px-3 py-2">
        <div className="min-w-0">
          <div className="font-display text-sm font-medium tracking-tight text-fg-base">{label}</div>
          <div className="truncate font-display text-2xs text-fg-subtle">{hint}</div>
        </div>
        {active && <Check size={11} className="shrink-0 text-accent" />}
      </div>
    </button>
  );
}

function AppearanceCard({
  label,
  icon: Icon,
  active,
  onPick,
  preview,
}: {
  label: string;
  icon: typeof Sun;
  active: boolean;
  onPick: () => void;
  preview: 'light' | 'dark' | 'system';
}) {
  return (
    <button
      onClick={onPick}
      className={cn(
        'group flex flex-col items-stretch overflow-hidden rounded-lg border text-left transition-all duration-150 ease-apple',
        active
          ? 'border-accent/60 shadow-glow-sm ring-1 ring-accent/40'
          : 'border-border-subtle hover:border-border-strong',
      )}
    >
      <div className="relative h-20 overflow-hidden">
        {preview === 'light' && <LightSwatch />}
        {preview === 'dark' && <DarkSwatch />}
        {preview === 'system' && (
          <div className="flex h-full">
            <div className="flex-1"><LightSwatch /></div>
            <div className="flex-1"><DarkSwatch /></div>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-border-subtle bg-bg-base/40 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Icon size={11} strokeWidth={2.1} className={active ? 'text-accent-bright' : 'text-fg-muted'} />
          <span className="font-display text-sm font-medium tracking-tight text-fg-base">
            {label}
          </span>
        </div>
        {active && <Check size={11} className="text-accent" />}
      </div>
    </button>
  );
}

function ThemeCard({
  label,
  description,
  active,
  onPick,
  swatches,
}: {
  label: string;
  description: string;
  active: boolean;
  onPick: () => void;
  swatches: [string, string, string];
}) {
  return (
    <button
      onClick={onPick}
      className={cn(
        'group flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all duration-150 ease-apple',
        active
          ? 'border-accent/60 shadow-glow-sm ring-1 ring-accent/40'
          : 'border-border-subtle hover:border-border-strong',
      )}
    >
      <div className="flex shrink-0 gap-0.5">
        {swatches.map((color, i) => (
          <span
            key={i}
            className="h-7 w-3 rounded-sm ring-1 ring-black/10"
            style={{ background: color }}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm font-medium tracking-tight text-fg-base">
          {label}
        </div>
        <div className="truncate font-display text-2xs text-fg-muted">{description}</div>
      </div>
      {active && <Check size={11} className="shrink-0 text-accent" />}
    </button>
  );
}

function LightSwatch() {
  return (
    <div className="flex h-full flex-col gap-1 p-2.5" style={{ background: '#f7f7f8', color: '#1c1c1e' }}>
      <div className="flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#ff5f57' }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#febc2e' }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#28c840' }} />
      </div>
      <div className="font-mono text-2xs leading-tight" style={{ color: '#3873d6' }}>
        ~ $ <span style={{ color: '#1c1c1e' }}>arc</span>
      </div>
    </div>
  );
}

function DarkSwatch() {
  return (
    <div className="flex h-full flex-col gap-1 p-2.5" style={{ background: '#161618', color: '#eef0f3' }}>
      <div className="flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#ff5252' }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#f0a958' }} />
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#3ad28a' }} />
      </div>
      <div className="font-mono text-2xs leading-tight" style={{ color: '#c8cad0' }}>
        ~ $ <span style={{ color: '#eef0f3' }}>arc</span>
      </div>
    </div>
  );
}

// ─── Shortcuts ─────────────────────────────────────────────────────────────

const SHORTCUT_CATEGORIES: ActionCategory[] = [
  'Workspace',
  'Terminal',
  'SSH',
  'AI CLIs',
  'Help',
];

function ShortcutsPane() {
  const overrides = useShortcuts((s) => s.overrides);
  const setBinding = useShortcuts((s) => s.setBinding);
  const resetBinding = useShortcuts((s) => s.resetBinding);
  const resetAll = useShortcuts((s) => s.resetAll);
  const clearBinding = useShortcuts((s) => s.clearBinding);

  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState<ActionId | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ACTION_ORDER.filter((id) => {
      if (!q) return true;
      const m = ACTION_META[id];
      return (
        m.label.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q) ||
        formatBinding(currentBinding(id, overrides)).toLowerCase().includes(q)
      );
    });
  }, [query, overrides]);

  const filteredRef = useMemo(() => {
    const q = query.trim().toLowerCase();
    return REFERENCE_SHORTCUTS.filter((s) => {
      if (!q) return true;
      return (
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.keys.toLowerCase().includes(q)
      );
    });
  }, [query]);

  const noMatches = filtered.length === 0 && filteredRef.length === 0;

  return (
    <>
      <PaneHeader
        title="Shortcuts"
        blurb="Click any binding to change it. Built-in shortcuts are listed for reference and cannot be rebound."
      />

      <div className="mb-6 flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2.5 rounded-md border border-edge-2 bg-surface-1 px-3 py-2 focus-within:border-accent/45 focus-within:shadow-focus">
          <Search size={13} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by action or key"
            aria-label="Filter shortcuts"
            className="min-w-0 flex-1 bg-transparent font-display text-sm text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg-base"
              aria-label="Clear filter"
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          )}
        </div>
        <button
          onClick={() => resetAll()}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-2 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          title="Restore every shortcut to its default"
        >
          <RotateCcw size={11} strokeWidth={2.1} />
          Reset all
        </button>
      </div>

      {SHORTCUT_CATEGORIES.map((cat) => {
        const rows = filtered.filter((id) => ACTION_META[id].category === cat);
        if (rows.length === 0) return null;
        return (
          <Group key={cat} title={cat}>
            <Rows>
              {rows.map((id) => (
                <ShortcutRow
                  key={id}
                  id={id}
                  capturing={capturing === id}
                  onStartCapture={() => setCapturing(id)}
                  onCapture={(binding) => {
                    setBinding(id, binding);
                    setCapturing(null);
                  }}
                  onClearBinding={() => {
                    clearBinding(id);
                    setCapturing(null);
                  }}
                  onCancel={() => setCapturing(null)}
                  onReset={() => resetBinding(id)}
                  overrides={overrides}
                />
              ))}
            </Rows>
          </Group>
        );
      })}

      {filteredRef.length > 0 && (
        <>
          <h3 className="mb-4 mt-10 border-t border-edge-1 pt-6 font-display text-sm font-semibold tracking-tight text-fg-base">
            Built in
            <span className="ml-2 font-normal text-fg-subtle">not rebindable</span>
          </h3>
          {REFERENCE_CATEGORIES.map((cat) => {
            const rows = filteredRef.filter((s) => s.category === cat);
            if (rows.length === 0) return null;
            return (
              <Group key={cat} title={cat}>
                <Rows>
                  {rows.map((s) => (
                    <Row
                      key={`${cat}:${s.label}`}
                      label={s.label}
                      hint={s.description}
                      control={
                        <span className="rounded-md border border-edge-2 bg-bg-base/40 px-2.5 py-1 font-mono text-xs text-fg-muted">
                          {s.keys}
                        </span>
                      }
                    />
                  ))}
                </Rows>
              </Group>
            );
          })}
        </>
      )}

      {noMatches && (
        <div className="rounded-squircle border border-edge-1 bg-surface-1 px-6 py-14 text-center">
          <p className="font-display text-sm text-fg-muted">
            Nothing matches “{query}”.
          </p>
          <button
            onClick={() => setQuery('')}
            className="mt-3 rounded-md px-3 py-1.5 font-display text-xs text-fg-base ring-1 ring-edge-2 transition-colors hover:bg-surface-2"
          >
            Clear the filter
          </button>
        </div>
      )}
    </>
  );
}

interface RowProps {
  id: ActionId;
  capturing: boolean;
  overrides: Partial<Record<ActionId, KeyBinding | null>>;
  onStartCapture: () => void;
  onCapture: (binding: KeyBinding) => void;
  onCancel: () => void;
  onClearBinding: () => void;
  onReset: () => void;
}

function ShortcutRow({
  id,
  capturing,
  overrides,
  onStartCapture,
  onCapture,
  onCancel,
  onReset,
  onClearBinding,
}: RowProps) {
  const meta = ACTION_META[id];
  const binding = currentBinding(id, overrides);
  const isCustom = overrides[id] !== undefined;
  const captureRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<KeyBinding | null>(null);
  const [conflict, setConflict] = useState<ActionId | null>(null);

  useEffect(() => {
    if (!capturing) {
      setPending(null);
      setConflict(null);
      return;
    }
    captureRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      const next = bindingFromEvent(e);
      if (!next) return;
      setPending(next);
      const conf = findConflict(next, id);
      setConflict(conf);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, id, onCancel]);

  return (
    <div
      className={cn(
        'group flex items-center justify-between gap-6 px-4 py-3 transition-colors',
        capturing ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm tracking-tight text-fg-base">
            {meta.label}
          </span>
          {isCustom && (
            <span
              className="rounded bg-accent/20 px-1.5 py-px font-display text-2xs text-accent-bright"
              title="Changed from the default"
            >
              custom
            </span>
          )}
        </div>
        <p className="mt-0.5 max-w-[46ch] truncate font-display text-xs text-fg-subtle">
          {meta.description}
        </p>
      </div>

      {capturing ? (
        <div className="flex shrink-0 items-center gap-2">
          {conflict && (
            <span
              className="flex items-center gap-1 font-display text-2xs text-status-warn"
              title="Already bound to another action"
            >
              <AlertTriangle size={10} strokeWidth={2.1} />
              taken by {ACTION_META[conflict].label}
            </span>
          )}
          <button
            ref={captureRef}
            className="rounded-md border border-accent/40 bg-bg-base/60 px-2.5 py-1 font-mono text-xs text-fg-base shadow-focus outline-none"
            tabIndex={-1}
          >
            {pending ? formatBinding(pending) : 'press a combo'}
          </button>
          {pending && (
            <button
              onClick={() => onCapture(pending)}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/20 text-accent-bright transition-colors hover:bg-accent/30"
              title="Save"
              aria-label="Save binding"
            >
              <Check size={11} strokeWidth={2.2} />
            </button>
          )}
          <button
            onClick={onClearBinding}
            className="rounded-md px-2 py-1 font-display text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
            title="Leave this action unbound"
          >
            Unbind
          </button>
          <button
            onClick={onCancel}
            className="rounded-md px-2 py-1 font-display text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {isCustom && (
            <button
              onClick={onReset}
              className="rounded-md p-1.5 text-fg-subtle opacity-0 transition-all hover:bg-surface-2 hover:text-fg-base focus-visible:opacity-100 group-hover:opacity-100"
              title="Restore the default"
              aria-label="Restore the default"
            >
              <RotateCcw size={11} strokeWidth={2.1} />
            </button>
          )}
          <button
            onClick={onStartCapture}
            className={cn(
              'rounded-md border px-2.5 py-1 font-mono text-xs transition-colors',
              binding
                ? 'border-edge-2 bg-bg-base/40 text-fg-base hover:bg-surface-2'
                : 'border-dashed border-edge-2 text-fg-subtle hover:bg-surface-2',
            )}
            title="Change this shortcut"
          >
            {binding ? formatBinding(binding) : 'unbound'}
          </button>
        </div>
      )}
    </div>
  );
}

function currentBinding(
  id: ActionId,
  overrides: Partial<Record<ActionId, KeyBinding | null>>,
): KeyBinding | null {
  const ov = overrides[id];
  if (ov === undefined) return DEFAULT_BINDINGS[id];
  return ov;
}


// ─── Editor ───────────────────────────────────────────────

function EditorPane({
  vimMode,
  onVimModeChange,
  lsp,
  onLspChange,
  formatOnSave,
  onFormatOnSaveChange,
}: {
  vimMode: boolean;
  onVimModeChange: (on: boolean) => void;
  lsp: boolean;
  onLspChange: (on: boolean) => void;
  formatOnSave: boolean;
  onFormatOnSaveChange: (on: boolean) => void;
}) {
  return (
    <>
      <PaneHeader
        title="Editor"
        blurb="Keybindings and language intelligence for files you open in ARC."
      />

      <Group
        title="Editing"
        hint="Multi-cursor is always on: Alt-click to drop extra cursors, ⌘D to select the next occurrence, Alt-drag for a rectangular selection."
      >
        <Rows>
          <ToggleRow
            label="Vim mode"
            hint="Modal Vim keybindings. Loads the first time you turn it on."
            checked={vimMode}
            onChange={() => onVimModeChange(!vimMode)}
          />
        </Rows>
      </Group>

      <Group
        title="Language servers"
        hint="Diagnostics, hover docs, completion, go-to-definition, references, rename and formatting from real language servers. Needs the server binaries on your PATH — typescript-language-server, rust-analyzer, pyright-langserver, gopls, clangd."
      >
        <Rows>
          <ToggleRow
            label="Enable language servers"
            hint="Connects TypeScript, JavaScript, Rust, Python, Go and C/C++ files to their server. A missing server falls back to a plain editor."
            checked={lsp}
            onChange={() => onLspChange(!lsp)}
          />
          <ToggleRow
            label="Format on save"
            hint="Runs the server's formatter before writing. Languages whose server has no formatter save unchanged."
            checked={formatOnSave}
            disabled={!lsp}
            onChange={() => onFormatOnSaveChange(!formatOnSave)}
          />
        </Rows>
      </Group>

      <Group
        title="Navigation"
        hint="Available whenever language servers are on and the file's server is running."
      >
        <Rows>
          <ShortcutHint keys="F12 / ⌘-click" label="Go to definition" />
          <ShortcutHint keys="⇧F12" label="Find all references" />
          <ShortcutHint keys="F2" label="Rename symbol" />
          <ShortcutHint keys="⇧⌥F" label="Format document" />
        </Rows>
      </Group>
    </>
  );
}

// ─── Sidebar ────────────────────────────────────────────

function SidebarSettingsPane() {
  const order = useSidebarLayout((s) => s.order);
  const hidden = useSidebarLayout((s) => s.hidden);
  const move = useSidebarLayout((s) => s.move);
  const setHidden = useSidebarLayout((s) => s.setHidden);
  const reset = useSidebarLayout((s) => s.reset);
  const showHidden = useFiles((s) => s.showHidden);
  const toggleHidden = useFiles((s) => s.toggleHidden);

  const ordered = useMemo(() => normalizeOrder(order), [order]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  return (
    <>
      <PaneHeader
        title="Sidebar"
        blurb="Which views appear in the activity rail, in what order, and what the file tree shows."
      />

      <Group
        title="Activity rail"
        hint="Reorder, show or hide the views in the left rail. Explorer is always shown."
        action={
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <RotateCcw size={11} strokeWidth={2} />
            Reset
          </button>
        }
      >
        <Rows>
          {ordered.map((id, i) => {
            const def = SIDEBAR_VIEW_BY_ID[id];
            const Icon = def.Icon;
            const locked = id === PINNED_VIEW;
            const isHidden = !locked && hiddenSet.has(id);
            return (
              <div
                key={id}
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5',
                  isHidden && 'opacity-50',
                )}
              >
                <Icon size={14} strokeWidth={1.9} className="shrink-0 text-fg-muted" />
                <span className="flex-1 font-display text-sm tracking-tight text-fg-base">
                  {def.label}
                </span>
                <SidebarRowBtn disabled={i === 0} onClick={() => move(id, -1)} title="Move up">
                  <ArrowUp size={13} strokeWidth={2} />
                </SidebarRowBtn>
                <SidebarRowBtn
                  disabled={i === ordered.length - 1}
                  onClick={() => move(id, 1)}
                  title="Move down"
                >
                  <ArrowDown size={13} strokeWidth={2} />
                </SidebarRowBtn>
                <SidebarRowBtn
                  disabled={locked}
                  onClick={() => setHidden(id, !isHidden)}
                  title={locked ? 'Always shown' : isHidden ? 'Show' : 'Hide'}
                >
                  {locked ? (
                    <Lock size={13} strokeWidth={2} />
                  ) : isHidden ? (
                    <EyeOff size={13} strokeWidth={2} />
                  ) : (
                    <Eye size={13} strokeWidth={2} />
                  )}
                </SidebarRowBtn>
              </div>
            );
          })}
        </Rows>
      </Group>

      <Group title="File tree">
        <Rows>
          <ToggleRow
            label="Show hidden files"
            hint="Dotfiles and other hidden entries appear in the explorer."
            checked={showHidden}
            onChange={toggleHidden}
          />
        </Rows>
      </Group>

      <Group
        title="File search"
        hint="Folders skipped by file search (⌘P / Ctrl+P). Remove one to make it searchable again."
      >
        <SearchIgnoreEditor />
      </Group>
    </>
  );
}

function SearchIgnoreEditor() {
  const dirs = useSettings((s) => s.searchIgnoreDirs);
  const setDirs = useSettings((s) => s.setSearchIgnoreDirs);
  const [draft, setDraft] = useState('');

  const add = () => {
    const name = draft.trim().replace(/[/\\]/g, '');
    if (!name) return;
    // Case-insensitive dedupe - folder-name matching is case-insensitive.
    if (!dirs.some((d) => d.toLowerCase() === name.toLowerCase())) {
      setDirs([...dirs, name]);
    }
    setDraft('');
  };

  const remove = (name: string) => setDirs(dirs.filter((d) => d !== name));

  const isDefault =
    dirs.length === DEFAULT_SEARCH_IGNORE_DIRS.length &&
    dirs.every((d, i) => d === DEFAULT_SEARCH_IGNORE_DIRS[i]);

  return (
    <Panel className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {dirs.length === 0 && (
          <span className="font-display text-xs text-fg-subtle">
            Nothing is skipped. Search covers every folder.
          </span>
        )}
        {dirs.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1 rounded-md border border-edge-2 bg-bg-base/40 py-1 pl-2.5 pr-1 font-mono text-xs text-fg-base"
          >
            {name}
            <button
              type="button"
              onClick={() => remove(name)}
              title={`Stop skipping ${name}`}
              className="grid h-4 w-4 place-items-center rounded text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Folder name, e.g. coverage"
          spellCheck={false}
          autoComplete="off"
          className="w-56 rounded-md border border-edge-2 bg-bg-base/50 px-2.5 py-1.5 font-mono text-sm text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="inline-flex items-center gap-1.5 rounded-md border border-edge-2 px-2.5 py-1.5 font-display text-sm tracking-tight text-fg-base transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus size={13} strokeWidth={2} />
          Add
        </button>
        {!isDefault && (
          <button
            type="button"
            onClick={() => setDirs([...DEFAULT_SEARCH_IGNORE_DIRS])}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-display text-xs text-fg-muted transition-colors hover:text-fg-base"
          >
            <RotateCcw size={12} strokeWidth={2} />
            Reset list
          </button>
        )}
      </div>
    </Panel>
  );
}

function SidebarRowBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-25 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// ─── Terminal ───────────────────────────────────────────

function TerminalPane({
  shells,
  defaultShell,
  onPickShell,
  notifyLongCommands,
  notifyThresholdSecs,
  notifySound,
  onNotifyLongCommandsChange,
  onNotifyThresholdChange,
  onNotifySoundChange,
}: {
  shells: ShellInfo[] | null;
  defaultShell: string | null;
  onPickShell: (shell: string | null) => void;
  notifyLongCommands: boolean;
  notifyThresholdSecs: number;
  notifySound: boolean;
  onNotifyLongCommandsChange: (on: boolean) => void;
  onNotifyThresholdChange: (secs: number) => void;
  onNotifySoundChange: (on: boolean) => void;
}) {
  return (
    <>
      <PaneHeader
        title="Terminal"
        blurb="Which shell new tabs open with, the profiles you can pick from, and what happens when a command finishes."
      />

      <ShellPicker shells={shells} defaultShell={defaultShell} onPick={onPickShell} />

      <TerminalProfilesSection />

      <Group
        title="Command suggestions"
        hint="Press ⌘K / Ctrl+K in a terminal, describe what you want, and the suggested command lands on the prompt for you to read. Nothing runs until you press Enter yourself."
      >
        <AiCommandSettings />
      </Group>

      <Group
        title="Notifications"
        hint="Tells you when a long command finishes while ARC is in the background. Needs shell integration (OSC 133), which most modern shell setups emit."
      >
        <Rows>
          <ToggleRow
            label="Notify when a long command finishes"
            hint="Only fires while the window is in the background."
            checked={notifyLongCommands}
            onChange={() => onNotifyLongCommandsChange(!notifyLongCommands)}
          />
          <Row
            label="Notify after"
            hint="How long a command has to run before it is worth telling you about."
            disabled={!notifyLongCommands}
            control={
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={notifyThresholdSecs}
                  onChange={(e) => onNotifyThresholdChange(Number(e.target.value))}
                  aria-label="Notification threshold in seconds"
                  className="w-16 rounded-md border border-edge-2 bg-bg-base/50 px-2 py-1 text-right font-mono text-sm text-fg-base focus:border-accent/45 focus:outline-none"
                />
                <span className="font-display text-xs text-fg-subtle">seconds</span>
              </div>
            }
          />
          <ToggleRow
            label="Play a sound"
            hint="Uses your OS notification sound."
            checked={notifySound}
            disabled={!notifyLongCommands}
            onChange={() => onNotifySoundChange(!notifySound)}
          />
        </Rows>
      </Group>
    </>
  );
}

/** API key + model for the ⌘K command bar. The key goes to the OS credential
 *  vault, never to SQLite, so it is write-only here: we can tell whether one
 *  exists, and replace or clear it, but never show it back. */
function AiCommandSettings() {
  const aiModel = useSettings((s) => s.aiModel);
  const setAiModel = useSettings((s) => s.setAiModel);
  const [model, setModel] = useState(aiModel);
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setModel(aiModel), [aiModel]);

  useEffect(() => {
    if (!isTauri) return;
    void secretGet(ANTHROPIC_KEY_SECRET)
      .then((v) => setHasKey(Boolean(v)))
      .catch(() => setHasKey(false));
  }, []);

  const saveKey = async () => {
    const trimmed = key.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await secretSet(ANTHROPIC_KEY_SECRET, trimmed);
      setHasKey(true);
      // Never hold the secret in component state longer than the call needs.
      setKey('');
    } catch (err) {
      console.error('[ai] storing API key failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    try {
      await secretDelete(ANTHROPIC_KEY_SECRET);
      setHasKey(false);
    } catch (err) {
      console.error('[ai] clearing API key failed:', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="space-y-4">
      <label className="block">
        <span className="font-display text-sm tracking-tight text-fg-base">
          Anthropic API key
        </span>
        <span className="mt-0.5 block font-display text-xs leading-relaxed text-fg-subtle">
          {hasKey
            ? 'A key is stored in your OS credential vault. Paste a new one to replace it.'
            : 'Goes to your OS credential vault — Keychain, Credential Manager or secret-service — not to ARC’s database.'}
        </span>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey();
            }}
            placeholder={hasKey ? '••••••••••••••••' : 'sk-ant-…'}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-edge-2 bg-bg-base/50 px-2.5 py-1.5 font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={!key.trim() || busy}
            className="shrink-0 rounded-md border border-edge-2 px-3 py-1.5 font-display text-xs font-medium text-fg-base transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            Save
          </button>
          {hasKey && (
            <button
              onClick={() => void clearKey()}
              disabled={busy}
              className="shrink-0 rounded-md px-2 py-1.5 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </label>

      <label className="block">
        <span className="font-display text-sm tracking-tight text-fg-base">Model</span>
        <span className="mt-0.5 block font-display text-xs leading-relaxed text-fg-subtle">
          Any Claude model id. <code className="font-mono">claude-haiku-4-5</code> is the
          cheapest and quickest; the default trades a little latency for better commands.
        </span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => setAiModel(model)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setAiModel(model);
          }}
          placeholder={DEFAULT_AI_MODEL}
          spellCheck={false}
          className="mt-2 w-full rounded-md border border-edge-2 bg-bg-base/50 px-2.5 py-1.5 font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
        />
      </label>
    </Panel>
  );
}

function ShellPicker({
  shells,
  defaultShell,
  onPick,
}: {
  shells: ShellInfo[] | null;
  defaultShell: string | null;
  onPick: (shell: string | null) => void;
}) {
  const matchesKnown =
    defaultShell !== null && (shells ?? []).some((s) => s.path === defaultShell);
  const showCustom = defaultShell !== null && !matchesKnown;
  const [customPath, setCustomPath] = useState(showCustom ? defaultShell : '');

  return (
    <Group
      title="Shell"
      hint="Used for terminal tabs you open from now on. Running tabs keep whatever they started with."
    >
      <Rows>
        <ShellRow
          active={defaultShell === null}
          onClick={() => onPick(null)}
          label="System default"
          subtitle={
            shells?.find((s) => s.is_default)?.path ??
            'COMSPEC on Windows, $SHELL elsewhere'
          }
        />

        {shells === null && isTauri && (
          <p className="px-4 py-3 font-display text-xs text-fg-subtle">
            Looking for installed shells…
          </p>
        )}

        {(shells ?? []).map((s) => (
          <ShellRow
            key={s.path}
            active={defaultShell === s.path}
            onClick={() => onPick(s.path)}
            label={s.label}
            subtitle={s.path}
          />
        ))}

        <div className={cn('px-4 py-3', showCustom && 'bg-accent-soft')}>
          <div className="font-display text-sm tracking-tight text-fg-base">
            Something else
          </div>
          <input
            value={customPath}
            onChange={(e) => {
              const v = e.target.value;
              setCustomPath(v);
              if (v.trim().length > 0) onPick(v.trim());
              else if (showCustom) onPick(null);
            }}
            aria-label="Custom shell path"
            placeholder={
              navigator.platform.toLowerCase().includes('win')
                ? 'C:\\Program Files\\…\\shell.exe'
                : '/usr/local/bin/fish'
            }
            className="mt-1 w-full bg-transparent font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </Rows>
    </Group>
  );
}

function ShellRow({
  active,
  onClick,
  label,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors duration-150 ease-apple',
        active ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span className="flex items-center gap-2 font-display text-sm tracking-tight text-fg-base">
        {active && <Check size={12} strokeWidth={2.4} className="shrink-0 text-accent-bright" />}
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-2xs text-fg-subtle">{subtitle}</span>
    </button>
  );
}

// ─── About ─────────────────────────────────────────────────────────────────

/** Fallback for the browser-only build, where `getAppVersion()` has no
 *  Tauri bridge to ask. The real number comes from tauri.conf.json. */
const APP_VERSION_FALLBACK = '0.2.0';
const REPO_URL = 'https://github.com/vedantnimbarte/Arc';

function SecretsPane() {
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setNames(await secretList());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    const n = name.trim();
    if (!n || !value) return;
    setBusy(true);
    setError(null);
    try {
      await secretSet(n, value);
      setName('');
      setValue('');
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: string) => {
    setError(null);
    try {
      await secretDelete(n);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const inputCls =
    'min-w-0 flex-1 rounded-md border border-edge-2 bg-bg-base/50 px-3 py-2 font-mono text-sm text-fg-base placeholder:text-fg-subtle transition-colors focus:border-accent/45 focus:outline-none';

  return (
    <>
      <PaneHeader
        title="Secrets"
        blurb="Values ARC can hand to terminals and agents without them living in a file. Stored in your OS credential vault, never on disk in plaintext."
      />

      {!isTauri ? (
        <Panel>
          <p className="font-display text-sm text-fg-muted">
            The secrets vault needs the desktop app.
          </p>
        </Panel>
      ) : (
        <>
          <Group
            title="Add a secret"
            hint="The value is written straight to the vault. It is never shown again — only the name is."
          >
            <Panel className="space-y-2.5">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="NAME"
                  aria-label="Secret name"
                  spellCheck={false}
                  autoComplete="off"
                  className={inputCls}
                />
                <input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void add();
                    }
                  }}
                  placeholder="Value"
                  aria-label="Secret value"
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => void add()}
                  disabled={busy || !name.trim() || !value}
                  className="flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-accent-soft px-4 py-2 font-display text-sm font-medium text-fg-base ring-1 ring-accent/40 transition-colors hover:bg-accent/20 disabled:opacity-40"
                >
                  <Plus size={13} /> Save
                </button>
              </div>
              {error && <p className="font-mono text-xs text-status-err">{error}</p>}
            </Panel>
          </Group>

          <Group title="Stored">
            {loading ? (
              <Panel>
                <p className="font-display text-sm text-fg-subtle">Loading…</p>
              </Panel>
            ) : names.length === 0 ? (
              <Panel>
                <p className="font-display text-sm text-fg-muted">
                  No secrets yet. Add one above and it becomes available to your terminals
                  and agents.
                </p>
              </Panel>
            ) : (
              <Rows>
                {names.map((n) => (
                  <div key={n} className="group flex items-center justify-between px-4 py-2.5">
                    <span className="flex items-center gap-2.5 font-mono text-sm text-fg-base">
                      <Lock size={12} className="text-fg-subtle" />
                      {n}
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(n)}
                      className="rounded-md px-2 py-1 font-display text-xs text-fg-subtle opacity-0 transition-all hover:bg-surface-2 hover:text-status-err focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </Rows>
            )}
          </Group>
        </>
      )}
    </>
  );
}

function AboutPane() {
  const [version, setVersion] = useState(APP_VERSION_FALLBACK);

  useEffect(() => {
    void getAppVersion().then((v) => {
      if (v) setVersion(v);
    });
  }, []);

  const openExternal = (url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <>
      {/* The one place in Settings that gets to be a composition rather than a
          list. It is the only pane you visit to look rather than to change
          something. */}
      <div className="mb-9 flex items-center gap-5 border-b border-edge-1 pb-8">
        <img
          src="/arc-logo.png"
          alt=""
          className="h-20 w-20 shrink-0 rounded-2xl shadow-glow ring-1 ring-edge-2"
          draggable={false}
        />
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-fg-base">
            ARC
          </h2>
          <p className="mt-0.5 font-display text-sm text-fg-muted">
            AI-native terminal and agent runtime
          </p>
          <p className="mt-2 font-mono text-xs text-fg-subtle">
            Version {version} · {detectPlatform()}
          </p>
        </div>
      </div>

      <Group title="Build">
        <Rows>
          <AboutRow label="Engine" value="Tauri 2, React, CodeMirror 6, xterm.js" />
          <AboutRow label="License" value="MIT" />
          <AboutRow label="Authors" value="ARC contributors" />
        </Rows>
      </Group>

      <UpdatesCard />

      <DiagnosticsCard />

      <Group title="Project">
        <Rows>
          <LinkRow
            icon={Github}
            label="Source on GitHub"
            onClick={() => openExternal(REPO_URL)}
          />
          <LinkRow
            icon={AlertTriangle}
            label="Report an issue"
            onClick={() => openExternal(`${REPO_URL}/issues`)}
          />
        </Rows>
      </Group>

      <p className="mt-8 font-display text-2xs text-fg-subtle">
        © 2026 ARC contributors. Released under the MIT license.
      </p>
    </>
  );
}

/** A row that leaves ARC. The arrow is the affordance, so the label stays a
 *  plain noun phrase rather than growing an imperative it does not need. */
function LinkRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Github;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-surface-2"
    >
      <span className="flex items-center gap-2.5 font-display text-sm tracking-tight text-fg-base">
        <Icon size={13} strokeWidth={2} className="text-fg-muted" />
        {label}
      </span>
      <ExternalLink size={12} strokeWidth={2} className="text-fg-subtle" />
    </button>
  );
}

/** Manual update check + the auto-check preference. The launch-time check
 *  and its corner card live in `UpdateToast`; this is the "I'll decide when"
 *  path and the only entry point when auto-check is off. */
function UpdatesCard() {
  const autoUpdateCheck = useSettings((s) => s.autoUpdateCheck);
  const setAutoUpdateCheck = useSettings((s) => s.setAutoUpdateCheck);
  const [status, setStatus] = useState<'idle' | 'checking' | 'current' | 'found'>('idle');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCheck = async () => {
    setStatus('checking');
    setError(null);
    const found = await checkForUpdate();
    setUpdate(found);
    setStatus(found ? 'found' : 'current');
  };

  const onInstall = async () => {
    setError(null);
    setProgress(0);
    try {
      // Resolves into a relaunch, so there is normally no "after" here.
      await installUpdate(setProgress);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const installing = progress !== null;

  return (
    <Group
      title="Updates"
      hint={
        error
          ? `Update failed: ${error}`
          : status === 'checking'
            ? 'Checking…'
            : status === 'current'
              ? 'You are on the latest version.'
              : status === 'found' && update
                ? `Version ${update.version} is ready. ARC restarts to finish installing.`
                : 'Downloads are signature-checked before they install.'
      }
      action={
        <button
          onClick={() => void (status === 'found' ? onInstall() : onCheck())}
          disabled={status === 'checking' || installing}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-edge-2 px-3 py-1.5 font-display text-xs font-medium text-fg-base transition-colors hover:bg-surface-2 disabled:opacity-60"
        >
          {(status === 'checking' || installing) && (
            <Loader2 size={11} strokeWidth={2.2} className="animate-spin text-fg-muted" />
          )}
          {status === 'found' && !installing && (
            <ArrowUpCircle size={11} strokeWidth={2.2} className="text-accent" />
          )}
          {installing
            ? `${progress}%`
            : status === 'found'
              ? 'Install and restart'
              : 'Check now'}
        </button>
      }
    >
      <Rows>
        <ToggleRow
          label="Check for updates on launch"
          hint="Offers a new version in the corner when one ships. Off means ARC never contacts the update endpoint on its own."
          checked={autoUpdateCheck}
          onChange={() => setAutoUpdateCheck(!autoUpdateCheck)}
        />
      </Rows>
    </Group>
  );
}

/**
 * Crash log surface. ARC's Rust side writes every panic to
 * `<data_dir>/arc/crash.log`; without this the file exists but nobody ever
 * finds it, and a bug report arrives as "it crashed".
 *
 * Quiet by design: with an empty log this is a single Copy button. It only
 * grows a warning row once there is actually something to report.
 */
function DiagnosticsCard() {
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);

  const refresh = () => {
    void diagnosticsSummary().then(setSummary);
  };
  useEffect(refresh, []);

  const copy = () => {
    void diagnosticsCollect().then(
      (text) => copyText(text, 'Diagnostics'),
      () => copyText('(diagnostics unavailable)', 'Diagnostics'),
    );
  };

  const clear = () => {
    void diagnosticsClear().then(refresh);
  };

  const crashes = summary?.crash_count ?? 0;

  return (
    <Group
      title="Diagnostics"
      hint={
        crashes > 0
          ? 'Paste this into a GitHub issue. It carries the version, the platform and the tail of the crash log.'
          : 'No crashes recorded. Copy this anyway when reporting a bug — it carries the version and platform.'
      }
    >
      <Panel className="space-y-3">
        {crashes > 0 && summary?.last_crash_at != null && (
          <p className="flex items-center gap-1.5 font-display text-xs text-status-warn">
            <AlertTriangle size={11} strokeWidth={2.1} />
            {crashes} crash{crashes === 1 ? '' : 'es'} logged, last on{' '}
            {new Date(summary.last_crash_at).toLocaleString()}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={copy}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-edge-2 px-3 py-2 font-display text-sm tracking-tight text-fg-base transition-colors hover:bg-surface-2"
          >
            <ClipboardCopy size={12} strokeWidth={2.1} className="text-fg-muted" />
            Copy diagnostics
          </button>
          {crashes > 0 && (
            <button
              onClick={clear}
              title="Delete the crash log"
              aria-label="Delete the crash log"
              className="rounded-md border border-edge-2 px-3 py-2 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
            >
              <Trash2 size={12} strokeWidth={2.1} />
            </button>
          )}
        </div>
        {summary?.log_path && (
          <p className="break-all font-mono text-2xs text-fg-subtle">{summary.log_path}</p>
        )}
      </Panel>
    </Group>
  );
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return <Row label={label} control={<span className="font-display text-sm text-fg-muted">{value}</span>} />;
}

function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const p = navigator.platform.toLowerCase();
  if (p.includes('win')) return 'Windows';
  if (p.includes('mac')) return 'macOS';
  if (p.includes('linux')) return 'Linux';
  return navigator.platform;
}

// ─── primitives ────────────────────────────────────────────────────────────

/** Wingman is an optional coding-agent daemon ARC talks to over HTTP/SSE.
 *  The connection form lives in its own component so the settings window and
 *  any future onboarding flow can share it. */
function WingmanPane() {
  return (
    <>
      <PaneHeader
        title="Wingman"
        blurb="Wingman is a terminal coding agent. Point ARC at a running daemon to get the agent panel and the pilot board. ARC works fully without it."
      />
      <Group
        title="Connection"
        hint="Start the daemon with `wingman serve`, then give ARC its address."
      >
        <Panel>
          <WingmanSettings />
        </Panel>
      </Group>
    </>
  );
}

/** Claude Code needs no connection - ARC spawns the user's own CLI, which
 *  already holds their login. What Settings owns is the blast radius: how much
 *  Claude may do unattended, and how much it may spend doing it. */
function ClaudePane() {
  return (
    <>
      <PaneHeader
        title="Claude Code"
        blurb="ARC drives your installed claude CLI to give it a chat panel with reviewable edits. Nothing to connect and no key to store — it uses your existing login. ARC works fully without it."
      />
      <Group
        title="Limits"
        hint="How much Claude may do on its own, and how much it may spend doing it."
      >
        <Panel>
          <ClaudeSettings />
        </Panel>
      </Group>
    </>
  );
}

/**
 * Terminal profile editor.
 *
 * A profile is a named (shell, args, cwd, env) set that ⌘K can open a
 * terminal with. The single-shell setting above it stays the fallback, so an
 * install that never defines a profile behaves exactly as it did before.
 *
 * Edits write straight through to the store on every keystroke — settings
 * already persist on a debounce, and a local draft plus an explicit save
 * would only add a state to get out of sync.
 */
function TerminalProfilesSection() {
  const profiles = useSettings((s) => s.terminalProfiles);
  const defaultProfileId = useSettings((s) => s.defaultProfileId);
  const setProfiles = useSettings((s) => s.setTerminalProfiles);
  const setDefaultProfileId = useSettings((s) => s.setDefaultProfileId);

  const patch = (id: string, fields: Partial<TerminalProfile>) =>
    setProfiles(profiles.map((p) => (p.id === id ? { ...p, ...fields } : p)));

  const add = () =>
    setProfiles([
      ...profiles,
      {
        id: `prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: `Profile ${profiles.length + 1}`,
        shell: '',
      },
    ]);

  const remove = (id: string) => setProfiles(profiles.filter((p) => p.id !== id));

  const fieldCls =
    'min-w-0 rounded-md border border-edge-2 bg-bg-base/50 px-2.5 py-1.5 font-mono text-xs text-fg-base placeholder:text-fg-subtle outline-none focus:border-accent/45';

  return (
    <Group
      title="Profiles"
      hint={
        'Each profile opens from the command palette as “New terminal: name”. Leave the shell empty to use the one above. Arguments are space-separated — quote anything containing a space.'
      }
      action={
        <button
          onClick={add}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <Plus size={11} strokeWidth={2.2} />
          Add profile
        </button>
      }
    >
      {profiles.length === 0 ? (
        <Panel>
          <p className="font-display text-sm text-fg-muted">
            No profiles yet. Add one to open a terminal with a particular shell,
            arguments and working directory in a single command.
          </p>
        </Panel>
      ) : (
        <div className="space-y-2.5">
          {profiles.map((p) => (
            <Panel key={p.id} className="space-y-2.5">
              <div className="flex items-center gap-2">
                <input
                  value={p.name}
                  onChange={(e) => patch(p.id, { name: e.target.value })}
                  placeholder="Name"
                  aria-label="Profile name"
                  className="min-w-0 flex-1 rounded-md border border-edge-2 bg-bg-base/50 px-2.5 py-1.5 font-display text-sm text-fg-base outline-none focus:border-accent/45"
                />
                <button
                  onClick={() => setDefaultProfileId(defaultProfileId === p.id ? null : p.id)}
                  title={
                    defaultProfileId === p.id
                      ? 'New terminals open with this profile'
                      : 'Use this profile for new terminals'
                  }
                  aria-pressed={defaultProfileId === p.id}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 font-display text-xs transition-colors',
                    defaultProfileId === p.id
                      ? 'border-accent/50 bg-accent-soft text-fg-base'
                      : 'border-edge-2 text-fg-subtle hover:bg-surface-2 hover:text-fg-base',
                  )}
                >
                  Default
                </button>
                <button
                  onClick={() => remove(p.id)}
                  title="Delete profile"
                  aria-label={`Delete ${p.name}`}
                  className="rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-status-err"
                >
                  <Trash2 size={12} strokeWidth={2.1} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={p.shell}
                  onChange={(e) => patch(p.id, { shell: e.target.value })}
                  placeholder="Shell path (blank uses the default)"
                  aria-label="Shell path"
                  spellCheck={false}
                  className={fieldCls}
                />
                <input
                  value={(p.args ?? []).join(' ')}
                  onChange={(e) => patch(p.id, { args: splitArgs(e.target.value) })}
                  placeholder="Arguments, e.g. -l"
                  aria-label="Shell arguments"
                  spellCheck={false}
                  className={fieldCls}
                />
              </div>
              <input
                value={p.cwd ?? ''}
                onChange={(e) => patch(p.id, { cwd: e.target.value || undefined })}
                placeholder="Start in (blank follows the file tree)"
                aria-label="Working directory"
                spellCheck={false}
                className={cn(fieldCls, 'w-full')}
              />
            </Panel>
          ))}
        </div>
      )}
    </Group>
  );
}

/**
 * Split a shell-argument string on whitespace, honouring single and double
 * quotes so a path with a space survives as one argument. Not a full shell
 * lexer — no escapes, no variable expansion — because these go straight to
 * the PTY spawn as an argv array, never through a shell that would expand
 * them anyway.
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true; // `""` is a real (empty) argument
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current) out.push(current);
  return out;
}

/**
 * A pane's opening line. Every pane has one, so the answer to "where am I"
 * comes from the content rather than from which rail row happens to be lit.
 */
function PaneHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <header className="mb-8 border-b border-edge-1 pb-5">
      <h2 className="font-display text-xl font-semibold tracking-tight text-fg-base">
        {title}
      </h2>
      <p className="mt-1.5 max-w-[56ch] font-display text-sm leading-relaxed text-fg-muted">
        {blurb}
      </p>
    </header>
  );
}

/**
 * A titled set of related settings.
 *
 * The explanation sits *above* the controls, not below them — a hint you read
 * after acting is a footnote, and this window had a lot of footnotes.
 * `action` takes an optional right-aligned control for the whole group
 * (a "Reset" button, say) so groups don't need a row just to hold one.
 */
function Group({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8 last:mb-0">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-sm font-semibold tracking-tight text-fg-base">
            {title}
          </h3>
          {hint && (
            <p className="mt-1 max-w-[62ch] font-display text-xs leading-relaxed text-fg-muted">
              {hint}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The single container a group's rows live in. One border for the whole set,
 * hairlines between the rows — instead of the previous box-per-setting, which
 * drew forty competing outlines on a pane that holds six choices.
 */
function Rows({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-edge-1 overflow-hidden rounded-squircle border border-edge-1 bg-surface-1">
      {children}
    </div>
  );
}

/** One setting inside a `Rows` container: label, optional hint, one control. */
function Row({
  label,
  hint,
  control,
  disabled = false,
}: {
  label: string;
  hint?: string;
  control: React.ReactNode;
  /** Dims and blocks the row — for a setting that only means something while
   *  another one is on. */
  disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-6 px-4 py-3',
        disabled && 'pointer-events-none opacity-45',
      )}
    >
      <div className="min-w-0">
        <p className="font-display text-sm tracking-tight text-fg-base">{label}</p>
        {hint && (
          <p className="mt-0.5 max-w-[58ch] font-display text-xs leading-relaxed text-fg-subtle">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** Free-form content that still wants the group container — a picker grid, an
 *  input pair, an editor. Same border and ground as `Rows`, no divisions. */
function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-squircle border border-edge-1 bg-surface-1 p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

function SidebarRow({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Cpu;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'source-row flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left font-display text-sm tracking-tight',
        active
          ? 'bg-accent-soft font-medium text-fg-base'
          : 'text-fg-base/80 hover:bg-surface-2 hover:text-fg-base',
      )}
    >
      <Icon
        size={14}
        strokeWidth={1.9}
        className={active ? 'text-accent-bright' : 'text-fg-muted'}
      />
      {label}
    </button>
  );
}
