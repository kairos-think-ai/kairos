-- Kairos Database Schema — Analytics Levels + Privacy Architecture
-- Migration: 010_analytics_levels
--
-- Privacy: Rename mirror/analyst to Own/Trust/Shield
-- Level 1: Persist behavioral profile per conversation
-- Level 2: Entity stats (lazy-computed aggregates)
-- Level 3: Project stats + many-to-many conversation-project links
-- Level 4: Dual-timescale EMA trend state (Strava pattern)
-- Level 5: Conversation dimensions + user identity profile + identity cache

-- ============================================================
-- PRIVACY ARCHITECTURE: Own / Trust / Shield
-- ============================================================

-- Rename existing enum values
ALTER TYPE privacy_tier RENAME VALUE 'mirror' TO 'own';
ALTER TYPE privacy_tier RENAME VALUE 'analyst' TO 'trust';

-- Add Shield tier (enterprise: differential privacy, aggregate-only for managers)
ALTER TYPE privacy_tier ADD VALUE IF NOT EXISTS 'shield';

-- Per-conversation analysis consent
-- 'none' = not analyzed, 'structure_only' = Own tier (metadata only), 'full' = Trust/Shield tier
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS analysis_consent text DEFAULT 'none';

-- ============================================================
-- LEVEL 1: Behavioral Profile per Conversation
-- ============================================================

-- Persisted output of behavioral-signals.ts computeConversationProfile()
-- JSONB because the structure may evolve; read infrequently (aggregated at higher levels)
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS behavioral_profile jsonb DEFAULT NULL;

-- ============================================================
-- LEVEL 2: Entity Aggregated Stats
-- ============================================================

-- Lazy-computed aggregates: avg drift, entropy, cognitive load when discussing this entity
-- Recomputed when stale (>24h) or on weekly batch
ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS stats jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stats_updated_at timestamptz DEFAULT NULL;

-- ============================================================
-- LEVEL 3: Project Stats + Many-to-Many Links
-- ============================================================

-- Project-level aggregated stats
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS stats jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stats_updated_at timestamptz DEFAULT NULL;

-- Many-to-many: a conversation can belong to multiple projects
-- Replaces the current projects.conversation_ids JSONB array
CREATE TABLE IF NOT EXISTS public.conversation_projects (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  confidence float DEFAULT 1.0,         -- how confident we are in this assignment
  source text DEFAULT 'inferred',       -- 'platform' (from export), 'inferred' (LLM/entity overlap), 'manual' (user tagged)
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (conversation_id, project_id)
);

-- RLS for conversation_projects
ALTER TABLE public.conversation_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own conversation_projects" ON public.conversation_projects
  FOR ALL USING (
    conversation_id IN (SELECT id FROM public.conversations WHERE user_id = auth.uid())
  );

-- ============================================================
-- LEVEL 4: Dual-Timescale EMA Trend State
-- ============================================================

-- Single row per user, updated incrementally on each conversation analysis.
-- Short-term EMA (tau=7): responsive to recent changes
-- Long-term EMA (tau=42): stable baseline
-- The GAP between short and long IS the trend insight.
CREATE TABLE IF NOT EXISTS public.user_trend_state (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,

  -- Short-term EMAs (tau=7 conversations)
  ema_short_drift float DEFAULT 0,
  ema_short_question_density float DEFAULT 0,
  ema_short_conversation_depth float DEFAULT 0,
  ema_short_self_correction float DEFAULT 0,
  ema_short_msg_length float DEFAULT 0,
  ema_short_conversations_per_day float DEFAULT 0,

  -- Long-term EMAs (tau=42 conversations)
  ema_long_drift float DEFAULT 0,
  ema_long_question_density float DEFAULT 0,
  ema_long_conversation_depth float DEFAULT 0,
  ema_long_self_correction float DEFAULT 0,
  ema_long_msg_length float DEFAULT 0,
  ema_long_conversations_per_day float DEFAULT 0,

  last_updated_at timestamptz DEFAULT now(),
  total_conversations_incorporated integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_trend_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own trend state" ON public.user_trend_state
  FOR ALL USING (auth.uid() = user_id);

-- EMA update function: O(1) per conversation, no history replay needed
CREATE OR REPLACE FUNCTION public.update_trend_emas(
  p_user_id uuid,
  p_drift_score float,
  p_question_density float,
  p_conversation_depth float,
  p_self_correction float,
  p_avg_msg_length float
)
RETURNS void AS $$
DECLARE
  alpha_short float := 1.0 / 7.0;   -- tau=7
  alpha_long float := 1.0 / 42.0;   -- tau=42
BEGIN
  INSERT INTO public.user_trend_state (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.user_trend_state SET
    ema_short_drift = ema_short_drift + (p_drift_score - ema_short_drift) * alpha_short,
    ema_short_question_density = ema_short_question_density + (p_question_density - ema_short_question_density) * alpha_short,
    ema_short_conversation_depth = ema_short_conversation_depth + (p_conversation_depth - ema_short_conversation_depth) * alpha_short,
    ema_short_self_correction = ema_short_self_correction + (p_self_correction - ema_short_self_correction) * alpha_short,
    ema_short_msg_length = ema_short_msg_length + (p_avg_msg_length - ema_short_msg_length) * alpha_short,
    ema_short_conversations_per_day = ema_short_conversations_per_day + (1.0 - ema_short_conversations_per_day) * alpha_short,

    ema_long_drift = ema_long_drift + (p_drift_score - ema_long_drift) * alpha_long,
    ema_long_question_density = ema_long_question_density + (p_question_density - ema_long_question_density) * alpha_long,
    ema_long_conversation_depth = ema_long_conversation_depth + (p_conversation_depth - ema_long_conversation_depth) * alpha_long,
    ema_long_self_correction = ema_long_self_correction + (p_self_correction - ema_long_self_correction) * alpha_long,
    ema_long_msg_length = ema_long_msg_length + (p_avg_msg_length - ema_long_msg_length) * alpha_long,
    ema_long_conversations_per_day = ema_long_conversations_per_day + (1.0 - ema_long_conversations_per_day) * alpha_long,

    last_updated_at = now(),
    total_conversations_incorporated = total_conversations_incorporated + 1
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- LEVEL 5: Thinking Personality Dimensions + Identity Profile
-- ============================================================

-- Per-conversation dimensional scores (computed during analysis)
CREATE TABLE IF NOT EXISTS public.conversation_dimensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Five thinking dimensions (each 0-1)
  exploration_scope float,        -- 0 = depth-first, 1 = breadth-first
  structure_level float,          -- 0 = freeform, 1 = systematic
  challenge_orientation float,    -- 0 = accepting, 1 = interrogative
  abstraction_level float,        -- 0 = concrete, 1 = abstract
  delegation_style float,         -- 0 = directive, 1 = collaborative
  computed_at timestamptz DEFAULT now(),
  UNIQUE(conversation_id)
);

ALTER TABLE public.conversation_dimensions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own conversation dimensions" ON public.conversation_dimensions
  FOR ALL USING (auth.uid() = user_id);

-- User identity profile: EMA-maintained across conversations
-- Updated incrementally, not recomputed from scratch
CREATE TABLE IF NOT EXISTS public.user_identity_profile (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  -- EMA of each dimension
  exploration_scope_ema float DEFAULT 0.5,
  structure_level_ema float DEFAULT 0.5,
  challenge_orientation_ema float DEFAULT 0.5,
  abstraction_level_ema float DEFAULT 0.5,
  delegation_style_ema float DEFAULT 0.5,
  -- Tracking
  observation_count integer DEFAULT 0,
  -- Archetype (computed from dimension thresholds)
  archetype_name text,
  archetype_confidence float DEFAULT 0,
  -- Change detection
  last_change_point timestamptz,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.user_identity_profile ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own identity profile" ON public.user_identity_profile
  FOR ALL USING (auth.uid() = user_id);

-- Identity cache on users table (on-demand, 24h cache for Level 5 narratives)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS identity_cache jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS identity_cache_updated_at timestamptz DEFAULT NULL;

-- ============================================================
-- INDEXES
-- ============================================================

-- Level 3: conversation-project lookups
CREATE INDEX IF NOT EXISTS idx_conversation_projects_project
  ON public.conversation_projects(project_id);

-- Level 4: trend state (single row per user, primary key suffices)

-- Level 5: conversation dimensions per user
CREATE INDEX IF NOT EXISTS idx_conversation_dimensions_user
  ON public.conversation_dimensions(user_id, computed_at DESC);
