//! Tauri command surface for [`arc_git_host`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("git_host_detect", { path })                          -> Option<RepoSlug>
//!   invoke("git_host_token_set",  { provider, token })           -> ()
//!   invoke("git_host_token_get",  { provider })                  -> Option<String>
//!   invoke("git_host_token_delete", { provider })                -> ()
//!   invoke("git_host_pr_list", { path, filter })                 -> Vec<PrSummary>
//!   invoke("git_host_pr_get",  { path, number })                 -> PrDetail
//!   invoke("git_host_pr_create", { path, req })                  -> PrSummary
//!
//! Auth: PATs live in the OS keychain under the `dev.arc.terminal.git-host`
//! service, keyed by provider id (currently always `github`). The frontend
//! lifts/drops them via the `git_host_token_*` commands.

use arc_git_host::{
    detect_github_slug, CreatePrRequest, GitHost, GitHubHost, PrDetail, PrListFilter, PrSummary,
    RepoSlug,
};
use keyring::Entry;

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

/// Resolve the GitHub slug for `path` and return a host bound to the stored
/// PAT. Errors when the path isn't a GitHub repo or no token has been saved.
async fn make_host_for(path: &str) -> Result<(GitHubHost, RepoSlug), String> {
    let entry = Entry::new(KEYRING_SERVICE, "github").map_err(|e| e.to_string())?;
    let token = entry.get_password().unwrap_or_default();
    if token.is_empty() {
        return Err(
            "no GitHub token set — open Settings → Git Host to add a personal access token"
                .to_string(),
        );
    }
    let host = GitHubHost::new(token).map_err(|e| e.to_string())?;
    let slug = detect_github_slug(path).await.map_err(|e| e.to_string())?;
    let slug =
        slug.ok_or_else(|| "not a GitHub repository (origin remote not set or not github.com)"
            .to_string())?;
    Ok((host, slug))
}

#[tauri::command]
pub async fn git_host_pr_list(path: String, filter: PrListFilter) -> Result<Vec<PrSummary>, String> {
    let (host, slug) = make_host_for(&path).await?;
    host.list_prs(&slug, filter)
        .await
        .map_err(|e| e.to_string())
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
