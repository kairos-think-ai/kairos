/**
 * kairos_connections — Traverse the conversation connection graph.
 *
 * Uses pheromone-weighted edges (stigmergic model):
 * - Connections strengthen when co-accessed
 * - Connections decay exponentially when neglected
 * - Connection types: semantic_similarity, shared_entity, topic_continuation,
 *   contradiction, evolution, temporal_proximity, user_linked
 */

import { from, rpc } from "../db.js";

interface ConnectionsArgs {
  conversation_id?: string;
  topic?: string;
  connection_types?: string[];
  min_strength?: number;
}

export async function handleConnections(args: ConnectionsArgs) {
  try {
    const minStrength = args.min_strength ?? 0.1;

    if (!args.conversation_id && !args.topic) {
      // Return global connection stats
      const { data: stats } = await from("conversation_connections")
        .select("connection_type, strength")
        .gte("strength", minStrength);

      if (!stats || stats.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No connections in the graph yet. Import and analyze conversations to build the connection network.",
          }],
        };
      }

      const byType = stats.reduce((acc, s) => {
        acc[s.connection_type] = (acc[s.connection_type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const avgStrength = stats.reduce((sum, s) => sum + s.strength, 0) / stats.length;

      return {
        content: [{
          type: "text" as const,
          text: `## Connection Graph Stats\n` +
                `- Total connections: ${stats.length}\n` +
                `- Avg strength: ${avgStrength.toFixed(2)}\n` +
                `- By type: ${Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ")}`,
        }],
      };
    }

    // Find connections for a specific conversation
    if (args.conversation_id) {
      let query = from("conversation_connections")
        .select(`
          id, connection_type, custom_type, strength, description,
          conversation_a_id, conversation_b_id
        `)
        .or(`conversation_a_id.eq.${args.conversation_id},conversation_b_id.eq.${args.conversation_id}`)
        .gte("strength", minStrength)
        .order("strength", { ascending: false })
        .limit(20);

      if (args.connection_types && args.connection_types.length > 0) {
        query = query.in("connection_type", args.connection_types);
      }

      const { data: connections } = await query;

      if (!connections || connections.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No connections found for this conversation." }],
        };
      }

      // Strengthen accessed connections (pheromone model)
      for (const conn of connections) {
        await rpc("strengthen_connection", { connection_uuid: conn.id });
      }

      // Fetch connected conversation details
      const connectedIds = connections.map((c) =>
        c.conversation_a_id === args.conversation_id ? c.conversation_b_id : c.conversation_a_id
      );

      const { data: convos } = await from("conversations")
        .select("id, title, platform, started_at, summary")
        .in("id", connectedIds);

      const convoMap = new Map((convos || []).map((c: any) => [c.id, c]));

      const formatted = connections.map((conn) => {
        const otherId = conn.conversation_a_id === args.conversation_id
          ? conn.conversation_b_id : conn.conversation_a_id;
        const other: any = convoMap.get(otherId);
        const type = conn.custom_type || conn.connection_type;
        return `- **${other?.title || "Untitled"}** [${type}, strength: ${conn.strength.toFixed(2)}]\n` +
               `  ${conn.description || ""}\n` +
               `  ${other?.platform || ""}, ${other?.started_at ? new Date(other.started_at).toLocaleDateString() : ""}`;
      }).join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `## Connections for "${(convos || []).find(() => true)?.title || args.conversation_id}"\n\n${formatted}`,
        }],
      };
    }

    // Search by topic — find conversations about this topic, then their connections
    if (args.topic) {
      const { data: convos } = await from("conversations")
        .select("id, title")
        .ilike("title", `%${args.topic}%`)
        .limit(5);

      if (!convos || convos.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No conversations found matching topic "${args.topic}".` }],
        };
      }

      // Recursively get connections for all matching conversations
      const allConnections: string[] = [];
      for (const convo of convos) {
        const result = await handleConnections({
          conversation_id: convo.id,
          connection_types: args.connection_types,
          min_strength: minStrength,
        });
        allConnections.push(`### ${convo.title}\n${result.content[0].text}`);
      }

      return {
        content: [{ type: "text" as const, text: allConnections.join("\n\n") }],
      };
    }

    return {
      content: [{ type: "text" as const, text: "Provide a conversation_id or topic to search connections." }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Connections failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
