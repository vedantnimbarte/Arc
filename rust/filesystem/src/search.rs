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
///
/// `ignore` is the list of directory names to skip (case-insensitive). It's
/// owned by the frontend setting; an empty list falls back to the built-in
/// [`SKIP`] defaults so a missing/unhydrated setting never floods results.
pub fn search(
    root: impl AsRef<Path>,
    query: &str,
    limit: usize,
    ignore: &[String],
) -> Result<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let needle = query.to_lowercase();

    let skip: Vec<String> = if ignore.is_empty() {
        SKIP.iter().map(|s| s.to_string()).collect()
    } else {
        ignore.to_vec()
    };

    let mut hits: Vec<SearchHit> = Vec::new();
    let walker = WalkDir::new(root.as_ref())
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

// ─── remote search ────────────────────────────────────────────────────────
//
// A remote workspace searches on its host: `rg --json` when the host has
// ripgrep, `grep -rnIZ` otherwise. These build the argv (the caller quotes it
// into a shell command) and parse what comes back into the same `SearchHit`s
// the local walk produces, with the same scoring and snippets. Paths come
// back absolute on the host; mapping them to `ssh://` URIs is the caller's.

/// Per-file match cap for the remote tools, mirroring the local walk's
/// circuit break so one minified bundle can't fill the result set.
const REMOTE_MAX_PER_FILE: &str = "50";

fn skip_list(ignore: &[String]) -> Vec<String> {
    if ignore.is_empty() {
        SKIP.iter().map(|s| s.to_string()).collect()
    } else {
        ignore.to_vec()
    }
}

/// `rg` argv: case-insensitive fixed-string search from `.`, hidden files
/// included (as the local walk does) minus the ignore list. The query goes
/// after `-e`, so one starting with `-` is still a pattern.
pub fn rg_args(query: &str, ignore: &[String]) -> Vec<String> {
    let mut args: Vec<String> = [
        "rg", "--json", "--hidden", "-i", "-F", "-m", REMOTE_MAX_PER_FILE, "--max-filesize", "256K",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for dir in skip_list(ignore) {
        args.push("-g".into());
        args.push(format!("!{dir}"));
    }
    args.extend(["-e".into(), query.trim().into(), "--".into(), ".".into()]);
    args
}

/// `grep` fallback argv. `-Z` ends each file name with a NUL, so a `:` in a
/// name can't be mistaken for the line-number separator.
pub fn grep_args(query: &str, ignore: &[String]) -> Vec<String> {
    let mut args: Vec<String> = ["grep", "-rnIiFZ", "-m", REMOTE_MAX_PER_FILE]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for dir in skip_list(ignore) {
        args.push(format!("--exclude-dir={dir}"));
    }
    args.extend(["-e".into(), query.trim().into(), "--".into(), ".".into()]);
    args
}

/// Build a hit the way the local walk scores it: occurrences in the line,
/// plus a boost when the file name itself matches.
fn remote_hit(root: &str, rel: &str, line_no: u32, line: &str, needle: &str) -> SearchHit {
    let rel = rel.strip_prefix("./").unwrap_or(rel);
    let path = format!("{}/{rel}", root.trim_end_matches('/'));
    let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let line = line.trim_end_matches(['\n', '\r']);
    let lower = line.to_lowercase();
    let count = lower.matches(needle).count().max(1) as i32;
    let boost = if name.to_lowercase().contains(needle) { 10 } else { 0 };
    SearchHit {
        snippet: make_snippet(line, &lower, needle),
        path,
        name,
        line: line_no,
        score: count + boost,
    }
}

fn finish(mut hits: Vec<SearchHit>, limit: usize) -> Vec<SearchHit> {
    hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
    hits.truncate(limit);
    hits
}

/// Parse `rg --json` output. Only `match` records matter; paths ripgrep
/// could only express as bytes (not UTF-8) are skipped.
pub fn parse_rg_json(stdout: &str, root: &str, query: &str, limit: usize) -> Vec<SearchHit> {
    let needle = query.trim().to_lowercase();
    let mut hits = Vec::new();
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if v["type"] != "match" {
            continue;
        }
        let d = &v["data"];
        let (Some(rel), Some(text), Some(n)) = (
            d["path"]["text"].as_str(),
            d["lines"]["text"].as_str(),
            d["line_number"].as_u64(),
        ) else {
            continue;
        };
        hits.push(remote_hit(root, rel, n as u32, text, &needle));
    }
    finish(hits, limit)
}

/// Parse `grep -rnZ` output: `path\0line:text` per line.
pub fn parse_grep_z(stdout: &str, root: &str, query: &str, limit: usize) -> Vec<SearchHit> {
    let needle = query.trim().to_lowercase();
    let mut hits = Vec::new();
    for record in stdout.lines() {
        let Some((rel, rest)) = record.split_once('\0') else { continue };
        let Some((n, text)) = rest.split_once(':') else { continue };
        let Ok(n) = n.parse::<u32>() else { continue };
        hits.push(remote_hit(root, rel, n, text, &needle));
    }
    finish(hits, limit)
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
        // Counter-suffixed: coarse clock granularity means two dirs can be
        // made in the same nanosecond and collide.
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "arc-search-{}-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed),
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

        let hits = search(&root, "hello_world", 10, &[]).unwrap();
        // node_modules entry should be excluded; two real hits.
        assert!(hits.len() == 2, "got {} hits", hits.len());
        for h in &hits {
            assert!(!h.path.contains("node_modules"));
        }
    }

    #[test]
    fn parses_ripgrep_json_matches() {
        let out = concat!(
            r#"{"type":"begin","data":{"path":{"text":"./src/it's a.rs"}}}"#, "\n",
            r#"{"type":"match","data":{"path":{"text":"./src/it's a.rs"},"lines":{"text":"let Hello = hello;\n"},"line_number":7,"absolute_offset":0,"submatches":[]}}"#, "\n",
            r#"{"type":"match","data":{"path":{"bytes":"/w=="},"lines":{"text":"hello\n"},"line_number":1,"submatches":[]}}"#, "\n",
            r#"{"type":"match","data":{"path":{"text":"./hello.md"},"lines":{"text":"say hello\n"},"line_number":2,"submatches":[]}}"#, "\n",
            r#"{"type":"end","data":{}}"#, "\n",
            r#"{"type":"summary","data":{}}"#, "\n",
        );
        let hits = parse_rg_json(out, "/srv/app/", "hello", 10);
        assert_eq!(hits.len(), 2);
        // Filename boost ranks hello.md first.
        assert_eq!(hits[0].path, "/srv/app/hello.md");
        assert_eq!((hits[0].score, hits[0].line), (11, 2));
        assert_eq!(hits[1].path, "/srv/app/src/it's a.rs");
        assert_eq!(hits[1].name, "it's a.rs");
        assert_eq!(hits[1].snippet, "let Hello = hello;");
        assert_eq!(hits[1].score, 2);
    }

    #[test]
    fn parses_grep_z_with_colons_in_names() {
        let out = "./a:b.txt\u{0}12:x: hello\n./c.rs\u{0}3:HELLO hello\nnot a record\n";
        let hits = parse_grep_z(out, "/r", "hello", 1);
        assert_eq!(hits.len(), 1, "limit applies");
        assert_eq!(hits[0].path, "/r/c.rs");
        let hits = parse_grep_z(out, "/r", "hello", 10);
        assert_eq!(hits[1].path, "/r/a:b.txt");
        assert_eq!((hits[1].line, hits[1].snippet.as_str()), (12, "x: hello"));
    }

    #[test]
    fn remote_args_end_with_the_query_as_a_pattern() {
        let rg = rg_args("-rf", &["mydeps".into()]);
        assert!(rg.contains(&"!mydeps".to_string()));
        assert_eq!(&rg[rg.len() - 4..], &["-e", "-rf", "--", "."]);
        let grep = grep_args("$(x)", &[]);
        assert!(grep.contains(&"--exclude-dir=node_modules".to_string()));
        assert_eq!(&grep[grep.len() - 4..], &["-e", "$(x)", "--", "."]);
    }

    #[test]
    fn custom_ignore_list_overrides_defaults() {
        let root = tempdir();
        fs::write(root.join("a.rs"), "hello_world\n").unwrap();
        // A default-skipped dir the user chose NOT to ignore -> searchable.
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/n.js"), "hello_world\n").unwrap();
        // A dir the user DID add to the ignore list -> excluded.
        fs::create_dir_all(root.join("mydeps")).unwrap();
        fs::write(root.join("mydeps/m.js"), "hello_world\n").unwrap();

        let ignore = vec!["mydeps".to_string()];
        let hits = search(&root, "hello_world", 10, &ignore).unwrap();
        assert!(hits.iter().any(|h| h.path.contains("node_modules")));
        assert!(hits.iter().all(|h| !h.path.contains("mydeps")));
    }

    #[test]
    fn empty_query_returns_empty() {
        let root = tempdir();
        fs::write(root.join("a.rs"), "anything").unwrap();
        assert!(search(&root, "", 10, &[]).unwrap().is_empty());
        assert!(search(&root, "   ", 10, &[]).unwrap().is_empty());
    }

    #[test]
    fn name_match_boosts_score() {
        let root = tempdir();
        fs::write(root.join("hello.txt"), "totally unrelated content\n").unwrap();
        fs::write(root.join("other.txt"), "hello hello\n").unwrap();
        let hits = search(&root, "hello", 10, &[]).unwrap();
        assert!(hits.len() >= 1);
        // hello.txt wins because its filename matches (boost +10).
        assert_eq!(hits[0].name, "hello.txt");
    }
}
