//! Remote filesystem over SFTP.
//!
//! This is what makes a remote folder usable as a workspace root rather than
//! just something you `cd` to in a terminal tab: the file tree, the editor,
//! and save all talk to a real remote filesystem.
//!
//! Design notes:
//!
//! * **Its own connection.** [`SshManager`](crate::SshManager) hands each
//!   interactive session's `Handle` to a driver task that owns it for the
//!   session's life, so there is no way to open a second channel on it from
//!   outside. A remote workspace therefore dials its own connection. That is
//!   also what you want operationally — closing the terminal tab must not
//!   take the file tree down with it.
//!
//! * **SFTP, not `exec` + `cat`.** Shelling out would mean quoting user paths
//!   into a remote command line (an injection surface), guessing at `ls`
//!   output formats, and mangling any file that isn't UTF-8. SFTP is the
//!   actual protocol for this and handles binary, permissions, and rename
//!   atomically.
//!
//! * **Paths are always POSIX.** Remote hosts are assumed POSIX; every path
//!   here uses `/`. The frontend never joins a remote path with a platform
//!   separator (see `lib/remote.ts`).

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use russh::client::{self, Handle};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{load_key, ClientHandler, HANDSHAKE_TIMEOUT_SECS};

/// Ceiling on a single remote file read, mirroring the local editor's cap.
/// Without it a stray click on a multi-gigabyte log pulls the whole thing
/// over the network into a string.
pub const MAX_REMOTE_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// What it takes to open a remote workspace. Same shape as the terminal's
/// connect options minus the PTY dimensions — there is no terminal here.
#[derive(Debug, Clone, Deserialize)]
pub struct RemoteFsOpts {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub identity_path: String,
    pub passphrase: Option<String>,
}

/// One entry in a remote directory listing. Mirrors `arc_filesystem::DirEntry`
/// so the frontend's file tree can render either without a second code path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteDirEntry {
    pub name: String,
    /// Absolute POSIX path on the remote host.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

struct RemoteSession {
    sftp: SftpSession,
    /// Kept alive purely so the connection outlives this struct's creation —
    /// dropping the handle closes the transport out from under the SFTP
    /// session.
    _handle: Handle<ClientHandler>,
}

/// Remote filesystem connections, keyed by a caller-chosen id (ARC uses the
/// SSH host id, so one host is one connection no matter how many tabs).
#[derive(Default)]
pub struct SftpManager {
    // Mutex rather than RwLock: SftpSession's operations take &self but the
    // underlying channel is a single multiplexed stream, and serializing
    // requests is both correct and cheap next to the network round-trip.
    sessions: Arc<DashMap<String, Arc<Mutex<RemoteSession>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// Dial `opts` and start an SFTP session under `id`. Reconnecting an id
    /// that is already live replaces it — the old connection is dropped,
    /// which is what a user pressing "Reconnect" means.
    pub async fn connect(&self, id: &str, opts: RemoteFsOpts) -> Result<()> {
        let key_pair = load_key(
            Path::new(&opts.identity_path),
            opts.passphrase.as_deref(),
        )
        .context("load identity")?;

        let mut config = client::Config::default();
        config.inactivity_timeout = None;
        // A file tree can sit idle for a long time between clicks; without a
        // keepalive the connection is quietly reaped by a NAT or the server
        // and the next click fails instead of the tree staying live.
        config.keepalive_interval = Some(std::time::Duration::from_secs(30));

        let handler = ClientHandler::silent();
        let connect_fut = client::connect(Arc::new(config), (opts.host.as_str(), opts.port), handler);
        let mut handle = tokio::time::timeout(
            std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            connect_fut,
        )
        .await
        .map_err(|_| anyhow!("connect timeout after {HANDSHAKE_TIMEOUT_SECS}s"))?
        .with_context(|| format!("connect {}:{}", opts.host, opts.port))?;

        let authed = handle
            .authenticate_publickey(&opts.username, Arc::new(key_pair))
            .await
            .context("publickey auth")?;
        if !authed {
            return Err(anyhow!("authentication failed: publickey rejected"));
        }

        let channel = handle
            .channel_open_session()
            .await
            .context("open sftp channel")?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .context("request sftp subsystem (is the server's sftp subsystem enabled?)")?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .context("start sftp session")?;

        self.sessions.insert(
            id.to_string(),
            Arc::new(Mutex::new(RemoteSession {
                sftp,
                _handle: handle,
            })),
        );
        Ok(())
    }

    pub fn disconnect(&self, id: &str) {
        self.sessions.remove(id);
    }

    fn session(&self, id: &str) -> Result<Arc<Mutex<RemoteSession>>> {
        self.sessions
            .get(id)
            .map(|e| e.clone())
            .ok_or_else(|| anyhow!("no remote connection for '{id}' — reconnect to continue"))
    }

    /// Resolve a path to its absolute form. Also the cheapest liveness probe,
    /// and how `.`/`~`-relative starting points become concrete roots.
    pub async fn canonicalize(&self, id: &str, path: &str) -> Result<String> {
        let session = self.session(id)?;
        let guard = session.lock().await;
        guard
            .sftp
            .canonicalize(path)
            .await
            .with_context(|| format!("resolve {path}"))
    }

    /// List `path`, directories first then files, each group name-sorted —
    /// the same ordering the local tree uses.
    pub async fn read_dir(&self, id: &str, path: &str) -> Result<Vec<RemoteDirEntry>> {
        let session = self.session(id)?;
        let guard = session.lock().await;
        let dir = guard
            .sftp
            .read_dir(path)
            .await
            .with_context(|| format!("read remote dir {path}"))?;

        let base = path.trim_end_matches('/');
        let mut out = Vec::new();
        for entry in dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            out.push(RemoteDirEntry {
                path: format!("{base}/{name}"),
                name,
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
            });
        }
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    /// Read a remote text file. Rejects oversized and binary content for the
    /// same reason the local editor does — the caller is an editor buffer,
    /// not a download.
    pub async fn read_file(&self, id: &str, path: &str) -> Result<String> {
        use tokio::io::AsyncReadExt;

        let session = self.session(id)?;
        let guard = session.lock().await;

        let meta = guard
            .sftp
            .metadata(path)
            .await
            .with_context(|| format!("stat {path}"))?;
        if let Some(size) = meta.size {
            if size > MAX_REMOTE_FILE_BYTES {
                return Err(anyhow!(
                    "file too large ({:.1} MiB; remote editing caps at {:.0} MiB)",
                    size as f64 / (1024.0 * 1024.0),
                    MAX_REMOTE_FILE_BYTES as f64 / (1024.0 * 1024.0),
                ));
            }
        }

        let mut file = guard
            .sftp
            .open(path)
            .await
            .with_context(|| format!("open {path}"))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .await
            .with_context(|| format!("read {path}"))?;

        let sniff_end = bytes.len().min(8192);
        if bytes[..sniff_end].contains(&0) {
            return Err(anyhow!("binary file (contains NUL bytes)"));
        }
        String::from_utf8(bytes).map_err(|_| anyhow!("not valid utf-8"))
    }

    /// Write a remote file.
    ///
    /// Writes to a sibling temp file and renames over the target, so an
    /// interrupted save (dropped connection, server disk full) leaves the
    /// original intact rather than truncated. `rename` is the one atomic
    /// primitive SFTP gives us, and a sibling keeps it on one filesystem.
    ///
    /// Servers speaking SFTP v3 fail `rename` when the destination exists, so
    /// a failed rename falls back to a direct write rather than leaving the
    /// user's save on the floor.
    pub async fn write_file(&self, id: &str, path: &str, contents: &str) -> Result<()> {
        use tokio::io::AsyncWriteExt;

        let session = self.session(id)?;
        let guard = session.lock().await;

        let tmp = format!("{path}.arc-tmp");
        {
            let mut file = guard
                .sftp
                .create(&tmp)
                .await
                .with_context(|| format!("create {tmp}"))?;
            file.write_all(contents.as_bytes())
                .await
                .with_context(|| format!("write {tmp}"))?;
            file.shutdown().await.with_context(|| format!("flush {tmp}"))?;
        }

        // Best-effort: v3 servers reject a rename onto an existing path.
        let _ = guard.sftp.remove_file(path).await;
        match guard.sftp.rename(&tmp, path).await {
            Ok(()) => Ok(()),
            Err(err) => {
                // Don't leave the temp file behind for the user to find.
                let _ = guard.sftp.remove_file(&tmp).await;
                let mut file = guard
                    .sftp
                    .create(path)
                    .await
                    .with_context(|| format!("create {path} after rename failed: {err}"))?;
                file.write_all(contents.as_bytes())
                    .await
                    .with_context(|| format!("write {path}"))?;
                file.shutdown().await.with_context(|| format!("flush {path}"))?;
                Ok(())
            }
        }
    }

    pub async fn create_dir(&self, id: &str, path: &str) -> Result<()> {
        let session = self.session(id)?;
        let guard = session.lock().await;
        guard
            .sftp
            .create_dir(path)
            .await
            .with_context(|| format!("mkdir {path}"))
    }

    pub async fn rename(&self, id: &str, from: &str, to: &str) -> Result<()> {
        let session = self.session(id)?;
        let guard = session.lock().await;
        guard
            .sftp
            .rename(from, to)
            .await
            .with_context(|| format!("rename {from} -> {to}"))
    }

    /// Delete a file or an (empty) directory. Directory recursion is
    /// deliberately absent: a recursive remote delete is a foot-gun with no
    /// undo and no trash to fall back on.
    pub async fn remove(&self, id: &str, path: &str, is_dir: bool) -> Result<()> {
        let session = self.session(id)?;
        let guard = session.lock().await;
        if is_dir {
            guard
                .sftp
                .remove_dir(path)
                .await
                .with_context(|| format!("rmdir {path} (is it empty?)"))
        } else {
            guard
                .sftp
                .remove_file(path)
                .await
                .with_context(|| format!("rm {path}"))
        }
    }
}

/// Join a POSIX parent and child, collapsing the separator. Kept here (and
/// tested) because getting it wrong produces `//` or a silently wrong path,
/// and the frontend has a mirror of it in `lib/remote.ts`.
pub fn posix_join(base: &str, name: &str) -> String {
    let base = base.trim_end_matches('/');
    let name = name.trim_start_matches('/');
    if base.is_empty() {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// POSIX dirname. Returns "/" for a top-level path — never an empty string,
/// which would make "go to parent" navigate to nowhere.
pub fn posix_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        None | Some(0) => "/".to_string(),
        Some(idx) => trimmed[..idx].to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_join_collapses_separators() {
        assert_eq!(posix_join("/home/u", "a.txt"), "/home/u/a.txt");
        assert_eq!(posix_join("/home/u/", "a.txt"), "/home/u/a.txt");
        assert_eq!(posix_join("/home/u", "/a.txt"), "/home/u/a.txt");
        assert_eq!(posix_join("/", "a.txt"), "/a.txt");
        assert_eq!(posix_join("", "a.txt"), "/a.txt");
    }

    #[test]
    fn posix_parent_stops_at_root() {
        assert_eq!(posix_parent("/home/u/a.txt"), "/home/u");
        assert_eq!(posix_parent("/home/u/"), "/home");
        assert_eq!(posix_parent("/home"), "/");
        assert_eq!(posix_parent("/"), "/");
        // A relative path with no separator has no parent but must still
        // resolve to something navigable.
        assert_eq!(posix_parent("file.txt"), "/");
    }
}
