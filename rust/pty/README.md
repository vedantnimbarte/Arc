# arc-pty — PTY Process Management

Terminal emulation via pseudo-terminals (PTY). Spawns shell processes and manages bidirectional I/O.

## What It Does

- **Spawn PTY:** Create a new shell process (bash, zsh, PowerShell, etc.)
- **Write stdin:** Send user input to the shell
- **Read stdout:** Capture shell output (bytes) in real-time
- **Resize:** Change terminal dimensions (cols/rows)
- **Kill:** Terminate the process

## Key Types

- `PtyManager` — Main interface for PTY operations
- `PtySpawnOptions` — Configuration for spawning (shell, cwd, size)
- `PtyOutput` — Bytes from shell stdout

## Dependencies

- `portable-pty` — Cross-platform PTY abstraction
- `tokio` — Async runtime
- `bytes` — Byte buffer utilities

## Example Usage

```rust
use arc_pty::PtyManager;

let mut pty = PtyManager::new();
let id = pty.spawn(PtySpawnOptions {
    shell: Some("/bin/bash".to_string()),
    cwd: Some("/home/user".to_string()),
    cols: 80,
    rows: 24,
})?;

pty.write(&id, "ls -la\n")?;
pty.resize(&id, 100, 30)?;
pty.kill(&id)?;
```

## Limitations

- **Blocking I/O:** Reader thread is OS-level blocking (not async)
- **Platform-specific:** Behavior varies on macOS, Windows, Linux
- **Shell availability:** Depends on system (respects PATH)

## See Also

- `apps/desktop/src/commands/pty.rs` — Tauri command layer
- `apps/frontend/src/components/Terminal.tsx` — xterm.js frontend
