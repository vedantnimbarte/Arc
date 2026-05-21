//! Directory listing — one level at a time, folders before files,
//! alphabetical (case-insensitive). Anything we can't read silently
//! drops; the file-tree should never crash on a single permission error.

use serde::Serialize;
use std::path::Path;

use crate::Result;

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    /// "dir" | "file" | "symlink".
    pub kind: String,
    pub hidden: bool,
}

pub fn read_dir(path: impl AsRef<Path>) -> Result<Vec<DirEntry>> {
    let path = path.as_ref();
    let read = std::fs::read_dir(path)?;

    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let hidden = name.starts_with('.') || is_os_hidden(&meta);
        let kind = if meta.is_dir() {
            "dir"
        } else if meta.file_type().is_symlink() {
            "symlink"
        } else {
            "file"
        };
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            kind: kind.to_string(),
            hidden,
        });
    }

    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", k) if k != "dir" => std::cmp::Ordering::Less,
        (k, "dir") if k != "dir" => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(out)
}

#[cfg(windows)]
fn is_os_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    let attrs = meta.file_attributes();
    (attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) != 0
}

#[cfg(not(windows))]
fn is_os_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}
