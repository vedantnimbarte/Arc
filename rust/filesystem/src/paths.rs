//! Cross-platform path resolution helpers.

use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// User's home directory, with cross-platform fallbacks.
pub fn default_root() -> Result<String> {
    if let Some(home) = dirs::home_dir() {
        if home.is_dir() {
            return Ok(home.to_string_lossy().to_string());
        }
    }
    // Last resort: whatever the process was started in.
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| Error::NoDefaultRoot)
}

/// Parent of `path` if one exists, otherwise None (top of the volume).
pub fn parent(path: impl AsRef<Path>) -> Option<String> {
    let p = PathBuf::from(path.as_ref());
    p.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string())
}
