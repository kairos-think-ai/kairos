import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/extension/briefing
 *
 * Returns a compact pre-session briefing for the extension popup.
 * The agent's first "push channel" — proactively surfaces useful
 * knowledge when the user opens the extension before an AI conversation.
 *
 * Gathers 4 signals in parallel (all from existing tables, no LLM calls):
 * 1. Ideas due for SM-2 resurfacing
 * 2. Most recent prompt lesson
 * 3. Most active idea cluster
 * 4. Latest coaching insight
 *
 * Designed for <100ms response time.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json(
      { error: 'Invalid token' },
      { status: 401, headers: CORS_HEADERS }
    );
  }

  try {
    // Gather all briefing data in parallel — 4 lightweight queries
    const [dueIdeasRes, promptLessonRes, activeClusterRes, coachingRes] = await Promise.all([
      // 1. Ideas due for SM-2 resurfacing (uses existing RPC)
      supabase.rpc('get_due_ideas', {
        p_user_id: user.id,
        max_count: 2,
      }),

      // 2. Most recent prompt lesson
      supabase
        .from('ideas')
        .select('id, summary, context, category, importance_score, created_at')
        .eq('user_id', user.id)
        .eq('category', 'prompt_lesson')
        .order('created_at', { ascending: false })
        .limit(1),

      // 3. Most active idea cluster
      supabase
        .from('idea_clusters')
        .select('id, label, idea_count, recurrence_count, last_seen_at')
        .eq('user_id', user.id)
        .order('last_seen_at', { ascending: false })
        .limit(1),

      // 4. Latest coaching insight (OIE format)
      supabase
        .from('coaching_insights')
        .select('id, observation, implication, experiment, category, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    // Shape the resurface ideas
    const resurfaceIdeas = (dueIdeasRes.data || []).map((idea: any) => ({
      id: idea.id || idea.idea_id,
      summary: idea.summary,
      category: idea.category,
      timesSurfaced: idea.times_surfaced || 0,
    }));

    // Shape the prompt lesson
    const lessonRow = promptLessonRes.data?.[0];
    const promptLesson = lessonRow
      ? {
          summary: lessonRow.summary,
          context: lessonRow.context,
          worked: lessonRow.importance_score < 0.65, // 0.6 = positive, 0.7 = negative
        }
      : null;

    // Shape the active cluster
    const clusterRow = activeClusterRes.data?.[0];
    const activeCluster = clusterRow
      ? {
          label: clusterRow.label,
          ideaCount: clusterRow.idea_count,
          recurrenceCount: clusterRow.recurrence_count,
        }
      : null;

    // Shape the coaching insight
    const coachingRow = coachingRes.data?.[0];
    const coachingInsight = coachingRow
      ? {
          observation: coachingRow.observation,
          experiment: coachingRow.experiment,
        }
      : null;

    return NextResponse.json(
      {
        briefing: {
          resurfaceIdeas,
          promptLesson,
          activeCluster,
          coachingInsight,
          generatedAt: new Date().toISOString(),
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('[Extension Briefing] Error:', error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
