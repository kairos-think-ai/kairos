-- Kairos Database Schema — Turn-Level Engagement Classification
-- Migration: 013_engagement_classification
--
-- Stores per-turn cognitive engagement state classifications.
-- Taxonomy adapted from Mozannar et al. CUPS (CHI 2024):
--   DEEP_ENGAGEMENT, PASSIVE_ACCEPTANCE, VERIFICATION,
--   PROMPT_CRAFTING, REDIRECTING, DEFERRED
--
-- Classification method: LLM with CoT (adapted from FastChat llm_judge, NeurIPS 2023)
-- with structural pre-classification for obvious cases.

-- Per-turn engagement classification
CREATE TABLE IF NOT EXISTS public.turn_engagement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Classification
  state text NOT NULL,  -- DEEP_ENGAGEMENT, PASSIVE_ACCEPTANCE, VERIFICATION, PROMPT_CRAFTING, REDIRECTING, DEFERRED
  confidence float DEFAULT 1.0,  -- 1.0 for structural, LLM-reported for ambiguous
  classification_method text DEFAULT 'structural',  -- 'structural' or 'llm'

  -- LLM reasoning (only for llm-classified turns)
  reasoning text,  -- CoT explanation from the LLM judge

  -- Metadata
  sequence integer NOT NULL,  -- turn position in conversation
  computed_at timestamptz DEFAULT now(),

  UNIQUE(message_id)
);

ALTER TABLE public.turn_engagement ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own turn engagement" ON public.turn_engagement
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_turn_engagement_conversation
  ON public.turn_engagement(conversation_id, sequence);

-- Per-conversation engagement profile (aggregated from turn_engagement)
-- Stored as JSONB on conversations table for fast retrieval
-- Structure: { stateDistribution: {DEEP_ENGAGEMENT: 0.3, ...}, transitionMatrix: {...}, metrics: {...} }
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS engagement_profile jsonb DEFAULT NULL;
