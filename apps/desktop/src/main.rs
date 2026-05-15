// On Windows, prevent a console window from popping up alongside the GUI in
// release builds. Dev keeps stdout/stderr for tracing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::llm::LlmState;
use commands::pty::PtyState;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("arc=debug,arc_pty=debug,arc_ai_runtime=debug,info")),
        )
        .with_target(true)
        .init();

    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(LlmState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::llm::llm_stream,
            commands::llm::llm_cancel,
        ])
        .setup(|_app| {
            tracing::info!("arc desktop started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ARC");
}
