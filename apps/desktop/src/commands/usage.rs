//! Tauri command surface for AI usage stats.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("usage_cli_fetch", { id })                         -> CliUsageResult
//!   invoke("usage_api_fetch", { kind, apiKey, baseUrl? })     -> UsageReport
//!
//! `usage_cli_fetch` shells out to a detected AI coding CLI (Claude Code,
//! Codex, …) with a hardcoded usage subcommand and returns the captured
//! output verbatim — the frontend parses it best-effort and shows the raw
//! text when parsing fails. `usage_api_fetch` proxies to
//! `arc_ai_runtime::fetch_usage` for cloud provider usage reporting.

use std::process::Stdio;
use std::time::Duration;

use arc_ai_runtime::{fetch_usage, UsageProvider, UsageReport};
use arc_pty::discover_ai_clis;
use serde::Serialize;
use tokio::process::Command;

/// Wall-clock cap for a usage CLI invocation. `claude -p` may make a network
/// round-trip, so this is generous, but bounded so a hung CLI can't wedge the
/// settings pane.
const CLI_TIMEOUT_S: u64 = 15;
/// Cap captured stdout/stderr so a chatty CLI can't bloat the IPC payload.
const OUTPUT_CAP: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUsageResult {
    /// Stable CLI id from `discover_ai_clis` (`"claude-cli"`, `"codex-cli"`, …).
    pub id: String,
    pub label: String,
    /// Human-readable command we ran (or would run), e.g. `claude -p /usage`.
    pub command: String,
    /// Whether the binary was found on PATH.
    pub installed: bool,
    /// Whether we have a known usage command for this CLI.
    pub supported: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Hardcoded usage subcommand per CLI id. `None` → no known usage command
/// (the UI shows a "no usage command available" state).
fn usage_args(id: &str) -> Option<&'static [&'static str]> {
    match id {
        "claude-cli" => Some(&["-p", "/usage"]),
        "codex-cli" => Some(&["status", "--json"]),
        // OpenCode / Kimi have no documented usage subcommand yet.
        _ => None,
    }
}

fn truncate(mut s: String) -> String {
    if s.len() > OUTPUT_CAP {
        let mut end = OUTPUT_CAP;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str("\n… (truncated)");
    }
    s
}

#[tauri::command]
pub async fn usage_cli_fetch(id: String) -> Result<CliUsageResult, String> {
    let cli = discover_ai_clis().into_iter().find(|c| c.id == id);
    let args = usage_args(&id);
    let supported = args.is_some();

    // Build a friendly command label regardless of install/support state.
    let bin = cli
        .as_ref()
        .map(|c| c.path.clone())
        .unwrap_or_else(|| id.trim_end_matches("-cli").to_string());
    let command = match args {
        Some(a) => format!("{} {}", short_bin(&bin), a.join(" ")),
        None => short_bin(&bin),
    };
    let label = cli.as_ref().map(|c| c.label.clone()).unwrap_or_else(|| id.clone());

    let Some(cli) = cli else {
        return Ok(CliUsageResult {
            id,
            label,
            command,
            installed: false,
            supported,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            timed_out: false,
        });
    };

    let Some(args) = args else {
        return Ok(CliUsageResult {
            id,
            label,
            command,
            installed: true,
            supported: false,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            timed_out: false,
        });
    };

    let mut cmd = Command::new(&cli.path);
    cmd.args(args);
    cmd.stdin(Stdio::null());

    let output = tokio::time::timeout(Duration::from_secs(CLI_TIMEOUT_S), cmd.output()).await;
    match output {
        Err(_) => Ok(CliUsageResult {
            id,
            label,
            command,
            installed: true,
            supported: true,
            stdout: String::new(),
            stderr: format!("command timed out after {CLI_TIMEOUT_S}s"),
            exit_code: None,
            timed_out: true,
        }),
        Ok(Err(e)) => Err(format!("spawn {}: {e}", cli.path)),
        Ok(Ok(out)) => Ok(CliUsageResult {
            id,
            label,
            command,
            installed: true,
            supported: true,
            stdout: truncate(String::from_utf8_lossy(&out.stdout).into_owned()),
            stderr: truncate(String::from_utf8_lossy(&out.stderr).into_owned()),
            exit_code: out.status.code(),
            timed_out: false,
        }),
    }
}

/// Show just the binary filename in the command label, not the full path.
fn short_bin(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string())
}

#[tauri::command]
pub async fn usage_api_fetch(
    kind: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<UsageReport, String> {
    let provider = UsageProvider::from_kind(&kind)
        .ok_or_else(|| format!("no usage API for provider kind: {kind}"))?;
    fetch_usage(provider, &api_key, base_url.as_deref())
        .await
        .map_err(|e| e.to_string())
}
