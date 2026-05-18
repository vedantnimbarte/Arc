//! arc-filesystem — filesystem reads + a notify-based directory watcher.
//!
//! The Tauri `fs_*` commands in `apps/desktop` are thin wrappers that
//! delegate to the functions exposed here. Phase 2+ will add tantivy-backed
//! search; for V0 we just expose what the file tree actually uses today.

pub mod dir;
pub mod dialog;
pub mod file;
pub mod paths;
pub mod watch;

pub use dir::{read_dir, DirEntry};
pub use dialog::pick_folder;
pub use file::{read_file, write_file, MAX_EDITOR_BYTES};
pub use paths::{default_root, parent};
pub use watch::Watcher;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a regular file")]
    NotARegularFile,
    #[error("file too large ({size_mib:.1} MiB; editor caps at {cap_mib:.0} MiB)")]
    TooLarge { size_mib: f64, cap_mib: f64 },
    #[error("binary file (contains NUL bytes)")]
    Binary,
    #[error("not valid utf-8: {0}")]
    NotUtf8(#[from] std::string::FromUtf8Error),
    #[error("could not resolve a default root")]
    NoDefaultRoot,
    #[error("watcher error: {0}")]
    Watch(#[from] notify::Error),
    #[error("dialog task: {0}")]
    Dialog(String),
}

pub type Result<T> = std::result::Result<T, Error>;
