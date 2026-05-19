import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { XTERM_THEME } from '@arc/terminal';
import {
  isTauri,
  onPtyData,
  onPtyExit,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  sessionCommandFinish,
  sessionCommandLog,
  type PtyId,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';

interface Props {
  sessionKey: string;
}

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
      theme: XTERM_THEME,
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
        term.writeln('\x1b[38;2;212;214;220m  arc \x1b[0m\x1b[2mrunning outside Tauri — PTY disabled.\x1b[0m');
        term.writeln('\x1b[2m       Run \x1b[0m\x1b[38;2;212;214;220mpnpm tauri:dev\x1b[0m\x1b[2m to attach a real shell.\x1b[0m');
        term.write('\r\n\x1b[38;2;212;214;220m›\x1b[0m ');
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

        // OSC 133 shell-integration tracking. We sniff the raw decoded
        // stream for `\e]133;X[;...]ST` markers so we can pair each command
        // with its exit code + a short output excerpt. xterm doesn't
        // render unknown OSCs, so leaving the bytes in the chunk we hand
        // to `term.write` is harmless.
        //
        // Format:
        //   A — prompt start
        //   B — command start (right after the prompt — buffer reset)
        //   C — pre-execution (output begins)
        //   D[;<exit>] — command finished, optional decimal exit code
        const OSC_133 = /\x1b\]133;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
        const OUTPUT_CAP = 4 * 1024;
        const osc = { capturing: false, buf: '' };
        // Hoisted here so both the OSC chunk parser (which finalizes the
        // row on `D`) and the keystroke loop (which sets it on `\r`)
        // share the same reference.
        let lastCommandId: number | null = null;
        const handleChunkText = (text: string) => {
          if (!text.includes('\x1b]133;')) {
            if (osc.capturing) {
              osc.buf += text;
              if (osc.buf.length > OUTPUT_CAP) osc.buf = osc.buf.slice(0, OUTPUT_CAP);
            }
            return;
          }
          let lastIdx = 0;
          OSC_133.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = OSC_133.exec(text)) !== null) {
            const between = text.slice(lastIdx, m.index);
            if (osc.capturing && between) {
              osc.buf += between;
              if (osc.buf.length > OUTPUT_CAP) osc.buf = osc.buf.slice(0, OUTPUT_CAP);
            }
            const fields = m[1]!.split(';');
            const verb = fields[0] ?? '';
            if (verb === 'C') {
              osc.capturing = true;
              osc.buf = '';
            } else if (verb === 'D') {
              osc.capturing = false;
              const exitStr = fields[1];
              const exit = exitStr === undefined ? null : Number.parseInt(exitStr, 10);
              const code = Number.isFinite(exit as number) ? (exit as number) : null;
              const id = lastCommandId;
              const excerpt = osc.buf;
              osc.buf = '';
              lastCommandId = null;
              if (id !== null) {
                void sessionCommandFinish(id, code, excerpt.length > 0 ? excerpt : null).catch(
                  () => {},
                );
              }
            }
            lastIdx = m.index + m[0].length;
          }
          if (osc.capturing) {
            const rest = text.slice(lastIdx);
            if (rest) {
              osc.buf += rest;
              if (osc.buf.length > OUTPUT_CAP) osc.buf = osc.buf.slice(0, OUTPUT_CAP);
            }
          }
        };

        unlistens.push(
          await onPtyData(ptyId, (chunk) => {
            const text = decoder.decode(chunk, { stream: true });
            handleChunkText(text);
            term.write(text);
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

        // Command capture: best-effort. If the shell emits OSC 133, the
        // `D` handler above attaches the exit code; otherwise we still
        // log the input line.
        //   * Append printable + tab chars to a buffer.
        //   * Backspace pops a char.
        //   * Enter flushes the buffer to the command_history table.
        //   * ^C clears the buffer (user cancelled, never ran).
        //   * Escape sequences (arrows, etc.) are skipped.
        // Note: this *does* capture lines typed at interactive prompts
        // (less, vim, ssh password) — without OSC 133 we can't tell
        // them apart. Shells with shell-integration installed avoid this.
        let cmdBuffer = '';
        term.onData((data) => {
          if (ptyId) ptyWrite(ptyId, data).catch(() => {});

          // Handle each char in `data` separately so a fast paste of
          // "ls\rgit status\r" splits into two commands.
          for (let i = 0; i < data.length; i++) {
            const ch = data[i]!;
            const code = ch.charCodeAt(0);
            if (ch === '\r' || ch === '\n') {
              const trimmed = cmdBuffer.trim();
              cmdBuffer = '';
              if (trimmed.length === 0) continue;
              const { activeTabId } = useWorkspace.getState();
              const { sessionId } = useWorkspace.getState();
              const cwd = useFiles.getState().root;
              void sessionCommandLog({
                sessionId: sessionId ?? null,
                tabId: activeTabId,
                workspaceId: null,
                cwd: cwd ?? null,
                command: trimmed,
              })
                .then((id) => {
                  lastCommandId = id;
                })
                .catch(() => {});
            } else if (code === 0x7f || code === 0x08) {
              // DEL / BS — back over a char (or no-op if buffer empty).
              if (cmdBuffer.length > 0) cmdBuffer = cmdBuffer.slice(0, -1);
            } else if (code === 0x03) {
              // ^C — abort
              cmdBuffer = '';
            } else if (code === 0x1b) {
              // ESC — start of an escape sequence; skip the whole
              // sequence by jumping to the next non-CSI/SS3 char.
              // A correct CSI parser is overkill here; the common cases
              // (`\x1b[A`, `\x1b[B`, etc.) are 2–3 chars total. Skip
              // through `[` and one trailing letter.
              const next = data[i + 1];
              if (next === '[' || next === 'O') {
                i += 1;
                while (i + 1 < data.length) {
                  const c = data[i + 1]!.charCodeAt(0);
                  i += 1;
                  // CSI final byte is in 0x40-0x7e range.
                  if (c >= 0x40 && c <= 0x7e) break;
                }
              }
            } else if (code >= 0x20 || ch === '\t') {
              cmdBuffer += ch;
            }
          }
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
