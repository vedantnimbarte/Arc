import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Key, Cpu, Boxes, MessageSquare, SlidersHorizontal } from 'lucide-react';
import {
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  useSettings,
} from '../state/settings';
import type { LlmProvider } from '../lib/tauri';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
}

const PROVIDERS: LlmProvider[] = ['openai', 'anthropic', 'ollama'];

const PROVIDER_ICON: Record<LlmProvider, typeof Cpu> = {
  openai: Cpu,
  anthropic: Cpu,
  ollama: Boxes,
};

type Pane = 'providers' | 'prompt';

export function SettingsDialog({ open, onClose }: Props) {
  const {
    activeProvider,
    providers,
    systemPrompt,
    setActiveProvider,
    updateProvider,
    setSystemPrompt,
  } = useSettings();

  const [showKey, setShowKey] = useState(false);
  const [pane, setPane] = useState<Pane>('providers');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const cfg = providers[activeProvider];
  const models = PROVIDER_MODELS[activeProvider];
  const isOllama = activeProvider === 'ollama';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[10vh] flex w-[680px] max-w-[92vw] animate-sheet-in overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        {/* Sidebar — the macOS Settings.app pattern: thin source list,
            translucent material, single-column section nav. */}
        <aside className="material-sidebar flex w-[180px] shrink-0 flex-col border-r border-border-hairline">
          <nav className="flex flex-col gap-0.5 p-2 pt-3">
            <SidebarRow
              icon={SlidersHorizontal}
              label="Providers"
              active={pane === 'providers'}
              onClick={() => setPane('providers')}
            />
            <SidebarRow
              icon={MessageSquare}
              label="System Prompt"
              active={pane === 'prompt'}
              onClick={() => setPane('prompt')}
            />
          </nav>

          <div className="mt-auto p-3 font-display text-[10px] tracking-tight text-fg-subtle">
            arc settings
          </div>
        </aside>

        {/* Detail pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 items-center justify-between border-b border-border-hairline bg-bg-chrome/40 px-4 backdrop-blur-md">
            <span className="font-display text-[13px] font-semibold tracking-tight text-fg-base">
              {pane === 'providers' ? 'Providers' : 'System Prompt'}
            </span>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-fg-subtle transition-all duration-150 ease-apple hover:bg-white/[0.08] hover:text-fg-base"
              aria-label="Close"
              title="Close (esc)"
            >
              <X size={13} strokeWidth={2.2} />
            </button>
          </div>

          <div className="space-y-5 overflow-y-auto p-5">
            {pane === 'providers' && (
              <>
                {/* Provider picker — segmented control */}
                <Section title="Service">
                  <div className="inline-flex rounded-lg bg-bg-base/55 p-0.5 ring-1 ring-border-subtle">
                    {PROVIDERS.map((id) => {
                      const Icon = PROVIDER_ICON[id];
                      const isActive = id === activeProvider;
                      return (
                        <button
                          key={id}
                          onClick={() => setActiveProvider(id)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 font-display text-[12px] font-medium tracking-tight transition-all duration-150 ease-apple',
                            isActive
                              ? 'bg-bg-subtle text-fg-base shadow-control'
                              : 'text-fg-muted hover:text-fg-base',
                          )}
                        >
                          <Icon size={11} strokeWidth={2.2} className={isActive ? 'text-accent' : ''} />
                          {PROVIDER_LABELS[id]}
                        </button>
                      );
                    })}
                  </div>
                </Section>

                {/* Model */}
                <Section title="Model">
                  {isOllama ? (
                    <input
                      value={cfg.model}
                      onChange={(e) => updateProvider(activeProvider, { model: e.target.value })}
                      placeholder="llama3.2:1b"
                      className="w-full rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:bg-bg-base/80 focus:shadow-focus"
                    />
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {models.map((m) => {
                        const isActive = m === cfg.model;
                        return (
                          <button
                            key={m}
                            onClick={() => updateProvider(activeProvider, { model: m })}
                            className={cn(
                              'rounded-md border px-2.5 py-1 font-mono text-[11px] transition-all duration-150 ease-apple',
                              isActive
                                ? 'border-accent/50 bg-accent-soft text-fg-base shadow-glow-sm'
                                : 'border-border-subtle bg-bg-base/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
                            )}
                          >
                            {m}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Section>

                {/* API key */}
                {!isOllama && (
                  <Section
                    title="API Key"
                    hint="Stored locally. Will move to the macOS Keychain via Rust before public release."
                  >
                    <div className="group flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-1.5 focus-within:border-accent/45 focus-within:bg-bg-base/80 focus-within:shadow-focus">
                      <Key size={11} className="text-fg-subtle" />
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={cfg.apiKey ?? ''}
                        onChange={(e) => updateProvider(activeProvider, { apiKey: e.target.value })}
                        placeholder={
                          activeProvider === 'openai' ? 'sk-…' : 'sk-ant-…'
                        }
                        className="flex-1 bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="rounded-md p-1 text-fg-subtle hover:bg-white/[0.08] hover:text-fg-base"
                        aria-label={showKey ? 'Hide key' : 'Show key'}
                      >
                        {showKey ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                    </div>
                  </Section>
                )}

                {/* Base URL */}
                {isOllama && (
                  <Section title="Base URL">
                    <input
                      value={cfg.baseUrl ?? ''}
                      onChange={(e) => updateProvider(activeProvider, { baseUrl: e.target.value })}
                      placeholder="http://localhost:11434"
                      className="w-full rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:bg-bg-base/80 focus:shadow-focus"
                    />
                  </Section>
                )}
              </>
            )}

            {pane === 'prompt' && (
              <Section
                title="System Prompt"
                hint="Prefixed to every conversation. Affects tone, format, and behavior."
              >
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={9}
                  className="w-full resize-none rounded-lg border border-border-subtle bg-bg-base/60 px-3 py-2 font-display text-[12.5px] leading-relaxed text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:bg-bg-base/80 focus:shadow-focus"
                />
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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
    <section className="space-y-1.5">
      <h3 className="font-display text-[11px] font-semibold tracking-tight text-fg-muted">
        {title}
      </h3>
      {children}
      {hint && (
        <p className="font-display text-[10.5px] leading-relaxed text-fg-subtle">
          {hint}
        </p>
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
