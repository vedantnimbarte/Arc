-- API Client tab kind ('apiclient') + per-tab state JSON, plus four new
-- tables backing the API Client feature:
--   api_collections   — folder tree of saved requests.
--   api_requests      — saved requests (collection_id NULL = draft/ad-hoc).
--   api_history       — per-workspace history of executed requests.
--   api_environments  — {{var}} environments; one is_active=1 per session.
--
-- The tabs table CHECK constraint can't be ALTERed in SQLite, so we rebuild
-- it the same way `0007_preview_tabs.sql` did when adding 'preview'.

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient')),
    file_path            TEXT,
    preview_url          TEXT,
    apiclient_state_json TEXT,
    position             INTEGER NOT NULL,
    created_at           INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO tabs_new (id, session_id, title, kind, file_path, preview_url, apiclient_state_json, position, created_at)
SELECT id, session_id, title, kind, file_path, preview_url, NULL, position, created_at FROM tabs;

DROP TABLE tabs;
ALTER TABLE tabs_new RENAME TO tabs;

PRAGMA foreign_keys = ON;

-- ─── Collections (tree of saved requests) ────────────────────────────────

CREATE TABLE api_collections (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    parent_id   TEXT,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id)  REFERENCES api_collections(id) ON DELETE CASCADE
);

CREATE INDEX api_collections_session_idx ON api_collections(session_id);
CREATE INDEX api_collections_parent_idx  ON api_collections(parent_id);

-- ─── Saved requests ──────────────────────────────────────────────────────
-- collection_id NULL = scratch/draft (lives in a tab but isn't filed yet).
-- params/headers/body/auth are JSON blobs owned by the frontend; the Rust
-- layer doesn't introspect them.

CREATE TABLE api_requests (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    collection_id TEXT,
    name          TEXT NOT NULL,
    method        TEXT NOT NULL,
    url           TEXT NOT NULL,
    params_json   TEXT,
    headers_json  TEXT,
    body_json     TEXT,
    auth_json     TEXT,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (session_id)    REFERENCES sessions(id)        ON DELETE CASCADE,
    FOREIGN KEY (collection_id) REFERENCES api_collections(id) ON DELETE SET NULL
);

CREATE INDEX api_requests_session_idx    ON api_requests(session_id);
CREATE INDEX api_requests_collection_idx ON api_requests(collection_id);

-- ─── History (last N executed requests per session) ──────────────────────
-- request_snapshot_json captures the full HttpRequest as sent, so the user
-- can re-run a historical entry verbatim. response_excerpt holds at most
-- the first ~4 KiB of the response body for quick preview without bloating
-- the DB.

CREATE TABLE api_history (
    id                     TEXT PRIMARY KEY,
    session_id             TEXT NOT NULL,
    method                 TEXT NOT NULL,
    url                    TEXT NOT NULL,
    request_snapshot_json  TEXT NOT NULL,
    status                 INTEGER,
    time_ms                INTEGER,
    size_bytes             INTEGER,
    response_excerpt       TEXT,
    error                  TEXT,
    executed_at            INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX api_history_session_time_idx ON api_history(session_id, executed_at DESC);

-- ─── Environments (variable sets, one active per session) ────────────────

CREATE TABLE api_environments (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    vars_json   TEXT NOT NULL DEFAULT '{}',
    is_active   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX api_environments_session_idx ON api_environments(session_id);
