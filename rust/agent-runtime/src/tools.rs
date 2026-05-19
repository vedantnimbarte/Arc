//! Tool implementations the agent can call.
//!
//! V0 was read-only (`fs_read_file`, `fs_search`). V1 adds mutating tools
//! (`fs_write_file`, `shell`) which must be approved by the user before
//! they run — see `requires_approval()` and the `Approver` plumbed through
//! the runtime in `lib.rs`.

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::process::Command;

/// Default cap on a shell command's wall-clock runtime, in seconds. Kept
/// conservative — the agent shouldn't be spinning up dev servers.
const SHELL_DEFAULT_TIMEOUT_S: u64 = 30;
/// Hard upper-bound the model can request via the `timeout_s` argument.
const SHELL_MAX_TIMEOUT_S: u64 = 120;
/// Cap on captured output before truncation. Output gets returned as a
/// tool_result so we want it small enough to fit in a follow-up turn.
const SHELL_OUTPUT_CAP: usize = 16 * 1024;

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    /// Anthropic-style tool definition (returned as one entry of the
    /// `tools` array on a /messages request).
    fn schema(&self) -> Value;
    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String>;
    /// When `true`, the runtime emits an `ApprovalRequest` event and
    /// blocks the call until the UI grants permission. Defaults to `false`
    /// for read-only tools.
    fn requires_approval(&self) -> bool {
        false
    }
}

pub struct FsReadFileTool;

#[async_trait]
impl Tool for FsReadFileTool {
    fn name(&self) -> &str {
        "fs_read_file"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "fs_read_file",
            "description":
                "Read the full contents of a text file. Use absolute paths, or paths \
                 relative to the workspace root. Returns UTF-8 text. Errors if the file \
                 is missing, binary, or larger than 5 MiB.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path, or relative to the workspace root."
                    }
                },
                "required": ["path"]
            }
        })
    }

    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let raw = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `path`".to_string())?;
        let resolved = resolve_path(raw, workspace_root);
        let path = resolved.clone();
        tokio::task::spawn_blocking(move || arc_filesystem::read_file(&path))
            .await
            .map_err(|e| format!("task: {e}"))?
            .map_err(|e| format!("read {}: {e}", resolved.display()))
    }
}

pub struct FsSearchTool;

#[async_trait]
impl Tool for FsSearchTool {
    fn name(&self) -> &str {
        "fs_search"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "fs_search",
            "description":
                "Substring-search the workspace's text files. Returns up to `limit` \
                 ranked hits, each with file path, line number, and a short snippet. \
                 Use this before reading files to locate where a symbol or string lives.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": {
                        "type": "integer",
                        "description": "Max hits. Default 25, capped at 100.",
                        "default": 25
                    }
                },
                "required": ["query"]
            }
        })
    }

    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let query = input
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `query`".to_string())?
            .to_string();
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(25)
            .min(100) as usize;
        let root = workspace_root
            .ok_or_else(|| "no workspace root configured".to_string())?
            .to_string();

        let hits = tokio::task::spawn_blocking(move || arc_filesystem::search_files(&root, &query, limit))
            .await
            .map_err(|e| format!("task: {e}"))?
            .map_err(|e| format!("search: {e}"))?;

        // Render as a compact markdown list — the model handles markdown
        // gracefully and it's cheaper than a JSON dump.
        if hits.is_empty() {
            return Ok("(no matches)".to_string());
        }
        let mut out = String::new();
        for h in hits {
            out.push_str(&format!("- `{}:{}` — {}\n", h.path, h.line, h.snippet));
        }
        Ok(out)
    }
}

// ─── Mutating tools (V1, approval-gated) ──────────────────────────────────

pub struct FsWriteFileTool;

#[async_trait]
impl Tool for FsWriteFileTool {
    fn name(&self) -> &str {
        "fs_write_file"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "fs_write_file",
            "description":
                "Write the given content to a file, replacing it if it exists. Creates \
                 parent directories as needed. Use absolute paths or paths relative to \
                 the workspace root. The user must approve every write — describe your \
                 intent in plain prose before calling so they know what they're \
                 approving.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path":    { "type": "string", "description": "Absolute or workspace-relative path." },
                    "content": { "type": "string", "description": "Full file contents to write (UTF-8 text)." }
                },
                "required": ["path", "content"]
            }
        })
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let raw = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `path`".to_string())?;
        let content = input
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `content`".to_string())?
            .to_string();
        let resolved = resolve_path(raw, workspace_root);
        let path = resolved.clone();
        let len = content.len();
        tokio::task::spawn_blocking(move || arc_filesystem::write_file(&path, &content))
            .await
            .map_err(|e| format!("task: {e}"))?
            .map_err(|e| format!("write {}: {e}", resolved.display()))?;
        Ok(format!("wrote {} bytes to {}", len, resolved.display()))
    }
}

pub struct ShellTool;

#[async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "shell",
            "description":
                "Run a one-shot shell command. Returns combined stdout/stderr (truncated \
                 to 16 KiB) and the exit code. The user must approve every command — \
                 keep them short and ideally read-only; avoid long-running processes. \
                 Default timeout is 30s; pass `timeout_s` up to 120 to extend.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command":   { "type": "string", "description": "Command to execute via the system shell." },
                    "cwd":       { "type": "string", "description": "Optional working directory (defaults to workspace root)." },
                    "timeout_s": { "type": "integer", "description": "Wall-clock cap in seconds (1..=120, default 30)." }
                },
                "required": ["command"]
            }
        })
    }

    fn requires_approval(&self) -> bool {
        true
    }

    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let command = input
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `command`".to_string())?
            .to_string();
        let cwd = input
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| workspace_root.map(|s| s.to_string()));
        let timeout = input
            .get("timeout_s")
            .and_then(|v| v.as_u64())
            .unwrap_or(SHELL_DEFAULT_TIMEOUT_S)
            .clamp(1, SHELL_MAX_TIMEOUT_S);

        // Native shell choice mirrors the PTY default — `cmd /C` on Windows,
        // `sh -c` elsewhere. The model targets POSIX-ish syntax; on Windows
        // it should prefer `pwsh -Command` explicitly if needed.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&command);
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c").arg(&command);
            c
        };
        if let Some(dir) = cwd.as_ref() {
            cmd.current_dir(dir);
        }
        cmd.stdin(std::process::Stdio::null());

        let run = cmd.output();
        let output = tokio::time::timeout(Duration::from_secs(timeout), run)
            .await
            .map_err(|_| format!("command timed out after {timeout}s"))?
            .map_err(|e| format!("spawn: {e}"))?;

        let mut combined = String::new();
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        if !output.stderr.is_empty() {
            if !combined.is_empty() && !combined.ends_with('\n') {
                combined.push('\n');
            }
            combined.push_str("--- stderr ---\n");
            combined.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        let truncated = if combined.len() > SHELL_OUTPUT_CAP {
            format!(
                "{}\n… (truncated, {} bytes total)",
                &combined[..SHELL_OUTPUT_CAP],
                combined.len()
            )
        } else {
            combined
        };

        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());

        Ok(format!("exit {code}\n{truncated}"))
    }
}

/// Resolve a path the model emits: absolute paths pass through; relative
/// paths are joined onto the workspace root when one is available.
fn resolve_path(raw: &str, workspace_root: Option<&str>) -> PathBuf {
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        return p;
    }
    match workspace_root {
        Some(root) => PathBuf::from(root).join(p),
        None => p,
    }
}
