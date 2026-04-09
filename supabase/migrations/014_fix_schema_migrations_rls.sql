-- Fix: Enable RLS on schema_migrations table
-- This table is used by the MCP migration runner and should not be publicly accessible.

ALTER TABLE IF EXISTS public.schema_migrations ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write migrations
CREATE POLICY "Service role only" ON public.schema_migrations
  FOR ALL USING (auth.role() = 'service_role');
