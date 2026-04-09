/**
 * kairos_reflect — Behavioral signals + coaching insights.
 *
 * Returns attention patterns and coaching using the OIE framework.
 * Works on metadata at Mirror tier — no conversation content needed.
 */

import { from } from "../db.js";

export async function handleReflect(period: string, focus: string) {
  try {
    const now = new Date();
    const periodStart = getPeriodStart(period, now);

    const sections: string[] = [];

    // Attention patterns
    if (focus === "all" || focus === "attention") {
      const { data: profiles } = await from("behavioral_profile")
        .select("*")
        .gte("date", periodStart.toISOString().split("T")[0])
        .order("date", { ascending: false });

      if (profiles && profiles.length > 0) {
        const avgFragmentation = profiles.reduce((sum, p) => sum + (p.fragmentation_score || 0), 0) / profiles.length;
        const avgSessionDuration = profiles.reduce((sum, p) => sum + (p.avg_session_duration_minutes || 0), 0) / profiles.length;
        const totalConversations = profiles.reduce((sum, p) => sum + (p.total_sessions || 0), 0);
        const peakHours = profiles.map((p) => p.peak_hour).filter(Boolean);
        const mostCommonPeak = mode(peakHours);

        sections.push(
          `## Attention Patterns (${period})\n` +
          `- Fragmentation score: ${avgFragmentation.toFixed(2)} (0=focused, 1=scattered)\n` +
          `- Avg session duration: ${avgSessionDuration.toFixed(0)} min\n` +
          `- Total sessions: ${totalConversations}\n` +
          `- Peak hour: ${mostCommonPeak !== null ? `${mostCommonPeak}:00` : "not enough data"}\n` +
          `- Days tracked: ${profiles.length}`
        );
      } else {
        sections.push("## Attention Patterns\nNo behavioral data yet. Import conversations to start tracking.");
      }
    }

    // Drift analysis
    if (focus === "all" || focus === "drift") {
      const { data: drifts } = await from("drift_reports")
        .select("drift_score, drift_category")
        .gte("created_at", periodStart.toISOString());

      if (drifts && drifts.length > 0) {
        const avgDrift = drifts.reduce((sum, d) => sum + d.drift_score, 0) / drifts.length;
        const categories = drifts.reduce((acc, d) => {
          acc[d.drift_category] = (acc[d.drift_category] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        const topCategory = Object.entries(categories).sort((a, b) => (b[1] as number) - (a[1] as number))[0];

        sections.push(
          `## Drift Analysis (${period})\n` +
          `- Average drift score: ${avgDrift.toFixed(2)} (0=on track, 1=off track) [experimental: normalization not yet calibrated]\n` +
          `- Conversations analyzed: ${drifts.length}\n` +
          `- Most common pattern: ${topCategory ? `${topCategory[0]} (${topCategory[1]} times)` : "n/a"}\n` +
          `- Category breakdown: ${Object.entries(categories).map(([k, v]) => `${k}: ${v}`).join(", ")}`
        );
      } else {
        sections.push("## Drift Analysis\nNo drift data yet. Run analysis on imported conversations.");
      }
    }

    // 7 Universal Metrics (from engagement classification + Phase 3 stats)
    if (focus === "all" || focus === "engagement") {
      const { data: engagedConvos } = await from("conversations")
        .select("engagement_profile")
        .gte("started_at", periodStart.toISOString())
        .neq("engagement_profile", null);

      if (engagedConvos && engagedConvos.length > 0) {
        const profiles = engagedConvos.map(c => c.engagement_profile).filter(Boolean);
        const avg = (key: string) => {
          const vals = profiles.map(p => p[key] || 0);
          return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        };

        // State distribution aggregated across conversations
        const states = ["DEEP_ENGAGEMENT", "PASSIVE_ACCEPTANCE", "VERIFICATION", "PROMPT_CRAFTING", "REDIRECTING", "DEFERRED"];
        const avgDist: Record<string, number> = {};
        for (const s of states) {
          const vals = profiles.map(p => p.stateDistribution?.[s] || 0);
          avgDist[s] = vals.reduce((a, b) => a + b, 0) / vals.length;
        }

        sections.push(
          `## 7 Universal Metrics (${period})\n` +
          `Based on ${profiles.length} classified conversations.\n\n` +
          `| Metric | Value | Note |\n` +
          `|---|---|---|\n` +
          `| Verification Rate | ${(avg("verificationRate") * 100).toFixed(1)}% | Turns where you checked/questioned AI claims |\n` +
          `| Generation Ratio | ${(avg("generationRatio") * 100).toFixed(1)}% | Turns where you contributed your own thinking |\n` +
          `| Passive Acceptance | ${(avg("passiveAcceptanceRate") * 100).toFixed(1)}% | Turns where you accepted without evaluation |\n` +
          `| Drift Rate | from drift analysis above | See Drift Analysis section |\n` +
          `| Discovery Entropy | from stats | See conversation mode distribution |\n` +
          `| Idea Follow-Through | pending resurfacing data | Requires SM-2 engagement over time |\n` +
          `| Cognitive Load | from stats | See per-conversation stats |\n\n` +
          `**Engagement state distribution (avg across conversations):**\n` +
          states.map(s => `- ${s}: ${(avgDist[s] * 100).toFixed(1)}%`).join("\n") +
          `\n\n*Classification method: ${profiles.reduce((sum, p) => sum + (p.structurallyClassified || 0), 0)} structural + ${profiles.reduce((sum, p) => sum + (p.llmClassified || 0), 0)} LLM turns*`
        );
      } else {
        sections.push("## 7 Universal Metrics\nNo engagement data yet. Run engagement classification first.");
      }
    }

    // Coaching insights (OIE framework)
    if (focus === "all" || focus === "coaching") {
      const { data: insights } = await from("coaching_insights")
        .select("observation, implication, experiment, category")
        .gte("created_at", periodStart.toISOString())
        .order("created_at", { ascending: false })
        .limit(3);

      if (insights && insights.length > 0) {
        const formatted = insights.map((i) =>
          `**Observe:** ${i.observation}\n` +
          (i.implication ? `**Implication:** ${i.implication}\n` : "") +
          (i.experiment ? `**Experiment:** ${i.experiment}` : "")
        ).join("\n\n");

        sections.push(`## Coaching Insights (OIE Framework)\n\n${formatted}`);
      } else {
        sections.push("## Coaching Insights\nNo coaching insights generated yet.");
      }
    }

    return {
      content: [{ type: "text" as const, text: sections.join("\n\n") }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Reflect failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

function getPeriodStart(period: string, now: Date): Date {
  const start = new Date(now);
  switch (period) {
    case "today": start.setHours(0, 0, 0, 0); break;
    case "week": start.setDate(start.getDate() - 7); break;
    case "month": start.setMonth(start.getMonth() - 1); break;
    case "all": start.setFullYear(2020); break;
    default: start.setDate(start.getDate() - 7);
  }
  return start;
}

function mode(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const freq: Record<number, number> = {};
  for (const v of arr) freq[v] = (freq[v] || 0) + 1;
  return Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
}
