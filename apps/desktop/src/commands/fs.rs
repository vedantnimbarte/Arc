//! Tauri command surface for lightweight filesystem reads used by the
//! file-tree panel. This is intentionally minimal — anything heavier
//! (indexing, watch, search) belongs in the dedicated `arc-filesystem`
//! crate once it's beyond stub.
//!
//! Frontend contract:
//!   invoke("fs_default_root")           -> String
//!   invoke("fs_read_dir", { path })     -> Vec<DirEntry>
//!   invoke("fs_parent",   { path })     -> Option<String>
//!   invoke("fs_pick_folder")            -> Option<String>
//!   invoke("fs_read_file", { path })    -> String (utf-8)
//!   invoke("fs_write_file", { path, content }) -> ()

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "dir" | "file" | "symlink"
    pub hidden: bool,
}

/// User's home directory, with sensible cross-platform fallbacks.
#[tauri::command]
pub async fn fs_default_root() -> Result<String, String> {
    if let Ok(p) = std::env::var("USERPROFILE") {
        if Path::new(&p).is_dir() {
            return Ok(p);
        }
    }
    if let Ok(p) = std::env::var("HOME") {
        if Path::new(&p).is_dir() {
            return Ok(p);
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("could not resolve a default root: {e}"))
}

/// Parent of `path` if one exists, otherwise None (top of the volume).
#[tauri::command]
pub async fn fs_parent(path: String) -> Result<Option<String>, String> {
    let p = PathBuf::from(&path);
    Ok(p.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string()))
}

/// One directory level. Folders first, then files, both alphabetical
/// (case-insensitive). Anything we can't read silently drops — the panel
/// should never crash because of a single permission error.
#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let read = std::fs::read_dir(&path).map_err(|e| format!("read_dir({path}): {e}"))?;

    let mut out: Vec<DirEntry> = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let hidden = name.starts_with('.');
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

/// Maximum file size the editor will load. Anything bigger should go
/// through a streaming/paged viewer, which is out of scope for now.
const MAX_EDITOR_BYTES: u64 = 5 * 1024 * 1024;

/// Read a text file as UTF-8. Returns a friendly error if the file is
/// too large or appears to be binary (heuristic: contains a NUL byte
/// inside the first 8 KiB).
#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    if meta.len() > MAX_EDITOR_BYTES {
        return Err(format!(
            "file is too large ({:.1} MiB; editor caps at {:.0} MiB)",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_EDITOR_BYTES as f64 / (1024.0 * 1024.0),
        ));
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("read: {e}"))?;
    let sample_end = bytes.len().min(8192);
    if bytes[..sample_end].contains(&0) {
        return Err("binary file (contains NUL bytes)".into());
    }

    String::from_utf8(bytes).map_err(|e| format!("not valid utf-8: {e}"))
}

/// Atomically overwrite `path` with `content` (UTF-8). Refuses to write
/// to anything that exists and isn't a regular file, so symlinks to
/// devices / sockets stay safe.
#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    if let Ok(meta) = std::fs::metadata(&path) {
        if !meta.is_file() {
            return Err("refusing to write: target exists and is not a regular file".into());
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("write: {e}"))
}

/// Open the native folder picker. Returns the chosen path or None if
/// cancelled. Runs the dialog on a blocking thread because rfd's sync
/// picker handles modality + cross-platform parenting more reliably
/// than the async variant inside Tauri's runtime.
#[tauri::command]
pub async fn fs_pick_folder(starting: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Choose folder");
        if let Some(start) = starting.as_ref() {
            if Path::new(start).is_dir() {
                dialog = dialog.set_directory(start);
            }
        }
        dialog.pick_folder().map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))
}
