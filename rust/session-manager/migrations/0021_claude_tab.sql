-- One new tab kind: 'claude', the full-window Claude Code chat.
--
-- Its per-tab state (folder, session id, model, permission mode, rail
-- visibility) rides in apiclient_state_json, the same opaque blob the API
-- client uses, so no new column is needed.

-- Widen the tabs.kind CHECK constraint. Same rebuild pattern as
-- 0016_github_tab.sql — SQLite can't ALTER a CHECK in place.

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient', 'sysmonitor', 'ssh', 'diff', 'db', 'merge', 'github', 'claude')),
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

-- Every rebuild since 0007 dropped this index with the old table. Restore it.
CREATE INDEX IF NOT EXISTS idx_tabs_session ON tabs(session_id, position);

PRAGMA foreign_keys = ON;
