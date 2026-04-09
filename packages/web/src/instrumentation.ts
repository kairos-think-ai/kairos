/**
 * Next.js Instrumentation Hook
 *
 * Runs once when the server starts (on deploy, cold start).
 * Checks for pending database migrations and applies them automatically.
 *
 * This means:
 * - Deploying a new version with new migrations → they run automatically
 * - Self-hosting users just deploy → migrations apply on first start
 * - No manual curl, no setup scripts, no "run this SQL"
 */

export async function register() {
  // Only run on server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await runPendingMigrations();
  }
}

async function runPendingMigrations() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log('[Kairos Migrate] No Supabase credentials — skipping migrations');
    return;
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  // Check if exec_sql RPC exists (required for running migrations)
  try {
    const checkRes = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'SELECT 1' }),
    });

    if (!checkRes.ok) {
      const err = await checkRes.text();
      if (err.includes('Could not find the function')) {
        console.log('[Kairos Migrate] exec_sql RPC not found — run bootstrap SQL first');
        return;
      }
      console.log('[Kairos Migrate] exec_sql check failed:', err.slice(0, 200));
      return;
    }
  } catch (err) {
    console.log('[Kairos Migrate] Could not reach Supabase:', err);
    return;
  }

  // Ensure schema_migrations table exists
  await execSql(supabaseUrl, headers, `
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz DEFAULT now()
    )
  `);

  // Get already-applied migrations
  const appliedRes = await fetch(
    `${supabaseUrl}/rest/v1/schema_migrations?select=filename`,
    { headers },
  );
  const applied = appliedRes.ok ? await appliedRes.json() : [];
  const appliedSet = new Set((applied || []).map((r: any) => r.filename));

  // Run pending migrations
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.name)) continue;

    console.log(`[Kairos Migrate] Applying: ${migration.name}`);
    const result = await execSql(supabaseUrl, headers, migration.sql);

    if (!result.ok) {
      console.error(`[Kairos Migrate] FAILED: ${migration.name}`);
      break;
    }

    // Record as applied
    await fetch(`${supabaseUrl}/rest/v1/schema_migrations`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ filename: migration.name }),
    });

    console.log(`[Kairos Migrate] Applied: ${migration.name}`);
    count++;
  }

  if (count > 0) {
    console.log(`[Kairos Migrate] Done. Applied ${count} migration(s).`);
  }
}

async function execSql(
  supabaseUrl: string,
  headers: Record<string, string>,
  sql: string,
): Promise<{ ok: boolean }> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: sql }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

// ── Migrations (in order) ────────────────────────────────────────────
// Each migration is idempotent (IF NOT EXISTS / IF EXISTS).
// Add new migrations to the end of this array.

const MIGRATIONS = [
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
