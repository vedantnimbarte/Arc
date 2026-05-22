-- Pane layout — a serialized recursive tree describing how tabs are arranged
-- into split panes inside a session. Stored as a JSON blob so we can edit it
-- whole-replace (matches the pattern `save_tabs` already uses) and bump the
-- format independently from the table schema.
--
-- Shape: `{ "v": 1, "root": <PaneNode>, "focused_pane_id": <id> }` where
-- `PaneNode` is either `{ kind: "leaf", id, tab_ids: [...], active_tab_id }`
-- or `{ kind: "split", id, direction: "horizontal"|"vertical", children: [...], sizes: [...] }`.
--
-- NULL on existing rows — the frontend synthesizes a single-leaf layout from
-- the flat `tabs` table the first time it hydrates and writes it back.

ALTER TABLE sessions ADD COLUMN pane_layout TEXT;
