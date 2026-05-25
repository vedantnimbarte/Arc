import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  RotateCw,
  Globe,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { useWorkspace } from '../state/workspace';
import { detectFramework, FALLBACK_PORTS, type FrameworkHit } from '../lib/framework';
import { networkProbePort, shellOpenExternal } from '../lib/tauri';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface Props {
  tabId: string;
}

/**
 * Embedded SPA preview pane. Renders a URL bar over an iframe so the user can
 * view a local dev server (Vite/Next/Svelte/Astro/etc.) without leaving ARC.
 *
 * State design:
 * - `inputUrl` is the controlled <input>; updates per keystroke without
 *   reloading the iframe.
 * - `loadedUrl` is what the iframe actually points at; only updated on
 *   submit (Enter / Go / port pick) and pushed back to the workspace store
 *   so the URL persists across restarts.
 * - `iframeKey` is bumped on refresh to force a full remount (re-evaluating
 *   src even when the URL didn't change).
 */
export function Preview({ tabId }: Props) {
  const previewUrl = useWorkspace(
    (s) => s.tabs.find((t) => t.id === tabId)?.previewUrl ?? '',
  );
  const setPreviewUrl = useWorkspace((s) => s.setPreviewUrl);

  const [inputUrl, setInputUrl] = useState(previewUrl);
  const [loadedUrl, setLoadedUrl] = useState(previewUrl);
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Reflect store→local on external updates (e.g. tab restore on hydrate).
  // Guarded so user keystrokes aren't clobbered by the store mirror.
  useEffect(() => {
    if (previewUrl !== loadedUrl) {
      setInputUrl(previewUrl);
      setLoadedUrl(previewUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewUrl]);

  const commit = useCallback(
    (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      setInputUrl(url);
      setLoadedUrl(url);
      setPreviewUrl(tabId, url);
    },
    [tabId, setPreviewUrl],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      commit(inputUrl);
    },
    [commit, inputUrl],
  );

  const refresh = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  // Same-origin only — fine for localhost dev servers. Cross-origin requests
  // throw SecurityError; we swallow that silently.
  const navIframe = useCallback((dir: 'back' | 'forward') => {
    try {
      const w = iframeRef.current?.contentWindow;
      if (!w) return;
      if (dir === 'back') w.history.back();
      else w.history.forward();
    } catch {
      /* cross-origin frame access denied — expected for external URLs */
    }
  }, []);

  const openExternal = useCallback(() => {
    if (!loadedUrl) return;
    if (isTauri) {
      void shellOpenExternal(loadedUrl).catch((err) =>
        console.error('[Preview] failed to open in browser:', err),
      );
    } else {
      // Web preview (pnpm dev) — fall back to the standard window.open path.
      window.open(loadedUrl, '_blank', 'noopener,noreferrer');
    }
  }, [loadedUrl]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex h-full w-full flex-col bg-base">
      {/* URL bar */}
      <form
        onSubmit={onSubmit}
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border-hairline px-2"
      >
        <IconButton
          ariaLabel="Back"
          title="Back"
          onClick={() => navIframe('back')}
          disabled={!loadedUrl}
        >
          <ArrowLeft size={13} strokeWidth={2.1} />
        </IconButton>
        <IconButton
          ariaLabel="Forward"
          title="Forward"
          onClick={() => navIframe('forward')}
          disabled={!loadedUrl}
        >
          <ArrowRight size={13} strokeWidth={2.1} />
        </IconButton>
        <IconButton
          ariaLabel="Refresh"
          title="Refresh"
          onClick={refresh}
          disabled={!loadedUrl}
        >
          <RotateCw size={13} strokeWidth={2.1} />
        </IconButton>

        <div className="flex flex-1 items-center gap-1.5 rounded-md border border-white/[0.05] bg-black/[0.22] px-2 py-1 focus-within:border-accent/40 focus-within:shadow-focus">
          <Globe size={11} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          <input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="http://localhost:5173"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="selectable min-w-0 flex-1 bg-transparent font-mono text-[11.5px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
          />
          <button
            ref={pickerAnchorRef}
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-label="Detect ports"
            title="Detect ports"
            className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-white/[0.10] hover:text-fg-base"
          >
            <ChevronDown size={10} strokeWidth={2.4} />
          </button>
        </div>

        <IconButton
          ariaLabel="Open in system browser"
          title="Open in system browser"
          onClick={openExternal}
          disabled={!loadedUrl}
        >
          <ExternalLink size={12} strokeWidth={2.1} />
        </IconButton>
      </form>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {loadedUrl ? (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            src={loadedUrl}
            title="Preview"
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          />
        ) : (
          <EmptyState onPickPort={() => setPickerOpen(true)} />
        )}
      </div>

      {pickerOpen && (
        <PortPicker
          anchor={pickerAnchorRef.current}
          onClose={() => setPickerOpen(false)}
          onPick={(port) => {
            commit(`http://localhost:${port}`);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── PortPicker ───────────────────────────────────────────────────────────────

interface PortPickerProps {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (port: number) => void;
}

function PortPicker({ anchor, onClose, onPick }: PortPickerProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [hit, setHit] = useState<FrameworkHit | null>(null);
  const [livePorts, setLivePorts] = useState<Set<number>>(new Set());
  const [probing, setProbing] = useState(true);

  // Anchor under the chevron, flipping above when there isn't enough room.
  useLayoutEffect(() => {
    if (!anchor || !menuRef.current) return;
    const a = anchor.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = a.right - m.width;
    if (left < 8) left = 8;
    if (left + m.width > vw - 8) left = vw - m.width - 8;
    let top = a.bottom + 4;
    if (top + m.height > vh - 8) top = a.top - m.height - 4;
    setPos({ left, top });
  }, [anchor, hit]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const detected = await detectFramework();
      if (cancelled) return;
      setHit(detected);
      // Probe detected ports + the common fallback set so the user always
      // has a chance to see something live even if framework detection misses.
      const candidates = Array.from(new Set([...detected.ports, ...FALLBACK_PORTS]));
      const results = await Promise.all(
        candidates.map(async (p) => [p, await networkProbePort(p)] as const),
      );
      if (cancelled) return;
      setLivePorts(new Set(results.filter(([, alive]) => alive).map(([p]) => p)));
      setProbing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          anchor && !anchor.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onMouse, { capture: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse, { capture: true });
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  const detectedPorts = hit?.ports ?? [];
  const live = useMemo(
    () => [...livePorts].sort((a, b) => a - b),
    [livePorts],
  );
  const defaults = useMemo(
    () => [
      ...detectedPorts.filter((p) => !livePorts.has(p)),
      ...FALLBACK_PORTS.filter(
        (p) => !livePorts.has(p) && !detectedPorts.includes(p),
      ),
    ],
    [detectedPorts, livePorts],
  );

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Detected ports"
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="material-sheet z-50 w-60 animate-popover-in overflow-hidden rounded-md p-1.5 shadow-sheet ring-1 ring-white/10"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="font-display text-[10px] uppercase tracking-wider text-fg-subtle/80">
          {hit ? hit.framework : 'Detecting…'}
        </span>
        {probing && (
          <span className="font-display text-[9.5px] text-fg-subtle">probing…</span>
        )}
      </div>

      {live.length > 0 && (
        <>
          <div className="my-0.5 border-t border-white/[0.05]" />
          <div className="px-2 pb-0.5 pt-1 font-display text-[9px] uppercase tracking-wider text-fg-subtle/70">
            Live
          </div>
          {live.map((p) => (
            <PortRow key={p} port={p} live onClick={() => onPick(p)} />
          ))}
        </>
      )}

      {defaults.length > 0 && (
        <>
          <div className="my-0.5 border-t border-white/[0.05]" />
          <div className="px-2 pb-0.5 pt-1 font-display text-[9px] uppercase tracking-wider text-fg-subtle/70">
            Common
          </div>
          {defaults.map((p) => (
            <PortRow key={p} port={p} live={false} onClick={() => onPick(p)} />
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}

function PortRow({
  port,
  live,
  onClick,
}: {
  port: number;
  live: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11.5px] transition-colors hover:bg-white/[0.06]',
        live ? 'text-fg-base' : 'text-fg-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          live ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]' : 'bg-white/[0.18]',
        )}
      />
      <span className="flex-1">localhost:{port}</span>
      {live && (
        <span className="font-display text-[9.5px] uppercase tracking-wider text-emerald-300/80">
          live
        </span>
      )}
    </button>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function IconButton({
  children,
  onClick,
  disabled,
  ariaLabel,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function EmptyState({ onPickPort }: { onPickPort: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center">
      <Globe size={28} strokeWidth={1.5} className="text-fg-subtle" />
      <div className="space-y-1">
        <p className="font-display text-[13px] text-fg-base">No URL loaded</p>
        <p className="max-w-xs font-display text-[11.5px] leading-relaxed text-fg-muted">
          Type a URL above and press Enter, or pick a running dev-server port.
        </p>
      </div>
      <button
        onClick={onPickPort}
        className="rounded-md bg-white/[0.06] px-3 py-1.5 font-display text-[11.5px] text-fg-base transition-colors hover:bg-white/[0.10]"
      >
        Detect ports
      </button>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Accept bare `localhost:5173`, `:5173`, or `5173` for ergonomic typing; prefix
// http:// when the user didn't include a scheme. Rejects empties and obvious
// garbage; the iframe will surface a real error if the URL doesn't load.
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed; // other schemes (file://, etc.)
  if (/^:\d+$/.test(trimmed)) return `http://localhost${trimmed}`;
  if (/^\d{2,5}$/.test(trimmed)) return `http://localhost:${trimmed}`;
  return `http://${trimmed}`;
}
