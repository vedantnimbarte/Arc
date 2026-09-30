import { useEffect, useRef, useState } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import {
  ArrowUp,
  Check,
  FileText,
  Image as ImageIcon,
  Paperclip,
  ShieldQuestion,
  Square,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { fsListFiles, isTauri, type ClaudePermissionMode, type FileItem } from '../../lib/tauri';
import type { ClaudeAttachment, ClaudeWindowSession } from '../../state/claudeCode';
import { askText } from '../../state/confirm';
import { useSettings } from '../../state/settings';
import { Select, type SelectOption } from '../Select';
import { MODE_OPTIONS, RISKY_MODES } from './ClaudeSettings';
import { relativeTo } from './ClaudePanel';

type WindowStore = UseBoundStore<StoreApi<ClaudeWindowSession>>;

const CUSTOM = '__custom';

/** Aliases resolve to the newest model of each family, so they never go stale. */
const MODEL_OPTIONS: SelectOption<string>[] = [
  { value: '', label: 'Default', hint: 'Whatever the CLI is configured to use' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

const MODE_LABELS: Record<ClaudePermissionMode, string> = {
  manual: 'Manual',
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};

const WINDOW_MODE_OPTIONS = MODE_OPTIONS.map((o) => ({ ...o, label: MODE_LABELS[o.value] }));

/** Images the API accepts inline. Anything else is read as text. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Raw bytes; base64 adds a third, which lands just under the API's 5 MB. */
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_TEXT_BYTES = 256 * 1024;

/** The `@query` being typed right before the caret, if any. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Turn a picked, pasted or dropped file into an attachment, or say why not. */
async function readAttachment(file: File): Promise<ClaudeAttachment | string> {
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) return `${file.name} is over 3.75 MB`;
    const url = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    return { kind: 'image', name: file.name || 'pasted image', mediaType: file.type, data: url.slice(url.indexOf(',') + 1) };
  }
  if (file.size > MAX_TEXT_BYTES) return `${file.name} is over 256 KB`;
  const text = await file.text();
  if (text.includes('\0')) return `${file.name} isn't a text file or a supported image`;
  return { kind: 'text', name: file.name, text };
}

/**
 * The window's composer — and, while Claude waits on a permission, the
 * approval card. The two share one surface on purpose: the question appears
 * where your hands already are, and you can't start a new prompt past it.
 */
export function ClaudeComposer({ store }: { store: WindowStore }) {
  const cwd = store((s) => s.cwd);
  const model = store((s) => s.model);
  const mode = store((s) => s.permissionMode);
  const streaming = store((s) => s.streaming);
  const pending = store((s) => s.pending);
  const send = store((s) => s.send);
  const cancel = store((s) => s.cancel);
  const ignoreDirs = useSettings((s) => s.searchIgnoreDirs);

  const [text, setText] = useState('');
  const [atts, setAtts] = useState<ClaudeAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [rows, setRows] = useState<FileItem[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const risky = RISKY_MODES.includes(mode);
  const canSend = !streaming && (text.trim().length > 0 || atts.length > 0);

  // File typeahead for `@`, debounced like the file search palette.
  useEffect(() => {
    if (!mention || !cwd || !isTauri) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fsListFiles(cwd, mention.query, 12, ignoreDirs)
        .then((r) => {
          if (!cancelled) {
            setRows(r);
            setSel(0);
          }
        })
        .catch(() => !cancelled && setRows([]));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mention?.query, cwd, ignoreDirs]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncMention = (el: HTMLTextAreaElement) =>
    setMention(mentionAt(el.value, el.selectionStart ?? el.value.length));

  const insertAtCaret = (insert: string, replaceFrom?: number) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const from = replaceFrom ?? caret;
    const pad = from > 0 && !/\s/.test(text[from - 1] ?? ' ') ? ' ' : '';
    const next = `${text.slice(0, from)}${pad}${insert}${text.slice(caret)}`;
    setText(next);
    setMention(null);
    const at = from + pad.length + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };

  const addFiles = async (files: FileList | File[]) => {
    const problems: string[] = [];
    const added: ClaudeAttachment[] = [];
    for (const f of Array.from(files)) {
      const r = await readAttachment(f).catch((e) => `${f.name}: ${String(e)}`);
      if (typeof r === 'string') problems.push(r);
      else added.push(r);
    }
    if (added.length) setAtts((a) => [...a, ...added]);
    setNotice(problems.length ? problems.join(' · ') : null);
  };

  const submit = () => {
    if (!canSend) return;
    const t = text.trim();
    const a = atts;
    setText('');
    setAtts([]);
    setNotice(null);
    setMention(null);
    void send(t, a);
  };

  const pickModel = async (v: string) => {
    if (v !== CUSTOM) {
      store.setState({ model: v });
      return;
    }
    const id = await askText(
      'Use a specific model',
      { label: 'Full model id', value: model, placeholder: 'claude-opus-5-5' },
      'Use',
    );
    if (id !== null) store.setState({ model: id.trim() });
  };

  const modelOptions: SelectOption<string>[] = [
    ...MODEL_OPTIONS,
    // A stored id that isn't an alias shows as itself, so the chip never lies.
    ...(model && !MODEL_OPTIONS.some((o) => o.value === model) ? [{ value: model, label: model }] : []),
    { value: CUSTOM, label: 'Custom…', hint: 'Type a full model id' },
  ];

  if (pending) {
    return (
      <div
        role="group"
        aria-label="Permission request"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            void store.getState().respond(false);
          }
        }}
        className="animate-view-in rounded-window bg-bg-panel p-4 shadow-panel ring-1 ring-status-warn/45"
      >
        <div className="flex items-start gap-2.5">
          <ShieldQuestion size={16} strokeWidth={1.9} className="mt-0.5 shrink-0 text-status-warn" />
          <div className="min-w-0 flex-1">
            <p className="font-display text-base text-fg-base">
              Claude wants to use <span className="font-semibold">{pending.title || pending.tool}</span>
            </p>
            {pending.description && (
              <p className="mt-0.5 font-display text-sm text-fg-muted">{pending.description}</p>
            )}
            {pending.summary && (
              <pre className="selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-scrim-1 px-3 py-2 font-mono text-xs leading-relaxed text-fg-base ring-1 ring-edge-1">
                {pending.summary}
              </pre>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <span className="mr-auto font-display text-2xs text-fg-subtle">Esc to deny</span>
          <button
            type="button"
            onClick={() => void store.getState().respond(false)}
            className="flex h-8 items-center gap-1.5 rounded-md px-3 font-display text-sm text-fg-muted ring-1 ring-edge-2 transition-colors hover:text-status-err hover:ring-status-err/50"
          >
            <X size={13} strokeWidth={2.2} />
            Deny
          </button>
          <button
            type="button"
            // Enter answers: nothing else on screen can take a key right now.
            autoFocus
            onClick={() => void store.getState().respond(true)}
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent-soft px-3 font-display text-sm text-fg-base ring-1 ring-accent/45 transition-transform active:scale-95"
          >
            <Check size={13} strokeWidth={2.2} />
            Allow
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        const types = Array.from(e.dataTransfer.types);
        if (types.includes('arc/path') || types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        const path = e.dataTransfer.getData('arc/path');
        if (path) {
          e.preventDefault();
          insertAtCaret(`@${cwd ? relativeTo(cwd, path) : path} `);
        } else if (e.dataTransfer.files.length) {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }
      }}
      className={cn(
        'relative rounded-window bg-bg-panel shadow-panel ring-1 transition-shadow',
        dragging ? 'ring-accent/60' : risky ? 'ring-status-warn/40' : 'ring-edge-2',
      )}
    >
      {mention && rows.length > 0 && (
        <ul
          role="listbox"
          aria-label="Files"
          className="absolute bottom-full left-3 right-3 mb-2 max-h-64 overflow-y-auto rounded-squircle bg-bg-panel py-1 shadow-sheet ring-1 ring-edge-2 animate-popover-in"
        >
          {rows.map((r, i) => (
            <li key={r.path} role="option" aria-selected={i === sel}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertAtCaret(`@${r.rel} `, mention.start)}
                className={cn(
                  'flex w-full items-baseline gap-2 px-3 py-1.5 text-left',
                  i === sel ? 'bg-surface-3' : 'hover:bg-surface-2',
                )}
              >
                <span className="shrink-0 font-display text-sm text-fg-base">{r.name}</span>
                <span className="min-w-0 truncate font-mono text-2xs text-fg-subtle">{r.rel}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {atts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {atts.map((a, i) => (
            <span
              key={i}
              className="flex max-w-[16rem] items-center gap-1.5 rounded-md bg-surface-2 py-1 pl-2 pr-1 font-mono text-2xs text-fg-muted"
            >
              {a.kind === 'image' ? (
                <ImageIcon size={12} strokeWidth={1.9} className="shrink-0" />
              ) : (
                <FileText size={12} strokeWidth={1.9} className="shrink-0" />
              )}
              <span className="truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => setAtts((all) => all.filter((_, j) => j !== i))}
                aria-label={`Remove ${a.name}`}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg-base"
              >
                <X size={10} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          syncMention(e.target);
        }}
        onSelect={(e) => syncMention(e.currentTarget)}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (mention && rows.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setSel((s) => (s + step + rows.length) % rows.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              insertAtCaret(`@${rows[sel]!.rel} `, mention.start);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        spellCheck={false}
        placeholder={streaming ? 'Claude is working… you can draft the next message' : 'Ask Claude… (@ to mention a file)'}
        aria-label="Message Claude Code"
        className="block max-h-[40vh] min-h-[4.5rem] w-full resize-none bg-transparent px-4 pb-1 pt-3 font-display text-base text-fg-base placeholder:text-fg-subtle focus:outline-none"
      />

      {notice && (
        <p className="px-4 pb-1 font-display text-2xs text-status-warn" role="status">
          {notice}
        </p>
      )}

      <div className="flex items-center gap-1.5 px-2 pb-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach files"
          title="Attach files or images"
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <Paperclip size={14} strokeWidth={1.9} />
        </button>
        <Select
          size="compact"
          ariaLabel="Model"
          value={model}
          options={modelOptions}
          onChange={(v) => void pickModel(v)}
          className="w-auto max-w-[12rem]"
        />
        <Select
          size="compact"
          ariaLabel="Permission mode"
          value={mode}
          options={WINDOW_MODE_OPTIONS}
          onChange={(v) => store.setState({ permissionMode: v })}
          className="w-auto"
        />
        <div className="flex-1" />
        {streaming ? (
          <button
            type="button"
            onClick={() => void cancel()}
            aria-label="Stop this turn"
            title="Stop"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2 text-fg-muted transition-all hover:text-status-err active:scale-95"
          >
            <Square size={12} strokeWidth={2.6} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send to Claude Code"
            title="Send (Enter)"
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-lg transition-all active:scale-95',
              canSend ? 'bg-accent-soft text-fg-base ring-1 ring-accent/45' : 'bg-surface-1 text-fg-subtle',
            )}
          >
            <ArrowUp size={15} strokeWidth={2.3} />
          </button>
        )}
      </div>
    </div>
  );
}
