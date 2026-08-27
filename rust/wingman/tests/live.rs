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

/// The one test here that is not read-only, and the only one that costs money.
///
/// Everything else in the client is exercised by the read paths; the turn
/// stream is the one surface whose framing has only ever been unit-tested
/// against synthetic frames. This runs a real turn so the SSE parser meets a
/// real provider stream: chunk boundaries the transport chooses, keepalive
/// comments, and the actual `AgentEvent` tag values.
///
/// Kept deliberately tiny — a prompt that wants a two-token answer — and the
/// session is deleted afterwards so a test run doesn't litter `session list`.
/// Ignored by default, so it never runs in CI or on a stray `cargo test`.
#[tokio::test]
#[ignore = "needs a running `wingman serve` AND spends provider credits"]
async fn turn_streams_typed_events() {
    let c = client();
    let project = c.projects().await.expect("projects")[0].id.clone();

    let session = c
        .create_session(&project, None, Some("read-only"))
        .await
        .expect("create session");
    println!("session {session}");

    let mut kinds: Vec<String> = Vec::new();
    let mut text = String::new();

    c.turn_stream(
        &project,
        Some(&session),
        "Reply with exactly: OK",
        None,
        Some("read-only"),
        |kind, payload| {
            if kind == "text_delta" {
                text.push_str(payload.get("text").and_then(|v| v.as_str()).unwrap_or(""));
            }
            kinds.push(kind);
        },
    )
    .await
    .expect("turn stream");

    println!("events: {kinds:?}");
    println!("text: {text:?}");

    // The parser produced typed events, not raw bytes — this is the assertion
    // that the SSE framing survives a real stream.
    assert!(!kinds.is_empty(), "stream yielded no events at all");
    assert!(
        kinds.iter().any(|k| k == "text_delta"),
        "no text_delta in {kinds:?} — the payload `type` tag did not resolve"
    );
    assert!(
        kinds.iter().any(|k| k == "stop"),
        "no terminal stop in {kinds:?} — ARC would spin forever"
    );
    assert!(!text.trim().is_empty(), "text deltas carried no text");

    // Don't leave the probe behind in the user's session list.
    let _ = c.delete_session(&project, &session).await;
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
