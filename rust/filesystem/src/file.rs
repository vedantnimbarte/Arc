//! Single-file reads + writes for the editor.

use std::path::Path;

use crate::{Error, Result};

/// Cap for editor-driven file loads. Anything bigger should go through a
/// streaming/paged viewer, which is out of scope for now.
pub const MAX_EDITOR_BYTES: u64 = 5 * 1024 * 1024;

/// Read a text file as UTF-8. Returns a friendly error if the file is
/// too large or appears to be binary (heuristic: a NUL byte inside the
/// first 8 KiB).
pub fn read_file(path: impl AsRef<Path>) -> Result<String> {
    let path = path.as_ref();
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(Error::NotARegularFile);
    }
    if meta.len() > MAX_EDITOR_BYTES {
        return Err(Error::TooLarge {
            size_mib: meta.len() as f64 / (1024.0 * 1024.0),
            cap_mib: MAX_EDITOR_BYTES as f64 / (1024.0 * 1024.0),
        });
    }

    let bytes = std::fs::read(path)?;
    let sample_end = bytes.len().min(8192);
    if bytes[..sample_end].contains(&0) {
        return Err(Error::Binary);
    }

    Ok(String::from_utf8(bytes)?)
}

/// Overwrite `path` with `content` (UTF-8). Refuses to write to anything
/// that exists and isn't a regular file, so symlinks to devices / sockets
/// stay safe.
pub fn write_file(path: impl AsRef<Path>, content: &str) -> Result<()> {
    let path = path.as_ref();
    if let Ok(meta) = std::fs::metadata(path) {
        if !meta.is_file() {
            return Err(Error::NotARegularFile);
        }
    }
    std::fs::write(path, content)?;
    Ok(())
}
