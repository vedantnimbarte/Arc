//! Tool implementations the agent can call.
//!
//! V0 was read-only (`fs_read_file`, `fs_search`). V1 adds mutating tools
//! (`fs_write_file`, `shell`) which must be approved by the user before
//! they run — see `requires_approval()` and the `Approver` plumbed through
//! the runtime in `lib.rs`.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::process::Command;

/// Largest byte index `<= max` that lands on a UTF-8 char boundary. Slicing
/// `&s[..floor_char_boundary(s, max)]` therefore never panics, even when a
/// multibyte character (accents, CJK, emoji — common in command output and
/// diffs) straddles `max`. Mirrors the unstable `str::floor_char_boundary`.
fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

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
        let resolved = resolve_path(raw, workspace_root)?;
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
        let resolved = resolve_path(raw, workspace_root)?;
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
                &combined[..floor_char_boundary(&combined, SHELL_OUTPUT_CAP)],
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

/// Resolve and CONFINE a model-supplied path to the workspace root. Relative
/// paths join onto the root; absolute paths are accepted only when they fall
/// inside it. `..`/`.` are collapsed lexically (works for not-yet-created
/// files) and any result that escapes the root is refused — this stops a
/// prompt-injected agent from reading/writing outside the workspace (e.g.
/// ~/.ssh, cloud credentials). Symlinks aren't chased; this is
/// defense-in-depth, not a hard sandbox. Comparison is case-sensitive, so an
/// absolute path with different drive-letter casing than the root is refused
/// (the model should prefer workspace-relative paths).
fn resolve_path(raw: &str, workspace_root: Option<&str>) -> Result<PathBuf, String> {
    let root = workspace_root.ok_or_else(|| "no workspace root configured".to_string())?;
    let root = normalize_lexical(Path::new(root));
    let raw_path = Path::new(raw);
    let joined = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        root.join(raw_path)
    };
    let normalized = normalize_lexical(&joined);
    if !normalized.starts_with(&root) {
        return Err(format!(
            "path \"{raw}\" escapes the workspace root and was refused"
        ));
    }
    Ok(normalized)
}

/// Collapse `.` and `..` components without touching the filesystem. Mirrors
/// cargo's `normalize_path`; `..` past the root is a harmless no-op pop.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut components = path.components().peekable();
    let mut ret = if let Some(c @ Component::Prefix(..)) = components.peek().cloned() {
        components.next();
        PathBuf::from(c.as_os_str())
    } else {
        PathBuf::new()
    };
    for component in components {
        match component {
            Component::Prefix(..) => {}
            Component::RootDir => ret.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                ret.pop();
            }
            Component::Normal(c) => ret.push(c),
        }
    }
    ret
}

// ─── V2 tools (still read-only or scoped writes) ──────────────────────────

pub struct FsListDirTool;

#[async_trait]
impl Tool for FsListDirTool {
    fn name(&self) -> &str {
        "fs_list_dir"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "fs_list_dir",
            "description":
                "List entries inside a directory (one level deep). Returns name + kind \
                 (`dir` / `file` / `symlink`). Use this to discover what's in a folder \
                 before reading specific files.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path or path relative to the workspace root."
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
        let resolved = resolve_path(raw, workspace_root)?;
        let path = resolved.clone();
        let entries = tokio::task::spawn_blocking(move || arc_filesystem::read_dir(&path))
            .await
            .map_err(|e| format!("task: {e}"))?
            .map_err(|e| format!("read_dir {}: {e}", resolved.display()))?;
        if entries.is_empty() {
            return Ok("(empty)".to_string());
        }
        let mut out = String::new();
        for e in entries {
            out.push_str(&format!("{}\t{}\n", e.kind, e.name));
        }
        Ok(out)
    }
}

/// Surgical find/replace within an existing file. Avoids round-tripping the
/// entire file through `fs_write_file` for small changes — much cheaper in
/// tokens and produces a smaller diff for the user to approve.
pub struct FsEditTool;

#[async_trait]
impl Tool for FsEditTool {
    fn name(&self) -> &str {
        "fs_edit"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "fs_edit",
            "description":
                "Replace one or more occurrences of an exact substring inside an existing \
                 file. Use this for targeted edits instead of rewriting the whole file. \
                 By default the match must be unique; pass `replace_all: true` to replace \
                 every occurrence. Requires user approval.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path":        { "type": "string", "description": "Absolute or workspace-relative path." },
                    "old_string":  { "type": "string", "description": "Exact substring to find." },
                    "new_string":  { "type": "string", "description": "Replacement text." },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence. Default false (must be unique)." }
                },
                "required": ["path", "old_string", "new_string"]
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
        let old = input
            .get("old_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `old_string`".to_string())?
            .to_string();
        let new = input
            .get("new_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "missing `new_string`".to_string())?
            .to_string();
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let resolved = resolve_path(raw, workspace_root)?;

        let path_for_read = resolved.clone();
        let original = tokio::task::spawn_blocking(move || arc_filesystem::read_file(&path_for_read))
            .await
            .map_err(|e| format!("task: {e}"))?
            .map_err(|e| format!("read {}: {e}", resolved.display()))?;

        if old.is_empty() {
            return Err("`old_string` must not be empty".into());
        }
        let occurrences = original.matches(&old).count();
        if occurrences == 0 {
            return Err(format!("`old_string` not found in {}", resolved.display()));
        }
        if occurrences > 1 && !replace_all {
            return Err(format!(
                "`old_string` matches {occurrences} places; pass replace_all=true or extend the match"
            ));
        }
        let updated = if replace_all {
            original.replace(&old, &new)
        } else {
            original.replacen(&old, &new, 1)
        };
        let len = updated.len();
        let path_for_write = resolved.clone();
        tokio::task::spawn_blocking(move || arc_filesystem::write_file(&path_for_write, &updated))
            .await
            .map_err(|e| format!("task: {e}"))?
            .map_err(|e| format!("write {}: {e}", resolved.display()))?;
        Ok(format!(
            "replaced {occurrences} occurrence(s) in {} ({} bytes)",
            resolved.display(),
            len
        ))
    }
}

// ─── Git tools (read-only) ────────────────────────────────────────────────

pub struct GitStatusTool;

#[async_trait]
impl Tool for GitStatusTool {
    fn name(&self) -> &str {
        "git_status"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "git_status",
            "description":
                "Summarize the workspace's git status — current branch, ahead/behind \
                 counts, and how many files are staged / unstaged / untracked / in \
                 conflict. Returns null when the workspace isn't a git repository.",
            "input_schema": { "type": "object", "properties": {} }
        })
    }

    async fn run(&self, _input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let root = workspace_root.ok_or_else(|| "no workspace root configured".to_string())?;
        match arc_git::status(root).await.map_err(|e| e.to_string())? {
            None => Ok("(not a git repo)".to_string()),
            Some(info) => Ok(format!(
                "branch: {}\nupstream: {}\nahead: {}  behind: {}\nstaged: {}  unstaged: {}  untracked: {}  conflicted: {}\ndirty: {}",
                info.branch.as_deref().unwrap_or("(detached)"),
                info.upstream.as_deref().unwrap_or("(none)"),
                info.ahead,
                info.behind,
                info.staged,
                info.unstaged,
                info.untracked,
                info.conflicted,
                info.dirty,
            )),
        }
    }
}

pub struct GitLogTool;

#[async_trait]
impl Tool for GitLogTool {
    fn name(&self) -> &str {
        "git_log"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "git_log",
            "description":
                "Recent commits from the workspace's git history. Returns up to `limit` \
                 entries (default 20, max 200) with short oid, author, date, and \
                 subject. Pass `path` to restrict to commits touching that file or \
                 directory.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "default": 20 },
                    "path":  { "type": "string", "description": "Optional path filter, workspace-relative." }
                }
            }
        })
    }

    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let root = workspace_root.ok_or_else(|| "no workspace root configured".to_string())?;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .min(200) as usize;
        let path_filter = input
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let opts = arc_git::LogOptions {
            path_filter,
            ..Default::default()
        };
        let entries = arc_git::log(root, limit, &opts)
            .await
            .map_err(|e| e.to_string())?;
        if entries.is_empty() {
            return Ok("(no commits)".to_string());
        }
        let mut out = String::new();
        for e in entries {
            out.push_str(&format!(
                "{}  {} <{}>  {}\n",
                e.short, e.author, e.email, e.subject
            ));
        }
        Ok(out)
    }
}

pub struct GitDiffTool;

#[async_trait]
impl Tool for GitDiffTool {
    fn name(&self) -> &str {
        "git_diff"
    }

    fn schema(&self) -> Value {
        json!({
            "name": "git_diff",
            "description":
                "Unified diff of pending changes. `scope` is `worktree` (unstaged), \
                 `staged` (index vs HEAD), or `head` (everything not yet committed). \
                 Pass `path` to narrow to a single file. Truncated to 32 KiB.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["worktree", "staged", "head"],
                        "default": "worktree"
                    },
                    "path": { "type": "string" }
                }
            }
        })
    }

    async fn run(&self, input: &Value, workspace_root: Option<&str>) -> Result<String, String> {
        let root = workspace_root.ok_or_else(|| "no workspace root configured".to_string())?;
        let scope = match input.get("scope").and_then(|v| v.as_str()).unwrap_or("worktree") {
            "staged" => arc_git::DiffScope::Staged,
            "head" => arc_git::DiffScope::Head,
            _ => arc_git::DiffScope::Worktree,
        };
        let path_filter = input.get("path").and_then(|v| v.as_str());
        let out = arc_git::diff(root, scope, path_filter)
            .await
            .map_err(|e| e.to_string())?;
        if out.is_empty() {
            return Ok("(no changes)".to_string());
        }
        const CAP: usize = 32 * 1024;
        if out.len() > CAP {
            Ok(format!(
                "{}\n… (truncated, {} bytes total)",
                &out[..floor_char_boundary(&out, CAP)],
                out.len()
            ))
        } else {
            Ok(out)
        }
    }
}
