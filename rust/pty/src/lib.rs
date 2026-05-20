//! arc-pty — wraps `portable-pty` with a session-keyed manager that streams
//! shell output over Tokio channels.
//!
//! The contract:
//!   spawn(opts)            -> id + Receivers (data chunks, exit code)
//!   write(id, bytes)       -> push to shell stdin
//!   resize(id, cols, rows) -> resize the PTY
//!   kill(id)               -> SIGKILL/TerminateProcess + drop session
//!
//! Reader I/O is blocking (portable-pty is sync), so we run it on a dedicated
//! OS thread and forward chunks into a bounded `tokio::sync::mpsc` channel.

use anyhow::{Context, Result};
use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const READ_BUF_SIZE: usize = 8 * 1024;
const DATA_CHANNEL_CAP: usize = 256;

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// Returned to the caller of [`PtyManager::spawn`]. The two receivers must be
/// drained by the caller; once dropped, the underlying threads exit cleanly.
pub struct SpawnResult {
    pub id: String,
    pub data_rx: mpsc::Receiver<Vec<u8>>,
    pub exit_rx: oneshot::Receiver<Option<i32>>,
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: DashMap<String, Arc<Session>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&self, opts: SpawnOptions) -> Result<SpawnResult> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows.max(1),
                cols: opts.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty")?;

        let shell = opts.shell.unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&shell);
        // Pick the most plausible cwd, validating each candidate so we
        // never hand the spawn a non-existent directory. On Windows that
        // would cause `CreateProcessW` to exit the shell with code 1
        // almost immediately, leaving the user staring at a blank xterm.
        // Order: explicit cwd → $HOME / %USERPROFILE% → current_dir().
        let chosen_cwd = opts
            .cwd
            .as_deref()
            .filter(|p| std::path::Path::new(p).is_dir())
            .map(|p| p.to_string())
            .or_else(|| {
                std::env::var(home_var())
                    .ok()
                    .filter(|p| std::path::Path::new(p).is_dir())
            })
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            });
        if let Some(ref cwd) = chosen_cwd {
            cmd.cwd(cwd);
            tracing::debug!(cwd = %cwd, "pty cwd");
        } else {
            tracing::warn!("pty spawning without an explicit cwd");
        }
        // Inherit env so PATH/PROMPT/etc work as expected.
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        // ANSI hint for apps that check.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawn shell {:?}", shell))?;

        // Once the child is spawned, drop the slave handle. On *nix this lets
        // the master see EOF when the child exits. On Windows it's a no-op.
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().context("clone reader")?;
        let writer = pair.master.take_writer().context("take writer")?;

        let (data_tx, data_rx) = mpsc::channel::<Vec<u8>>(DATA_CHANNEL_CAP);
        let (exit_tx, exit_rx) = oneshot::channel::<Option<i32>>();

        let id = Uuid::new_v4().to_string();

        // Reader thread: blocking read → Tokio channel.
        {
            let data_tx = data_tx.clone();
            let id_for_log = id.clone();
            std::thread::Builder::new()
                .name(format!("arc-pty-read-{id_for_log}"))
                .spawn(move || {
                    let mut buf = [0u8; READ_BUF_SIZE];
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => {
                                tracing::debug!(id = %id_for_log, "pty reader eof");
                                break;
                            }
                            Ok(n) => {
                                if data_tx.blocking_send(buf[..n].to_vec()).is_err() {
                                    break;
                                }
                            }
                            Err(err) => {
                                tracing::debug!(id = %id_for_log, ?err, "pty reader error");
                                break;
                            }
                        }
                    }
                })
                .context("spawn reader thread")?;
        }

        // Waiter thread: wait on child + emit exit code.
        {
            let id_for_log = id.clone();
            std::thread::Builder::new()
                .name(format!("arc-pty-wait-{id_for_log}"))
                .spawn(move || {
                    let code = match child.wait() {
                        Ok(status) => Some(status.exit_code() as i32),
                        Err(err) => {
                            tracing::warn!(id = %id_for_log, ?err, "pty wait error");
                            None
                        }
                    };
                    let _ = exit_tx.send(code);
                })
                .context("spawn waiter thread")?;
        }

        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        });
        self.sessions.insert(id.clone(), session);

        Ok(SpawnResult { id, data_rx, exit_rx })
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let session = self.sessions.get(id).context("unknown pty session")?;
        let mut writer = session.writer.lock();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = self.sessions.get(id).context("unknown pty session")?;
        let master = session.master.lock();
        master
            .resize(PtySize {
                cols: cols.max(1),
                rows: rows.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize")?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        if let Some((_, session)) = self.sessions.remove(id) {
            let mut killer = session.killer.lock();
            let _ = killer.kill();
        }
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

fn home_var() -> &'static str {
    if cfg!(windows) { "USERPROFILE" } else { "HOME" }
}

/// One shell discovered on the user's `PATH`. Returned by [`discover_shells`].
///
/// `label` is a human-friendly name ("Windows PowerShell", "Zsh"), `path`
/// is the absolute resolved path (suitable to hand back to [`SpawnOptions`]).
/// `is_default` marks the entry that matches the platform default returned
/// by [`default_shell`] (COMSPEC on Windows, $SHELL on Unix).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShellInfo {
    pub label: String,
    pub path: String,
    pub is_default: bool,
}

/// Probe `PATH` for known shells and return what was found. Pure read —
/// nothing is spawned, no env is mutated. Order: most common first
/// (cmd.exe / bash before pwsh / nu) so the picker UI presents a sensible
/// default list.
///
/// Callers should treat the result as advisory: the user can always type
/// a custom path the picker doesn't surface (PowerShell 7 installed
/// somewhere off PATH, an exotic shell, etc).
pub fn discover_shells() -> Vec<ShellInfo> {
    let candidates: &[(&str, &str)] = if cfg!(windows) {
        &[
            ("cmd.exe", "Command Prompt"),
            ("powershell.exe", "Windows PowerShell"),
            ("pwsh.exe", "PowerShell 7"),
            ("bash.exe", "Bash"),
            ("nu.exe", "Nushell"),
            ("wsl.exe", "WSL"),
        ]
    } else {
        &[
            ("bash", "Bash"),
            ("zsh", "Zsh"),
            ("fish", "Fish"),
            ("nu", "Nushell"),
            ("sh", "Sh"),
        ]
    };

    let default = default_shell();
    // `default_shell()` may return a bare command (`cmd.exe`) on Windows.
    // Lowercase + filename-only comparison is friendlier than path-equality
    // for the "is default?" marker.
    let default_name = std::path::Path::new(&default)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| default.to_ascii_lowercase());

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<std::path::PathBuf> = std::env::split_paths(&path_var).collect();

    let mut out = Vec::with_capacity(candidates.len());
    for (exe, label) in candidates {
        let Some(resolved) = which_in(exe, &dirs) else {
            continue;
        };
        let resolved_str = resolved.to_string_lossy().into_owned();
        let is_default = exe.to_ascii_lowercase() == default_name;
        out.push(ShellInfo {
            label: (*label).to_string(),
            path: resolved_str,
            is_default,
        });
    }
    out
}

/// Resolve `exe` against `dirs` the same way the OS PATH search would —
/// no spawn, no fancy globbing. On Windows, an explicit extension wins;
/// otherwise we also try the bare candidate (already includes `.exe` in
/// our `candidates` table).
fn which_in(exe: &str, dirs: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    for dir in dirs {
        let p = dir.join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// One AI coding-agent CLI discovered on `PATH`. Mirrors [`ShellInfo`] but
/// with a stable `id` field so the frontend can map "claude" → the Claude
/// Code provider regardless of where the binary lives.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AiCliInfo {
    /// Stable id used in settings + provider routing
    /// (`"claude-cli"`, `"codex-cli"`, `"opencode-cli"`).
    pub id: String,
    pub label: String,
    pub path: String,
}

/// Probe `PATH` for known AI coding-agent CLIs (Claude Code, OpenAI Codex,
/// OpenCode). Pure read — nothing is spawned, no env is mutated. Each tool
/// may ship multiple binary names across platforms (e.g. `claude.cmd` vs
/// `claude.exe` on Windows); the first match wins.
pub fn discover_ai_clis() -> Vec<AiCliInfo> {
    // (stable id, label, [candidate binaries in preference order])
    let candidates: &[(&str, &str, &[&str])] = if cfg!(windows) {
        &[
            (
                "claude-cli",
                "Claude Code",
                &["claude.cmd", "claude.exe", "claude.bat", "claude"],
            ),
            (
                "codex-cli",
                "OpenAI Codex",
                &["codex.cmd", "codex.exe", "codex.bat", "codex"],
            ),
            (
                "opencode-cli",
                "OpenCode",
                &["opencode.cmd", "opencode.exe", "opencode.bat", "opencode"],
            ),
        ]
    } else {
        &[
            ("claude-cli", "Claude Code", &["claude"]),
            ("codex-cli", "OpenAI Codex", &["codex"]),
            ("opencode-cli", "OpenCode", &["opencode"]),
        ]
    };

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let dirs: Vec<std::path::PathBuf> = std::env::split_paths(&path_var).collect();

    let mut out = Vec::new();
    for (id, label, exes) in candidates {
        for exe in *exes {
            if let Some(resolved) = which_in(exe, &dirs) {
                out.push(AiCliInfo {
                    id: (*id).to_string(),
                    label: (*label).to_string(),
                    path: resolved.to_string_lossy().into_owned(),
                });
                break;
            }
        }
    }
    out
}
