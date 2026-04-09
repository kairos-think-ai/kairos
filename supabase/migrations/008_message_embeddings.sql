-- Kairos Database Schema — Message-Level Embeddings
-- Migration: 008_message_embeddings
--
-- Adds embedding column to messages table for statistical analysis:
-- JSD drift detection, TextTiling change points, information entropy,
-- cognitive load estimation, and all Phase 3+ metrics.
--
-- Uses vector(1024) to match Voyage AI voyage-3 dimensions.

-- Add embedding column to messages
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- HNSW index for message similarity search
-- Only index non-null embeddings (most messages won't have embeddings initially)
CREATE INDEX IF NOT EXISTS idx_messages_embedding_hnsw
  ON public.messages
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- Index for efficient per-conversation embedding queries
CREATE INDEX IF NOT EXISTS idx_messages_conversation_embedding
  ON public.messages (conversation_id, sequence)
  WHERE embedding IS NOT NULL;
