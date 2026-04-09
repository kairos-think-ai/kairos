/**
 * kairos_profile — Compile user's thinking profile for system prompt injection.
 *
 * Layer 1 of the coaching architecture. Called by:
 *   - SessionStart hook (Claude Code — auto-injected)
 *   - MCP Prompt (Claude.ai — one-click)
 *   - Kairos SDK (API — auto-injected)
 *
 * Reads from existing DB tables. Calls no external APIs.
 * Returns formatted text suitable for system prompt injection.
 */

import { from, rpc } from "../db.js";

export async function handleProfile() {
  try {
    const sections: string[] = [];

    // ── 1. Engagement metrics (from classified conversations) ──────

    const { data: engagedConvos } = await from("conversations")
      .select("engagement_profile, started_at")
      .neq("engagement_profile", "null")
      .order("started_at", { ascending: false })
      .limit(100);

    const profiles = (engagedConvos || [])
      .map((c: any) => c.engagement_profile)
      .filter(Boolean);

    if (profiles.length > 0) {
      const avg = (key: string) => {
        const vals = profiles.map((p: any) => p[key] || 0);
        return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
      };

      const verificationRate = avg("verificationRate");
      const generationRatio = avg("generationRatio");
      const passiveAcceptanceRate = avg("passiveAcceptanceRate");

      // State distribution
      const states = ["DEEP_ENGAGEMENT", "PASSIVE_ACCEPTANCE", "VERIFICATION", "PROMPT_CRAFTING", "REDIRECTING", "DEFERRED"];
      const avgDist: Record<string, number> = {};
      for (const s of states) {
        const vals = profiles.map((p: any) => p.stateDistribution?.[s] || 0);
        avgDist[s] = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
      }

      const lines: string[] = [
        "### How they think",
        `- Generates own ideas ${(generationRatio * 100).toFixed(0)}% of the time${generationRatio > 0.5 ? " — ask what they think before explaining" : ""}`,
        `- Verifies AI claims ${(verificationRate * 100).toFixed(0)}% of the time${verificationRate < 0.2 ? " — show reasoning proactively" : ""}`,
        `- Passively accepts ${(passiveAcceptanceRate * 100).toFixed(0)}% of the time${passiveAcceptanceRate > 0.3 ? " — invite evaluation before proceeding" : ""}`,
      ];

      // Drift stats
      const { data: drifts } = await from("drift_reports")
        .select("drift_score")
        .order("created_at", { ascending: false })
        .limit(50);

      if (drifts && drifts.length > 0) {
        const avgDrift = drifts.reduce((sum: number, d: any) => sum + d.drift_score, 0) / drifts.length;
        lines.push(`- Drifts from intent ${(avgDrift * 100).toFixed(0)}% of the time${avgDrift > 0.4 ? " — check alignment every 5-6 turns" : ""}`);
      }

      // Dominant engagement pattern
      const dominantState = Object.entries(avgDist).sort((a, b) => b[1] - a[1])[0];
      lines.push(`- Dominant engagement: ${dominantState[0].replace(/_/g, " ").toLowerCase()} (${(dominantState[1] * 100).toFixed(0)}%)`);
      lines.push(`- Based on ${profiles.length} classified conversations`);

      sections.push(lines.join("\n"));
    }

    // ── 2. Top concepts (expertise areas) ──────────────────────────

    const { data: entities } = await from("entities")
      .select("name, type, importance_score, document_frequency")
      .neq("status", "archived")
      .order("importance_score", { ascending: false })
      .limit(20);

    if (entities && entities.length > 0) {
      // Group by frequency to identify deep expertise vs casual mentions
      const deep = entities.filter((e: any) => e.document_frequency >= 3);
      const emerging = entities.filter((e: any) => e.document_frequency >= 1 && e.document_frequency < 3);

      const lines: string[] = ["### Their world"];

      if (deep.length > 0) {
        lines.push(`- Deep expertise: ${deep.slice(0, 8).map((e: any) => e.name).join(", ")}`);
      }
      if (emerging.length > 0) {
        lines.push(`- Exploring: ${emerging.slice(0, 6).map((e: any) => e.name).join(", ")}`);
      }

      sections.push(lines.join("\n"));
    }

    // ── 3. Active projects ─────────────────────────────────────────

    const { data: projects } = await from("projects")
      .select("name, status")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(5);

    if (projects && projects.length > 0) {
      sections.push(
        `- Active projects: ${projects.map((p: any) => p.name).join(", ")}`
      );
    }

    // ── 4. Ideas to resurface ──────────────────────────────────────

    try {
      const { data: dueIdeas } = await rpc("get_due_ideas", {
        p_user_id: await getUserId(),
        max_count: 3,
      });

      if (dueIdeas && dueIdeas.length > 0) {
        const lines = ["### Ideas to resurface"];
        for (const idea of dueIdeas.slice(0, 3)) {
          lines.push(`- "${idea.summary}" (${idea.category}, importance: ${(idea.importance_score || 0).toFixed(1)})`);
        }
        sections.push(lines.join("\n"));
      }
    } catch {
      // Resurfacing not set up — skip silently
    }

    // ── 5. Coaching insights ───────────────────────────────────────

    const { data: insights } = await from("coaching_insights")
      .select("observation, experiment, category")
      .order("created_at", { ascending: false })
      .limit(2);

    if (insights && insights.length > 0) {
      const lines = ["### Recent coaching"];
      for (const i of insights) {
        lines.push(`- ${i.observation}${i.experiment ? ` Try: ${i.experiment}` : ""}`);
      }
      sections.push(lines.join("\n"));
    }

    // ── 6. Behavioral fingerprint ──────────────────────────────────

    const { data: behavioralProfiles } = await from("behavioral_profile")
      .select("peak_hour, avg_session_duration_minutes")
      .order("date", { ascending: false })
      .limit(7);

    if (behavioralProfiles && behavioralProfiles.length > 0) {
      const peakHours = behavioralProfiles.map((p: any) => p.peak_hour).filter(Boolean);
      if (peakHours.length > 0) {
        const freq: Record<number, number> = {};
        for (const h of peakHours) freq[h] = (freq[h] || 0) + 1;
        const peak = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
        sections.push(`- Peak thinking hour: ${peak}:00`);
      }
    }

    // ── Compile ────────────────────────────────────────────────────

    if (sections.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "## Kairos Thinking Profile\n\nNo data yet. Import conversations to build your thinking profile.",
        }],
      };
    }

    const profile = [
      "## About this user (Kairos Thinking Profile)",
      "",
      ...sections,
      "",
      "### Available tools",
      "- kairos_coach: Analyze current conversation engagement + provide coaching",
      "- kairos_recall: Find related past conversations and ideas by topic",
      "- kairos_reflect: View detailed behavioral patterns and metrics",
      "- kairos_resurface: Get ideas due for spaced repetition review",
      "- kairos_connections: Explore how concepts connect across conversations",
    ].join("\n");

    return {
      content: [{ type: "text" as const, text: profile }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Profile generation failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function getUserId(): Promise<string> {
  // Use env var if available, otherwise query the first user
  if (process.env.KAIROS_USER_ID) return process.env.KAIROS_USER_ID;

  const { data: users } = await from("users")
    .select("id")
    .limit(1);

  if (users && users.length > 0) return users[0].id;
  throw new Error("No user found");
}
