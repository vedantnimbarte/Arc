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
    ignore: &[String],
) -> Result<Vec<FileItem>> {
    let root = root.as_ref();
    let needle = query.trim().to_lowercase();
    let mut scored: Vec<(i32, FileItem)> = Vec::new();
    let mut walked = 0usize;

    // Empty override falls back to the built-in defaults so an unhydrated
    // setting never floods the picker with dependency folders.
    let skip: Vec<String> = if ignore.is_empty() {
        SKIP.iter().map(|s| s.to_string()).collect()
    } else {
        ignore.to_vec()
    };

    let walker = WalkDir::new(root)
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !skip.iter().any(|s| name.eq_ignore_ascii_case(s))
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
        let Some(score) = score_file(&rel, &name_lower, &needle) else {
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

    Ok(rank(scored, limit))
}

fn rank(mut scored: Vec<(i32, FileItem)>, limit: usize) -> Vec<FileItem> {
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.rel.cmp(&b.1.rel)));
    scored.truncate(limit);
    scored.into_iter().map(|(_, it)| it).collect()
}

/// Where the match landed, or `None` for no match. `rel` uses `/`.
fn score_file(rel: &str, name_lower: &str, needle: &str) -> Option<i32> {
    let rel_lower = rel.to_lowercase();
    Some(if needle.is_empty() {
        // No query: prefer shallow files (shorter relative path).
        1_000 - rel.matches('/').count() as i32
    } else if name_lower == needle {
        500
    } else if name_lower.starts_with(needle) {
        400
    } else if rel_lower.starts_with(needle) {
        350
    } else if name_lower.contains(needle) {
        250
    } else if rel_lower.contains(needle) {
        150
    } else {
        return None;
    })
}

/// `find` argv listing every file under `.` for a remote workspace, pruning
/// the ignore list. The caller caps the output at [`MAX_WALK`] lines.
pub fn find_args(ignore: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec!["find".into(), ".".into(), "(".into()];
    let skip: Vec<String> = if ignore.is_empty() {
        SKIP.iter().map(|s| s.to_string()).collect()
    } else {
        ignore.to_vec()
    };
    for (i, dir) in skip.iter().enumerate() {
        if i > 0 {
            args.push("-o".into());
        }
        args.push("-name".into());
        args.push(dir.clone());
    }
    args.extend(
        [")", "-prune", "-o", "-type", "f", "-print"]
            .iter()
            .map(|s| s.to_string()),
    );
    args
}

/// Rank [`find_args`] output (one `./rel` per line) exactly as [`list_files`]
/// ranks a local walk. `root` is the absolute POSIX root it ran in.
pub fn rank_remote_listing(root: &str, stdout: &str, query: &str, limit: usize) -> Vec<FileItem> {
    let needle = query.trim().to_lowercase();
    let root = root.trim_end_matches('/');
    let scored = stdout
        .lines()
        .take(MAX_WALK)
        .filter_map(|line| {
            let rel = line.strip_prefix("./")?;
            let name = rel.rsplit('/').next().unwrap_or(rel);
            let score = score_file(rel, &name.to_lowercase(), &needle)?;
            Some((
                score,
                FileItem {
                    path: format!("{root}/{rel}"),
                    name: name.to_string(),
                    rel: rel.to_string(),
                },
            ))
        })
        .collect();
    rank(scored, limit)
}

#[cfg(test)]
mod remote_tests {
    use super::*;

    #[test]
    fn ranks_find_output_like_a_local_walk() {
        let out = "./src/test_a.py\n./test.py\n./docs/notes.md\n.\n./a dir/it's test.rs\n";
        let items = rank_remote_listing("/srv/app/", out, "test", 10);
        let rels: Vec<&str> = items.iter().map(|i| i.rel.as_str()).collect();
        // Name-prefix matches tie at 400 and fall back to path order.
        assert_eq!(rels, vec!["src/test_a.py", "test.py", "a dir/it's test.rs"]);
        assert_eq!(items[1].path, "/srv/app/test.py");
        assert_eq!(items[2].name, "it's test.rs");
    }

    #[test]
    fn find_args_prune_the_ignore_list() {
        let args = find_args(&["a".into(), "-b".into()]);
        assert_eq!(
            args,
            vec!["find", ".", "(", "-name", "a", "-o", "-name", "-b", ")", "-prune", "-o", "-type", "f", "-print"]
        );
    }
}
