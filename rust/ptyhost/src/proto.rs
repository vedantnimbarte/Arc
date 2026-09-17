//! Wire format between ARC and the session host.
//!
//! Every frame is:
//!
//! ```text
//!   u32 LE  body length (header length field + header + payload)
//!   u32 LE  header length
//!   [..]    header: one JSON `Request` or `Event`
//!   [..]    payload: raw bytes (shell input for `Write`, output for `Output`)
//! ```
//!
//! Output travels as raw bytes rather than a JSON number array — the same
//! reason the Tauri side streams PTY output over a raw channel.
//!
//! The frame layout, `Request::Hello`, `Request::Shutdown` and `Event::Hello`
//! are frozen: they are how an ARC of one version recognises a host of another
//! and retires it. Anything else may change with [`PROTOCOL_VERSION`].

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt};

/// Bump on any incompatible change to the messages below.
pub const PROTOCOL_VERSION: u32 = 1;

/// Largest frame either side accepts. Bounds what a peer can make us allocate;
/// a replay (the ring buffer) plus its header fits comfortably.
pub const MAX_FRAME: usize = 1024 * 1024;

/// Largest payload one `Write` frame carries; bigger pastes are split.
pub const MAX_WRITE_CHUNK: usize = 64 * 1024;

/// Error text for an `Attach` to a session that isn't running.
pub const NOT_FOUND: &str = "no such session";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Request {
    /// First frame on every connection.
    Hello { version: u32 },
    Spawn {
        seq: u64,
        id: String,
        shell: Option<String>,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    },
    /// Route the session's output to this connection, starting with a replay
    /// of its recent output.
    Attach { seq: u64, id: String, cols: u16, rows: u16 },
    Detach { seq: u64, id: String },
    Kill { seq: u64, id: String },
    List { seq: u64 },
    /// Payload: bytes for the shell's stdin. No reply — keystrokes shouldn't
    /// pay a round trip.
    Write { id: String },
    Resize { id: String, cols: u16, rows: u16 },
    /// End every session and exit. Accepted whatever the protocol version.
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Event {
    Hello { version: u32 },
    /// Answer to the request with the same `seq`. `ids` is only filled for `List`.
    Reply {
        seq: u64,
        error: Option<String>,
        #[serde(default)]
        ids: Vec<String>,
    },
    /// Payload: output bytes.
    Output { id: String },
    Exit { id: String, code: Option<i32> },
}

impl Request {
    pub fn seq(&self) -> Option<u64> {
        match self {
            Request::Spawn { seq, .. }
            | Request::Attach { seq, .. }
            | Request::Detach { seq, .. }
            | Request::Kill { seq, .. }
            | Request::List { seq } => Some(*seq),
            _ => None,
        }
    }

    /// Reject anything a well-behaved ARC would never send. The endpoint is
    /// same-user only, but a frame is still untrusted input.
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Request::Spawn { id, shell, args, cwd, env, cols, rows, .. } => {
                check_id(id)?;
                check_size(*cols, *rows)?;
                for s in shell.iter().chain(cwd.iter()) {
                    check_str(s, 4096)?;
                }
                if args.len() > 256 || env.len() > 1024 {
                    return Err("too many args or env vars");
                }
                for a in args {
                    check_str(a, 32 * 1024)?;
                }
                for (k, v) in env {
                    check_str(k, 1024)?;
                    check_str(v, 32 * 1024)?;
                    if k.is_empty() || k.contains('=') {
                        return Err("bad env key");
                    }
                }
                Ok(())
            }
            Request::Attach { id, cols, rows, .. } | Request::Resize { id, cols, rows } => {
                check_id(id)?;
                check_size(*cols, *rows)
            }
            Request::Detach { id, .. } | Request::Kill { id, .. } | Request::Write { id } => {
                check_id(id)
            }
            Request::Hello { .. } | Request::List { .. } | Request::Shutdown => Ok(()),
        }
    }
}

/// Session ids are ARC tab ids (`term-1712345678-ab12`).
fn check_id(id: &str) -> Result<(), &'static str> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok { Ok(()) } else { Err("bad session id") }
}

fn check_size(cols: u16, rows: u16) -> Result<(), &'static str> {
    if (1..=4096).contains(&cols) && (1..=4096).contains(&rows) {
        Ok(())
    } else {
        Err("bad terminal size")
    }
}

fn check_str(s: &str, max: usize) -> Result<(), &'static str> {
    if s.len() > max || s.contains('\0') { Err("bad string field") } else { Ok(()) }
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

/// Encode one frame. Fails only when the result would exceed [`MAX_FRAME`].
pub fn encode<T: Serialize>(msg: &T, payload: &[u8]) -> io::Result<Vec<u8>> {
    let header = serde_json::to_vec(msg).map_err(|e| invalid(e.to_string()))?;
    let body = 4 + header.len() + payload.len();
    if body > MAX_FRAME {
        return Err(invalid("frame too large"));
    }
    let mut out = Vec::with_capacity(4 + body);
    out.extend_from_slice(&(body as u32).to_le_bytes());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(payload);
    Ok(out)
}

/// Read one frame. `Ok(None)` is a clean end of stream; any malformed frame is
/// an `InvalidData` error, after which the connection should be dropped.
pub async fn read_frame<R, T>(r: &mut R) -> io::Result<Option<(T, Vec<u8>)>>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if !(4..=MAX_FRAME).contains(&len) {
        return Err(invalid("frame length out of range"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    let hlen = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    if hlen > len - 4 {
        return Err(invalid("header length out of range"));
    }
    let msg = serde_json::from_slice(&body[4..4 + hlen]).map_err(|e| invalid(e.to_string()))?;
    body.drain(..4 + hlen);
    Ok(Some((msg, body)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_with_payload() {
        let mut wire = encode(&Request::Write { id: "term-1".into() }, b"ls\r\n\x00\xff").unwrap();
        wire.extend(encode(&Event::Exit { id: "term-1".into(), code: Some(3) }, &[]).unwrap());
        let mut r = wire.as_slice();

        let (req, payload) = read_frame::<_, Request>(&mut r).await.unwrap().unwrap();
        assert_eq!(req, Request::Write { id: "term-1".into() });
        assert_eq!(payload, b"ls\r\n\x00\xff");
        let (ev, payload) = read_frame::<_, Event>(&mut r).await.unwrap().unwrap();
        assert_eq!(ev, Event::Exit { id: "term-1".into(), code: Some(3) });
        assert!(payload.is_empty());
        assert!(read_frame::<_, Event>(&mut r).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_malformed_frames() {
        async fn read(bytes: Vec<u8>) -> io::Result<Option<(Request, Vec<u8>)>> {
            read_frame(&mut bytes.as_slice()).await
        }
        // Oversized length: refused before allocating.
        assert!(read(((MAX_FRAME + 1) as u32).to_le_bytes().to_vec()).await.is_err());
        // Header length past the end of the body.
        let mut bad = 8u32.to_le_bytes().to_vec();
        bad.extend(100u32.to_le_bytes());
        bad.extend(b"xxxx");
        assert!(read(bad).await.is_err());
        // Not JSON / unknown message.
        let mut bad = encode(&Request::List { seq: 1 }, &[]).unwrap();
        bad[8] = b'!';
        assert!(read(bad).await.is_err());
        let unknown = br#"{"t":"exec","cmd":"calc"}"#;
        let mut frame = ((4 + unknown.len()) as u32).to_le_bytes().to_vec();
        frame.extend((unknown.len() as u32).to_le_bytes());
        frame.extend(unknown);
        assert!(read(frame).await.is_err());
        // Truncated body.
        let mut cut = encode(&Request::List { seq: 1 }, &[]).unwrap();
        cut.truncate(cut.len() - 2);
        assert!(read(cut).await.is_err());
        // Encoding refuses what decoding would.
        assert!(encode(&Request::Write { id: "x".into() }, &vec![0; MAX_FRAME]).is_err());
    }

    #[test]
    fn validates_fields() {
        let spawn = |id: &str, cols: u16, env: &[(&str, &str)]| Request::Spawn {
            seq: 1,
            id: id.into(),
            shell: None,
            args: vec![],
            cwd: None,
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            cols,
            rows: 24,
        };
        assert!(spawn("term-1712345678-ab12", 80, &[("RUST_LOG", "debug")]).validate().is_ok());
        assert!(spawn("", 80, &[]).validate().is_err());
        assert!(spawn("../../etc", 80, &[]).validate().is_err());
        assert!(spawn("term-1", 0, &[]).validate().is_err());
        assert!(spawn("term-1", 80, &[("A=B", "x")]).validate().is_err());
        assert!(spawn("term-1", 80, &[("A", "x\0y")]).validate().is_err());
    }
}
