/**
 * kairos_resurface — SM-2 spaced repetition for ideas.
 *
 * Returns ideas due for revisiting, with their context and connections.
 * Also accepts engagement feedback to update the SM-2 schedule.
 */

import { from, rpc } from "../db.js";

export async function handleResurface(
  maxIdeas: number,
  engage?: { idea_id: string; action: string }
) {
  try {
    // Handle engagement feedback first
    if (engage) {
      // Find the resurfacing record for this idea
      const { data: record } = await from("idea_resurfacing")
        .select("id")
        .eq("idea_id", engage.idea_id)
        .maybeSingle();

      if (record) {
        // Update Leitner box
        await rpc("update_resurfacing_after_engagement", {
          p_resurfacing_id: record.id,
          p_engagement_type: engage.action,
        });

        // Propagate engagement to related entities (asymmetric feedback)
        await rpc("propagate_engagement_to_entities", {
          p_idea_id: engage.idea_id,
          p_engagement_type: engage.action,
        });

        const boxNames = ["", "daily", "3-day", "weekly", "biweekly", "monthly", "quarterly", "archive"];
        return {
          content: [{
            type: "text" as const,
            text: `Engagement recorded: "${engage.action}" for idea ${engage.idea_id}. Leitner schedule updated. Entity confidence adjusted.`,
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: `No resurfacing record found for idea ${engage.idea_id}.` }],
      };
    }

    // Get ideas due for resurfacing using the DB function
    const { data: dueIdeas, error } = await rpc("get_due_ideas", {
      p_user_id: await getCurrentUserId(),
      max_count: maxIdeas,
    });

    if (error || !dueIdeas || dueIdeas.length === 0) {
      // Check if there are ANY ideas in the system
      const { count } = await from("ideas")
        .select("id", { count: "exact", head: true });

      if (!count || count === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No ideas in your memory yet. Import and analyze conversations to start building your idea graph.",
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: "No ideas due for resurfacing right now. Check back later — ideas resurface at expanding intervals (1 → 3 → 7 → 14 → 30 days).",
        }],
      };
    }

    // Enrich with connection context
    const formatted = await Promise.all(dueIdeas.map(async (idea: any) => {
      let out = `### ${idea.summary}\n`;
      out += `Category: ${idea.category} | Importance: ${idea.importance_score.toFixed(1)} | `;
      out += `Surfaced ${idea.times_surfaced} times | Interval: ${idea.interval_days} days\n`;
      out += `Enrolled because: ${idea.enrollment_reason}\n`;
      out += `ID: ${idea.idea_id} (use with engage to record your response)`;

      // Find connections to this idea's conversation
      const { data: ideaRow } = await from("ideas")
        .select("conversation_id")
        .eq("id", idea.idea_id)
        .maybeSingle();

      if (ideaRow?.conversation_id) {
        const { data: connections } = await from("conversation_connections")
          .select("connection_type, strength, description")
          .or(`conversation_a_id.eq.${ideaRow.conversation_id},conversation_b_id.eq.${ideaRow.conversation_id}`)
          .gte("strength", 0.2)
          .order("strength", { ascending: false })
          .limit(3);

        if (connections && connections.length > 0) {
          out += `\nConnections: ${connections.map((c) => `${c.connection_type} (${c.strength.toFixed(1)})`).join(", ")}`;
        }
      }

      return out;
    }));

    return {
      content: [{
        type: "text" as const,
        text: `## Ideas to Revisit\n\n${formatted.join("\n\n---\n\n")}\n\n` +
              `*To record engagement, call kairos_resurface with engage: { idea_id: "...", action: "revisit"|"act"|"dismiss" }*`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Resurface failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function getCurrentUserId(): Promise<string> {
  if (process.env.KAIROS_USER_ID) return process.env.KAIROS_USER_ID;
  const { data } = await from("users")
    .select("id")
    .limit(1)
    .maybeSingle();

  return data?.id || "";
}
