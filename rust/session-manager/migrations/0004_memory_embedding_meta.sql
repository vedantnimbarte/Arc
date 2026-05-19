-- Memory vector search (V1). The embedding BLOB column has been on the
-- table since 0003; what was missing is *which model* produced it. Add
-- a model id and the vector's dimensionality so vector_search can filter
-- to rows it can actually compare against, and so we can spot stale
-- embeddings if the user later switches models.

ALTER TABLE memory_entries ADD COLUMN embedding_model TEXT;
ALTER TABLE memory_entries ADD COLUMN embedding_dim   INTEGER;

-- Lets vector_search prune the candidate set quickly on big workspaces.
CREATE INDEX IF NOT EXISTS idx_memory_embedding_model
    ON memory_entries(embedding_model)
    WHERE embedding IS NOT NULL;
