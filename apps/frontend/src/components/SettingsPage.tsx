import { useEffect, useMemo, useRef, useState } from 'react';
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
  Activity,
} from 'lucide-react';
import { useSettings } from '../state/settings';
import { FontPicker } from './FontPicker';
import { useFiles, type SidebarView } from '../state/files';
import { useSidebarLayout } from '../state/sidebarLayout';
import { normalizeOrder, PINNED_VIEW, SIDEBAR_VIEW_BY_ID } from '../lib/sidebarViews';
import {
  isTauri,
  ptyListShells,
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
import { installThemeFromUrl, loadInstalledThemes } from '../lib/themeMarketplace';
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

type Pane = 'appearance' | 'themes' | 'shortcuts' | 'terminal' | 'editor' | 'sidebar' | 'about';

export function SettingsPage() {
  const {
    defaultShell,
    appearance,
    themeId,
    fontId,
    fontSize,
    launchAtLogin,
    restoreWindowState,
    terminalWebgl,
    editorVimMode,
    editorLsp,
    notifyLongCommands,
    notifyThresholdSecs,
    notifySound,
    setDefaultShell,
    setAppearance,
    setThemeId,
    setFontId,
    setFontSize,
    setLaunchAtLogin,
    setRestoreWindowState,
    setTerminalWebgl,
    setEditorVimMode,
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
    void getCurrentWindow().close().catch(() => {});
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
        <span className="font-display text-[12px] font-semibold tracking-tight text-fg-base">
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
        <aside className="material-sidebar flex w-[200px] shrink-0 flex-col border-r border-border-hairline">
          <nav className="flex flex-col gap-0.5 p-2 pt-3">
            <SidebarRow icon={Monitor} label="Appearance" active={pane === 'appearance'} onClick={() => setPane('appearance')} />
            <SidebarRow icon={Palette} label="Themes" active={pane === 'themes'} onClick={() => setPane('themes')} />
            <SidebarRow icon={Keyboard} label="Shortcuts" active={pane === 'shortcuts'} onClick={() => setPane('shortcuts')} />
            <SidebarRow icon={TerminalIcon} label="Terminal" active={pane === 'terminal'} onClick={() => setPane('terminal')} />
            <SidebarRow icon={FileCode2} label="Editor" active={pane === 'editor'} onClick={() => setPane('editor')} />
            <SidebarRow icon={PanelLeft} label="Sidebar" active={pane === 'sidebar'} onClick={() => setPane('sidebar')} />
            <SidebarRow icon={Info} label="About" active={pane === 'about'} onClick={() => setPane('about')} />
          </nav>

          <div className="mt-auto p-3 font-display text-[10px] tracking-tight text-fg-subtle">
            arc settings · saved to sqlite
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {(
            <div className="flex flex-1 flex-col overflow-y-auto p-6">
              {pane === 'appearance' && (
                <AppearancePane
                  appearance={appearance}
                  fontId={fontId}
                  fontSize={fontSize}
                  launchAtLogin={launchAtLogin}
                  restoreWindowState={restoreWindowState}
                  onAppearanceChange={setAppearance}
                  onFontChange={setFontId}
                  onFontSizeChange={setFontSize}
                  onLaunchAtLoginChange={setLaunchAtLogin}
                  onRestoreWindowStateChange={setRestoreWindowState}
                />
              )}
              {pane === 'themes' && (
                <ThemesPane themeId={themeId} onThemeChange={setThemeId} />
              )}
              {pane === 'shortcuts' && <ShortcutsPane />}
              {pane === 'terminal' && (
                <TerminalPane
                  shells={shells}
                  defaultShell={defaultShell}
                  onPickShell={setDefaultShell}
                  terminalWebgl={terminalWebgl}
                  onTerminalWebglChange={setTerminalWebgl}
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
                />
              )}
              {pane === 'sidebar' && <SidebarSettingsPane />}
              {pane === 'about' && <AboutPane />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Appearance ─────────────────────────────────────────────────────────────

function AppearancePane({
  appearance,
  fontId,
  fontSize,
  launchAtLogin,
  restoreWindowState,
  onAppearanceChange,
  onFontChange,
  onFontSizeChange,
  onLaunchAtLoginChange,
  onRestoreWindowStateChange,
}: {
  appearance: Appearance;
  fontId: string;
  fontSize: number;
  launchAtLogin: boolean;
  restoreWindowState: boolean;
  onAppearanceChange: (a: Appearance) => void;
  onFontChange: (id: string) => void;
  onFontSizeChange: (size: number) => void;
  onLaunchAtLoginChange: (on: boolean) => void;
  onRestoreWindowStateChange: (on: boolean) => void;
}) {
  const showHidden = useFiles((s) => s.showHidden);
  const toggleHidden = useFiles((s) => s.toggleHidden);

  return (
    <div className="space-y-7">
      <Section title="Color Mode" hint="Choose how ARC looks. 'System' follows your OS color scheme.">
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
      </Section>

      <Section title="Font Family" hint="Used by the terminal and editor. Pick from the fonts installed on your system.">
        <FontPicker value={fontId} onChange={onFontChange} />
      </Section>

      <Section title="Font Size">
        <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-border-subtle bg-bg-base/40">
          <button
            onClick={() => onFontSizeChange(fontSize - 1)}
            disabled={fontSize <= MIN_FONT_SIZE}
            className="flex h-8 w-8 items-center justify-center text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Decrease font size"
          >
            <Minus size={12} />
          </button>
          <div className="flex h-8 w-16 items-center justify-center border-x border-border-subtle font-mono text-[13px] text-fg-base">
            {fontSize}px
          </div>
          <button
            onClick={() => onFontSizeChange(fontSize + 1)}
            disabled={fontSize >= MAX_FONT_SIZE}
            className="flex h-8 w-8 items-center justify-center text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Increase font size"
          >
            <Plus size={12} />
          </button>
        </div>
      </Section>

      <Section title="File Tree">
        <ToggleRow
          label="Show hidden files"
          hint="Display dotfiles and other hidden entries in the sidebar."
          checked={showHidden}
          onChange={toggleHidden}
        />
      </Section>

      <Section title="Startup & Window" hint="Window-state changes take effect on next launch.">
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Launch ARC at login"
            hint="Start ARC automatically when you sign in to your computer."
            checked={launchAtLogin}
            onChange={() => onLaunchAtLoginChange(!launchAtLogin)}
          />
          <ToggleRow
            label="Restore window position and size"
            hint="Re-open at the position and size it was when you last closed it."
            checked={restoreWindowState}
            onChange={() => onRestoreWindowStateChange(!restoreWindowState)}
          />
        </div>
      </Section>
    </div>
  );
}

// ─── Themes ─────────────────────────────────────────────────────────────────

function ThemesPane({
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

  const reload = () => setThemes(listThemes());

  // The Settings window is a separate JS context, so register the user's
  // installed themes here too (the main window does this on boot).
  useEffect(() => {
    void loadInstalledThemes().then(reload).catch(() => {});
  }, []);

  const onInstall = async () => {
    const trimmed = url.trim();
    if (!trimmed || installing) return;
    setInstalling(true);
    setMsg(null);
    const res = await installThemeFromUrl(trimmed);
    setInstalling(false);
    if (res.ok) {
      reload();
      onThemeChange(res.theme.id);
      setUrl('');
      setMsg({ kind: 'ok', text: `Installed “${res.theme.name}”.` });
    } else {
      setMsg({ kind: 'err', text: res.error });
    }
  };

  return (
    <div className="space-y-7">
      <Section
        title="Theme"
        hint="Pick a specific palette, or stick with the default dark/light pair from the color mode above."
      >
        <div className="grid grid-cols-2 gap-3">
          <ThemeCard
            label="Default"
            description="Follow the color mode."
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
      </Section>

      <Section
        title="Install from URL"
        hint="Paste a link to a theme JSON file (e.g. a GitHub raw URL or gist). It's validated, applied, and saved to ~/.arc/themes so it loads next launch."
      >
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
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-2 font-mono text-[11.5px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          />
          <button
            onClick={() => void onInstall()}
            disabled={installing || !url.trim()}
            className="shrink-0 rounded-lg bg-accent-soft px-3 py-2 font-display text-[11.5px] font-medium text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {installing ? 'installing…' : 'install'}
          </button>
        </div>
        {msg && (
          <p
            className={cn(
              'mt-2 font-display text-[11px] leading-relaxed',
              msg.kind === 'ok' ? 'text-status-ok' : 'text-status-err',
            )}
          >
            {msg.text}
          </p>
        )}
      </Section>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
      <div className="min-w-0">
        <p className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
          {label}
        </p>
        {hint && (
          <p className="mt-0.5 font-display text-[11px] leading-relaxed text-fg-subtle">
            {hint}
          </p>
        )}
      </div>
      <Switch checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150 ease-apple',
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
          <span className="font-display text-[12px] font-medium tracking-tight text-fg-base">
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
        <div className="truncate font-display text-[12px] font-medium tracking-tight text-fg-base">
          {label}
        </div>
        <div className="truncate font-display text-[10.5px] text-fg-muted">{description}</div>
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
      <div className="font-mono text-[9px] leading-tight" style={{ color: '#3873d6' }}>
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
      <div className="font-mono text-[9px] leading-tight" style={{ color: '#c8cad0' }}>
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[11px] font-semibold uppercase tracking-widest2 text-fg-muted">
          Keyboard Shortcuts
        </h3>
        <button
          onClick={() => resetAll()}
          className="flex items-center gap-1 rounded-md px-2 py-1 font-display text-[11px] text-fg-muted transition-all hover:bg-white/[0.08] hover:text-fg-base"
          title="Reset every shortcut to its default"
        >
          <RotateCcw size={10} strokeWidth={2.1} />
          Reset all
        </button>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-1.5 focus-within:border-accent/45 focus-within:bg-bg-base/80 focus-within:shadow-focus">
        <Search size={13} strokeWidth={2.1} className="text-fg-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by action or key…"
          className="flex-1 bg-transparent font-display text-[12.5px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="rounded p-1 text-fg-subtle hover:bg-white/[0.06] hover:text-fg-base"
            aria-label="Clear filter"
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div className="pt-1">
        {SHORTCUT_CATEGORIES.map((cat) => {
          const rows = filtered.filter((id) => ACTION_META[id].category === cat);
          if (rows.length === 0) return null;
          return (
            <section key={cat} className="mb-3">
              <h4 className="px-1 pb-1 font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                {cat}
              </h4>
              <div className="space-y-0.5">
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
              </div>
            </section>
          );
        })}
        {filteredRef.length > 0 && (
          <div className="mb-1 mt-1">
            <div className="mb-2 flex items-center gap-2 px-1">
              <div className="h-px flex-1 bg-border-hairline" />
              <span className="font-display text-[9.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                Built-in · not rebindable
              </span>
              <div className="h-px flex-1 bg-border-hairline" />
            </div>
            {REFERENCE_CATEGORIES.map((cat) => {
              const rows = filteredRef.filter((s) => s.category === cat);
              if (rows.length === 0) return null;
              return (
                <section key={cat} className="mb-3">
                  <h4 className="px-1 pb-1 font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                    {cat}
                  </h4>
                  <div className="space-y-0.5">
                    {rows.map((s) => (
                      <div
                        key={`${cat}:${s.label}`}
                        className="flex items-center gap-3 rounded-md px-2 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
                            {s.label}
                          </span>
                          <p className="truncate font-display text-[11px] text-fg-subtle">
                            {s.description}
                          </p>
                        </div>
                        <span className="shrink-0 rounded-md border border-border-subtle bg-bg-base/40 px-2.5 py-1 font-mono text-[11px] text-fg-muted">
                          {s.keys}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {filtered.length === 0 && filteredRef.length === 0 && (
          <div className="flex items-center justify-center gap-1.5 px-4 py-12 font-display text-[12px] italic text-fg-subtle">
            <Search size={11} strokeWidth={2} />
            no actions match "{query}"
          </div>
        )}
      </div>

      <p className="font-display text-[11px] text-fg-subtle">
        Click a binding to rebind · <kbd className="font-mono">esc</kbd> to cancel ·
        built-in shortcuts are shown for reference
      </p>
    </div>
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
        'group flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors',
        capturing ? 'bg-accent-soft ring-1 ring-inset ring-accent/40' : 'hover:bg-white/[0.035]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
            {meta.label}
          </span>
          {isCustom && (
            <span
              className="rounded bg-accent/20 px-1 py-0.5 font-mono text-[8.5px] tracking-tight text-accent-bright"
              title="Customized — click reset to restore the default"
            >
              custom
            </span>
          )}
        </div>
        <p className="truncate font-display text-[11px] text-fg-subtle">
          {meta.description}
        </p>
      </div>

      {capturing ? (
        <div className="flex items-center gap-2">
          {conflict && (
            <span
              className="flex items-center gap-1 font-display text-[10.5px] text-status-warn"
              title="This combo is already bound to another action"
            >
              <AlertTriangle size={10} strokeWidth={2.1} />
              conflicts with {ACTION_META[conflict].label}
            </span>
          )}
          <button
            ref={captureRef}
            className="rounded-md border border-accent/40 bg-bg-base/70 px-2.5 py-1 font-mono text-[11px] text-fg-base shadow-focus outline-none"
            tabIndex={-1}
          >
            {pending ? formatBinding(pending) : 'press a combo…'}
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
            className="rounded-md px-2 py-1 font-display text-[10.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
            title="Disable this action"
          >
            disable
          </button>
          <button
            onClick={onCancel}
            className="rounded-md px-2 py-1 font-display text-[10.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={onStartCapture}
            className={cn(
              'rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors',
              binding
                ? 'border-border-subtle bg-bg-base/40 text-fg-base hover:border-border-strong hover:bg-bg-base/60'
                : 'border-dashed border-border-subtle bg-bg-base/20 text-fg-subtle italic hover:border-border-strong',
            )}
            title="Click to rebind"
          >
            {formatBinding(binding)}
          </button>
          {isCustom && (
            <button
              onClick={onReset}
              className="rounded-md p-1 text-fg-subtle opacity-0 transition-all hover:bg-white/[0.06] hover:text-fg-base group-hover:opacity-100"
              title="Reset to default"
              aria-label="Reset to default"
            >
              <RotateCcw size={10} strokeWidth={2.1} />
            </button>
          )}
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


function EditorPane({
  vimMode,
  onVimModeChange,
  lsp,
  onLspChange,
}: {
  vimMode: boolean;
  onVimModeChange: (on: boolean) => void;
  lsp: boolean;
  onLspChange: (on: boolean) => void;
}) {
  return (
    <div className="space-y-7">
      <Section
        title="Editing"
        hint="Multi-cursor is always on — Alt-click to drop extra cursors, ⌘D to select the next occurrence, Alt-drag for a rectangular selection."
      >
        <ToggleRow
          label="Vim mode"
          hint="Modal Vim keybindings in the editor. Loads the first time it's enabled."
          checked={vimMode}
          onChange={() => onVimModeChange(!vimMode)}
        />
      </Section>
      <Section
        title="Language servers (LSP)"
        hint="Diagnostics, hover docs, and completion from real language servers. Requires the server binaries on your PATH — e.g. typescript-language-server, rust-analyzer, pyright-langserver, gopls, clangd."
      >
        <ToggleRow
          label="Enable LSP"
          hint="Connects supported files (TypeScript/JavaScript, Rust, Python, Go, C/C++) to their language server. Missing servers degrade gracefully to a plain editor."
          checked={lsp}
          onChange={() => onLspChange(!lsp)}
        />
      </Section>
    </div>
  );
}

function SidebarSettingsPane() {
  const order = useSidebarLayout((s) => s.order);
  const hidden = useSidebarLayout((s) => s.hidden);
  const move = useSidebarLayout((s) => s.move);
  const setHidden = useSidebarLayout((s) => s.setHidden);
  const reset = useSidebarLayout((s) => s.reset);

  const ordered = useMemo(() => normalizeOrder(order), [order]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  return (
    <div className="space-y-7">
      <Section
        title="Activity Rail"
        hint="Reorder, show, or hide the views in the left sidebar rail. Explorer is always shown."
      >
        <div className="flex flex-col gap-1.5">
          {ordered.map((id, i) => {
            const def = SIDEBAR_VIEW_BY_ID[id];
            const Icon = def.Icon;
            const locked = id === PINNED_VIEW;
            const isHidden = !locked && hiddenSet.has(id);
            return (
              <div
                key={id}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2',
                  isHidden && 'opacity-55',
                )}
              >
                <Icon size={14} strokeWidth={1.9} className="shrink-0 text-fg-muted" />
                <span className="flex-1 font-display text-[12.5px] font-medium tracking-tight text-fg-base">
                  {def.label}
                </span>
                <SidebarRowBtn
                  disabled={i === 0}
                  onClick={() => move(id, -1)}
                  title="Move up"
                >
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
        </div>
      </Section>

      <Section title="Reset">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-2 font-display text-[12px] font-medium tracking-tight text-fg-base transition-colors hover:bg-bg-hover"
        >
          <RotateCcw size={13} strokeWidth={2} />
          Reset to defaults
        </button>
      </Section>
    </div>
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
      className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-base disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function TerminalPane({
  shells,
  defaultShell,
  onPickShell,
  terminalWebgl,
  onTerminalWebglChange,
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
  terminalWebgl: boolean;
  onTerminalWebglChange: (on: boolean) => void;
  notifyLongCommands: boolean;
  notifyThresholdSecs: number;
  notifySound: boolean;
  onNotifyLongCommandsChange: (on: boolean) => void;
  onNotifyThresholdChange: (secs: number) => void;
  onNotifySoundChange: (on: boolean) => void;
}) {
  return (
    <div className="space-y-7">
      <ShellPicker shells={shells} defaultShell={defaultShell} onPick={onPickShell} />

      <Section
        title="Renderer"
        hint="WebGL is faster and smoother on most machines. Falls back to the canvas renderer automatically when WebGL isn't available. Applies to newly-opened terminal tabs."
      >
        <ToggleRow
          label="Use WebGL renderer"
          hint="Accelerated drawing via GPU. Disable if you see glitches or your GPU is flaky."
          checked={terminalWebgl}
          onChange={() => onTerminalWebglChange(!terminalWebgl)}
        />
      </Section>

      <Section
        title="Notifications"
        hint="Get a system notification when a long command finishes while ARC isn't focused. Requires shell integration (OSC 133) — most modern shell setups emit it."
      >
        <ToggleRow
          label="Notify on long commands"
          hint="Fires only when the window is in the background."
          checked={notifyLongCommands}
          onChange={() => onNotifyLongCommandsChange(!notifyLongCommands)}
        />
        <div
          className={cn(
            'mt-2 flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5 transition-opacity',
            !notifyLongCommands && 'pointer-events-none opacity-50',
          )}
        >
          <div className="min-w-0">
            <p className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
              Threshold
            </p>
            <p className="mt-0.5 font-display text-[11px] leading-relaxed text-fg-subtle">
              Minimum duration before notifying.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={5}
              max={3600}
              value={notifyThresholdSecs}
              onChange={(e) => onNotifyThresholdChange(Number(e.target.value))}
              className="w-16 rounded-md border border-border-subtle bg-bg-base/60 px-2 py-1 text-right font-mono text-[12px] text-fg-base focus:border-accent/45 focus:outline-none"
            />
            <span className="font-display text-[11px] text-fg-subtle">sec</span>
          </div>
        </div>
        <div className={cn('mt-2 transition-opacity', !notifyLongCommands && 'pointer-events-none opacity-50')}>
          <ToggleRow
            label="Play sound"
            hint="Use the OS notification sound."
            checked={notifySound}
            onChange={() => onNotifySoundChange(!notifySound)}
          />
        </div>
      </Section>
    </div>
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
    <Section
      title="Shell"
      hint="Used for newly-opened terminal tabs. Existing tabs keep running whatever they were started with."
    >
      <div className="flex flex-col gap-1.5">
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
          <p className="px-1 font-display text-[11px] text-fg-subtle">
            Discovering shells…
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

        <div
          className={cn(
            'mt-1 rounded-lg border px-3 py-2 transition-colors',
            showCustom
              ? 'border-accent/45 bg-accent-soft/40'
              : 'border-border-subtle bg-bg-base/40',
          )}
        >
          <div className="mb-1 font-display text-[11px] font-medium tracking-tight text-fg-muted">
            Custom path
          </div>
          <input
            value={customPath}
            onChange={(e) => {
              const v = e.target.value;
              setCustomPath(v);
              if (v.trim().length > 0) onPick(v.trim());
              else if (showCustom) onPick(null);
            }}
            placeholder={
              navigator.platform.toLowerCase().includes('win')
                ? 'C:\\Program Files\\…\\shell.exe'
                : '/usr/local/bin/fish'
            }
            className="w-full bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>
    </Section>
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
        'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-all duration-150 ease-apple',
        active
          ? 'border-accent/50 bg-accent-soft text-fg-base shadow-glow-sm'
          : 'border-border-subtle bg-bg-base/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
      )}
    >
      <span className="font-display text-[12.5px] font-medium tracking-tight">{label}</span>
      <span className="ml-3 truncate font-mono text-[10.5px] text-fg-subtle">{subtitle}</span>
    </button>
  );
}

// ─── About ─────────────────────────────────────────────────────────────────

const APP_VERSION = '0.0.1';
const REPO_URL = 'https://github.com/vedant-nimbarte/arc-terminal';

function AboutPane() {
  const openExternal = (url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="flex flex-col items-center gap-5 pt-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <img
          src="/arc-logo.png"
          alt="ARC logo"
          className="h-24 w-24 rounded-2xl shadow-glow ring-1 ring-border-subtle"
          draggable={false}
        />
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-fg-base">
            ARC
          </h1>
          <p className="font-display text-[12px] text-fg-muted">
            AI-native terminal & agent runtime
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-fg-subtle">
          <span className="rounded-md border border-border-subtle bg-bg-base/40 px-2 py-0.5">
            v{APP_VERSION}
          </span>
          <span>·</span>
          <span>{detectPlatform()}</span>
        </div>
      </div>

      <div className="w-full max-w-md space-y-2.5 rounded-lg border border-border-subtle bg-bg-base/40 p-4">
        <AboutRow label="Engine" value="Tauri 2 · React · CodeMirror 6 · xterm.js" />
        <AboutRow label="License" value="MIT" />
        <AboutRow label="Authors" value="ARC contributors" />
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        <button
          onClick={() => openExternal(REPO_URL)}
          className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2 text-fg-base transition-all duration-150 ease-apple hover:border-border-strong hover:bg-bg-base/60"
        >
          <span className="flex items-center gap-2 font-display text-[12.5px] font-medium tracking-tight">
            <Github size={12} strokeWidth={2.1} className="text-fg-muted" />
            GitHub repository
          </span>
          <ExternalLink size={11} strokeWidth={2.1} className="text-fg-subtle" />
        </button>
        <button
          onClick={() => openExternal(`${REPO_URL}/issues`)}
          className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2 text-fg-base transition-all duration-150 ease-apple hover:border-border-strong hover:bg-bg-base/60"
        >
          <span className="flex items-center gap-2 font-display text-[12.5px] font-medium tracking-tight">
            <AlertTriangle size={12} strokeWidth={2.1} className="text-fg-muted" />
            Report an issue
          </span>
          <ExternalLink size={11} strokeWidth={2.1} className="text-fg-subtle" />
        </button>
      </div>

      <p className="pt-2 font-display text-[10.5px] text-fg-subtle">
        © 2026 ARC contributors. Released under the MIT license.
      </p>
    </div>
  );
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-display text-[11px] uppercase tracking-widest2 text-fg-subtle">
        {label}
      </span>
      <span className="text-right font-display text-[12px] text-fg-base">{value}</span>
    </div>
  );
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

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="font-display text-[11px] font-semibold uppercase tracking-widest2 text-fg-muted">
        {title}
      </h3>
      {children}
      {hint && (
        <p className="font-display text-[11px] leading-relaxed text-fg-subtle">{hint}</p>
      )}
    </section>
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
        'source-row flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-display text-[12.5px] font-medium tracking-tight',
        active
          ? 'bg-accent-soft text-fg-base ring-1 ring-border-strong'
          : 'text-fg-base/85 hover:bg-white/[0.06]',
      )}
    >
      <Icon size={12} strokeWidth={2.1} className={active ? 'text-accent-bright' : 'text-fg-muted'} />
      {label}
    </button>
  );
}
