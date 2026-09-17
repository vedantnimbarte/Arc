//! arc-filesystem — filesystem reads + a notify-based directory watcher.
//!
//! The Tauri `fs_*` commands in `apps/desktop` are thin wrappers that
//! delegate to the functions exposed here.

pub mod dir;
pub mod dialog;
pub mod file;
pub mod listing;
pub mod paths;
pub mod replace;
pub mod search;
pub mod watch;

pub use dir::{read_dir, DirEntry};
pub use dialog::{pick_files, pick_folder, pick_save_file};
pub use file::{read_file, write_file, MAX_EDITOR_BYTES};
pub use listing::{list_files, FileItem};
pub use paths::{default_root, parent, scratch_file};
pub use replace::{find as find_literal, replace_in_files, ReplaceMatch, ReplaceSummary};
pub use search::{grep_args, parse_grep_z, parse_rg_json, rg_args, search as search_files, SearchHit};
pub use listing::{find_args, rank_remote_listing};
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
    #[error("invalid path: {0}")]
    InvalidPath(String),
}

pub type Result<T> = std::result::Result<T, Error>;
