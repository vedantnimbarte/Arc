//! Tauri command surface for lightweight local-network probes plus the
//! "open in system browser" helper used by the Preview pane.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("network_probe_port",   { port }) -> bool
//!   invoke("shell_open_external",  { url })  -> Result<(), String>

use std::time::Duration;
use tokio::net::TcpStream;
use tokio::time::timeout;

#[tauri::command]
pub async fn network_probe_port(port: u16) -> bool {
    timeout(
        Duration::from_millis(200),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// Hand a URL off to the user's default handler (system browser for http/https,
/// mail client for mailto:, etc.). Backed by the cross-platform `open` crate.
///
/// We accept anything string-shaped and let the OS reject unknown schemes; the
/// frontend already normalizes Preview URLs before invoking this.
#[tauri::command]
pub async fn shell_open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}
