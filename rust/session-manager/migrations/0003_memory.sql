-- Memory subsystem (V0). Workspace-scoped notes the user (or the agent on
-- the user's behalf) saves for later recall. FTS5 powers keyword search;
-- the `embedding` BLOB column is reserved for vector search (V1+) so we
-- don't have to migrate the table when an embeddings provider lands.

CREATE TABLE memory_entries (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT,
    kind         TEXT NOT NULL DEFAULT 'note',
    title        TEXT,
    content      TEXT NOT NULL,
    tags         TEXT,   -- comma-separated; tag table can replace this later
    source       TEXT,   -- 'chat' | 'manual' | 'agent' | ...
    embedding    BLOB,   -- reserved for vector search
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_workspace_time ON memory_entries(workspace_id, updated_at DESC);
CREATE INDEX idx_memory_kind ON memory_entries(kind);

-- External-content FTS5 index. The rowid is the implicit sqlite rowid of
-- memory_entries; triggers below keep the two in sync.
CREATE VIRTUAL TABLE memory_fts USING fts5(
    title,
    content,
    tags,
    content='memory_entries',
    content_rowid='rowid',
    tokenize = 'porter unicode61'
);

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries BEGIN
    INSERT INTO memory_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO memory_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
END;
