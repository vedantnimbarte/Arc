//! Workspace file search (V0).
//!
//! Walks the root, opens each text file (within size limits), and returns
//! line-level matches for the query. No persistent index: a fresh search
//! re-walks. That's fast enough for typical project repos (~1k files);
//! tantivy with persistent indexing can swap in later behind the same
//! Tauri surface.
//!
//! V0 caveats:
//!   * Substring match (case-insensitive). No fuzzy / token scoring.
//!   * Skip-list for `node_modules`, `target`, `.git`, etc. (see SKIP).
//!   * Files over 256 KiB or with NUL bytes in the first 8 KiB are skipped.

use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

use crate::Result;

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub snippet: String,
    /// Higher = better. V0: filename match boosts; otherwise number of
    /// query occurrences in the line.
    pub score: i32,
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

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_SNIPPET_CHARS: usize = 180;

/// Run `query` against every text file under `root`. Returns up to `limit`
/// hits sorted by descending score, ties broken by path.
pub fn search(root: impl AsRef<Path>, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();

    let mut hits: Vec<SearchHit> = Vec::new();
    let walker = WalkDir::new(root.as_ref())
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
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let path = entry.path().to_path_buf();
        let Ok(bytes) = std::fs::read(&path) else { continue };
        // Binary sniff — same trick the editor uses.
        let sniff_end = bytes.len().min(8192);
        if bytes[..sniff_end].contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };

        let name = entry.file_name().to_string_lossy().to_string();
        let name_lower = name.to_lowercase();
        let name_boost: i32 = if name_lower.contains(&needle) { 10 } else { 0 };

        let mut emitted_for_file = 0usize;
        for (lineno, line) in text.lines().enumerate() {
            let lower = line.to_lowercase();
            let mut idx = 0;
            let mut count = 0;
            while let Some(pos) = lower[idx..].find(&needle) {
                count += 1;
                idx += pos + needle.len();
                if idx >= lower.len() {
                    break;
                }
            }
            if count == 0 {
                continue;
            }
            let snippet = make_snippet(line, &lower, &needle);
            hits.push(SearchHit {
                path: path.to_string_lossy().to_string(),
                name: name.clone(),
                line: (lineno + 1) as u32,
                snippet,
                score: count as i32 + name_boost,
            });
            emitted_for_file += 1;
            // Cheap circuit-break: stop reading this file after we've
            // collected enough across the whole walk. The sort+truncate
            // below still keeps the best.
            if hits.len() > limit.saturating_mul(4) {
                break;
            }
        }

        // Filename-only match (no content hits): still emit one hit so
        // the user can find files by name. Snippet is the first
        // non-empty line.
        if emitted_for_file == 0 && name_boost > 0 {
            let snippet = text
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .to_string();
            hits.push(SearchHit {
                path: path.to_string_lossy().to_string(),
                name: name.clone(),
                line: 1,
                snippet: make_snippet(&snippet, &snippet.to_lowercase(), &needle),
                score: name_boost,
            });
        }

        if hits.len() > limit.saturating_mul(8) {
            break;
        }
    }

    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(limit);
    Ok(hits)
}

/// Trim a long source line to a window centered on the first match.
fn make_snippet(line: &str, lower: &str, needle: &str) -> String {
    let trimmed_line = line.trim_end();
    if trimmed_line.chars().count() <= MAX_SNIPPET_CHARS {
        return trimmed_line.to_string();
    }
    let idx = lower.find(needle).unwrap_or(0);
    let before = MAX_SNIPPET_CHARS / 3;
    let start = idx.saturating_sub(before);
    let end = (start + MAX_SNIPPET_CHARS).min(trimmed_line.len());
    // Walk to char boundaries.
    let safe_start = floor_char_boundary(trimmed_line, start);
    let safe_end = floor_char_boundary(trimmed_line, end);
    let leading = if safe_start > 0 { "…" } else { "" };
    let trailing = if safe_end < trimmed_line.len() { "…" } else { "" };
    format!("{leading}{}{trailing}", &trimmed_line[safe_start..safe_end])
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tempdir() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "arc-search-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            std::process::id(),
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn finds_matches_and_skips_node_modules() {
        let root = tempdir();
        fs::write(root.join("a.rs"), "fn main() { hello_world(); }").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "pub fn hello_world() {}").unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("node_modules/x/y.js"), "// hello_world is everywhere\n").unwrap();

        let hits = search(&root, "hello_world", 10).unwrap();
        // node_modules entry should be excluded; two real hits.
        assert!(hits.len() == 2, "got {} hits", hits.len());
        for h in &hits {
            assert!(!h.path.contains("node_modules"));
        }
    }

    #[test]
    fn empty_query_returns_empty() {
        let root = tempdir();
        fs::write(root.join("a.rs"), "anything").unwrap();
        assert!(search(&root, "", 10).unwrap().is_empty());
        assert!(search(&root, "   ", 10).unwrap().is_empty());
    }

    #[test]
    fn name_match_boosts_score() {
        let root = tempdir();
        fs::write(root.join("hello.txt"), "totally unrelated content\n").unwrap();
        fs::write(root.join("other.txt"), "hello hello\n").unwrap();
        let hits = search(&root, "hello", 10).unwrap();
        assert!(hits.len() >= 1);
        // hello.txt wins because its filename matches (boost +10).
        assert_eq!(hits[0].name, "hello.txt");
    }
}
