import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  isTauri,
  onPtyData,
  onPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtyId,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';

interface Props {
  sessionKey: string;
}

// xterm theme — graphite base, platinum cursor + selection. The ANSI palette
// stays close to the macOS Terminal defaults so syntax highlighting in `ls`,
// `git`, etc. still reads correctly; only the accent + cursor shift to silver.
const THEME = {
  background: '#161618',
  foreground: '#eef0f3',
  cursor: '#d4d6dc',
  cursorAccent: '#161618',
  selectionBackground: 'rgba(200, 210, 225, 0.32)',

  black: '#28282a',
  red: '#ff5252',
  green: '#3ad28a',
  yellow: '#f0a958',
  blue: '#9cb5d4',     // cool steel-blue so `ls` directories still feel "blue"
  magenta: '#bf9ff2',
  cyan: '#7ec8d0',
  white: '#d4d6dc',

  brightBlack: '#6c6c70',
  brightRed: '#ff7a78',
  brightGreen: '#65e0a4',
  brightYellow: '#ffc370',
  brightBlue: '#c1d2e6',
  brightMagenta: '#d8b7ff',
  brightCyan: '#a8d6dc',
  brightWhite: '#f3f5f8',
};

export function Terminal({ sessionKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  // Snapshot the root at mount — the PTY can only be spawned with one CWD,
  // and we don't restart it when the user reroots the tree.
  const initialCwd = useRef<string | null>(useFiles.getState().root);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let unlistens: Array<() => void> = [];
    let ptyId: PtyId | null = null;
    let disposed = false;

    const term = new XTerm({
      fontFamily: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Monaco, 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
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
      theme: THEME,
    });
    termRef.current = term;

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(container);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    };
    safeFit();

    // Re-fit once webfonts (Geist Mono) finish loading — prevents column drift
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!disposed) safeFit();
      });
    }

    const decoder = new TextDecoder('utf-8');

    const boot = async () => {
      if (!isTauri) {
        term.writeln('\x1b[38;2;10;132;255m  arc \x1b[0m\x1b[2mrunning outside Tauri — PTY disabled.\x1b[0m');
        term.writeln('\x1b[2m       Run \x1b[0m\x1b[38;2;10;132;255mpnpm tauri:dev\x1b[0m\x1b[2m to attach a real shell.\x1b[0m');
        term.write('\r\n\x1b[38;2;10;132;255m›\x1b[0m ');
        return;
      }
      try {
        ptyId = await ptySpawn({
          shell: null,
          cwd: initialCwd.current ?? null,
          cols: term.cols,
          rows: term.rows,
        });
        if (disposed) {
          if (ptyId) await ptyKill(ptyId).catch(() => {});
          return;
        }

        unlistens.push(
          await onPtyData(ptyId, (chunk) => {
            term.write(decoder.decode(chunk, { stream: true }));
          }),
        );
        unlistens.push(
          await onPtyExit(ptyId, (code) => {
            term.writeln(`\r\n\x1b[38;2;99;99;102m[exit ${code ?? '?'}]\x1b[0m`);
          }),
        );

        // Publish the PTY id on the tab so other panes (file tree, chat)
        // can write into this terminal.
        useWorkspace.getState().setTabPtyId(sessionKey, ptyId);

        // OSC 7 — modern shells emit `\e]7;file://host/path\e\\` whenever
        // their CWD changes. We sync the file tree root to it so the tree
        // follows the shell. Shells that don't emit it (default cmd.exe,
        // unmodified PowerShell) are a no-op.
        term.parser.registerOscHandler(7, (data) => {
          const url = data.trim();
          if (!url.startsWith('file://')) return false;
          let path = decodeURIComponent(url.slice('file://'.length));
          // Drop the host portion: file://host/path → /path
          const slash = path.indexOf('/');
          if (slash >= 0) path = path.slice(slash);
          // Windows: `/C:/Users/...` → `C:/Users/...`
          if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
          if (path) useFiles.getState().setRoot(path);
          return true; // we handled the OSC
        });

        term.onData((data) => {
          if (ptyId) ptyWrite(ptyId, data).catch(() => {});
        });

        term.onResize(({ cols, rows }) => {
          if (ptyId) ptyResize(ptyId, cols, rows).catch(() => {});
        });
      } catch (err) {
        term.writeln(`\x1b[38;2;255;69;58m  failed to spawn pty: ${err}\x1b[0m`);
      }
    };

    void boot();

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      unlistens.forEach((u) => u());
      if (ptyId) void ptyKill(ptyId).catch(() => {});
      useWorkspace.getState().setTabPtyId(sessionKey, undefined);
      term.dispose();
      termRef.current = null;
    };
  }, [sessionKey]);

  return (
    <div
      ref={containerRef}
      className="selectable h-full w-full"
      data-session={sessionKey}
    />
  );
}
