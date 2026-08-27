//! End-to-end checks against a real `wingman serve` daemon.
//!
//! Ignored by default — they need a daemon on `WINGMAN_TEST_URL` (default
//! `http://127.0.0.1:8787`). CI has no daemon, and these would otherwise be a
//! flaky dependency on a developer's local setup.
//!
//! Run them when changing anything about the wire format:
//!
//! ```sh
//! wingman serve --mode read-only &
//! cargo test -p arc-wingman -- --ignored --nocapture
//! ```
//!
//! Everything here is read-only. Nothing dispatches a run, starts a turn, or
//! writes to the board — a test suite must not spend the developer's API
//! credits or mutate their real board.

use arc_wingman::Client;

fn client() -> Client {
    let url =
        std::env::var("WINGMAN_TEST_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".to_string());
    Client::new(url, std::env::var("WINGMAN_TEST_TOKEN").ok()).expect("client")
}

#[tokio::test]
#[ignore = "needs a running `wingman serve`"]
async fn health_reports_a_version() {
    let h = client().health().await.expect("health");
    assert!(h.ok, "daemon reported not-ok");
    assert!(!h.version.is_empty(), "no version string");
    println!("wingman {} (auth_required={})", h.version, h.auth_required);
}

#[tokio::test]
#[ignore = "needs a running `wingman serve`"]
async fn projects_deserialize() {
    let projects = client().projects().await.expect("projects");
    assert!(
        !projects.is_empty(),
        "daemon serves no projects — check [[serve.projects]]"
    );
    for p in &projects {
        assert!(!p.id.is_empty());
        assert!(!p.root.is_empty());
        println!("project {} at {} ({:?})", p.id, p.root, p.branch);
    }
}

/// The board is the shape most likely to drift, since it nests a roll-up and
/// per-task sub-rows. Deserializing a real payload is the point of this test.
#[tokio::test]
#[ignore = "needs a running `wingman serve`"]
async fn board_deserializes_with_rollups() {
    let board = client().board(None, false).await.expect("board");
    println!("{} card(s)", board.cards.len());
    for c in &board.cards {
        assert!(!c.id.is_empty());
        assert!(
            matches!(
                c.column.as_str(),
                "backlog" | "planned" | "in_progress" | "review" | "done"
            ),
            "unexpected column {:?} — Column enum changed upstream",
            c.column
        );
        if let Some(r) = &c.rollup {
            println!(
                "  {} [{}] {}/{} ${:.2} — {} subrow(s)",
                c.title.as_deref().or(c.goal.as_deref()).unwrap_or(&c.id),
                c.column,
                r.done,
                r.total,
                r.usd,
                r.subrows.len()
            );
            for s in &r.subrows {
                assert!(!s.task_id.is_empty());
            }
        }
    }
}

#[tokio::test]
#[ignore = "needs a running `wingman serve`"]
async fn pilot_runs_and_sessions_deserialize() {
    let c = client();
    let project = c.projects().await.expect("projects")[0].id.clone();

    let runs = c.pilot_runs(&project).await.expect("pilot runs");
    println!("{} run(s) in {project}", runs.len());
    for r in runs.iter().take(3) {
        assert!(!r.run_id.is_empty());
        println!("  {} {} {}/{}", r.run_id, r.status, r.done, r.total);
    }

    let sessions = c.sessions(&project).await.expect("sessions");
    println!("{} session(s)", sessions.len());
    for s in sessions.iter().take(3) {
        assert!(!s.session_id.is_empty());
    }
}

/// A wrong project id must surface the daemon's own message, not a bare status
/// code — that error text is what ARC shows the user.
#[tokio::test]
#[ignore = "needs a running `wingman serve`"]
async fn unknown_project_is_a_useful_error() {
    let err = client()
        .pilot_runs("definitely-not-a-project")
        .await
        .expect_err("should 404");
    let msg = err.to_string();
    println!("error: {msg}");
    assert!(msg.contains("404"), "expected the status in {msg:?}");
}
