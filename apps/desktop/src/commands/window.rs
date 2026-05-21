//! Multi-window helpers — standalone Settings and Git windows.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("settings_window_open")           -> ()  // open / focus
//!   invoke("settings_broadcast_changed")     -> ()  // ping sibling windows
//!   invoke("git_window_open")                -> ()  // open / focus

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const SETTINGS_LABEL: &str = "settings";
const GIT_LABEL: &str = "git";

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
