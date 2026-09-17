//! Per-session output history, and turning it into something safe to replay.

use std::collections::VecDeque;

/// Bounded FIFO of a session's most recent raw output.
pub struct RingBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    /// Output has been dropped off the front at least once.
    wrapped: bool,
}

impl RingBuffer {
    pub fn new(cap: usize) -> Self {
        Self { buf: VecDeque::with_capacity(cap.min(64 * 1024)), cap, wrapped: false }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        let tail = &bytes[bytes.len().saturating_sub(self.cap)..];
        let over = (self.buf.len() + tail.len()).saturating_sub(self.cap);
        if over > 0 || tail.len() < bytes.len() {
            self.wrapped = true;
        }
        self.buf.drain(..over);
        self.buf.extend(tail);
    }

    pub fn contents(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    /// The buffer as a reattaching terminal should receive it.
    ///
    /// Why replaying raw output is safe here when 0.10's scrollback restore
    /// was not: that restored terminal *modes* (bracketed paste, mouse
    /// tracking, alt screen) into a *new* shell that never turns them off. A
    /// reattach replays into the same process that set them, and the buffer is
    /// a contiguous suffix of its output, so every mode change in it is
    /// followed by any later change too. Losing the oldest bytes can only
    /// drop an "enable" whose "disable" is still present — harmless.
    ///
    /// Two things still need fixing up:
    ///   * a wrapped buffer starts mid-line, possibly mid-escape-sequence, so
    ///     it is cut to the first newline;
    ///   * queries in the history (ConPTY's startup cursor-position request,
    ///     an app's device-attributes probe) would make the new terminal answer
    ///     them *now*, and the answer would land in the live program as typed
    ///     input — so they are removed.
    ///
    /// The picture is completed by the resize the host sends after the replay
    /// (see `host::attach`): full-screen TUIs repaint on SIGWINCH.
    pub fn replay(&self) -> Vec<u8> {
        let mut bytes = self.contents();
        if self.wrapped {
            if let Some(nl) = bytes.iter().position(|&b| b == b'\n') {
                bytes.drain(..=nl);
            }
        }
        strip_queries(&bytes)
    }
}

/// Remove escape sequences that ask the terminal to reply: DSR (`CSI … n`),
/// device attributes (`CSI … c`), window reports (`CSI … t`), DECRQM
/// (`CSI … $ p`), XTVERSION (`CSI > q`), kitty keyboard query (`CSI ? u`),
/// OSC colour queries (`OSC … ?`) and DECRQSS / XTGETTCAP (`DCS $q` / `DCS +q`).
/// Everything else, including an unterminated trailing sequence, is kept.
fn strip_queries(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] != 0x1b || i + 1 >= input.len() {
            out.push(input[i]);
            i += 1;
            continue;
        }
        match input[i + 1] {
            b'[' => {
                // Parameter and intermediate bytes, then one final byte.
                let mut j = i + 2;
                while j < input.len() && (0x20..=0x3f).contains(&input[j]) {
                    j += 1;
                }
                if j >= input.len() {
                    out.extend_from_slice(&input[i..]);
                    break;
                }
                let params = &input[i + 2..j];
                let query = match input[j] {
                    b'n' | b'c' | b't' => true,
                    b'p' => params.last() == Some(&b'$'),
                    b'q' => params.first() == Some(&b'>'),
                    b'u' => params.first() == Some(&b'?'),
                    _ => false,
                };
                if !query {
                    out.extend_from_slice(&input[i..=j]);
                }
                i = j + 1;
            }
            kind @ (b']' | b'P') => {
                // String sequence, terminated by BEL or ST (ESC \).
                let start = i + 2;
                let mut end = None;
                let mut j = start;
                while j < input.len() {
                    if input[j] == 0x07 {
                        end = Some((j, j + 1));
                        break;
                    }
                    if input[j] == 0x1b && input.get(j + 1) == Some(&b'\\') {
                        end = Some((j, j + 2));
                        break;
                    }
                    j += 1;
                }
                let Some((body_end, next)) = end else {
                    out.extend_from_slice(&input[i..]);
                    break;
                };
                let body = &input[start..body_end];
                let query = if kind == b']' {
                    body.last() == Some(&b'?')
                } else {
                    body.starts_with(b"$q") || body.starts_with(b"+q")
                };
                if !query {
                    out.extend_from_slice(&input[i..next]);
                }
                i = next;
            }
            _ => {
                out.push(input[i]);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_most_recent_bytes() {
        let mut ring = RingBuffer::new(8);
        ring.push(b"abc");
        ring.push(b"def");
        assert_eq!(ring.contents(), b"abcdef");
        assert!(!ring.wrapped);
        ring.push(b"ghij");
        assert_eq!(ring.contents(), b"cdefghij");
        assert!(ring.wrapped);
        // A single push bigger than the whole buffer keeps its own tail.
        ring.push(b"0123456789");
        assert_eq!(ring.contents(), b"23456789");
    }

    #[test]
    fn replay_cuts_a_wrapped_buffer_at_a_line_start() {
        let mut ring = RingBuffer::new(12);
        ring.push(b"line one\r\n");
        assert_eq!(ring.replay(), b"line one\r\n");
        ring.push(b"\x1b[1mtwo\r\nthree");
        // Front was dropped, so the partial first line (and its half escape) goes.
        assert_eq!(ring.replay(), b"three");
    }

    #[test]
    fn replay_strips_queries_but_not_modes() {
        let mut ring = RingBuffer::new(1024);
        ring.push(
            b"\x1b[6n\x1b[?2004h\x1b[c\x1b[>0cprompt\x1b[?1049h\x1b]11;?\x07\
              \x1b]7;file:///tmp\x1b\\\x1b[?2026$p\x1b[>q\x1bP$qm\x1b\\\x1b[31mred\x1b[0m\x1b[18t\x1b[",
        );
        assert_eq!(
            ring.replay(),
            b"\x1b[?2004hprompt\x1b[?1049h\x1b]7;file:///tmp\x1b\\\x1b[31mred\x1b[0m\x1b[".to_vec(),
        );
    }
}
