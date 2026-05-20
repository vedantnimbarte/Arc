# arc-filesystem — File Operations & Search

Directory browsing, file reading/writing, watching, and full-text search.

## What It Does

- **Read/write:** File system operations (respecting 5 MiB limit)
- **Browse:** List directory contents
- **Watch:** Recursive directory watching (debounced ~150ms)
- **Search:** BM25 full-text search via tantivy; falls back to walkdir
- **Index:** Build and maintain tantivy index per workspace root
- **Dialog:** Native folder picker (macOS/Windows/Linux)

## Key Types

- `FileOps` — Main interface
- `DirEntry` — File metadata
- `SearchHit` — Search result (path, line number, content)
- `Watcher` — Directory change subscription

## Search Strategy

| Index Status | Strategy | Speed |
|--------------|----------|-------|
| Index exists | tantivy BM25 | Fast (ms) |
| No index | Walkdir (all files) | Slow (seconds) |
| Index stale | Automatic rebuild | Fast after rebuild |

## Key Functions

```rust
pub struct FileOps {
    pub fn read_file(&self, path: &str) -> Result<String>;
    pub fn write_file(&self, path: &str, content: &str) -> Result<()>;
    pub fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>>;
    pub fn search(&self, root: &str, query: &str) -> Result<Vec<SearchHit>>;
    pub fn watch(&mut self, path: &str) -> Result<String>; // Returns watch ID
    pub fn index_rebuild(&self, root: &str) -> Result<usize>; // Returns doc count
}
```

## Configuration

```rust
let mut fs = FileOps::new();

// Search with index
let results = fs.search("/home/user/project", "async function")?;

// Watch for changes
let watch_id = fs.watch("/home/user/project")?;
// Emits fs://change/<watch_id> events
```

## Dependencies

- `notify` — File system watching
- `walkdir` — Directory traversal
- `tantivy` — Full-text search (BM25)
- `rfd` — Native file dialogs

## Performance Notes

- Index stored per workspace root (identified by path hash)
- Watcher debounces changes ~150ms (configurable)
- Search queries are case-insensitive
- Binary files and hidden files are skipped by default

## See Also

- `apps/desktop/src/commands/fs.rs` — Tauri command layer
- `apps/frontend/src/components/FileTree.tsx` — File browser UI
