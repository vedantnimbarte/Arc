-- Widen the tabs.kind CHECK constraint to allow 'sysmonitor'. Same rebuild
-- pattern as 0008_apiclient.sql / 0007_preview_tabs.sql — SQLite can't ALTER
-- a CHECK in place.

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient', 'sysmonitor')),
    file_path            TEXT,
    preview_url          TEXT,
    apiclient_state_json TEXT,
    position             INTEGER NOT NULL,
    created_at           INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO tabs_new (id, session_id, title, kind, file_path, preview_url, apiclient_state_json, position, created_at)
SELECT id, session_id, title, kind, file_path, preview_url, apiclient_state_json, position, created_at FROM tabs;

DROP TABLE tabs;
ALTER TABLE tabs_new RENAME TO tabs;

PRAGMA foreign_keys = ON;
