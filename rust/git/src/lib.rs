//! arc-git — git introspection.
//!
//! V0 shipped `status` (porcelain v2).
//! V1 adds `log`, `diff`, and `blame` — still shelling out, since git is
//! already on PATH for any developer terminal. Moving to `gix` is a
//! contained refactor once we need richer operations.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Error)]
pub enum Error {
    #[error("running git: {0}")]
    Spawn(String),
    #[error("git command failed: {0}")]
    Failed(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    /// Current branch name, or `None` for a detached HEAD.
    pub branch: Option<String>,
    /// Short HEAD commit id (7 chars), `None` on a fresh repo with no commits.
    pub head_short: Option<String>,
    /// Tracked upstream branch (e.g. `origin/main`), if configured.
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// True if anything is staged, unstaged, untracked, or in conflict.
    pub dirty: bool,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicted: usize,
}

/// Discover the repository containing `path` and return its current state.
///
/// Returns `Ok(None)` if:
///   * `path` is not inside any git repository,
///   * git isn't on `PATH`,
///   * git fails for any reason (the status bar should never crash because of
///     an unreadable repo — silently degrade instead).
pub async fn status<P: AsRef<Path>>(path: P) -> Result<Option<GitInfo>> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
        ])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;

    if !output.status.success() {
        // Most common case: not a git repo. Don't surface as an error.
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(Some(parse_porcelain_v2(&stdout)))
}

fn parse_porcelain_v2(out: &str) -> GitInfo {
    let mut info = GitInfo {
        branch: None,
        head_short: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        dirty: false,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
    };

    for line in out.lines() {
        // Header lines start with `# `; entries with `1 `, `2 `, `u `, `? `.
        if let Some(rest) = line.strip_prefix("# ") {
            let mut parts = rest.splitn(2, ' ');
            let key = parts.next().unwrap_or("");
            let val = parts.next().unwrap_or("");
            match key {
                "branch.oid" => {
                    if val != "(initial)" {
                        info.head_short = Some(val.chars().take(7).collect());
                    }
                }
                "branch.head" => {
                    if val != "(detached)" {
                        info.branch = Some(val.to_string());
                    }
                }
                "branch.upstream" => {
                    info.upstream = Some(val.to_string());
                }
                "branch.ab" => {
                    // Format: "+N -M"
                    let mut tokens = val.split_whitespace();
                    if let Some(a) = tokens.next() {
                        info.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
                    }
                    if let Some(b) = tokens.next() {
                        info.behind = b.trim_start_matches('-').parse().unwrap_or(0);
                    }
                }
                _ => {}
            }
            continue;
        }

        // Entry lines:
        //   "1 XY ..."   — changed entry (X=staged status, Y=worktree status)
        //   "2 XY ..."   — renamed/copied entry (same encoding)
        //   "u XY ..."   — unmerged (conflict)
        //   "? path"     — untracked
        if let Some(rest) = line.strip_prefix("1 ").or_else(|| line.strip_prefix("2 ")) {
            count_xy(&mut info, rest);
        } else if line.starts_with("u ") {
            info.conflicted += 1;
        } else if line.starts_with("? ") {
            info.untracked += 1;
        }
    }

    info.dirty = info.staged + info.unstaged + info.untracked + info.conflicted > 0;
    info
}

fn count_xy(info: &mut GitInfo, rest: &str) {
    // rest = "XY <submodule> <mH> <mI> <mW> <hH> <hI> <path>"
    // We just need the first two characters: index status + worktree status.
    let mut chars = rest.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if x != '.' {
        info.staged += 1;
    }
    if y != '.' {
        info.unstaged += 1;
    }
}

// ----- log ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub oid: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /// Unix seconds.
    pub time: i64,
    pub subject: String,
}

/// Most-recent commits reachable from HEAD, up to `limit`.
/// `path_filter`, if Some, restricts to commits touching that path.
pub async fn log<P: AsRef<Path>>(
    path: P,
    limit: usize,
    path_filter: Option<&str>,
) -> Result<Vec<LogEntry>> {
    let path = path.as_ref();
    let limit = limit.clamp(1, 1000);
    // Custom format with a record separator that survives subjects containing newlines.
    // Fields: %H<US>%h<US>%an<US>%ae<US>%at<US>%s<RS>
    const US: &str = "\u{1f}";
    const RS: &str = "\u{1e}";
    let format = format!("%H{US}%h{US}%an{US}%ae{US}%at{US}%s{RS}");

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args([
        "log",
        "--no-merges",
        &format!("-n{limit}"),
        &format!("--format={format}"),
    ]);
    if let Some(p) = path_filter {
        cmd.arg("--").arg(p);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for rec in stdout.split(RS) {
        let rec = rec.trim_matches(|c: char| c == '\n' || c == '\r');
        if rec.is_empty() {
            continue;
        }
        let mut fields = rec.splitn(6, US);
        let oid = fields.next().unwrap_or("").to_string();
        let short = fields.next().unwrap_or("").to_string();
        let author = fields.next().unwrap_or("").to_string();
        let email = fields.next().unwrap_or("").to_string();
        let time = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
        let subject = fields.next().unwrap_or("").to_string();
        if oid.is_empty() {
            continue;
        }
        entries.push(LogEntry {
            oid,
            short,
            author,
            email,
            time,
            subject,
        });
    }
    Ok(entries)
}

// ----- diff -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiffScope {
    /// Working tree vs index (unstaged changes).
    Worktree,
    /// Index vs HEAD (staged changes).
    Staged,
    /// `git diff HEAD` (everything not yet committed).
    Head,
}

/// Plain unified-diff text. Empty string when nothing differs.
/// `path_filter`, if Some, restricts the diff to a single file.
pub async fn diff<P: AsRef<Path>>(
    path: P,
    scope: DiffScope,
    path_filter: Option<&str>,
) -> Result<String> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(path)
        .arg("--no-pager")
        .arg("diff")
        .arg("--no-color");
    match scope {
        DiffScope::Worktree => {}
        DiffScope::Staged => {
            cmd.arg("--cached");
        }
        DiffScope::Head => {
            cmd.arg("HEAD");
        }
    }
    if let Some(p) = path_filter {
        cmd.arg("--").arg(p);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// ----- blame ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlameLine {
    pub line_number: usize,
    pub oid: String,
    pub short: String,
    pub author: String,
    /// Unix seconds (author time).
    pub time: i64,
    pub content: String,
}

/// Line-by-line blame for `file`, optionally constrained to a 1-indexed range.
pub async fn blame<P: AsRef<Path>>(
    path: P,
    file: &str,
    range: Option<(usize, usize)>,
) -> Result<Vec<BlameLine>> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(path)
        .arg("--no-pager")
        .arg("blame")
        .arg("--porcelain");
    if let Some((start, end)) = range {
        cmd.arg(format!("-L{start},{end}"));
    }
    cmd.arg("--").arg(file);

    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Ok(parse_blame_porcelain(&raw))
}

fn parse_blame_porcelain(out: &str) -> Vec<BlameLine> {
    // The porcelain format is a sequence of records. Each record starts with:
    //   <oid> <orig-lineno> <final-lineno> [<group-size>]
    // ... followed by header lines like `author <name>`, `author-time <secs>`,
    // and ending with a line that begins with TAB containing the actual source line.
    //
    // Header info is repeated only the first time a commit appears; subsequent
    // occurrences just give the oid. We cache by oid.
    use std::collections::HashMap;
    let mut commits: HashMap<String, (String, i64)> = HashMap::new();
    let mut lines = out.lines().peekable();
    let mut out_lines = Vec::new();

    while let Some(header) = lines.next() {
        let mut parts = header.split_whitespace();
        let oid = match parts.next() {
            Some(o) if o.len() >= 7 => o.to_string(),
            _ => continue,
        };
        let _orig: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let final_ln: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);

        let mut author = commits.get(&oid).map(|v| v.0.clone()).unwrap_or_default();
        let mut time = commits.get(&oid).map(|v| v.1).unwrap_or(0);
        let mut content = String::new();

        while let Some(next) = lines.peek() {
            if let Some(rest) = next.strip_prefix('\t') {
                content = rest.to_string();
                lines.next();
                break;
            }
            let line = lines.next().unwrap();
            if let Some(rest) = line.strip_prefix("author ") {
                author = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("author-time ") {
                time = rest.parse::<i64>().unwrap_or(0);
            }
        }
        commits.insert(oid.clone(), (author.clone(), time));

        let short: String = oid.chars().take(7).collect();
        out_lines.push(BlameLine {
            line_number: final_ln,
            oid,
            short,
            author,
            time,
            content,
        });
    }

    out_lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_branch_with_upstream() {
        let raw = "\
# branch.oid abc1234deadbeef
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -0
";
        let info = parse_porcelain_v2(raw);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head_short.as_deref(), Some("abc1234"));
        assert_eq!(info.upstream.as_deref(), Some("origin/main"));
        assert_eq!(info.ahead, 0);
        assert_eq!(info.behind, 0);
        assert!(!info.dirty);
    }

    #[test]
    fn parses_ahead_behind_and_dirty() {
        let raw = "\
# branch.oid abc1234
# branch.head feature
# branch.upstream origin/feature
# branch.ab +3 -2
1 M. N... 100644 100644 100644 aaa bbb src/main.rs
1 .M N... 100644 100644 100644 ccc ddd src/lib.rs
? new.txt
u UU N... 100644 100644 100644 100644 eee fff ggg conflict.rs
";
        let info = parse_porcelain_v2(raw);
        assert_eq!(info.ahead, 3);
        assert_eq!(info.behind, 2);
        assert_eq!(info.staged, 1);
        assert_eq!(info.unstaged, 1);
        assert_eq!(info.untracked, 1);
        assert_eq!(info.conflicted, 1);
        assert!(info.dirty);
    }

    #[test]
    fn handles_detached_head_and_initial_repo() {
        let raw = "\
# branch.oid (initial)
# branch.head (detached)
";
        let info = parse_porcelain_v2(raw);
        assert!(info.branch.is_none());
        assert!(info.head_short.is_none());
        assert!(info.upstream.is_none());
        assert!(!info.dirty);
    }

    #[test]
    fn parses_blame_porcelain_basic() {
        let raw = "abc1234def 1 1 1\nauthor Alice\nauthor-time 1700000000\nauthor-tz +0000\nsummary first\nfilename foo.rs\n\thello world\nabc1234def 2 2\n\tsecond line\ndef5678abc 3 3 1\nauthor Bob\nauthor-time 1700000100\nauthor-tz +0000\nsummary second\nfilename foo.rs\n\tthird\n";
        let blame = parse_blame_porcelain(raw);
        assert_eq!(blame.len(), 3);
        assert_eq!(blame[0].author, "Alice");
        assert_eq!(blame[0].content, "hello world");
        assert_eq!(blame[1].author, "Alice"); // inherited
        assert_eq!(blame[1].content, "second line");
        assert_eq!(blame[2].author, "Bob");
        assert_eq!(blame[2].time, 1700000100);
    }

    #[tokio::test]
    async fn status_of_this_repo_returns_something() {
        // Sanity check — running from inside the workspace should resolve a repo.
        let out = status(".").await.expect("git ran");
        assert!(out.is_some(), "expected to find the arc-terminal repo");
    }
}
