//! Tests that talk to the real api.github.com.
//!
//! Ignored by default, like `arc-wingman`'s: a test suite that needs network
//! and credentials to pass is a test suite people learn to skip. Run them
//! deliberately:
//!
//! ```bash
//! cargo test -p arc-git-host --test live -- --ignored --nocapture
//! ```
//!
//! Everything here is read-only. Nothing opens an issue, merges a PR, or
//! spends a write against someone's repository — a test that mutates a real
//! account is a test nobody dares run twice.

use arc_git_host::{
    device_code_start, GitHost, GitHubHost, IssueFilter, PrListFilter, RepoScope, RepoSlug,
    DEVICE_CLIENT_ID,
};

/// Read-only fixture. Public, stable, and not ours to break.
fn octocat() -> RepoSlug {
    RepoSlug {
        owner: "octocat".into(),
        name: "Hello-World".into(),
    }
}

fn host() -> GitHubHost {
    let token = std::env::var("GITHUB_TOKEN")
        .expect("set GITHUB_TOKEN to a PAT with the repo scope");
    GitHubHost::new(token).expect("client builds")
}

/// The one test here that needs no token.
///
/// Asking for a device code proves three things at once that nothing else
/// can: the bundled client id is real, the OAuth App still exists, and
/// **Device Flow is enabled on it** — the setting that is one unticked
/// checkbox away from making sign-in fail for every user with a 400 and no
/// useful message. No authorization happens: this only requests a code, and
/// the code expires unused.
#[tokio::test]
#[ignore = "hits github.com"]
async fn device_flow_is_enabled_on_the_bundled_app() {
    assert!(
        !DEVICE_CLIENT_ID.is_empty(),
        "no client id compiled in — this build can only sign in with a token",
    );

    let start = device_code_start()
        .await
        .expect("github issued a device code; if this is a 400, Device Flow is off on the app");

    assert!(!start.user_code.is_empty(), "there is a code to show the user");
    assert!(
        start.verification_uri.contains("github.com"),
        "the URL we send people to is github.com, got {}",
        start.verification_uri,
    );
    assert!(start.interval >= 1, "a poll interval we can honour");
    assert!(start.expires_in > 60, "long enough for a person to type it");

    println!(
        "device code {} at {} (expires in {}s, poll every {}s)",
        start.user_code, start.verification_uri, start.expires_in, start.interval,
    );
}

#[tokio::test]
#[ignore = "needs GITHUB_TOKEN"]
async fn viewer_resolves() {
    let v = host().get_viewer().await.expect("/user");
    assert!(!v.login.is_empty());
    println!("signed in as {}", v.login);
}

#[tokio::test]
#[ignore = "needs GITHUB_TOKEN"]
async fn lists_your_repos() {
    let repos = host()
        .list_repos(RepoScope::Mine)
        .await
        .expect("/user/repos");
    println!("{} repos", repos.len());
    for r in repos.iter().take(3) {
        assert!(!r.full_name.is_empty());
        assert!(r.full_name.contains('/'), "full_name is owner/name");
    }
}

#[tokio::test]
#[ignore = "needs GITHUB_TOKEN"]
async fn lists_issues_without_pull_requests() {
    // The /issues endpoint returns PRs too. If the filter ever regresses the
    // list double-counts every PR, which is invisible until someone notices
    // the same title in two sections.
    let issues = host()
        .list_issues(&octocat(), &IssueFilter::default())
        .await
        .expect("/issues");
    let prs = host()
        .list_prs(&octocat(), PrListFilter::Open)
        .await
        .expect("/pulls");

    for i in &issues {
        assert!(
            !prs.iter().any(|p| p.number == i.number),
            "#{} appears as both an issue and a pull request",
            i.number,
        );
    }
    println!("{} issues, {} pull requests", issues.len(), prs.len());
}

#[tokio::test]
#[ignore = "needs GITHUB_TOKEN"]
async fn rate_limit_reports_a_budget() {
    let left = host().rate_remaining().await.expect("/rate_limit");
    assert!(left > 0, "authenticated budget should not be exhausted");
    println!("{left} requests left this hour");
}
