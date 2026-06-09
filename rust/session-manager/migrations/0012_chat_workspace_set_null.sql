-- chat_conversations.workspace_id was ON DELETE CASCADE, so removing a
-- workspace from the list silently destroyed all its conversations and (via
-- the chat_messages cascade) every message — a surprising, irreversible data
-- loss for a routine cleanup action. command_history, sessions, and
-- agent_runs all use ON DELETE SET NULL; bring chat into line by rebuilding
-- the table with SET NULL (SQLite can't alter an FK in place).
--
-- chat_messages keeps its ON DELETE CASCADE onto chat_conversations(id) —
-- deleting a conversation should still delete its messages. Row ids are
-- preserved, so that relationship stays intact across the rebuild.

PRAGMA foreign_keys = OFF;

CREATE TABLE chat_conversations_new (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT,
    title            TEXT,
    created_at       INTEGER NOT NULL,
    last_message_at  INTEGER NOT NULL,
    agent_id         TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

INSERT INTO chat_conversations_new (id, workspace_id, title, created_at, last_message_at, agent_id)
SELECT id, workspace_id, title, created_at, last_message_at, agent_id FROM chat_conversations;

DROP TABLE chat_conversations;
ALTER TABLE chat_conversations_new RENAME TO chat_conversations;

CREATE INDEX idx_chat_workspace ON chat_conversations(workspace_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_recent ON chat_conversations(last_message_at DESC);

PRAGMA foreign_keys = ON;
