import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Sparkles,
  ListChecks,
  Rocket,
  ScanSearch,
  GraduationCap,
  Bot,
  Wrench,
  Brain,
  Terminal as TerminalIcon,
  Bug,
  type LucideIcon,
} from 'lucide-react';

// --- Visual taxonomy -------------------------------------------------------

export type AgentIconKey =
  | 'sparkles'
  | 'list-checks'
  | 'rocket'
  | 'scan-search'
  | 'graduation'
  | 'bot'
  | 'wrench'
  | 'brain'
  | 'terminal'
  | 'bug';

export const AGENT_ICONS: Record<AgentIconKey, LucideIcon> = {
  sparkles: Sparkles,
  'list-checks': ListChecks,
  rocket: Rocket,
  'scan-search': ScanSearch,
  graduation: GraduationCap,
  bot: Bot,
  wrench: Wrench,
  brain: Brain,
  terminal: TerminalIcon,
  bug: Bug,
};

export type AgentTint =
  | 'platinum'
  | 'sky'
  | 'violet'
  | 'amber'
  | 'emerald'
  | 'rose'
  | 'lime';

// Tints are dual-purpose: they tint the agent's icon chip and seed the
// active-state ring on cards. Kept literal so Tailwind's JIT can find them.
export const AGENT_TINTS: Record<
  AgentTint,
  { chipBg: string; chipFg: string; chipRing: string; ringActive: string; dot: string }
> = {
  platinum: {
    chipBg: 'bg-white/[0.08]',
    chipFg: 'text-fg-base',
    chipRing: 'ring-white/[0.15]',
    ringActive: 'ring-white/30',
    dot: 'bg-white/80',
  },
  sky: {
    chipBg: 'bg-sky-400/[0.12]',
    chipFg: 'text-sky-200',
    chipRing: 'ring-sky-400/30',
    ringActive: 'ring-sky-400/45',
    dot: 'bg-sky-300',
  },
  violet: {
    chipBg: 'bg-violet-400/[0.12]',
    chipFg: 'text-violet-200',
    chipRing: 'ring-violet-400/30',
    ringActive: 'ring-violet-400/45',
    dot: 'bg-violet-300',
  },
  amber: {
    chipBg: 'bg-amber-400/[0.12]',
    chipFg: 'text-amber-200',
    chipRing: 'ring-amber-400/30',
    ringActive: 'ring-amber-400/45',
    dot: 'bg-amber-300',
  },
  emerald: {
    chipBg: 'bg-emerald-400/[0.12]',
    chipFg: 'text-emerald-200',
    chipRing: 'ring-emerald-400/30',
    ringActive: 'ring-emerald-400/45',
    dot: 'bg-emerald-300',
  },
  rose: {
    chipBg: 'bg-rose-400/[0.12]',
    chipFg: 'text-rose-200',
    chipRing: 'ring-rose-400/30',
    ringActive: 'ring-rose-400/45',
    dot: 'bg-rose-300',
  },
  lime: {
    chipBg: 'bg-lime-400/[0.12]',
    chipFg: 'text-lime-200',
    chipRing: 'ring-lime-400/30',
    ringActive: 'ring-lime-400/45',
    dot: 'bg-lime-300',
  },
};

// --- Agent shape -----------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  iconKey: AgentIconKey;
  tint: AgentTint;
  builtin: boolean;
  createdAt: number;
}

// Built-in agent personas. Kept short so the system prompts read like a job
// description rather than a screenplay — terse system prompts tend to give
// the LLM more room to be useful.
export const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'chat-assistant',
    name: 'Chat Assistant',
    description: 'A general-purpose helper for any question.',
    systemPrompt:
      'You are ARC, a helpful AI assistant embedded in a developer terminal. Keep answers tight, prefer code over prose, and assume the user is a working engineer.',
    iconKey: 'sparkles',
    tint: 'platinum',
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'task-planner',
    name: 'Task Planner',
    description: 'Breaks a goal into ordered, actionable tasks.',
    systemPrompt:
      'You are a planning assistant. Given a goal, decompose it into a numbered list of small, concrete tasks. Each task should be independently verifiable. Call out dependencies and pre-requisites explicitly. Avoid filler — output the list and nothing else unless asked.',
    iconKey: 'list-checks',
    tint: 'sky',
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'sprint-planner',
    name: 'Sprint Planner',
    description: 'Plans 1-2 week sprints with capacity and risk.',
    systemPrompt:
      'You are a sprint planner. For the goals provided, propose a 1-2 week sprint plan with: scope (in/out), tickets with rough estimates in points, suggested ownership, capacity check, and the top 3 risks with mitigations. Be honest about uncertainty.',
    iconKey: 'rocket',
    tint: 'violet',
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'review-agent',
    name: 'Review Agent',
    description: 'Reviews diffs and surfaces risks, bugs, and nits.',
    systemPrompt:
      'You are a senior code reviewer. For each diff or snippet: flag correctness bugs, security issues, and performance traps first; then design concerns; then nits. Cite exact line(s). Skip praise — assume the author wants signal, not encouragement.',
    iconKey: 'scan-search',
    tint: 'amber',
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'code-explainer',
    name: 'Code Explainer',
    description: 'Explains code with context, examples, and trade-offs.',
    systemPrompt:
      'You are a patient teacher of working engineers. Explain code by stating what it does in one sentence, then walking through the key mechanisms, then noting trade-offs and alternatives. Use small inline examples. Prefer precision over hedging.',
    iconKey: 'graduation',
    tint: 'emerald',
    builtin: true,
    createdAt: 0,
  },
  {
    id: 'debug-buddy',
    name: 'Debug Buddy',
    description: 'Pairs on a failing test or stack trace until it works.',
    systemPrompt:
      'You are a debugging partner. Given a failing test, stack trace, or symptom: state the likely root cause first, then the diagnostic step to confirm, then the minimal fix. Ask only the one question you need to proceed.',
    iconKey: 'bug',
    tint: 'rose',
    builtin: true,
    createdAt: 0,
  },
];

// --- Store -----------------------------------------------------------------

interface AgentsState {
  custom: Agent[];
  /** Per-agent extra instructions appended to the base systemPrompt. Keyed
   *  by agent id; applies to both built-in and custom agents. Empty/whitespace
   *  values mean "no override" — same as a missing entry. */
  instructions: Record<string, string>;
  createAgent: (
    input: Omit<Agent, 'id' | 'builtin' | 'createdAt'>,
  ) => string;
  updateAgent: (
    id: string,
    patch: Partial<Omit<Agent, 'id' | 'builtin' | 'createdAt'>>,
  ) => void;
  deleteAgent: (id: string) => void;
  /** Set the custom-instruction override for an agent. Pass null/empty to
   *  clear so the agent falls back to its default systemPrompt. */
  setInstructions: (agentId: string, text: string | null) => void;
}

export const useAgents = create<AgentsState>()(
  persist(
    (set) => ({
      custom: [],
      instructions: {},
      createAgent: (input) => {
        const id = `custom-${crypto.randomUUID()}`;
        set((s) => ({
          custom: [
            ...s.custom,
            { ...input, id, builtin: false, createdAt: Date.now() },
          ],
        }));
        return id;
      },
      updateAgent: (id, patch) =>
        set((s) => ({
          custom: s.custom.map((a) =>
            a.id === id && !a.builtin ? { ...a, ...patch } : a,
          ),
        })),
      deleteAgent: (id) =>
        set((s) => {
          // Drop the instructions row too — orphan overrides waste storage
          // and confuse the UI if the same id is ever reissued.
          const { [id]: _gone, ...rest } = s.instructions;
          return {
            custom: s.custom.filter((a) => a.id !== id || a.builtin),
            instructions: rest,
          };
        }),
      setInstructions: (agentId, text) =>
        set((s) => {
          const trimmed = (text ?? '').trim();
          if (trimmed.length === 0) {
            const { [agentId]: _gone, ...rest } = s.instructions;
            return { instructions: rest };
          }
          return { instructions: { ...s.instructions, [agentId]: trimmed } };
        }),
    }),
    // Version stays at 1 — adding the `instructions` field is backwards
    // compatible because Zustand persist shallow-merges the loaded blob
    // onto the initial state, so v1 stores get `instructions: {}` for free.
    { name: 'arc-agents', version: 1 },
  ),
);

// Cross-window rehydrate. The Settings, Agent-editor, and main windows all
// share localStorage but each has its own Zustand instance — a save in one
// won't reach the others without this listener.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'arc-agents') {
      void useAgents.persist.rehydrate();
    }
  });
}

// --- Selectors -------------------------------------------------------------

/** All agents in display order (built-ins first, then user-created). */
export function getAllAgents(state: AgentsState = useAgents.getState()): Agent[] {
  return [...DEFAULT_AGENTS, ...state.custom];
}

/** Resolve an agent and layer the user's custom instructions on top. The
 *  returned object's `systemPrompt` is what should actually be sent to the
 *  model — base prompt + a blank line + the user's extras. */
export function getAgentById(id: string | undefined | null): Agent {
  const state = useAgents.getState();
  const all = [...DEFAULT_AGENTS, ...state.custom];
  const base = (id ? all.find((a) => a.id === id) : undefined) ?? DEFAULT_AGENTS[0]!;
  const extra = (state.instructions[base.id] ?? '').trim();
  if (extra.length === 0) return base;
  return { ...base, systemPrompt: `${base.systemPrompt}\n\n${extra}` };
}

/** Same lookup as {@link getAgentById} but without merging instructions —
 *  the Settings UI uses this to render the unmodified default alongside
 *  the user's override. */
export function getRawAgentById(id: string | undefined | null): Agent {
  if (!id) return DEFAULT_AGENTS[0]!;
  const all = [...DEFAULT_AGENTS, ...useAgents.getState().custom];
  return all.find((a) => a.id === id) ?? DEFAULT_AGENTS[0]!;
}
