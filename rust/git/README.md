# arc-git — Git Introspection

Git status, log, diff, and blame via CLI shelling.

## What It Does

- **Status:** Branch, ahead/behind, dirty counts
- **Log:** Commit history with custom formatting
- **Diff:** Worktree, staged, or HEAD changes
- **Blame:** Line-by-line commit attribution

## Key Functions

```rust
pub async fn status(path: &str) -> Result<Option<GitInfo>>;
pub async fn log(path: &str, limit: u32) -> Result<Vec<LogEntry>>;
pub async fn diff(path: &str, scope: DiffScope) -> Result<String>;
pub async fn blame(path: &str, file: &str) -> Result<Vec<BlameLine>>;
```

## Note: Shell-out Design

This crate shells out to `git` CLI rather than using libgit2. Advantages:
- No compilation/version issues
- Respects local git config
- Simpler logic

Tradeoff: Requires git to be installed on the system.

## See Also

- `apps/desktop/src/commands/git.rs` — Tauri command layer
- `apps/frontend/src/components/StatusBar.tsx` — Branch display
