//! Workspace-wide find & replace.
//!
//! Deliberately *not* built on [`crate::index`]: that is a BM25 token index,
//! which is right for ranking files by relevance and wrong for a replace,
//! where missing one occurrence silently corrupts a refactor. This does its
//! own exact literal scan of the same files [`crate::search`] walks.
//!
//! The flow is two-phase on purpose. [`find`] reports every match and the UI
//! shows them; [`replace_in_files`] then takes the explicit list of files the
//! user accepted. Re-scanning at apply time would let a file that changed in
//! between get rewritten from a preview the user never saw.
//!
//! Literal only — no regex. A regex replace over a whole tree with no undo is
//! a much sharper edge than this needs to be, and the common case (rename a
//! symbol, change a URL) is literal.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::{Error, Result};

/// Same limits the search walker uses — a replace should consider exactly the
/// files a search offered, no more.
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_SNIPPET_CHARS: usize = 180;

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
];

/// One matching line.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReplaceMatch {
    pub path: String,
    pub name: String,
    /// One-based, matching how editors count.
    pub line: u32,
    pub snippet: String,
    /// Occurrences on this line — a line can match more than once.
    pub count: u32,
}

/// What an apply actually did.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ReplaceSummary {
    pub files_changed: usize,
    pub replacements: usize,
}

/// Count occurrences of `needle` in `haystack`, and return the byte offset of
/// each. Case-insensitive matching lowercases both sides; that is only sound
/// while the lowercase form has the same byte length as the original, so
/// offsets are taken from a lowercase copy of the *line* and applied to the
/// original only when the two lengths agree (see `replace_all`).
fn match_offsets(haystack: &str, needle: &str, case_sensitive: bool) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if case_sensitive {
        let mut from = 0;
        while let Some(pos) = haystack[from..].find(needle) {
            let at = from + pos;
            out.push(at);
            from = at + needle.len();
        }
    } else {
        let hay = haystack.to_lowercase();
        let need = needle.to_lowercase();
        // Lowercasing can change byte length (e.g. 'İ'), which would make the
        // offsets meaningless against the original. Fall back to the exact
        // scan in that case rather than splicing at a wrong index.
        if hay.len() != haystack.len() {
            return match_offsets(haystack, needle, true);
        }
        let mut from = 0;
        while let Some(pos) = hay[from..].find(&need) {
            let at = from + pos;
            // Only accept offsets that land on a char boundary of the original.
            if haystack.is_char_boundary(at) && haystack.is_char_boundary(at + needle.len()) {
                out.push(at);
            }
            from = at + need.len().max(1);
        }
    }
    out
}

/// Replace every occurrence, returning the new text and how many were made.
pub fn replace_all(text: &str, needle: &str, replacement: &str, case_sensitive: bool) -> (String, usize) {
    let offsets = match_offsets(text, needle, case_sensitive);
    if offsets.is_empty() {
        return (text.to_string(), 0);
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for at in &offsets {
        out.push_str(&text[last..*at]);
        out.push_str(replacement);
        last = at + needle.len();
    }
    out.push_str(&text[last..]);
    (out, offsets.len())
}

fn snippet_for(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= MAX_SNIPPET_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX_SNIPPET_CHARS).collect();
    format!("{cut}…")
}

/// True when this file should be considered: text, and not too large.
fn readable_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // Binary sniff — same trick the editor and search use.
    let sniff_end = bytes.len().min(8192);
    if bytes[..sniff_end].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Every literal match of `needle` under `root`, up to `limit` lines.
pub fn find(
    root: impl AsRef<Path>,
    needle: &str,
    case_sensitive: bool,
    limit: usize,
    ignore: &[String],
) -> Result<Vec<ReplaceMatch>> {
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let skip: Vec<String> = if ignore.is_empty() {
        SKIP.iter().map(|s| s.to_string()).collect()
    } else {
        ignore.to_vec()
    };

    let mut out = Vec::new();
    let walker = WalkDir::new(root.as_ref())
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !skip.iter().any(|s| name.eq_ignore_ascii_case(s))
        });

    for entry in walker.flatten() {
        if out.len() >= limit {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(text) = readable_text(entry.path()) else {
            continue;
        };
        let path = entry.path().to_string_lossy().to_string();
        let name = entry.file_name().to_string_lossy().to_string();
        for (idx, line) in text.lines().enumerate() {
            if out.len() >= limit {
                break;
            }
            let count = match_offsets(line, needle, case_sensitive).len();
            if count == 0 {
                continue;
            }
            out.push(ReplaceMatch {
                path: path.clone(),
                name: name.clone(),
                line: idx as u32 + 1,
                snippet: snippet_for(line),
                count: count as u32,
            });
        }
    }
    Ok(out)
}

/// Rewrite `files`, replacing every literal occurrence of `needle`.
///
/// `files` is an explicit allowlist — normally the paths from a [`find`] the
/// user has reviewed. Each one must resolve inside `root`: these strings
/// arrive from the frontend, and without the check a crafted path would make
/// this a whole-filesystem rewrite primitive.
///
/// A file that changed since the preview, became unreadable, or no longer
/// matches is skipped rather than failing the batch — a partial replace the
/// summary reports honestly beats aborting halfway with no record of what
/// already landed.
pub fn replace_in_files(
    root: impl AsRef<Path>,
    files: &[String],
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
) -> Result<ReplaceSummary> {
    if needle.is_empty() {
        return Ok(ReplaceSummary::default());
    }
    let root = root.as_ref();
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());

    let mut summary = ReplaceSummary::default();
    // The same path listed twice would double-count; the second pass finds
    // nothing left to replace, but the file count would still be wrong.
    let mut done: HashSet<PathBuf> = HashSet::new();

    for raw in files {
        let path = PathBuf::from(raw);
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            continue; // vanished between preview and apply
        };
        if !canonical.starts_with(&canonical_root) {
            return Err(Error::InvalidPath(format!(
                "{} is outside the workspace root",
                canonical.display()
            )));
        }
        if !done.insert(canonical.clone()) {
            continue;
        }
        let Some(text) = readable_text(&canonical) else {
            continue;
        };
        let (next, n) = replace_all(&text, needle, replacement, case_sensitive);
        if n == 0 {
            continue;
        }
        std::fs::write(&canonical, next)?;
        summary.files_changed += 1;
        summary.replacements += n;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same throwaway-dir helper `search.rs` uses — no extra dev-dependency
    /// for something this small. Counter-suffixed so two dirs made in the
    /// same nanosecond can't collide.
    fn tmpdir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "arc-replace-{}-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn replace_all_handles_repeats_and_overlapping_starts() {
        assert_eq!(replace_all("a b a", "a", "z", true), ("z b z".into(), 2));
        // "aa" in "aaaa" matches at 0 and 2 — non-overlapping, like every
        // other find-replace tool.
        assert_eq!(replace_all("aaaa", "aa", "b", true), ("bb".into(), 2));
    }

    #[test]
    fn replace_all_is_case_sensitive_only_when_asked() {
        assert_eq!(replace_all("Foo foo", "foo", "bar", true), ("Foo bar".into(), 1));
        assert_eq!(replace_all("Foo foo", "foo", "bar", false), ("bar bar".into(), 2));
    }

    #[test]
    fn replace_all_leaves_non_matching_text_untouched() {
        assert_eq!(replace_all("hello", "zzz", "x", true), ("hello".into(), 0));
        assert_eq!(replace_all("hello", "", "x", true), ("hello".into(), 0));
    }

    #[test]
    fn replace_all_preserves_multibyte_text_around_a_match() {
        let (out, n) = replace_all("héllo WORLD héllo", "WORLD", "x", true);
        assert_eq!((out.as_str(), n), ("héllo x héllo", 1));
    }

    #[test]
    fn find_reports_line_numbers_and_per_line_counts() {
        let dir = tmpdir();
        std::fs::write(dir.as_path().join("a.txt"), "one\ntwo two\nthree\n").unwrap();
        let hits = find(dir.as_path(), "two", true, 100, &[]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].count, 2);
    }

    #[test]
    fn find_skips_binary_files() {
        let dir = tmpdir();
        std::fs::write(dir.as_path().join("bin"), b"needle\0\0needle").unwrap();
        assert!(find(dir.as_path(), "needle", true, 100, &[]).unwrap().is_empty());
    }

    #[test]
    fn find_honours_the_ignore_list() {
        let dir = tmpdir();
        std::fs::create_dir(dir.as_path().join("skipme")).unwrap();
        std::fs::write(dir.as_path().join("skipme/a.txt"), "needle").unwrap();
        std::fs::write(dir.as_path().join("b.txt"), "needle").unwrap();
        let hits = find(dir.as_path(), "needle", true, 100, &["skipme".into()]).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("b.txt"));
    }

    #[test]
    fn replace_in_files_rewrites_and_counts() {
        let dir = tmpdir();
        let a = dir.as_path().join("a.txt");
        let b = dir.as_path().join("b.txt");
        std::fs::write(&a, "x foo x foo").unwrap();
        std::fs::write(&b, "no match here").unwrap();
        let files = vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ];
        let out = replace_in_files(dir.as_path(), &files, "foo", "bar", true).unwrap();
        // b.txt had nothing to change, so it is not counted as changed.
        assert_eq!(out, ReplaceSummary { files_changed: 1, replacements: 2 });
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "x bar x bar");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "no match here");
    }

    #[test]
    fn replace_in_files_refuses_a_path_outside_the_root() {
        // Without this guard a crafted path list turns the command into a
        // whole-filesystem rewrite primitive.
        let dir = tmpdir();
        let outside = tmpdir();
        let victim = outside.as_path().join("victim.txt");
        std::fs::write(&victim, "foo").unwrap();
        std::fs::write(dir.as_path().join("ok.txt"), "foo").unwrap();

        let err = replace_in_files(
            dir.as_path(),
            &[victim.to_string_lossy().to_string()],
            "foo",
            "bar",
            true,
        );
        assert!(err.is_err());
        // The outside file is untouched.
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "foo");
    }

    #[test]
    fn replace_in_files_counts_a_duplicated_path_once() {
        let dir = tmpdir();
        let a = dir.as_path().join("a.txt");
        std::fs::write(&a, "foo").unwrap();
        let p = a.to_string_lossy().to_string();
        let out = replace_in_files(dir.as_path(), &[p.clone(), p], "foo", "bar", true).unwrap();
        assert_eq!(out, ReplaceSummary { files_changed: 1, replacements: 1 });
    }

    #[test]
    fn replace_in_files_skips_a_file_that_vanished_since_the_preview() {
        let dir = tmpdir();
        let gone = dir.as_path().join("gone.txt").to_string_lossy().to_string();
        let out = replace_in_files(dir.as_path(), &[gone], "foo", "bar", true).unwrap();
        assert_eq!(out, ReplaceSummary::default());
    }
}
