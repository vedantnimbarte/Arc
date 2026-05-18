// On Windows, prevent a console window from popping up alongside the GUI in
// release builds. Dev keeps stdout/stderr for tracing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use arc_session_manager::SessionStore;
use commands::fs::WatchState;
use commands::llm::LlmState;
use commands::mcp::McpState;
use commands::pty::PtyState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new(
                    "arc=debug,arc_pty=debug,arc_ai_runtime=debug,arc_session_manager=debug,info",
                )
            }),
        )
        .with_target(true)
        .init();

    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(LlmState::default())
        .manage(WatchState::default())
        .manage(McpState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::llm::llm_stream,
            commands::llm::llm_cancel,
            commands::fs::fs_default_root,
            commands::fs::fs_parent,
            commands::fs::fs_read_dir,
            commands::fs::fs_pick_folder,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_watch_start,
            commands::fs::fs_watch_stop,
            commands::fs::fs_search,
            commands::session::session_load,
            commands::session::session_save_tabs,
            commands::session::session_set_workspace,
            commands::session::session_workspaces_list,
            commands::session::session_workspace_upsert,
            commands::session::session_workspace_delete,
            commands::session::session_chat_load,
            commands::session::session_chat_append,
            commands::session::session_chat_clear,
            commands::session::session_command_log,
            commands::session::session_commands_recent,
            commands::git::git_status,
            commands::secrets::secrets_set_api_key,
            commands::secrets::secrets_get_api_key,
            commands::secrets::secrets_delete_api_key,
            commands::agent::agent_run,
            commands::mcp::mcp_connect,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_disconnect,
        ])
        .setup(|app| {
            // Open the SQLite store before the window appears so the first
            // `session_load` call from the frontend always has a pool ready.
            let store = tauri::async_runtime::block_on(SessionStore::open_default())
                .expect("opening session store");
            app.manage(store);
            tracing::info!("arc desktop started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ARC");
}
