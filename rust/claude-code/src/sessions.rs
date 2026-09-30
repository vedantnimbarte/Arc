//! The CLI's own conversation history, read from disk.
//!
//! Claude Code writes every session to
//! `<config>/projects/<encoded cwd>/<session id>.jsonl`, one record per line.
//! ARC reads those files directly rather than keeping a transcript of its own,
//! so a conversation started in a terminal shows up in the window's history and
//! vice versa — there is exactly one record of what was said.
//!
//! Replay reuses [`Translator`]: a transcript's `assistant` and `user` records
//! have the same shape as the live stream's, so the frontend folds a loaded
//! conversation through the same reducer as a streaming one.

use crate::{stringify_content, Event, Translator};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

/// The CLI's config root: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn config_dir() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(d) if !d.is_empty() => Some(PathBuf::from(d)),
        _ => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

/// The CLI's folder name for a working directory: every character that isn't
/// an ASCII letter or digit becomes `-`. Per UTF-16 unit, matching the CLI's
/// JavaScript `replace(/[^a-zA-Z0-9]/g, "-")`.
///
/// ponytail: the CLI truncates + hashes names over 200 chars; those folders
/// list as empty until that's mirrored here.
pub fn encode_cwd(cwd: &str) -> String {
    cwd.encode_utf16()
        .map(|u| match char::from_u32(u as u32) {
            Some(c) if c.is_ascii_alphanumeric() => c,
            _ => '-',
        })
        .collect()
}

/// Session ids are UUIDs. Anything else is refused before it reaches a path,
/// which is what stops `../` in an id from escaping the projects folder.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn project_dir(cwd: &str) -> Result<PathBuf> {
    let root = config_dir().context("no home directory")?;
    Ok(root.join("projects").join(encode_cwd(cwd)))
}

fn session_file(cwd: &str, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        bail!("invalid session id");
    }
    Ok(project_dir(cwd)?.join(format!("{id}.jsonl")))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    /// Last write, ms since the epoch.
    pub updated_at: u64,
}

/// Every conversation recorded for `cwd`, newest first. A folder Claude has
/// never run in is an empty list, not an error.
pub fn list(cwd: &str) -> Result<Vec<SessionMeta>> {
    let dir = project_dir(cwd)?;
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // `<id>/` subfolders hold subagent transcripts, not conversations.
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).filter(|s| valid_id(s)) else {
            continue;
        };
        let updated_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let title = read_tail(&path, 64 * 1024).ok().and_then(|t| title_from_tail(&t));
        let first_prompt = first_prompt(&path);
        // A file with neither is a session that never got a prompt (e.g. one
        // opened and immediately quit) — nothing to resume.
        if title.is_none() && first_prompt.is_none() {
            continue;
        }
        out.push(SessionMeta { id: id.to_string(), title, first_prompt, updated_at });
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(out)
}

/// A conversation replayed as ARC events, ready for the panel's reducer.
pub fn load(cwd: &str, id: &str) -> Result<Vec<Event>> {
    let path = session_file(cwd, id)?;
    let text = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    Ok(transcript_events(&text))
}

/// Delete a conversation. Its subagent folder goes too; missing is fine.
pub fn delete(cwd: &str, id: &str) -> Result<()> {
    let path = session_file(cwd, id)?;
    for r in [fs::remove_file(&path), fs::remove_dir_all(path.with_extension(""))] {
        if let Err(e) = r {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
}

fn read_tail(path: &PathBuf, max: u64) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(max)))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Titles are appended as the conversation goes, so the latest wins. A title
/// the user set beats the CLI's generated one, which beats the last prompt.
fn title_from_tail(tail: &str) -> Option<String> {
    let (mut custom, mut ai, mut last) = (None, None, None);
    // Reverse, so the first hit of each kind is the latest. The first line of
    // a tail is usually cut mid-record and simply fails to parse.
    for line in tail.lines().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let (slot, key) = match v.get("type").and_then(Value::as_str) {
            Some("custom-title") => (&mut custom, "customTitle"),
            Some("ai-title") => (&mut ai, "aiTitle"),
            Some("last-prompt") => (&mut last, "lastPrompt"),
            _ => continue,
        };
        if slot.is_none() {
            *slot = v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(clip);
        }
    }
    custom.or(ai).or(last)
}

fn first_prompt(path: &PathBuf) -> Option<String> {
    let f = File::open(path).ok()?;
    BufReader::new(f)
        .lines()
        .take(40)
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
        .filter_map(|v| user_text(&v))
        // `/clear` or `/model x` says nothing about the conversation.
        .find(|t| !t.starts_with('/') || t.starts_with("/plan "))
        .map(|t| clip(&t))
}

fn clip(s: &str) -> String {
    s.chars().take(200).collect()
}

/// ponytail: tool output capped for the IPC hop; lazy-load the full body if
/// anyone misses it.
const MAX_TOOL_OUTPUT: usize = 16 * 1024;

/// What a person typed, from a `user` record — `None` for tool results, the
/// CLI's own injected messages, and local command noise.
fn user_text(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("user")
        || v.get("isMeta").and_then(Value::as_bool) == Some(true)
        || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let text = match v.pointer("/message/content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            blocks
                .iter()
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
                    Some("image") => Some("[image]".to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty()
        || text.starts_with("<local-command-")
        || text.starts_with("<task-notification")
    {
        return None;
    }
    // `/plan foo` is recorded as tag soup; show it the way it was typed.
    if let Some(name) = between(text, "<command-name>", "</command-name>") {
        let args = between(text, "<command-args>", "</command-args>").unwrap_or("").trim();
        return Some(if args.is_empty() { name.to_string() } else { format!("{name} {args}") });
    }
    Some(text.to_string())
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = s.find(open)? + open.len();
    let end = s[start..].find(close)? + start;
    Some(&s[start..end])
}

/// Replay a transcript as ARC events.
///
/// ponytail: records are taken in file order, so a rewound branch shows
/// inline; walk `parentUuid` from the last leaf if that ever matters.
pub fn transcript_events(text: &str) -> Vec<Event> {
    let mut tr = Translator::new();
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(t) = user_text(&v) {
                    out.push(Event::new("user", json!({ "text": t })));
                    continue;
                }
                if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                for mut ev in tr.push(&v) {
                    if ev.kind == "tool_result" {
                        let full = stringify_content(Some(&ev.payload["output"]));
                        if full.len() > MAX_TOOL_OUTPUT {
                            let mut cut = MAX_TOOL_OUTPUT;
                            while !full.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            ev.payload["output"] = json!(format!("{}\n… (truncated)", &full[..cut]));
                        }
                    }
                    out.push(ev);
                }
            }
            Some("assistant") => out.extend(tr.push(&v)),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_cwd_like_the_cli() {
        assert_eq!(
            encode_cwd(r"C:\Users\vedan\OneDrive\Desktop\Projects\Arc"),
            "C--Users-vedan-OneDrive-Desktop-Projects-Arc"
        );
        assert_eq!(encode_cwd("/home/me/my_app.v2"), "-home-me-my-app-v2");
        // One UTF-16 unit per `-`: é is one, 😀 is a surrogate pair.
        assert_eq!(encode_cwd("/é😀"), "----");
    }

    #[test]
    fn refuses_ids_that_could_escape_the_folder() {
        assert!(valid_id("4aed8d32-2e0e-4149-8c13-95841c665bc9"));
        for bad in ["", "../x", "a/b", r"a\b", "..", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(session_file("/x", "../../etc/passwd").is_err());
    }

    #[test]
    fn title_prefers_custom_then_ai_then_last_prompt_latest_first() {
        let tail = [
            r#"{"type":"ai-title","aiTitle":"old"}"#,
            r#"{"type":"last-prompt","lastPrompt":"do it"}"#,
            r#"{"type":"ai-title","aiTitle":"new"}"#,
        ]
        .join("\n");
        assert_eq!(title_from_tail(&tail).as_deref(), Some("new"));
        let with_custom = format!("{tail}\n{}", r#"{"type":"custom-title","customTitle":"mine"}"#);
        assert_eq!(title_from_tail(&with_custom).as_deref(), Some("mine"));
        assert_eq!(
            title_from_tail(r#"{"type":"last-prompt","lastPrompt":"do it"}"#).as_deref(),
            Some("do it")
        );
        assert_eq!(title_from_tail("garbage\n{}"), None);
    }

    fn kinds(evs: &[Event]) -> Vec<&str> {
        evs.iter().map(|e| e.kind.as_str()).collect()
    }

    #[test]
    fn replays_a_transcript_as_panel_events() {
        let text = [
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/plan</command-name>\n<command-message>plan</command-message>\n<command-args>add a window</command-args>"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Enabled plan mode</local-command-stdout>"}}"#,
            r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>done</task-notification>"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Reading."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"body"}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"t"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{}}]}}"#,
        ]
        .join("\n");
        let evs = transcript_events(&text);
        assert_eq!(kinds(&evs), ["user", "text_delta", "tool_start", "tool_result", "user"]);
        assert_eq!(evs[0].payload["text"], "/plan add a window");
        assert_eq!(evs[1].payload["text"], "Reading.");
        assert_eq!(evs[3].payload["id"], "t1");
        assert_eq!(evs[3].payload["output"], "body");
        assert_eq!(evs[4].payload["text"], "look\n[image]");
    }

    #[test]
    fn caps_long_tool_output() {
        let body = "é".repeat(MAX_TOOL_OUTPUT);
        let line = json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":body}]}}).to_string();
        let evs = transcript_events(&line);
        let out = evs[0].payload["output"].as_str().unwrap();
        assert!(out.len() < MAX_TOOL_OUTPUT + 32);
        assert!(out.ends_with("(truncated)"));
    }
}
