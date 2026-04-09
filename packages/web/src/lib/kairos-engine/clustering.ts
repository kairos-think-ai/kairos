/**
 * Kairos Engine — Idea Clustering
 *
 * Two modes:
 * 1. quickAssignClusters — per-conversation, after embeddings. O(num_clusters) per idea.
 * 2. weeklyRecluster — full recluster via greedy cosine + Claude Sonnet refinement.
 *
 * Threshold: cosine similarity >= 0.80 for cluster assignment.
 * Min cluster size: 2 ideas.
 */

import { createServiceClient } from '../supabase/server';
import { getAnthropicClient } from '../anthropic';

const COSINE_THRESHOLD = 0.80;
const MIN_CLUSTER_SIZE = 2;
const REFINEMENT_MODEL = 'claude-sonnet-4-5-20250929';

// ============================================================
// QUICK ASSIGN (per-conversation, real-time)
// ============================================================

/**
 * Quick-assign new ideas from a conversation to existing clusters.
 * Uses pgvector cosine distance via the find_nearest_cluster RPC.
 */
export async function quickAssignClusters(
  conversationId: string,
  userId: string
): Promise<{ assigned: number; unclustered: number }> {
  const supabase = createServiceClient();

  // Fetch newly-embedded ideas from this conversation
  const { data: newIdeas } = await supabase
    .from('ideas')
    .select('id, embedding')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .not('embedding', 'is', null);

  if (!newIdeas || newIdeas.length === 0) return { assigned: 0, unclustered: 0 };

  // Check which already have cluster assignments
  const ideaIds = newIdeas.map((i: { id: string }) => i.id);
  const { data: existingMembers } = await supabase
    .from('idea_cluster_members')
    .select('idea_id')
    .in('idea_id', ideaIds);

  const alreadyClustered = new Set((existingMembers || []).map((m: { idea_id: string }) => m.idea_id));
  const unclusteredIdeas = newIdeas.filter((i: { id: string; embedding: unknown }) => !alreadyClustered.has(i.id));

  if (unclusteredIdeas.length === 0) return { assigned: 0, unclustered: 0 };

  let assigned = 0;
  const distanceThreshold = 1 - COSINE_THRESHOLD; // pgvector uses distance

  for (const idea of unclusteredIdeas) {
    const { data: nearestMatch } = await supabase.rpc('find_nearest_cluster', {
      p_user_id: userId,
      p_embedding: idea.embedding,
      p_threshold: distanceThreshold,
    });

    if (nearestMatch && nearestMatch.length > 0) {
      const match = nearestMatch[0];
      const similarity = 1 - match.distance;

      await supabase.from('idea_cluster_members').insert({
        idea_id: idea.id,
        cluster_id: match.cluster_id,
        similarity_score: similarity,
      });

      await supabase.from('idea_clusters')
        .update({
          idea_count: match.idea_count + 1,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', match.cluster_id);

      assigned++;
    }
  }

  return { assigned, unclustered: unclusteredIdeas.length - assigned };
}

// ============================================================
// WEEKLY RECLUSTER (greedy cosine + LLM refinement)
// ============================================================

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Greedy single-linkage cosine clustering.
 * Returns arrays of idea indices grouped by similarity.
 */
function greedyCosineClustering(
  ideas: Array<{ id: string; embedding: number[] }>,
  threshold: number
): Array<string[]> {
  const clusters: Array<Set<number>> = [];
  const assigned = new Set<number>();

  for (let i = 0; i < ideas.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = new Set([i]);
    assigned.add(i);

    for (let j = i + 1; j < ideas.length; j++) {
      if (assigned.has(j)) continue;
      const sim = cosineSimilarity(ideas[i].embedding, ideas[j].embedding);
      if (sim >= threshold) {
        cluster.add(j);
        assigned.add(j);
      }
    }

    if (cluster.size >= MIN_CLUSTER_SIZE) {
      clusters.push(cluster);
    }
  }

  return clusters.map(c => [...c].map(idx => ideas[idx].id));
}

/**
 * Send candidate clusters to Claude Sonnet for merge/split/label decisions.
 */
async function refineWithLLM(
  clusters: Array<{ ideaIds: string[]; summaries: string[] }>,
  userId: string
): Promise<Array<{ label: string; description: string; ideaIds: string[] }>> {
  if (clusters.length === 0) return [];

  const anthropic = await getAnthropicClient(userId);

  const clusterDescriptions = clusters.map((c, i) =>
    `Cluster ${i + 1} (${c.summaries.length} ideas):\n${c.summaries.map(s => `  - ${s}`).join('\n')}`
  ).join('\n\n');

  const response = await anthropic.messages.create({
    model: REFINEMENT_MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an expert at organizing ideas into meaningful groups.

Given these candidate idea clusters, suggest the final grouping. You may:
- Merge clusters that are clearly about the same theme
- Split clusters that contain unrelated ideas
- Label each cluster with a clear, concise name

${clusterDescriptions}

Respond with ONLY a JSON array:
[
  {
    "label": "Short cluster name",
    "description": "1-sentence description of what ties these ideas together",
    "clusterIndices": [0, 1]  // Which input cluster indices to include
  }
]

If all clusters look good as-is, return them with their original indices.`,
    }],
  });

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const refined = JSON.parse(cleaned) as Array<{
      label: string;
      description: string;
      clusterIndices: number[];
    }>;

    return refined.map(r => ({
      label: r.label,
      description: r.description,
      ideaIds: r.clusterIndices.flatMap(idx => clusters[idx]?.ideaIds || []),
    }));
  } catch {
    // If LLM response is malformed, return original clusters with auto-labels
    return clusters.map((c, i) => ({
      label: `Cluster ${i + 1}`,
      description: c.summaries[0] || '',
      ideaIds: c.ideaIds,
    }));
  }
}

/**
 * Full weekly recluster for a user.
 * 1. Greedy cosine threshold clustering
 * 2. Claude Sonnet refinement (merge/split/label)
 * 3. Update DB tables
 */
export async function weeklyRecluster(userId: string): Promise<{
  clustersCreated: number;
  ideasAssigned: number;
}> {
  const supabase = createServiceClient();

  // Fetch all ideas with embeddings
  const { data: allIdeas } = await supabase
    .from('ideas')
    .select('id, summary, category, embedding')
    .eq('user_id', userId)
    .not('embedding', 'is', null)
    .order('created_at', { ascending: false });

  if (!allIdeas || allIdeas.length < MIN_CLUSTER_SIZE) {
    return { clustersCreated: 0, ideasAssigned: 0 };
  }

  // Greedy cosine clustering
  const clusterIdGroups = greedyCosineClustering(
    allIdeas.map((i: { id: string; summary: string; category: string; embedding: unknown }) => ({ id: i.id, embedding: i.embedding as unknown as number[] })),
    COSINE_THRESHOLD
  );

  // Build cluster data with summaries for LLM
  const clusterData = clusterIdGroups.map(ideaIds => ({
    ideaIds,
    summaries: ideaIds.map(id => {
      const idea = allIdeas.find((i: { id: string; summary: string; category: string }) => i.id === id);
      return idea ? `[${idea.category}] ${idea.summary}` : '';
    }),
  }));

  // LLM refinement
  const refined = await refineWithLLM(clusterData, userId);

  // Clear existing clusters for this user
  const { data: existingClusters } = await supabase
    .from('idea_clusters')
    .select('id')
    .eq('user_id', userId);

  if (existingClusters && existingClusters.length > 0) {
    const clusterIds = existingClusters.map((c: { id: string }) => c.id);
    await supabase.from('idea_cluster_members').delete().in('cluster_id', clusterIds);
    await supabase.from('idea_clusters').delete().eq('user_id', userId);
  }

  // Insert new clusters
  let totalAssigned = 0;
  for (const cluster of refined) {
    if (cluster.ideaIds.length < MIN_CLUSTER_SIZE) continue;

    const { data: newCluster } = await supabase
      .from('idea_clusters')
      .insert({
        user_id: userId,
        label: cluster.label,
        description: cluster.description,
        idea_count: cluster.ideaIds.length,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (newCluster) {
      await supabase.from('idea_cluster_members').insert(
        cluster.ideaIds.map(ideaId => ({
          idea_id: ideaId,
          cluster_id: newCluster.id,
          similarity_score: null,
        }))
      );
      totalAssigned += cluster.ideaIds.length;
    }
  }

  // Audit log
  await supabase.from('audit_log').insert({
    user_id: userId,
    skill_name: 'weekly-recluster',
    action: 'analyze',
    data_type: 'cluster',
    destination: 'claude_api',
    details: {
      total_ideas: allIdeas.length,
      clusters_created: refined.length,
      ideas_assigned: totalAssigned,
      model: REFINEMENT_MODEL,
    },
  });

  return { clustersCreated: refined.length, ideasAssigned: totalAssigned };
}
