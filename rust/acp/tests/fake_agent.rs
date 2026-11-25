//! ARC's ACP client against a fake agent (`fake-acp-agent.mjs`), covering the
//! protocol paths real agents need a subscription to reach: permission
//! prompts, cancelling, config options, history, MCP injection, failures.
//!
//! Needs `node` on PATH; skipped (with a note) when it isn't.

use arc_acp::{list_sessions, run_session, Command, Decision, Event, SessionOptions};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

fn script() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fake-acp-agent.mjs")
        .to_string_lossy()
        .into_owned()
}

fn node() -> Option<String> {
    let ok = std::process::Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("node not found; skipping fake ACP agent tests");
    }
    ok.then(|| "node".to_string())
}

/// A fresh working folder, so each test has its own session store.
fn workdir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("arc-fake-acp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

struct Agent {
    tx: mpsc::UnboundedSender<Command>,
    events: mpsc::UnboundedReceiver<Event>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

fn start(node: &str, cwd: &str, f: impl FnOnce(&mut SessionOptions)) -> Agent {
    let mut opts = SessionOptions {
        binary: node.to_string(),
        args: vec![script()],
        cwd: cwd.to_string(),
        load: None,
        config: vec![],
        mcp_url: None,
    };
    f(&mut opts);
    let (tx, rx) = mpsc::unbounded_channel();
    let (ev_tx, events) = mpsc::unbounded_channel();
    let task = tokio::spawn(run_session(opts, rx, move |e| {
        let _ = ev_tx.send(e);
    }));
    Agent { tx, events, task }
}

impl Agent {
    fn prompt(&self, text: &str) {
        self.tx
            .send(Command::Prompt(vec![
                json!({ "type": "text", "text": text }),
            ]))
            .unwrap();
    }

    /// Events up to and including the next one of `kinds`.
    async fn until(&mut self, kinds: &[&str]) -> Vec<Event> {
        let mut out = Vec::new();
        loop {
            let e = tokio::time::timeout(Duration::from_secs(20), self.events.recv())
                .await
                .expect("the agent went quiet")
                .expect("the session ended");
            let stop = kinds.contains(&e.kind.as_str());
            out.push(e);
            if stop {
                return out;
            }
        }
    }

    /// A whole turn: everything up to `done`, failing on `error`.
    async fn turn(&mut self, text: &str) -> Vec<Event> {
        self.prompt(text);
        let events = self.until(&["done", "error"]).await;
        let last = events.last().unwrap();
        assert_eq!(last.kind, "done", "turn failed: {:?}", last.payload);
        events
    }

    async fn close(self) {
        drop(self.tx);
        self.task.await.unwrap().unwrap();
    }
}

fn text(events: &[Event]) -> String {
    events
        .iter()
        .filter(|e| e.kind == "text_delta")
        .map(|e| e.payload["text"].as_str().unwrap_or(""))
        .collect()
}

fn find<'a>(events: &'a [Event], kind: &str) -> &'a Event {
    events.iter().find(|e| e.kind == kind).unwrap_or_else(|| {
        panic!(
            "no {kind} event in {:?}",
            events.iter().map(|e| &e.kind).collect::<Vec<_>>()
        )
    })
}

/// The e2e suite's way in: the app offers the script as an agent when asked.
#[test]
fn the_test_hook_offers_the_fake_agent() {
    if node().is_none() {
        return;
    }
    // Only this test touches the variable, so setting it here is safe.
    std::env::set_var("ARC_TEST_ACP_AGENT", script());
    let found = arc_acp::providers()
        .into_iter()
        .find(|p| p.id == "fake-acp");
    std::env::remove_var("ARC_TEST_ACP_AGENT");
    let p = found.expect("fake agent offered");
    assert_eq!(p.args, [script()]);
    assert!(p.path.to_lowercase().contains("node"), "{}", p.path);
}

#[tokio::test]
async fn a_turn_streams_reasoning_text_usage_and_cost() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("turn"), |_| {});
    let events = a.turn("hello there").await;
    assert_eq!(events[0].kind, "init");
    assert!(events.iter().any(|e| e.kind == "thinking_delta"));
    assert_eq!(text(&events), "echo: hello there");
    assert_eq!(
        find(&events, "usage").payload["usage"]["cache_read_input_tokens"],
        3
    );
    let result = find(&events, "result");
    assert_eq!(result.payload["is_error"], false);
    assert!((result.payload["cost_usd"].as_f64().unwrap() - 0.01).abs() < 1e-9);

    // The second turn reports only its own share of the running total.
    let second = a.turn("again").await;
    assert!(
        (find(&second, "result").payload["cost_usd"]
            .as_f64()
            .unwrap()
            - 0.01)
            .abs()
            < 1e-9
    );
    a.close().await;
}

#[tokio::test]
async fn an_edit_reports_the_file_it_wrote() {
    let Some(node) = node() else { return };
    let cwd = workdir("edit");
    let mut a = start(&node, &cwd, |_| {});
    let events = a.turn("edit something").await;
    let start_ev = events
        .iter()
        .find(|e| {
            e.kind == "tool_start" && e.payload["paths"].as_array().is_some_and(|p| !p.is_empty())
        })
        .expect("an edit with its path");
    assert!(start_ev.payload["paths"][0]
        .as_str()
        .unwrap()
        .ends_with("fake.txt"));
    assert_eq!(
        find(&events, "tool_result").payload["output"],
        "Wrote file successfully."
    );
    a.close().await;
}

#[tokio::test]
async fn a_permission_prompt_waits_for_the_user_both_ways() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("perm"), |_| {});

    a.prompt("permission please");
    let asked = a.until(&["permission_request"]).await;
    let req = asked.last().unwrap();
    assert_eq!(req.payload["summary"], "rm -rf build");
    let id = req.payload["request_id"].as_str().unwrap().to_string();
    a.tx.send(Command::Decide(Decision {
        request_id: id,
        allow: true,
    }))
    .unwrap();
    let rest = a.until(&["done"]).await;
    assert_eq!(text(&rest), "allowed");

    a.prompt("permission again");
    let asked = a.until(&["permission_request"]).await;
    let id = asked.last().unwrap().payload["request_id"]
        .as_str()
        .unwrap()
        .to_string();
    a.tx.send(Command::Decide(Decision {
        request_id: id,
        allow: false,
    }))
    .unwrap();
    let rest = a.until(&["done"]).await;
    // The one-shot reject option, never "always".
    assert_eq!(text(&rest), "denied (no)");
    a.close().await;
}

#[tokio::test]
async fn cancel_stops_a_running_turn_and_the_conversation_goes_on() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("cancel"), |_| {});
    a.prompt("go slow");
    a.until(&["text_delta"]).await;
    a.tx.send(Command::Cancel).unwrap();
    let rest = a.until(&["done"]).await;
    let result = find(&rest, "result");
    assert_eq!(result.payload["stop_reason"], "cancelled");
    assert_eq!(result.payload["is_error"], false);
    assert_eq!(text(&a.turn("still there?").await), "echo: still there?");
    a.close().await;
}

#[tokio::test]
async fn cancel_answers_an_open_permission_prompt() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("cancel-perm"), |_| {});
    a.prompt("permission please");
    a.until(&["permission_request"]).await;
    a.tx.send(Command::Cancel).unwrap();
    let rest = a.until(&["done"]).await;
    assert_eq!(find(&rest, "result").payload["stop_reason"], "cancelled");
    a.close().await;
}

#[tokio::test]
async fn config_is_applied_before_the_first_prompt_and_changed_live() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("config"), |o| {
        o.config = vec![
            ("mode".into(), "plan".into()),
            // A remembered value the agent doesn't offer is dropped, not fatal.
            ("model".into(), "gone".into()),
        ];
    });
    let events = a.turn("config?").await;
    assert_eq!(text(&events), "model=fake-small mode=plan");

    let (reply, answer) = oneshot::channel();
    a.tx.send(Command::SetConfig {
        id: "model".into(),
        value: "fake-large".into(),
        reply,
    })
    .unwrap();
    let options: Value = answer.await.unwrap().expect("accepted");
    let ids: Vec<&str> = options
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        ["model", "effort", "mode"],
        "a bigger model adds an option"
    );

    let (reply, answer) = oneshot::channel();
    a.tx.send(Command::SetConfig {
        id: "model".into(),
        value: "nope".into(),
        reply,
    })
    .unwrap();
    assert!(answer.await.unwrap().is_err());
    a.close().await;
}

#[tokio::test]
async fn sessions_list_and_reload_with_their_history() {
    let Some(node) = node() else { return };
    let cwd = workdir("history");
    let mut a = start(&node, &cwd, |_| {});
    let init = a.turn("first question").await;
    let id = init[0].payload["session_id"].as_str().unwrap().to_string();
    a.close().await;

    let listed = list_sessions(&node, &[script()], &cwd)
        .await
        .unwrap()
        .expect("can list");
    assert_eq!(listed[0]["sessionId"], id.as_str());
    assert_eq!(listed[0]["title"], "first question");

    let mut b = start(&node, &cwd, |o| o.load = Some(id.clone()));
    let replay = b.until(&["loaded"]).await;
    assert!(replay
        .iter()
        .any(|e| e.kind == "user" && e.payload["text"] == "first question"));
    assert_eq!(text(&replay), "echo: first question");
    // And the reopened conversation continues.
    assert_eq!(text(&b.turn("second").await), "echo: second");
    b.close().await;
}

#[tokio::test]
async fn arcs_mcp_server_reaches_an_agent_that_takes_http_servers() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("mcp"), |o| {
        o.mcp_url = Some("http://127.0.0.1:1/mcp/token".into());
    });
    let servers: Value = serde_json::from_str(&text(&a.turn("mcp?").await)).unwrap();
    assert_eq!(servers[0]["name"], "arc");
    assert_eq!(servers[0]["type"], "http");
    assert_eq!(servers[0]["url"], "http://127.0.0.1:1/mcp/token");
    a.close().await;
}

#[tokio::test]
async fn an_agent_error_ends_the_turn_but_not_the_conversation() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("fail"), |_| {});
    a.prompt("fail now");
    let events = a.until(&["done", "error"]).await;
    assert_eq!(events.last().unwrap().kind, "error");
    assert_eq!(events.last().unwrap().payload["message"], "fake failure");
    assert_eq!(text(&a.turn("ok?").await), "echo: ok?");
    a.close().await;
}

#[tokio::test]
async fn an_agent_that_dies_mid_turn_says_so() {
    let Some(node) = node() else { return };
    let mut a = start(&node, &workdir("crash"), |_| {});
    a.prompt("crash please");
    let events = a.until(&["error"]).await;
    let msg = events.last().unwrap().payload["message"].as_str().unwrap();
    assert!(msg.contains("the agent exited (3)"), "{msg}");
    assert!(msg.contains("crashed on purpose"), "stderr is shown: {msg}");
    a.task.await.unwrap().unwrap();
}
