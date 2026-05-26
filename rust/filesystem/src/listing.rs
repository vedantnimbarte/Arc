//! Lightweight workspace file-name listing for the @-mention picker.
//!
//! Walks `root` (skipping the same noisy dirs as `search`), filters by
//! case-insensitive name substring, ranks by where the match landed
//! (prefix > word-boundary > anywhere) and returns up to `limit` entries.

use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

use crate::Result;

#[derive(Debug, Clone, Serialize)]
pub struct FileItem {
    pub path: String,
    pub name: String,
    /// Path relative to `root` with forward slashes. Useful for display.
    pub rel: String,
}

const SKIP: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".turbo",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".cargo",
    ".idea",
    ".vscode",
    "vendor",
    ".DS_Store",
];

const MAX_WALK: usize = 8000;

pub fn list_files(
    root: impl AsRef<Path>,
    query: &str,
    limit: usize,
) -> Result<Vec<FileItem>> {
    let root = root.as_ref();
    let needle = query.trim().to_lowercase();
    let mut scored: Vec<(i32, FileItem)> = Vec::new();
    let mut walked = 0usize;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !SKIP.iter().any(|s| name.eq_ignore_ascii_case(s))
        });

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        walked += 1;
        if walked > MAX_WALK {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let name_lower = name.to_lowercase();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let rel_lower = rel.to_lowercase();

        let score = if needle.is_empty() {
            // No query: prefer shallow files (shorter relative path).
            1_000 - rel.matches('/').count() as i32
        } else if name_lower == needle {
            500
        } else if name_lower.starts_with(&needle) {
            400
        } else if rel_lower.starts_with(&needle) {
            350
        } else if name_lower.contains(&needle) {
            250
        } else if rel_lower.contains(&needle) {
            150
        } else {
            continue;
        };

        scored.push((
            score,
            FileItem {
                path: path.to_string_lossy().to_string(),
                name,
                rel,
            },
        ));
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.rel.cmp(&b.1.rel)));
    scored.truncate(limit);
    Ok(scored.into_iter().map(|(_, it)| it).collect())
}
