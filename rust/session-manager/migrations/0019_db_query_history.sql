-- Per-connection query history for the DB client tab: every statement run
-- from the editor, with its timing and outcome. The per-connection cap is
-- enforced by the repository (`db::history_add` prunes the oldest), not here.
-- Rows are deleted with their connection.

CREATE TABLE db_query_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id  TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
    sql            TEXT NOT NULL,
    executed_at    INTEGER NOT NULL,
    duration_ms    INTEGER NOT NULL,
    -- Rows returned, or rows affected for a statement with no result set.
    -- NULL when the statement failed.
    row_count      INTEGER,
    -- NULL on success.
    error          TEXT
);

CREATE INDEX idx_db_query_history_conn ON db_query_history(connection_id, id DESC);
