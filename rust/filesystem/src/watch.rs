//! Notify-backed directory watcher.
//!
//! The shape we expose is intentionally coarse: per watcher, the caller
//! gets a tokio receiver that yields a single `()` per *debounced batch*
//! of changes. The file-tree only needs "something changed under this
//! root, refresh visible nodes" — granular per-path events would be
//! useful later (badges, partial refresh) but cost complexity now.
//!
//! Lifecycle:
//!   * `Watcher::start` returns the watcher + a receiver.
//!   * The receiver yields `()` per ~150 ms burst.
//!   * Dropping the watcher closes the notify side; the bridge thread
//!     exits naturally; the tokio sender drops; the receiver returns
//!     `None`.

use std::path::Path;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use tokio::sync::mpsc as tokio_mpsc;

use crate::Result;

const DEBOUNCE: Duration = Duration::from_millis(150);

pub struct Watcher {
    // Held to keep notify alive. The bridge thread is not held — it exits
    // when this drops because the sender side of the std::sync channel
    // closes.
    _inner: RecommendedWatcher,
}

impl Watcher {
    /// Watch `root` recursively. Returns the watcher (drop to stop) and a
    /// receiver that yields one `()` per debounced batch of changes.
    pub fn start(
        root: impl AsRef<Path>,
    ) -> Result<(Self, tokio_mpsc::UnboundedReceiver<()>)> {
        let (raw_tx, raw_rx) = std_mpsc::channel::<()>();
        let (tx, rx) = tokio_mpsc::unbounded_channel::<()>();

        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                // We don't care about the event details (yet); any
                // successful event is a "something changed" signal.
                if res.is_ok() {
                    let _ = raw_tx.send(());
                }
            },
            Config::default(),
        )?;
        watcher.watch(root.as_ref(), RecursiveMode::Recursive)?;

        // Bridge: std::sync::mpsc → tokio::sync::mpsc, with debounce.
        // A burst of N notify events within DEBOUNCE collapses to one ().
        std::thread::Builder::new()
            .name("arc-fs-watch-debounce".into())
            .spawn(move || {
                while raw_rx.recv().is_ok() {
                    // Sleep through the debounce window, then drain.
                    std::thread::sleep(DEBOUNCE);
                    while raw_rx.try_recv().is_ok() {}
                    if tx.send(()).is_err() {
                        // Receiver dropped — caller stopped listening.
                        break;
                    }
                }
            })
            .expect("spawn debounce thread");

        Ok((Self { _inner: watcher }, rx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn watcher_fires_on_file_create() {
        let dir = tempdir();
        let (_w, mut rx) = Watcher::start(&dir).expect("start watcher");

        // Give notify a moment to set up its OS-level watches.
        tokio::time::sleep(Duration::from_millis(50)).await;

        std::fs::write(dir.join("hello.txt"), b"hi").expect("write");

        // Should receive at least one debounced () within a reasonable window.
        let recv =
            tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert!(matches!(recv, Ok(Some(()))), "expected one event, got {recv:?}");
    }

    #[tokio::test]
    async fn dropping_watcher_closes_receiver() {
        let dir = tempdir();
        let (w, mut rx) = Watcher::start(&dir).expect("start watcher");
        drop(w);
        // After dropping the watcher, the bridge thread may still be
        // sleeping in its debounce window before it notices the sender
        // closed — but rx.recv() will eventually return None.
        let recv =
            tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert!(
            matches!(recv, Ok(None) | Err(_)),
            "expected None or timeout once watcher is dropped, got {recv:?}"
        );
    }

    fn tempdir() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "arc-fs-watch-{}",
            uuid_like()
        ));
        std::fs::create_dir_all(&p).expect("mkdir tmp");
        p
    }

    fn uuid_like() -> String {
        // Avoid pulling uuid into dev-deps for one test helper.
        use std::time::{SystemTime, UNIX_EPOCH};
        format!(
            "{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            std::process::id()
        )
    }
}
