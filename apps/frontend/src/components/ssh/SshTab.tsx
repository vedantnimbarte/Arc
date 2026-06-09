import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  isTauri,
  onSshExit,
  sshResize,
  sshWrite,
} from '../../lib/tauri';
import { useSettings } from '../../state/settings';
import { useSsh } from '../../state/ssh';
import { useWorkspace } from '../../state/workspace';
import { getFont, resolveActiveTheme } from '../../themes';
import { SshConnectingOverlay } from './SshConnectingOverlay';
import { SshErrorCard } from './SshErrorCard';
import { LogDrawerToggle, SshSessionLogDrawer } from './SshSessionLogDrawer';

interface SshTabProps {
  /** Tab id — stable identifier used by the parent layout. */
  sessionKey: string;
  /** SSH host id this tab is bound to (Tab.sshHostId). */
  hostId: string;
}

/** A workspace tab whose PTY is an SSH channel rather than a local shell.
 *  Reuses xterm.js + the same theme/font subscriptions Terminal.tsx uses,
 *  but the data/IO adapter is `ssh_*` instead of `pty_*`, and the surface
 *  is overlaid with `<SshConnectingOverlay>` until the handshake finishes
 *  (or `<SshErrorCard>` if it fails). */
export function SshTab({ sessionKey, hostId }: SshTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const host = useSsh((s) => s.hosts.find((h) => h.id === hostId) ?? null);
  const connect = useSsh((s) => s.connect);
  const disconnect = useSsh((s) => s.disconnect);

  // Pull the live session id (if any) from the workspace tab record so
  // remounts (e.g. tab moved across panes) re-bind to the same session.
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === sessionKey) ?? null);
  const sessionId = tab?.sshSessionId ?? null;
  const setTabSshSessionId = useWorkspace((s) => s.setTabSshSessionId);
  const removeTab = useWorkspace((s) => s.closeTab);

  const session = useSsh((s) => (sessionId ? s.sessions[sessionId] ?? null : null));
  const status = session?.status ?? 'idle';

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // Stable host meta for the connecting overlay.
  const hostLine = useMemo(
    () => (host ? `${host.username}@${host.host}:${host.port}` : ''),
    [host],
  );
  const hostName = host?.name ?? 'ssh';

  // ─── xterm + SSH plumbing ────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!host) return;

    let unlistens: Array<() => void> = [];
    let disposed = false;
    let currentSessionId: string | null = null;

    const initialSettings = useSettings.getState();
    const initialFont = getFont(initialSettings.fontId);
    const initialTheme = resolveActiveTheme(initialSettings.appearance, initialSettings.themeId);

    const term = new XTerm({
      fontFamily: initialFont.stack,
      fontSize: initialSettings.fontSize,
      fontWeight: '400',
      fontWeightBold: '600',
      lineHeight: 1.32,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 10_000,
      allowTransparency: true,
      smoothScrollDuration: 80,
      theme: initialTheme.xterm,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    while (container.firstChild) container.removeChild(container.firstChild);
    term.open(container);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    };
    safeFit();

    const decoder = new TextDecoder('utf-8');

    const boot = async () => {
      if (!isTauri) {
        term.writeln(
          '\x1b[38;2;212;214;220m  arc \x1b[0m\x1b[2mrunning outside Tauri — SSH disabled.\x1b[0m',
        );
        return;
      }
      try {
        // Shell output arrives on a per-connect raw channel wired up inside
        // `connect` before the command runs (no early-output race). Guard on
        // `disposed` so a late chunk can't write into a torn-down terminal.
        const id = await connect(hostId, term.cols, term.rows, (chunk) => {
          if (disposed) return;
          term.write(decoder.decode(chunk, { stream: true }));
        });
        if (disposed) {
          void useSsh.getState().disconnect(id).catch(() => {});
          return;
        }
        currentSessionId = id;
        setTabSshSessionId(sessionKey, id);

        unlistens.push(
          await onSshExit(id, (code) => {
            term.writeln(`\r\n\x1b[38;2;99;99;102m[session ended · ${code ?? '?'}]\x1b[0m`);
          }),
        );

        term.onData((data) => {
          if (currentSessionId) sshWrite(currentSessionId, data).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          if (currentSessionId) sshResize(currentSessionId, cols, rows).catch(() => {});
        });
      } catch (err) {
        term.writeln(`\x1b[38;2;255;69;58m  failed to connect: ${err}\x1b[0m`);
      }
    };

    void boot();

    // Live-update font + theme when the user changes them in Settings.
    const unsubAppearance = useSettings.subscribe((s, prev) => {
      if (
        s.fontId !== prev.fontId ||
        s.fontSize !== prev.fontSize ||
        s.appearance !== prev.appearance ||
        s.themeId !== prev.themeId
      ) {
        try {
          term.options.fontFamily = getFont(s.fontId).stack;
          term.options.fontSize = s.fontSize;
          term.options.theme = resolveActiveTheme(s.appearance, s.themeId).xterm;
          safeFit();
        } catch {
          /* term may be disposed */
        }
      }
    });

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(container);

    const hostEl = container.parentElement;
    const onHostShown = () => {
      requestAnimationFrame(() => {
        if (disposed) return;
        safeFit();
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          /* terminal may be disposed */
        }
      });
    };
    hostEl?.addEventListener('arc:host-shown', onHostShown);

    return () => {
      disposed = true;
      ro.disconnect();
      hostEl?.removeEventListener('arc:host-shown', onHostShown);
      unsubAppearance();
      unlistens.forEach((u) => u());
      if (currentSessionId) void useSsh.getState().disconnect(currentSessionId).catch(() => {});
      setTabSshSessionId(sessionKey, undefined);
      try {
        term.dispose();
      } catch {
        /* addon cleanup races */
      }
    };
  }, [sessionKey, hostId, retryNonce, connect, setTabSshSessionId, host]);

  if (!host) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-base">
        <div className="font-mono text-[11px] text-fg-subtle">
          host not found — open the SSH panel to add or pick one
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-bg-base">
      <div className="flex items-center justify-between border-b border-border-subtle bg-bg-chrome/40 px-3 py-1">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor:
                status === 'connected'
                  ? 'rgb(58 210 138)'
                  : status === 'error'
                    ? 'rgb(255 82 82)'
                    : 'rgb(200 202 208)',
            }}
          />
          <span className="font-display text-[11px] text-fg-base">{hostName}</span>
          <span className="font-mono text-[10px] text-fg-subtle">{hostLine}</span>
        </div>
        <div className="flex items-center gap-1">
          <LogDrawerToggle open={drawerOpen} onToggle={() => setDrawerOpen((v) => !v)} />
          {(status === 'connected' || status === 'connecting') && sessionId && (
            <button
              type="button"
              onClick={() => disconnect(sessionId)}
              className="rounded px-1.5 py-1 font-mono text-[9px] uppercase tracking-widest2 text-status-err transition hover:bg-bg-hover"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="selectable absolute inset-0"
          data-session={sessionKey}
        />

        {status === 'connecting' && sessionId && (
          <SshConnectingOverlay
            sessionId={sessionId}
            hostName={hostName}
            hostLine={hostLine}
            onCancel={() => {
              if (sessionId) void disconnect(sessionId);
              removeTab(sessionKey);
            }}
          />
        )}

        {status === 'error' && session?.error && (
          <SshErrorCard
            hostName={hostName}
            message={session.error}
            onRetry={() => {
              if (sessionId) void disconnect(sessionId);
              setTabSshSessionId(sessionKey, undefined);
              setRetryNonce((n) => n + 1);
            }}
            onClose={() => removeTab(sessionKey)}
          />
        )}
      </div>

      {drawerOpen && sessionId && (
        <SshSessionLogDrawer
          sessionId={sessionId}
          hostName={hostName}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
