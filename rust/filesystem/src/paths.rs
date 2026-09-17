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

/// Create a fresh, empty scratch file in `dir` (ARC passes
/// `<arc data dir>/scratch`) and return its path.
///
/// Scratch buffers are real files on disk rather than an in-memory tab kind.
/// That is the whole trick: the editor, its LSP attachment, save, syntax
/// highlighting and session restore all work with no changes, because from
/// their side nothing is special about the file. The only thing ARC adds is
/// picking the name and the directory.
///
/// `ext` is the language suffix without the dot (`md`, `sql`, `py`, ...).
/// Anything that is not alphanumeric is rejected rather than sanitised — it
/// arrives from the renderer and ends up in a filesystem path.
pub fn scratch_file(dir: &Path, ext: &str) -> Result<String> {
    if ext.is_empty() || ext.len() > 12 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Error::InvalidPath(format!("bad scratch extension: {ext}")));
    }
    std::fs::create_dir_all(dir)?;

    // First free `scratch-N.<ext>`. Numbering restarts from 1 as old scratches
    // are deleted, which is what makes the tab titles stay short. `create_new`
    // is the race guard: two windows asking at once get different files rather
    // than one silently truncating the other's.
    for n in 1..1000 {
        let candidate = dir.join(format!("scratch-{n}.{ext}"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate.to_string_lossy().to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Error::Io(e)),
        }
    }
    Err(Error::InvalidPath(
        "1000 scratch files already exist — clear some out".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_rejects_extensions_that_could_escape_the_directory() {
        // `ext` arrives from the renderer and lands in a filesystem path.
        for bad in ["", "../evil", "md/../..", "a b", "sh;rm", "verylongextension"] {
            assert!(
                scratch_file(&std::env::temp_dir(), bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn scratch_creates_distinct_empty_files() {
        let dir = std::env::temp_dir().join(format!("arc-scratch-test-{}", std::process::id()));
        let a = scratch_file(&dir, "md").expect("first scratch");
        let b = scratch_file(&dir, "md").expect("second scratch");
        assert_ne!(a, b, "each call gets its own file");
        assert!(a.ends_with(".md") && b.ends_with(".md"));
        assert_eq!(std::fs::read_to_string(&a).expect("readable"), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
