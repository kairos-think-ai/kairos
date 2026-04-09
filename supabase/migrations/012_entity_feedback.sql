-- Kairos Database Schema — Entity Confidence Feedback
-- Migration: 012_entity_feedback
--
-- When a user engages with or dismisses a resurfaced idea,
-- propagate the signal to related entities (asymmetric):
-- - Dismiss: slow negative signal to entity confidence (lr=0.05)
-- - Engage/Act: faster positive signal (lr=0.10)
-- This prevents premature entity demotion while rewarding genuine interest.

CREATE OR REPLACE FUNCTION public.propagate_engagement_to_entities(
  p_idea_id uuid,
  p_engagement_type text  -- 'click', 'revisit', 'dismiss', 'act', 'ignore'
)
RETURNS void AS $$
DECLARE
  signal float;
  lr float;
  entity_record RECORD;
BEGIN
  -- Determine signal strength and learning rate
  CASE p_engagement_type
    WHEN 'act' THEN signal := 1.0; lr := 0.10;
    WHEN 'revisit' THEN signal := 0.7; lr := 0.10;
    WHEN 'click' THEN signal := 0.5; lr := 0.08;
    WHEN 'dismiss' THEN signal := -0.5; lr := 0.05;  -- Slower negative propagation
    WHEN 'ignore' THEN signal := -0.2; lr := 0.03;   -- Very weak negative
    ELSE RETURN;
  END CASE;

  -- Find entities related to this idea via entity_mentions on the same conversation
  FOR entity_record IN
    SELECT DISTINCT e.id, e.confidence
    FROM public.entities e
    JOIN public.entity_mentions em ON em.entity_id = e.id
    JOIN public.ideas i ON i.conversation_id = em.conversation_id
    WHERE i.id = p_idea_id
      AND e.status != 'archived'
  LOOP
    -- Update entity confidence: EMA-style update
    UPDATE public.entities
    SET confidence = GREATEST(0.05, LEAST(1.0,
      entity_record.confidence + lr * (signal - entity_record.confidence * 0.1)
    ))
    WHERE id = entity_record.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
