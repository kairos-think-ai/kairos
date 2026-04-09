-- Kairos Database Schema — Fix Embedding Dimension
-- Migration: 003_fix_embedding_dimension
--
-- Fixes ideas.embedding column dimension from vector(1536) to vector(1024)
-- to match Voyage AI voyage-3 output dimensions.
--
-- Safe to run: no embeddings have been generated yet (Voyage AI not implemented),
-- so no data loss occurs.

-- Change embedding dimension from 1536 (OpenAI default) to 1024 (Voyage AI voyage-3)
ALTER TABLE public.ideas ALTER COLUMN embedding TYPE vector(1024);
