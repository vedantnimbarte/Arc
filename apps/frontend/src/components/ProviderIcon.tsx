// Brand-aware icon component for provider presets.
//
// We pull SVG path data from `simple-icons` for the providers it ships
// (Anthropic, Gemini, DeepSeek, Mistral, Perplexity, Ollama, MoonshotAI,
// MiniMax, OpenRouter). For names simple-icons doesn't have yet —
// OpenAI, xAI, the OpenAI-Compatible custom slot — we inline geometric
// marks. Anything still without a mark falls back to the existing
// monogram letter so the tile never looks empty.
//
// Rendering: the SVG path uses `currentColor` so the tile's `tint.fg`
// drives its colour, matching the existing aesthetic instead of pulling
// in each brand's RGB.

import {
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siMinimax,
  siMistralai,
  siMoonshotai,
  siOllama,
  siOpenrouter,
  siPerplexity,
  type SimpleIcon,
} from 'simple-icons';
import { cn } from '../lib/cn';
import { TINT_CLASSES, getPreset, type ProviderPreset } from '../state/providers';

interface BrandPath {
  path: string;
  viewBox?: string;
}

/** Inline marks for presets simple-icons doesn't ship. */
const INLINE: Record<string, BrandPath> = {
  // OpenAI six-loop hex knot — the canonical brand mark.
  openai: {
    path: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  },
  // xAI stylized X — two crossed strokes.
  xai: {
    path: 'M3.005 4.5l5.766 7.5L2.4 19.5h2.643l4.948-6.428L14.95 19.5h5.045L13.93 11.6 19.99 4.5h-2.642l-4.354 5.74L8.05 4.5H3.005zM6.07 6.5h.85l11.04 11h-.85L6.07 6.5z',
  },
  // Groq lightning bolt — a stylized energy mark.
  groq: {
    path: 'M14.2 2L4 13.5h6.4L9.8 22 20 10.5h-6.4L14.2 2z',
  },
  // Cohere "coral" — three nested circles forming the C arc.
  cohere: {
    path: 'M8.5 19.5a7.5 7.5 0 1 1 7.5-7.5 1.5 1.5 0 0 1-3 0 4.5 4.5 0 1 0-4.5 4.5h.5a1.5 1.5 0 0 1 0 3h-.5zM12 13.5a1.5 1.5 0 0 1 0-3h7a1.5 1.5 0 0 1 0 3h-7zM3.5 13.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  },
  // Fireworks four-point starburst.
  fireworks: {
    path: 'M12 1.5L13.6 9.2 21.5 11l-7.9 1.7L12 20.5l-1.6-7.8L2.5 11l7.9-1.8L12 1.5z',
  },
  // LM Studio — monitor outline.
  lmstudio: {
    path: 'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z',
  },
  // Together AI — linked rings.
  together: {
    path: 'M8 12a4 4 0 1 1 8 0 4 4 0 0 1-8 0zm-3 0a7 7 0 0 0 11.95 4.95l2.12 2.12 1.42-1.41-2.12-2.12A7 7 0 1 0 5 12zm3-1a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm8-2a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM12 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 8a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  },
  // Cerebras — interlocking C shapes.
  cerebras: {
    path: 'M12 3a9 9 0 0 0-7.94 4.74 1.5 1.5 0 0 0 2.65 1.4A6 6 0 0 1 18 12a1.5 1.5 0 0 0 3 0A9 9 0 0 0 12 3zm0 18a9 9 0 0 0 7.94-4.74 1.5 1.5 0 0 0-2.65-1.4A6 6 0 0 1 6 12a1.5 1.5 0 0 0-3 0 9 9 0 0 0 9 9z',
  },
  // Azure OpenAI — Azure-style A triangle.
  'azure-openai': {
    path: 'M11.3 5.5L4 18.5h5.2l1.6-2.7L14 18.5h5.5l-7-13h-1.2zm.5 4.2l2.7 4.6h-5l-1 1.7-1.7-2.9 5-3.4z',
  },
  // OpenAI-Compatible custom slot — plus mark in a thin square.
  custom: {
    path: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4z',
  },
};

function brandFromSimpleIcons(presetId: string): SimpleIcon | undefined {
  switch (presetId) {
    case 'anthropic':
      return siAnthropic;
    case 'gemini':
      return siGooglegemini;
    case 'deepseek':
      return siDeepseek;
    case 'mistral':
      return siMistralai;
    case 'perplexity':
      return siPerplexity;
    case 'ollama':
      return siOllama;
    case 'kimi':
      return siMoonshotai;
    case 'minimax':
      return siMinimax;
    case 'openrouter':
      return siOpenrouter;
    default:
      return undefined;
  }
}

/** Resolve a brand path for `presetId`, or `null` if the preset should
 *  fall back to its monogram letter. */
function resolveBrand(presetId: string): BrandPath | null {
  const inline = INLINE[presetId];
  if (inline) return inline;
  const si = brandFromSimpleIcons(presetId);
  if (si) return { path: si.path };
  return null;
}

interface Props {
  preset: ProviderPreset;
  /** Tile size in px. The SVG is centered inside this square. */
  size?: number;
  /** Letter size when falling back to a monogram. */
  monogramSize?: number;
  className?: string;
  dimmed?: boolean;
}

/** Tile + provider icon. Replaces the old monogram-only treatment in row
 *  / detail headers / picker triggers. */
export function ProviderIcon({
  preset,
  size = 22,
  monogramSize,
  className,
  dimmed,
}: Props) {
  const tint = TINT_CLASSES[preset.tint];
  const brand = resolveBrand(preset.id);

  const monoFontPx = monogramSize ?? Math.round(size * 0.5);

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md ring-1 ring-inset transition-opacity',
        tint.bg,
        tint.fg,
        tint.ring,
        dimmed && 'opacity-50',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {brand ? (
        <svg
          viewBox={brand.viewBox ?? '0 0 24 24'}
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          fill="currentColor"
          aria-hidden
        >
          <path d={brand.path} />
        </svg>
      ) : (
        <span
          className="font-display font-semibold"
          style={{ fontSize: monoFontPx, lineHeight: 1 }}
        >
          {preset.monogram}
        </span>
      )}
    </span>
  );
}

/** Same icon but unwrapped — no tile chrome. Useful inside compact pills
 *  that already have their own border / background. */
export function ProviderIconBare({
  presetId,
  size = 12,
  className,
}: {
  presetId: string;
  size?: number;
  className?: string;
}) {
  const preset = getPreset(presetId);
  if (!preset) return null;
  const tint = TINT_CLASSES[preset.tint];
  const brand = resolveBrand(presetId);
  if (!brand) {
    return (
      <span
        className={cn('font-display font-semibold leading-none', tint.fg, className)}
        style={{ fontSize: Math.round(size * 0.85) }}
        aria-hidden
      >
        {preset.monogram}
      </span>
    );
  }
  return (
    <svg
      viewBox={brand.viewBox ?? '0 0 24 24'}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      className={cn(tint.fg, className)}
    >
      <path d={brand.path} />
    </svg>
  );
}
