//! Tauri command surface for [`arc_git_host`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("git_host_detect", { path })                          -> Option<RepoSlug>
//!   invoke("git_host_device_login_available")                    -> bool
//!   invoke("git_host_device_login")                              -> topic (streams)
//!   invoke("git_host_viewer")                                    -> Viewer
//!   invoke("git_host_token_set",  { provider, token })           -> ()
//!   invoke("git_host_token_get",  { provider })                  -> Option<String>
//!   invoke("git_host_token_delete", { provider })                -> ()
//!   invoke("git_host_pr_get",  { path, number })                 -> PrDetail
//!   invoke("git_host_pr_create", { path, req })                  -> PrSummary
//!   invoke("git_host_repo_list", { scope })                      -> Vec<RepoSummary>
//!   invoke("git_host_repo_search", { query })                    -> Vec<RepoSummary>
//!   invoke("git_host_org_list")                                  -> Vec<Org>
//!   invoke("git_host_clone", { url, dest })                      -> topic (streams)
//!
//! Repo-addressed (owner + name, for repos that aren't checked out):
//!   git_host_issue_list / _get / _create / _comment / _set_state
//!   git_host_label_list
//!   git_host_pr_list_for / _get_for / _merge / _reviews / git_host_check_runs
//!   git_host_run_list / _jobs / _rerun / _cancel
//!   git_host_release_list
//!   git_host_notification_list / _read
//!   git_host_rate_remaining
//!
//! Auth: PATs live in the OS keychain under the `dev.arc.terminal.git-host`
//! service, keyed by provider id (currently always `github`). The frontend
//! lifts/drops them via the `git_host_token_*` commands.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use arc_git_host::{
    detect_github_slug, device_code_poll, device_code_start, CreatePrRequest, DevicePollOutcome,
    CheckRun, Comment, GitHost, GitHubHost, IssueDetail, IssueFilter, IssueSummary, Job, Label,
    MergeMethod, NewIssue, Notification, Org, PrDetail, PrListFilter, PrSummary, Release, RepoScope,
    RepoSlug, RepoSummary, Review, Viewer, WorkflowRun, DEVICE_CLIENT_ID,
};
use keyring::Entry;
use tauri::{AppHandle, Emitter};

const KEYRING_SERVICE: &str = "dev.arc.terminal.git-host";

#[derive(serde::Serialize)]
pub struct RepoSlugDto {
    pub owner: String,
    pub name: String,
}

impl From<RepoSlug> for RepoSlugDto {
    fn from(s: RepoSlug) -> Self {
        Self { owner: s.owner, name: s.name }
    }
}

#[tauri::command]
pub async fn git_host_detect(path: String) -> Result<Option<RepoSlugDto>, String> {
    detect_github_slug(&path)
        .await
        .map(|opt| opt.map(Into::into))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_host_token_set(provider: String, token: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &provider).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_host_token_get(provider: String) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn git_host_token_delete(provider: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Sign in ───────────────────────────────────────────────────────────────

/// Whether this build can offer "Sign in with GitHub". False when no OAuth
/// App client id was compiled in, in which case the sign-in screen shows only
/// the personal-access-token field.
#[tauri::command]
pub fn git_host_device_login_available() -> bool {
    !DEVICE_CLIENT_ID.is_empty()
}

/// Run an OAuth device login to completion, streaming its two visible steps.
///
/// Returns a topic immediately and emits on it:
///   `{ kind: "code",  payload: { user_code, verification_uri, expires_in } }`
///   `{ kind: "done",  payload: { login } }`   — token already in the keychain
///   `{ kind: "error", payload: { message } }`
///
/// Exactly one terminal event (`done` or `error`) is emitted on every path,
/// including a panic-free early return — without that guarantee the sign-in
/// screen would sit on its spinner forever. The token is written to the same
/// keychain entry `git_host_token_set` uses, so every existing command picks
/// it up with no further wiring.
#[tauri::command]
pub async fn git_host_device_login(app: AppHandle) -> Result<String, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let topic = format!("github://device-login/{}", NEXT.fetch_add(1, Ordering::Relaxed));

    let emit_topic = topic.clone();
    tauri::async_runtime::spawn(async move {
        let terminal = match run_device_login(&app, &emit_topic).await {
            Ok(login) => serde_json::json!({ "kind": "done", "payload": { "login": login } }),
            Err(message) => {
                tracing::warn!("github device login failed: {message}");
                serde_json::json!({ "kind": "error", "payload": { "message": message } })
            }
        };
        let _ = app.emit(&emit_topic, terminal);
    });

    Ok(topic)
}

/// The login itself. Split out so the spawned task above has exactly one place
/// to turn a failure into the terminal `error` event.
async fn run_device_login(app: &AppHandle, topic: &str) -> Result<String, String> {
    let start = device_code_start().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        topic,
        serde_json::json!({
            "kind": "code",
            "payload": {
                "user_code": start.user_code,
                "verification_uri": start.verification_uri,
                "expires_in": start.expires_in,
            }
        }),
    );

    // GitHub's `interval` is a floor, not a suggestion — polling faster earns
    // a `slow_down`, which costs five seconds each time it happens.
    let mut interval = Duration::from_secs(start.interval.max(1));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(start.expires_in.max(1));

    loop {
        if tokio::time::Instant::now() >= deadline {
            return Err("The sign-in code expired. Start again.".to_string());
        }
        tokio::time::sleep(interval).await;
        match device_code_poll(&start.device_code)
            .await
            .map_err(|e| e.to_string())?
        {
            DevicePollOutcome::Pending => continue,
            DevicePollOutcome::SlowDown => {
                interval += Duration::from_secs(5);
                continue;
            }
            DevicePollOutcome::Expired => {
                return Err("The sign-in code expired. Start again.".to_string())
            }
            DevicePollOutcome::Denied => {
                return Err("Sign-in was cancelled on github.com.".to_string())
            }
            DevicePollOutcome::Token(token) => {
                // Confirm the token before storing it: a token we can't call
                // /user with is one the tab would fail on anyway, and storing
                // it would leave the user "signed in" to a broken session.
                let host = GitHubHost::new(&token).map_err(|e| e.to_string())?;
                let viewer = host.get_viewer().await.map_err(|e| e.to_string())?;
                let entry =
                    Entry::new(KEYRING_SERVICE, "github").map_err(|e| e.to_string())?;
                entry.set_password(&token).map_err(|e| e.to_string())?;
                return Ok(viewer.login);
            }
        }
    }
}

/// The account the stored token belongs to. Errors with the standard
/// no-token message when nothing is saved, which the tab reads as "signed out".
#[tauri::command]
pub async fn git_host_viewer() -> Result<Viewer, String> {
    let host = make_host()?;
    host.get_viewer().await.map_err(|e| e.to_string())
}

/// A host bound to the stored PAT, with no repository attached — for the
/// account-level endpoints (viewer, repo list, notifications).
fn make_host() -> Result<GitHubHost, String> {
    let entry = Entry::new(KEYRING_SERVICE, "github").map_err(|e| e.to_string())?;
    let token = entry.get_password().unwrap_or_default();
    if token.is_empty() {
        return Err(NO_TOKEN.to_string());
    }
    GitHubHost::new(token).map_err(|e| e.to_string())
}

const NO_TOKEN: &str = "Not signed in to GitHub — open the GitHub tab to sign in.";

// ─── Repositories ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_host_repo_list(scope: RepoScope) -> Result<Vec<RepoSummary>, String> {
    make_host()?.list_repos(scope).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_repo_search(query: String) -> Result<Vec<RepoSummary>, String> {
    make_host()?
        .search_repos(&query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_org_list() -> Result<Vec<Org>, String> {
    make_host()?.list_orgs().await.map_err(|e| e.to_string())
}

/// Clone `url` into `dest`, streaming git's progress.
///
/// Returns a topic immediately and emits on it:
///   `{ kind: "progress", payload: { line } }`  — one per line git prints
///   `{ kind: "done",     payload: { path } }`
///   `{ kind: "error",    payload: { message } }`
///
/// The stored token is passed down so private repositories work: `git_cmd`
/// disables terminal prompting, so without it git has no way to authenticate.
/// `arc_git::clone_repo` scrubs it back out of `origin` when the clone lands.
#[tauri::command]
pub async fn git_host_clone(app: AppHandle, url: String, dest: String) -> Result<String, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let topic = format!("github://clone/{}", NEXT.fetch_add(1, Ordering::Relaxed));

    // Read the keychain here rather than inside the task: a missing token is
    // fine (public repos clone anonymously), but a locked vault should not
    // look like a clone failure.
    let token = Entry::new(KEYRING_SERVICE, "github")
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default();

    let emit_topic = topic.clone();
    tauri::async_runtime::spawn(async move {
        let app2 = app.clone();
        let t2 = emit_topic.clone();
        let result = arc_git::clone_repo(
            &url,
            &dest,
            if token.is_empty() { None } else { Some(token.as_str()) },
            move |line| {
                let _ = app2.emit(
                    &t2,
                    serde_json::json!({ "kind": "progress", "payload": { "line": line } }),
                );
            },
        )
        .await;
        let terminal = match result {
            Ok(()) => serde_json::json!({ "kind": "done", "payload": { "path": dest } }),
            Err(e) => {
                tracing::warn!("github clone failed: {e}");
                serde_json::json!({ "kind": "error", "payload": { "message": e.to_string() } })
            }
        };
        let _ = app.emit(&emit_topic, terminal);
    });

    Ok(topic)
}

// ─── Issues ────────────────────────────────────────────────────────────────
//
// Every command below takes `owner` + `name` rather than a workspace path: the
// GitHub tab browses repositories that may not be checked out at all, so there
// is nothing on disk to detect a slug from. The path-based `git_host_pr_*`
// commands stay as they are for the Source Control sidebar, which is always
// looking at the repo the user has open.

fn slug(owner: String, name: String) -> RepoSlug {
    RepoSlug { owner, name }
}

#[tauri::command]
pub async fn git_host_issue_list(
    owner: String,
    name: String,
    filter: IssueFilter,
) -> Result<Vec<IssueSummary>, String> {
    make_host()?
        .list_issues(&slug(owner, name), &filter)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_issue_get(
    owner: String,
    name: String,
    number: u64,
) -> Result<IssueDetail, String> {
    make_host()?
        .get_issue(&slug(owner, name), number)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_issue_create(
    owner: String,
    name: String,
    req: NewIssue,
) -> Result<IssueSummary, String> {
    make_host()?
        .create_issue(&slug(owner, name), &req)
        .await
        .map_err(|e| e.to_string())
}

/// Also used for pull request conversation comments — GitHub files those under
/// the issues endpoint.
#[tauri::command]
pub async fn git_host_issue_comment(
    owner: String,
    name: String,
    number: u64,
    body: String,
) -> Result<Comment, String> {
    make_host()?
        .comment_issue(&slug(owner, name), number, &body)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_issue_set_state(
    owner: String,
    name: String,
    number: u64,
    open: bool,
) -> Result<IssueSummary, String> {
    make_host()?
        .set_issue_state(&slug(owner, name), number, open)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_label_list(owner: String, name: String) -> Result<Vec<Label>, String> {
    make_host()?
        .list_labels(&slug(owner, name))
        .await
        .map_err(|e| e.to_string())
}

// ─── Pull requests (repo-addressed) ────────────────────────────────────────

#[tauri::command]
pub async fn git_host_pr_list_for(
    owner: String,
    name: String,
    filter: PrListFilter,
) -> Result<Vec<PrSummary>, String> {
    make_host()?
        .list_prs(&slug(owner, name), filter)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_pr_get_for(
    owner: String,
    name: String,
    number: u64,
) -> Result<PrDetail, String> {
    make_host()?
        .get_pr(&slug(owner, name), number)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_pr_merge(
    owner: String,
    name: String,
    number: u64,
    method: MergeMethod,
) -> Result<String, String> {
    make_host()?
        .merge_pr(&slug(owner, name), number, method)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_pr_reviews(
    owner: String,
    name: String,
    number: u64,
) -> Result<Vec<Review>, String> {
    make_host()?
        .list_pr_reviews(&slug(owner, name), number)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_check_runs(
    owner: String,
    name: String,
    sha: String,
) -> Result<Vec<CheckRun>, String> {
    make_host()?
        .list_check_runs(&slug(owner, name), &sha)
        .await
        .map_err(|e| e.to_string())
}

// ─── Actions, releases, inbox ──────────────────────────────────────────────

#[tauri::command]
pub async fn git_host_run_list(
    owner: String,
    name: String,
    branch: Option<String>,
) -> Result<Vec<WorkflowRun>, String> {
    make_host()?
        .list_workflow_runs(&slug(owner, name), branch.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_run_jobs(
    owner: String,
    name: String,
    run_id: u64,
) -> Result<Vec<Job>, String> {
    make_host()?
        .get_run_jobs(&slug(owner, name), run_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_run_rerun(
    owner: String,
    name: String,
    run_id: u64,
    failed_only: bool,
) -> Result<(), String> {
    make_host()?
        .rerun_workflow(&slug(owner, name), run_id, failed_only)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_run_cancel(
    owner: String,
    name: String,
    run_id: u64,
) -> Result<(), String> {
    make_host()?
        .cancel_workflow(&slug(owner, name), run_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_release_list(
    owner: String,
    name: String,
) -> Result<Vec<Release>, String> {
    make_host()?
        .list_releases(&slug(owner, name))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_notification_list(all: bool) -> Result<Vec<Notification>, String> {
    make_host()?
        .list_notifications(all)
        .await
        .map_err(|e| e.to_string())
}

/// Requests left in the current hour. Free — `/rate_limit` doesn't count
/// against the limit it reports.
#[tauri::command]
pub async fn git_host_rate_remaining() -> Result<u32, String> {
    make_host()?.rate_remaining().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_notification_read(thread_id: String) -> Result<(), String> {
    make_host()?
        .mark_notification_read(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

/// Resolve the GitHub slug for `path` and return a host bound to the stored
/// PAT. Errors when the path isn't a GitHub repo or no token has been saved.
async fn make_host_for(path: &str) -> Result<(GitHubHost, RepoSlug), String> {
    let host = make_host()?;
    let slug = detect_github_slug(path).await.map_err(|e| e.to_string())?;
    let slug =
        slug.ok_or_else(|| "not a GitHub repository (origin remote not set or not github.com)"
            .to_string())?;
    Ok((host, slug))
}

#[tauri::command]
pub async fn git_host_pr_get(path: String, number: u64) -> Result<PrDetail, String> {
    let (host, slug) = make_host_for(&path).await?;
    host.get_pr(&slug, number).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_host_pr_create(
    path: String,
    req: CreatePrRequest,
) -> Result<PrSummary, String> {
    let (host, slug) = make_host_for(&path).await?;
    host.create_pr(&slug, &req).await.map_err(|e| e.to_string())
}
