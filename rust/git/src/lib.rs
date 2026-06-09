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

// ----- changes (per-file) ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// Staged-only change (X in porcelain).
    Staged,
    /// Worktree-only change (Y in porcelain).
    Unstaged,
    /// Both staged and unstaged modifications.
    Both,
    /// Untracked file (`?`).
    Untracked,
    /// Unmerged / conflicted (`u`).
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeEntry {
    /// Repository-relative path.
    pub path: String,
    /// Original path for rename/copy entries.
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    /// Single-letter status (M, A, D, R, C, U, ?). Worktree side preferred,
    /// fallback to index side. Useful for badges in the UI.
    pub status: String,
}

/// Per-file working-copy status, derived from `git status --porcelain=v2`.
///
/// Returns `Ok(vec![])` when `path` is not inside a repo.
pub async fn changes<P: AsRef<Path>>(path: P) -> Result<Vec<ChangeEntry>> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "status",
            "--porcelain=v2",
            "--untracked-files=normal",
            "-z",
        ])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    // `-z` produces NUL-terminated records. Rename/copy ("2") entries use
    // NUL to separate the new path and origin path as well, so we have to
    // parse sequentially rather than splitting once.
    let mut out = Vec::new();
    let bytes = &output.stdout[..];
    let mut i = 0;
    while i < bytes.len() {
        let end = bytes[i..]
            .iter()
            .position(|&b| b == 0)
            .map(|p| i + p)
            .unwrap_or(bytes.len());
        let line = std::str::from_utf8(&bytes[i..end]).unwrap_or("");
        i = end + 1;

        if let Some(rest) = line.strip_prefix("1 ") {
            // "XY <sub> <mH> <mI> <mW> <hH> <hI> <path>"
            let (x, y) = first_two(rest);
            if let Some(p) = nth_token(rest, 8) {
                out.push(make_entry(p, None, x, y));
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // "XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"
            // followed by NUL-separated <orig_path>.
            let (x, y) = first_two(rest);
            let new_path = nth_token(rest, 9);
            let orig_end = bytes[i..]
                .iter()
                .position(|&b| b == 0)
                .map(|p| i + p)
                .unwrap_or(bytes.len());
            let orig = std::str::from_utf8(&bytes[i..orig_end]).unwrap_or("");
            i = orig_end + 1;
            if let Some(p) = new_path {
                out.push(make_entry(
                    p,
                    if orig.is_empty() { None } else { Some(orig.to_string()) },
                    x,
                    y,
                ));
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            // "XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
            if let Some(p) = nth_token(rest, 10) {
                let _ = rest;
                out.push(ChangeEntry {
                    path: p.to_string(),
                    orig_path: None,
                    kind: ChangeKind::Conflict,
                    status: "U".into(),
                });
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            out.push(ChangeEntry {
                path: rest.to_string(),
                orig_path: None,
                kind: ChangeKind::Untracked,
                status: "?".into(),
            });
        }
    }

    Ok(out)
}

fn first_two(s: &str) -> (char, char) {
    let mut it = s.chars();
    (it.next().unwrap_or('.'), it.next().unwrap_or('.'))
}

/// Take the Nth whitespace-separated token from `s` and return everything
/// from its start to end-of-string (so paths with spaces survive intact).
fn nth_token(s: &str, n: usize) -> Option<&str> {
    let mut count = 0;
    let mut in_tok = false;
    for (idx, ch) in s.char_indices() {
        let is_ws = ch == ' ';
        if !is_ws && !in_tok {
            count += 1;
            if count == n {
                return Some(&s[idx..]);
            }
            in_tok = true;
        } else if is_ws {
            in_tok = false;
        }
    }
    None
}

fn make_entry(path: &str, orig: Option<String>, x: char, y: char) -> ChangeEntry {
    let x_changed = x != '.';
    let y_changed = y != '.';
    let kind = match (x_changed, y_changed) {
        (true, true) => ChangeKind::Both,
        (true, false) => ChangeKind::Staged,
        (false, true) => ChangeKind::Unstaged,
        (false, false) => ChangeKind::Unstaged,
    };
    // Prefer the worktree status letter; fall back to index side.
    let status = if y_changed { y } else { x };
    ChangeEntry {
        path: path.to_string(),
        orig_path: orig,
        kind,
        status: status.to_string(),
    }
}

// ----- stage / unstage / commit --------------------------------------------

/// Stage the given repository-relative paths (`git add -- <paths>`).
///
/// Works for tracked modifications, deletions, and untracked files — `git add`
/// records whatever the working-tree state currently shows. Empty `paths`
/// no-ops; pass an explicit `vec!["."]` to stage everything.
pub async fn stage<P: AsRef<Path>>(path: P, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(["add", "--"]);
    for p in paths {
        cmd.arg(p);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(if err.is_empty() {
            "git add failed".into()
        } else {
            err
        }));
    }
    Ok(())
}

/// Unstage the given paths so they return to the working tree without touching
/// the file contents.
///
/// Uses `git reset HEAD -- <paths>` rather than `git restore --staged` because
/// the former gracefully handles the initial-commit case (no HEAD yet) by
/// falling back to `git rm --cached`.
pub async fn unstage<P: AsRef<Path>>(path: P, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let path = path.as_ref();

    // Detect whether the repo has any commits yet — `git reset HEAD` fails
    // on a fresh repo before the first commit.
    let head = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let has_head = head.status.success();

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path);
    if has_head {
        cmd.args(["reset", "HEAD", "--"]);
    } else {
        // Pre-first-commit: drop entries from the index entirely.
        cmd.args(["rm", "--cached", "--"]);
    }
    for p in paths {
        cmd.arg(p);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(if err.is_empty() {
            "unstage failed".into()
        } else {
            err
        }));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    /// Short SHA of the new commit (7 chars). Empty when git produced no oid
    /// (shouldn't happen on success, but we don't want to panic).
    pub short: String,
    /// First line of the commit subject as recorded.
    pub subject: String,
}

/// Create a new commit from whatever is currently staged.
///
/// Fails (with the git error surfaced) when there's nothing staged, when the
/// message is empty, or when a hook rejects the commit. We deliberately do
/// **not** pass `-a` — the UI's stage/unstage model is the source of truth.
pub async fn commit<P: AsRef<Path>>(path: P, message: &str) -> Result<CommitResult> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(Error::Failed("empty commit message".into()));
    }
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["commit", "-m", msg])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !err.is_empty() {
            err
        } else if !out.is_empty() {
            out
        } else {
            "commit failed".into()
        };
        return Err(Error::Failed(detail));
    }

    // Resolve the new HEAD so the UI can confirm. Don't fail the call if this
    // probe trips — the commit already landed.
    let probe = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["log", "-1", "--format=%h%n%s"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let (short, subject) = if probe.status.success() {
        let s = String::from_utf8_lossy(&probe.stdout);
        let mut it = s.lines();
        (
            it.next().unwrap_or("").to_string(),
            it.next().unwrap_or("").to_string(),
        )
    } else {
        (String::new(), msg.to_string())
    };
    Ok(CommitResult { short, subject })
}

/// Discard local changes for the given repository-relative paths.
///
/// Two flavors, both expected to be present in a single call so the UI can fire
/// one command for a mixed selection:
///   * `tracked_paths` are restored from `HEAD` via `git checkout HEAD -- …`,
///     which throws away both worktree and staged modifications.
///   * `untracked_paths` have no history to restore from — they're deleted
///     from disk directly. Missing files are tolerated (already gone).
///
/// Empty inputs no-op.
pub async fn discard<P: AsRef<Path>>(
    path: P,
    tracked_paths: &[String],
    untracked_paths: &[String],
) -> Result<()> {
    let path = path.as_ref();

    if !tracked_paths.is_empty() {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(path).args(["checkout", "HEAD", "--"]);
        for p in tracked_paths {
            cmd.arg(p);
        }
        let output = cmd
            .output()
            .await
            .map_err(|e| Error::Spawn(e.to_string()))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Failed(if err.is_empty() {
                "discard failed".into()
            } else {
                err
            }));
        }
    }

    if !untracked_paths.is_empty() {
        for rel in untracked_paths {
            let full = path.join(rel);
            // Tolerate missing files — the goal is "ensure it's gone".
            match tokio::fs::metadata(&full).await {
                Ok(meta) if meta.is_dir() => {
                    tokio::fs::remove_dir_all(&full)
                        .await
                        .map_err(|e| Error::Failed(format!("removing {rel}: {e}")))?;
                }
                Ok(_) => {
                    tokio::fs::remove_file(&full)
                        .await
                        .map_err(|e| Error::Failed(format!("removing {rel}: {e}")))?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Error::Failed(format!("stat {rel}: {e}"))),
            }
        }
    }

    Ok(())
}

// ----- branches -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    /// Display name. For locals: `main`. For remotes: `origin/main`.
    pub name: String,
    /// True when this branch is the current HEAD (locals only).
    pub current: bool,
    /// True when `refs/remotes/...` (e.g. `origin/main`); false for locals.
    pub remote: bool,
    /// Tracked upstream branch for a local (e.g. `origin/main`), if configured.
    pub upstream: Option<String>,
    /// Short HEAD commit id (7 chars).
    pub head_short: Option<String>,
    /// Most-recent commit subject on this branch.
    pub subject: Option<String>,
    /// Commit time in unix seconds (committer time).
    pub time: i64,
}

/// Enumerate every local + remote branch in the repository.
///
/// Sorted by committer time descending so freshly-touched branches surface
/// first — empirically what users want when they reach for a branch picker.
/// Returns `Ok(vec![])` when `path` is not inside a git repo.
pub async fn branches<P: AsRef<Path>>(path: P) -> Result<Vec<BranchInfo>> {
    let path = path.as_ref();
    // Fields, US-separated:
    //   refname:short, HEAD (`*` or ` `), refname (full),
    //   objectname (full), committerdate:unix, contents:subject,
    //   upstream:short
    const US: &str = "\u{1f}";
    let format = format!(
        "%(refname:short){US}%(HEAD){US}%(refname){US}%(objectname){US}%(committerdate:unix){US}%(contents:subject){US}%(upstream:short)"
    );

    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={format}"),
            "refs/heads",
            "refs/remotes",
        ])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let mut fields = line.splitn(7, US);
        let short = fields.next().unwrap_or("").trim().to_string();
        let head_marker = fields.next().unwrap_or(" ").trim();
        let refname = fields.next().unwrap_or("");
        let oid = fields.next().unwrap_or("").trim().to_string();
        let time = fields.next().unwrap_or("0").trim().parse::<i64>().unwrap_or(0);
        let subject = fields.next().unwrap_or("").trim().to_string();
        let upstream = fields.next().unwrap_or("").trim().to_string();

        // Skip the symbolic `origin/HEAD -> origin/main` pseudo-ref.
        if short.ends_with("/HEAD") || refname == "refs/remotes/origin/HEAD" {
            continue;
        }
        if short.is_empty() {
            continue;
        }

        let remote = refname.starts_with("refs/remotes/");
        out.push(BranchInfo {
            name: short,
            current: head_marker == "*",
            remote,
            upstream: if upstream.is_empty() { None } else { Some(upstream) },
            head_short: if oid.is_empty() { None } else { Some(oid.chars().take(7).collect()) },
            subject: if subject.is_empty() { None } else { Some(subject) },
            time,
        });
    }
    Ok(out)
}

// ----- checkout -------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutResult {
    /// Branch that HEAD ended up on (locals only; None on detached HEAD).
    pub branch: Option<String>,
    /// True when we created a new local tracking branch from a remote ref.
    pub created_tracking: bool,
}

/// Reject a ref / branch / oid / start-point that begins with `-`, which git
/// would otherwise parse as an option rather than a value (argument injection
/// — e.g. a remote branch named `--upload-pack=…` or `--exec=…` flowing into
/// `checkout`/`merge`). Valid git refnames can't start with `-`, so this only
/// blocks malicious input, never a legitimate ref.
fn reject_option_like(value: &str, what: &str) -> Result<()> {
    if value.trim_start().starts_with('-') {
        return Err(Error::Failed(format!(
            "refusing {what} that looks like a command-line option: {value:?}"
        )));
    }
    Ok(())
}

/// Check out an existing branch by name.
///
/// `name` may be a local (`main`) or remote (`origin/feature/x`) short name.
/// Remote names trigger `git switch --track <remote>` so the working tree
/// lands on a fresh local branch tracking that remote.
pub async fn checkout<P: AsRef<Path>>(path: P, name: &str) -> Result<CheckoutResult> {
    let path = path.as_ref();
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(Error::Failed("empty branch name".into()));
    }
    reject_option_like(trimmed, "branch name")?;

    // Heuristic: if the ref looks like `<remote>/<rest>` and there's no local
    // ref of the same name, create a tracking branch.
    let (args, created_tracking): (Vec<&str>, bool) = if let Some((_remote, rest)) =
        trimmed.split_once('/')
    {
        // Probe for a local branch with this exact short name.
        let probe = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("refs/heads/{trimmed}"))
            .output()
            .await
            .map_err(|e| Error::Spawn(e.to_string()))?;
        if probe.status.success() {
            (vec!["switch", trimmed], false)
        } else {
            // `git switch --track origin/main` creates a local `main` tracking origin/main.
            // The shortened branch name git picks is `rest`.
            let _ = rest; // for clarity
            (vec!["switch", "--track", trimmed], true)
        }
    } else {
        (vec!["switch", trimmed], false)
    };

    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&args)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(if err.is_empty() {
            "checkout failed".into()
        } else {
            err
        }));
    }

    // Resolve the branch HEAD ended up on.
    let head = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["symbolic-ref", "--short", "HEAD"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let branch = if head.status.success() {
        let s = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    };

    Ok(CheckoutResult {
        branch,
        created_tracking,
    })
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
    /// Full-SHA parent OIDs (empty for the root commit; multiple for merges).
    pub parents: Vec<String>,
    /// Lines added across all files in this commit (from --numstat).
    pub additions: i64,
    /// Lines removed across all files in this commit (from --numstat).
    pub deletions: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LogOptions {
    /// Restrict to commits touching this path.
    pub path_filter: Option<String>,
    /// Unix seconds. Drop commits authored before this instant.
    pub since: Option<i64>,
    /// Unix seconds. Drop commits authored after this instant.
    pub until: Option<i64>,
    /// `--author=<pattern>`. Case-insensitive substring on name OR email.
    pub author: Option<String>,
    /// When false (default), merge commits are excluded. The Git window
    /// turns this on so the graph view can render fork/merge geometry.
    pub include_merges: bool,
}

/// Most-recent commits reachable from HEAD, up to `limit`.
pub async fn log<P: AsRef<Path>>(
    path: P,
    limit: usize,
    opts: &LogOptions,
) -> Result<Vec<LogEntry>> {
    let path = path.as_ref();
    let limit = limit.clamp(1, 5000);
    // SOH (\x01) prefixes each commit record so we can cleanly separate the
    // per-commit format line from the --numstat block that follows it.
    // Fields: <SOH>%H<US>%h<US>%an<US>%ae<US>%at<US>%P<US>%s
    const US: char = '\u{1f}';
    const SOH: char = '\u{01}';
    let format = format!("{SOH}%H{US}%h{US}%an{US}%ae{US}%at{US}%P{US}%s");

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args([
        "log",
        &format!("-n{limit}"),
        &format!("--format={format}"),
        "--numstat",
    ]);
    if !opts.include_merges {
        cmd.arg("--no-merges");
    }
    if let Some(ts) = opts.since {
        cmd.arg(format!("--since={ts}"));
    }
    if let Some(ts) = opts.until {
        cmd.arg(format!("--until={ts}"));
    }
    if let Some(a) = opts.author.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("-i").arg(format!("--author={a}"));
    }
    if let Some(p) = opts.path_filter.as_deref().filter(|s| !s.is_empty()) {
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

    // Each block starts with SOH; splitting on it gives one segment per commit.
    // Segment structure (after trimming outer blank lines):
    //   Line 0 : commit fields (SOH already consumed by the split)
    //   Line 1 : blank
    //   Lines 2+: numstat rows  "<ins>\t<del>\t<path>"
    //             binary files show "-\t-\t<path>" and are skipped
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for block in stdout.split(SOH) {
        let block = block.trim_matches(|c: char| c == '\n' || c == '\r');
        if block.is_empty() {
            continue;
        }
        let mut lines_iter = block.lines();
        let first = lines_iter.next().unwrap_or("").trim_end_matches('\r');
        if first.is_empty() {
            continue;
        }
        let mut fields = first.splitn(7, US);
        let oid = fields.next().unwrap_or("").to_string();
        let short = fields.next().unwrap_or("").to_string();
        let author = fields.next().unwrap_or("").to_string();
        let email = fields.next().unwrap_or("").to_string();
        let time = fields.next().unwrap_or("0").parse::<i64>().unwrap_or(0);
        let parents_field = fields.next().unwrap_or("");
        let subject = fields.next().unwrap_or("").to_string();
        if oid.is_empty() {
            continue;
        }
        let parents: Vec<String> = parents_field
            .split_ascii_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();

        let mut additions = 0i64;
        let mut deletions = 0i64;
        for line in lines_iter {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(3, '\t');
            let ins_s = parts.next().unwrap_or("");
            let del_s = parts.next().unwrap_or("");
            if parts.next().is_some() {
                additions += ins_s.parse::<i64>().unwrap_or(0);
                deletions += del_s.parse::<i64>().unwrap_or(0);
            }
        }

        entries.push(LogEntry {
            oid,
            short,
            author,
            email,
            time,
            subject,
            parents,
            additions,
            deletions,
        });
    }
    Ok(entries)
}

// ----- authors --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorInfo {
    pub name: String,
    pub email: String,
    pub commits: usize,
}

/// All committers reachable from any ref, ranked by commit count desc.
/// Falls back to an empty list (rather than erroring) on a bare repo.
pub async fn authors<P: AsRef<Path>>(path: P) -> Result<Vec<AuthorInfo>> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["shortlog", "-sne", "--all", "--no-merges"])
        .env("GIT_PAGER", "")
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        // Empty repo / detached refs → just return nothing rather than failing.
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in stdout.lines() {
        // Each row: "  <count>\t<name> <email>" where email is wrapped in <>.
        let line = line.trim_start();
        let (count_str, rest) = match line.split_once('\t') {
            Some(p) => p,
            None => continue,
        };
        let commits: usize = count_str.trim().parse().unwrap_or(0);
        let (name, email) = match (rest.rfind('<'), rest.rfind('>')) {
            (Some(lt), Some(gt)) if gt > lt => {
                let name = rest[..lt].trim().to_string();
                let email = rest[lt + 1..gt].to_string();
                (name, email)
            }
            _ => (rest.trim().to_string(), String::new()),
        };
        if name.is_empty() && email.is_empty() {
            continue;
        }
        out.push(AuthorInfo {
            name,
            email,
            commits,
        });
    }
    Ok(out)
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

// ----- apply ----------------------------------------------------------------

/// Apply a unified-diff patch to the repository.
/// `cached` → apply to the index only (`git apply --cached`).
/// `reverse` → apply in reverse (`git apply --reverse`).
/// Pass the patch text (file header + one or more hunks) produced by [`diff`].
pub async fn apply<P: AsRef<Path>>(
    path: P,
    patch: &str,
    cached: bool,
    reverse: bool,
) -> Result<()> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).arg("apply");
    if cached {
        cmd.arg("--cached");
    }
    if reverse {
        cmd.arg("--reverse");
    }
    cmd.arg("-") // read patch from stdin
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| Error::Spawn(e.to_string()))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(patch.as_bytes())
            .await
            .map_err(|e| Error::Spawn(e.to_string()))?;
        // Drop closes the pipe, signalling EOF to git.
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

// ----- diff stat (summary) --------------------------------------------------

/// Aggregate insertion/deletion line counts across all changes vs `HEAD`
/// (staged + unstaged combined). Untracked files are counted as new files
/// with their full line count as insertions, so the totals match what the
/// user would see if they staged everything and ran `git diff --cached`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiffStat {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// Run `git diff --numstat HEAD` and sum the per-file counts, then add
/// untracked files separately. Binary files (where numstat shows `-\t-`)
/// contribute to `files_changed` but not to line counts.
///
/// Returns `Ok(None)` when `path` isn't inside a git repo. Returns a zeroed
/// `DiffStat` when there are no changes (or no HEAD yet on a fresh repo,
/// in which case only untracked files contribute).
pub async fn diff_stat<P: AsRef<Path>>(path: P) -> Result<Option<DiffStat>> {
    let path = path.as_ref();

    // Cheap repo-membership check — same probe `status` does. Lets us
    // distinguish "not a repo" (return None) from "repo with no changes".
    let probe = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !probe.status.success() {
        return Ok(None);
    }

    let mut stat = DiffStat::default();

    // Tracked changes vs HEAD. If there's no HEAD (fresh repo) this fails;
    // we treat that as "no tracked changes" and fall through to untracked.
    let numstat = Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("--no-pager")
        .args(["diff", "--numstat", "HEAD"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if numstat.status.success() {
        for line in String::from_utf8_lossy(&numstat.stdout).lines() {
            // Format: "<ins>\t<del>\t<path>"  (binary files use "-\t-")
            let mut parts = line.splitn(3, '\t');
            let ins = parts.next().unwrap_or("");
            let del = parts.next().unwrap_or("");
            if parts.next().is_none() {
                continue;
            }
            stat.files_changed += 1;
            stat.insertions += ins.parse::<usize>().unwrap_or(0);
            stat.deletions += del.parse::<usize>().unwrap_or(0);
        }
    }

    // Untracked files — counted as additions of their full line count.
    let untracked = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if untracked.status.success() {
        for raw in untracked.stdout.split(|&b| b == 0) {
            if raw.is_empty() {
                continue;
            }
            let rel = match std::str::from_utf8(raw) {
                Ok(s) => s,
                Err(_) => continue,
            };
            stat.files_changed += 1;
            // Read the file and count lines. Cap at 1 MiB so a stray huge
            // log file doesn't stall the status bar.
            let abs = path.join(rel);
            if let Ok(meta) = tokio::fs::metadata(&abs).await {
                if meta.is_file() && meta.len() <= 1 << 20 {
                    if let Ok(bytes) = tokio::fs::read(&abs).await {
                        // Treat binary-looking files (contains NUL) as zero-line.
                        if !bytes.contains(&0) {
                            stat.insertions += bytecount_lines(&bytes);
                        }
                    }
                }
            }
        }
    }

    Ok(Some(stat))
}

fn bytecount_lines(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let nl = bytes.iter().filter(|&&b| b == b'\n').count();
    // Treat a missing trailing newline as one extra line so a 1-line file
    // without LF still reports as 1 insertion.
    if bytes.last() == Some(&b'\n') {
        nl
    } else {
        nl + 1
    }
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

// ----- remotes --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

/// List all configured remotes with their fetch + push URLs.
pub async fn remotes<P: AsRef<Path>>(path: P) -> Result<Vec<RemoteInfo>> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "-v"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut map: std::collections::BTreeMap<String, (String, String)> = Default::default();
    for line in stdout.lines() {
        // "<name>\t<url> (fetch|push)"
        let (name, rest) = match line.split_once('\t') {
            Some(p) => p,
            None => continue,
        };
        if let Some(url) = rest.strip_suffix(" (fetch)") {
            map.entry(name.to_string()).or_default().0 = url.to_string();
        } else if let Some(url) = rest.strip_suffix(" (push)") {
            map.entry(name.to_string()).or_default().1 = url.to_string();
        }
    }
    Ok(map
        .into_iter()
        .map(|(name, (fetch_url, push_url))| RemoteInfo {
            name,
            fetch_url,
            push_url,
        })
        .collect())
}

// ----- remote operations (fetch / pull / push) ------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteOpResult {
    /// Human-readable output from git (combined stdout + stderr).
    pub message: String,
}

pub async fn fetch<P: AsRef<Path>>(path: P, remote: Option<&str>) -> Result<RemoteOpResult> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).arg("fetch");
    if let Some(r) = remote {
        cmd.arg(r);
    }
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(Error::Failed(if !stderr.is_empty() { stderr } else { stdout }));
    }
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "Fetch complete.".to_string()
    };
    Ok(RemoteOpResult { message })
}

pub async fn pull<P: AsRef<Path>>(path: P, rebase: bool) -> Result<RemoteOpResult> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).arg("pull").arg("--no-edit");
    if rebase {
        cmd.arg("--rebase");
    }
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(Error::Failed(if !stderr.is_empty() { stderr } else { stdout }));
    }
    let message = if !stdout.is_empty() {
        stdout
    } else if !stderr.is_empty() {
        stderr
    } else {
        "Pull complete.".to_string()
    };
    Ok(RemoteOpResult { message })
}

pub async fn push<P: AsRef<Path>>(
    path: P,
    remote: Option<&str>,
    branch: Option<&str>,
    force: bool,
    set_upstream: bool,
) -> Result<RemoteOpResult> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).arg("push");
    if force {
        cmd.arg("--force-with-lease");
    }
    if set_upstream {
        cmd.arg("--set-upstream");
    }
    if let Some(r) = remote {
        cmd.arg(r);
    }
    if let Some(b) = branch {
        cmd.arg(b);
    }
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(Error::Failed(if !stderr.is_empty() { stderr } else { stdout }));
    }
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "Push complete.".to_string()
    };
    Ok(RemoteOpResult { message })
}

// ----- stash ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashEntry {
    pub index: usize,
    pub oid: String,
    pub message: String,
}

pub async fn stash_list<P: AsRef<Path>>(path: P) -> Result<Vec<StashEntry>> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["stash", "list", "--format=%gd\t%H\t%gs"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.splitn(3, '\t');
        let ref_name = parts.next().unwrap_or("");
        let oid = parts.next().unwrap_or("").to_string();
        let message = parts.next().unwrap_or("").to_string();
        let index = ref_name
            .trim_start_matches("stash@{")
            .trim_end_matches('}')
            .parse::<usize>()
            .unwrap_or(0);
        entries.push(StashEntry { index, oid, message });
    }
    Ok(entries)
}

pub async fn stash_push<P: AsRef<Path>>(path: P, message: Option<&str>) -> Result<()> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).arg("stash").arg("push");
    if let Some(m) = message {
        cmd.args(["-m", m]);
    }
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

pub async fn stash_pop<P: AsRef<Path>>(path: P, index: Option<usize>) -> Result<()> {
    let path = path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).arg("stash").arg("pop");
    if let Some(i) = index {
        cmd.arg(format!("stash@{{{i}}}"));
    }
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

pub async fn stash_drop<P: AsRef<Path>>(path: P, index: usize) -> Result<()> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("stash")
        .arg("drop")
        .arg(format!("stash@{{{index}}}"))
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

// ----- branch management ---------------------------------------------------

pub async fn branch_create<P: AsRef<Path>>(
    path: P,
    name: &str,
    checkout: bool,
) -> Result<()> {
    reject_option_like(name, "branch name")?;
    let path = path.as_ref();
    let args: &[&str] = if checkout {
        &["checkout", "-b", name]
    } else {
        &["branch", name]
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

pub async fn branch_rename<P: AsRef<Path>>(
    path: P,
    old_name: &str,
    new_name: &str,
) -> Result<()> {
    reject_option_like(old_name, "branch name")?;
    reject_option_like(new_name, "branch name")?;
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["branch", "-m", old_name, new_name])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

pub async fn branch_delete<P: AsRef<Path>>(
    path: P,
    name: &str,
    force: bool,
) -> Result<()> {
    reject_option_like(name, "branch name")?;
    let path = path.as_ref();
    let flag = if force { "-D" } else { "-d" };
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["branch", flag, name])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeResult {
    pub message: String,
    pub conflicts: bool,
}

pub async fn merge<P: AsRef<Path>>(path: P, branch: &str) -> Result<MergeResult> {
    reject_option_like(branch, "branch")?;
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["merge", "--no-edit", branch])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let conflicts = stdout.contains("CONFLICT") || stderr.contains("CONFLICT");
        if conflicts {
            let msg = if !stdout.is_empty() { stdout } else { stderr };
            return Ok(MergeResult { message: msg, conflicts: true });
        }
        return Err(Error::Failed(if !stderr.is_empty() { stderr } else { stdout }));
    }
    let msg = if !stdout.is_empty() { stdout } else { "Merge complete.".to_string() };
    Ok(MergeResult { message: msg, conflicts: false })
}

// ----- commit operations ---------------------------------------------------

pub async fn commit_amend<P: AsRef<Path>>(path: P, message: &str) -> Result<CommitResult> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err(Error::Failed("empty commit message".into()));
    }
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["commit", "--amend", "-m", msg])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(Error::Failed(if !err.is_empty() { err } else { out }));
    }
    let probe = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["log", "-1", "--format=%h%n%s"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let (short, subject) = if probe.status.success() {
        let s = String::from_utf8_lossy(&probe.stdout);
        let mut it = s.lines();
        (
            it.next().unwrap_or("").to_string(),
            it.next().unwrap_or("").to_string(),
        )
    } else {
        (String::new(), msg.to_string())
    };
    Ok(CommitResult { short, subject })
}

pub async fn revert<P: AsRef<Path>>(path: P, oid: &str) -> Result<CommitResult> {
    reject_option_like(oid, "commit")?;
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["revert", "--no-edit", oid])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(Error::Failed(if !err.is_empty() { err } else { out }));
    }
    let probe = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["log", "-1", "--format=%h%n%s"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    let (short, subject) = if probe.status.success() {
        let s = String::from_utf8_lossy(&probe.stdout);
        let mut it = s.lines();
        (
            it.next().unwrap_or("").to_string(),
            it.next().unwrap_or("").to_string(),
        )
    } else {
        (String::new(), format!("Revert {oid}"))
    };
    Ok(CommitResult { short, subject })
}

pub async fn cherry_pick<P: AsRef<Path>>(path: P, oid: &str) -> Result<()> {
    reject_option_like(oid, "commit")?;
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["cherry-pick", oid])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(Error::Failed(if !err.is_empty() { err } else { out }));
    }
    Ok(())
}

// ─── Interactive rebase ───────────────────────────────────────────────────

/// One row of a `git rebase -i` TODO list. V1 omits `edit` and `reword`
/// because both require interactive user input mid-rebase; the UI nudges
/// users toward `git commit --amend` after the rebase instead.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RebaseAction {
    /// Keep the commit as-is.
    Pick,
    /// Drop the commit entirely.
    Drop,
    /// Combine with the previous commit, keep both messages.
    Squash,
    /// Combine with the previous commit, discard this commit's message.
    Fixup,
}

impl RebaseAction {
    fn keyword(self) -> &'static str {
        match self {
            RebaseAction::Pick => "pick",
            RebaseAction::Drop => "drop",
            RebaseAction::Squash => "squash",
            RebaseAction::Fixup => "fixup",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebaseTodoEntry {
    pub oid: String,
    pub action: RebaseAction,
}

/// Run `git rebase -i <base>` with a pre-built TODO list.
///
/// `entries` is the TODO in the order the user wants the final history to
/// have (top-down, oldest first — matches what `git rebase -i` writes into
/// the editor). Unlike interactive rebase from the shell, this never opens
/// an editor: a helper script copies the prepared TODO into the sequence
/// editor's slot, and `GIT_EDITOR` is set to a no-op so squash/fixup
/// combined-message prompts accept their defaults.
///
/// Callers should ensure the working tree is clean before invoking — git
/// itself refuses an interactive rebase on a dirty tree, but the error
/// message is opaque. The caller can stash + restore around this if needed.
///
/// Conflicts during rebase surface as `Err`; the repo is left mid-rebase
/// and the caller is expected to drive the user through resolution (or
/// call [`rebase_abort`]).
pub async fn rebase_interactive<P: AsRef<Path>>(
    repo_path: P,
    base: &str,
    entries: &[RebaseTodoEntry],
) -> Result<()> {
    let repo_path = repo_path.as_ref();
    if entries.is_empty() {
        return Err(Error::Failed("empty rebase todo list".into()));
    }

    // Build the TODO file content. Each line is `<action> <oid>`.
    let mut todo = String::new();
    for entry in entries {
        todo.push_str(entry.action.keyword());
        todo.push(' ');
        todo.push_str(&entry.oid);
        todo.push('\n');
    }

    // Drop everything into a unique tempdir so we can clean up reliably.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("arc-rebase-{stamp}-{pid}"));
    std::fs::create_dir_all(&dir).map_err(|e| Error::Spawn(format!("tempdir: {e}")))?;
    let todo_path = dir.join("todo.txt");
    std::fs::write(&todo_path, todo).map_err(|e| Error::Spawn(format!("write todo: {e}")))?;

    // Helper script — overwrites git's TODO file with our prepared one.
    // We use ARC_REBASE_TODO to avoid quoting the path through the editor
    // env var (which git tokenises by whitespace).
    let (seq_editor_path, no_op_editor) = write_helpers(&dir, &todo_path)?;

    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rebase", "-i", base])
        .env("GIT_SEQUENCE_EDITOR", &seq_editor_path)
        .env("GIT_EDITOR", &no_op_editor)
        .env("ARC_REBASE_TODO", &todo_path)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;

    // Best-effort cleanup. If the rebase succeeded we're done; if it
    // failed mid-flight, git's reflog + ORIG_HEAD already cover recovery.
    let _ = std::fs::remove_dir_all(&dir);

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(Error::Failed(if !err.is_empty() {
            err
        } else if !out.is_empty() {
            out
        } else {
            "rebase failed".into()
        }));
    }
    Ok(())
}

/// `git rebase --abort`. Restores the pre-rebase HEAD and working tree.
pub async fn rebase_abort<P: AsRef<Path>>(repo_path: P) -> Result<()> {
    let repo_path = repo_path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rebase", "--abort"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

/// `git rebase --continue`. Used after the user finishes resolving a
/// conflict in the worktree.
pub async fn rebase_continue<P: AsRef<Path>>(repo_path: P) -> Result<()> {
    let repo_path = repo_path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rebase", "--continue"])
        // Same no-op editor so the post-resolve commit-message dialog
        // accepts the default.
        .env("GIT_EDITOR", no_op_editor_command())
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

#[cfg(windows)]
fn write_helpers(dir: &Path, _todo: &Path) -> Result<(std::path::PathBuf, String)> {
    let seq = dir.join("arc-seq-editor.cmd");
    // `>NUL 2>&1` swallows copy's chatter so it doesn't poison git's stderr.
    std::fs::write(&seq, "@echo off\r\ncopy /Y \"%ARC_REBASE_TODO%\" \"%1\" >NUL 2>&1\r\n")
        .map_err(|e| Error::Spawn(format!("write helper: {e}")))?;
    Ok((seq, no_op_editor_command()))
}

#[cfg(not(windows))]
fn write_helpers(dir: &Path, _todo: &Path) -> Result<(std::path::PathBuf, String)> {
    use std::os::unix::fs::PermissionsExt;
    let seq = dir.join("arc-seq-editor.sh");
    std::fs::write(&seq, "#!/bin/sh\ncp \"$ARC_REBASE_TODO\" \"$1\"\n")
        .map_err(|e| Error::Spawn(format!("write helper: {e}")))?;
    std::fs::set_permissions(&seq, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| Error::Spawn(format!("chmod helper: {e}")))?;
    Ok((seq, no_op_editor_command()))
}

/// Command that does nothing and exits 0 — used as `GIT_EDITOR` to accept
/// the default contents of squash combined-message + post-conflict commit
/// message buffers. `true` is available on every POSIX shell; on Windows
/// the equivalent is `cmd /c exit 0`.
fn no_op_editor_command() -> String {
    if cfg!(windows) {
        // Quoting is awkward — git invokes the value as a command with the
        // file path appended. `rem` is the cmd built-in for a no-op.
        "cmd /c rem".to_string()
    } else {
        "true".to_string()
    }
}

// ─── Worktree management ───────────────────────────────────────────────────

/// One entry of `git worktree list --porcelain`. The fields map 1:1 to the
/// porcelain output; `branch` is `None` for a detached worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeEntry {
    /// Absolute path to the worktree's root.
    pub path: String,
    /// Short HEAD oid (7 chars). `None` only for very unusual broken states.
    pub head_short: Option<String>,
    /// Local branch name (`refs/heads/<name>` stripped), or `None` when
    /// detached.
    pub branch: Option<String>,
    /// True for the main worktree — the one inside `.git/`. Removing it
    /// requires removing the whole repo, which we refuse.
    pub is_main: bool,
    /// `git worktree lock` was used. Removal needs `force`.
    pub locked: bool,
    /// `git worktree list` flagged this entry as prunable (its directory
    /// was deleted out-of-band).
    pub prunable: bool,
}

/// List every worktree of the repository containing `path`. Returns an
/// empty vec when `path` isn't inside a repo (consistent with `status`).
pub async fn worktree_list<P: AsRef<Path>>(path: P) -> Result<Vec<WorktreeEntry>> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_porcelain(&stdout))
}

fn parse_worktree_porcelain(out: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut cur: Option<WorktreeEntry> = None;
    let mut first = true;

    let push = |entries: &mut Vec<WorktreeEntry>, cur: &mut Option<WorktreeEntry>, first: &mut bool| {
        if let Some(mut e) = cur.take() {
            if *first {
                e.is_main = true;
                *first = false;
            }
            entries.push(e);
        }
    };

    for line in out.lines() {
        // A blank line separates entries in porcelain format.
        if line.is_empty() {
            push(&mut entries, &mut cur, &mut first);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            // Should be impossible to see a second `worktree` before a
            // blank line, but tolerate it: emit the in-flight entry first.
            push(&mut entries, &mut cur, &mut first);
            cur = Some(WorktreeEntry {
                path: rest.to_string(),
                head_short: None,
                branch: None,
                is_main: false,
                locked: false,
                prunable: false,
            });
        } else if let Some(entry) = cur.as_mut() {
            if let Some(oid) = line.strip_prefix("HEAD ") {
                entry.head_short = Some(oid.chars().take(7).collect());
            } else if let Some(b) = line.strip_prefix("branch ") {
                entry.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "detached" {
                entry.branch = None;
            } else if line == "locked" || line.starts_with("locked ") {
                entry.locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                entry.prunable = true;
            }
            // Unknown keys (`bare`, etc.) — ignore for V1.
        }
    }
    push(&mut entries, &mut cur, &mut first);
    entries
}

/// Add a new worktree at `new_path`. When `create_branch` is true, `branch`
/// names a NEW branch to create starting at `start_point` (defaulting to
/// HEAD). When false, `branch` checks out an existing ref. Empty `branch`
/// with `create_branch=false` creates a detached worktree at HEAD.
pub async fn worktree_add<P: AsRef<Path>>(
    repo_path: P,
    new_path: &str,
    branch: Option<&str>,
    create_branch: bool,
    start_point: Option<&str>,
) -> Result<()> {
    if let Some(b) = branch {
        reject_option_like(b, "branch name")?;
    }
    if let Some(sp) = start_point {
        reject_option_like(sp, "start point")?;
    }
    let repo_path = repo_path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path).args(["worktree", "add"]);
    if create_branch {
        let name = branch
            .ok_or_else(|| Error::Failed("branch name required when create_branch=true".into()))?;
        cmd.arg("-b").arg(name);
    }
    cmd.arg(new_path);
    if let Some(start) = start_point {
        cmd.arg(start);
    } else if !create_branch {
        if let Some(b) = branch {
            cmd.arg(b);
        }
    }
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(Error::Failed(if !err.is_empty() { err } else { out }));
    }
    Ok(())
}

/// Remove the worktree rooted at `target_path`. When `force` is true, runs
/// `git worktree remove --force`, which deletes a worktree even if it has
/// modified or untracked files.
pub async fn worktree_remove<P: AsRef<Path>>(
    repo_path: P,
    target_path: &str,
    force: bool,
) -> Result<()> {
    let repo_path = repo_path.as_ref();
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path).args(["worktree", "remove"]);
    if force {
        cmd.arg("--force");
    }
    cmd.arg(target_path);
    let output = cmd.output().await.map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let out = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(Error::Failed(if !err.is_empty() { err } else { out }));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

pub async fn reset<P: AsRef<Path>>(path: P, oid: &str, mode: ResetMode) -> Result<()> {
    reject_option_like(oid, "commit")?;
    let path = path.as_ref();
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["reset", flag, oid])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    Ok(())
}

/// Return the full message of the most recent commit (for amend pre-fill).
pub async fn last_commit_message<P: AsRef<Path>>(path: P) -> Result<String> {
    let path = path.as_ref();
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["log", "-1", "--pretty=%B"])
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
}

// ----- conflict resolution -------------------------------------------------

/// Accept the "ours" version of conflicted files and stage them.
pub async fn checkout_ours<P: AsRef<Path>>(path: P, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let path = path.as_ref();
    let mut args = vec!["checkout", "--ours", "--"];
    for p in paths {
        args.push(p.as_str());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&args)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    // Stage the resolved files.
    let mut add_args = vec!["add", "--"];
    for p in paths {
        add_args.push(p.as_str());
    }
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&add_args)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    Ok(())
}

/// Accept the "theirs" version of conflicted files and stage them.
pub async fn checkout_theirs<P: AsRef<Path>>(path: P, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let path = path.as_ref();
    let mut args = vec!["checkout", "--theirs", "--"];
    for p in paths {
        args.push(p.as_str());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&args)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Failed(err));
    }
    let mut add_args = vec!["add", "--"];
    for p in paths {
        add_args.push(p.as_str());
    }
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&add_args)
        .output()
        .await
        .map_err(|e| Error::Spawn(e.to_string()))?;
    Ok(())
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

    #[test]
    fn parses_worktree_porcelain() {
        let raw = "worktree /repo\nHEAD abcdef1234567890\nbranch refs/heads/main\n\nworktree /tmp/feature\nHEAD 1234567890abcdef\nbranch refs/heads/feature\n\nworktree /tmp/detached\nHEAD deadbeefdeadbeef\ndetached\n\nworktree /tmp/locked\nHEAD cafebabecafebabe\nbranch refs/heads/old\nlocked\n";
        let parsed = parse_worktree_porcelain(raw);
        assert_eq!(parsed.len(), 4);
        assert!(parsed[0].is_main);
        assert_eq!(parsed[0].branch.as_deref(), Some("main"));
        assert_eq!(parsed[0].head_short.as_deref(), Some("abcdef1"));
        assert!(!parsed[1].is_main);
        assert_eq!(parsed[1].branch.as_deref(), Some("feature"));
        assert!(parsed[2].branch.is_none());
        assert!(parsed[3].locked);
    }

    #[tokio::test]
    async fn status_of_this_repo_returns_something() {
        // Sanity check — running from inside the workspace should resolve a repo.
        let out = status(".").await.expect("git ran");
        assert!(out.is_some(), "expected to find the arc-terminal repo");
    }
}
