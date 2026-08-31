//! Run a program to completion and hand back its captured output.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("proc_run", { cwd, program, args, timeoutMs }) -> ProcOutput
//!
//! Used by the test explorer, which needs a test runner's exit code and
//! output as *data* — a PTY tab gives the user a pretty view but nothing the
//! UI can turn into a pass/fail tree.
//!
//! This is a general "run a program" surface, so it's worth being explicit
//! about what it does and doesn't widen: the renderer already has
//! `pty_spawn`, which takes an arbitrary `shell` path plus `args`, so any
//! code that can call this could already have run the same program. The new
//! capability here is output capture, not execution.

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::process::Command;

/// Cap on captured output per stream. A runner that dumps a gigabyte of logs
/// must not take the app's memory with it.
const MAX_CAPTURE: usize = 2 * 1024 * 1024;

/// Ceiling on the caller-supplied timeout — 10 minutes is longer than any
/// test suite anyone will sit and watch inside a side panel.
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Serialize)]
pub struct ProcOutput {
    /// Exit status, or `None` if the process was killed by a signal or the
    /// timeout below.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    /// True when either stream hit [`MAX_CAPTURE`] and was cut short.
    pub truncated: bool,
}

fn clamp(mut bytes: Vec<u8>, truncated: &mut bool) -> String {
    if bytes.len() > MAX_CAPTURE {
        bytes.truncate(MAX_CAPTURE);
        *truncated = true;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tauri::command]
pub async fn proc_run(
    cwd: String,
    program: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<ProcOutput, String> {
    if program.trim().is_empty() {
        return Err("no program given".to_string());
    }
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, MAX_TIMEOUT_MS),
    );

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Reap the child if we bail out early (timeout) rather than leaving
        // a detached test runner chewing CPU.
        .kill_on_drop(true);
    // No console flash on Windows — same reasoning as `arc_git::git_cmd`.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let started = Instant::now();
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not run `{program}`: {e}"))?;

    let mut truncated = false;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(ProcOutput {
            code: out.status.code(),
            stdout: clamp(out.stdout, &mut truncated),
            stderr: clamp(out.stderr, &mut truncated),
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out: false,
            truncated,
        }),
        Ok(Err(e)) => Err(format!("`{program}` failed: {e}")),
        Err(_) => Ok(ProcOutput {
            code: None,
            stdout: String::new(),
            // The child is killed by `kill_on_drop` as the future unwinds, so
            // whatever it had written is gone — say why rather than returning
            // two empty streams and a bare `timed_out`.
            stderr: format!("timed out after {}s", timeout.as_secs()),
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out: true,
            truncated: false,
        }),
    }
}
