//! Tauri command surface for [`arc_project_config`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("project_config_load", { workspaceRoot }) -> Option<ProjectConfig>
//!
//! A missing `.arc/config.toml` is returned as `null` rather than an error —
//! that's the common case (most workspaces don't bother) and the frontend
//! shouldn't have to distinguish "file not present" from "we couldn't read
//! it." Parse failures and unknown schema versions still surface as errors.

use std::path::PathBuf;

use arc_project_config::{load, ProjectConfig};

#[tauri::command]
pub async fn project_config_load(
    workspace_root: String,
) -> Result<Option<ProjectConfig>, String> {
    let root = PathBuf::from(workspace_root);
    tauri::async_runtime::spawn_blocking(move || load(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
