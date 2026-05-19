# Decisions

ADR-style log. Each entry is a decision we made, the alternatives we rejected, and the trigger that would make us revisit it.

---

## ADR-001 — Tauri 2 over Electron

**Decision:** Use Tauri 2 (Rust core, system webview).

**Why:**

- Spec calls out "low memory footprint" and "<300MB idle RAM". Electron's per-app Chromium instance makes that essentially impossible.
- We want serious system work (PTY, filesystem watching, agent runtime) in Rust — Tauri's Rust-native command model fits cleanly.

**Rejected:** Electron (memory), Neutralino (immature plugin ecosystem), pure native Win32/Cocoa (not cross-platform fast enough).

**Revisit if:** macOS WKWebView or Windows WebView2 has a blocking bug that takes >1 week to work around.

---

## ADR-002 — portable-pty over alacritty_terminal / mio_pty

**Decision:** Use `portable-pty` for spawning shells.

**Why:** Covers Windows ConPTY, macOS, Linux behind one API. Used by WezTerm, mature, low surface area. `alacritty_terminal` is a full terminal *emulator* (we don't need state — xterm.js owns rendering and parsing). `mio_pty` is *nix only.

**Tradeoff:** API is synchronous — we run a thread per session. That's fine for the small N we expect; if we ever hit hundreds of concurrent PTYs we'd revisit.

**Revisit if:** session count regularly exceeds 50 and thread overhead shows up in profiles.

---

## ADR-003 — pnpm workspaces over Turborepo / Nx

**Decision:** pnpm workspaces, no build orchestrator.

**Why:** We're small. Build graph is shallow (frontend depends on packages/*; packages have no codegen). A real orchestrator earns its keep at 10+ packages, not 8 stubs.

**Revisit if:** Cold `pnpm typecheck` takes more than 30s across the repo.

---

## ADR-004 — Zustand over Redux Toolkit

**Decision:** Zustand for client state.

**Why:** Lower ceremony, slice-per-concern fits the app, easy selective subscriptions. Devtools available via middleware when we need them.

**Revisit if:** We need time-travel debugging or strict action logging for agent flows (Redux Toolkit's strength).

---

## ADR-005 — One Rust crate per concern, thin desktop crate

**Decision:** PTY, agents, filesystem, etc. each live in their own crate under `/rust`. `apps/desktop` only composes them.

**Why:** Crate-level isolation makes each one testable without Tauri and reusable from a CLI or integration test binary. Also keeps build times bounded — touching the frontend or the agent runtime doesn't recompile the PTY.

**Revisit if:** The cross-crate type-juggling becomes a tax (e.g. >10 shared types being re-exported).

---

## ADR-006 — JSON byte arrays for PTY data over base64

**Decision:** PTY output crosses IPC as `Vec<u8>` → `number[]` in JSON.

**Why:** Simplest possible path that works end-to-end. Lets us ship the MVP without binary IPC.

**Tradeoff:** ~6× the wire size of binary, and the JSON parser materializes a JS number per byte. Fine at ASCII-shell speeds; will be a bottleneck for high-throughput programs (e.g. `cat large.log`).

**Revisit if:** Profiling shows event serialization is >5% of frame time. Tauri 2's `Channel` type or base64-wrapped strings are the next step.

---

## ADR-007 — cmd.exe (via COMSPEC) as the default Windows shell

**Decision:** Default to `%COMSPEC%` on Windows, `$SHELL` on Unix.

**Why:** cmd.exe is universally available, requires no exec policy change, and has Windows 10+ VT support. PowerShell has stronger UX but stumbles on first-run execution policy on some machines.

**Revisit when:** We add a shell-picker UI. The default for new installs should probably become `pwsh` once Microsoft Store delivery is ubiquitous.

**Update (shell-picker landed):** Settings → Terminal now exposes a per-user override backed by `pty_list_shells` (probes PATH for cmd / powershell / pwsh / bash / nu / wsl on Windows, bash / zsh / fish / nu / sh elsewhere) plus a free-text custom-path field. Persisted as `defaultShell` in the Zustand settings store; `null` falls through to the original `default_shell()` logic, so the OS-default behavior above is preserved for users who never open Settings. The "switch the default to pwsh" question is now a packaging decision rather than a code one — users who prefer pwsh just pick it once.

---

## ADR-008 — Stub AI provider in MVP

**Decision:** Ship a stub provider that echoes the last user message word-by-word. No real LLM calls in Phase 1.

**Why:** Lets us prove the streaming UI contract end-to-end without API keys, accounts, or network in the loop. The provider interface (`packages/provider-sdk`) is the real artifact.

**Revisit:** As soon as Phase 2 starts — first real provider should be Anthropic or OpenAI for tooling parity, then Ollama for the local-first story.
