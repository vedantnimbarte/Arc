//! End to end: spawn through a host, detach (ARC quitting),
//! reconnect as a new client (ARC relaunching) and read the replay.

use std::time::{Duration, Instant};

use arc_pty::SpawnOptions;
use arc_ptyhost::client::{Attached, HostClient};
use arc_ptyhost::host;

const MARKER: &str = "ARC_REATTACH_OK";

fn endpoint(tag: &str) -> String {
    let unique = format!("{tag}-{}", std::process::id());
    if cfg!(windows) {
        format!(r"\\.\pipe\arc-ptyhost-test-{unique}")
    } else {
        std::env::temp_dir()
            .join(format!("arc-ptyhost-test-{unique}"))
            .join("sock")
            .to_string_lossy()
            .into_owned()
    }
}

/// A shell that prints the marker and then stays alive long enough to be
/// reattached to.
fn echo_then_wait() -> SpawnOptions {
    let (shell, args) = if cfg!(windows) {
        ("cmd.exe", vec!["/c".to_string(), format!("echo {MARKER} && ping -n 30 127.0.0.1 >nul")])
    } else {
        ("/bin/sh", vec!["-c".to_string(), format!("echo {MARKER}; sleep 30")])
    };
    SpawnOptions {
        shell: Some(shell.into()),
        cwd: None,
        cols: 80,
        rows: 24,
        env: None,
        args: Some(args),
    }
}

async fn read_until_marker(client: &HostClient, id: &str, a: &mut Attached) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut out = Vec::new();
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), a.data_rx.recv()).await {
            Ok(Some(chunk)) => {
                // ConPTY holds all output until its cursor-position request
                // is answered, as xterm would.
                if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                    client.write(id, b"\x1b[1;1R").await.expect("write");
                }
                out.extend(chunk);
            }
            Ok(None) => break,
            Err(_) => {}
        }
        if String::from_utf8_lossy(&out).contains(MARKER) {
            break;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn spawn_detach_reattach(first: HostClient, second: HostClient) {
    let mut live = first.spawn("term-test-1", echo_then_wait()).await.expect("spawn");
    let out = read_until_marker(&first, "term-test-1", &mut live).await;
    assert!(out.contains(MARKER), "live output missing marker: {out:?}");

    first.detach("term-test-1").await.expect("detach");
    // `second` stands in for the relaunched ARC: a new connection.

    assert_eq!(second.list().await.expect("list"), vec!["term-test-1".to_string()]);
    assert!(second.attach("term-missing", 80, 24).await.expect("attach").is_none());
    let mut again = second.attach("term-test-1", 100, 30).await.expect("attach").expect("alive");
    let replay = read_until_marker(&second, "term-test-1", &mut again).await;
    assert!(replay.contains(MARKER), "replay missing marker: {replay:?}");

    second.kill("term-test-1").await.expect("kill");
    assert!(second.list().await.expect("list").is_empty());
}

/// Host served in-process on a private endpoint — runs everywhere, no binary.
#[tokio::test(flavor = "multi_thread")]
async fn reattach_in_process_host() {
    let ep = endpoint("inproc");
    let serve_ep = ep.clone();
    tokio::spawn(async move { host::serve(&serve_ep, Duration::from_secs(600)).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    spawn_detach_reattach(
        HostClient::new(None, Some(ep.clone())),
        HostClient::new(None, Some(ep)),
    )
    .await;
}

/// The real thing: the built `arc-ptyhost` binary, launched detached by the
/// client. Build it first with `cargo build -p arc-desktop --bin arc-ptyhost`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the built arc-ptyhost binary"]
async fn reattach_detached_binary() {
    // target/<profile>/deps/reattach-xxxx -> target/<profile>/arc-ptyhost
    let exe = std::env::current_exe()
        .unwrap()
        .parent()
        .and_then(|deps| deps.parent())
        .unwrap()
        .join(format!("arc-ptyhost{}", std::env::consts::EXE_SUFFIX));
    assert!(exe.exists(), "build the host first: {}", exe.display());
    let ep = endpoint("binary");
    let first = HostClient::new(Some(exe.clone()), Some(ep.clone()));
    let second = HostClient::new(Some(exe), Some(ep.clone()));
    spawn_detach_reattach(first, second).await;
    HostClient::new(None, Some(ep.clone())).shutdown().await.expect("shutdown");
    assert!(HostClient::new(None, Some(ep)).list().await.expect("list").is_empty());
}
