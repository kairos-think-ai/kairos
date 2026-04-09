/**
 * Standalone analysis runner — processes pending conversations.
 * Uses raw fetch to Supabase + Anthropic API directly.
 * Avoids needing to boot the Next.js app.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-5-20250929';

const sbHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, ...opts.headers }, ...opts });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getDefaultUserId() {
  const [user] = await sb('users?select=id&limit=1');
  if (!user) { console.error('No user found. Set KAIROS_USER_ID env var.'); process.exit(1); }
  return user.id;
}

const USER_ID = process.env.KAIROS_USER_ID || await getDefaultUserId();

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
}

// Skill prompts (simplified versions)
const IDEA_PROMPT = (convo) => `You are an idea extraction engine. Analyze this AI conversation and extract discrete ideas, decisions, insights, or important points.

Return a JSON array of objects with: summary (1-2 sentences), context (surrounding context), category (one of: product, technical, strategic, personal, creative, research), importanceScore (0.0-1.0).

Conversation:
${convo}

Return ONLY valid JSON array, no markdown fences.`;

const INTENT_PROMPT = (first) => `Analyze the first few messages of this AI conversation and determine the user's original intent.

Return a JSON object with: inferredIntent (1-2 sentence description), intentCategory (one of: coding, writing, research, planning, debugging, learning, brainstorming, other), intentConfidence (0.0-1.0).

First messages:
${first}

Return ONLY valid JSON object, no markdown fences.`;

const DRIFT_PROMPT = (intent, convo) => `Analyze this AI conversation for topic drift. The user's original intent was: "${intent}"

Return a JSON object with: actualOutcome (what actually happened), outcomeCategory (coding/writing/research/planning/debugging/learning/brainstorming/other), driftScore (0.0=on track to 1.0=completely off), driftCategory (on_track/productive_drift/rabbit_hole/context_switch/exploratory), trajectory (array of {topic, messageRange: [start, end]}).

Conversation:
${convo}

Return ONLY valid JSON object, no markdown fences.`;

// Get pending conversations
const pending = await sb(
  `conversations?select=id,title,message_count&user_id=eq.${USER_ID}&analysis_status=eq.pending&order=started_at.asc&limit=100`
);
console.log(`Found ${pending.length} pending conversations\n`);

let analyzed = 0, failed = 0;

for (const convo of pending) {
  console.log(`\n--- [${analyzed + failed + 1}/${pending.length}] "${convo.title || 'Untitled'}" (${convo.message_count} msgs) ---`);

  if (convo.message_count === 0) {
    console.log('  Skipping: no messages');
    await sb(`conversations?id=eq.${convo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ analysis_status: 'completed' }),
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    analyzed++;
    continue;
  }

  // Fetch messages
  const messages = await sb(
    `messages?select=role,content,sequence&conversation_id=eq.${convo.id}&order=sequence.asc`
  );

  const formatted = messages.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
  const firstMsgs = messages.slice(0, 4).map(m => `[${m.role}]: ${m.content}`).join('\n\n');

  // Mark as processing
  await sb(`conversations?id=eq.${convo.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ analysis_status: 'processing' }),
    headers: { ...sbHeaders, Prefer: 'return=minimal' },
  });

  try {
    // Run skills
    console.log('  Running idea extraction...');
    const ideas = await callClaude(IDEA_PROMPT(formatted)).catch(e => { console.error('  Ideas failed:', e.message); return []; });

    console.log('  Running intent classification...');
    const intent = await callClaude(INTENT_PROMPT(firstMsgs)).catch(e => { console.error('  Intent failed:', e.message); return null; });

    let drift = null;
    if (intent) {
      console.log('  Running drift analysis...');
      drift = await callClaude(DRIFT_PROMPT(intent.inferredIntent, formatted)).catch(e => { console.error('  Drift failed:', e.message); return null; });
    }

    // Store ideas
    if (Array.isArray(ideas) && ideas.length > 0) {
      await sb('ideas', {
        method: 'POST',
        body: JSON.stringify(ideas.map(idea => ({
          user_id: USER_ID,
          conversation_id: convo.id,
          summary: idea.summary,
          context: idea.context || '',
          category: idea.category || 'other',
          importance_score: idea.importanceScore || 0.5,
        }))),
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
      });
      console.log(`  Stored ${ideas.length} ideas`);
    }

    // Store drift report
    if (intent && drift) {
      await sb('drift_reports', {
        method: 'POST',
        body: JSON.stringify({
          conversation_id: convo.id,
          user_id: USER_ID,
          inferred_intent: intent.inferredIntent,
          intent_category: intent.intentCategory,
          intent_confidence: intent.intentConfidence,
          actual_outcome: drift.actualOutcome,
          outcome_category: drift.outcomeCategory,
          drift_score: drift.driftScore,
          drift_category: drift.driftCategory,
          trajectory: drift.trajectory || [],
        }),
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
      });
      console.log(`  Drift: ${drift.driftCategory} (${drift.driftScore})`);
    }

    // Generate summary for the conversation (for kairos_recall)
    const summary = ideas.length > 0
      ? ideas.slice(0, 3).map(i => i.summary).join('. ')
      : intent?.inferredIntent || '';

    // Mark completed + store summary
    await sb(`conversations?id=eq.${convo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ analysis_status: 'completed', summary }),
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });

    analyzed++;
    console.log(`  ✓ Done`);

  } catch (err) {
    console.error(`  ✗ Failed: ${err.message}`);
    await sb(`conversations?id=eq.${convo.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ analysis_status: 'failed' }),
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
    });
    failed++;
  }
}

console.log(`\n\n=== Analysis Complete ===`);
console.log(`Analyzed: ${analyzed}, Failed: ${failed}`);

// Final counts
const ideasCount = await fetch(`${SUPABASE_URL}/rest/v1/ideas?select=id&user_id=eq.${USER_ID}`, {
  headers: { ...sbHeaders, Prefer: 'count=exact' },
});
console.log(`Total ideas in DB: ${ideasCount.headers.get('content-range')}`);
