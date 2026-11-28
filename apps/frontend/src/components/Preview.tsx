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
import { Button, EmptyState } from './ui';

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
  /** The local address that didn't answer, or null when it did (or wasn't checked). */
  const [down, setDown] = useState<LocalTarget | null>(null);
  /** History only works when the frame is same-origin; a dev server on its
   *  own port never is, so Back/Forward stay off rather than doing nothing. */
  const [canNav, setCanNav] = useState(false);
  const probeSeq = useRef(0);

  // Probe local addresses before showing them: a dead port otherwise renders
  // as a blank white frame with no hint why. Remote hosts are never probed.
  const probe = useCallback(async (url: string) => {
    const seq = ++probeSeq.current;
    const target = isTauri ? localTarget(url) : null;
    const alive = target ? await networkProbePort(target.port).catch(() => true) : true;
    if (seq === probeSeq.current) setDown(alive ? null : target);
  }, []);

  useEffect(() => {
    if (loadedUrl) void probe(loadedUrl);
    else setDown(null);
  }, [loadedUrl, probe]);

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
      // Re-check even when the URL didn't change: Enter after starting the
      // server should clear "Nothing is running".
      void probe(url);
    },
    [tabId, setPreviewUrl, probe],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      commit(inputUrl);
    },
    [commit, inputUrl],
  );

  const refresh = useCallback(() => {
    if (loadedUrl) void probe(loadedUrl);
    setIframeKey((k) => k + 1);
  }, [loadedUrl, probe]);

  const onFrameLoad = useCallback(() => {
    try {
      // Throws for a cross-origin frame.
      void iframeRef.current?.contentWindow?.location.href;
      setCanNav(true);
    } catch {
      setCanNav(false);
    }
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
    <div className="flex h-full w-full flex-col bg-bg-base">
      {/* URL bar */}
      <form
        onSubmit={onSubmit}
        className="flex h-10 shrink-0 items-center gap-1 bg-bg-chrome px-2"
      >
        <IconButton
          ariaLabel="Back"
          title="Back"
          onClick={() => navIframe('back')}
          disabled={!loadedUrl || !!down || !canNav}
        >
          <ArrowLeft size={13} strokeWidth={2.1} />
        </IconButton>
        <IconButton
          ariaLabel="Forward"
          title="Forward"
          onClick={() => navIframe('forward')}
          disabled={!loadedUrl || !!down || !canNav}
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

        <div className="flex flex-1 items-center gap-1.5 rounded-md bg-bg-panel px-2 py-1 focus-within:shadow-focus">
          <Globe size={11} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          <input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="http://localhost:5173"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="selectable min-w-0 flex-1 bg-transparent font-mono text-xs tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
          />
          <button
            ref={pickerAnchorRef}
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-label="Find running servers"
            title="Find running servers"
            className="flex h-4 w-4 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg-base"
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
        {down ? (
          <EmptyState
            icon={Globe}
            title={`Nothing is running at ${down.host}:${down.port}`}
            body="Start your dev server in a terminal (for example npm run dev), then press Refresh."
          >
            <Button variant="primary" icon={RotateCw} onClick={refresh}>
              Refresh
            </Button>
          </EmptyState>
        ) : loadedUrl ? (
          // White, like a browser tab: pages that set no background expect it.
          <iframe
            ref={iframeRef}
            key={iframeKey}
            src={loadedUrl}
            title="Preview"
            onLoad={onFrameLoad}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          />
        ) : (
          <EmptyState
            icon={Globe}
            title="Preview your app"
            body="Start your dev server, then pick it here or type its address."
          >
            <Button variant="primary" onClick={() => setPickerOpen(true)}>
              Find running servers
            </Button>
          </EmptyState>
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
      aria-label="Running servers"
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="material-sheet z-50 w-60 animate-popover-in overflow-hidden rounded-md p-1.5 shadow-sheet"
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="font-display text-xs text-fg-muted">
          {!hit ? 'Looking at your project…' : hit.framework === 'Unknown' ? 'Dev servers' : hit.framework}
        </span>
        {probing && <span className="font-display text-2xs text-fg-subtle">Checking…</span>}
      </div>

      {!probing && (
        <>
          <div className="px-2 pb-0.5 pt-2 font-display text-2xs font-medium text-fg-subtle">
            Running now
          </div>
          {live.length === 0 && (
            <div className="px-2 py-1.5 font-display text-xs text-fg-muted">No servers running right now</div>
          )}
          {live.map((p) => (
            <PortRow key={p} port={p} live onClick={() => onPick(p)} />
          ))}
        </>
      )}

      {defaults.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-2 font-display text-2xs font-medium text-fg-subtle">
            Common ports
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
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-surface-2',
        live ? 'text-fg-base' : 'text-fg-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          live ? 'bg-status-ok' : 'bg-surface-3',
        )}
      />
      <span className="flex-1">localhost:{port}</span>
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
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg-base disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface LocalTarget {
  host: string;
  port: number;
}

/** The host and port to probe, for localhost / 127.0.0.1 addresses only. */
function localTarget(url: string): LocalTarget | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : NaN;
  return Number.isFinite(port) ? { host: u.hostname, port } : null;
}

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
