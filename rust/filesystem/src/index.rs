//! Tantivy-backed persistent index for workspace search.
//!
//! For workspaces that have been indexed, [`search`] becomes a fast BM25
//! query instead of the V0 full-walk. Falls back to the walker when no
//! index has been built yet (see `crate::search`).
//!
//! Index layout:
//!   `<data_dir>/arc/index/<sha256(canonical_root)>/` — one tantivy
//!   directory per workspace. Building is idempotent: opening an existing
//!   directory with the same schema reuses it.
//!
//! Tokenization: default tantivy "default" tokenizer (Simple + lowercase
//! + stop-word removal). Code identifiers like `snake_case` and
//! `kebab-case` split on underscores/dashes; `camelCase` stays as one
//! token. Good enough for prose + most file-level queries.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, TextFieldIndexing, TextOptions, Value, FAST,
    STORED, TEXT,
};
use tantivy::{doc, Index, IndexReader, IndexWriter, TantivyDocument, Term};
use walkdir::WalkDir;

use crate::Error;

/// Files larger than this are skipped during indexing (same cap as walk
/// search). Keeps the index focused on source code, not generated blobs.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// Tantivy writer buffer — bigger = fewer commits but more RAM. 50 MB is
/// fine for the workspace sizes ARC targets.
const WRITER_HEAP_BYTES: usize = 50 * 1024 * 1024;

/// Directory names skipped during indexing. Mirrors `crate::search::SKIP`.
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".turbo",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".cargo",
    ".idea",
    ".vscode",
    "vendor",
    ".DS_Store",
];

/// One hit. Matches [`crate::SearchHit`] field-for-field so the Tauri
/// surface can be transport-agnostic about which backend produced it.
#[derive(Debug, Clone, Serialize)]
pub struct IndexHit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub snippet: String,
    pub score: f32,
}

struct IndexHandle {
    index: Index,
    reader: IndexReader,
    fields: Fields,
}

#[derive(Clone)]
struct Fields {
    path: Field,
    name: Field,
    content: Field,
    mtime: Field,
}

/// Process-wide cache of opened indices keyed by canonical root. Avoids
/// reopening + warming the reader on every search call.
fn cache() -> &'static Mutex<HashMap<PathBuf, Arc<IndexHandle>>> {
    use std::sync::OnceLock;
    static C: OnceLock<Mutex<HashMap<PathBuf, Arc<IndexHandle>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_schema() -> (Schema, Fields) {
    let mut b = SchemaBuilder::default();
    // `path` and `name` get both a STRING (for exact-match deletion via
    // Term) and TEXT (for query matching). We store the path so we can
    // emit a usable hit without re-reading the file.
    let path_opts = TextOptions::default()
        .set_stored()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("raw")
                .set_index_option(IndexRecordOption::Basic),
        );
    let path = b.add_text_field("path", path_opts);
    let name = b.add_text_field("name", TEXT | STORED);
    let content = b.add_text_field("content", TEXT | STORED);
    let mtime = b.add_i64_field("mtime", STORED | FAST);
    let schema = b.build();
    (
        schema.clone(),
        Fields {
            path,
            name,
            content,
            mtime,
        },
    )
}

fn index_dir_for(root: &Path) -> Result<PathBuf, Error> {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canon.as_os_str().to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();

    let base = dirs::data_dir().ok_or(Error::NoDefaultRoot)?;
    Ok(base.join("arc").join("index").join(hex))
}

fn open_or_create(dir: &Path, schema: &Schema) -> tantivy::Result<Index> {
    if dir.join("meta.json").exists() {
        Index::open_in_dir(dir)
    } else {
        std::fs::create_dir_all(dir).ok();
        Index::create_in_dir(dir, schema.clone())
    }
}

fn handle_for(root: &Path) -> Result<Arc<IndexHandle>, Error> {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    {
        let cache = cache().lock();
        if let Some(h) = cache.get(&canon) {
            return Ok(h.clone());
        }
    }
    let dir = index_dir_for(&canon)?;
    let (schema, fields) = build_schema();
    let index = open_or_create(&dir, &schema)
        .map_err(|e| Error::Index(format!("open {}: {e}", dir.display())))?;
    let reader = index
        .reader_builder()
        .reload_policy(tantivy::ReloadPolicy::OnCommitWithDelay)
        .try_into()
        .map_err(|e| Error::Index(format!("reader: {e}")))?;
    let handle = Arc::new(IndexHandle {
        index,
        reader,
        fields,
    });
    cache().lock().insert(canon, handle.clone());
    Ok(handle)
}

/// Walk `root` and (re)index every text file. Existing documents for the
/// same path are replaced — callers can use this for a full rebuild OR an
/// incremental "this set of paths changed" refresh.
///
/// Returns the number of documents written.
pub fn rebuild(root: impl AsRef<Path>) -> Result<usize, Error> {
    let root = root.as_ref();
    let handle = handle_for(root)?;
    let mut writer: IndexWriter = handle
        .index
        .writer(WRITER_HEAP_BYTES)
        .map_err(|e| Error::Index(format!("writer: {e}")))?;
    // Wipe — `rebuild` semantics. `update_paths` is the incremental form.
    writer
        .delete_all_documents()
        .map_err(|e| Error::Index(format!("delete_all: {e}")))?;

    let mut count = 0usize;
    let walker = WalkDir::new(root)
        .follow_links(false)
        .same_file_system(true)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !SKIP.iter().any(|s| name.eq_ignore_ascii_case(s))
        });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let path = entry.path();
        let Ok(bytes) = std::fs::read(path) else { continue };
        let sniff_end = bytes.len().min(8192);
        if bytes[..sniff_end].contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };

        let name = entry.file_name().to_string_lossy().to_string();
        let path_str = path.to_string_lossy().to_string();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        writer
            .add_document(doc!(
                handle.fields.path => path_str,
                handle.fields.name => name,
                handle.fields.content => text.to_string(),
                handle.fields.mtime => mtime,
            ))
            .map_err(|e| Error::Index(format!("add: {e}")))?;
        count += 1;
    }
    writer
        .commit()
        .map_err(|e| Error::Index(format!("commit: {e}")))?;
    handle
        .reader
        .reload()
        .map_err(|e| Error::Index(format!("reload: {e}")))?;
    Ok(count)
}

/// Refresh just the supplied paths (called from a file-watcher loop).
/// Missing-from-disk paths get their documents deleted; files that exist
/// are re-added (path is the dedup key).
pub fn update_paths(root: impl AsRef<Path>, paths: &[PathBuf]) -> Result<usize, Error> {
    let root = root.as_ref();
    let handle = handle_for(root)?;
    let mut writer: IndexWriter = handle
        .index
        .writer(WRITER_HEAP_BYTES)
        .map_err(|e| Error::Index(format!("writer: {e}")))?;

    let mut updated = 0usize;
    for path in paths {
        let path_str = path.to_string_lossy().to_string();
        // Delete any prior doc with this path (raw tokenizer means the term
        // is the exact string).
        let term = Term::from_field_text(handle.fields.path, &path_str);
        writer.delete_term(term);
        if !path.is_file() {
            continue;
        }
        let Ok(meta) = path.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else { continue };
        let sniff_end = bytes.len().min(8192);
        if bytes[..sniff_end].contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        writer
            .add_document(doc!(
                handle.fields.path => path_str,
                handle.fields.name => name,
                handle.fields.content => text.to_string(),
                handle.fields.mtime => mtime,
            ))
            .map_err(|e| Error::Index(format!("add: {e}")))?;
        updated += 1;
    }
    writer
        .commit()
        .map_err(|e| Error::Index(format!("commit: {e}")))?;
    handle
        .reader
        .reload()
        .map_err(|e| Error::Index(format!("reload: {e}")))?;
    Ok(updated)
}

/// Query the index for `query`, returning up to `limit` hits sorted by
/// descending BM25 score. Returns `Ok(None)` when no index has been built
/// for this workspace yet — caller should fall back to the walker.
pub fn search(
    root: impl AsRef<Path>,
    query: &str,
    limit: usize,
) -> Result<Option<Vec<IndexHit>>, Error> {
    let root = root.as_ref();
    let dir = index_dir_for(root)?;
    if !dir.join("meta.json").exists() {
        return Ok(None);
    }
    let query = query.trim();
    if query.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let handle = handle_for(root)?;
    let searcher = handle.reader.searcher();
    let parser = QueryParser::for_index(&handle.index, vec![handle.fields.name, handle.fields.content]);
    let q = parser
        .parse_query(query)
        .map_err(|e| Error::Index(format!("parse: {e}")))?;
    let top = searcher
        .search(&q, &TopDocs::with_limit(limit.max(1).min(200)))
        .map_err(|e| Error::Index(format!("search: {e}")))?;

    let mut out = Vec::with_capacity(top.len());
    for (score, addr) in top {
        let retrieved: TantivyDocument = searcher
            .doc(addr)
            .map_err(|e| Error::Index(format!("doc: {e}")))?;
        let path = retrieved
            .get_first(handle.fields.path)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = retrieved
            .get_first(handle.fields.name)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content = retrieved
            .get_first(handle.fields.content)
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let (line, snippet) = first_hit_line(content, query);
        out.push(IndexHit {
            path,
            name,
            line,
            snippet,
            score,
        });
    }
    Ok(Some(out))
}

/// Best-effort: locate the first line that contains any token of `query`
/// and return a snippet for it. Cheap heuristic — not a substitute for a
/// tantivy `SnippetGenerator`, but good enough for the search palette.
fn first_hit_line(content: &str, query: &str) -> (u32, String) {
    const MAX: usize = 180;
    let terms: Vec<String> = query
        .split_whitespace()
        .filter_map(|t| {
            let t = t.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
            if t.is_empty() {
                None
            } else {
                Some(t.to_lowercase())
            }
        })
        .collect();

    for (idx, line) in content.lines().enumerate() {
        let lower = line.to_lowercase();
        if terms.iter().any(|t| lower.contains(t)) {
            let trimmed = line.trim_end();
            let snippet = if trimmed.chars().count() <= MAX {
                trimmed.to_string()
            } else {
                let mut end = MAX;
                while end > 0 && !trimmed.is_char_boundary(end) {
                    end -= 1;
                }
                format!("{}…", &trimmed[..end])
            };
            return ((idx + 1) as u32, snippet);
        }
    }
    // Fall back to the first non-empty line so the user still sees context.
    let fallback = content.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let trimmed = fallback.trim_end();
    let snippet = if trimmed.chars().count() <= MAX {
        trimmed.to_string()
    } else {
        let mut end = MAX;
        while end > 0 && !trimmed.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &trimmed[..end])
    };
    (1, snippet)
}

/// True if a built index exists on disk for this root. Cheap — just
/// checks for `meta.json`. The frontend uses this to decide whether to
/// offer a "Rebuild index" button.
pub fn is_built(root: impl AsRef<Path>) -> bool {
    index_dir_for(root.as_ref())
        .map(|d| d.join("meta.json").exists())
        .unwrap_or(false)
}
