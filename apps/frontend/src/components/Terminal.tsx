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

interface Props {
  sessionKey: string;
}

// xterm theme — calibrated to read well on the dot-grid panel and to share
// the violet accent with the rest of the chrome.
const THEME = {
  background: '#0c0d12',
  foreground: '#eceff5',
  cursor: '#a78bfa',
  cursorAccent: '#0c0d12',
  selectionBackground: 'rgba(167, 139, 250, 0.28)',

  black: '#191b24',
  red: '#f47b8e',
  green: '#86d099',
  yellow: '#f5a97f',
  blue: '#7aa2f7',
  magenta: '#a78bfa',
  cyan: '#80cfff',
  white: '#c8cad1',

  brightBlack: '#5d6477',
  brightRed: '#ff8ea1',
  brightGreen: '#9fdfb1',
  brightYellow: '#fcc28d',
  brightBlue: '#a0bdfa',
  brightMagenta: '#c5b0ff',
  brightCyan: '#a8dffd',
  brightWhite: '#f4f6fa',
};

export function Terminal({ sessionKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let unlistens: Array<() => void> = [];
    let ptyId: PtyId | null = null;
    let disposed = false;

    const term = new XTerm({
      fontFamily: "'Geist Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
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
        term.writeln('\x1b[38;2;167;139;250m  arc \x1b[0m\x1b[2mrunning outside Tauri — PTY disabled.\x1b[0m');
        term.writeln('\x1b[2m       Run \x1b[0m\x1b[38;2;167;139;250mpnpm tauri:dev\x1b[0m\x1b[2m to attach a real shell.\x1b[0m');
        term.write('\r\n\x1b[38;2;167;139;250m›\x1b[0m ');
        return;
      }
      try {
        ptyId = await ptySpawn({
          shell: null,
          cwd: null,
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
            term.writeln(`\r\n\x1b[38;2;93;100;119m[exit ${code ?? '?'}]\x1b[0m`);
          }),
        );

        term.onData((data) => {
          if (ptyId) ptyWrite(ptyId, data).catch(() => {});
        });

        term.onResize(({ cols, rows }) => {
          if (ptyId) ptyResize(ptyId, cols, rows).catch(() => {});
        });
      } catch (err) {
        term.writeln(`\x1b[38;2;244;123;142m  failed to spawn pty: ${err}\x1b[0m`);
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
