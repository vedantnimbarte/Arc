-- Allow a third tab kind ('preview') and stash the preview URL alongside
-- file_path. SQLite can't ALTER a CHECK constraint, so we rebuild the table.

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview')),
    file_path   TEXT,
    preview_url TEXT,
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO tabs_new (id, session_id, title, kind, file_path, preview_url, position, created_at)
SELECT id, session_id, title, kind, file_path, NULL, position, created_at FROM tabs;

DROP TABLE tabs;
ALTER TABLE tabs_new RENAME TO tabs;

PRAGMA foreign_keys = ON;
