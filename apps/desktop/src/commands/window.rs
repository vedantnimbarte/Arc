//! Multi-window helpers — standalone Settings, Git, and Agent-editor windows.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("settings_window_open")              -> ()  // open / focus
//!   invoke("settings_broadcast_changed")        -> ()  // ping sibling windows
//!   invoke("git_window_open")                   -> ()  // open / focus
//!   invoke("agent_editor_window_open", { id })  -> ()  // open / focus for `id`

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const SETTINGS_LABEL: &str = "settings";
const GIT_LABEL: &str = "git";
const AGENT_EDITOR_LABEL: &str = "agent-editor";

/// Open the Settings window. If it already exists, just focus it.
/// The window loads the same frontend bundle as the main window but
/// with `?view=settings` so `main.tsx` renders the SettingsPage.
#[tauri::command]
pub async fn settings_window_open(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?view=settings".into());
    let win = WebviewWindowBuilder::new(&app, SETTINGS_LABEL, url)
        .title("ARC — Settings")
        .inner_size(820.0, 620.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Notify every window that settings just changed. Each window's frontend
/// listens for `settings://changed` and re-pulls from SQLite — so the
/// terminal/editor in the main window picks up a theme change made in
/// the Settings window without restart.
#[tauri::command]
pub async fn settings_broadcast_changed(app: AppHandle) -> Result<(), String> {
    app.emit("settings://changed", ()).map_err(|e| e.to_string())
}

/// Open the Agent-editor window pointed at `agent_id`. The frontend
/// expects the id to exist in the agents store — the caller (Settings
/// grid → New / Edit) is responsible for creating a blank entry first
/// when launching the "new" flow.
#[tauri::command]
pub async fn agent_editor_window_open(app: AppHandle, agent_id: String) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(AGENT_EDITOR_LABEL) {
        // Re-navigate the existing window to the new agent id so a second
        // "Edit" from the grid doesn't leave the user staring at the wrong
        // agent. We swap the URL by setting `window.location` from the
        // frontend after focus, via a query-param ping below.
        let _ = existing.show();
        let _ = existing.set_focus();
        let _ = app.emit("agent-editor://navigate", &agent_id);
        return Ok(());
    }

    // URL-encode the id so paths with `&` or `=` survive intact. The
    // frontend reads it back via `URLSearchParams`.
    let encoded = urlencoding(&agent_id);
    let url = WebviewUrl::App(format!("index.html?view=agent-editor&id={encoded}").into());
    let win = WebviewWindowBuilder::new(&app, AGENT_EDITOR_LABEL, url)
        .title("ARC — Agent")
        .inner_size(720.0, 640.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

/// Tiny query-string encoder — pulled in inline so we don't take a new
/// dep just to escape an agent id. Only encodes the subset that breaks
/// `URLSearchParams` parsing.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            _ => {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

/// Open the Git history window. Same one-bundle, `?view=git` dispatch as
/// Settings — `main.tsx` renders `<GitPage>` when the flag is present.
#[tauri::command]
pub async fn git_window_open(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(GIT_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?view=git".into());
    let win = WebviewWindowBuilder::new(&app, GIT_LABEL, url)
        .title("ARC — Git")
        .inner_size(1100.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .decorations(false)
        .transparent(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}
