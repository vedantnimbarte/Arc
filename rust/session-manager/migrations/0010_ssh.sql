-- SSH hosts, keys, and session logs.
--
-- Private-key material never lives in this DB — only the *path* to the
-- key on disk. Passphrases live in the OS credential vault under the
-- service name "dev.arc.terminal.ssh", account = ssh_keys.id.

CREATE TABLE ssh_keys (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    path            TEXT NOT NULL UNIQUE,
    kind            TEXT NOT NULL,            -- 'ed25519' | 'ssh-rsa' | etc
    fingerprint     TEXT NOT NULL,            -- "SHA256:..." form
    has_passphrase  INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

CREATE TABLE ssh_hosts (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT,
    name            TEXT NOT NULL,
    host            TEXT NOT NULL,
    port            INTEGER NOT NULL DEFAULT 22,
    username        TEXT NOT NULL,
    identity_id     TEXT,
    keepalive_secs  INTEGER NOT NULL DEFAULT 30,
    startup_cmd     TEXT,
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL,
    FOREIGN KEY (identity_id)  REFERENCES ssh_keys(id)   ON DELETE SET NULL
);

CREATE INDEX idx_ssh_hosts_workspace ON ssh_hosts(workspace_id);
CREATE INDEX idx_ssh_hosts_last_used ON ssh_hosts(last_used_at DESC);

CREATE TABLE ssh_session_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id         TEXT NOT NULL,
    session_uuid    TEXT NOT NULL,
    at              INTEGER NOT NULL,
    level           TEXT NOT NULL,
    msg             TEXT NOT NULL,
    FOREIGN KEY (host_id) REFERENCES ssh_hosts(id) ON DELETE CASCADE
);

CREATE INDEX idx_ssh_logs_session ON ssh_session_logs(session_uuid, at);
CREATE INDEX idx_ssh_logs_host    ON ssh_session_logs(host_id,      at DESC);

-- Widen the tabs.kind CHECK constraint to allow 'ssh'. Same rebuild
-- pattern as 0009_sysmonitor.sql / 0008_apiclient.sql — SQLite can't
-- ALTER a CHECK in place.

PRAGMA foreign_keys = OFF;

CREATE TABLE tabs_new (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL,
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('terminal', 'editor', 'preview', 'apiclient', 'sysmonitor', 'ssh')),
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
