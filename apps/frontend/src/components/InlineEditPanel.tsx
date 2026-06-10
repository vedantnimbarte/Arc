import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Sparkles, CornerDownLeft, X, Loader2, Check, RotateCcw } from 'lucide-react';
import { llmStream } from '../lib/tauri';
import {
  buildInlineEditMessages,
  isUsableInstruction,
  lineDiff,
  stripCodeFence,
  type DiffLine,
} from '../lib/inlineEdit';
import { useActivePreset, useActiveProviderConfig } from '../state/settings';
import { cn } from '../lib/cn';

/** A live inline-edit session: the selection range being rewritten plus the
 *  viewport anchor used to position the floating panel. */
export interface InlineSession {
  from: number;
  to: number;
  code: string;
  anchor: { left: number; top: number } | null;
}

type Phase = 'input' | 'streaming' | 'review' | 'error';

interface Props {
  session: InlineSession;
  view: EditorView;
  filePath: string;
  language: string | null;
  onClose: () => void;
}

const PANEL_WIDTH = 440;

/**
 * Floating ⌘K inline-edit panel. The user types an instruction, the selected
 * code is streamed through the active chat provider, and the result is shown
 * as a line-level diff with Accept / Discard. Accepting dispatches a single
 * CodeMirror transaction replacing the original selection.
 */
export function InlineEditPanel({ session, view, filePath, language, onClose }: Props) {
  const preset = useActivePreset();
  const cfg = useActiveProviderConfig();
  const [phase, setPhase] = useState<Phase>('input');
  const [instruction, setInstruction] = useState('');
  const [streamed, setStreamed] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Cancel fn for an in-flight stream, so Esc / unmount tears it down. */
  const cancelRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Tear down any in-flight stream when the panel unmounts.
  useEffect(() => {
    return () => {
      void cancelRef.current?.();
    };
  }, []);

  const close = () => {
    void cancelRef.current?.();
    cancelRef.current = null;
    onClose();
  };

  const submit = async () => {
    if (!isUsableInstruction(instruction)) return;
    if (preset.needsApiKey && !cfg.apiKey) {
      setError(`Set an API key for ${preset.label} in Settings to use inline edit.`);
      setPhase('error');
      return;
    }
    if (!cfg.model) {
      setError(`Pick a model for ${preset.label} in Settings to use inline edit.`);
      setPhase('error');
      return;
    }

    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const { system, messages } = buildInlineEditMessages({
      code: session.code,
      instruction,
      fileName,
      language,
    });

    setStreamed('');
    setError('');
    setPhase('streaming');
    let acc = '';
    try {
      cancelRef.current = await llmStream(
        {
          id: crypto.randomUUID(),
          provider: preset.kind,
          model: cfg.model,
          messages,
          system,
          api_key: cfg.apiKey || undefined,
          base_url: cfg.baseUrl || undefined,
          // Deterministic edits — we want the most likely rewrite, not variety.
          temperature: 0,
        },
        (chunk) => {
          if (chunk.text) {
            acc += chunk.text;
            setStreamed(acc);
          }
        },
        (ev) => {
          cancelRef.current = null;
          if (ev.error) {
            setError(ev.error);
            setPhase('error');
            return;
          }
          if (ev.cancelled) return;
          const cleaned = stripCodeFence(acc);
          setResult(cleaned);
          setPhase('review');
        },
      );
    } catch (err) {
      setError(String(err));
      setPhase('error');
    }
  };

  const accept = () => {
    view.dispatch({
      changes: { from: session.from, to: session.to, insert: result },
      selection: { anchor: session.from + result.length },
    });
    view.focus();
    onClose();
  };

  const retry = () => {
    setResult('');
    setStreamed('');
    setPhase('input');
    queueMicrotask(() => inputRef.current?.focus());
  };

  // Anchor under the selection; clamp to keep the panel on-screen.
  const left = session.anchor
    ? Math.min(session.anchor.left, window.innerWidth - PANEL_WIDTH - 16)
    : 16;
  const top = session.anchor ? session.anchor.top + 6 : 64;

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border-hairline bg-bg-chrome/95 shadow-2xl backdrop-blur-xl"
      style={{ left: Math.max(8, left), top, width: PANEL_WIDTH }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-2">
        <Sparkles size={13} strokeWidth={2} className="text-accent" />
        <span className="font-display text-[12px] font-medium tracking-tight text-fg-base">
          Edit with AI
        </span>
        <span className="font-mono text-[10px] text-fg-subtle">
          {preset.label} · {cfg.model || 'no model'}
        </span>
        <button
          onClick={close}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-white/[0.08] hover:text-fg-base"
          aria-label="Close inline edit"
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>

      {/* Instruction input */}
      {(phase === 'input' || phase === 'error') && (
        <div className="flex flex-col gap-2 p-3">
          <textarea
            ref={inputRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder="Describe the change… (e.g. add error handling, convert to async)"
            className="w-full resize-none rounded-md border border-border-hairline bg-black/20 px-2.5 py-2 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/50 focus:outline-none"
          />
          {phase === 'error' && (
            <p className="font-mono text-[11px] leading-relaxed text-status-err">{error}</p>
          )}
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-fg-subtle">
              {countLines(session.code)} line{countLines(session.code) === 1 ? '' : 's'} selected
            </span>
            <button
              onClick={() => void submit()}
              disabled={!isUsableInstruction(instruction)}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-md px-2.5 font-display text-[11px] font-medium tracking-tight transition-colors duration-150',
                isUsableInstruction(instruction)
                  ? 'surface-silver active:scale-[0.97]'
                  : 'bg-white/[0.05] text-fg-subtle',
              )}
            >
              <CornerDownLeft size={11} strokeWidth={2.2} />
              Generate
            </button>
          </div>
        </div>
      )}

      {/* Streaming */}
      {phase === 'streaming' && (
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
            <Loader2 size={12} className="animate-spin text-accent" />
            Generating edit…
          </div>
          <pre className="max-h-48 overflow-auto rounded-md border border-border-hairline bg-black/20 p-2 font-mono text-[11px] leading-relaxed text-fg-muted">
            {streamed || '…'}
          </pre>
          <button
            onClick={close}
            className="self-end font-mono text-[10px] text-fg-subtle hover:text-fg-base"
          >
            cancel
          </button>
        </div>
      )}

      {/* Review (diff + accept/discard) */}
      {phase === 'review' && (
        <div className="flex flex-col gap-2 p-3">
          <DiffPreview diff={lineDiff(session.code, result)} />
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={retry}
              className="flex h-6 items-center gap-1 rounded-md px-2 font-display text-[11px] font-medium tracking-tight text-fg-muted hover:bg-white/[0.08] hover:text-fg-base"
            >
              <RotateCcw size={11} strokeWidth={2.2} />
              retry
            </button>
            <button
              onClick={close}
              className="flex h-6 items-center gap-1 rounded-md px-2 font-display text-[11px] font-medium tracking-tight text-fg-muted hover:bg-white/[0.08] hover:text-fg-base"
            >
              discard
            </button>
            <button
              onClick={accept}
              className="flex h-6 items-center gap-1 rounded-md bg-accent/20 px-2.5 font-display text-[11px] font-medium tracking-tight text-accent transition-colors duration-150 hover:bg-accent/30"
            >
              <Check size={11} strokeWidth={2.4} />
              accept
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffPreview({ diff }: { diff: DiffLine[] }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-md border border-border-hairline bg-black/20 font-mono text-[11px] leading-relaxed">
      {diff.map((line, i) => (
        <div
          key={i}
          className={cn(
            'px-2 py-px',
            line.op === 'add' && 'bg-status-ok/15 text-status-ok',
            line.op === 'del' && 'bg-status-err/15 text-status-err',
            line.op === 'same' && 'text-fg-muted',
          )}
        >
          <span className="mr-1.5 select-none opacity-60">
            {line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '}
          </span>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function countLines(s: string): number {
  return s.split('\n').length;
}
