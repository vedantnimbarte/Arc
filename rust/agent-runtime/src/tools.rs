//! Tool implementations the agent can call. V0 ships read-only tools so
//! we can skip approval gating; destructive tools (write_file, run_shell)
//! land with V1 behind an explicit user-approval channel.

use std::path::PathBuf;

use async_trait::async_trait;
use serde_json::{json, Value};

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    /// Anthropic-style tool definition (returned as one entry of the
    /// `tools` array on a /messages request).
    fn schema(&self) -> Value;
    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String>;
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
