import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * POST /api/pipeline/trigger
 *
 * Triggers the full analysis pipeline for a user's pending conversations.
 * Uses the user's own API keys (stored in their settings).
 *
 * Pipeline steps:
 * 1. Analyze conversations (extract ideas, intent, drift) — uses Anthropic key
 * 2. Generate message embeddings — uses OpenAI key
 * 3. Extract entities + build connections — uses Anthropic key
 * 4. Filter entities by importance
 * 5. Classify engagement states — uses Anthropic key
 *
 * Returns: { status, steps: [{name, status, count}], errors: string[] }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401, headers: corsHeaders });
  }

  // Get user's API keys
  const { data: userData } = await supabase
    .from('users')
    .select('settings')
    .eq('id', user.id)
    .single();

  const settings = (userData?.settings || {}) as Record<string, string>;
  const anthropicKey = settings.anthropic_api_key;
  const openaiKey = settings.openai_api_key;

  if (!anthropicKey) {
    return NextResponse.json({
      error: 'Anthropic API key not configured. Go to Settings to add your key.',
    }, { status: 400, headers: corsHeaders });
  }

  if (!openaiKey) {
    return NextResponse.json({
      error: 'OpenAI API key not configured. Go to Settings to add your key.',
    }, { status: 400, headers: corsHeaders });
  }

  // Get pending conversations
  const { data: pending } = await supabase
    .from('conversations')
    .select('id, title, message_count')
    .eq('user_id', user.id)
    .eq('analysis_status', 'pending')
    .gt('message_count', 0)
    .order('started_at');

  if (!pending || pending.length === 0) {
    return NextResponse.json({
      status: 'complete',
      message: 'No pending conversations to analyze.',
      steps: [],
    }, { headers: corsHeaders });
  }

  const results = {
    status: 'running',
    totalConversations: pending.length,
    steps: [] as { name: string; status: string; count: number; errors: number }[],
    errors: [] as string[],
  };

  // ── Step 1: Analyze conversations ────────────────────────────────
  let analyzed = 0;
  let analyzeErrors = 0;

  for (const convo of pending) {
    // Mark as processing
    await supabase
      .from('conversations')
      .update({ analysis_status: 'processing' })
      .eq('id', convo.id);

    // Get messages
    const { data: messages } = await supabase
      .from('messages')
      .select('role, content, sequence')
      .eq('conversation_id', convo.id)
      .order('sequence');

    if (!messages || messages.length === 0) {
      await supabase
        .from('conversations')
        .update({ analysis_status: 'completed' })
        .eq('id', convo.id);
      analyzed++;
      continue;
    }

    const formatted = messages.map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');
    const firstMsgs = messages.slice(0, 4).map((m: any) => `[${m.role}]: ${m.content}`).join('\n\n');

    try {
      // Run idea extraction + intent classification
      const [ideas, intent] = await Promise.all([
        callClaude(anthropicKey, IDEA_PROMPT(formatted)),
        callClaude(anthropicKey, INTENT_PROMPT(firstMsgs)),
      ]);

      // Run drift analysis (depends on intent)
      let drift = null;
      if (intent) {
        drift = await callClaude(anthropicKey, DRIFT_PROMPT(intent.inferredIntent, formatted));
      }

      // Store ideas
      if (Array.isArray(ideas) && ideas.length > 0) {
        await supabase.from('ideas').insert(
          ideas.map((idea: any) => ({
            user_id: user.id,
            conversation_id: convo.id,
            summary: idea.summary,
            context: idea.context || '',
            category: idea.category || 'other',
            importance_score: idea.importanceScore || 0.5,
          }))
        );
      }

      // Store drift report
      if (intent && drift) {
        await supabase.from('drift_reports').upsert({
          conversation_id: convo.id,
          user_id: user.id,
          inferred_intent: intent.inferredIntent,
          intent_category: intent.intentCategory,
          intent_confidence: intent.intentConfidence,
          actual_outcome: drift.actualOutcome,
          outcome_category: drift.outcomeCategory,
          drift_score: drift.driftScore,
          drift_category: drift.driftCategory,
          trajectory: drift.trajectory || [],
        }, { onConflict: 'conversation_id' });
      }

      // Generate summary
      const summary = Array.isArray(ideas) && ideas.length > 0
        ? ideas.slice(0, 3).map((i: any) => i.summary).join('. ')
        : intent?.inferredIntent || '';

      await supabase
        .from('conversations')
        .update({ analysis_status: 'completed', summary })
        .eq('id', convo.id);

      analyzed++;
    } catch (err) {
      analyzeErrors++;
      results.errors.push(`Analysis failed for "${convo.title || 'Untitled'}": ${err instanceof Error ? err.message : String(err)}`);
      await supabase
        .from('conversations')
        .update({ analysis_status: 'failed' })
        .eq('id', convo.id);
    }
  }

  results.steps.push({ name: 'Analyze conversations', status: 'complete', count: analyzed, errors: analyzeErrors });

  // ── Step 2: Generate message embeddings ──────────────────────────
  let embedded = 0;
  let embedErrors = 0;

  const { data: unembeddedConvos } = await supabase
    .from('conversations')
    .select('id, message_count')
    .eq('user_id', user.id)
    .eq('analysis_status', 'completed');

  for (const convo of (unembeddedConvos || [])) {
    // Check if already embedded
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('conversation_id', convo.id)
      .not('embedding', 'is', null)
      .limit(1);

    if (existing && existing.length > 0) continue;

    // Get messages
    const { data: msgs } = await supabase
      .from('messages')
      .select('id, role, content')
      .eq('conversation_id', convo.id)
      .is('embedding', null)
      .order('sequence');

    if (!msgs || msgs.length === 0) continue;

    try {
      const texts = msgs.map((m: any) => {
        const prefix = m.role === 'user' ? '[User] ' : '[Assistant] ';
        const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '...' : m.content;
        return prefix + content;
      });

      // Batch embeddings (64 at a time)
      for (let i = 0; i < texts.length; i += 64) {
        const batch = texts.slice(i, i + 64);
        const batchMsgs = msgs.slice(i, i + 64);

        const embeddings = await callOpenAIEmbeddings(openaiKey, batch);

        for (let j = 0; j < batchMsgs.length; j++) {
          await supabase
            .from('messages')
            .update({ embedding: JSON.stringify(embeddings[j]) })
            .eq('id', batchMsgs[j].id);
        }
        embedded += batchMsgs.length;
      }
    } catch (err) {
      embedErrors++;
      results.errors.push(`Embedding failed for conversation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  results.steps.push({ name: 'Generate embeddings', status: 'complete', count: embedded, errors: embedErrors });

  // ── Step 3: Classify engagement + store profiles ────────────────
  let classified = 0;
  let classifyErrors = 0;

  const { data: classifiableConvos } = await supabase
    .from('conversations')
    .select('id, title, engagement_profile')
    .eq('user_id', user.id)
    .eq('analysis_status', 'completed')
    .is('engagement_profile', null);

  for (const convo of (classifiableConvos || [])) {
    // Skip if already has engagement profile
    if (convo.engagement_profile) continue;

    try {
      const { data: msgs } = await supabase
        .from('messages')
        .select('id, role, content, sequence')
        .eq('conversation_id', convo.id)
        .order('sequence');

      if (!msgs || msgs.length < 2) continue;

      // Classify using structural classifier (no LLM needed)
      const messages = msgs
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const { classifyLiveMessages, computeEngagementProfile } = await import('@kairos/core');
      const { classifications } = classifyLiveMessages(messages);
      const profile = computeEngagementProfile(classifications);

      // Store engagement profile on conversation
      await supabase
        .from('conversations')
        .update({ engagement_profile: profile })
        .eq('id', convo.id);

      // Store per-turn classifications in turn_engagement table
      const userMsgs = msgs.filter((m: any) => m.role === 'user');
      const turnRows = classifications.map((c: any, i: number) => ({
        message_id: userMsgs[i]?.id,
        conversation_id: convo.id,
        user_id: user.id,
        state: c.state,
        confidence: c.confidence,
        classification_method: c.method,
        reasoning: c.reasoning || null,
        sequence: userMsgs[i]?.sequence || i,
      })).filter((r: any) => r.message_id); // Only rows with valid message_id

      if (turnRows.length > 0) {
        await supabase.from('turn_engagement').upsert(turnRows, { onConflict: 'message_id' });
      }

      classified++;
    } catch (err) {
      classifyErrors++;
      results.errors.push(`Engagement classification failed for ${convo.title || convo.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  results.steps.push({ name: 'Classify engagement', status: 'complete', count: classified, errors: classifyErrors });

  results.status = 'complete';
  return NextResponse.json(results, { headers: corsHeaders });
}

// ── Helper functions ────────────────────────────────────────────────

async function callClaude(apiKey: string, prompt: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
}

async function callOpenAIEmbeddings(apiKey: string, texts: string[]) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
      dimensions: 1024,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
}

// ── Simplified prompts (same as run-analysis.mjs) ───────────────────

const IDEA_PROMPT = (convo: string) => `You are an idea extraction engine. Analyze this AI conversation and extract discrete ideas, decisions, insights, or important points.

Return a JSON array of objects with: summary (1-2 sentences), context (surrounding context), category (one of: product, technical, strategic, personal, creative, research), importanceScore (0.0-1.0).

Conversation:
${convo.slice(0, 15000)}

Return ONLY valid JSON array, no markdown fences.`;

const INTENT_PROMPT = (first: string) => `Analyze the first few messages of this AI conversation and determine the user's original intent.

Return a JSON object with: inferredIntent (1-2 sentence description), intentCategory (one of: coding, writing, research, planning, debugging, learning, brainstorming, other), intentConfidence (0.0-1.0).

First messages:
${first.slice(0, 5000)}

Return ONLY valid JSON object, no markdown fences.`;

const DRIFT_PROMPT = (intent: string, convo: string) => `Analyze this AI conversation for topic drift. The user's original intent was: "${intent}"

Return a JSON object with: actualOutcome (what actually happened), outcomeCategory (coding/writing/research/planning/debugging/learning/brainstorming/other), driftScore (0.0=on track to 1.0=completely off), driftCategory (on_track/productive_drift/rabbit_hole/context_switch/exploratory), trajectory (array of {topic, messageRange: [start, end]}).

Conversation:
${convo.slice(0, 15000)}

Return ONLY valid JSON object, no markdown fences.`;
