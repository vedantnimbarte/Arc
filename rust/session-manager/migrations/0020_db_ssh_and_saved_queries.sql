-- SSH tunnels on database connections, and per-connection saved queries.
--
-- A connection with `ssh_host` set is reached through an SSH local forward:
-- the URL's host/port are as seen from the SSH server. Only the key *path* is
-- stored; its passphrase lives in the OS credential vault under service
-- "dev.arc.terminal.db", account "<db_connections.id>:ssh".

ALTER TABLE db_connections ADD COLUMN ssh_host TEXT;
ALTER TABLE db_connections ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE db_connections ADD COLUMN ssh_user TEXT;
ALTER TABLE db_connections ADD COLUMN ssh_key_path TEXT;

-- Named queries kept per connection. Deleted with their connection.
CREATE TABLE db_saved_queries (
    id             TEXT PRIMARY KEY,
    connection_id  TEXT NOT NULL REFERENCES db_connections(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    sql            TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_db_saved_queries_conn ON db_saved_queries(connection_id, name);
