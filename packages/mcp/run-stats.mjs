/**
 * Compute statistical metrics for all conversations.
 * Uses message-level embeddings (must run run-embed-messages.mjs first).
 *
 * Outputs: JSD drift, change points, entropy, cognitive load for each conversation.
 */
import { getMessageEmbeddings } from './src/embeddings.js';
import { computeConversationStats } from './src/stats.js';
import { from } from './src/db.js';

const USER_ID = process.env.KAIROS_USER_ID;

// Get default user if not specified
if (!USER_ID) {
  const { data: user } = await from("users").select("id").limit(1).maybeSingle();
  if (!user) { console.error("No user found"); process.exit(1); }
  process.env.KAIROS_USER_ID = user.id;
}

const userId = process.env.KAIROS_USER_ID;

console.log('=== Computing Conversation Stats (Math Layer) ===\n');

// Get all analyzed conversations
const { data: conversations } = await from("conversations")
  .select("id, title, message_count")
  .eq("user_id", userId)
  .eq("analysis_status", "completed")
  .order("started_at");

if (!conversations || conversations.length === 0) {
  console.log("No analyzed conversations found.");
  process.exit(0);
}

console.log(`Conversations: ${conversations.length}\n`);

const results = [];

for (let i = 0; i < conversations.length; i++) {
  const convo = conversations[i];
  const title = convo.title || "Untitled";

  // Get message embeddings
  const embeddings = await getMessageEmbeddings(convo.id);

  if (embeddings.length < 3) {
    console.log(`[${i + 1}/${conversations.length}] "${title}" — skipped (${embeddings.length} embedded messages)`);
    continue;
  }

  // Get raw messages for cognitive load computation
  const { data: rawMessages } = await from("messages")
    .select("role, content")
    .eq("conversation_id", convo.id)
    .order("sequence")
    .limit(500);

  if (!rawMessages) continue;

  // Compute all stats
  const stats = computeConversationStats(embeddings, rawMessages);

  console.log(
    `[${i + 1}/${conversations.length}] "${title}" (${embeddings.length} msgs)\n` +
    `  Drift: ${stats.drift.driftScore.toFixed(3)} | ` +
    `Entropy: ${stats.entropy.normalizedEntropy.toFixed(2)} (${stats.entropy.mode}) | ` +
    `Load: ${stats.cognitiveLoad.cognitiveLoadIndex.toFixed(2)} (${stats.cognitiveLoad.level}) | ` +
    `Change points: ${stats.changePoints.changePoints.length}`
  );

  results.push({ title, messageCount: embeddings.length, ...stats });
}

// Summary
console.log('\n=== Summary ===\n');

const driftScores = results.map(r => r.drift.driftScore);
const entropies = results.map(r => r.entropy.normalizedEntropy);
const loads = results.map(r => r.cognitiveLoad.cognitiveLoadIndex);

const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

console.log(`Conversations analyzed: ${results.length}`);
console.log(`Avg drift score: ${avg(driftScores).toFixed(3)}`);
console.log(`Avg entropy: ${avg(entropies).toFixed(2)}`);
console.log(`Avg cognitive load: ${avg(loads).toFixed(2)}`);
console.log(`Mode distribution: ${results.filter(r => r.entropy.mode === 'discovery').length} discovery, ${results.filter(r => r.entropy.mode === 'production').length} production, ${results.filter(r => r.entropy.mode === 'mixed').length} mixed`);
console.log(`Load distribution: ${results.filter(r => r.cognitiveLoad.level === 'low').length} low, ${results.filter(r => r.cognitiveLoad.level === 'moderate').length} moderate, ${results.filter(r => r.cognitiveLoad.level === 'high').length} high, ${results.filter(r => r.cognitiveLoad.level === 'overloaded').length} overloaded`);
console.log(`Total change points detected: ${results.reduce((sum, r) => sum + r.changePoints.changePoints.length, 0)}`);
