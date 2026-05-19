-- Per-conversation agent persona. NULL until set by the UI; an
-- application-level default (the "Chat Assistant" built-in) is assumed
-- when reading a NULL row.
ALTER TABLE chat_conversations ADD COLUMN agent_id TEXT;

-- Faster listing-by-recency for the sessions sidebar in the chat popover.
CREATE INDEX IF NOT EXISTS idx_chat_recent
    ON chat_conversations(last_message_at DESC);
