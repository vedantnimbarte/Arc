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
    #[error("device login isn't configured in this build — paste a personal access token instead")]
    DeviceLoginUnavailable,
}

pub type Result<T> = std::result::Result<T, Error>;

const USER_AGENT: &str = "arc-terminal/0.1 (+https://github.com/vedantnimbarte/arc)";

// ─── OAuth device flow ────────────────────────────────────────────────────
//
// Device flow is the only OAuth grant that works for a desktop app with no
// server and no secret to keep: we ask GitHub for a short code, the user types
// it into github.com in their browser, and we poll until they approve.
//
// The client id belongs to a GitHub OAuth App with "Device flow" enabled. It
// is public by design — device flow has no client secret — so committing it is
// correct, not a leak. Override at build time with ARC_GITHUB_CLIENT_ID.
// Empty means this build can't offer device login and the UI falls back to
// pasting a personal access token.

/// OAuth App client id for the device flow. Public; see the note above.
pub const DEVICE_CLIENT_ID: &str = match option_env!("ARC_GITHUB_CLIENT_ID") {
    Some(id) => id,
    None => "",
};

/// Scopes requested at sign-in, covering every surface the GitHub tab shows:
/// repositories and their issues and pull requests (`repo`), workflow runs
/// (`workflow`), organisation repositories (`read:org`), and the notification
/// inbox (`notifications`).
const DEVICE_SCOPES: &str = "repo workflow read:org notifications";

/// What GitHub hands back when we ask to start a device login.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeStart {
    /// Secret half — we poll with this, the user never sees it.
    pub device_code: String,
    /// The code the user types into `verification_uri`, e.g. `WDJB-MJHT`.
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until `device_code` stops being accepted.
    pub expires_in: u64,
    /// Minimum seconds between polls. Polling faster earns a `slow_down`.
    pub interval: u64,
}

/// One poll's answer. The caller owns the timing, so this never sleeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePollOutcome {
    /// Nobody has entered the code yet — poll again after `interval`.
    Pending,
    /// We polled too fast; add five seconds to the interval and continue.
    SlowDown,
    /// The code aged out. Start over.
    Expired,
    /// The user pressed Cancel.
    Denied,
    Token(String),
}

/// Shared client for the two unauthenticated OAuth endpoints. The poll runs
/// every few seconds for up to fifteen minutes, so rebuilding a client — and
/// its TLS setup — per poll is pure waste.
fn oauth_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Ask GitHub for a device code. The caller shows `user_code` and
/// `verification_uri` to the user, then polls [`device_code_poll`].
pub async fn device_code_start() -> Result<DeviceCodeStart> {
    if DEVICE_CLIENT_ID.is_empty() {
        return Err(Error::DeviceLoginUnavailable);
    }
    let resp = oauth_client()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", DEVICE_CLIENT_ID), ("scope", DEVICE_SCOPES)])
        .send()
        .await
        .map_err(|e| Error::Http(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| Error::Http(e.to_string()))?;
    if !status.is_success() {
        return Err(Error::Api {
            status: status.as_u16(),
            message: oauth_message(&text),
        });
    }
    serde_json::from_str(&text).map_err(|e| Error::Http(e.to_string()))
}

/// Poll once for the token. Returns [`DevicePollOutcome::Pending`] until the
/// user approves — that is the normal answer, not an error.
pub async fn device_code_poll(device_code: &str) -> Result<DevicePollOutcome> {
    if DEVICE_CLIENT_ID.is_empty() {
        return Err(Error::DeviceLoginUnavailable);
    }
    let resp = oauth_client()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", DEVICE_CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| Error::Http(e.to_string()))?;
    let text = resp.text().await.map_err(|e| Error::Http(e.to_string()))?;
    // GitHub answers 200 for every case here, including the errors — the
    // status tells us nothing, the body does.
    let parsed: DevicePollBody =
        serde_json::from_str(&text).map_err(|e| Error::Http(e.to_string()))?;
    if let Some(token) = parsed.access_token {
        return Ok(DevicePollOutcome::Token(token));
    }
    match parsed.error.as_deref() {
        Some(code) => device_error_outcome(code),
        None => Err(Error::Http("device poll returned neither a token nor an error".into())),
    }
}

/// Map GitHub's documented device-flow error codes. Split out from the request
/// so it can be tested without a network.
fn device_error_outcome(code: &str) -> Result<DevicePollOutcome> {
    match code {
        "authorization_pending" => Ok(DevicePollOutcome::Pending),
        "slow_down" => Ok(DevicePollOutcome::SlowDown),
        "expired_token" => Ok(DevicePollOutcome::Expired),
        "access_denied" => Ok(DevicePollOutcome::Denied),
        // `incorrect_device_code`, `unsupported_grant_type`, and anything new
        // are all bugs on our side rather than states to wait out.
        other => Err(Error::Api {
            status: 400,
            message: other.to_string(),
        }),
    }
}

#[derive(Debug, Deserialize)]
struct DevicePollBody {
    access_token: Option<String>,
    error: Option<String>,
}

/// Pull a human-readable message out of an OAuth error body, which may be
/// JSON or a urlencoded form depending on which endpoint failed.
fn oauth_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error_description")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(400).collect())
}

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
    /// Commit at the tip of `head` — the key check runs are filed under.
    pub head_sha: String,
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
    /// Commit at the tip of `head` — the key check runs are filed under.
    pub head_sha: String,
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
    let mut cmd = TokioCommand::new("git");
    // GUI process, no console: without CREATE_NO_WINDOW this spawns a
    // conhost.exe (and flashes a black window). See arc_git::git_cmd.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let output = cmd
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
            .user_agent(USER_AGENT)
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
            return Err(api_error(status.as_u16(), &text));
        }
        resp.json::<T>().await.map_err(|e| Error::Http(e.to_string()))
    }

    /// GET a paginated collection, following `Link: rel="next"` until GitHub
    /// stops offering one or `MAX_PAGES` is reached.
    ///
    /// The cap is deliberate: an account with thousands of repositories would
    /// otherwise spend a chunk of its hourly rate limit filling a list nobody
    /// scrolls to the end of. Callers that need everything should search
    /// instead of paging.
    async fn get_all<T: for<'de> Deserialize<'de>>(&self, first_url: &str) -> Result<Vec<T>> {
        const MAX_PAGES: usize = 5;
        let mut url = first_url.to_string();
        let mut out: Vec<T> = Vec::new();
        for _ in 0..MAX_PAGES {
            let resp = self
                .auth_request(self.client.get(&url))
                .send()
                .await
                .map_err(|e| Error::Http(e.to_string()))?;
            let status = resp.status();
            let next = resp
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|v| v.to_str().ok())
                .and_then(next_page_url);
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                return Err(api_error(status.as_u16(), &text));
            }
            let page: Vec<T> = resp.json().await.map_err(|e| Error::Http(e.to_string()))?;
            out.extend(page);
            match next {
                Some(n) => url = n,
                None => break,
            }
        }
        Ok(out)
    }

    /// Repositories to offer in the picker.
    pub async fn list_repos(&self, scope: RepoScope) -> Result<Vec<RepoSummary>> {
        let url = match &scope {
            // `affiliation` includes repos you can push to via a team, which
            // plain /user/repos would leave out.
            RepoScope::Mine => format!(
                "{}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
                self.base_url
            ),
            RepoScope::Starred => format!("{}/user/starred?per_page=100", self.base_url),
            RepoScope::Org(name) => format!(
                "{}/orgs/{}/repos?per_page=100&sort=updated",
                self.base_url, name
            ),
        };
        let raw: Vec<GhRepo> = self.get_all(&url).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// Search every repository on GitHub. Unlike [`list_repos`] this is a
    /// single page — search results are ranked, so page two is rarely what
    /// someone typing in a box wants.
    pub async fn search_repos(&self, query: &str) -> Result<Vec<RepoSummary>> {
        let q = urlencode(query);
        let url = format!("{}/search/repositories?q={q}&per_page=50", self.base_url);
        let page: GhSearchPage<GhRepo> = self.send_json(self.client.get(&url)).await?;
        Ok(page.items.into_iter().map(Into::into).collect())
    }

    /// Organisations the signed-in account belongs to, for the repo picker's
    /// scope switcher.
    pub async fn list_orgs(&self) -> Result<Vec<Org>> {
        let url = format!("{}/user/orgs?per_page=100", self.base_url);
        let raw: Vec<GhOrg> = self.get_all(&url).await?;
        Ok(raw
            .into_iter()
            .map(|o| Org {
                login: o.login,
                avatar_url: o.avatar_url,
            })
            .collect())
    }

    // ─── Pull requests (beyond the GitHost trait) ──────────────────────────

    /// Merge a pull request. Returns the message GitHub reports, which names
    /// the resulting commit.
    pub async fn merge_pr(
        &self,
        repo: &RepoSlug,
        number: u64,
        method: MergeMethod,
    ) -> Result<String> {
        let url = format!(
            "{}/repos/{}/{}/pulls/{}/merge",
            self.base_url, repo.owner, repo.name, number
        );
        let body = serde_json::json!({
            "merge_method": match method {
                MergeMethod::Merge => "merge",
                MergeMethod::Squash => "squash",
                MergeMethod::Rebase => "rebase",
            }
        });
        let res: GhMergeResult = self.send_json(self.client.put(&url).json(&body)).await?;
        Ok(res.message)
    }

    /// Reviews left on a pull request — approvals, change requests, comments.
    pub async fn list_pr_reviews(&self, repo: &RepoSlug, number: u64) -> Result<Vec<Review>> {
        let url = format!(
            "{}/repos/{}/{}/pulls/{}/reviews?per_page=100",
            self.base_url, repo.owner, repo.name, number
        );
        let raw: Vec<GhReview> = self.get_all(&url).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// CI checks for a commit — what colours the status glyph on a PR row.
    pub async fn list_check_runs(&self, repo: &RepoSlug, sha: &str) -> Result<Vec<CheckRun>> {
        let url = format!(
            "{}/repos/{}/{}/commits/{}/check-runs?per_page=100",
            self.base_url, repo.owner, repo.name, sha
        );
        let page: GhCheckRunPage = self.send_json(self.client.get(&url)).await?;
        Ok(page.check_runs.into_iter().map(Into::into).collect())
    }

    // ─── Issues ────────────────────────────────────────────────────────────

    /// Issues in `repo`, newest activity first.
    pub async fn list_issues(
        &self,
        repo: &RepoSlug,
        filter: &IssueFilter,
    ) -> Result<Vec<IssueSummary>> {
        let state = match filter.state {
            IssueState::Open => "open",
            IssueState::Closed => "closed",
            IssueState::All => "all",
        };
        let mut url = format!(
            "{}/repos/{}/{}/issues?state={state}&per_page=100&sort=updated&direction=desc",
            self.base_url, repo.owner, repo.name
        );
        if !filter.labels.is_empty() {
            url.push_str(&format!("&labels={}", urlencode(&filter.labels.join(","))));
        }
        if let Some(a) = &filter.assignee {
            url.push_str(&format!("&assignee={}", urlencode(a)));
        }
        if let Some(a) = &filter.author {
            url.push_str(&format!("&creator={}", urlencode(a)));
        }
        let raw: Vec<GhIssue> = self.get_all(&url).await?;
        // The issues endpoint returns pull requests too — they are issues as
        // far as GitHub's data model is concerned. Without this the list would
        // show every PR twice over, once here and once under Pull requests.
        Ok(raw
            .into_iter()
            .filter(|i| i.pull_request.is_none())
            .map(Into::into)
            .collect())
    }

    /// One issue plus its comment thread.
    pub async fn get_issue(&self, repo: &RepoSlug, number: u64) -> Result<IssueDetail> {
        let base = format!(
            "{}/repos/{}/{}/issues/{}",
            self.base_url, repo.owner, repo.name, number
        );
        let issue_req = self.send_json::<GhIssue>(self.client.get(&base));
        let comments_req =
            self.send_json::<Vec<GhComment>>(self.client.get(format!("{base}/comments?per_page=100")));
        let (issue, comments) = tokio::try_join!(issue_req, comments_req)?;
        let body = issue.body.clone().unwrap_or_default();
        let summary: IssueSummary = issue.into();
        Ok(IssueDetail {
            summary,
            body,
            thread: comments.into_iter().map(Into::into).collect(),
        })
    }

    pub async fn create_issue(&self, repo: &RepoSlug, req: &NewIssue) -> Result<IssueSummary> {
        let url = format!("{}/repos/{}/{}/issues", self.base_url, repo.owner, repo.name);
        let body = serde_json::json!({
            "title": req.title,
            "body": req.body,
            "labels": req.labels,
        });
        let issue: GhIssue = self.send_json(self.client.post(&url).json(&body)).await?;
        Ok(issue.into())
    }

    /// Post a comment. Works for pull requests too — GitHub files PR
    /// conversation comments under the issues endpoint.
    pub async fn comment_issue(
        &self,
        repo: &RepoSlug,
        number: u64,
        body: &str,
    ) -> Result<Comment> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/comments",
            self.base_url, repo.owner, repo.name, number
        );
        let payload = serde_json::json!({ "body": body });
        let c: GhComment = self.send_json(self.client.post(&url).json(&payload)).await?;
        Ok(c.into())
    }

    /// Open or close an issue. Also closes a pull request, for the same
    /// reason `comment_issue` works on one.
    pub async fn set_issue_state(
        &self,
        repo: &RepoSlug,
        number: u64,
        open: bool,
    ) -> Result<IssueSummary> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}",
            self.base_url, repo.owner, repo.name, number
        );
        let payload = serde_json::json!({ "state": if open { "open" } else { "closed" } });
        let issue: GhIssue = self.send_json(self.client.patch(&url).json(&payload)).await?;
        Ok(issue.into())
    }

    /// Labels defined on the repo, for the filter menu and the create form.
    pub async fn list_labels(&self, repo: &RepoSlug) -> Result<Vec<Label>> {
        let url = format!(
            "{}/repos/{}/{}/labels?per_page=100",
            self.base_url, repo.owner, repo.name
        );
        let raw: Vec<GhLabel> = self.get_all(&url).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    // ─── Actions, releases, inbox ──────────────────────────────────────────

    /// Workflow runs, newest first.
    pub async fn list_workflow_runs(
        &self,
        repo: &RepoSlug,
        branch: Option<&str>,
    ) -> Result<Vec<WorkflowRun>> {
        let mut url = format!(
            "{}/repos/{}/{}/actions/runs?per_page=50",
            self.base_url, repo.owner, repo.name
        );
        if let Some(b) = branch {
            url.push_str(&format!("&branch={}", urlencode(b)));
        }
        let page: GhRunPage = self.send_json(self.client.get(&url)).await?;
        Ok(page.workflow_runs.into_iter().map(Into::into).collect())
    }

    /// The jobs inside one run, with each step's outcome — this is what turns
    /// "the build is red" into "which step failed".
    pub async fn get_run_jobs(&self, repo: &RepoSlug, run_id: u64) -> Result<Vec<Job>> {
        let url = format!(
            "{}/repos/{}/{}/actions/runs/{}/jobs?per_page=100",
            self.base_url, repo.owner, repo.name, run_id
        );
        let page: GhJobPage = self.send_json(self.client.get(&url)).await?;
        Ok(page.jobs.into_iter().map(Into::into).collect())
    }

    /// Re-run a workflow. `failed_only` re-runs just the failed jobs, which is
    /// almost always what someone means by "run it again".
    pub async fn rerun_workflow(
        &self,
        repo: &RepoSlug,
        run_id: u64,
        failed_only: bool,
    ) -> Result<()> {
        let suffix = if failed_only {
            "rerun-failed-jobs"
        } else {
            "rerun"
        };
        let url = format!(
            "{}/repos/{}/{}/actions/runs/{}/{suffix}",
            self.base_url, repo.owner, repo.name, run_id
        );
        self.send_empty(self.client.post(&url)).await
    }

    pub async fn cancel_workflow(&self, repo: &RepoSlug, run_id: u64) -> Result<()> {
        let url = format!(
            "{}/repos/{}/{}/actions/runs/{}/cancel",
            self.base_url, repo.owner, repo.name, run_id
        );
        self.send_empty(self.client.post(&url)).await
    }

    pub async fn list_releases(&self, repo: &RepoSlug) -> Result<Vec<Release>> {
        let url = format!(
            "{}/repos/{}/{}/releases?per_page=50",
            self.base_url, repo.owner, repo.name
        );
        let raw: Vec<GhRelease> = self.send_json(self.client.get(&url)).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// The notification inbox, across every repository.
    pub async fn list_notifications(&self, all: bool) -> Result<Vec<Notification>> {
        let url = format!(
            "{}/notifications?per_page=50&all={}",
            self.base_url, all
        );
        let raw: Vec<GhNotification> = self.send_json(self.client.get(&url)).await?;
        Ok(raw.into_iter().map(Into::into).collect())
    }

    /// Mark one notification thread read.
    pub async fn mark_notification_read(&self, thread_id: &str) -> Result<()> {
        let url = format!("{}/notifications/threads/{}", self.base_url, thread_id);
        self.send_empty(self.client.patch(&url)).await
    }

    /// Requests left in the current hour.
    ///
    /// `/rate_limit` is the one endpoint that doesn't itself count against the
    /// limit, which is why this is a separate call rather than a header read
    /// threaded through every other response.
    pub async fn rate_remaining(&self) -> Result<u32> {
        let url = format!("{}/rate_limit", self.base_url);
        let r: GhRateLimit = self.send_json(self.client.get(&url)).await?;
        Ok(r.resources.core.remaining)
    }

    /// Send a request whose success has no body worth parsing (202, 204, …).
    async fn send_empty(&self, req: reqwest::RequestBuilder) -> Result<()> {
        let resp = self
            .auth_request(req)
            .send()
            .await
            .map_err(|e| Error::Http(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let text = resp.text().await.unwrap_or_default();
        Err(api_error(status.as_u16(), &text))
    }

    /// Who the stored token belongs to. Also the cheapest way to confirm a
    /// token still works — the tab calls this on open and shows the sign-in
    /// screen again if it comes back `NeedsAuth`.
    pub async fn get_viewer(&self) -> Result<Viewer> {
        let url = format!("{}/user", self.base_url);
        let u: GhViewer = self.send_json(self.client.get(&url)).await?;
        Ok(Viewer {
            login: u.login,
            avatar_url: u.avatar_url,
            name: u.name,
        })
    }
}

/// Which set of repositories to list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "name", rename_all = "lowercase")]
pub enum RepoScope {
    /// Everything the account owns, collaborates on, or reaches through a team.
    Mine,
    Starred,
    Org(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoSummary {
    pub owner: String,
    pub name: String,
    /// `owner/name`, the form the UI keys on and shows.
    pub full_name: String,
    pub description: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    /// Empty when the repo has no detected language.
    pub language: String,
    pub stars: u32,
    pub open_issues: u32,
    pub default_branch: String,
    pub html_url: String,
    /// HTTPS remote, ready to clone.
    pub clone_url: String,
    /// ISO 8601. Empty when GitHub omitted it (never seen in practice).
    pub pushed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Org {
    pub login: String,
    pub avatar_url: String,
}

// ─── Pull request extras ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Review {
    pub author: String,
    pub author_avatar: String,
    /// `approved`, `changes_requested`, `commented`, `dismissed`, `pending`.
    pub state: String,
    pub body: String,
    /// ISO 8601. Empty for a pending review, which has no submit time yet.
    pub submitted_at: String,
}

/// One CI check on a commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckRun {
    pub name: String,
    /// `queued`, `in_progress`, `completed`.
    pub status: String,
    /// `success`, `failure`, `neutral`, `cancelled`, `timed_out`,
    /// `action_required`, `skipped`. Empty while still running.
    pub conclusion: String,
    pub html_url: String,
}

// ─── Issue types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
    All,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IssueFilter {
    #[serde(default)]
    pub state: IssueState,
    #[serde(default)]
    pub labels: Vec<String>,
    /// A login, or the literal `none` / `*` GitHub accepts.
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
}

impl Default for IssueState {
    fn default() -> Self {
        IssueState::Open
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Label {
    pub name: String,
    /// Six hex digits, no leading `#`.
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    /// `open` or `closed`. Never `all` — that's a filter, not a state.
    pub state: IssueState,
    pub author: String,
    pub author_avatar: String,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub comments: u32,
    pub html_url: String,
    /// ISO 8601.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: u64,
    pub author: String,
    pub author_avatar: String,
    pub body: String,
    /// ISO 8601.
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueDetail {
    #[serde(flatten)]
    pub summary: IssueSummary,
    pub body: String,
    /// Named `thread`, not `comments`: the flattened summary already has a
    /// `comments` count, and two fields with one JSON key would collide.
    pub thread: Vec<Comment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewIssue {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub labels: Vec<String>,
}

// ─── Actions, releases, inbox types ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub id: u64,
    /// Workflow name, e.g. "CI".
    pub name: String,
    /// The commit message's first line.
    pub title: String,
    /// `queued`, `in_progress`, `completed`, `waiting`, `requested`.
    pub status: String,
    /// `success`, `failure`, `cancelled`, … Empty while still running.
    pub conclusion: String,
    pub branch: String,
    pub event: String,
    /// Monotonic per-workflow run number, the `#42` GitHub shows.
    pub run_number: u64,
    pub actor: String,
    pub html_url: String,
    /// ISO 8601.
    pub created_at: String,
    /// ISO 8601. Empty while still running.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub html_url: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub name: String,
    pub status: String,
    pub conclusion: String,
    pub number: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub tag: String,
    pub name: String,
    pub body: String,
    pub draft: bool,
    pub prerelease: bool,
    pub author: String,
    pub html_url: String,
    /// ISO 8601. Empty for an unpublished draft.
    pub published_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    /// What it's about — the issue or PR title, or the commit subject.
    pub title: String,
    /// `Issue`, `PullRequest`, `Commit`, `Release`, `Discussion`, …
    pub subject_type: String,
    /// Why it reached you: `assign`, `author`, `mention`, `review_requested`,
    /// `subscribed`, `team_mention`, `state_change`, `comment`, `ci_activity`.
    pub reason: String,
    /// `owner/name`.
    pub repo: String,
    pub unread: bool,
    /// ISO 8601.
    pub updated_at: String,
    /// The issue or PR number this points at, when it points at one. GitHub
    /// only gives an API URL, so this is parsed out of its last segment.
    pub number: Option<u64>,
}

/// The signed-in account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Viewer {
    pub login: String,
    pub avatar_url: String,
    /// Display name, when the account has one set.
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhViewer {
    login: String,
    avatar_url: String,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhRateLimit {
    resources: GhRateResources,
}

#[derive(Debug, Deserialize)]
struct GhRateResources {
    core: GhRateBucket,
}

#[derive(Debug, Deserialize)]
struct GhRateBucket {
    remaining: u32,
}

#[derive(Debug, Deserialize)]
struct GhRunPage {
    #[serde(default)]
    workflow_runs: Vec<GhRun>,
}

#[derive(Debug, Deserialize)]
struct GhRun {
    id: u64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_title: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    head_branch: Option<String>,
    #[serde(default)]
    event: String,
    #[serde(default)]
    run_number: u64,
    #[serde(default)]
    actor: Option<GhUser>,
    html_url: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
}

impl From<GhRun> for WorkflowRun {
    fn from(r: GhRun) -> Self {
        Self {
            id: r.id,
            name: r.name.unwrap_or_default(),
            title: r.display_title.unwrap_or_default(),
            status: r.status.unwrap_or_default(),
            conclusion: r.conclusion.unwrap_or_default(),
            branch: r.head_branch.unwrap_or_default(),
            event: r.event,
            run_number: r.run_number,
            actor: r.actor.map(|u| u.login).unwrap_or_default(),
            html_url: r.html_url,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GhJobPage {
    #[serde(default)]
    jobs: Vec<GhJob>,
}

#[derive(Debug, Deserialize)]
struct GhJob {
    id: u64,
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    steps: Vec<GhStep>,
}

#[derive(Debug, Deserialize)]
struct GhStep {
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    number: u32,
}

impl From<GhJob> for Job {
    fn from(j: GhJob) -> Self {
        Self {
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion.unwrap_or_default(),
            html_url: j.html_url.unwrap_or_default(),
            steps: j
                .steps
                .into_iter()
                .map(|s| Step {
                    name: s.name,
                    status: s.status,
                    conclusion: s.conclusion.unwrap_or_default(),
                    number: s.number,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    author: Option<GhUser>,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
}

impl From<GhRelease> for Release {
    fn from(r: GhRelease) -> Self {
        Self {
            name: r.name.filter(|n| !n.is_empty()).unwrap_or_else(|| r.tag_name.clone()),
            tag: r.tag_name,
            body: r.body.unwrap_or_default(),
            draft: r.draft,
            prerelease: r.prerelease,
            author: r.author.map(|u| u.login).unwrap_or_default(),
            html_url: r.html_url,
            published_at: r.published_at.unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GhNotification {
    id: String,
    #[serde(default)]
    unread: bool,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    updated_at: String,
    subject: GhSubject,
    repository: GhNotificationRepo,
}

#[derive(Debug, Deserialize)]
struct GhSubject {
    #[serde(default)]
    title: String,
    /// API URL, e.g. `.../repos/o/n/issues/42`. There is no plain number field.
    #[serde(default)]
    url: Option<String>,
    #[serde(default, rename = "type")]
    subject_type: String,
}

#[derive(Debug, Deserialize)]
struct GhNotificationRepo {
    #[serde(default)]
    full_name: String,
}

impl From<GhNotification> for Notification {
    fn from(n: GhNotification) -> Self {
        Self {
            id: n.id,
            title: n.subject.title,
            number: n.subject.url.as_deref().and_then(number_from_api_url),
            subject_type: n.subject.subject_type,
            reason: n.reason,
            repo: n.repository.full_name,
            unread: n.unread,
            updated_at: n.updated_at,
        }
    }
}

/// Pull the trailing issue/PR number off a GitHub API URL. Returns `None` for
/// subjects that aren't numbered (a `Commit` URL ends in a SHA, a `Release`
/// URL in a release id we don't want).
fn number_from_api_url(url: &str) -> Option<u64> {
    let (head, last) = url.trim_end_matches('/').rsplit_once('/')?;
    if !(head.ends_with("/issues") || head.ends_with("/pulls")) {
        return None;
    }
    last.parse().ok()
}

#[derive(Debug, Deserialize)]
struct GhMergeResult {
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct GhReview {
    user: Option<GhUser>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: Option<String>,
}

impl From<GhReview> for Review {
    fn from(r: GhReview) -> Self {
        Self {
            author: r.user.as_ref().map(|u| u.login.clone()).unwrap_or_default(),
            author_avatar: r
                .user
                .as_ref()
                .map(|u| u.avatar_url.clone())
                .unwrap_or_default(),
            state: r.state,
            body: r.body,
            submitted_at: r.submitted_at.unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct GhCheckRunPage {
    #[serde(default)]
    check_runs: Vec<GhCheckRun>,
}

#[derive(Debug, Deserialize)]
struct GhCheckRun {
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}

impl From<GhCheckRun> for CheckRun {
    fn from(c: GhCheckRun) -> Self {
        Self {
            name: c.name,
            status: c.status,
            conclusion: c.conclusion.unwrap_or_default(),
            html_url: c.html_url.unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct GhIssue {
    number: u64,
    title: String,
    body: Option<String>,
    state: String, // open / closed
    user: Option<GhUser>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    assignees: Vec<GhUser>,
    #[serde(default)]
    comments: u32,
    html_url: String,
    updated_at: String,
    /// Present only when this "issue" is really a pull request. Its presence
    /// is the only way GitHub distinguishes the two on `/issues`.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct GhLabel {
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GhComment {
    id: u64,
    user: Option<GhUser>,
    #[serde(default)]
    body: String,
    created_at: String,
}

impl From<GhLabel> for Label {
    fn from(l: GhLabel) -> Self {
        Self {
            name: l.name,
            color: l.color,
        }
    }
}

impl From<GhComment> for Comment {
    fn from(c: GhComment) -> Self {
        Self {
            id: c.id,
            author: c.user.as_ref().map(|u| u.login.clone()).unwrap_or_default(),
            author_avatar: c
                .user
                .as_ref()
                .map(|u| u.avatar_url.clone())
                .unwrap_or_default(),
            body: c.body,
            created_at: c.created_at,
        }
    }
}

impl From<GhIssue> for IssueSummary {
    fn from(i: GhIssue) -> Self {
        Self {
            number: i.number,
            title: i.title,
            state: if i.state == "open" {
                IssueState::Open
            } else {
                IssueState::Closed
            },
            author: i.user.as_ref().map(|u| u.login.clone()).unwrap_or_default(),
            author_avatar: i
                .user
                .as_ref()
                .map(|u| u.avatar_url.clone())
                .unwrap_or_default(),
            labels: i.labels.into_iter().map(Into::into).collect(),
            assignees: i.assignees.into_iter().map(|u| u.login).collect(),
            comments: i.comments,
            html_url: i.html_url,
            updated_at: i.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GhOrg {
    login: String,
    avatar_url: String,
}

#[derive(Debug, Deserialize)]
struct GhSearchPage<T> {
    items: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct GhRepo {
    name: String,
    full_name: String,
    owner: GhUser,
    description: Option<String>,
    private: bool,
    fork: bool,
    #[serde(default)]
    archived: bool,
    language: Option<String>,
    #[serde(default)]
    stargazers_count: u32,
    #[serde(default)]
    open_issues_count: u32,
    #[serde(default)]
    default_branch: String,
    html_url: String,
    #[serde(default)]
    clone_url: String,
    pushed_at: Option<String>,
}

impl From<GhRepo> for RepoSummary {
    fn from(r: GhRepo) -> Self {
        Self {
            owner: r.owner.login,
            name: r.name,
            full_name: r.full_name,
            description: r.description.unwrap_or_default(),
            private: r.private,
            fork: r.fork,
            archived: r.archived,
            language: r.language.unwrap_or_default(),
            stars: r.stargazers_count,
            open_issues: r.open_issues_count,
            default_branch: r.default_branch,
            html_url: r.html_url,
            clone_url: r.clone_url,
            pushed_at: r.pushed_at.unwrap_or_default(),
        }
    }
}

/// Extract the `rel="next"` URL from a GitHub `Link` header, if there is one.
///
/// The header looks like:
///   `<https://api.github.com/…&page=2>; rel="next", <…&page=9>; rel="last"`
fn next_page_url(link_header: &str) -> Option<String> {
    for part in link_header.split(',') {
        let (url_part, rest) = part.split_once(';')?;
        if !rest.contains("rel=\"next\"") {
            continue;
        }
        let url = url_part.trim().trim_start_matches('<').trim_end_matches('>');
        if url.is_empty() {
            return None;
        }
        return Some(url.to_string());
    }
    None
}

/// Build an [`Error`] from a failed response, preferring GitHub's structured
/// `message` over the raw body. Shared by `send_json` and `get_all`.
fn api_error(status: u16, body: &str) -> Error {
    if status == 401 || status == 403 {
        return Error::NeedsAuth;
    }
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str().map(|s| s.to_string())))
        .unwrap_or_else(|| body.chars().take(400).collect());
    Error::Api { status, message }
}

/// Percent-encode a query-string value. Only the handful of characters that
/// actually break a GitHub search URL — pulling in a URL crate for this would
/// be a dependency for six lines.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
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
            head_sha: summary.head_sha,
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
    /// Commit the ref points at. Needed to ask for the PR's check runs, which
    /// are filed against a commit rather than the pull request.
    #[serde(default)]
    sha: String,
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
            head_sha: p.head.sha,
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
    fn maps_every_documented_device_error() {
        assert_eq!(
            device_error_outcome("authorization_pending").unwrap(),
            DevicePollOutcome::Pending
        );
        assert_eq!(
            device_error_outcome("slow_down").unwrap(),
            DevicePollOutcome::SlowDown
        );
        assert_eq!(
            device_error_outcome("expired_token").unwrap(),
            DevicePollOutcome::Expired
        );
        assert_eq!(
            device_error_outcome("access_denied").unwrap(),
            DevicePollOutcome::Denied
        );
    }

    #[test]
    fn unknown_device_error_is_an_error_not_a_wait() {
        // Treating an unrecognized code as Pending would spin the sign-in
        // screen forever instead of telling the user what happened.
        assert!(device_error_outcome("incorrect_device_code").is_err());
    }

    #[test]
    fn finds_the_next_page_link() {
        let header = r#"<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last""#;
        assert_eq!(
            next_page_url(header).as_deref(),
            Some("https://api.github.com/user/repos?page=2")
        );
    }

    #[test]
    fn last_page_has_no_next() {
        // On the final page GitHub sends only prev/first — stopping here is
        // what ends the paging loop, so getting it wrong would loop forever.
        let header = r#"<https://api.github.com/user/repos?page=8>; rel="prev", <https://api.github.com/user/repos?page=1>; rel="first""#;
        assert_eq!(next_page_url(header), None);
        assert_eq!(next_page_url(""), None);
    }

    #[test]
    fn next_is_found_after_other_rels() {
        let header = r#"<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next""#;
        assert_eq!(next_page_url(header).as_deref(), Some("https://api.github.com/x?page=3"));
    }

    #[test]
    fn urlencodes_what_breaks_a_query() {
        assert_eq!(urlencode("arc terminal"), "arc%20terminal");
        assert_eq!(urlencode("user:octocat"), "user%3Aoctocat");
        assert_eq!(urlencode("safe-Name_1.0~"), "safe-Name_1.0~");
    }

    #[test]
    fn reads_a_number_off_a_notification_subject_url() {
        assert_eq!(
            number_from_api_url("https://api.github.com/repos/o/n/issues/42"),
            Some(42)
        );
        assert_eq!(
            number_from_api_url("https://api.github.com/repos/o/n/pulls/7"),
            Some(7)
        );
    }

    #[test]
    fn unnumbered_notification_subjects_yield_none() {
        // A commit URL ends in a SHA and a release URL in a release id —
        // parsing either as an issue number would deep-link to the wrong thing.
        assert_eq!(
            number_from_api_url("https://api.github.com/repos/o/n/commits/abc123"),
            None
        );
        assert_eq!(
            number_from_api_url("https://api.github.com/repos/o/n/releases/9912"),
            None
        );
        assert_eq!(number_from_api_url(""), None);
    }

    #[test]
    fn api_error_maps_auth_statuses() {
        assert!(matches!(api_error(401, ""), Error::NeedsAuth));
        assert!(matches!(api_error(403, ""), Error::NeedsAuth));
        match api_error(422, r#"{"message":"Validation failed"}"#) {
            Error::Api { status, message } => {
                assert_eq!(status, 422);
                assert_eq!(message, "Validation failed");
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[test]
    fn oauth_message_prefers_the_description() {
        assert_eq!(
            oauth_message(r#"{"error":"bad_verification_code","error_description":"Code expired."}"#),
            "Code expired."
        );
        assert_eq!(oauth_message(r#"{"error":"bad_verification_code"}"#), "bad_verification_code");
        assert_eq!(oauth_message("<html>502</html>"), "<html>502</html>");
    }

    #[test]
    fn rejects_partial_path() {
        assert_eq!(parse_github_slug("https://github.com/just-owner"), None);
        assert_eq!(parse_github_slug("https://github.com/"), None);
    }
}
