import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Key, Cpu, Boxes } from 'lucide-react';
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg-base/60 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-[8vh] w-[560px] max-w-[92vw] animate-fade-in overflow-hidden rounded-2xl border border-border-subtle bg-bg-panel/90 shadow-panel ring-1 ring-white/5"
      >
        {/* Header */}
        <div className="flex h-12 items-center justify-between border-b border-border-subtle px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent ring-1 ring-accent/20">
              <Key size={11} strokeWidth={2.4} />
            </div>
            <span className="font-display text-[13px] font-semibold tracking-tight text-fg-base">
              Settings
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-fg-subtle transition-all hover:bg-bg-hover/60 hover:text-fg-base"
            aria-label="Close"
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>

        <div className="space-y-6 p-5">
          {/* Provider picker */}
          <section className="space-y-2.5">
            <h3 className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
              Provider
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {PROVIDERS.map((id) => {
                const Icon = PROVIDER_ICON[id];
                const isActive = id === activeProvider;
                return (
                  <button
                    key={id}
                    onClick={() => setActiveProvider(id)}
                    className={cn(
                      'flex flex-col items-start gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 ease-out-soft',
                      isActive
                        ? 'border-accent/40 bg-accent-soft text-fg-base shadow-glow-sm'
                        : 'border-border-subtle bg-bg-subtle/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
                    )}
                  >
                    <Icon size={13} strokeWidth={2.2} className={isActive ? 'text-accent' : ''} />
                    <span className="font-display text-[12px] font-semibold tracking-tight">
                      {PROVIDER_LABELS[id]}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Model */}
          <section className="space-y-2">
            <h3 className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
              Model
            </h3>
            {isOllama ? (
              <input
                value={cfg.model}
                onChange={(e) => updateProvider(activeProvider, { model: e.target.value })}
                placeholder="llama3.2:1b"
                className="w-full rounded-xl border border-border-subtle bg-bg-base/60 px-3 py-2 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-bg-base/85 focus:outline-none focus:shadow-glow-sm"
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
                        'rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-all duration-200',
                        isActive
                          ? 'border-accent/40 bg-accent-soft text-fg-base'
                          : 'border-border-subtle bg-bg-subtle/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
                      )}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* API key — hidden for ollama */}
          {!isOllama && (
            <section className="space-y-2">
              <h3 className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
                API key
              </h3>
              <div className="group flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-base/60 px-3 py-2 focus-within:border-accent/40 focus-within:bg-bg-base/85 focus-within:shadow-glow-sm">
                <Key size={12} className="text-fg-subtle" />
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
                  className="rounded-md p-1 text-fg-subtle hover:bg-bg-hover/60 hover:text-fg-base"
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              <p className="px-1 font-display text-[10px] leading-relaxed text-fg-subtle">
                Stored locally in browser storage. We'll move this to the OS keychain in a follow-up.
              </p>
            </section>
          )}

          {/* Base URL — visible for ollama */}
          {isOllama && (
            <section className="space-y-2">
              <h3 className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
                Base URL
              </h3>
              <input
                value={cfg.baseUrl ?? ''}
                onChange={(e) => updateProvider(activeProvider, { baseUrl: e.target.value })}
                placeholder="http://localhost:11434"
                className="w-full rounded-xl border border-border-subtle bg-bg-base/60 px-3 py-2 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-bg-base/85 focus:outline-none focus:shadow-glow-sm"
              />
            </section>
          )}

          {/* System prompt */}
          <section className="space-y-2">
            <h3 className="font-display text-[10px] font-medium uppercase tracking-widest2 text-fg-subtle">
              System prompt
            </h3>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-xl border border-border-subtle bg-bg-base/60 px-3 py-2 font-display text-[12px] leading-relaxed text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-bg-base/85 focus:outline-none focus:shadow-glow-sm"
            />
          </section>
        </div>
      </div>
    </div>
  );
}
