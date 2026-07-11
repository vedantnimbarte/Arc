-- Drop the AI feature tables (chat, coding agent, memory). In-app AI was
-- removed; these tables are no longer written or read. Forward-only cleanup —
-- migrations 0001–0013 stay untouched so existing DBs keep their checksums.
DROP TRIGGER IF EXISTS memory_entries_ai;
DROP TRIGGER IF EXISTS memory_entries_ad;
DROP TRIGGER IF EXISTS memory_entries_au;
DROP TABLE IF EXISTS memory_fts;
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_conversations;
DROP TABLE IF EXISTS agent_runs;
