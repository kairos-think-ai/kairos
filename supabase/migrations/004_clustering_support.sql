-- Kairos Database Schema — Clustering Support
-- Migration: 004_clustering_support
--
-- Adds HNSW index for vector similarity search (better than IVFFlat for <10K vectors)
-- and find_nearest_cluster() function for real-time cluster assignment.

-- HNSW index for cosine similarity search on idea embeddings
-- No training data needed (unlike IVFFlat), works well for small datasets.
CREATE INDEX IF NOT EXISTS idx_ideas_embedding_hnsw
ON public.ideas
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Function: find nearest cluster for a given embedding
-- Used by quickAssignClusters() for real-time cluster assignment.
-- Returns the cluster with the closest member idea (by cosine distance).
CREATE OR REPLACE FUNCTION public.find_nearest_cluster(
  p_user_id uuid,
  p_embedding vector(1024),
  p_threshold float DEFAULT 0.20  -- cosine distance threshold (1 - similarity)
)
RETURNS TABLE(
  cluster_id uuid,
  distance float,
  idea_count integer
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    icm.cluster_id,
    MIN(i.embedding <=> p_embedding)::float as distance,
    ic.idea_count
  FROM public.idea_cluster_members icm
  JOIN public.ideas i ON i.id = icm.idea_id
  JOIN public.idea_clusters ic ON ic.id = icm.cluster_id
  WHERE ic.user_id = p_user_id
    AND i.embedding IS NOT NULL
  GROUP BY icm.cluster_id, ic.idea_count
  HAVING MIN(i.embedding <=> p_embedding) < p_threshold
  ORDER BY distance ASC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Index for session detection: efficiently find conversations in a time window
CREATE INDEX IF NOT EXISTS idx_conversations_user_started
ON public.conversations(user_id, started_at DESC);
