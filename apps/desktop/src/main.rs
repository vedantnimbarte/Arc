// On Windows, prevent a console window from popping up alongside the GUI in
// release builds. Dev keeps stdout/stderr for tracing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use arc_session_manager::SessionStore;
use commands::fs::WatchState;
use commands::lsp::LspState;
use commands::pty::PtyState;
use commands::ssh::SshState;
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
    // Before anything else: a panic in a command otherwise dies with the
    // process, leaving the user a failed invoke and no way to say what broke.
    commands::diagnostics::install_panic_hook();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new(
                    "arc=debug,arc_pty=debug,arc_session_manager=debug,info",
                )
            }),
        )
        .with_target(true)
        .init();

    let app = tauri::Builder::default()
        // Auto-launch at login (toggleable from Settings → Appearance).
        // The plugin only flips OS-level autostart when the frontend calls
        // its `enable()` / `disable()` JS API; registering is otherwise
        // inert.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // System notifications for long-running commands (Tier 1.5). The
        // frontend gates delivery on a setting + window focus.
        .plugin(tauri_plugin_notification::init())
        // In-app updates. Registering only exposes the check/download IPC —
        // nothing is fetched until the frontend asks, and every downloaded
        // bundle must carry a minisign signature matching the `pubkey` in
        // tauri.conf.json or the install is rejected.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // `relaunch()` — used to restart into a freshly installed update.
        .plugin(tauri_plugin_process::init())
        // Save the main window's geometry on close. Restore is gated by the
        // user's `restoreWindowState` preference, checked in `setup` below.
        // The settings & git popups are excluded — they have their own
        // sensible defaults and we don't want them migrating around.
        .plugin(
            WindowStateBuilder::default()
                .with_state_flags(WINDOW_STATE_FLAGS)
                .with_denylist(&["settings", "git"])
                .skip_initial_state("main")
                .build(),
        )
        .manage(PtyState::default())
        .manage(SshState::default())
        .manage(commands::ssh::SftpState::default())
        .manage(WatchState::default())
        .manage(commands::wingman::WingmanState::default())
        .manage(commands::claude_code::ClaudeState::default())
        .manage(commands::db::DbState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pty::pty_spawn,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_kill,
            commands::pty::pty_list_shells,
            commands::pty::pty_list_ai_clis,
            commands::fs::fs_default_root,
            commands::fs::fs_parent,
            commands::fs::fs_read_dir,
            commands::fs::fs_pick_folder,
            commands::fs::fs_pick_files,
            commands::fs::fs_list_files,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_scratch_file,
            commands::fs::fs_watch_start,
            commands::fs::fs_watch_stop,
            commands::fs::fs_search,
            commands::fs::fs_replace_find,
            commands::fs::fs_replace_apply,
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
            commands::session::session_command_log,
            commands::session::session_commands_recent,
            commands::session::session_command_finish,
            commands::session::session_settings_load,
            commands::session::session_settings_save,
            commands::session::session_scrollback_save,
            commands::session::session_scrollback_load,
            commands::session::session_scrollback_delete,
            commands::session::session_scrollback_prune,
            commands::git::git_status,
            commands::git::git_diff_stat,
            commands::git::git_changes,
            commands::git::git_root,
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
            commands::git::git_remotes,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_stash_list,
            commands::git::git_stash_push,
            commands::git::git_stash_pop,
            commands::git::git_stash_drop,
            commands::git::git_checkpoint_create,
            commands::git::git_checkpoint_restore,
            commands::git::git_checkpoint_forget,
            commands::git::git_branch_create,
            commands::git::git_branch_rename,
            commands::git::git_branch_delete,
            commands::git::git_merge,
            commands::git::git_commit_amend,
            commands::git::git_revert,
            commands::git::git_cherry_pick,
            commands::git::git_reset,
            commands::git::git_last_message,
            commands::git::git_checkout_ours,
            commands::git::git_checkout_theirs,
            commands::git::git_worktree_list,
            commands::git::git_worktree_add,
            commands::git::git_worktree_remove,
            commands::git::git_rebase_interactive,
            commands::git::git_rebase_abort,
            commands::git::git_rebase_continue,
            commands::git::git_tags,
            commands::git::git_tag_create,
            commands::git::git_tag_delete,
            commands::git::git_tag_push,
            commands::git::git_remote_add,
            commands::git::git_remote_remove,
            commands::git::git_remote_set_url,
            commands::git::git_reflog,
            commands::git::git_submodules,
            commands::git::git_bisect_status,
            commands::git::git_bisect_start,
            commands::git::git_bisect_mark,
            commands::git::git_bisect_reset,
            commands::git_host::git_host_detect,
            commands::git_host::git_host_token_set,
            commands::git_host::git_host_token_get,
            commands::git_host::git_host_token_delete,
            commands::git_host::git_host_pr_list,
            commands::git_host::git_host_pr_get,
            commands::git_host::git_host_pr_create,
            commands::secrets::secret_set,
            commands::secrets::secret_get,
            commands::secrets::secret_delete,
            commands::secrets::secret_list,
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
            commands::ssh::ssh_fs_connect,
            commands::ssh::ssh_fs_disconnect,
            commands::ssh::ssh_fs_connected,
            commands::ssh::ssh_fs_read_dir,
            commands::ssh::ssh_fs_read_file,
            commands::ssh::ssh_fs_write_file,
            commands::ssh::ssh_fs_create_dir,
            commands::ssh::ssh_fs_rename,
            commands::ssh::ssh_fs_remove,
            commands::lsp::lsp_start,
            commands::lsp::lsp_did_open,
            commands::lsp::lsp_did_change,
            commands::lsp::lsp_did_close,
            commands::lsp::lsp_hover,
            commands::lsp::lsp_completion,
            commands::lsp::lsp_definition,
            commands::lsp::lsp_references,
            commands::lsp::lsp_rename,
            commands::lsp::lsp_formatting,
            commands::lsp::lsp_stop,
            commands::lsp::lsp_is_running,
            commands::proc::proc_run,
            commands::db::db_conn_list,
            commands::db::db_conn_upsert,
            commands::db::db_conn_delete,
            commands::db::db_password_set,
            commands::db::db_connect,
            commands::db::db_disconnect,
            commands::db::db_is_connected,
            commands::db::db_query,
            commands::db::db_tables,
            commands::db::db_preview,
            commands::network::network_probe_port,
            commands::network::shell_open_external,
            commands::fonts::fonts_list_system,
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
            commands::project_config::project_config_load,
            commands::window::settings_window_open,
            commands::window::settings_broadcast_changed,
            commands::window::git_window_open,
            commands::wingman::wingman_configure,
            commands::wingman::wingman_health,
            commands::wingman::wingman_projects,
            commands::wingman::wingman_board,
            commands::wingman::wingman_board_add_card,
            commands::wingman::wingman_board_dispatch,
            commands::wingman::wingman_board_archive,
            commands::wingman::wingman_board_delete_card,
            commands::wingman::wingman_pilot_runs,
            commands::wingman::wingman_pilot_run,
            commands::wingman::wingman_pilot_control,
            commands::wingman::wingman_sessions,
            commands::wingman::wingman_session_transcript,
            commands::wingman::wingman_create_session,
            commands::wingman::wingman_delete_session,
            commands::wingman::wingman_diff,
            commands::wingman::wingman_explain,
            commands::wingman::wingman_cost,
            commands::wingman::wingman_turn_start,
            commands::wingman::wingman_events_subscribe,
            commands::claude_code::claude_available,
            commands::claude_code::claude_turn_start,
            commands::claude_code::claude_turn_cancel,
            commands::claude_code::claude_permission_respond,
            commands::diagnostics::diagnostics_collect,
            commands::diagnostics::diagnostics_summary,
            commands::diagnostics::diagnostics_clear,
        ])
        .setup(|app| {
            // Open the SQLite store before the window appears so the first
            // `session_load` call from the frontend always has a pool ready.
            // A corrupt / half-migrated db must not brick the app: recover by
            // quarantining the bad file and starting fresh. Only a genuinely
            // unwritable data dir (disk full / permissions) fails here, and
            // there's nothing to persist to in that case anyway.
            let (store, recovered) =
                match tauri::async_runtime::block_on(SessionStore::open_default_or_recover()) {
                    Ok(v) => v,
                    Err(err) => {
                        tracing::error!(%err, "cannot open or recreate session store; exiting");
                        // ponytail: no writable data dir => nothing to persist;
                        // clean exit beats a panic dialog. Upgrade to a native
                        // error dialog if users ever actually hit this.
                        std::process::exit(1);
                    }
                };
            if let Some(path) = recovered {
                tracing::warn!(?path, "previous database was unreadable; started fresh (old file kept alongside)");
            }

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
            // The LSP manager needs an AppHandle to emit diagnostics events,
            // so it's built here (not via Default) where the handle is ready.
            app.manage(LspState::new(app.handle().clone()));
            tracing::info!("arc desktop started");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ARC");

    // Reap every live PTY before the process exits. Tauri tears the app down
    // via `process::exit`, which skips Rust destructors — so without this the
    // PtyManager's masters never drop, `ClosePseudoConsole` never runs, and
    // each tab's conhost.exe (plus its shell) is orphaned in Task Manager.
    // `ExitRequested` fires once the last window closes; `Exit` is the final
    // event before teardown. `kill_all` is idempotent, so covering both is
    // safe.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app_handle.state::<PtyState>().manager.kill_all();
            // Same reasoning for language servers: `kill_on_drop` never runs
            // under `process::exit`, so rust-analyzer & friends (each with its
            // own conhost.exe on Windows) would keep running after the window
            // is gone. Clone the Arc out of the state guard first — the guard
            // can't be held across the await inside `block_on`.
            let lsp = app_handle.state::<LspState>().manager.clone();
            tauri::async_runtime::block_on(lsp.stop_all());
            // Database pools too, so servers see a clean disconnect rather
            // than N abandoned sockets timing out.
            tauri::async_runtime::block_on(
                app_handle.state::<commands::db::DbState>().manager.close_all(),
            );
        }
        _ => {}
    });
}
