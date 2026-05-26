//! arc-git-host — code-forge integrations (PRs, issues, …).
//!
//! V1 ships a single backend: GitHub. The [`GitHost`] trait keeps room for
//! a future GitLab implementation behind the same surface.
//!
//! Scope: list pull requests, fetch a single PR with its commits + file diff,
//! create a new PR. Comments, reviews, line-level threads, and one-click
//! merge are intentionally deferred — each is a significant sub-feature.
//!
//! Auth: Personal Access Token. The PAT is stored in the OS keychain by the
//! desktop crate (under the `dev.arc.terminal.git-host` service) and passed
//! into the host's constructor. We don't manage credentials inside this
//! crate.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::process::Command as TokioCommand;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(String),
    #[error("http: {0}")]
    Http(String),
    #[error("api error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("not a recognized git host: {0}")]
    UnsupportedHost(String),
    #[error("authentication required — set a personal access token")]
    NeedsAuth,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Common PR state across forges.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// Filter for `list_prs`. Matches the typical UI toggle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrListFilter {
    Open,
    Closed,
    All,
}

/// Lightweight PR summary — what the list view shows. The detail view
/// fetches a [`PrDetail`] with commits + file diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub state: PrState,
    pub author: String,
    /// Author's avatar URL (empty for backends that don't provide one).
    pub author_avatar: String,
    pub head: String,
    pub base: String,
    pub html_url: String,
    pub draft: bool,
    /// ISO 8601 timestamp.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrCommit {
    pub oid: String,
    pub short: String,
    pub message: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrFile {
    pub path: String,
    pub status: String, // added / modified / removed / renamed
    pub additions: u32,
    pub deletions: u32,
    /// Unified diff patch for the file. `None` for binary files or when the
    /// patch was truncated by the API.
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: PrState,
    pub author: String,
    pub author_avatar: String,
    pub head: String,
    pub base: String,
    pub html_url: String,
    pub draft: bool,
    pub commits: Vec<PrCommit>,
    pub files: Vec<PrFile>,
    pub mergeable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePrRequest {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

/// `owner/name` parsed out of a remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSlug {
    pub owner: String,
    pub name: String,
}

#[async_trait]
pub trait GitHost: Send + Sync {
    async fn list_prs(&self, repo: &RepoSlug, filter: PrListFilter) -> Result<Vec<PrSummary>>;
    async fn get_pr(&self, repo: &RepoSlug, number: u64) -> Result<PrDetail>;
    async fn create_pr(&self, repo: &RepoSlug, req: &CreatePrRequest) -> Result<PrSummary>;
}

// ─── Remote URL → repo slug ────────────────────────────────────────────────

/// Detect the GitHub `owner/name` of the repository at `path` by reading
/// `git remote get-url origin`. Returns `Ok(None)` when:
///   * the directory isn't a repo
///   * `origin` isn't set
///   * `origin` isn't a recognized GitHub URL
pub async fn detect_github_slug(path: &str) -> Result<Option<RepoSlug>> {
    let output = TokioCommand::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .await
        .map_err(|e| Error::Io(e.to_string()))?;
    if !output.status.success() {
        return Ok(None);
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(parse_github_slug(&url))
}

/// Pure helper — extract `owner/name` from a GitHub URL. Recognized shapes:
///   * `https://github.com/owner/name`
///   * `https://github.com/owner/name.git`
///   * `git@github.com:owner/name.git`
///   * `ssh://git@github.com/owner/name.git`
pub fn parse_github_slug(url: &str) -> Option<RepoSlug> {
    let stripped = url.trim().trim_end_matches('/').trim_end_matches(".git");
    // SSH shorthand: git@github.com:owner/name
    if let Some(rest) = stripped.strip_prefix("git@github.com:") {
        return slug_from_path(rest);
    }
    // ssh://git@github.com/owner/name
    if let Some(rest) = stripped.strip_prefix("ssh://git@github.com/") {
        return slug_from_path(rest);
    }
    // https://github.com/owner/name
    for prefix in ["https://github.com/", "http://github.com/"] {
        if let Some(rest) = stripped.strip_prefix(prefix) {
            return slug_from_path(rest);
        }
    }
    None
}

fn slug_from_path(path: &str) -> Option<RepoSlug> {
    let mut parts = path.splitn(3, '/');
    let owner = parts.next()?;
    let name = parts.next()?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(RepoSlug {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

// ─── GitHub implementation ────────────────────────────────────────────────

pub struct GitHubHost {
    token: String,
    client: reqwest::Client,
    base_url: String,
}

impl GitHubHost {
    /// New host bound to `token` (a GitHub PAT — classic or fine-grained).
    /// Pass an empty string only when you intend to call public endpoints
    /// for already-public repos — most PR endpoints require auth even on
    /// public repos due to rate limits.
    pub fn new(token: impl Into<String>) -> Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent("arc-terminal/0.1 (+https://github.com/vedantnimbarte/arc)")
            .build()
            .map_err(|e| Error::Http(e.to_string()))?;
        Ok(Self {
            token: token.into(),
            client,
            base_url: "https://api.github.com".to_string(),
        })
    }

    fn auth_request(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let b = builder
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if self.token.is_empty() {
            b
        } else {
            b.bearer_auth(&self.token)
        }
    }

    async fn send_json<T: for<'de> Deserialize<'de>>(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<T> {
        let resp = self
            .auth_request(req)
            .send()
            .await
            .map_err(|e| Error::Http(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(Error::NeedsAuth);
            }
            // Try to extract GitHub's structured message; fall back to body.
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("message").and_then(|m| m.as_str().map(|s| s.to_string())))
                .unwrap_or_else(|| text.chars().take(400).collect());
            return Err(Error::Api {
                status: status.as_u16(),
                message,
            });
        }
        resp.json::<T>().await.map_err(|e| Error::Http(e.to_string()))
    }
}

#[async_trait]
impl GitHost for GitHubHost {
    async fn list_prs(&self, repo: &RepoSlug, filter: PrListFilter) -> Result<Vec<PrSummary>> {
        let state = match filter {
            PrListFilter::Open => "open",
            PrListFilter::Closed => "closed",
            PrListFilter::All => "all",
        };
        let url = format!(
            "{}/repos/{}/{}/pulls?state={state}&per_page=50&sort=updated&direction=desc",
            self.base_url, repo.owner, repo.name
        );
        let raw: Vec<GhPr> = self.send_json(self.client.get(&url)).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    async fn get_pr(&self, repo: &RepoSlug, number: u64) -> Result<PrDetail> {
        let base = format!(
            "{}/repos/{}/{}/pulls/{}",
            self.base_url, repo.owner, repo.name, number
        );
        // Issue three parallel-ish calls. tokio::try_join! gives concurrency
        // without spawning explicit tasks.
        let pr_url = base.clone();
        let commits_url = format!("{base}/commits?per_page=100");
        let files_url = format!("{base}/files?per_page=100");

        let pr_req = self.send_json::<GhPr>(self.client.get(pr_url));
        let commits_req = self.send_json::<Vec<GhCommit>>(self.client.get(commits_url));
        let files_req = self.send_json::<Vec<GhFile>>(self.client.get(files_url));

        let (pr, commits, files) = tokio::try_join!(pr_req, commits_req, files_req)?;
        let summary: PrSummary = pr.clone().into();
        Ok(PrDetail {
            number: summary.number,
            title: summary.title,
            body: pr.body.unwrap_or_default(),
            state: summary.state,
            author: summary.author,
            author_avatar: summary.author_avatar,
            head: summary.head,
            base: summary.base,
            html_url: summary.html_url,
            draft: summary.draft,
            commits: commits
                .into_iter()
                .map(|c| PrCommit {
                    short: c.sha.chars().take(7).collect(),
                    oid: c.sha,
                    message: c.commit.message,
                    author: c.commit.author.name,
                })
                .collect(),
            files: files
                .into_iter()
                .map(|f| PrFile {
                    path: f.filename,
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                    patch: f.patch,
                })
                .collect(),
            mergeable: pr.mergeable,
        })
    }

    async fn create_pr(&self, repo: &RepoSlug, req: &CreatePrRequest) -> Result<PrSummary> {
        let url = format!(
            "{}/repos/{}/{}/pulls",
            self.base_url, repo.owner, repo.name
        );
        let body = serde_json::json!({
            "title": req.title,
            "body": req.body,
            "head": req.head,
            "base": req.base,
            "draft": req.draft,
        });
        let pr: GhPr = self
            .send_json(self.client.post(&url).json(&body))
            .await?;
        Ok(pr.into())
    }
}

// ─── GitHub wire types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
struct GhPr {
    number: u64,
    title: String,
    body: Option<String>,
    state: String,        // open / closed
    merged: Option<bool>, // present on the detail endpoint
    draft: bool,
    html_url: String,
    updated_at: String,
    user: Option<GhUser>,
    head: GhRef,
    base: GhRef,
    mergeable: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhUser {
    login: String,
    avatar_url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GhRef {
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GhCommit {
    sha: String,
    commit: GhCommitInner,
}

#[derive(Debug, Clone, Deserialize)]
struct GhCommitInner {
    message: String,
    author: GhAuthor,
}

#[derive(Debug, Clone, Deserialize)]
struct GhAuthor {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GhFile {
    filename: String,
    status: String,
    additions: u32,
    deletions: u32,
    #[serde(default)]
    patch: Option<String>,
}

impl From<GhPr> for PrSummary {
    fn from(p: GhPr) -> Self {
        let state = if p.merged.unwrap_or(false) {
            PrState::Merged
        } else {
            match p.state.as_str() {
                "open" => PrState::Open,
                _ => PrState::Closed,
            }
        };
        Self {
            number: p.number,
            title: p.title,
            state,
            author: p.user.as_ref().map(|u| u.login.clone()).unwrap_or_default(),
            author_avatar: p
                .user
                .as_ref()
                .map(|u| u.avatar_url.clone())
                .unwrap_or_default(),
            head: p.head.ref_name,
            base: p.base.ref_name,
            html_url: p.html_url,
            draft: p.draft,
            updated_at: p.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_https_url() {
        assert_eq!(
            parse_github_slug("https://github.com/octocat/Hello-World"),
            Some(RepoSlug {
                owner: "octocat".into(),
                name: "Hello-World".into()
            }),
        );
    }

    #[test]
    fn parses_https_url_with_git_suffix() {
        assert_eq!(
            parse_github_slug("https://github.com/octocat/Hello-World.git"),
            Some(RepoSlug {
                owner: "octocat".into(),
                name: "Hello-World".into()
            }),
        );
    }

    #[test]
    fn parses_ssh_shorthand() {
        assert_eq!(
            parse_github_slug("git@github.com:octocat/Hello-World.git"),
            Some(RepoSlug {
                owner: "octocat".into(),
                name: "Hello-World".into()
            }),
        );
    }

    #[test]
    fn parses_ssh_url() {
        assert_eq!(
            parse_github_slug("ssh://git@github.com/octocat/Hello-World.git"),
            Some(RepoSlug {
                owner: "octocat".into(),
                name: "Hello-World".into()
            }),
        );
    }

    #[test]
    fn rejects_other_hosts() {
        assert_eq!(parse_github_slug("https://gitlab.com/foo/bar"), None);
        assert_eq!(parse_github_slug("https://example.com/x/y"), None);
    }

    #[test]
    fn rejects_partial_path() {
        assert_eq!(parse_github_slug("https://github.com/just-owner"), None);
        assert_eq!(parse_github_slug("https://github.com/"), None);
    }
}
