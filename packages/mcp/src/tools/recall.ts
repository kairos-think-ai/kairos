/**
 * kairos_recall — Graph-first + embedding-fallback retrieval.
 *
 * Retrieval strategy:
 *   1. Search entities by name match (active entities only)
 *   2. Follow entity_mentions → seed conversations
 *   3. Run Personalized PageRank on conversation connection graph
 *      (alpha=0.5, naturally handles multi-hop — expected walk length = 2 hops)
 *   4. Fallback: title search, idea search
 *   5. Return conversation summaries with ideas and drift context
 */

import { from } from "../db.js";
import { personalizedPageRank } from "@kairos/core";

export async function handleRecall(query: string, maxResults: number, includeMessages: boolean) {
  try {
    const results: RecallResult[] = [];

    // Step 1: Search active entities
    const { data: entities } = await from("entities")
      .select("id, name, type, importance_score")
      .ilike("name", `%${query}%`)
      .neq("status", "archived")
      .order("importance_score", { ascending: false })
      .limit(10);

    if (entities && entities.length > 0) {
      // Step 2: Follow entity_mentions → seed conversations
      const entityIds = entities.map((e) => e.id);
      const { data: mentions } = await from("entity_mentions")
        .select("conversation_id, entity_id")
        .in("entity_id", entityIds)
        .limit(50);

      if (mentions && mentions.length > 0) {
        const seedConvoIds = [...new Set(mentions.map((m) => m.conversation_id))] as string[];

        // Step 3: Build adjacency + run PPR
        const pprResults = await runPPRRetrieval(seedConvoIds, entities);

        // Fetch top conversations by PPR score
        const topIds = pprResults.slice(0, maxResults * 2).map((r) => r.id);
        if (topIds.length > 0) {
          const convos = await fetchConversations(topIds, includeMessages);
          // Annotate with retrieval method
          for (const convo of convos) {
            const pprEntry = pprResults.find((r) => r.id === convo.id);
            if (pprEntry) {
              convo.via = pprEntry.isSeed ? "entity_match" : "ppr_connected";
            }
          }
          results.push(...convos);
        }
      }
    }

    // Step 4: Title search fallback
    if (results.length < maxResults) {
      const { data: textMatches } = await from("conversations")
        .select("id")
        .ilike("title", `%${query}%`)
        .limit(maxResults - results.length);

      if (textMatches) {
        const existingIds = new Set(results.map((r) => r.id));
        const newIds = textMatches.map((m) => m.id).filter((id) => !existingIds.has(id));
        if (newIds.length > 0) {
          const fallback = await fetchConversations(newIds, includeMessages);
          results.push(...fallback.map((r) => ({ ...r, via: "title_search" })));
        }
      }
    }

    // Step 5: Idea search fallback
    if (results.length < maxResults) {
      const { data: ideas } = await from("ideas")
        .select("id, summary, conversation_id, category, importance_score")
        .ilike("summary", `%${query}%`)
        .order("importance_score", { ascending: false })
        .limit(maxResults);

      if (ideas && ideas.length > 0) {
        const existingIds = new Set(results.map((r) => r.id));
        const newConvoIds = [...new Set(ideas.map((i) => i.conversation_id).filter((id) => !existingIds.has(id)))] as string[];
        if (newConvoIds.length > 0) {
          const ideaConvos = await fetchConversations(newConvoIds, includeMessages);
          results.push(...ideaConvos.map((r) => ({ ...r, via: "idea_match" })));
        }
      }
    }

    const limited = results.slice(0, maxResults);

    if (limited.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No conversations found for "${query}". Try importing conversations first with kairos_import.` }],
      };
    }

    const formatted = limited.map((r) => formatRecallResult(r)).join("\n\n---\n\n");
    return {
      content: [{ type: "text" as const, text: `Found ${limited.length} conversation(s) for "${query}":\n\n${formatted}` }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Recall failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

/**
 * Run PPR on the conversation connection graph, seeded from entity-matched conversations.
 * Returns conversations ranked by PPR score.
 */
async function runPPRRetrieval(
  seedConvoIds: string[],
  matchedEntities: any[]
): Promise<Array<{ id: string; score: number; isSeed: boolean }>> {
  // Build adjacency from conversation_connections
  const { data: allConnections } = await from("conversation_connections")
    .select("conversation_a_id, conversation_b_id, strength")
    .gte("strength", 0.05)
    .limit(1000);

  if (!allConnections || allConnections.length === 0) {
    // No graph — return seeds only
    return seedConvoIds.map((id) => ({ id, score: 1.0, isSeed: true }));
  }

  // Build adjacency map (bidirectional)
  const adjacency = new Map<string, Map<string, number>>();
  for (const conn of allConnections) {
    if (!adjacency.has(conn.conversation_a_id)) adjacency.set(conn.conversation_a_id, new Map());
    if (!adjacency.has(conn.conversation_b_id)) adjacency.set(conn.conversation_b_id, new Map());
    adjacency.get(conn.conversation_a_id)!.set(conn.conversation_b_id, conn.strength);
    adjacency.get(conn.conversation_b_id)!.set(conn.conversation_a_id, conn.strength);
  }

  // Build teleport vector: seed conversations weighted by entity importance
  const teleport = new Map<string, number>();
  const totalImportance = matchedEntities.reduce((sum, e) => sum + (e.importance_score || 1), 0) || 1;
  for (const id of seedConvoIds) {
    teleport.set(id, 1.0 / seedConvoIds.length); // equal weight for now
  }

  // Run PPR
  const scores = personalizedPageRank(adjacency, teleport, 0.5, 20);

  // Sort by score, annotate seeds
  const seedSet = new Set(seedConvoIds);
  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ id, score, isSeed: seedSet.has(id) }))
    .sort((a, b) => b.score - a.score);

  return ranked;
}

// ── Types + Helpers ───────────────────────────────────────────────────

interface RecallResult {
  id: string;
  title: string | null;
  platform: string;
  started_at: string;
  message_count: number;
  summary?: string;
  ideas?: Array<{ summary: string; category: string; importance_score: number }>;
  drift?: { drift_score: number; drift_category: string; inferred_intent: string };
  messages?: Array<{ role: string; content: string }>;
  via?: string;
}

async function fetchConversations(ids: string[], includeMessages: boolean): Promise<RecallResult[]> {
  const { data: convos } = await from("conversations")
    .select("id, title, platform, started_at, message_count, summary")
    .in("id", ids);

  if (!convos) return [];

  const results: RecallResult[] = [];

  for (const convo of convos) {
    const result: RecallResult = {
      id: convo.id,
      title: convo.title,
      platform: convo.platform,
      started_at: convo.started_at,
      message_count: convo.message_count,
      summary: convo.summary,
    };

    const { data: ideas } = await from("ideas")
      .select("summary, category, importance_score")
      .eq("conversation_id", convo.id)
      .order("importance_score", { ascending: false })
      .limit(5);

    if (ideas) result.ideas = ideas;

    const { data: drift } = await from("drift_reports")
      .select("drift_score, drift_category, inferred_intent")
      .eq("conversation_id", convo.id)
      .maybeSingle();

    if (drift) result.drift = drift;

    if (includeMessages) {
      const { data: msgs } = await from("messages")
        .select("role, content")
        .eq("conversation_id", convo.id)
        .order("sequence")
        .limit(20);

      if (msgs) result.messages = msgs;
    }

    results.push(result);
  }

  return results;
}

function formatRecallResult(r: RecallResult): string {
  let out = `**${r.title || "Untitled"}** (${r.platform}, ${new Date(r.started_at).toLocaleDateString()})`;
  if (r.via) out += ` [found via: ${r.via}]`;
  out += `\n${r.message_count} messages`;

  if (r.summary) {
    out += `\n\n${r.summary}`;
  }

  if (r.ideas && r.ideas.length > 0) {
    out += `\n\nKey ideas:`;
    for (const idea of r.ideas) {
      out += `\n- [${idea.category}] ${idea.summary} (importance: ${idea.importance_score.toFixed(1)})`;
    }
  }

  if (r.drift) {
    out += `\n\nDrift: ${r.drift.drift_category} (score: ${r.drift.drift_score.toFixed(2)})`;
    out += `\nOriginal intent: ${r.drift.inferred_intent}`;
  }

  if (r.messages) {
    out += `\n\nMessages (first ${r.messages.length}):`;
    for (const m of r.messages.slice(0, 10)) {
      out += `\n[${m.role}]: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`;
    }
  }

  return out;
}
