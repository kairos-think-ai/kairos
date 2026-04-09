-- Fix decay_connection_strengths function
-- Bug: used is_distinct_from() as a function call instead of IS DISTINCT FROM operator

CREATE OR REPLACE FUNCTION public.decay_connection_strengths()
RETURNS void AS $$
BEGIN
  UPDATE public.conversation_connections
  SET strength = greatest(
    0.01,
    strength * exp(-decay_rate * extract(epoch from (now() - coalesce(last_accessed_at, discovered_at))) / 86400)
  )
  WHERE strength IS DISTINCT FROM greatest(
    0.01,
    strength * exp(-decay_rate * extract(epoch from (now() - coalesce(last_accessed_at, discovered_at))) / 86400)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
