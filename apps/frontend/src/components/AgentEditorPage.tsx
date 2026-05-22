import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Lock, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  AGENT_ICONS,
  AGENT_TINTS,
  DEFAULT_AGENTS,
  useAgents,
  type Agent,
  type AgentIconKey,
  type AgentTint,
} from '../state/agents';
import { cn } from '../lib/cn';
import { isTauri, onAgentEditorNavigate } from '../lib/tauri';

const AGENT_ICON_KEYS = Object.keys(AGENT_ICONS) as AgentIconKey[];
const AGENT_TINT_KEYS = Object.keys(AGENT_TINTS) as AgentTint[];

/**
 * Standalone single-agent editor. Loaded into its own Tauri window when the
 * user clicks an agent card in Settings, so the editing experience gets the
 * whole viewport and the directory stays purely a directory.
 *
 * Built-in agents are read-only here for every field *except* "Custom
 * instructions" — that's the user's local override and applies to any
 * agent. Custom agents are fully editable and can be deleted.
 */
export function AgentEditorPage() {
  const custom = useAgents((s) => s.custom);
  const instructions = useAgents((s) => s.instructions);
  const updateAgent = useAgents((s) => s.updateAgent);
  const deleteAgent = useAgents((s) => s.deleteAgent);
  const setInstructions = useAgents((s) => s.setInstructions);

  const allAgents = useMemo(() => [...DEFAULT_AGENTS, ...custom], [custom]);

  // Read the agent id from the URL query. We re-read on `agent-editor://navigate`
  // pings so a second "Edit" from Settings swaps the page in-place rather than
  // opening a duplicate window.
  const [agentId, setAgentId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('id');
  });

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    void onAgentEditorNavigate((id) => {
      setAgentId(id);
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const close = useCallback(() => {
    if (!isTauri) return;
    void getCurrentWindow().close().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const agent = useMemo(() => allAgents.find((a) => a.id === agentId), [allAgents, agentId]);

  if (!agent) {
    return (
      <div className="flex h-screen w-screen flex-col bg-bg-base text-fg-base">
        <TitleBar onClose={close} />
        <div className="flex flex-1 items-center justify-center px-8 text-center">
          <div className="max-w-[360px]">
            <h2 className="font-display text-[14px] font-semibold tracking-tight text-fg-base">
              Agent not found
            </h2>
            <p className="mt-2 font-display text-[12px] leading-relaxed text-fg-muted">
              The agent you opened has been removed in another window. Close
              this window and pick a different one from Settings.
            </p>
            <button
              onClick={close}
              className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-3 py-1.5 font-display text-[11.5px] font-medium tracking-tight text-fg-base ring-1 ring-white/[0.10] transition-colors hover:bg-white/[0.10]"
            >
              <ArrowLeft size={11} strokeWidth={2.2} />
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <EditorBody
      // Key on agent id so the local form state resets cleanly when the
      // window navigates between agents via the navigate ping.
      key={agent.id}
      agent={agent}
      customInstructions={instructions[agent.id] ?? ''}
      onClose={close}
      onUpdate={(patch) => updateAgent(agent.id, patch)}
      onDelete={() => {
        deleteAgent(agent.id);
        close();
      }}
      onSetInstructions={(text) => setInstructions(agent.id, text)}
    />
  );
}

function EditorBody({
  agent,
  customInstructions,
  onClose,
  onUpdate,
  onDelete,
  onSetInstructions,
}: {
  agent: Agent;
  customInstructions: string;
  onClose: () => void;
  onUpdate: (patch: Partial<Omit<Agent, 'id' | 'builtin' | 'createdAt'>>) => void;
  onDelete: () => void;
  onSetInstructions: (text: string | null) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [instructions, setInstructionsLocal] = useState(customInstructions);

  const Icon = AGENT_ICONS[agent.iconKey];
  const tint = AGENT_TINTS[agent.tint];

  const commitField = (patch: Partial<Omit<Agent, 'id' | 'builtin' | 'createdAt'>>) => {
    if (agent.builtin) return;
    onUpdate(patch);
  };
  const commitInstructions = () => {
    if (instructions.trim() === customInstructions.trim()) return;
    onSetInstructions(instructions);
  };
  const clearInstructions = () => {
    setInstructionsLocal('');
    onSetInstructions(null);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-bg-base text-fg-base">
      <TitleBar onClose={onClose} />

      {/* Hero — the one moment of presence in an otherwise quiet page. The
          tinted icon is large enough to feel earned; everything else
          retreats to small type. */}
      <header className="shrink-0 border-b border-border-hairline px-8 pb-7 pt-5">
        <div className="flex items-start gap-4">
          <span
            className={cn(
              'flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ring-1',
              tint.chipBg,
              tint.chipFg,
              tint.chipRing,
            )}
          >
            <Icon size={22} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
                {agent.builtin ? (
                  <span className="inline-flex items-center gap-1">
                    <Lock size={9} strokeWidth={2.3} /> built-in agent
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-accent-bright">
                    <Pencil size={9} strokeWidth={2.3} /> custom agent
                  </span>
                )}
              </span>
            </div>
            <h1 className="mt-0.5 truncate font-display text-[20px] font-semibold tracking-tight text-fg-base">
              {agent.name || 'Untitled agent'}
            </h1>
            <p className="mt-1 font-display text-[12px] leading-relaxed text-fg-muted">
              {agent.description ||
                (agent.builtin ? ' ' : 'Add a short description to remember what it does.')}
            </p>
          </div>
          {!agent.builtin && (
            <button
              onClick={() => {
                if (window.confirm(`Delete agent "${agent.name}"?`)) onDelete();
              }}
              className="flex h-8 items-center gap-1.5 rounded-md px-3 font-display text-[11.5px] font-medium tracking-tight text-fg-muted ring-1 ring-white/[0.06] transition-colors hover:bg-status-err/15 hover:text-status-err hover:ring-status-err/30"
              title="Delete this agent"
            >
              <Trash2 size={11} strokeWidth={2.1} />
              Delete
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-10 pt-7">
        <div className="mx-auto flex max-w-[640px] flex-col gap-8">
          {/* Identity */}
          <FormSection
            label="Identity"
            note={
              agent.builtin
                ? 'Built-in agents are read-only — create a custom agent to remix the visuals.'
                : 'How it shows up in the picker and the chat composer.'
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <LabeledInput
                label="Name"
                value={name}
                disabled={agent.builtin}
                onChange={setName}
                onCommit={() => commitField({ name: name.trim() || agent.name })}
              />
              <LabeledInput
                label="Description"
                value={description}
                disabled={agent.builtin}
                onChange={setDescription}
                onCommit={() => commitField({ description: description.trim() })}
              />
            </div>

            {!agent.builtin && (
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Field label="Icon">
                  <div className="grid grid-cols-5 gap-1.5">
                    {AGENT_ICON_KEYS.map((key) => {
                      const IconChoice = AGENT_ICONS[key];
                      const isOn = agent.iconKey === key;
                      return (
                        <button
                          key={key}
                          onClick={() => commitField({ iconKey: key })}
                          aria-pressed={isOn}
                          className={cn(
                            'flex aspect-square items-center justify-center rounded-md ring-1 ring-inset transition-colors',
                            isOn
                              ? 'bg-white/[0.10] text-fg-base ring-white/25'
                              : 'bg-bg-base/40 text-fg-muted ring-white/[0.05] hover:bg-white/[0.05] hover:text-fg-base',
                          )}
                        >
                          <IconChoice size={13} strokeWidth={2} />
                        </button>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Accent">
                  <div className="grid grid-cols-7 gap-1.5">
                    {AGENT_TINT_KEYS.map((tintKey) => {
                      const t = AGENT_TINTS[tintKey];
                      const isOn = agent.tint === tintKey;
                      return (
                        <button
                          key={tintKey}
                          onClick={() => commitField({ tint: tintKey })}
                          aria-pressed={isOn}
                          className={cn(
                            'flex aspect-square items-center justify-center rounded-md ring-1 ring-inset transition-colors',
                            t.chipBg,
                            isOn ? t.ringActive : 'ring-white/[0.05] hover:ring-white/[0.12]',
                          )}
                        >
                          <span className={cn('h-3 w-3 rounded-full', t.dot)} />
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </div>
            )}
          </FormSection>

          {/* System prompt */}
          <FormSection
            label={agent.builtin ? 'Default prompt' : 'System prompt'}
            note={
              agent.builtin
                ? 'The persona this agent ships with. You cannot change it directly — override or extend it below.'
                : 'Sent as the system message before each turn.'
            }
          >
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              onBlur={() => commitField({ systemPrompt: systemPrompt.trim() || agent.systemPrompt })}
              disabled={agent.builtin}
              rows={7}
              className={cn(
                'w-full resize-y rounded-md border bg-bg-base/40 px-3 py-2.5 font-display text-[12px] leading-relaxed text-fg-base',
                'transition-colors focus:outline-none',
                agent.builtin
                  ? 'cursor-not-allowed border-border-subtle/50 text-fg-muted'
                  : 'border-border-subtle focus:border-accent/45 focus:shadow-focus',
              )}
            />
          </FormSection>

          {/* Custom instructions — the only field built-ins can have. */}
          <FormSection
            label="Custom instructions"
            note="Appended to the system prompt for this agent only. Tweak tone, add house rules, or pin context the model should always carry."
          >
            <textarea
              value={instructions}
              onChange={(e) => setInstructionsLocal(e.target.value)}
              onBlur={commitInstructions}
              placeholder="e.g. Always respond in TypeScript. Cite file paths as path:line. Prefer pnpm over npm."
              rows={6}
              className="w-full resize-y rounded-md border border-border-subtle bg-bg-base/40 px-3 py-2.5 font-display text-[12px] leading-relaxed text-fg-base placeholder:text-fg-subtle transition-colors focus:border-accent/45 focus:shadow-focus focus:outline-none"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-widest2 text-fg-subtle tabular-nums">
                {instructions.trim().length} ch
                {customInstructions.trim() && instructions.trim() !== customInstructions.trim() && (
                  <span className="ml-2 normal-case tracking-normal text-status-warn">· unsaved</span>
                )}
              </span>
              {customInstructions.trim() && (
                <button
                  onClick={clearInstructions}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 font-display text-[11px] text-fg-muted ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.06] hover:text-fg-base"
                  title="Remove the custom instructions for this agent"
                >
                  <RotateCcw size={10} strokeWidth={2.1} />
                  Clear instructions
                </button>
              )}
            </div>
          </FormSection>
        </div>
      </div>
    </div>
  );
}

function TitleBar({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-tauri-drag-region
      className="material-toolbar relative flex h-9 shrink-0 items-center justify-center px-3"
    >
      <span className="font-display text-[11.5px] font-semibold tracking-widest2 uppercase text-fg-muted">
        Agent
      </span>
      <button
        onClick={onClose}
        className="group absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-all duration-200 ease-out hover:bg-red-500/[0.18] hover:text-red-300 active:scale-95"
        aria-label="Close"
        title="Close (esc)"
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function FormSection({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-muted">
          {label}
        </h2>
        {note && (
          <p className="max-w-[60%] text-right font-display text-[10.5px] leading-snug text-fg-subtle">
            {note}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function LabeledInput({
  label,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  return (
    <Field label={label}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        disabled={disabled}
        className={cn(
          'w-full rounded-md border bg-bg-base/40 px-2.5 py-2 font-display text-[12.5px] text-fg-base placeholder:text-fg-subtle',
          'transition-colors focus:outline-none',
          disabled
            ? 'cursor-not-allowed border-border-subtle/50 text-fg-muted'
            : 'border-border-subtle focus:border-accent/45 focus:shadow-focus',
        )}
      />
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="px-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
        {label}
      </span>
      {children}
    </label>
  );
}
