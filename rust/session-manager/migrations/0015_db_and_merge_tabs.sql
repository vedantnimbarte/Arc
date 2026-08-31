-- Saved database connections for the DB client tab, plus two new tab kinds
-- ('db' and 'merge').
--
-- Passwords never land in this table. `url` is stored with its password
-- component stripped by the frontend before it gets here; the password itself
-- lives in the OS credential vault under service "dev.arc.terminal.db",
-- account = db_connections.id — the same split ssh_keys uses for passphrases.

CREATE TABLE db_connections (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    -- 'postgres' | 'mysql' | 'sqlite', derived from the URL scheme.
    backend       TEXT NOT NULL,
    -- Connection URL minus the password (e.g. postgres://user@host:5432/db).
    url           TEXT NOT NULL,
    has_password  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
);

CREATE INDEX idx_db_connections_last_used ON db_connections(last_used_at DESC);

-- Widen the tabs.kind CHECK constraint. Same rebuild pattern as
-- 0011_diff_tabs.sql — SQLite can't ALTER a CHECK in place. 'sysmonitor' is
-- still carried along as dead allowance (see 0011).

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient', 'sysmonitor', 'ssh', 'diff', 'db', 'merge')),
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
