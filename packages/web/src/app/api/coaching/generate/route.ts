import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getAnthropicClient, AnthropicKeyError } from '@/lib/anthropic';
import { AI_INTERACTION_COACH_PROMPT } from '@/lib/prompts/skills';

const MODEL = 'claude-sonnet-4-5-20250929';

/**
 * POST /api/coaching/generate
 *
 * Manually triggers coaching insight generation for the current user.
 * Gathers the user's recent data, calls Claude with the AI Interaction Coach
 * prompt, and stores the resulting OIE-structured insights.
 *
 * This replaces waiting for the weekly cron — useful during alpha and
 * for on-demand coaching after importing conversations.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  try {
    // Analysis period: all time during alpha (imported data can be months old)
    // Once live capture is active, narrow to 30 days.
    const periodEnd = new Date();
    const periodStart = new Date('2020-01-01');

    // Gather all data needed for the coaching prompt in parallel
    const [
      conversationsRes,
      ideasRes,
      driftRes,
      sessionsRes,
      clustersRes,
    ] = await Promise.all([
      // Conversations in period
      supabase
        .from('conversations')
        .select('id, platform, title, started_at, message_count')
        .eq('user_id', user.id)
        .gte('started_at', periodStart.toISOString())
        .order('started_at', { ascending: false }),

      // Ideas in period
      supabase
        .from('ideas')
        .select('id, summary, category, importance_score, created_at')
        .eq('user_id', user.id)
        .gte('created_at', periodStart.toISOString())
        .order('created_at', { ascending: false }),

      // Drift reports in period
      supabase
        .from('drift_reports')
        .select('drift_score, drift_category, trajectory')
        .eq('user_id', user.id)
        .gte('created_at', periodStart.toISOString()),

      // Sessions in period
      supabase
        .from('sessions')
        .select('id, started_at, ended_at, conversation_ids')
        .eq('user_id', user.id)
        .gte('started_at', periodStart.toISOString()),

      // Idea clusters
      supabase
        .from('idea_clusters')
        .select('label, idea_count, recurrence_count')
        .eq('user_id', user.id)
        .order('last_seen_at', { ascending: false })
        .limit(10),
    ]);

    const conversations = conversationsRes.data || [];
    const ideas = ideasRes.data || [];
    const driftReports = driftRes.data || [];
    const sessions = sessionsRes.data || [];
    const clusters = clustersRes.data || [];

    // Need at least some data to generate meaningful coaching
    if (conversations.length === 0) {
      return NextResponse.json({
        error: 'Not enough data to generate coaching insights. Import some conversations first.',
      }, { status: 400 });
    }

    // Compute aggregate metrics for the prompt
    const platforms = [...new Set(conversations.map((c: any) => c.platform))];
    const avgDrift = driftReports.length > 0
      ? (driftReports.reduce((sum: number, d: any) => sum + d.drift_score, 0) / driftReports.length).toFixed(2)
      : '0';

    const avgSessionDuration = sessions.length > 0
      ? (() => {
          const durations = sessions
            .filter((s: any) => s.ended_at)
            .map((s: any) => (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000);
          return durations.length > 0
            ? `${Math.round(durations.reduce((a: number, b: number) => a + b, 0) / durations.length)} minutes`
            : 'unknown';
        })()
      : 'unknown';

    const categoryCounts = ideas.reduce((acc: Record<string, number>, i: any) => {
      acc[i.category] = (acc[i.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const topCategories = Object.entries(categoryCounts)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 5)
      .map(([cat, count]) => `${cat} (${count})`)
      .join(', ');

    const platformCounts = conversations.reduce((acc: Record<string, number>, c: any) => {
      acc[c.platform] = (acc[c.platform] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const platformDistribution = Object.entries(platformCounts)
      .map(([p, count]) => `${p}: ${count}`)
      .join(', ');

    const recurringThemes = clusters
      .filter((c: any) => c.recurrence_count > 1)
      .map((c: any) => `${c.label} (${c.recurrence_count}x)`)
      .join(', ') || 'None detected yet';

    // Fill the prompt template
    const prompt = AI_INTERACTION_COACH_PROMPT
      .replace('{totalConversations}', String(conversations.length))
      .replace('{platforms}', platforms.join(', '))
      .replace('{avgDrift}', avgDrift)
      .replace('{sessionCount}', String(sessions.length))
      .replace('{avgSessionDuration}', avgSessionDuration)
      .replace('{ideasExtracted}', String(ideas.length))
      .replace('{topCategories}', topCategories || 'None')
      .replace('{recurringThemes}', recurringThemes)
      .replace('{platformDistribution}', platformDistribution);

    // Call Claude
    const anthropic = await getAnthropicClient(user.id);
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    // Parse the JSON response
    const responseText = response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    // Extract JSON array from response (may be wrapped in markdown code blocks)
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[Coaching Generate] Failed to parse response:', responseText);
      return NextResponse.json({ error: 'Failed to parse coaching response' }, { status: 500 });
    }

    const insights = JSON.parse(jsonMatch[0]);

    // Store insights in the database
    const insightRows = insights.map((insight: any) => ({
      user_id: user.id,
      observation: insight.observation,
      implication: insight.implication || null,
      experiment: insight.experiment || null,
      category: insight.category || 'attention_pattern',
      data_points: conversations.length + ideas.length + driftReports.length,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    }));

    const { data: stored, error: insertError } = await supabase
      .from('coaching_insights')
      .insert(insightRows)
      .select('id, observation, implication, experiment, category, period_start, period_end, created_at');

    if (insertError) {
      console.error('[Coaching Generate] Insert error:', insertError);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({
      generated: stored?.length || 0,
      insights: stored || [],
    });
  } catch (error) {
    if (error instanceof AnthropicKeyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Coaching Generate] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
