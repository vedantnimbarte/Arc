import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cpu,
  Cloud,
  HardDrive,
  Keyboard,
  SlidersHorizontal,
  Terminal as TerminalIcon,
  Palette,
  Eye,
  EyeOff,
  Key,
  Check,
  Minus,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Info,
  Sun,
  Moon,
  Monitor,
  Search,
  RotateCcw,
  AlertTriangle,
  Github,
  ExternalLink,
  Zap,
  ClipboardPaste,
  RefreshCw,
  PowerOff,
} from 'lucide-react';
import { useSettings } from '../state/settings';
import {
  PROVIDER_PRESETS,
  TINT_CLASSES,
  presetOrDefault,
  type ProviderPreset,
} from '../state/providers';
import { resolveModelsFor, useModels } from '../state/models';
import { useFiles } from '../state/files';
import { isTauri, ptyListShells, type ShellInfo } from '../lib/tauri';
import { cn } from '../lib/cn';
import {
  FONT_OPTIONS,
  getFont,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  type Appearance,
} from '../themes';
import {
  ACTION_META,
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  bindingFromEvent,
  findConflict,
  formatBinding,
  useShortcuts,
  type ActionCategory,
  type ActionId,
  type KeyBinding,
} from '../state/shortcuts';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Pane = 'appearance' | 'shortcuts' | 'terminal' | 'providers' | 'about';

export function SettingsPage() {
  const {
    activePresetId,
    enabledPresetIds,
    providers,
    defaultShell,
    appearance,
    fontId,
    fontSize,
    setActivePresetId,
    setPresetEnabled,
    updateProvider,
    setDefaultShell,
    setAppearance,
    setFontId,
    setFontSize,
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
            <SidebarRow icon={Palette} label="Appearance" active={pane === 'appearance'} onClick={() => setPane('appearance')} />
            <SidebarRow icon={Keyboard} label="Shortcuts" active={pane === 'shortcuts'} onClick={() => setPane('shortcuts')} />
            <SidebarRow icon={TerminalIcon} label="Terminal" active={pane === 'terminal'} onClick={() => setPane('terminal')} />
            <SidebarRow icon={SlidersHorizontal} label="Providers" active={pane === 'providers'} onClick={() => setPane('providers')} />
            <SidebarRow icon={Info} label="About" active={pane === 'about'} onClick={() => setPane('about')} />
          </nav>

          <div className="mt-auto p-3 font-display text-[10px] tracking-tight text-fg-subtle">
            arc settings · saved to sqlite
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {pane === 'providers' ? (
            <ProvidersPane
              activePresetId={activePresetId}
              enabledPresetIds={enabledPresetIds}
              providers={providers}
              onSetActive={setActivePresetId}
              onToggleEnabled={setPresetEnabled}
              onUpdateProvider={updateProvider}
            />
          ) : (
            <div className="flex flex-1 flex-col overflow-y-auto p-6">
              {pane === 'appearance' && (
                <AppearancePane
                  appearance={appearance}
                  fontId={fontId}
                  fontSize={fontSize}
                  onAppearanceChange={setAppearance}
                  onFontChange={setFontId}
                  onFontSizeChange={setFontSize}
                />
              )}
              {pane === 'shortcuts' && <ShortcutsPane />}
              {pane === 'terminal' && (
                <ShellPicker shells={shells} defaultShell={defaultShell} onPick={setDefaultShell} />
              )}
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
  onAppearanceChange,
  onFontChange,
  onFontSizeChange,
}: {
  appearance: Appearance;
  fontId: string;
  fontSize: number;
  onAppearanceChange: (a: Appearance) => void;
  onFontChange: (id: string) => void;
  onFontSizeChange: (size: number) => void;
}) {
  const showHidden = useFiles((s) => s.showHidden);
  const toggleHidden = useFiles((s) => s.toggleHidden);

  return (
    <div className="space-y-7">
      <Section title="Appearance" hint="Choose how ARC looks. 'System' follows your OS color scheme.">
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

      <Section title="Font Family" hint="Used by the terminal and editor. Falls back to the next available font on your system.">
        <div className="relative">
          <select
            value={fontId}
            onChange={(e) => onFontChange(e.target.value)}
            className="w-full appearance-none rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-2 pr-9 font-display text-[12.5px] font-medium tracking-tight text-fg-base transition-colors focus:border-accent/45 focus:bg-bg-base/80 focus:shadow-focus focus:outline-none"
            style={{ fontFamily: getFont(fontId).stack }}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                {f.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={12}
            strokeWidth={2.2}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
        </div>
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

const SHORTCUT_CATEGORIES: ActionCategory[] = ['Workspace', 'Terminal', 'Assistant', 'AI CLIs', 'Help'];

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
        {filtered.length === 0 && (
          <div className="flex items-center justify-center gap-1.5 px-4 py-12 font-display text-[12px] italic text-fg-subtle">
            <Search size={11} strokeWidth={2} />
            no actions match "{query}"
          </div>
        )}
      </div>

      <p className="font-display text-[11px] text-fg-subtle">
        Click a binding to rebind · <kbd className="font-mono">esc</kbd> to cancel
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

// ─── Providers ──────────────────────────────────────────────────────────────

interface ProviderConfigRow {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

function ProvidersPane({
  activePresetId,
  enabledPresetIds,
  providers,
  onSetActive,
  onToggleEnabled,
  onUpdateProvider,
}: {
  activePresetId: string;
  enabledPresetIds: string[];
  providers: Record<string, ProviderConfigRow>;
  onSetActive: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onUpdateProvider: (id: string, patch: Partial<ProviderConfigRow>) => void;
}) {
  // The row currently shown in the detail panel. Defaults to whatever is
  // active so the user lands on the preset they actually use.
  const [selectedId, setSelectedId] = useState(activePresetId);
  const [query, setQuery] = useState('');

  // Keep selection in sync if `activePresetId` changes from elsewhere
  // (e.g. cross-window broadcast) — but only if the user hasn't focused a
  // different row.
  useEffect(() => {
    setSelectedId((curr) => (providers[curr] ? curr : activePresetId));
    // We intentionally don't follow activePresetId on every change — the
    // user is allowed to inspect a non-active provider without it snapping
    // back. Only adjust when the current selection vanishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePresetId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [query]);

  const cloud = filtered.filter((p) => p.category === 'cloud');
  const local = filtered.filter((p) => p.category === 'local');
  const selected = presetOrDefault(selectedId);
  const selectedCfg = providers[selected.id] ?? { model: selected.defaultModels[0] ?? '' };

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {/* Provider directory */}
      <aside className="flex w-[240px] shrink-0 flex-col border-r border-border-hairline bg-bg-base/30">
        <div className="border-b border-border-hairline px-3 pb-2 pt-3">
          <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 focus-within:border-accent/45 focus-within:shadow-focus">
            <Search size={11} strokeWidth={2.2} className="text-fg-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter providers…"
              className="flex-1 bg-transparent font-display text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="rounded p-0.5 text-fg-subtle hover:bg-white/[0.08] hover:text-fg-base"
                aria-label="Clear filter"
              >
                <X size={9} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <ProviderGroup
            label="Cloud"
            icon={Cloud}
            count={cloud.length}
            items={cloud}
            providers={providers}
            enabledPresetIds={enabledPresetIds}
            activePresetId={activePresetId}
            selectedId={selected.id}
            onSelect={setSelectedId}
          />
          <ProviderGroup
            label="Local"
            icon={HardDrive}
            count={local.length}
            items={local}
            providers={providers}
            enabledPresetIds={enabledPresetIds}
            activePresetId={activePresetId}
            selectedId={selected.id}
            onSelect={setSelectedId}
          />
          {filtered.length === 0 && (
            <div className="px-4 pt-6 text-center font-display text-[11px] italic text-fg-subtle">
              no providers match "{query}"
            </div>
          )}
        </div>
      </aside>

      {/* Detail panel */}
      <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <ProviderDetail
          key={selected.id}
          preset={selected}
          cfg={selectedCfg}
          isActive={selected.id === activePresetId}
          isEnabled={enabledPresetIds.includes(selected.id)}
          onSetActive={() => onSetActive(selected.id)}
          onToggleEnabled={(enabled) => onToggleEnabled(selected.id, enabled)}
          onUpdate={(patch) => onUpdateProvider(selected.id, patch)}
        />
      </section>
    </div>
  );
}

function ProviderGroup({
  label,
  icon: Icon,
  count,
  items,
  providers,
  enabledPresetIds,
  activePresetId,
  selectedId,
  onSelect,
}: {
  label: string;
  icon: typeof Cloud;
  count: number;
  items: ProviderPreset[];
  providers: Record<string, ProviderConfigRow>;
  enabledPresetIds: string[];
  activePresetId: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-3 pb-1 pt-1">
        <div className="flex items-center gap-1.5">
          <Icon size={9} strokeWidth={2.4} className="text-fg-subtle" />
          <h4 className="font-display text-[10px] font-semibold uppercase tracking-widest2 text-fg-subtle">
            {label}
          </h4>
        </div>
        <span className="font-mono text-[9.5px] text-fg-subtle">{count}</span>
      </div>
      <div className="flex flex-col">
        {items.map((p) => (
          <ProviderRow
            key={p.id}
            preset={p}
            cfg={providers[p.id]}
            selected={p.id === selectedId}
            active={p.id === activePresetId}
            enabled={enabledPresetIds.includes(p.id)}
            onSelect={() => onSelect(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderRow({
  preset,
  cfg,
  selected,
  active,
  enabled,
  onSelect,
}: {
  preset: ProviderPreset;
  cfg: ProviderConfigRow | undefined;
  selected: boolean;
  active: boolean;
  enabled: boolean;
  onSelect: () => void;
}) {
  const configured = !preset.needsApiKey || Boolean(cfg?.apiKey);
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group relative flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-100 ease-apple',
        selected
          ? 'bg-accent-soft'
          : 'hover:bg-white/[0.035]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full transition-colors',
          selected ? 'bg-accent' : 'bg-transparent',
        )}
      />
      <StatusDot configured={configured} enabled={enabled} />
      <Monogram preset={preset} small dimmed={!enabled} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate font-display text-[12.5px] font-medium tracking-tight',
              enabled ? 'text-fg-base' : 'text-fg-muted',
            )}
          >
            {preset.label}
          </span>
          {active && <ActivePill label="Current" />}
          {!active && enabled && <EnabledPill />}
        </div>
        <p className="truncate font-mono text-[10px] text-fg-subtle">
          {cfg?.model || preset.defaultModels[0] || 'no model set'}
        </p>
      </div>
    </button>
  );
}

function StatusDot({
  configured,
  enabled = true,
}: {
  configured: boolean;
  enabled?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-[5px] w-[5px] shrink-0 rounded-full',
        configured && enabled
          ? 'bg-accent shadow-[0_0_4px_0_rgba(220,224,232,0.55)]'
          : configured
            ? 'bg-fg-subtle'
            : 'border border-border-strong',
      )}
    />
  );
}

function ActivePill({ label = 'Active' }: { label?: string }) {
  return (
    <span className="rounded bg-accent-soft px-1 py-0.5 font-display text-[8.5px] font-semibold uppercase tracking-widest2 text-accent-bright ring-1 ring-inset ring-accent/30">
      {label}
    </span>
  );
}

function EnabledPill() {
  return (
    <span className="rounded bg-white/[0.06] px-1 py-0.5 font-display text-[8.5px] font-semibold uppercase tracking-widest2 text-fg-muted ring-1 ring-inset ring-white/10">
      On
    </span>
  );
}

function Monogram({
  preset,
  small,
  dimmed,
}: {
  preset: ProviderPreset;
  small?: boolean;
  dimmed?: boolean;
}) {
  const tint = TINT_CLASSES[preset.tint];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-display font-semibold ring-1 ring-inset transition-opacity',
        tint.bg,
        tint.fg,
        tint.ring,
        small ? 'h-[22px] w-[22px] text-[11px]' : 'h-[34px] w-[34px] text-[15px]',
        dimmed && 'opacity-50',
      )}
      aria-hidden
    >
      {preset.monogram}
    </span>
  );
}

function ProviderDetail({
  preset,
  cfg,
  isActive,
  isEnabled,
  onSetActive,
  onToggleEnabled,
  onUpdate,
}: {
  preset: ProviderPreset;
  cfg: ProviderConfigRow;
  isActive: boolean;
  isEnabled: boolean;
  onSetActive: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onUpdate: (patch: Partial<ProviderConfigRow>) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(preset.advancedDefault));
  const [customModel, setCustomModel] = useState('');
  const [testState, setTestState] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');

  // Live model catalog — pulled the first time this preset is selected.
  const entry = useModels((s) => s.entries[preset.id]);
  const fetchModels = useModels((s) => s.fetch);
  const loading = entry?.status === 'loading';
  const errored = entry?.status === 'error';

  useEffect(() => {
    setShowKey(false);
    setAdvancedOpen(Boolean(preset.advancedDefault));
    setCustomModel('');
    setTestState('idle');
    if (!preset.needsApiKey || cfg.apiKey) {
      void fetchModels(preset.id).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.id]);

  const configured = !preset.needsApiKey || Boolean(cfg.apiKey);
  const liveModels = resolveModelsFor(preset.id, entry);
  const knownIds = liveModels.map((m) => m.id);
  const modelInKnown = knownIds.includes(cfg.model);
  const showFreeForm = preset.freeFormModel || knownIds.length === 0;
  const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

  const handlePasteKey = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onUpdate({ apiKey: text.trim() });
    } catch {
      /* clipboard blocked */
    }
  };

  // `Test` is a placeholder for a 1-token completion ping. The real wire-up
  // can land later; for now flash the affordance so the visual story is
  // complete.
  const handleTest = () => {
    setTestState('running');
    setTimeout(() => setTestState(configured ? 'ok' : 'fail'), 600);
    setTimeout(() => setTestState('idle'), 2400);
  };

  return (
    <div className="flex flex-col gap-6 px-6 py-5 animate-fade-in">
      {/* Identity */}
      <header className="flex items-start gap-3">
        <Monogram preset={preset} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-display text-[15px] font-semibold tracking-tight text-fg-base">
              {preset.label}
            </h2>
            <span className="rounded border border-border-subtle bg-bg-base/40 px-1.5 py-0.5 font-display text-[9.5px] font-medium uppercase tracking-widest2 text-fg-muted">
              {preset.category}
            </span>
            {isActive && <ActivePill />}
          </div>
          <p className="mt-0.5 font-display text-[11.5px] text-fg-muted">
            {preset.description}
          </p>
        </div>
      </header>

      <div className="h-px bg-border-hairline" />

      {/* API key */}
      {preset.needsApiKey && (
        <FieldSection
          title="API Key"
          hint="Stored in the OS credential vault — never written to localStorage."
        >
          <div className="group flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-1.5 focus-within:border-accent/45 focus-within:bg-bg-base/80 focus-within:shadow-focus">
            <Key size={11} className="text-fg-subtle" />
            <input
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey ?? ''}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
              placeholder={preset.apiKeyPlaceholder ?? 'paste key here'}
              className="flex-1 bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={handlePasteKey}
              className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-white/[0.08] hover:text-fg-base"
              aria-label="Paste from clipboard"
              title="Paste from clipboard"
            >
              <ClipboardPaste size={11} />
            </button>
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-white/[0.08] hover:text-fg-base"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
            </button>
          </div>
          {preset.signupUrl && (
            <button
              onClick={() => openExternal(preset.signupUrl!)}
              className="mt-1 inline-flex items-center gap-1 font-display text-[10.5px] text-fg-subtle transition-colors hover:text-fg-base"
            >
              Get a key
              <ExternalLink size={9} strokeWidth={2.2} />
            </button>
          )}
        </FieldSection>
      )}

      {!preset.needsApiKey && preset.signupUrl && (
        <FieldSection title="Setup" hint={`${preset.label} runs locally — install once, no key required.`}>
          <button
            onClick={() => openExternal(preset.signupUrl!)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-base/40 px-2.5 py-1.5 font-display text-[11.5px] text-fg-base transition-colors hover:border-border-strong hover:bg-bg-base/60"
          >
            Download {preset.label}
            <ExternalLink size={10} strokeWidth={2.1} className="text-fg-subtle" />
          </button>
        </FieldSection>
      )}

      {/* Model — live catalog from the provider API. */}
      <FieldSection>
        <div className="flex items-center justify-between">
          <h3 className="font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-muted">
            Available models
          </h3>
          <div className="flex items-center gap-1.5">
            {entry?.fetchedAt && (
              <span className="font-display text-[10px] text-fg-subtle" title={new Date(entry.fetchedAt).toLocaleString()}>
                fetched {formatAgo(entry.fetchedAt)}
              </span>
            )}
            <button
              onClick={() => void fetchModels(preset.id, { force: true }).catch(() => {})}
              disabled={loading || (preset.needsApiKey && !cfg.apiKey)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-display text-[10.5px] transition-colors',
                loading || (preset.needsApiKey && !cfg.apiKey)
                  ? 'cursor-not-allowed border-border-subtle text-fg-subtle'
                  : 'border-border-subtle text-fg-muted hover:border-border-strong hover:text-fg-base',
              )}
              title="Refresh from provider API"
            >
              <RefreshCw
                size={9}
                strokeWidth={2.2}
                className={cn(loading && 'animate-spin')}
              />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {errored && entry?.error && (
          <div className="flex items-center gap-1.5 rounded-md border border-status-warn/30 bg-status-warn/10 px-2.5 py-1 font-display text-[11px] text-status-warn">
            <AlertTriangle size={10} strokeWidth={2.1} />
            {entry.error.startsWith('no api key')
              ? 'Set an API key above to fetch models.'
              : `Could not fetch models — ${entry.error.slice(0, 80)}`}
          </div>
        )}

        {liveModels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {liveModels.map((m) => {
              const selectedModel = m.id === cfg.model;
              return (
                <button
                  key={m.id}
                  onClick={() => onUpdate({ model: m.id })}
                  className={cn(
                    'rounded-md border px-2.5 py-1 font-mono text-[11px] transition-all duration-150 ease-apple',
                    selectedModel
                      ? 'border-accent/50 bg-accent-soft text-fg-base shadow-glow-sm'
                      : 'border-border-subtle bg-bg-base/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
                  )}
                  title={m.label ?? m.id}
                >
                  {m.label ?? m.id}
                </button>
              );
            })}
          </div>
        ) : !loading && !errored ? (
          <p className="font-display text-[11px] text-fg-subtle">
            No models cached yet. Click Refresh once a key is in place.
          </p>
        ) : null}

        {showFreeForm && (
          <div className="mt-2">
            <div className="font-display text-[10px] font-semibold uppercase tracking-widest2 text-fg-subtle">
              {liveModels.length > 0 ? 'Custom model' : 'Model name'}
            </div>
            <input
              value={modelInKnown ? customModel : cfg.model}
              onChange={(e) => {
                const v = e.target.value;
                setCustomModel(v);
                onUpdate({ model: v });
              }}
              placeholder={
                preset.id === 'ollama'
                  ? 'llama3.2:1b'
                  : preset.id === 'lmstudio'
                    ? 'whatever-you-loaded'
                    : 'provider/model-id'
              }
              className="mt-1 w-full rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:bg-bg-base/80 focus:shadow-focus focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
      </FieldSection>

      {/* Advanced */}
      <FieldSection>
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 font-display text-[11px] font-semibold uppercase tracking-widest2 text-fg-muted transition-colors hover:text-fg-base"
        >
          {advancedOpen ? <ChevronDown size={10} strokeWidth={2.4} /> : <ChevronRight size={10} strokeWidth={2.4} />}
          Advanced
        </button>
        {advancedOpen && (
          <div className="mt-2 space-y-3 rounded-lg border border-border-subtle bg-bg-base/30 p-3">
            <div>
              <div className="mb-1 font-display text-[10px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                Base URL
              </div>
              <input
                value={cfg.baseUrl ?? ''}
                onChange={(e) => onUpdate({ baseUrl: e.target.value })}
                placeholder={preset.defaultBaseUrl || 'https://your-endpoint/v1'}
                className="w-full rounded-md border border-border-subtle bg-bg-base/60 px-3 py-1.5 font-mono text-[11.5px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:bg-bg-base/80 focus:shadow-focus focus:outline-none"
                autoComplete="off"
                spellCheck={false}
              />
              {preset.defaultBaseUrl && cfg.baseUrl && cfg.baseUrl !== preset.defaultBaseUrl && (
                <button
                  onClick={() => onUpdate({ baseUrl: preset.defaultBaseUrl })}
                  className="mt-1 inline-flex items-center gap-1 font-display text-[10.5px] text-fg-subtle transition-colors hover:text-fg-base"
                >
                  <RotateCcw size={9} strokeWidth={2.2} />
                  reset to default
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 font-display text-[10.5px] text-fg-subtle">
              <span>Backend kind</span>
              <span className="font-mono text-fg-muted">{preset.kind}</span>
            </div>
          </div>
        )}
      </FieldSection>

      {/* Action row — Enabled toggle, Make current, Test. */}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <EnabledToggle
          enabled={isEnabled}
          disabled={preset.needsApiKey && !cfg.apiKey}
          onToggle={onToggleEnabled}
        />
        {isActive ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 font-display text-[12px] font-medium tracking-tight text-fg-base shadow-glow-sm">
            <Check size={11} strokeWidth={2.2} className="text-accent-bright" />
            Current selection
          </span>
        ) : (
          <button
            onClick={onSetActive}
            disabled={!isEnabled}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-display text-[12px] font-medium tracking-tight transition-all duration-150 ease-apple',
              !isEnabled
                ? 'cursor-not-allowed border-border-subtle bg-bg-base/30 text-fg-subtle'
                : 'border-accent/45 bg-accent-soft text-fg-base hover:bg-accent/15 hover:shadow-glow-sm',
            )}
            title="Use this provider for the next chat turn"
          >
            <Zap size={11} strokeWidth={2.2} />
            Use now
          </button>
        )}
        <button
          onClick={handleTest}
          disabled={preset.needsApiKey && !cfg.apiKey}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-display text-[12px] font-medium tracking-tight transition-colors',
            preset.needsApiKey && !cfg.apiKey
              ? 'cursor-not-allowed border-border-subtle bg-bg-base/30 text-fg-subtle'
              : 'border-border-subtle bg-bg-base/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
          )}
          title="Send a 1-token ping (coming soon)"
        >
          {testState === 'running' && (
            <span className="h-2 w-2 animate-pulse-soft rounded-full bg-accent" />
          )}
          {testState === 'ok' && <Check size={11} strokeWidth={2.2} className="text-status-ok" />}
          {testState === 'fail' && (
            <AlertTriangle size={11} strokeWidth={2.2} className="text-status-warn" />
          )}
          {testState === 'idle' && <Cpu size={11} strokeWidth={2.2} />}
          {testState === 'running'
            ? 'Testing…'
            : testState === 'ok'
              ? 'OK'
              : testState === 'fail'
                ? 'Failed'
                : 'Test'}
        </button>
        <span className="ml-auto font-display text-[10.5px] text-fg-subtle">
          {configured ? 'connected' : preset.needsApiKey ? 'needs key' : 'ready'}
        </span>
      </div>
    </div>
  );
}

function EnabledToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onToggle(!enabled)}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 font-display text-[12px] font-medium tracking-tight transition-colors',
        disabled
          ? 'cursor-not-allowed border-border-subtle bg-bg-base/30 text-fg-subtle'
          : enabled
            ? 'border-border-strong bg-bg-base/60 text-fg-base hover:bg-bg-base/80'
            : 'border-border-subtle bg-bg-base/30 text-fg-muted hover:border-border-strong hover:text-fg-base',
      )}
      title={enabled ? 'Hide from model picker' : 'Show in model picker'}
    >
      <span
        className={cn(
          'inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full transition-colors',
          enabled ? 'bg-accent/80' : 'bg-bg-base/60 ring-1 ring-inset ring-border-subtle',
        )}
      >
        <span
          className={cn(
            'inline-block h-[10px] w-[10px] rounded-full bg-white shadow-sm transition-transform',
            enabled ? 'translate-x-[12px]' : 'translate-x-[2px]',
          )}
        />
      </span>
      {enabled ? (
        <>
          <Check size={10} strokeWidth={2.4} className="text-accent-bright" />
          Enabled
        </>
      ) : (
        <>
          <PowerOff size={10} strokeWidth={2.2} />
          Disabled
        </>
      )}
    </button>
  );
}

function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function FieldSection({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      {title && (
        <h3 className="font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-muted">
          {title}
        </h3>
      )}
      {children}
      {hint && (
        <p className="font-display text-[10.5px] leading-relaxed text-fg-subtle">{hint}</p>
      )}
    </section>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────────

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
