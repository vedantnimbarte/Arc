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
use commands::ssh::SshState;
use commands::system::SystemState;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::{Builder as WindowStateBuilder, StateFlags, WindowExt};
use tracing_subscriber::EnvFilter;

/// State flags the window-state plugin saves on close and (conditionally)
/// restores on launch. We intentionally skip `VISIBLE` — the main window
/// should always come back up.
const WINDOW_STATE_FLAGS: StateFlags = StateFlags::from_bits_truncate(
    StateFlags::POSITION.bits() | StateFlags::SIZE.bits() | StateFlags::MAXIMIZED.bits(),
);

/// Peek at the persisted user-settings blob to decide whether to restore
/// the main window's saved geometry. Defaults to `true` on any read error so
/// users who never visited the settings pane get the natural behaviour.
fn read_restore_window_pref(store: &SessionStore) -> bool {
    let result: Result<Option<String>, _> = tauri::async_runtime::block_on(async {
        arc_session_manager::settings::load(store.pool(), "user_settings").await
    });
    let raw = match result {
        Ok(Some(s)) => s,
        _ => return true,
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return true,
    };
    parsed
        .get("restoreWindowState")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

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
        // Auto-launch at login (toggleable from Settings → Appearance).
        // The plugin only flips OS-level autostart when the frontend calls
        // its `enable()` / `disable()` JS API; registering is otherwise
        // inert.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Save the main window's geometry on close. Restore is gated by the
        // user's `restoreWindowState` preference, checked in `setup` below.
        // The settings & git popups are excluded — they have their own
        // sensible defaults and we don't want them migrating around.
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .with_denylist(&["settings", "git", "agent-editor"])
                .skip_initial_state("main")
                .build(),
        )
        .manage(PtyState::default())
        .manage(SshState::default())
        .manage(LlmState::default())
        .manage(WatchState::default())
        .manage(McpState::default())
        .manage(AgentApprovals::new())
        .manage::<SystemState>(std::sync::Arc::new(arc_system_monitor::Monitor::new()))
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_list_shells,
            commands::pty::pty_list_ai_clis,
            commands::llm::llm_stream,
            commands::llm::llm_cancel,
            commands::llm::llm_list_models,
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
            commands::git::git_diff_stat,
            commands::git::git_changes,
            commands::git::git_log,
            commands::git::git_diff,
            commands::git::git_blame,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_authors,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_discard,
            commands::git::git_apply,
            commands::secrets::secrets_set_api_key,
            commands::secrets::secrets_get_api_key,
            commands::secrets::secrets_delete_api_key,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_close,
            commands::ssh::ssh_host_list,
            commands::ssh::ssh_host_upsert,
            commands::ssh::ssh_host_delete,
            commands::ssh::ssh_key_list,
            commands::ssh::ssh_key_generate,
            commands::ssh::ssh_key_import,
            commands::ssh::ssh_key_delete,
            commands::ssh::ssh_session_logs,
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
            commands::network::network_probe_port,
            commands::network::shell_open_external,
            commands::http::http_request,
            commands::apiclient::apiclient_list_collections,
            commands::apiclient::apiclient_upsert_collection,
            commands::apiclient::apiclient_delete_collection,
            commands::apiclient::apiclient_list_requests,
            commands::apiclient::apiclient_upsert_request,
            commands::apiclient::apiclient_delete_request,
            commands::apiclient::apiclient_append_history,
            commands::apiclient::apiclient_history,
            commands::apiclient::apiclient_clear_history,
            commands::apiclient::apiclient_envs_list,
            commands::apiclient::apiclient_envs_upsert,
            commands::apiclient::apiclient_envs_delete,
            commands::apiclient::apiclient_envs_set_active,
            commands::system::system_snapshot,
            commands::system::system_processes_list,
            commands::system::system_process_kill,
            commands::window::settings_window_open,
            commands::window::settings_broadcast_changed,
            commands::window::git_window_open,
            commands::window::agent_editor_window_open,
        ])
        .setup(|app| {
            // Open the SQLite store before the window appears so the first
            // `session_load` call from the frontend always has a pool ready.
            let store = tauri::async_runtime::block_on(SessionStore::open_default())
                .expect("opening session store");

            // Honour the user's window-state preference. We had the plugin
            // skip the auto-restore for "main" above; do it here only when
            // the saved blob says we should. Failures are non-fatal — the
            // window just keeps its default geometry.
            if read_restore_window_pref(&store) {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(err) = window.restore_state(WINDOW_STATE_FLAGS) {
                        tracing::warn!("restore_state(main) failed: {err}");
                    }
                }
            }

            app.manage(store);
            tracing::info!("arc desktop started");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ARC");
}
