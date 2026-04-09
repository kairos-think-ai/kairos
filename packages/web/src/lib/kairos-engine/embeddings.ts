/**
 * Kairos Engine — Embedding Generation
 *
 * Uses Voyage AI voyage-3 (1024 dimensions) for idea embeddings.
 * Direct HTTP calls — no SDK dependency.
 *
 * Enrichment strategy: "[{category}] {summary}. {context}"
 * for better short-text cluster separation (spec Section 6.5).
 */

import { createServiceClient } from '../supabase/server';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3';
const EMBEDDING_DIM = 1024;
const MAX_BATCH_SIZE = 128;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

/**
 * Call Voyage AI embedding API. Batch-friendly: up to 128 texts per call.
 */
async function callVoyageAPI(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY not configured');
  }

  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: 'document',
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${errText}`);
  }

  const result: VoyageResponse = await response.json();
  return result.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

/**
 * Enrich idea text before embedding for better clustering.
 * Format: "[{category}] {summary}. {context}"
 */
function enrichIdeaText(idea: {
  summary: string;
  context: string | null;
  category: string | null;
}): string {
  const parts: string[] = [];
  if (idea.category) parts.push(`[${idea.category}]`);
  parts.push(idea.summary);
  if (idea.context) parts.push(idea.context);
  return parts.join(' ');
}

/**
 * Generate and store embeddings for all ideas in a conversation
 * that don't yet have embeddings.
 */
export async function generateIdeaEmbeddings(
  conversationId: string,
  userId: string
): Promise<{ embedded: number; skipped: number }> {
  const supabase = createServiceClient();

  // Fetch ideas without embeddings for this conversation
  const { data: ideas, error } = await supabase
    .from('ideas')
    .select('id, summary, context, category')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .is('embedding', null);

  if (error || !ideas || ideas.length === 0) {
    return { embedded: 0, skipped: 0 };
  }

  const texts = ideas.map(enrichIdeaText);

  // Process in batches of MAX_BATCH_SIZE
  let embedded = 0;
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchIdeas = ideas.slice(i, i + MAX_BATCH_SIZE);
    const embeddings = await callVoyageAPI(batch);

    for (let j = 0; j < batchIdeas.length; j++) {
      const { error: updateErr } = await supabase
        .from('ideas')
        .update({ embedding: JSON.stringify(embeddings[j]) })
        .eq('id', batchIdeas[j].id);

      if (!updateErr) embedded++;
    }
  }

  // Audit log
  await supabase.from('audit_log').insert({
    user_id: userId,
    skill_name: 'embedding-generator',
    action: 'analyze',
    conversation_id: conversationId,
    data_type: 'embedding',
    destination: 'voyage_api',
    details: {
      ideas_embedded: embedded,
      model: VOYAGE_MODEL,
      dimension: EMBEDDING_DIM,
    },
  });

  return { embedded, skipped: ideas.length - embedded };
}
