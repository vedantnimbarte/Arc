import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
  fsDefaultRoot,
  fsReadDir,
  isTauri,
  onPtyExit,
  projectConfigLoad,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  sessionCommandFinish,
  sessionCommandLog,
  sessionScrollbackLoad,
  sessionScrollbackSave,
  type PtyId,
} from '../lib/tauri';
import { createPathLinkProvider } from '../lib/links';
import { isRemotePath } from '../lib/remote';
import { notifyCommandFinished } from '../lib/notify';
import { NewTabSplash } from './NewTabSplash';
import { TerminalSearchBar } from './TerminalSearchBar';
import { useFiles } from '../state/files';
import { useTrust } from '../state/trust';
import { detectRiskyPaste, usePaste } from '../state/paste';
import { resolveTerminalProfile, useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';
import { useAi } from '../state/ai';
import { AiCommandBar } from './AiCommandBar';
import { getFont, resolveActiveTheme } from '../themes';

interface Props {
  /** Stable id for the terminal (tab id). Also serves as the React-effect
   *  key — recreating the component spawns a new PTY. */
  sessionKey: string;
}

/** Find-bar highlight colours. Deliberately theme-independent: an amber wash
 *  reads against every bundled xterm palette, light or dark, and the overview
 *  ruler needs opaque values regardless. */
const SEARCH_DECORATIONS = {
  matchBackground: 'rgba(255, 200, 60, 0.28)',
  matchOverviewRuler: '#e0a33c',
  activeMatchBackground: 'rgba(255, 170, 40, 0.55)',
  activeMatchColorOverviewRuler: '#ff8c1a',
};

/** How much of the buffer is serialized for restore-after-relaunch. The full
 *  10k-line scrollback would be megabytes per tab; the last thousand lines is
 *  what anyone actually scrolls back to read. */
const SCROLLBACK_SAVE_LINES = 1000;

/** How often a terminal with new output writes its buffer to the DB. The app
 *  can be killed in ways React cleanup never sees (window close, crash, OS
 *  shutdown), so persistence can't hang off unmount alone.
 *  ponytail: fixed interval, dirty-gated. Worst case loses the last 15s of
 *  scrollback — drop it if that ever matters. */
const SCROLLBACK_SAVE_MS = 15_000;

export function Terminal({ sessionKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  // Find bar (⌘F / ctrl+shift+F). The addon outlives the bar so a reopened
  // bar can keep searching the same buffer.
  const searchRef = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // Snapshot the root at mount — the PTY can only be spawned with one CWD,
  // and we don't restart it when the user reroots the tree.
  //
  // A remote root is not a directory this machine has: handing `ssh://…` to
  // the local PTY spawn fails outright. Local terminals opened while a remote
  // workspace is active start at home instead; the shell *on* that host is an
  // SSH tab, which is a different thing entirely.
  const initialCwd = useRef<string | null>(
    isRemotePath(useFiles.getState().root) ? null : useFiles.getState().root,
  );
  // New-tab splash (Tier 1.2): disabled — open straight to the terminal.
  // ponytail: hard-off; reintroduce a setting here if it's ever wanted back.
  const [showSplash, setShowSplash] = useState(false);

  // Clear the running dot if the pane is closed mid-command (OSC 133 `D` may
  // never arrive when the PTY is killed).
  useEffect(
    () => () => useWorkspace.getState().setTabRunning(sessionKey, false),
    [sessionKey],
  );

  const pasteRecentCommand = (command: string) => {
    const ptyId = useWorkspace.getState().tabs.find((t) => t.id === sessionKey)?.ptyId;
    if (ptyId) void ptyWrite(ptyId, command).catch(() => {});
    setShowSplash(false);
    termRef.current?.focus();
  };
  // ⌘K command bar (App owns the shortcut and names the tab).
  const aiOpen = useAi((s) => s.openFor === sessionKey);

  const openRecentFile = (path: string) => {
    useWorkspace.getState().openFile(path);
    setShowSplash(false);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let unlistens: Array<() => void> = [];
    let ptyId: PtyId | null = null;
    let disposed = false;
    // Set on every PTY chunk, cleared on every write to the DB, so an idle
    // terminal doesn't re-serialize its buffer every tick.
    let scrollbackDirty = false;
    let scrollbackTimer: ReturnType<typeof setInterval> | null = null;

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
    // Search + serialize are pure buffer operations — safe to load before
    // `open()`. WebGL is not: it needs a live renderer, so it waits for
    // `ensureOpen()` below.
    const search = new SearchAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.loadAddon(search);
    term.loadAddon(serialize);
    searchRef.current = search;

    // ⌘F (mac) / ctrl+shift+F (win/linux) opens the find bar. Plain ctrl+F is
    // deliberately left alone — readline binds it to forward-char, and
    // stealing it would break cursor movement in every shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const isFind = e.key === 'F' || e.key === 'f';
      if (!isFind) return true;
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        setSearchOpen(true);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        setSearchOpen(true);
        return false;
      }
      return true;
    });
    // File-path links → editor (Tier 1.1). Resolves relative paths against the
    // tree root (which tracks the shell's CWD) and opens them in an editor tab.
    const pathLinks = term.registerLinkProvider(
      createPathLinkProvider(
        term,
        () => useFiles.getState().root,
        (absPath, line) => useWorkspace.getState().openFile(absPath, undefined, { line }),
      ),
    );
    // Defer `term.open()` until the container is actually visible. Tabs that
    // aren't the active leaf mount with their host div parked in the hidden
    // (`display:none`) stage, so the container is 0×0. Opening xterm there
    // makes it defer renderer creation, and the first PTY write then crashes
    // inside `syncScrollArea` (`this._renderer.value.dimensions` on an
    // undefined renderer). ensureOpen() runs once the host is shown — see the
    // `arc:host-shown` handler and ResizeObserver below.
    let opened = false;
    // Anything written before `ensureOpen()` runs would reach an xterm with no
    // renderer, and the next `syncScrollArea` reads `dimensions` on undefined
    // — the crash the comment above describes. Buffer instead and flush once
    // the terminal is really open.
    //
    // Every write goes through `write`/`writeln` for that reason. It is not
    // only the browser-only banner: that one is just the reliable reproducer,
    // because it writes synchronously while the host is still parked in the
    // hidden stage. PTY output normally arrives late enough to be safe, but a
    // spawn that fails immediately hits the same window in the real app.
    const pending: string[] = [];
    const write = (data: string) => {
      if (disposed) return;
      if (!opened) {
        pending.push(data);
        return;
      }
      term.write(data);
    };
    const writeln = (data: string) => write(`${data}\r\n`);

    const ensureOpen = () => {
      if (opened || disposed) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      opened = true;
      // Remove orphaned DOM from a previous xterm instance. In React Strict
      // Mode effects run twice (mount→cleanup→remount); dispose() doesn't
      // always remove every child, so the second open() finds a dirty
      // container.
      while (container.firstChild) container.removeChild(container.firstChild);
      term.open(container);
      safeFit();
      // GPU renderer. Roughly an order of magnitude faster than the DOM
      // renderer on heavy output (a full `cargo build`, `npm test` with a
      // spinner). Every failure path here is non-fatal — xterm keeps its DOM
      // renderer and the terminal works exactly as before:
      //   * construction throws when there's no WebGL2 context at all
      //     (software rendering, remote desktop, a locked-down GPU driver);
      //   * `onContextLoss` fires when the driver resets the context later —
      //     disposing the addon hands rendering back to the DOM path rather
      //     than leaving a permanently blank canvas.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            /* already gone */
          }
        });
        term.loadAddon(webgl);
      } catch {
        /* no WebGL2 available — DOM renderer stays */
      }
      // Drain on the next frame, not in this tick. `open()` does not guarantee
      // the renderer exists yet, and writing into that gap is the same
      // `dimensions`-on-undefined crash this buffer exists to avoid — PTY
      // output only ever worked because it arrived a frame or more later.
      // Drained in arrival order so a buffered banner reads as it would live.
      if (pending.length > 0) {
        requestAnimationFrame(() => {
          if (disposed) return;
          const queued = pending.splice(0, pending.length);
          try {
            for (const chunk of queued) term.write(chunk);
          } catch {
            /* renderer torn down between the frame and here */
          }
        });
      }
    };

    const safeFit = () => {
      if (!opened) return;
      try {
        fit.fit();
      } catch {
        /* container not measurable yet */
      }
    };
    ensureOpen();

    // The mono web font can still be loading when xterm first measures its
    // cell size, which leaves the cursor drawn a few columns into the prompt
    // until a resize re-fits (intermittent, default-font). Once the fonts are
    // ready, force a fresh char-size measurement (a no-op letterSpacing toggle
    // makes xterm re-measure) and re-fit so the cursor lines up with the glyphs.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        // `opened` matters as much as `disposed`: re-measuring pokes the
        // renderer, and before `term.open()` there isn't one — xterm then
        // throws on `dimensions` of undefined. There is also nothing to
        // re-measure yet, and `ensureOpen` fits on open anyway.
        //
        // This became reachable when the webfonts moved into the bundle:
        // `fonts.ready` used to resolve after a CDN round-trip, by which time
        // the host had been shown, and now it can resolve first.
        if (disposed || !opened) return;
        try {
          const ls = term.options.letterSpacing ?? 0;
          term.options.letterSpacing = ls === 0 ? 0.01 : 0;
          term.options.letterSpacing = ls;
          safeFit();
        } catch {
          /* renderer torn down between the guard and here */
        }
      });
    }

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

    // Deferred fit: on the next frame the flex layout is guaranteed to have
    // resolved, which matters when this pane is freshly created by a split.
    const rafId = requestAnimationFrame(() => {
      if (disposed) return;
      ensureOpen();
      safeFit();
    });

    // Re-fit once webfonts (Geist Mono) finish loading — prevents column drift
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!disposed) safeFit();
      });
    }

    const decoder = new TextDecoder('utf-8');

    // ─── Smart paste warnings (Tier 1.4) ───────────────────────────────
    // Intercept paste in the capture phase — before xterm's own textarea
    // handler — so we can vet the clipboard text. Risky pastes (multi-line,
    // sudo, rm -rf, curl|sh, …) are parked behind a confirm dialog; safe
    // pastes fall straight through to xterm untouched. Holding shift while
    // pasting bypasses the check entirely.
    let shiftHeld = false;
    const trackShift = (e: KeyboardEvent) => {
      shiftHeld = e.shiftKey;
    };
    window.addEventListener('keydown', trackShift, true);
    window.addEventListener('keyup', trackShift, true);
    const onPaste = (e: ClipboardEvent) => {
      if (shiftHeld) return; // explicit bypass
      const text = e.clipboardData?.getData('text') ?? '';
      if (!text) return;
      const flags = detectRiskyPaste(text);
      if (flags.length === 0) return; // nothing to warn about
      // Stop xterm from pasting now; re-issue via term.paste() on confirm.
      e.preventDefault();
      e.stopPropagation();
      void usePaste
        .getState()
        .request(text, flags)
        .then((ok) => {
          if (ok && !disposed) term.paste(text);
        });
    };
    container.addEventListener('paste', onPaste, true);

    const boot = async () => {
      if (!isTauri) {
        writeln('\x1b[38;2;212;214;220m  arc \x1b[0m\x1b[2mrunning outside Tauri — PTY disabled.\x1b[0m');
        writeln('\x1b[2m       Run \x1b[0m\x1b[38;2;212;214;220mpnpm tauri:dev\x1b[0m\x1b[2m to attach a real shell.\x1b[0m');
        write('\r\n\x1b[38;2;212;214;220m›\x1b[0m ');
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
      // Long-command notification bookkeeping (Tier 1.5): the command text is
      // set on Enter, the start time on the `C` (execution begins) marker.
      let lastCommandText: string | null = null;
      let cmdStartMs: number | null = null;
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
            cmdStartMs = Date.now();
            // A command is now executing — light the pane's status dot.
            useWorkspace.getState().setTabRunning(sessionKey, true);
          } else if (verb === 'D') {
            osc.capturing = false;
            useWorkspace.getState().setTabRunning(sessionKey, false);
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
            // Remember a failure so ⌘K can offer to explain it. Everything it
            // needs is already here — the command, its exit code, and what it
            // printed — so the user never retypes any of it. A success clears
            // the tab's failure: the thing that went wrong has been dealt with.
            if (code !== null && code !== 0 && lastCommandText) {
              useAi.getState().recordFailure(sessionKey, {
                command: lastCommandText,
                exitCode: code,
                output: excerpt,
              });
            } else if (code === 0) {
              useAi.getState().clearFailure(sessionKey);
            }
            // Notify on slow commands that finished while we weren't looking.
            const startedAt = cmdStartMs;
            cmdStartMs = null;
            const s = useSettings.getState();
            if (s.notifyLongCommands && startedAt !== null) {
              const elapsed = Date.now() - startedAt;
              if (elapsed >= s.notifyThresholdSecs * 1000 && !document.hasFocus()) {
                void notifyCommandFinished({
                  command: lastCommandText ?? '(command)',
                  exitCode: code,
                  durationMs: elapsed,
                  sound: s.notifySound,
                });
              }
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
      // Task runner: a one-shot command typed into the shell once it's alive.
      // Set from the tab below; fired on the first output chunk (the shell has
      // booted by then) after a short delay so the prompt is drawn first.
      // ponytail: first-output + 250ms heuristic; gate on the OSC 133 `A`
      // prompt marker instead if a slow shell ever races it.
      let pendingRunCommand: string | null = null;
      let ranPending = false;
      const onPtyChunk = (chunk: Uint8Array) => {
        sawAnyData = true;
        scrollbackDirty = true;
        const text = decoder.decode(chunk, { stream: true });
        handleChunkText(text);
        write(text);
        if (pendingRunCommand && !ranPending) {
          ranPending = true;
          const cmd = pendingRunCommand;
          setTimeout(() => {
            if (!disposed && ptyId) void ptyWrite(ptyId, `${cmd}\r`).catch(() => {});
          }, 250);
        }
      };

      // Replay the buffer this tab had when the app last closed, before any
      // new output arrives, so a restored tab reads in chronological order.
      // Awaited (not fired-and-forgotten) for exactly that reason. A failure
      // here is cosmetic — carry on and spawn the shell.
      try {
        const saved = await sessionScrollbackLoad(sessionKey);
        if (saved && !disposed) {
          write(saved);
          writeln('\r\n\x1b[2m── session restored ──\x1b[0m');
        }
      } catch {
        /* nothing stored, or the read failed — start clean */
      }

      // Persist the buffer periodically. Cheap when idle (the dirty flag
      // short-circuits) and bounded when busy (SCROLLBACK_SAVE_LINES).
      scrollbackTimer = setInterval(() => {
        if (disposed || !scrollbackDirty || !opened) return;
        scrollbackDirty = false;
        try {
          const data = serialize.serialize({ scrollback: SCROLLBACK_SAVE_LINES });
          void sessionScrollbackSave(sessionKey, data).catch(() => {});
        } catch {
          /* buffer torn down mid-serialize */
        }
      }, SCROLLBACK_SAVE_MS);

      try {
        // Snapshot the picker choice at spawn time. `null` = let Rust
        // pick the OS default (COMSPEC / $SHELL). Changing the setting
        // only affects subsequently-opened tabs — existing PTYs keep
        // running whatever they were started with.
        // Precedence, most specific first:
        //   1. `shellOverride` — an AI CLI launcher spawning a specific binary.
        //   2. the tab's terminal profile, or the default profile.
        //   3. `defaultShell`, the single-shell setting profiles build on.
        // An unknown profile id (the user deleted it) resolves to null and
        // falls through to 3 rather than spawning nothing.
        const tab = useWorkspace.getState().tabs.find((t) => t.id === sessionKey);
        const settings = useSettings.getState();
        const profile = resolveTerminalProfile(
          settings.terminalProfiles,
          tab?.profileId ?? settings.defaultProfileId,
        );
        const chosenShell =
          tab?.shellOverride ?? (profile && profile.shell ? profile.shell : settings.defaultShell);
        pendingRunCommand = tab?.runCommand ?? null;
        // Layer any `.arc/config.toml` env for the terminal's actual cwd on
        // top of the inherited process env. Loaded per-cwd (not from the
        // file-tree-keyed store) so it's race-free against the home reset.
        let projectEnv: Record<string, string> | null = null;
        // A profile's cwd pins the terminal; without one it follows the tree.
        // A tab that was launched into its own worktree pins itself there;
        // otherwise a profile's cwd wins, and failing that the file tree's root.
        const cwd = tab?.launchCwd || profile?.cwd || initialCwd.current;
        // Only inject `.arc/config.toml` env from a folder the user has
        // trusted (state/trust.ts). Untrusted repo env is drive-by RCE via
        // PROMPT_COMMAND / BASH_ENV / LD_PRELOAD, so we don't even load it.
        if (cwd && useTrust.getState().isTrusted(cwd)) {
          try {
            const pc = await projectConfigLoad(cwd);
            if (pc?.env && Object.keys(pc.env).length > 0) projectEnv = pc.env;
          } catch {
            // No config / unreadable → inherit env only.
          }
        }
        // Profile env is user-authored in Settings, so unlike the project env
        // above it needs no trust gate — and it wins over the repo's values.
        const env =
          profile?.env || projectEnv
            ? { ...(projectEnv ?? {}), ...(profile?.env ?? {}) }
            : null;
        // `onPtyChunk` is wired to the output channel *inside* ptySpawn
        // before the pty_spawn command runs, so no early output is dropped.
        ptyId = await ptySpawn(
          {
            shell: chosenShell && chosenShell.length > 0 ? chosenShell : null,
            cwd: cwd ?? null,
            cols: term.cols,
            rows: term.rows,
            env,
            args: tab?.shellArgs ?? profile?.args ?? null,
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
              writeln(
                `\x1b[38;2;255;82;82m  shell exited immediately with code ${code ?? '?'}.\x1b[0m`,
              );
              writeln(`\x1b[2m  cwd:   ${cwd}\x1b[0m`);
              writeln(
                `\x1b[2m  shell: ${useSettings.getState().defaultShell ?? '(system default)'}\x1b[0m`,
              );
              writeln(
                `\x1b[2m  Press ⌘T for a fresh tab, or open Settings → Terminal to pick a different shell.\x1b[0m`,
              );
            } else {
              writeln(`\r\n\x1b[38;2;99;99;102m[exit ${code ?? '?'}]\x1b[0m`);
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
        // Track this tab's cwd centrally so the grid's per-cell branch pill can
        // resolve a repo. Updated below on every OSC 7 / cd. Seed immediately.
        const setTabCwd = (path: string) => useWorkspace.getState().setTabCwd(sessionKey, path);
        if (shellCwd) setTabCwd(shellCwd);

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
            setTabCwd(path);
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
            setTabCwd(resolved);
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
          // First interaction dismisses the new-tab splash.
          setShowSplash(false);

          // Handle each char in `data` separately so a fast paste of
          // "ls\rgit status\r" splits into two commands.
          for (let i = 0; i < data.length; i++) {
            const ch = data[i]!;
            const code = ch.charCodeAt(0);
            if (ch === '\r' || ch === '\n') {
              const trimmed = cmdBuffer.trim();
              cmdBuffer = '';
              if (trimmed.length === 0) continue;
              // Remember the text for the long-command notification (Tier 1.5).
              lastCommandText = trimmed;
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
        writeln(`\x1b[38;2;255;69;58m  failed to spawn pty: ${err}\x1b[0m`);
      }
    };

    void boot();

    const ro = new ResizeObserver(() => {
      ensureOpen();
      safeFit();
    });
    ro.observe(container);

    // When the tab's host div is reparented from the offscreen stage back
    // into a visible leaf (tab switch / pane move), PaneLeafView dispatches
    // `arc:host-shown` on the host. ResizeObserver doesn't always fire for
    // display:none→visible transitions, leaving the terminal on a stale size
    // (only a sliver of the prompt visible). Force a fit + full refresh on the
    // next frame so layout has settled.
    const host = container.parentElement;
    const onHostShown = () => {
      requestAnimationFrame(() => {
        if (disposed) return;
        ensureOpen();
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
      // Final write before the buffer goes away. Deliberately *not* gated on
      // the dirty flag: a tab that scrolled but produced no new output since
      // the last tick still has the content worth keeping. Tab closes are
      // handled separately — `closeTab` deletes the row outright.
      if (scrollbackTimer) clearInterval(scrollbackTimer);
      if (opened) {
        try {
          const data = serialize.serialize({ scrollback: SCROLLBACK_SAVE_LINES });
          if (data) void sessionScrollbackSave(sessionKey, data).catch(() => {});
        } catch {
          /* renderer already torn down */
        }
      }
      cancelAnimationFrame(rafId);
      ro.disconnect();
      host?.removeEventListener('arc:host-shown', onHostShown);
      container.removeEventListener('paste', onPaste, true);
      window.removeEventListener('keydown', trackShift, true);
      window.removeEventListener('keyup', trackShift, true);
      try {
        pathLinks.dispose();
      } catch {
        /* terminal already disposed */
      }
      unsubAppearance();
      unlistens.forEach((u) => u());
      if (ptyId) void ptyKill(ptyId).catch(() => {});
      useWorkspace.getState().setTabPtyId(sessionKey, undefined);
      try {
        term.dispose();
      } catch {
        /* addon cleanup races — terminal is already going away */
      }
      termRef.current = null;
      searchRef.current = null;
    };
  }, [sessionKey]);

  return (
    <div className="relative h-full w-full bg-bg-base">
      <div
        ref={containerRef}
        className="selectable h-full w-full"
        data-session={sessionKey}
      />
      {searchOpen && searchRef.current && (
        <TerminalSearchBar
          addon={searchRef.current}
          decorations={SEARCH_DECORATIONS}
          onClose={() => {
            setSearchOpen(false);
            termRef.current?.focus();
          }}
        />
      )}
      {showSplash && (
        <NewTabSplash onPasteCommand={pasteRecentCommand} onOpenFile={openRecentFile} />
      )}
      {aiOpen && (
        <AiCommandBar
          sessionKey={sessionKey}
          shell={
            useWorkspace.getState().tabs.find((t) => t.id === sessionKey)?.shellOverride ??
            useSettings.getState().defaultShell
          }
          cwd={useWorkspace.getState().tabs.find((t) => t.id === sessionKey)?.cwd ?? null}
          onInsert={pasteRecentCommand}
        />
      )}
    </div>
  );
}
