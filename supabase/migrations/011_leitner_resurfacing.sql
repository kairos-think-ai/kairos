-- Kairos Database Schema — Modified Leitner Resurfacing
-- Migration: 011_leitner_resurfacing
--
-- EXPERIMENTAL: Box intervals (1, 3, 7, 14, 30, 90 days) are classic Leitner,
-- designed for flashcard memorization. Not validated for idea resurfacing.
-- Future: replace with contextual bandits that learn optimal intervals from engagement data.
-- See KNOWN-HEURISTICS.md #13 for validation plan.
--
-- Replaces SM-2 with Modified Leitner box system.
-- 7 boxes: daily(1), 3-day(2), weekly(3), biweekly(4), monthly(5), quarterly(6), archive(7)
--
-- Key differences from SM-2:
-- - Engage: move up 1 box (not exponential interval growth)
-- - Dismiss: move down 1 box (not back to box 1)
-- - Act: jump to box 5 directly (validated idea)
-- - Ignore 3x in same box: move down 1 box
-- - Box 1 + dismiss: move to archive (can be manually retrieved)

-- Add box field to idea_resurfacing
ALTER TABLE public.idea_resurfacing
  ADD COLUMN IF NOT EXISTS box integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ignore_count integer DEFAULT 0;

-- Box intervals (days)
-- Box 1: 1 day, Box 2: 3 days, Box 3: 7 days, Box 4: 14 days,
-- Box 5: 30 days, Box 6: 90 days, Box 7: archive (inactive)

-- Replace the SM-2 engagement function with Leitner
CREATE OR REPLACE FUNCTION public.update_resurfacing_after_engagement(
  p_resurfacing_id uuid,
  p_engagement_type text  -- 'click', 'revisit', 'dismiss', 'act', 'ignore'
)
RETURNS void AS $$
DECLARE
  current_box integer;
  new_box integer;
  new_interval integer;
  box_intervals integer[] := ARRAY[1, 3, 7, 14, 30, 90, 365];
  current_ignore_count integer;
BEGIN
  SELECT box, ignore_count
  INTO current_box, current_ignore_count
  FROM public.idea_resurfacing
  WHERE id = p_resurfacing_id;

  IF NOT FOUND THEN RETURN; END IF;

  new_box := current_box;

  CASE p_engagement_type
    WHEN 'click', 'revisit' THEN
      -- Move up 1 box (min box 1, max box 6)
      new_box := LEAST(6, current_box + 1);

    WHEN 'act' THEN
      -- Validated idea — jump to box 5
      new_box := 5;

    WHEN 'dismiss' THEN
      IF current_box <= 1 THEN
        -- Already in box 1, dismiss = archive
        new_box := 7;
      ELSE
        -- Move down 1 box
        new_box := current_box - 1;
      END IF;

    WHEN 'ignore' THEN
      -- Stay in current box, increment ignore count
      -- If ignored 3x in same box, move down
      IF current_ignore_count >= 2 THEN
        new_box := GREATEST(1, current_box - 1);
        -- Reset ignore count after demotion
        current_ignore_count := -1; -- will be incremented to 0 below
      END IF;

    ELSE
      -- Unknown engagement type, no change
      NULL;
  END CASE;

  new_interval := box_intervals[LEAST(new_box, 7)];

  UPDATE public.idea_resurfacing
  SET
    box = new_box,
    interval_days = new_interval,
    next_surface_at = now() + (new_interval || ' days')::interval,
    times_surfaced = times_surfaced + 1,
    last_engagement = p_engagement_type,
    last_engagement_at = now(),
    ignore_count = CASE
      WHEN p_engagement_type = 'ignore' THEN current_ignore_count + 1
      ELSE 0  -- Reset on any non-ignore engagement
    END,
    is_active = (new_box < 7)  -- Box 7 = archived
  WHERE id = p_resurfacing_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop and recreate get_due_ideas with box column
DROP FUNCTION IF EXISTS public.get_due_ideas(uuid, integer);
CREATE OR REPLACE FUNCTION public.get_due_ideas(p_user_id uuid, max_count integer DEFAULT 3)
RETURNS TABLE(
  idea_id uuid,
  summary text,
  category text,
  importance_score float,
  interval_days integer,
  times_surfaced integer,
  enrollment_reason text,
  box integer
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ir.idea_id,
    i.summary,
    i.category,
    i.importance_score,
    ir.interval_days,
    ir.times_surfaced,
    ir.enrollment_reason,
    ir.box
  FROM public.idea_resurfacing ir
  JOIN public.ideas i ON i.id = ir.idea_id
  WHERE ir.user_id = p_user_id
    AND ir.is_active = true
    AND ir.next_surface_at <= now()
  ORDER BY ir.box ASC, i.importance_score DESC, ir.next_surface_at ASC
  LIMIT max_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
