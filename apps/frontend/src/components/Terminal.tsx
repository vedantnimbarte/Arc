import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  fsDefaultRoot,
  fsReadDir,
  isTauri,
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
import { useSelection } from '../state/selection';
import { useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';
import { getFont, resolveActiveTheme } from '../themes';

interface Props {
  /** Stable id for the terminal (tab id). Also serves as the React-effect
   *  key — recreating the component spawns a new PTY. */
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
    // Tracked so we can dispose the WebGL addon ourselves before the
    // terminal is torn down. xterm's AddonManager will otherwise cascade
    // into WebglAddon.dispose() after its renderer has already been
    // released by context-loss or canvas detach, which throws
    // `Cannot read properties of undefined (reading '_isDisposed')`
    // and crashes the React tree.
    let webglAddon: { dispose: () => void } | null = null;
    let webglDisposed = false;
    const disposeWebgl = () => {
      if (webglDisposed || !webglAddon) return;
      webglDisposed = true;
      try {
        webglAddon.dispose();
      } catch {
        /* renderer already gone */
      }
      webglAddon = null;
    };

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
    termRef.current = term;

    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    // Remove orphaned DOM from a previous xterm instance. In React Strict Mode
    // effects run twice (mount→cleanup→remount); dispose() doesn't always
    // remove every child, so the second open() finds a dirty container.
    while (container.firstChild) container.removeChild(container.firstChild);
    term.open(container);

    // Optional WebGL renderer. xterm requires it to be loaded *after*
    // `open()` because it needs a live canvas to grab a GL context from.
    // The setting captures the user's preference at mount time; switching
    // it in Settings applies to subsequently-opened tabs.
    if (initialSettings.terminalWebgl) {
      void (async () => {
        try {
          const { WebglAddon } = await import('@xterm/addon-webgl');
          if (disposed) return;
          const webgl = new WebglAddon();
          // Dispose on context loss so xterm transparently falls back to
          // its canvas renderer instead of freezing the pane. Route
          // through disposeWebgl so the cleanup path can't double-dispose
          // (which throws inside xterm's AddonManager).
          webgl.onContextLoss(() => disposeWebgl());
          term.loadAddon(webgl);
          webglAddon = webgl;
        } catch (err) {
          // GPU lacks WebGL2, driver crashed, etc. — terminal keeps working
          // with the default renderer.
          console.warn('[terminal] WebGL renderer unavailable:', err);
        }
      })();
    }

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    };
    safeFit();

    // Live-update font + theme when the user changes them in Settings.
    const unsubAppearance = useSettings.subscribe((s, prev) => {
      if (
        s.fontId !== prev.fontId ||
        s.fontSize !== prev.fontSize ||
        s.appearance !== prev.appearance
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

    // Deferred fit: on the next frame the flex layout is guaranteed to have
    // resolved, which matters when this pane is freshly created by a split.
    const rafId = requestAnimationFrame(() => {
      if (!disposed) safeFit();
    });

    // Re-fit once webfonts (Geist Mono) finish loading — prevents column drift
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!disposed) safeFit();
      });
    }

    const decoder = new TextDecoder('utf-8');

    // ─── Ask-ARC-AI selection wiring ────────────────────────────────────
    // xterm paints its selection on a canvas, so there's no DOM rect we
    // can read. The pragmatic anchor is the last mouse position inside
    // this terminal (selection is mouse-driven in 99% of cases). We
    // record mouseup coords on the container, then `onSelectionChange`
    // packages them up with the current selection text.
    let lastPointer: { x: number; y: number } | null = null;
    const onContainerMouseUp = (e: MouseEvent) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    };
    container.addEventListener('mouseup', onContainerMouseUp);
    const shellName = () => {
      const tab = useWorkspace.getState().tabs.find((t) => t.id === sessionKey);
      return tab?.title?.trim() || 'shell';
    };
    const pushSelection = () => {
      const text = term.getSelection();
      if (!text || !text.trim()) {
        useSelection.getState().clear('terminal', sessionKey);
        return;
      }
      // Anchor: mouseup position, falling back to the container's
      // top-center if we have no pointer record (e.g. keyboard select).
      const cb = container.getBoundingClientRect();
      const anchor = lastPointer ?? { x: cb.left + cb.width / 2, y: cb.top + 24 };
      // Build a tiny rect at the anchor so AskAiFloater can position
      // its pill relative to it.
      const rect = { left: anchor.x, top: anchor.y - 16, width: 0, height: 16 };
      useSelection.getState().set({
        source: 'terminal',
        sourceId: sessionKey,
        label: `Terminal · ${shellName()}`,
        text,
        rect,
      });
    };
    const selDisposable = term.onSelectionChange(pushSelection);

    const boot = async () => {
      if (!isTauri) {
        term.writeln('\x1b[38;2;212;214;220m  arc \x1b[0m\x1b[2mrunning outside Tauri — PTY disabled.\x1b[0m');
        term.writeln('\x1b[2m       Run \x1b[0m\x1b[38;2;212;214;220mpnpm tauri:dev\x1b[0m\x1b[2m to attach a real shell.\x1b[0m');
        term.write('\r\n\x1b[38;2;212;214;220m›\x1b[0m ');
        return;
      }
      // ─── OSC 133 shell-integration tracking ────────────────────────────
      // Declared *before* the spawn so the data callback we hand to
      // `ptySpawn` can close over them. We sniff the raw decoded stream for
      // `\e]133;X[;...]ST` markers so we can pair each command with its exit
      // code + a short output excerpt. xterm doesn't render unknown OSCs, so
      // leaving the bytes in the chunk we hand to `term.write` is harmless.
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

      // Track whether we ever saw output from the shell. If the PTY exits
      // with no output at all, the user is left staring at an empty pane and
      // has no idea what went wrong — surface a clear diagnostic in that case.
      let sawAnyData = false;
      const onPtyChunk = (chunk: Uint8Array) => {
        sawAnyData = true;
        const text = decoder.decode(chunk, { stream: true });
        handleChunkText(text);
        term.write(text);
      };

      try {
        // Snapshot the picker choice at spawn time. `null` = let Rust
        // pick the OS default (COMSPEC / $SHELL). Changing the setting
        // only affects subsequently-opened tabs — existing PTYs keep
        // running whatever they were started with.
        // A per-tab `shellOverride` (used by AI CLI launchers) wins over
        // the global default shell.
        const tab = useWorkspace.getState().tabs.find((t) => t.id === sessionKey);
        const chosenShell = tab?.shellOverride ?? useSettings.getState().defaultShell;
        // `onPtyChunk` is wired to the output channel *inside* ptySpawn
        // before the pty_spawn command runs, so no early output is dropped.
        ptyId = await ptySpawn(
          {
            shell: chosenShell && chosenShell.length > 0 ? chosenShell : null,
            cwd: initialCwd.current ?? null,
            cols: term.cols,
            rows: term.rows,
          },
          onPtyChunk,
        );
        if (disposed) {
          if (ptyId) await ptyKill(ptyId).catch(() => {});
          return;
        }

        unlistens.push(
          await onPtyExit(ptyId, (code) => {
            if (!sawAnyData) {
              const cwd = initialCwd.current ?? '(default)';
              term.writeln(
                `\x1b[38;2;255;82;82m  shell exited immediately with code ${code ?? '?'}.\x1b[0m`,
              );
              term.writeln(`\x1b[2m  cwd:   ${cwd}\x1b[0m`);
              term.writeln(
                `\x1b[2m  shell: ${useSettings.getState().defaultShell ?? '(system default)'}\x1b[0m`,
              );
              term.writeln(
                `\x1b[2m  Press ⌘T for a fresh tab, or open Settings → Terminal to pick a different shell.\x1b[0m`,
              );
            } else {
              term.writeln(`\r\n\x1b[38;2;99;99;102m[exit ${code ?? '?'}]\x1b[0m`);
            }
          }),
        );

        // Publish the PTY id so other components (file tree, chat) can write
        // into this terminal.
        useWorkspace.getState().setTabPtyId(sessionKey, ptyId);

        // Our best-effort view of the shell's CWD, used to resolve relative
        // `cd` targets when the shell doesn't emit OSC 7. OSC 7 (below) is
        // authoritative when present. When we didn't pass an explicit cwd to
        // `pty_spawn`, the Rust side falls back to $HOME / %USERPROFILE%
        // (see rust/pty/src/lib.rs) — `fsDefaultRoot` returns the same path,
        // so seeding from it keeps us in sync from the very first command.
        let shellCwd: string | null = initialCwd.current ?? null;
        if (!shellCwd) {
          try {
            shellCwd = await fsDefaultRoot();
          } catch {
            /* leave null — only absolute cd targets will resolve */
          }
        }

        // OSC 7 — modern shells emit `\e]7;file://host/path\e\\` whenever
        // their CWD changes. We sync the file tree root to it so the tree
        // follows the shell. Shells that don't emit it (default cmd.exe,
        // unmodified PowerShell) fall back to the cd-sniffer below.
        term.parser.registerOscHandler(7, (data) => {
          const url = data.trim();
          if (!url.startsWith('file://')) return false;
          let path = decodeURIComponent(url.slice('file://'.length));
          // Drop the host portion: file://host/path → /path
          const slash = path.indexOf('/');
          if (slash >= 0) path = path.slice(slash);
          // Windows: `/C:/Users/...` → `C:/Users/...`
          if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
          if (path) {
            shellCwd = path;
            useFiles.getState().setRoot(path);
          }
          return true; // we handled the OSC
        });

        // Pull the target argument out of a `cd`-style command line. Returns
        // null when the line isn't a directory change, or has no resolvable
        // argument (bare `cd`, `cd -`, `cd ~`).
        const parseCdTarget = (line: string): string | null => {
          const m = line.match(/^\s*(cd|chdir|pushd|Set-Location|sl)\b\s*(.*)$/i);
          if (!m) return null;
          let rest = m[2]!.trim();
          // cmd.exe: `cd /d <path>` switches drive too. Strip the flag.
          rest = rest.replace(/^\/d\b\s*/i, '');
          // PowerShell: `-Path` / `-LiteralPath` named parameter.
          rest = rest.replace(/^-(LiteralPath|Path)\b\s*/i, '').trim();
          if (!rest) return null;
          if (
            (rest.startsWith('"') && rest.endsWith('"')) ||
            (rest.startsWith("'") && rest.endsWith("'"))
          ) {
            rest = rest.slice(1, -1);
          }
          if (rest === '-' || rest === '~' || rest.startsWith('~/') || rest.startsWith('~\\')) {
            return null;
          }
          return rest;
        };

        // Resolve `target` against `base`, collapsing `.`/`..`. Picks the
        // separator from whichever side looks Windows-ish.
        const joinAndNormalize = (base: string | null, target: string): string | null => {
          const winLike =
            /^[A-Za-z]:[\\/]/.test(target) ||
            (base !== null && (/\\/.test(base) || /^[A-Za-z]:/.test(base)));
          const sep = winLike ? '\\' : '/';
          const isAbs =
            /^[A-Za-z]:[\\/]/.test(target) ||
            target.startsWith('/') ||
            target.startsWith('\\');
          const abs = isAbs ? target : base ? `${base}${sep}${target}` : null;
          if (!abs) return null;
          let prefix = '';
          let rest = abs;
          const drive = /^([A-Za-z]:)[\\/](.*)$/.exec(abs);
          if (drive) {
            prefix = `${drive[1]}${sep}`;
            rest = drive[2]!;
          } else if (abs.startsWith('/') || abs.startsWith('\\')) {
            prefix = sep;
            rest = abs.slice(1);
          }
          const parts = rest.split(/[\\/]+/).filter((p) => p && p !== '.');
          const out: string[] = [];
          for (const p of parts) {
            if (p === '..') out.pop();
            else out.push(p);
          }
          return prefix + out.join(sep);
        };

        // Fallback CWD sync for shells without OSC 7: sniff `cd <path>` from
        // the typed line and adopt the target only if it resolves to a real
        // directory (mirrors what the shell will do).
        const syncRootFromCd = async (line: string) => {
          const target = parseCdTarget(line);
          if (!target) return;
          const resolved = joinAndNormalize(shellCwd, target);
          if (!resolved) return;
          try {
            await fsReadDir(resolved);
            shellCwd = resolved;
            useFiles.getState().setRoot(resolved);
          } catch {
            /* path didn't exist or wasn't a dir — shell will have errored too */
          }
        };

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
              void syncRootFromCd(trimmed);
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

    // When the tab's host div is reparented from the offscreen stage back
    // into a visible leaf (tab switch / pane move), PaneLeafView dispatches
    // `arc:host-shown` on the host. ResizeObserver doesn't always fire for
    // display:none→visible transitions, and the WebGL renderer can hold a
    // stale-sized canvas, leaving only a sliver of the prompt visible.
    // Force a fit + full refresh on the next frame so layout has settled.
    const host = container.parentElement;
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
    host?.addEventListener('arc:host-shown', onHostShown);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      host?.removeEventListener('arc:host-shown', onHostShown);
      container.removeEventListener('mouseup', onContainerMouseUp);
      try {
        selDisposable.dispose();
      } catch {
        /* terminal already disposed */
      }
      useSelection.getState().clear('terminal', sessionKey);
      unsubAppearance();
      unlistens.forEach((u) => u());
      if (ptyId) void ptyKill(ptyId).catch(() => {});
      useWorkspace.getState().setTabPtyId(sessionKey, undefined);
      // Tear the WebGL addon down ourselves first; otherwise xterm's
      // AddonManager runs it after the canvas is gone and throws.
      disposeWebgl();
      try {
        term.dispose();
      } catch {
        /* addon cleanup races — terminal is already going away */
      }
      termRef.current = null;
    };
  }, [sessionKey]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="selectable h-full w-full"
        data-session={sessionKey}
      />
    </div>
  );
}
