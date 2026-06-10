-- Worktree-isolated agent runs. When a run is launched in isolation we spin
-- up a dedicated git worktree on a throwaway branch so the agent's edits never
-- touch the user's working tree until they've reviewed the diff. We record the
-- worktree path + branch on the run so the Agents view can offer "open diff",
-- "switch to worktree", and "discard" actions after the fact.
--
-- Both columns are nullable: in-place runs (the default) leave them NULL.

ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT;
ALTER TABLE agent_runs ADD COLUMN worktree_branch TEXT;
