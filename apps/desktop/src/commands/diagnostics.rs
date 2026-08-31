//! Crash logging and the diagnostics blob users paste into bug reports.
//!
//! A panic inside a Tauri command doesn't reach the UI — the invoke rejects
//! with a generic message (or the process aborts) and the actual location is
//! lost with the process. [`install_panic_hook`] writes every panic to
//! `<data_dir>/arc/crash.log` so there is something to read afterwards, and
//! `diagnostics_collect` bundles that log with the build/platform facts a
//! report needs.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("diagnostics_collect")  -> String   (ready to paste)
//!   invoke("diagnostics_summary")  -> DiagnosticsSummary
//!   invoke("diagnostics_clear")    -> ()

use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Keep the log from growing without bound on a machine that panics in a
/// loop. Old entries are dropped from the front when the file exceeds this.
const CRASH_LOG_MAX_BYTES: u64 = 512 * 1024;

/// How much of the log the diagnostics blob carries. A bug report wants the
/// last few panics, not the file's whole history.
const CRASH_LOG_TAIL_BYTES: usize = 32 * 1024;

fn crash_log_path() -> Option<PathBuf> {
    let mut dir = dirs::data_dir()?;
    dir.push("arc");
    Some(dir.join("crash.log"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Chain a crash-logging hook onto whatever hook is already installed, so the
/// default (or tracing's) stderr output still happens in dev.
///
/// Everything here is best-effort: a panic handler that itself panics aborts
/// the process, so no unwrap, no expect, and no allocation-heavy formatting
/// beyond the message itself.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        // `payload_as_str` is still unstable, so match the two types that
        // `panic!` actually produces.
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let backtrace = std::backtrace::Backtrace::force_capture();

        let entry = format!(
            "\n=== panic @ {} ===\nversion: {}\nthread:  {}\nat:      {}\nmessage: {}\n{}\n",
            now_ms(),
            env!("CARGO_PKG_VERSION"),
            thread,
            location,
            message,
            backtrace,
        );
        append_crash_entry(&entry);

        previous(info);
    }));
}

fn append_crash_entry(entry: &str) {
    let Some(path) = crash_log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Truncate from the front once the file gets large. Reading the whole
    // file to rewrite it is fine at this size and only happens after a panic.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > CRASH_LOG_MAX_BYTES {
            if let Ok(existing) = std::fs::read_to_string(&path) {
                let keep = existing
                    .char_indices()
                    .nth(existing.chars().count().saturating_sub(CRASH_LOG_TAIL_BYTES))
                    .map(|(i, _)| &existing[i..])
                    .unwrap_or("");
                let _ = std::fs::write(&path, keep);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(entry.as_bytes());
    }
}

/// What the About pane shows without asking for the whole blob.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticsSummary {
    /// Epoch-ms of the most recent panic, or `null` if the log is empty.
    pub last_crash_at: Option<i64>,
    /// How many panic entries the log holds.
    pub crash_count: usize,
    /// Absolute path to the log, so the user can attach the file itself.
    pub log_path: Option<String>,
}

fn read_crash_log() -> Option<String> {
    std::fs::read_to_string(crash_log_path()?).ok()
}

/// Parse the `=== panic @ <ms> ===` markers the hook writes.
fn scan_entries(log: &str) -> (usize, Option<i64>) {
    let mut count = 0;
    let mut last = None;
    for line in log.lines() {
        let Some(rest) = line.strip_prefix("=== panic @ ") else {
            continue;
        };
        let Some(ts) = rest.strip_suffix(" ===") else {
            continue;
        };
        count += 1;
        if let Ok(ms) = ts.trim().parse::<i64>() {
            last = Some(ms);
        }
    }
    (count, last)
}

#[tauri::command]
pub fn diagnostics_summary() -> DiagnosticsSummary {
    let log = read_crash_log().unwrap_or_default();
    let (crash_count, last_crash_at) = scan_entries(&log);
    DiagnosticsSummary {
        last_crash_at,
        crash_count,
        log_path: crash_log_path().map(|p| p.display().to_string()),
    }
}

/// Build the paste-ready report: build facts, then the tail of the crash log.
#[tauri::command]
pub fn diagnostics_collect() -> String {
    let mut out = String::new();
    let _ = writeln!(out, "ARC {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(out, "os:      {} {}", std::env::consts::OS, std::env::consts::ARCH);
    let _ = writeln!(
        out,
        "tauri:   {}",
        option_env!("DEP_TAURI_VERSION").unwrap_or("2")
    );
    let _ = writeln!(
        out,
        "data:    {}",
        dirs::data_dir()
            .map(|mut d| {
                d.push("arc");
                d.display().to_string()
            })
            .unwrap_or_else(|| "<unavailable>".to_string())
    );

    match read_crash_log() {
        Some(log) if !log.trim().is_empty() => {
            let tail = if log.len() > CRASH_LOG_TAIL_BYTES {
                let mut cut = log.len() - CRASH_LOG_TAIL_BYTES;
                while cut < log.len() && !log.is_char_boundary(cut) {
                    cut += 1;
                }
                &log[cut..]
            } else {
                &log[..]
            };
            let (count, _) = scan_entries(&log);
            let _ = writeln!(out, "\n--- crash log ({count} panic(s), most recent last) ---");
            out.push_str(tail);
        }
        _ => {
            let _ = writeln!(out, "\n--- crash log: empty ---");
        }
    }
    out
}

#[tauri::command]
pub fn diagnostics_clear() -> Result<(), String> {
    let Some(path) = crash_log_path() else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Nothing to clear is success, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_entries_counts_and_takes_the_last_timestamp() {
        let log = "\
=== panic @ 1000 ===
message: boom
=== panic @ 2500 ===
message: boom again
";
        assert_eq!(scan_entries(log), (2, Some(2500)));
    }

    #[test]
    fn scan_entries_ignores_unrelated_lines_and_empty_logs() {
        assert_eq!(scan_entries(""), (0, None));
        assert_eq!(scan_entries("thread panicked at src/x.rs"), (0, None));
        // A malformed timestamp still counts as a crash — we'd rather report
        // "1 crash, time unknown" than silently drop the entry.
        assert_eq!(scan_entries("=== panic @ nope ==="), (1, None));
    }
}
