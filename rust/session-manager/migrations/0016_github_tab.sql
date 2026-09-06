-- One new tab kind: 'github', the full-page GitHub workspace (repos, issues,
-- pull requests, workflow runs, releases, notifications).
--
-- The tab carries no payload — it's a singleton scoped to the signed-in
-- account, not to a workspace — so apiclient_state_json stays null for it and
-- there's nothing to hydrate beyond the row itself.

-- Widen the tabs.kind CHECK constraint. Same rebuild pattern as
-- 0015_db_and_merge_tabs.sql — SQLite can't ALTER a CHECK in place.
-- 'sysmonitor' is still carried along as dead allowance (see 0011).

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient', 'sysmonitor', 'ssh', 'diff', 'db', 'merge', 'github')),
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
