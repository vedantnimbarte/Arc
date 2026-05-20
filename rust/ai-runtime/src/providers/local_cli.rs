//! Local CLI provider — wraps an installed coding-agent CLI (Claude Code,
//! OpenAI Codex, OpenCode) and streams its stdout back as chat chunks.
//!
//! Trade-offs vs. the HTTP providers:
//! - No multi-turn API. Each CLI manages its own session state; we collapse
//!   the message history into a single prompt argument per call.
//! - Streaming granularity depends on how the CLI flushes stdout — typically
//!   line-buffered for `--print` / `exec` / `run` modes.
//! - Auth + model selection live inside the CLI's own config.

use std::process::Stdio;

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream, StreamExt};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::{ChatRequest, Chunk, Provider, ProviderError, Role};

/// Which installed CLI to invoke.
#[derive(Debug, Clone, Copy)]
pub enum LocalCliKind {
    ClaudeCode,
    Codex,
    OpenCode,
}

impl LocalCliKind {
    pub fn from_provider_id(id: &str) -> Option<Self> {
        match id {
            "claude-cli" => Some(Self::ClaudeCode),
            "codex-cli" => Some(Self::Codex),
            "opencode-cli" => Some(Self::OpenCode),
            _ => None,
        }
    }

    fn provider_id(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-cli",
            Self::Codex => "codex-cli",
            Self::OpenCode => "opencode-cli",
        }
    }

    /// The binary name to spawn when no explicit path was supplied.
    fn default_binary(&self) -> &'static str {
        match self {
            Self::ClaudeCode => {
                if cfg!(windows) {
                    "claude.cmd"
                } else {
                    "claude"
                }
            }
            Self::Codex => {
                if cfg!(windows) {
                    "codex.cmd"
                } else {
                    "codex"
                }
            }
            Self::OpenCode => {
                if cfg!(windows) {
                    "opencode.cmd"
                } else {
                    "opencode"
                }
            }
        }
    }

    /// Argv tail to append after the prompt argument.
    fn args(&self, prompt: &str) -> Vec<String> {
        match self {
            Self::ClaudeCode => vec![
                "--print".into(),
                "--output-format".into(),
                "text".into(),
                prompt.to_string(),
            ],
            Self::Codex => vec!["exec".into(), prompt.to_string()],
            Self::OpenCode => vec!["run".into(), prompt.to_string()],
        }
    }
}

pub struct LocalCliProvider {
    kind: LocalCliKind,
    /// Optional explicit path; falls back to PATH lookup of `default_binary`.
    path: Option<String>,
}

impl LocalCliProvider {
    pub fn new(provider_id: &str, path: Option<String>) -> Result<Self, ProviderError> {
        let kind = LocalCliKind::from_provider_id(provider_id).ok_or_else(|| {
            ProviderError::Other(format!("unknown local-cli provider: {provider_id}"))
        })?;
        Ok(Self { kind, path })
    }
}

#[async_trait]
impl Provider for LocalCliProvider {
    fn id(&self) -> &'static str {
        self.kind.provider_id()
    }

    async fn stream(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, Result<Chunk, ProviderError>>, ProviderError> {
        let prompt = collapse_prompt(&req);

        let binary = self
            .path
            .clone()
            .unwrap_or_else(|| self.kind.default_binary().to_string());
        let args = self.kind.args(&prompt);

        let mut cmd = Command::new(&binary);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| ProviderError::Other(format!("spawn {binary}: {e}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProviderError::Other("stdout pipe missing".into()))?;
        let stderr = child.stderr.take();

        // Forward stdout lines into an mpsc; the stream below drains it and
        // tags an exit-status terminator when the channel closes. Spawning a
        // task keeps the I/O loop independent of consumer back-pressure.
        let (tx, rx) = mpsc::channel::<Result<String, ProviderError>>(64);
        let tx_for_task = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let mut text = line;
                        text.push('\n');
                        if tx_for_task.send(Ok(text)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = tx_for_task
                            .send(Err(ProviderError::Other(format!("read stdout: {e}"))))
                            .await;
                        break;
                    }
                }
            }
            drop(tx_for_task);
        });

        // State threaded through the unfold:
        //   (rx, child, stderr, done_sent)
        let init = (rx, Some(child), stderr, false);
        let stream = stream::unfold(init, |state| async move {
            let (mut rx, child_opt, stderr, done_sent) = state;
            if done_sent {
                return None;
            }
            match rx.recv().await {
                Some(Ok(text)) => Some((
                    Ok(Chunk { text, done: false }),
                    (rx, child_opt, stderr, false),
                )),
                Some(Err(e)) => Some((Err(e), (rx, child_opt, stderr, true))),
                None => {
                    // Channel closed → reader finished. Wait on child to surface
                    // a clean exit code OR a non-zero stderr-flavored error.
                    let mut child = match child_opt {
                        Some(c) => c,
                        None => return None,
                    };
                    let status = child.wait().await;
                    match status {
                        Ok(s) if s.success() => Some((
                            Ok(Chunk {
                                text: String::new(),
                                done: true,
                            }),
                            (rx, None, None, true),
                        )),
                        Ok(s) => {
                            let stderr_text = read_to_string_opt(stderr).await;
                            let msg = if stderr_text.is_empty() {
                                format!("CLI exited with status {s}")
                            } else {
                                stderr_text
                            };
                            Some((Err(ProviderError::Other(msg)), (rx, None, None, true)))
                        }
                        Err(e) => Some((
                            Err(ProviderError::Other(format!("wait: {e}"))),
                            (rx, None, None, true),
                        )),
                    }
                }
            }
        })
        .boxed();

        drop(tx);
        Ok(stream)
    }
}

/// Squash the chat history into a single text prompt the CLI can consume.
fn collapse_prompt(req: &ChatRequest) -> String {
    let mut buf = String::new();
    if let Some(sys) = req.system.as_deref() {
        buf.push_str(sys.trim());
        buf.push_str("\n\n");
    }
    for (i, m) in req.messages.iter().enumerate() {
        let role = match m.role {
            Role::System => "System",
            Role::User => "User",
            Role::Assistant => "Assistant",
        };
        if i > 0 {
            buf.push('\n');
        }
        buf.push_str(role);
        buf.push_str(": ");
        buf.push_str(m.content.trim());
        buf.push('\n');
    }
    buf.trim().to_string()
}

async fn read_to_string_opt(stderr: Option<tokio::process::ChildStderr>) -> String {
    let Some(mut err) = stderr else {
        return String::new();
    };
    let mut buf = String::new();
    let _ = err.read_to_string(&mut buf).await;
    buf
}
