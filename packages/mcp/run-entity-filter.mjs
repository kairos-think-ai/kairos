/**
 * Entity Noise Filter
 *
 * Scores all entities using cross-conversation document frequency (BM25-style).
 * Sets status: active (signal), dormant (weak signal), archived (noise).
 *
 * Scoring:
 *   - document_frequency: distinct conversations mentioning the entity
 *   - importance_score: BM25-weighted cross-conversation importance
 *   - confidence: Bayesian Beta(alpha, beta) mean with temporal decay
 *   - status: active (df >= 2), dormant (df == 1 but recent), archived (df == 1 and old)
 */

import { from, rpc } from './src/db.js';

const USER_ID = process.env.KAIROS_USER_ID;

// Get default user if not specified
if (!USER_ID) {
  const { data: user } = await from("users").select("id").limit(1).maybeSingle();
  if (!user) { console.error("No user found"); process.exit(1); }
  process.env.KAIROS_USER_ID = user.id;
}

const userId = process.env.KAIROS_USER_ID;

console.log('=== Entity Noise Filter ===\n');

// Apply migration if needed
if (process.env.KAIROS_RUN_MIGRATIONS === 'true') {
  const { runMigrations } = await import('./src/migrate.js');
  await runMigrations();
}

// Get total conversation count
const { data: allConvos } = await from("conversations")
  .select("id")
  .eq("user_id", userId)
  .eq("analysis_status", "completed");
const N = allConvos?.length || 1;
console.log(`Total analyzed conversations: ${N}`);

// Get all entities
const { data: entities } = await from("entities")
  .select("id, name, type, mention_count, first_mentioned_at, last_mentioned_at")
  .eq("user_id", userId);

if (!entities || entities.length === 0) {
  console.log("No entities found.");
  process.exit(0);
}
console.log(`Total entities: ${entities.length}`);

// Get all entity_mentions to compute TRUE document frequency
// (mention_count in entities table is not reliable — it's per-extraction, not per-conversation)
const { data: mentions } = await from("entity_mentions")
  .select("entity_id, conversation_id")
  .limit(10000);

// Compute document frequency: distinct conversations per entity
const entityDF = new Map();
const entityConvos = new Map(); // entity_id -> Set of conversation_ids
for (const m of (mentions || [])) {
  if (!entityConvos.has(m.entity_id)) entityConvos.set(m.entity_id, new Set());
  entityConvos.get(m.entity_id).add(m.conversation_id);
}
for (const [entityId, convoSet] of entityConvos) {
  entityDF.set(entityId, convoSet.size);
}

console.log(`\nEntity mentions loaded: ${(mentions || []).length}`);
console.log(`Entities with mentions: ${entityDF.size}`);

// Score each entity
const now = Date.now();
let active = 0, dormant = 0, archived = 0;

for (const entity of entities) {
  const df = entityDF.get(entity.id) || 0;

  // BM25-style IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  // Normalized by log(N+1) to keep in [0, 1]-ish range
  const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1) / Math.log(N + 1);
  const importanceScore = df * idf; // TF (df as proxy) * IDF

  // Bayesian confidence: Beta(alpha, beta) mean
  // alpha = df (positive evidence: appeared in conversations)
  // beta = max(1, N/5 - df) (absence: didn't appear where we might expect it)
  const alpha = df + 1; // +1 prior
  const beta = Math.max(1, Math.floor(N / 5) - df + 1); // +1 prior
  let confidence = alpha / (alpha + beta);

  // Temporal decay: entities not seen recently lose confidence
  const lastSeen = entity.last_mentioned_at ? new Date(entity.last_mentioned_at).getTime() : now;
  const daysSinceLastSeen = (now - lastSeen) / (1000 * 60 * 60 * 24);

  // Decay rate depends on entity type
  const decayRates = {
    technology: 0.01, tool: 0.01, concept: 0.005, person: 0.003,
    company: 0.005, project_name: 0.007, decision: 0.01, goal: 0.008, other: 0.01,
  };
  const decayRate = decayRates[entity.type] || 0.01;
  confidence *= Math.exp(-decayRate * daysSinceLastSeen);

  // Status determination
  let status;
  if (df >= 2) {
    status = 'active';
    active++;
  } else if (df === 1 && daysSinceLastSeen < 30) {
    status = 'dormant'; // single mention but recent — might reappear
    dormant++;
  } else {
    status = 'archived'; // single mention and old — noise
    archived++;
  }

  // Update entity
  await from("entities")
    .update({
      importance_score: Math.round(importanceScore * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      document_frequency: df,
      status,
    })
    .eq("id", entity.id);
}

console.log(`\n=== Results ===`);
console.log(`Active (df >= 2): ${active}`);
console.log(`Dormant (df == 1, recent): ${dormant}`);
console.log(`Archived (df == 1, old): ${archived}`);

// Show top entities by importance
const { data: topEntities } = await from("entities")
  .select("name, type, document_frequency, importance_score, confidence, status")
  .eq("user_id", userId)
  .eq("status", "active")
  .order("importance_score", { ascending: false })
  .limit(20);

if (topEntities && topEntities.length > 0) {
  console.log(`\nTop active entities:`);
  for (const e of topEntities) {
    console.log(`  df=${e.document_frequency} imp=${e.importance_score.toFixed(3)} conf=${e.confidence.toFixed(2)} [${e.type}] ${e.name}`);
  }
}

// Show what got archived
const { data: archivedEntities } = await from("entities")
  .select("name, type")
  .eq("user_id", userId)
  .eq("status", "archived")
  .limit(10);

if (archivedEntities && archivedEntities.length > 0) {
  console.log(`\nSample archived entities (noise):`);
  for (const e of archivedEntities) {
    console.log(`  [${e.type}] ${e.name}`);
  }
}
