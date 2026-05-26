//! Per-project `.arc/` config — a small TOML file living at the workspace
//! root that lets a project nail down its preferred shell, theme, default
//! environment variables, custom agents, and MCP server registrations.
//!
//! Schema (current = 1):
//!
//! ```toml
//! schema = 1
//!
//! [workspace]
//! name = "my-project"
//!
//! [env]
//! DEBUG = "true"
//! DATABASE_URL = "postgres://localhost/dev"
//!
//! [[agents]]
//! id = "review-buddy"
//! label = "Review Buddy"
//! prompt = "You review code carefully…"
//!
//! [[mcp_servers]]
//! id = "github"
//! command = ["mcp-server-github"]
//! # OR
//! # url = "https://example.com/mcp"
//!
//! [terminal]
//! default_shell = "bash"
//!
//! [theme]
//! id = "catppuccin-mocha"
//! ```
//!
//! The loader is intentionally permissive: every field is optional, unknown
//! keys are ignored, and a missing file returns `Ok(None)` rather than an
//! error. The intent is that a project can grow its `.arc/config.toml`
//! incrementally without breaking older ARC versions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("unsupported schema version: {0}")]
    UnsupportedSchema(u32),
}

/// Latest supported schema version. Bump when fields require a migration.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ProjectConfig {
    /// `schema = 1` — versioned so future loaders can refuse files newer
    /// than what they understand.
    pub schema: u32,
    pub workspace: Option<WorkspaceMeta>,
    /// Environment variables injected into newly-spawned terminals. Does
    /// NOT mutate the parent process's environment.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Custom chat agents available alongside the built-in personas.
    #[serde(default)]
    pub agents: Vec<AgentDef>,
    /// MCP servers auto-connected when the workspace opens.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerDef>,
    pub terminal: Option<TerminalCfg>,
    pub theme: Option<ThemeCfg>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct WorkspaceMeta {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AgentDef {
    pub id: String,
    pub label: String,
    pub prompt: String,
    /// Optional default model in `<preset>:<model>` form. When set, the
    /// chat picker snaps to this when the agent is selected.
    #[serde(default)]
    pub model: Option<String>,
}

/// MCP server entry — `command` for stdio, `url` for Streamable HTTP. Exactly
/// one of the two should be set. The loader doesn't enforce this (the caller
/// validates when it actually connects), so a half-filled entry is preserved
/// rather than dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct McpServerDef {
    pub id: String,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct TerminalCfg {
    /// Override `defaultShell` for terminals spawned inside this workspace.
    /// Falls back to the global setting when absent.
    pub default_shell: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ThemeCfg {
    /// Theme id (built-in or registered custom). When set, ARC picks this
    /// theme on workspace open; the user can still switch from settings.
    pub id: Option<String>,
}

/// Standard location: `<workspace_root>/.arc/config.toml`.
pub fn config_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".arc").join("config.toml")
}

/// Read + parse `<root>/.arc/config.toml`. Returns:
///   - `Ok(Some(cfg))` on a present, well-formed file
///   - `Ok(None)` when the file simply doesn't exist (the common case)
///   - `Err(_)` only on IO failures we can't characterize as not-found, or
///     on a parse failure that the user needs to see
pub fn load(workspace_root: &Path) -> Result<Option<ProjectConfig>, ConfigError> {
    let path = config_path(workspace_root);
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    let mut cfg: ProjectConfig = toml::from_str(&raw)?;
    if cfg.schema == 0 {
        // A file omitting `schema =` is treated as the current version —
        // friendlier than rejecting it. Bumps that ARE incompatible should
        // require an explicit schema number.
        cfg.schema = SCHEMA_VERSION;
    }
    if cfg.schema > SCHEMA_VERSION {
        return Err(ConfigError::UnsupportedSchema(cfg.schema));
    }
    Ok(Some(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let p = std::env::temp_dir().join(format!(
            "arc-project-config-test-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_file_returns_none() {
        let root = tmp();
        assert!(load(&root).unwrap().is_none());
    }

    #[test]
    fn parses_full_config() {
        let root = tmp();
        std::fs::create_dir_all(root.join(".arc")).unwrap();
        std::fs::write(
            config_path(&root),
            r#"
schema = 1
[workspace]
name = "demo"
[env]
DEBUG = "true"
[[agents]]
id = "reviewer"
label = "Reviewer"
prompt = "Review carefully."
[[mcp_servers]]
id = "github"
command = ["mcp-github"]
[terminal]
default_shell = "bash"
[theme]
id = "catppuccin-mocha"
"#,
        )
        .unwrap();
        let cfg = load(&root).unwrap().unwrap();
        assert_eq!(cfg.schema, 1);
        assert_eq!(cfg.workspace.as_ref().and_then(|w| w.name.as_deref()), Some("demo"));
        assert_eq!(cfg.env.get("DEBUG").map(String::as_str), Some("true"));
        assert_eq!(cfg.agents.len(), 1);
        assert_eq!(cfg.agents[0].id, "reviewer");
        assert_eq!(cfg.mcp_servers.len(), 1);
        assert_eq!(
            cfg.mcp_servers[0].command.as_deref().map(|v| v[0].as_str()),
            Some("mcp-github")
        );
        assert_eq!(cfg.terminal.unwrap().default_shell.as_deref(), Some("bash"));
        assert_eq!(cfg.theme.unwrap().id.as_deref(), Some("catppuccin-mocha"));
    }

    #[test]
    fn empty_file_defaults() {
        let root = tmp();
        std::fs::create_dir_all(root.join(".arc")).unwrap();
        std::fs::write(config_path(&root), "").unwrap();
        let cfg = load(&root).unwrap().unwrap();
        assert_eq!(cfg.schema, SCHEMA_VERSION);
        assert!(cfg.env.is_empty());
        assert!(cfg.agents.is_empty());
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let root = tmp();
        std::fs::create_dir_all(root.join(".arc")).unwrap();
        std::fs::write(
            config_path(&root),
            r#"
schema = 1
mystery = "ignored"

[unknown_table]
also_ignored = true

[env]
FOO = "bar"
"#,
        )
        .unwrap();
        let cfg = load(&root).unwrap().unwrap();
        assert_eq!(cfg.env.get("FOO").map(String::as_str), Some("bar"));
    }

    #[test]
    fn future_schema_rejected() {
        let root = tmp();
        std::fs::create_dir_all(root.join(".arc")).unwrap();
        std::fs::write(config_path(&root), "schema = 999").unwrap();
        let err = load(&root).unwrap_err();
        assert!(matches!(err, ConfigError::UnsupportedSchema(999)));
    }
}
