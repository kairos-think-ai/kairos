/**
 * MCP-specific embedding utilities.
 * Pure math lives in @kairos/core. This file handles DB retrieval.
 */

import { from } from "./db.js";
import type { MessageEmbedding } from "@kairos/core";

// Re-export pure math from core for backwards compatibility
export { cosineSimilarity, centroid, cosineDistance, type MessageEmbedding } from "@kairos/core";

/**
 * Get all message embeddings for a conversation, ordered by sequence.
 * Returns only messages that have embeddings.
 */
export async function getMessageEmbeddings(conversationId: string): Promise<MessageEmbedding[]> {
  const { data } = await from("messages")
    .select("id, sequence, role, embedding")
    .eq("conversation_id", conversationId)
    .order("sequence")
    .limit(500);

  if (!data) return [];

  return data
    .filter((m: any) => m.embedding !== null)
    .map((m: any) => ({
      id: m.id,
      sequence: m.sequence,
      role: m.role,
      embedding: typeof m.embedding === "string" ? JSON.parse(m.embedding) : m.embedding,
    }));
}
