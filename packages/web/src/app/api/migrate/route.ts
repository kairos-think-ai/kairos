import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * POST /api/migrate
 *
 * Runs pending database migrations.
 * Protected by CRON_SECRET to prevent unauthorized access.
 * Called automatically on deploy via Vercel build, or manually.
 *
 * Migrations are stored as SQL strings in this file (not read from disk)
 * because Vercel serverless functions don't have access to the
 * supabase/migrations/ directory at runtime.
 */

// All migrations in order. Each runs idempotently (IF NOT EXISTS / IF EXISTS).
const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '014_fix_schema_migrations_rls.sql',
    sql: `
      ALTER TABLE IF EXISTS public.schema_migrations ENABLE ROW LEVEL SECURITY;
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE tablename = 'schema_migrations' AND policyname = 'Service role only'
        ) THEN
          CREATE POLICY "Service role only" ON public.schema_migrations
            FOR ALL USING (auth.role() = 'service_role');
        END IF;
      END $$;
    `,
  },
];

export async function POST(req: Request) {
  // Auth: require CRON_SECRET or service role
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const results: Array<{ name: string; status: string; error?: string }> = [];

  for (const migration of MIGRATIONS) {
    try {
      // Check if already applied
      const { data: existing } = await supabase
        .from('schema_migrations')
        .select('filename')
        .eq('filename', migration.name)
        .maybeSingle();

      if (existing) {
        results.push({ name: migration.name, status: 'skipped' });
        continue;
      }

      // Run migration via RPC
      const { error } = await supabase.rpc('exec_sql', { query: migration.sql });

      if (error) {
        results.push({ name: migration.name, status: 'failed', error: error.message });
        break; // Stop on failure
      }

      // Record as applied
      await supabase.from('schema_migrations').insert({ filename: migration.name });
      results.push({ name: migration.name, status: 'applied' });
    } catch (err) {
      results.push({ name: migration.name, status: 'failed', error: String(err) });
      break;
    }
  }

  return NextResponse.json({ migrations: results });
}
