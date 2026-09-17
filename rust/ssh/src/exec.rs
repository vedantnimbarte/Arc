//! Run programs on a remote workspace's host over SSH `exec` channels.
//!
//! This is how git, content search, tests, checkers, tasks and language
//! servers reach a remote workspace: the real tools, run on the host, over the
//! connection the workspace already holds. SSH multiplexes channels, so no
//! call logs in again, and nothing is installed on the host beyond the tools
//! themselves.
//!
//! Every command goes through [`remote_command`], which produces
//! `sh -lc '<cd root && command>'`. The server hands an exec request to the
//! user's login shell as one string, so anything that reaches it — above all
//! paths and names read from the remote tree — must go through
//! [`shell_quote`]. `sh -lc` pins the inner command to POSIX sh whatever the
//! login shell is, and `-l` loads the profile so tools installed under
//! `~/.local/bin` and friends are on PATH.
//!
//! ponytail: assumes the login shell reads single quotes the POSIX way (bash,
//! zsh, dash, ksh). fish and csh treat `\` and newlines inside quotes
//! differently; pipe the command to `sh -s` on stdin if those users show up.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelStream};
use tokio::sync::mpsc;

use crate::SftpManager;

/// Cap on each captured stream of a buffered [`SftpManager::exec`]. Generous,
/// because a truncated `git status` is a wrong answer rather than a short one,
/// but finite so a runaway command can't take the app's memory with it.
pub const MAX_EXEC_OUTPUT: usize = 16 * 1024 * 1024;

/// Quote `s` as one POSIX shell word: wrap it in single quotes, which make
/// every character literal, and spell each embedded `'` as `'\''`. Always
/// quotes — a heuristic for "safe" characters is one more thing to get wrong.
pub fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Quote each argument and join them into one command line.
pub fn shell_join<S: AsRef<str>>(args: &[S]) -> String {
    args.iter()
        .map(|a| shell_quote(a.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The exact string sent as the exec request. `command` is shell text the
/// caller built with [`shell_quote`]; `cwd` must be absolute, which also means
/// it can never be read as an option to `cd`.
pub fn remote_command(command: &str, cwd: Option<&str>) -> Result<String> {
    // A NUL would silently truncate the command on the server side.
    if command.contains('\0') || cwd.is_some_and(|c| c.contains('\0')) {
        bail!("remote command contains a NUL byte");
    }
    let inner = match cwd {
        Some(dir) if dir.starts_with('/') => format!("cd {} && {command}", shell_quote(dir)),
        Some(dir) => bail!("remote working directory must be absolute: {dir:?}"),
        None => command.to_string(),
    };
    Ok(format!("sh -lc {}", shell_quote(&inner)))
}

/// One piece of a streaming exec. `Exit` is always the last event.
#[derive(Debug)]
pub enum ExecEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    /// `None` when the program died of a signal or the channel closed first.
    Exit(Option<i32>),
}

#[derive(Debug, Default)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Either stream hit [`MAX_EXEC_OUTPUT`].
    pub truncated: bool,
}

impl ExecOutput {
    /// `sh` exits 127 when it can't find the program.
    pub fn not_found(&self) -> bool {
        self.exit_code == Some(127)
    }
}

impl SftpManager {
    /// The host name behind a connection, for user-facing messages.
    pub fn host_name(&self, id: &str) -> Option<String> {
        self.session(id).ok().map(|s| s.host.clone())
    }

    async fn open_exec(&self, id: &str, command: &str, cwd: Option<&str>) -> Result<Channel<Msg>> {
        let line = remote_command(command, cwd)?;
        let session = self.session(id)?;
        let channel = session
            .conn
            .handle
            .channel_open_session()
            .await
            .context("open exec channel")?;
        channel.exec(true, line).await.context("exec")?;
        Ok(channel)
    }

    /// Run `command` and stream its output. `stdin` is written and closed
    /// before any output is read; commands that read no input see EOF.
    ///
    /// Dropping the receiver cancels: the channel is closed, which closes the
    /// program's pipes on the host.
    pub async fn exec_stream(
        &self,
        id: &str,
        command: &str,
        cwd: Option<&str>,
        stdin: Option<Vec<u8>>,
    ) -> Result<mpsc::Receiver<ExecEvent>> {
        let mut channel = self.open_exec(id, command, cwd).await?;
        if let Some(input) = stdin {
            channel.data(&input[..]).await.context("write stdin")?;
        }
        channel.eof().await.context("close stdin")?;

        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(async move {
            let mut code = None;
            loop {
                let msg = tokio::select! {
                    msg = channel.wait() => msg,
                    _ = tx.closed() => break,
                };
                let event = match msg {
                    Some(ChannelMsg::Data { data }) => ExecEvent::Stdout(data.to_vec()),
                    Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                        ExecEvent::Stderr(data.to_vec())
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        code = Some(exit_status as i32);
                        continue;
                    }
                    // Exit status may still follow EOF; only Close ends it.
                    Some(ChannelMsg::Close) | Some(ChannelMsg::Failure) | None => break,
                    Some(_) => continue,
                };
                if tx.send(event).await.is_err() {
                    break;
                }
            }
            let _ = channel.close().await;
            let _ = tx.send(ExecEvent::Exit(code)).await;
        });
        Ok(rx)
    }

    /// Run `command` to completion and collect its output, capped at
    /// [`MAX_EXEC_OUTPUT`] per stream. On timeout the command is cancelled and
    /// whatever it printed so far is returned with `timed_out` set.
    pub async fn exec(
        &self,
        id: &str,
        command: &str,
        cwd: Option<&str>,
        stdin: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<ExecOutput> {
        let mut rx = self.exec_stream(id, command, cwd, stdin).await?;
        let mut out = ExecOutput::default();
        let collect = async {
            while let Some(event) = rx.recv().await {
                match event {
                    ExecEvent::Stdout(b) => push_capped(&mut out.stdout, &b, &mut out.truncated),
                    ExecEvent::Stderr(b) => push_capped(&mut out.stderr, &b, &mut out.truncated),
                    ExecEvent::Exit(code) => out.exit_code = code,
                }
            }
        };
        if tokio::time::timeout(timeout, collect).await.is_err() {
            out.timed_out = true;
        }
        Ok(out)
    }

    /// Run `command` with its stdin and stdout as a byte stream — a language
    /// server's transport. stderr is discarded. Dropping the stream closes the
    /// channel, and with it the program's stdin.
    pub async fn exec_io(
        &self,
        id: &str,
        command: &str,
        cwd: Option<&str>,
    ) -> Result<ChannelStream<Msg>> {
        Ok(self.open_exec(id, command, cwd).await?.into_stream())
    }
}

fn push_capped(buf: &mut Vec<u8>, chunk: &[u8], truncated: &mut bool) {
    let room = MAX_EXEC_OUTPUT.saturating_sub(buf.len());
    if chunk.len() > room {
        *truncated = true;
    }
    buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Names a remote tree can hand us. Every one must come out of the shell
    /// exactly as it went in, and none may run anything.
    const NASTY: &[&str] = &[
        "plain",
        "",
        "with space",
        "$(rm -rf ~)",
        "`rm -rf ~`",
        "it's",
        "'",
        "''",
        "\"double\"",
        "a\nb",
        "-rf",
        "--upload-pack=touch pwned",
        "back\\slash",
        "semi;colon && echo hi | cat > x",
        "$HOME ${HOME} *.rs ?",
        "tab\there",
        "'; rm -rf ~; echo '",
        "ünïcødé",
    ];

    #[test]
    fn quotes_are_literal_single_quoted_words() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(shell_quote("a\nb"), "'a\nb'");
        assert_eq!(shell_join(&["git", "-C", "/a b"]), "'git' '-C' '/a b'");
    }

    #[test]
    fn remote_command_wraps_in_sh_and_quotes_cwd() {
        assert_eq!(remote_command("'ls'", None).unwrap(), "sh -lc ''\\''ls'\\'''");
        assert_eq!(
            remote_command("'ls'", Some("/srv/it's")).unwrap(),
            format!("sh -lc {}", shell_quote("cd '/srv/it'\\''s' && 'ls'"))
        );
        assert!(remote_command("ls", Some("relative")).is_err());
        assert!(remote_command("ls", Some("-")).is_err());
        assert!(remote_command("ls\0", None).is_err());
        assert!(remote_command("ls", Some("/a\0b")).is_err());
    }

    /// A real shell is the only honest judge of quoting. Skipped where there
    /// is no `sh` (a Windows box without Git for Windows on PATH).
    #[test]
    fn nasty_names_survive_a_real_shell() {
        use std::process::Command;
        for name in NASTY {
            // Quoted once, as an argument.
            let script = format!("printf '%s' {}", shell_quote(name));
            let Ok(out) = Command::new("sh").arg("-c").arg(&script).output() else {
                eprintln!("no sh on PATH; skipping");
                return;
            };
            assert_eq!(String::from_utf8_lossy(&out.stdout), *name, "script: {script}");

            // Quoted twice, the way `remote_command` nests the command inside
            // `sh -c`. `-c` rather than `-lc`: a login profile could print.
            let inner = format!("printf '%s' {}", shell_quote(name));
            let outer = format!("sh -c {}", shell_quote(&inner));
            let out = Command::new("sh").arg("-c").arg(&outer).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), *name, "outer: {outer}");
        }
    }

    /// The full exec string, run by a real shell from a directory whose name
    /// is itself hostile. Unix-only: it needs an absolute POSIX temp path.
    #[cfg(unix)]
    #[test]
    fn remote_command_runs_in_a_hostile_directory() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!(
            "arc-exec-it's $(touch pwned) `x` {}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();
        let line = remote_command(&shell_join(&["pwd"]), Some(cwd)).unwrap();
        let out = Command::new("sh").arg("-c").arg(&line).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), cwd);
        assert!(!dir.join("pwned").exists() && !std::path::Path::new("pwned").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capped_output_marks_truncation() {
        let mut buf = vec![0u8; MAX_EXEC_OUTPUT - 2];
        let mut truncated = false;
        push_capped(&mut buf, b"ab", &mut truncated);
        assert!(!truncated);
        push_capped(&mut buf, b"c", &mut truncated);
        assert!(truncated);
        assert_eq!(buf.len(), MAX_EXEC_OUTPUT);
    }
}
