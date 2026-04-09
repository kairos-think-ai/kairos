-- Kairos Database Schema — Entity Confidence Scoring
-- Migration: 009_entity_confidence
--
-- Adds confidence scoring fields to entities for signal/noise filtering:
-- - importance_score: computed TF-IDF/BM25 cross-conversation importance
-- - confidence: Bayesian confidence (Beta distribution mean)
-- - status: active/archived/dormant based on confidence thresholds
-- - document_frequency: number of distinct conversations mentioning this entity

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS importance_score float DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence float DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS document_frequency integer DEFAULT 0;

-- Index for filtering by status and importance
CREATE INDEX IF NOT EXISTS idx_entities_status_importance
  ON public.entities (user_id, status, importance_score DESC)
  WHERE status = 'active';
