/**
 * Classify engagement state for all conversation turns.
 *
 * Two-phase approach:
 *   1. Structural pre-classification for obvious cases (free, instant)
 *   2. LLM classification for ambiguous cases (Claude Sonnet, ~$0.01 per ambiguous turn)
 *
 * Adapted from:
 *   - Mozannar et al. CUPS taxonomy (CHI 2024)
 *   - Zheng et al. FastChat llm_judge (NeurIPS 2023)
 *   - Demszky uptake model (ACL 2021)
 *
 * See PHASE6-DESIGN-NOTES.md for design decisions.
 */

import {
  structuralClassify,
  buildEngagementPrompt,
  extractStateFromLLMOutput,
  computeEngagementProfile,
} from '@kairos/core';
import { from } from './src/db.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function getDefaultUserId() {
  const { data } = await from("users").select("id").limit(1).maybeSingle();
  if (!data) { console.error("No user found"); process.exit(1); }
  return data.id;
}

const userId = process.env.KAIROS_USER_ID || await getDefaultUserId();

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300,  // Short — just reasoning + state name
      temperature: 0,   // Deterministic (Pattern 3 from FastChat)
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

console.log('=== Turn-Level Engagement Classification ===\n');

// Get change points for each conversation (for REDIRECTING detection)
// We'll compute these inline from TextTiling since they're already in stats

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

let totalStructural = 0;
let totalLLM = 0;
let totalSkipped = 0;
let totalErrors = 0;

for (let ci = 0; ci < conversations.length; ci++) {
  const convo = conversations[ci];
  const title = convo.title || "Untitled";

  // Check if already classified
  const { data: existing } = await from("turn_engagement")
    .select("id")
    .eq("conversation_id", convo.id)
    .limit(1);

  if (existing && existing.length > 0) {
    totalSkipped++;
    continue;
  }

  // Get messages in order
  const { data: messages } = await from("messages")
    .select("id, role, content, sequence")
    .eq("conversation_id", convo.id)
    .order("sequence");

  if (!messages || messages.length < 2) continue;

  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) continue;

  process.stdout.write(`[${ci + 1}/${conversations.length}] "${title}" (${userMessages.length} user turns)... `);

  const classifications = [];
  let structural = 0;
  let llm = 0;

  // Get change points for REDIRECTING detection
  // Simple approach: detect where cosine similarity between consecutive user messages drops
  // (We don't have embeddings for all messages, so we'll skip change point detection
  //  and let the LLM handle REDIRECTING classification)
  const changePointIndices = new Set(); // TODO: populate from Phase 3 stats if available

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== 'user') continue;

    // Find the preceding AI message (if any)
    let aiPrev = null;
    for (let j = mi - 1; j >= 0; j--) {
      if (messages[j].role === 'assistant') {
        aiPrev = messages[j].content;
        break;
      }
    }

    // Find next action (if available)
    let nextAction = null;
    for (let j = mi + 1; j < messages.length; j++) {
      if (messages[j].role === 'user') {
        nextAction = messages[j].content;
        break;
      }
    }

    const isTopicChange = changePointIndices.has(msg.sequence);

    // Phase 1: Try structural classification
    const structResult = structuralClassify(msg.content, aiPrev, isTopicChange);

    if (structResult) {
      classifications.push({
        message_id: msg.id,
        sequence: msg.sequence,
        ...structResult,
      });
      structural++;
    } else if (aiPrev && ANTHROPIC_KEY) {
      // Phase 2: LLM classification for ambiguous turns
      try {
        const prompt = buildEngagementPrompt(aiPrev, msg.content, nextAction);
        const output = await callClaude(prompt);
        const { state, reasoning } = extractStateFromLLMOutput(output);

        if (state) {
          classifications.push({
            message_id: msg.id,
            sequence: msg.sequence,
            state,
            confidence: 0.85, // LLM confidence — not calibrated, marked as such
            method: 'llm',
            reasoning,
          });
          llm++;
        } else {
          // LLM couldn't classify — default to DEEP_ENGAGEMENT (most common ambiguous state)
          classifications.push({
            message_id: msg.id,
            sequence: msg.sequence,
            state: 'DEEP_ENGAGEMENT',
            confidence: 0.5, // Low confidence
            method: 'llm',
            reasoning: `LLM output did not contain valid state: ${output.slice(0, 100)}`,
          });
          llm++;
        }
      } catch (err) {
        totalErrors++;
      }
    }
  }

  // Store classifications
  if (classifications.length > 0) {
    for (const c of classifications) {
      await from("turn_engagement")
        .insert({
          message_id: c.message_id,
          conversation_id: convo.id,
          user_id: userId,
          state: c.state,
          confidence: c.confidence,
          classification_method: c.method,
          reasoning: c.reasoning || null,
          sequence: c.sequence,
        });
    }

    // Compute and store engagement profile
    const profile = computeEngagementProfile(classifications);
    await from("conversations")
      .update({ engagement_profile: profile })
      .eq("id", convo.id);
  }

  totalStructural += structural;
  totalLLM += llm;

  console.log(`structural: ${structural}, llm: ${llm}`);
}

console.log(`\n=== Summary ===`);
console.log(`Conversations processed: ${conversations.length - totalSkipped}`);
console.log(`Skipped (already classified): ${totalSkipped}`);
console.log(`Structural classifications: ${totalStructural}`);
console.log(`LLM classifications: ${totalLLM}`);
console.log(`Errors: ${totalErrors}`);
console.log(`Structural ratio: ${totalStructural + totalLLM > 0 ? (totalStructural / (totalStructural + totalLLM) * 100).toFixed(1) : 0}%`);
