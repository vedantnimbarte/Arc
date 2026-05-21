// On Windows, prevent a console window from popping up alongside the GUI in
// release builds. Dev keeps stdout/stderr for tracing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use arc_session_manager::SessionStore;
use commands::agent::AgentApprovals;
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
        .manage(AgentApprovals::new())
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_list_shells,
            commands::pty::pty_list_ai_clis,
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
            commands::fs::fs_index_rebuild,
            commands::fs::fs_index_status,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_reveal,
            commands::fs::fs_create_dir,
            commands::session::session_load,
            commands::session::session_save_tabs,
            commands::session::session_set_workspace,
            commands::session::session_workspaces_list,
            commands::session::session_workspace_upsert,
            commands::session::session_workspace_delete,
            commands::session::session_chat_load,
            commands::session::session_chat_append,
            commands::session::session_chat_clear,
            commands::session::session_chat_sessions_list,
            commands::session::session_chat_session_create,
            commands::session::session_chat_session_update,
            commands::session::session_chat_session_delete,
            commands::session::session_chat_messages_load,
            commands::session::session_command_log,
            commands::session::session_commands_recent,
            commands::session::session_command_finish,
            commands::session::session_settings_load,
            commands::session::session_settings_save,
            commands::git::git_status,
            commands::git::git_log,
            commands::git::git_diff,
            commands::git::git_blame,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::secrets::secrets_set_api_key,
            commands::secrets::secrets_get_api_key,
            commands::secrets::secrets_delete_api_key,
            commands::agent::agent_run,
            commands::agent::agent_decide,
            commands::mcp::mcp_connect,
            commands::mcp::mcp_connect_http,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            commands::mcp::mcp_disconnect,
            commands::memory::memory_save,
            commands::memory::memory_update,
            commands::memory::memory_delete,
            commands::memory::memory_get,
            commands::memory::memory_list,
            commands::memory::memory_search,
            commands::memory::memory_embed_entry,
            commands::memory::memory_vector_search,
            commands::window::settings_window_open,
            commands::window::settings_broadcast_changed,
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
