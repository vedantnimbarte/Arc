//! Remote development parity: git, content search, file listing, process
//! runs and language servers for a remote workspace, run on its host over
//! the SSH connection the workspace already holds (`arc_ssh::exec`).
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts, which routes the
//! ordinary `git*`/`fsSearch`/`fsListFiles`/`procRun`/`lspStart` wrappers here
//! when the path is an `ssh://` URI):
//!   invoke("ssh_git",          { hostId, command, args })                   -> JSON
//!   invoke("ssh_search",       { hostId, root, query, limit, ignoreDirs })  -> SearchHit[]
//!   invoke("ssh_list_files",   { hostId, root, query, limit, ignoreDirs })  -> FileItem[]
//!   invoke("ssh_exec",         { hostId, cwd, program, args, timeoutMs, onData }) -> ProcOutput
//!   invoke("lsp_start_remote", { hostId, id, command, args, root, rootUri }) -> capabilities
//!
//! `ssh_git` takes the local `git_*` command name and that command's own
//! arguments, so the frontend needs one routing rule rather than a remote twin
//! of every wrapper. Paths in and out are POSIX paths on the host; the
//! frontend strips and re-adds the `ssh://<hostId>` prefix.
//!
//! Every argument a user or the remote tree supplies reaches the host through
//! `arc_ssh::shell_join`, never string formatting.

use std::time::{Duration, Instant};

use arc_git::DiffScope;
use arc_ssh::{remote_uri, shell_join, shell_quote, ExecEvent, ExecOutput, SftpManager};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::lsp::LspState;
use super::proc::{ProcOutput, DEFAULT_TIMEOUT_MS, MAX_CAPTURE, MAX_TIMEOUT_MS};
use super::ssh::SftpState;

/// Budget for the quick git/search/list calls. A cold `git status` on a big
/// repo over a slow link can take a while; a hung one must not spin forever.
const QUICK_TIMEOUT: Duration = Duration::from_secs(60);

/// Run `argv` in `cwd` on the host. A missing program comes back as a clear
/// error naming the host instead of a shell's "not found" line.
async fn run(
    sftp: &SftpManager,
    host_id: &str,
    argv: &[String],
    cwd: &str,
    stdin: Option<Vec<u8>>,
) -> Result<ExecOutput, String> {
    run_script(sftp, host_id, &shell_join(argv), &argv[0], cwd, stdin).await
}

async fn run_script(
    sftp: &SftpManager,
    host_id: &str,
    script: &str,
    program: &str,
    cwd: &str,
    stdin: Option<Vec<u8>>,
) -> Result<ExecOutput, String> {
    let out = sftp
        .exec(host_id, script, Some(cwd), stdin, QUICK_TIMEOUT)
        .await
        .map_err(|e| format!("{e:#}"))?;
    if out.timed_out {
        return Err(format!("`{program}` timed out after {}s", QUICK_TIMEOUT.as_secs()));
    }
    missing_program(sftp, host_id, program, &out)?;
    Ok(out)
}

fn missing_program(
    sftp: &SftpManager,
    host_id: &str,
    program: &str,
    out: &ExecOutput,
) -> Result<(), String> {
    if out.not_found() && String::from_utf8_lossy(&out.stderr).contains("not found") {
        let host = sftp.host_name(host_id).unwrap_or_else(|| "the remote host".into());
        return Err(format!("{program} isn't installed on {host}"));
    }
    Ok(())
}

fn ok(out: &ExecOutput) -> bool {
    out.exit_code == Some(0)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// git's own complaint, for a failed command.
fn failure(out: &ExecOutput, fallback: &str) -> String {
    let err = text(&out.stderr).trim().to_string();
    let std = text(&out.stdout).trim().to_string();
    if !err.is_empty() {
        err
    } else if !std.is_empty() {
        std
    } else {
        fallback.to_string()
    }
}

fn git_argv<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    std::iter::once("git".to_string())
        .chain(args.iter().map(|a| a.as_ref().to_string()))
        .collect()
}

// ─── git ──────────────────────────────────────────────────────────────────

/// The union of every supported `git_*` command's arguments, as the frontend
/// sends them.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitArgs {
    path: String,
    scope: Option<DiffScope>,
    path_filter: Option<String>,
    paths: Vec<String>,
    tracked_paths: Vec<String>,
    untracked_paths: Vec<String>,
    message: Option<String>,
    sign: Option<bool>,
    signoff: Option<bool>,
    patch: Option<String>,
    cached: bool,
    reverse: bool,
    limit: Option<usize>,
    options: Option<arc_git::LogOptions>,
    file: Option<String>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    name: Option<String>,
    oid: Option<String>,
}

/// git with the same environment `arc_git::git_cmd` sets locally: no
/// credential prompt to hang on, no optional index writes to wake watchers.
async fn git(
    sftp: &SftpManager,
    host_id: &str,
    cwd: &str,
    args: &[String],
    stdin: Option<Vec<u8>>,
) -> Result<ExecOutput, String> {
    let script = format!(
        "GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 {}",
        shell_join(&git_argv(args))
    );
    run_script(sftp, host_id, &script, "git", cwd, stdin).await
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
pub async fn ssh_git(
    sftp: State<'_, SftpState>,
    host_id: String,
    command: String,
    args: GitArgs,
) -> Result<Value, String> {
    let m = &*sftp.manager;
    let h = host_id.as_str();
    let cwd = args.path.as_str();
    if !cwd.starts_with('/') {
        return Err(format!("remote git needs an absolute path, got {cwd:?}"));
    }
    let to_json = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());

    match command.as_str() {
        "git_status" => {
            let out = git(m, h, cwd, &strings(arc_git::STATUS_ARGS), None).await?;
            if !ok(&out) {
                return Ok(Value::Null);
            }
            let mut info = arc_git::parse_status(&text(&out.stdout));
            // One round trip for every marker instead of a stat each.
            let script = format!(
                "g=$(GIT_OPTIONAL_LOCKS=0 git rev-parse --absolute-git-dir) || exit 0; \
                 for m in {}; do [ -e \"$g/$m\" ] && printf '%s\\n' \"$m\"; done; exit 0",
                shell_join(arc_git::IN_PROGRESS_MARKERS)
            );
            let markers = run_script(m, h, &script, "git", cwd, None).await?;
            let present = text(&markers.stdout);
            info.in_progress = arc_git::in_progress_op(|name| present.lines().any(|l| l == name));
            to_json(serde_json::to_value(Some(info)))
        }
        "git_changes" => {
            let out = git(m, h, cwd, &strings(arc_git::CHANGES_ARGS), None).await?;
            let entries = if ok(&out) { arc_git::parse_changes(&out.stdout) } else { Vec::new() };
            to_json(serde_json::to_value(entries))
        }
        "git_root" => {
            let out = git(m, h, cwd, &strings(&["rev-parse", "--show-toplevel"]), None).await?;
            let top = text(&out.stdout).trim().to_string();
            Ok(if ok(&out) && !top.is_empty() { json!(top) } else { Value::Null })
        }
        "git_diff_stat" => {
            let probe = git(m, h, cwd, &strings(&["rev-parse", "--is-inside-work-tree"]), None).await?;
            if !ok(&probe) {
                return Ok(Value::Null);
            }
            let mut stat = arc_git::DiffStat::default();
            let numstat =
                git(m, h, cwd, &strings(&["--no-pager", "diff", "--numstat", "HEAD"]), None).await?;
            if ok(&numstat) {
                arc_git::add_numstat(&mut stat, &text(&numstat.stdout));
            }
            // Untracked files count as additions of their line count, like
            // the local version. `grep -Ic ''` counts lines and reports 0 for
            // binaries, all on the host rather than pulling each file over.
            let script = "GIT_OPTIONAL_LOCKS=0 git ls-files --others --exclude-standard -z \
                          | xargs -0 grep -IcH '' -- 2>/dev/null; exit 0";
            let counted = run_script(m, h, script, "git", cwd, None).await?;
            for line in text(&counted.stdout).lines() {
                if let Some((_, n)) = line.rsplit_once(':') {
                    stat.files_changed += 1;
                    stat.insertions += n.parse::<usize>().unwrap_or(0);
                }
            }
            to_json(serde_json::to_value(Some(stat)))
        }
        "git_diff" => {
            let scope = args.scope.unwrap_or(DiffScope::Worktree);
            let out = git(m, h, cwd, &arc_git::diff_args(scope, args.path_filter.as_deref()), None)
                .await?;
            if !ok(&out) {
                return Err(failure(&out, "git diff failed"));
            }
            Ok(json!(text(&out.stdout)))
        }
        "git_blame" => {
            let file = args.file.as_deref().ok_or("missing file")?;
            let range = match (args.start_line, args.end_line) {
                (Some(s), Some(e)) if s > 0 && e >= s => Some((s, e)),
                _ => None,
            };
            let out = git(m, h, cwd, &arc_git::blame_args(file, range), None).await?;
            if !ok(&out) {
                return Err(failure(&out, "git blame failed"));
            }
            to_json(serde_json::to_value(arc_git::parse_blame_porcelain(&text(&out.stdout))))
        }
        "git_log" => {
            let opts = args.options.unwrap_or_default();
            let out = git(m, h, cwd, &arc_git::log_args(args.limit.unwrap_or(100), &opts), None).await?;
            if !ok(&out) {
                return Err(failure(&out, "git log failed"));
            }
            to_json(serde_json::to_value(arc_git::parse_log(&text(&out.stdout))))
        }
        "git_commit_files" => {
            let oid = args.oid.as_deref().ok_or("missing oid")?;
            let out = git(m, h, cwd, &arc_git::commit_files_args(oid), None).await?;
            if !ok(&out) {
                return Err(failure(&out, "git show failed"));
            }
            to_json(serde_json::to_value(arc_git::parse_commit_files(&text(&out.stdout))))
        }
        "git_commit_message" => {
            let oid = args.oid.as_deref().ok_or("missing oid")?;
            let out = git(m, h, cwd, &arc_git::commit_message_args(oid), None).await?;
            if !ok(&out) {
                return Err(failure(&out, "git show failed"));
            }
            Ok(json!(text(&out.stdout).trim_end()))
        }
        "git_branches" => {
            let out = git(m, h, cwd, &arc_git::branches_args(), None).await?;
            let list = if ok(&out) { arc_git::parse_branches(&text(&out.stdout)) } else { Vec::new() };
            to_json(serde_json::to_value(list))
        }
        "git_stage" => {
            if args.paths.is_empty() {
                return Ok(Value::Null);
            }
            let mut a = strings(&["add", "--"]);
            a.extend(args.paths);
            let out = git(m, h, cwd, &a, None).await?;
            if !ok(&out) {
                return Err(failure(&out, "git add failed"));
            }
            Ok(Value::Null)
        }
        "git_unstage" => {
            if args.paths.is_empty() {
                return Ok(Value::Null);
            }
            // Same initial-commit fallback as `arc_git::unstage`.
            let head =
                git(m, h, cwd, &strings(&["rev-parse", "--verify", "--quiet", "HEAD"]), None).await?;
            let mut a = if ok(&head) {
                strings(&["reset", "HEAD", "--"])
            } else {
                strings(&["rm", "--cached", "--"])
            };
            a.extend(args.paths);
            let out = git(m, h, cwd, &a, None).await?;
            if !ok(&out) {
                return Err(failure(&out, "unstage failed"));
            }
            Ok(Value::Null)
        }
        "git_apply" => {
            let mut a = strings(&["apply"]);
            if args.cached {
                a.push("--cached".into());
            }
            if args.reverse {
                a.push("--reverse".into());
            }
            a.push("-".into());
            let patch = args.patch.unwrap_or_default().into_bytes();
            let out = git(m, h, cwd, &a, Some(patch)).await?;
            if !ok(&out) {
                return Err(failure(&out, "git apply failed"));
            }
            Ok(Value::Null)
        }
        "git_commit" => {
            let message = args.message.unwrap_or_default();
            let msg = message.trim();
            if msg.is_empty() {
                return Err("empty commit message".into());
            }
            let a = arc_git::commit_args(msg, args.sign.unwrap_or(false), args.signoff.unwrap_or(false));
            let out = git(m, h, cwd, &a, None).await?;
            if !ok(&out) {
                return Err(failure(&out, "commit failed"));
            }
            let probe = git(m, h, cwd, &strings(arc_git::COMMIT_PROBE_ARGS), None).await?;
            let probed = ok(&probe).then(|| text(&probe.stdout));
            to_json(serde_json::to_value(arc_git::parse_commit_probe(probed.as_deref(), msg)))
        }
        "git_discard" => {
            if !args.tracked_paths.is_empty() {
                let mut a = strings(&["checkout", "HEAD", "--"]);
                a.extend(args.tracked_paths);
                let out = git(m, h, cwd, &a, None).await?;
                if !ok(&out) {
                    return Err(failure(&out, "discard failed"));
                }
            }
            if !args.untracked_paths.is_empty() {
                // Untracked files have no history to restore; they go, as
                // locally. `rm -rf` tolerates ones already gone.
                let mut argv = strings(&["rm", "-rf", "--"]);
                argv.extend(args.untracked_paths);
                let out = run(m, h, &argv, cwd, None).await?;
                if !ok(&out) {
                    return Err(failure(&out, "removing untracked files failed"));
                }
            }
            Ok(Value::Null)
        }
        "git_checkout" => {
            let name = args.name.unwrap_or_default();
            let name = name.trim();
            if name.is_empty() {
                return Err("empty branch name".into());
            }
            // Same guard as `arc_git::checkout`: a ref can't start with `-`.
            if name.starts_with('-') {
                return Err(format!("refusing branch name that looks like a command-line option: {name:?}"));
            }
            let (a, created_tracking) = if name.contains('/') {
                let local = format!("refs/heads/{name}");
                let probe =
                    git(m, h, cwd, &strings(&["show-ref", "--verify", "--quiet", &local]), None).await?;
                if ok(&probe) {
                    (strings(&["switch", name]), false)
                } else {
                    (strings(&["switch", "--track", name]), true)
                }
            } else {
                (strings(&["switch", name]), false)
            };
            let out = git(m, h, cwd, &a, None).await?;
            if !ok(&out) {
                return Err(failure(&out, "checkout failed"));
            }
            let head = git(m, h, cwd, &strings(&["symbolic-ref", "--short", "HEAD"]), None).await?;
            let branch = text(&head.stdout).trim().to_string();
            to_json(serde_json::to_value(arc_git::CheckoutResult {
                branch: (ok(&head) && !branch.is_empty()).then_some(branch),
                created_tracking,
            }))
        }
        other => Err(format!(
            "{} isn't available on remote workspaces yet — use an SSH tab",
            other.replacen("git_", "git ", 1).replace('_', " ")
        )),
    }
}

// ─── search / listing ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn ssh_search(
    sftp: State<'_, SftpState>,
    host_id: String,
    root: String,
    query: String,
    limit: usize,
    ignore_dirs: Vec<String>,
) -> Result<Vec<arc_filesystem::SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    // One exec either way: prefer ripgrep, fall back to grep, and say which
    // ran on the first line so the right parser reads the rest. `head` caps
    // what crosses the wire; the parser ranks and truncates to `limit`.
    let cap = limit.saturating_mul(8).max(200);
    let script = format!(
        "if command -v rg >/dev/null 2>&1; then echo rg; {rg} 2>/dev/null | head -n {cap}; \
         else echo grep; {grep} 2>/dev/null | head -n {cap}; fi",
        rg = shell_join(&arc_filesystem::rg_args(&query, &ignore_dirs)),
        grep = shell_join(&arc_filesystem::grep_args(&query, &ignore_dirs)),
    );
    let out = run_script(&sftp.manager, &host_id, &script, "grep", &root, None).await?;
    let stdout = text(&out.stdout);
    let (tool, rest) = stdout.split_once('\n').unwrap_or((stdout.as_str(), ""));
    let mut hits = if tool == "rg" {
        arc_filesystem::parse_rg_json(rest, &root, &query, limit)
    } else {
        arc_filesystem::parse_grep_z(rest, &root, &query, limit)
    };
    for hit in &mut hits {
        hit.path = remote_uri(&host_id, &hit.path);
    }
    Ok(hits)
}

#[tauri::command]
pub async fn ssh_list_files(
    sftp: State<'_, SftpState>,
    host_id: String,
    root: String,
    query: String,
    limit: usize,
    ignore_dirs: Vec<String>,
) -> Result<Vec<arc_filesystem::FileItem>, String> {
    let script = format!(
        "{} 2>/dev/null | head -n 8000",
        shell_join(&arc_filesystem::find_args(&ignore_dirs))
    );
    let out = run_script(&sftp.manager, &host_id, &script, "find", &root, None).await?;
    let mut items = arc_filesystem::rank_remote_listing(&root, &text(&out.stdout), &query, limit);
    for item in &mut items {
        item.path = remote_uri(&host_id, &item.path);
    }
    Ok(items)
}

// ─── process runs (tests, checkers) ───────────────────────────────────────

/// `proc_run` on the host. Output streams to `on_data` as it arrives (both
/// streams, raw bytes) and the collected result comes back at the end, in
/// `proc_run`'s shape so the test explorer and checkers parse it unchanged.
#[tauri::command]
pub async fn ssh_exec(
    sftp: State<'_, SftpState>,
    host_id: String,
    cwd: String,
    program: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<ProcOutput, String> {
    if program.trim().is_empty() {
        return Err("no program given".to_string());
    }
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, MAX_TIMEOUT_MS),
    );
    let argv: Vec<String> = std::iter::once(program.clone()).chain(args).collect();
    let started = Instant::now();
    let mut rx = sftp
        .manager
        .exec_stream(&host_id, &shell_join(&argv), Some(&cwd), None)
        .await
        .map_err(|e| format!("{e:#}"))?;

    let mut out = ExecOutput::default();
    let collect = async {
        while let Some(event) = rx.recv().await {
            let (buf, chunk) = match event {
                ExecEvent::Stdout(b) => (&mut out.stdout, b),
                ExecEvent::Stderr(b) => (&mut out.stderr, b),
                ExecEvent::Exit(code) => {
                    out.exit_code = code;
                    continue;
                }
            };
            let room = MAX_CAPTURE.saturating_sub(buf.len());
            out.truncated |= chunk.len() > room;
            buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
            let _ = on_data.send(InvokeResponseBody::Raw(chunk));
        }
    };
    // Timing out drops the receiver, which closes the channel on the host.
    out.timed_out = tokio::time::timeout(timeout, collect).await.is_err();
    missing_program(&sftp.manager, &host_id, &program, &out)?;
    Ok(ProcOutput {
        code: if out.timed_out { None } else { out.exit_code },
        stdout: text(&out.stdout),
        stderr: if out.timed_out {
            format!("{}timed out after {}s", text(&out.stderr), timeout.as_secs())
        } else {
            text(&out.stderr)
        },
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out: out.timed_out,
        truncated: out.truncated,
    })
}

// ─── language servers ─────────────────────────────────────────────────────

/// Start a language server on the host, its stdio piped over an exec
/// channel, under the LSP session `id`. `root` is the POSIX workspace root it
/// runs in and `root_uri` the same as a `file://` URI. URIs on this session are the server's `file:///…` form; the
/// frontend translates them to and from `ssh://` (see `lib/remote.ts`).
#[tauri::command]
pub async fn lsp_start_remote(
    sftp: State<'_, SftpState>,
    lsp: State<'_, LspState>,
    host_id: String,
    id: String,
    command: String,
    args: Vec<String>,
    root: String,
    root_uri: String,
) -> Result<Value, String> {
    // Probe first: a missing server would otherwise surface as "closed before
    // response", which says nothing about why.
    let probe = format!("command -v {} >/dev/null", shell_quote(&command));
    let found = sftp
        .manager
        .exec(&host_id, &probe, Some(&root), None, QUICK_TIMEOUT)
        .await
        .map_err(|e| format!("{e:#}"))?;
    if !ok(&found) {
        let host = sftp.manager.host_name(&host_id).unwrap_or_else(|| "the remote host".into());
        return Err(format!("{command} isn't installed on {host}"));
    }
    let argv: Vec<String> = std::iter::once(command).chain(args).collect();
    let stream = sftp
        .manager
        .exec_io(&host_id, &shell_join(&argv), Some(&root))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let (reader, writer) = tokio::io::split(stream);
    lsp.manager.start_io(&id, reader, writer, Some(&root_uri)).await
}
