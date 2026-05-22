// Registry of every AI provider preset the Settings UI knows about.
//
// The Rust backend only speaks three "kinds" — `openai`, `anthropic`,
// `ollama` — but most cloud APIs are OpenAI-compatible, so presets route
// through one of those kinds with a per-preset `defaultBaseUrl`. Adding a
// new cloud provider that already mirrors the OpenAI schema is one entry
// in this file; no Rust changes needed.

import type { LlmProvider } from '../lib/tauri';

export type ProviderKind = LlmProvider;
export type ProviderCategory = 'cloud' | 'local';

/** Tailwind token name for the monogram tile tint. Maps to one of the
 *  Mocha-palette swatches in tailwind.config.ts. Kept as a string so the
 *  component can drive both bg and border colors off it. */
export type ProviderTint =
  | 'teal'
  | 'amber'
  | 'sky'
  | 'indigo'
  | 'violet'
  | 'rose'
  | 'emerald'
  | 'orange'
  | 'red'
  | 'cyan'
  | 'fuchsia'
  | 'lime'
  | 'slate'
  | 'sage'
  | 'neutral';

export interface ProviderPreset {
  /** Stable id, used as keychain entry name and settings key. */
  id: string;
  label: string;
  /** Routing target on the Rust side. */
  kind: ProviderKind;
  category: ProviderCategory;
  /** One-line tagline shown in the row + detail panel. ≤ 60 chars. */
  description: string;
  /** Single-letter monogram for the tile. */
  monogram: string;
  tint: ProviderTint;
  /** Default base URL. If `undefined`, the kind's hard-coded default is used. */
  defaultBaseUrl?: string;
  /** Known model ids; empty array means "free-text only". */
  defaultModels: string[];
  /** Show a free-text input next to / instead of the chip row. */
  freeFormModel?: boolean;
  /** False for purely-local providers (Ollama, LM Studio without auth). */
  needsApiKey: boolean;
  apiKeyPlaceholder?: string;
  /** Link rendered under the API-key field — where the user fetches one. */
  signupUrl?: string;
  /** Auto-expand the "Advanced" disclosure (Base URL etc.) for this preset.
   *  Use for OpenAI-Compatible and LM Studio where Base URL is primary. */
  advancedDefault?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ─── Cloud ───────────────────────────────────────────────────────────
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    category: 'cloud',
    description: 'GPT-4o, o1 family, and the canonical reference API',
    monogram: 'O',
    tint: 'teal',
    defaultBaseUrl: 'https://api.openai.com',
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini'],
    needsApiKey: true,
    apiKeyPlaceholder: 'sk-…',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    category: 'cloud',
    description: 'Claude — Opus, Sonnet, Haiku',
    monogram: 'A',
    tint: 'amber',
    defaultModels: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    needsApiKey: true,
    apiKeyPlaceholder: 'sk-ant-…',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'openai',
    category: 'cloud',
    description: 'Gemini 2.5 family via the OpenAI-compatible endpoint',
    monogram: 'G',
    tint: 'sky',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    needsApiKey: true,
    apiKeyPlaceholder: 'AIza…',
    signupUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    category: 'cloud',
    description: 'DeepSeek-V3 chat and DeepSeek-R1 reasoning',
    monogram: 'D',
    tint: 'indigo',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    needsApiKey: true,
    apiKeyPlaceholder: 'sk-…',
    signupUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'kimi',
    label: 'Moonshot Kimi',
    kind: 'openai',
    category: 'cloud',
    description: 'Long-context Kimi K2 and Moonshot v1',
    monogram: 'K',
    tint: 'violet',
    defaultBaseUrl: 'https://api.moonshot.ai',
    defaultModels: ['kimi-k2-0905-preview', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    needsApiKey: true,
    apiKeyPlaceholder: 'sk-…',
    signupUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'openai',
    category: 'cloud',
    description: 'MiniMax-Text and abab chat models',
    monogram: 'M',
    tint: 'rose',
    defaultBaseUrl: 'https://api.minimax.chat',
    defaultModels: ['MiniMax-Text-01', 'abab6.5s-chat', 'abab6.5-chat'],
    needsApiKey: true,
    signupUrl: 'https://platform.minimaxi.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    category: 'cloud',
    description: 'One key, every model — gateway for 200+ models',
    monogram: 'R',
    tint: 'emerald',
    defaultBaseUrl: 'https://openrouter.ai/api',
    defaultModels: [
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-pro-1.5',
      'meta-llama/llama-3.1-405b-instruct',
      'deepseek/deepseek-chat',
    ],
    freeFormModel: true,
    needsApiKey: true,
    apiKeyPlaceholder: 'sk-or-…',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    category: 'cloud',
    description: 'LPU-accelerated inference — fastest open-weight tokens',
    monogram: 'Q',
    tint: 'orange',
    defaultBaseUrl: 'https://api.groq.com/openai',
    defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    needsApiKey: true,
    apiKeyPlaceholder: 'gsk_…',
    signupUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    category: 'cloud',
    description: 'Mistral Large, Medium, and Small',
    monogram: 'M',
    tint: 'red',
    defaultBaseUrl: 'https://api.mistral.ai',
    defaultModels: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
    needsApiKey: true,
    signupUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai',
    category: 'cloud',
    description: 'Open-weight catalog — Llama, Qwen, Mixtral, DeepSeek',
    monogram: 'T',
    tint: 'cyan',
    defaultBaseUrl: 'https://api.together.xyz',
    defaultModels: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
    ],
    freeFormModel: true,
    needsApiKey: true,
    signupUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    kind: 'openai',
    category: 'cloud',
    description: 'Sonar — search-grounded chat with citations',
    monogram: 'P',
    tint: 'teal',
    defaultBaseUrl: 'https://api.perplexity.ai',
    defaultModels: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'],
    needsApiKey: true,
    apiKeyPlaceholder: 'pplx-…',
    signupUrl: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    kind: 'openai',
    category: 'cloud',
    description: 'Grok family with real-time context',
    monogram: 'X',
    tint: 'neutral',
    defaultBaseUrl: 'https://api.x.ai',
    defaultModels: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'],
    needsApiKey: true,
    apiKeyPlaceholder: 'xai-…',
    signupUrl: 'https://console.x.ai',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai',
    category: 'cloud',
    description: 'Wafer-scale inference for Llama and Qwen',
    monogram: 'C',
    tint: 'fuchsia',
    defaultBaseUrl: 'https://api.cerebras.ai',
    defaultModels: ['llama3.3-70b', 'llama3.1-8b', 'qwen-3-32b'],
    needsApiKey: true,
    signupUrl: 'https://cloud.cerebras.ai',
  },
  {
    id: 'fireworks',
    label: 'Fireworks',
    kind: 'openai',
    category: 'cloud',
    description: 'Open-weight serving — function calling + JSON mode',
    monogram: 'F',
    tint: 'orange',
    defaultBaseUrl: 'https://api.fireworks.ai/inference',
    defaultModels: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
    ],
    freeFormModel: true,
    needsApiKey: true,
    apiKeyPlaceholder: 'fw_…',
    signupUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    kind: 'openai',
    category: 'cloud',
    description: 'Command R+ via OpenAI-compatible endpoint',
    monogram: 'H',
    tint: 'lime',
    defaultBaseUrl: 'https://api.cohere.ai/compatibility',
    defaultModels: ['command-r-plus', 'command-r', 'command-r7b'],
    needsApiKey: true,
    signupUrl: 'https://dashboard.cohere.com/api-keys',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    kind: 'openai',
    category: 'cloud',
    description: 'Azure-hosted OpenAI deployments',
    monogram: 'Z',
    tint: 'sky',
    defaultBaseUrl: '',
    defaultModels: [],
    freeFormModel: true,
    needsApiKey: true,
    apiKeyPlaceholder: 'azure key',
    signupUrl: 'https://portal.azure.com',
    advancedDefault: true,
  },
  {
    id: 'custom',
    label: 'OpenAI-Compatible',
    kind: 'openai',
    category: 'cloud',
    description: 'Any endpoint mirroring the OpenAI chat-completions schema',
    monogram: '+',
    tint: 'neutral',
    defaultBaseUrl: '',
    defaultModels: [],
    freeFormModel: true,
    needsApiKey: true,
    apiKeyPlaceholder: 'optional',
    advancedDefault: true,
  },

  // ─── Local ───────────────────────────────────────────────────────────
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    category: 'local',
    description: 'Run open models locally via ollama serve',
    monogram: 'O',
    tint: 'slate',
    defaultBaseUrl: 'http://localhost:11434',
    defaultModels: ['llama3.2', 'llama3.2:1b', 'qwen2.5-coder', 'mistral', 'phi3'],
    freeFormModel: true,
    needsApiKey: false,
    signupUrl: 'https://ollama.com/download',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai',
    category: 'local',
    description: 'Local server with the OpenAI-compatible API',
    monogram: 'L',
    tint: 'sage',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultModels: [],
    freeFormModel: true,
    needsApiKey: false,
    signupUrl: 'https://lmstudio.ai',
    advancedDefault: true,
  },
];

const PRESETS_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS_BY_ID.get(id);
}

export function presetOrDefault(id: string | undefined): ProviderPreset {
  const found = id ? PRESETS_BY_ID.get(id) : undefined;
  // PROVIDER_PRESETS is a const, non-empty literal — the bang is safe.
  return found ?? PROVIDER_PRESETS[0]!;
}

/** Tailwind classes for the monogram tile, keyed by ProviderTint. The
 *  shades are pegged to the Mocha-graphite range — soft fills, never loud. */
export const TINT_CLASSES: Record<ProviderTint, { bg: string; fg: string; ring: string }> = {
  teal:    { bg: 'bg-teal-500/[0.12]',    fg: 'text-teal-200',    ring: 'ring-teal-400/25' },
  amber:   { bg: 'bg-amber-500/[0.14]',   fg: 'text-amber-200',   ring: 'ring-amber-400/25' },
  sky:     { bg: 'bg-sky-500/[0.12]',     fg: 'text-sky-200',     ring: 'ring-sky-400/25' },
  indigo:  { bg: 'bg-indigo-500/[0.14]',  fg: 'text-indigo-200',  ring: 'ring-indigo-400/25' },
  violet:  { bg: 'bg-violet-500/[0.14]',  fg: 'text-violet-200',  ring: 'ring-violet-400/25' },
  rose:    { bg: 'bg-rose-500/[0.12]',    fg: 'text-rose-200',    ring: 'ring-rose-400/25' },
  emerald: { bg: 'bg-emerald-500/[0.12]', fg: 'text-emerald-200', ring: 'ring-emerald-400/25' },
  orange:  { bg: 'bg-orange-500/[0.12]',  fg: 'text-orange-200',  ring: 'ring-orange-400/25' },
  red:     { bg: 'bg-red-500/[0.12]',     fg: 'text-red-200',     ring: 'ring-red-400/25' },
  cyan:    { bg: 'bg-cyan-500/[0.12]',    fg: 'text-cyan-200',    ring: 'ring-cyan-400/25' },
  fuchsia: { bg: 'bg-fuchsia-500/[0.12]', fg: 'text-fuchsia-200', ring: 'ring-fuchsia-400/25' },
  lime:    { bg: 'bg-lime-500/[0.12]',    fg: 'text-lime-200',    ring: 'ring-lime-400/25' },
  slate:   { bg: 'bg-slate-400/[0.12]',   fg: 'text-slate-200',   ring: 'ring-slate-300/25' },
  sage:    { bg: 'bg-emerald-400/10',     fg: 'text-emerald-100', ring: 'ring-emerald-300/20' },
  neutral: { bg: 'bg-white/[0.06]',       fg: 'text-fg-base',     ring: 'ring-white/15' },
};
