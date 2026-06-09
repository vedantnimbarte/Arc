-- Widen the tabs.kind CHECK constraint to allow 'diff'. Same rebuild
-- pattern as 0010_ssh.sql / 0009_sysmonitor.sql — SQLite can't ALTER a
-- CHECK in place. 'sysmonitor' is kept in the allow-list as harmless dead
-- allowance (the System Resources feature was removed; nothing writes it,
-- and dropping it would require migrating any rows a hand-edit might hold).

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient', 'sysmonitor', 'ssh', 'diff')),
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
