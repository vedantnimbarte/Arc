-- Phase 2 persistence schema (V0).
--
-- Timestamps are unix-epoch milliseconds (i64) to match JS Date.now().
-- Foreign keys are enabled per-connection in code (sqlx-sqlite doesn't run
-- PRAGMA foreign_keys = ON automatically).

CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    root            TEXT NOT NULL UNIQUE,
    created_at      INTEGER NOT NULL,
    last_opened_at  INTEGER NOT NULL
);

-- One row per ARC instance/window. The frontend uses the single most-recent
-- session for V0; multi-window sessions are a later concern.
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT,
    active_tab_id   TEXT,
    created_at      INTEGER NOT NULL,
    last_active_at  INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);
CREATE INDEX idx_sessions_active ON sessions(last_active_at DESC);

CREATE TABLE tabs (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('terminal', 'editor')),
    file_path   TEXT,
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_tabs_session ON tabs(session_id, position);

-- Placeholders for later phases. Tables exist so migrations stay coherent;
-- repository code lands when the matching feature is built.

CREATE TABLE command_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT,
    tab_id          TEXT,
    workspace_id    TEXT,
    cwd             TEXT,
    command         TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    exit_code       INTEGER,
    output_excerpt  TEXT,
    FOREIGN KEY (session_id)   REFERENCES sessions(id)   ON DELETE SET NULL,
    FOREIGN KEY (tab_id)       REFERENCES tabs(id)       ON DELETE SET NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);
CREATE INDEX idx_cmd_session_time   ON command_history(session_id, started_at);
CREATE INDEX idx_cmd_workspace_time ON command_history(workspace_id, started_at);

CREATE TABLE chat_conversations (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT,
    title            TEXT,
    created_at       INTEGER NOT NULL,
    last_message_at  INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX idx_chat_workspace ON chat_conversations(workspace_id, last_message_at DESC);

CREATE TABLE chat_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);
CREATE INDEX idx_msg_conv_time ON chat_messages(conversation_id, created_at);

CREATE TABLE agent_runs (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT,
    agent_id      TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'completed', 'failed')),
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    summary       TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);
CREATE INDEX idx_agent_workspace ON agent_runs(workspace_id, started_at DESC);
