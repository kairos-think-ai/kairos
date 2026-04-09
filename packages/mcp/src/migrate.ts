/**
 * Auto-migration runner for Kairos MCP server.
 *
 * On startup (if KAIROS_RUN_MIGRATIONS=true):
 * 1. Checks if exec_sql RPC exists (bootstrap requirement)
 * 2. Creates schema_migrations tracking table if needed
 * 3. Reads all .sql files from supabase/migrations/
 * 4. Runs unapplied ones in order, wrapped in transactions
 * 5. Uses advisory lock to prevent concurrent runs
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { rpc, from } from "./db.js";

const MIGRATIONS_DIR = resolve(import.meta.dirname || ".", "../../..", "supabase/migrations");
const ADVISORY_LOCK_ID = 8675309; // arbitrary but consistent

interface MigrationResult {
  applied: string[];
  skipped: string[];
  failed: { file: string; error: string } | null;
}

export async function runMigrations(): Promise<MigrationResult> {
  if (process.env.KAIROS_RUN_MIGRATIONS !== "true") {
    return { applied: [], skipped: [], failed: null };
  }

  console.error("[Kairos Migrate] Starting migration check...");

  // Step 1: Check if exec_sql RPC exists
  const execCheck = await rpc("exec_sql", { query: "SELECT 1" });
  if (execCheck.error) {
    if (execCheck.error.message.includes("Could not find the function")) {
      console.error(
        "[Kairos Migrate] exec_sql RPC not found. Run this ONE TIME in Supabase SQL Editor:\n\n" +
        "  CREATE OR REPLACE FUNCTION public.exec_sql(query text)\n" +
        "  RETURNS void AS $$\n" +
        "  BEGIN\n" +
        "    EXECUTE query;\n" +
        "  END;\n" +
        "  $$ LANGUAGE plpgsql SECURITY DEFINER;\n"
      );
      return { applied: [], skipped: [], failed: { file: "bootstrap", error: "exec_sql RPC not found" } };
    }
    console.error("[Kairos Migrate] exec_sql check failed:", execCheck.error.message);
    return { applied: [], skipped: [], failed: { file: "bootstrap", error: execCheck.error.message } };
  }

  // Step 2: Acquire advisory lock (prevents concurrent migration runs)
  const lockResult = await rpc("exec_sql", {
    query: `SELECT pg_advisory_lock(${ADVISORY_LOCK_ID})`,
  });
  if (lockResult.error) {
    console.error("[Kairos Migrate] Could not acquire advisory lock:", lockResult.error.message);
    return { applied: [], skipped: [], failed: { file: "lock", error: lockResult.error.message } };
  }

  try {
    // Step 3: Create schema_migrations table if it doesn't exist
    await rpc("exec_sql", {
      query: `
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          filename text PRIMARY KEY,
          applied_at timestamptz DEFAULT now()
        )
      `,
    });

    // Step 4: Get already-applied migrations
    const { data: applied } = await from("schema_migrations")
      .select("filename");
    const appliedSet = new Set((applied || []).map((r: any) => r.filename));

    // Step 5: Read migration files from disk
    let files: string[];
    try {
      files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort(); // lexicographic = correct order (001_, 002_, etc.)
    } catch {
      console.error(`[Kairos Migrate] Could not read migrations dir: ${MIGRATIONS_DIR}`);
      return { applied: [], skipped: [], failed: { file: "readdir", error: `Dir not found: ${MIGRATIONS_DIR}` } };
    }

    const result: MigrationResult = { applied: [], skipped: [], failed: null };

    // Step 6: Run unapplied migrations in order
    for (const file of files) {
      if (appliedSet.has(file)) {
        result.skipped.push(file);
        continue;
      }

      console.error(`[Kairos Migrate] Applying: ${file}`);
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");

      // Run migration SQL (Supabase RPC runs in an implicit transaction)
      const migrationResult = await rpc("exec_sql", { query: sql });

      if (migrationResult.error) {
        console.error(`[Kairos Migrate] FAILED: ${file} — ${migrationResult.error.message}`);
        result.failed = { file, error: migrationResult.error.message };
        break; // Stop on first failure — don't skip ahead
      }

      // Record as applied (separate call — if this fails, migration re-runs next time which is safe due to IF NOT EXISTS)
      const recordResult = await rpc("exec_sql", {
        query: `INSERT INTO public.schema_migrations (filename) VALUES ('${file.replace(/'/g, "''")}')`,
      });

      result.applied.push(file);
      console.error(`[Kairos Migrate] Applied: ${file}`);
    }

    if (result.applied.length > 0) {
      console.error(`[Kairos Migrate] Done. Applied ${result.applied.length}, skipped ${result.skipped.length}.`);
    } else if (!result.failed) {
      console.error(`[Kairos Migrate] Up to date. ${result.skipped.length} migrations already applied.`);
    }

    return result;
  } finally {
    // Always release advisory lock
    await rpc("exec_sql", {
      query: `SELECT pg_advisory_unlock(${ADVISORY_LOCK_ID})`,
    }).catch(() => {});
  }
}
