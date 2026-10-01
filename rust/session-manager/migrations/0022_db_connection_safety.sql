-- How carefully the DB client treats a connection:
--   'normal'     — destructive statements (DROP, TRUNCATE, DELETE/UPDATE
--                  without WHERE) ask first.
--   'production' — every write asks first, and the client shows a warning bar.
--   'readonly'   — writes are refused before they reach the server.
ALTER TABLE db_connections ADD COLUMN safety TEXT NOT NULL DEFAULT 'normal';
