import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/trends
 *
 * Returns trend data: dual-timescale EMAs + temporal snapshots.
 * User-facing name: "Your Thinking Over Time"
 *
 * Note: user_trend_state may not be populated yet (Level 4 EMAs
 * need to be wired into the analysis pipeline). This route handles
 * the empty case gracefully.
 */
export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(
    request.headers.get('Authorization')?.slice(7) || ''
  );
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get EMA trend state
  const { data: trendState } = await supabase
    .from('user_trend_state')
    .select('*')
    .eq('user_id', user.id)
    .single();

  // Get temporal snapshots (weekly)
  const { data: snapshots } = await supabase
    .from('temporal_snapshots')
    .select('period_start, period_end, snapshot_type, metrics')
    .eq('user_id', user.id)
    .eq('snapshot_type', 'weekly')
    .order('period_start', { ascending: true })
    .limit(52); // Up to 1 year of weekly snapshots

  // Get conversation count for progressive disclosure
  const { count: totalConvos } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('analysis_status', 'completed');

  // Determine disclosure state
  const disclosureState =
    (totalConvos || 0) === 0 ? 'new' :
    (totalConvos || 0) <= 15 ? 'early' :
    (totalConvos || 0) <= 30 ? 'active' : 'established';

  if (!trendState) {
    return NextResponse.json({
      disclosureState,
      totalConversations: totalConvos || 0,
      trends: null,
      snapshots: [],
      message: disclosureState === 'new'
        ? 'Import conversations to start tracking trends.'
        : disclosureState === 'early'
        ? 'We\'re learning your patterns. Trends will be available after more conversations.'
        : 'Trend computation not yet active. Run the trend population pipeline.',
    });
  }

  // Compute gaps (short-term EMA - long-term EMA) for each metric
  const gaps = {
    drift: trendState.ema_short_drift - trendState.ema_long_drift,
    questionDensity: trendState.ema_short_question_density - trendState.ema_long_question_density,
    conversationDepth: trendState.ema_short_conversation_depth - trendState.ema_long_conversation_depth,
    selfCorrection: trendState.ema_short_self_correction - trendState.ema_long_self_correction,
    messageLength: trendState.ema_short_msg_length - trendState.ema_long_msg_length,
    conversationsPerDay: trendState.ema_short_conversations_per_day - trendState.ema_long_conversations_per_day,
  };

  return NextResponse.json({
    disclosureState,
    totalConversations: totalConvos || 0,
    trends: {
      shortTerm: {
        drift: trendState.ema_short_drift,
        questionDensity: trendState.ema_short_question_density,
        conversationDepth: trendState.ema_short_conversation_depth,
        selfCorrection: trendState.ema_short_self_correction,
        messageLength: trendState.ema_short_msg_length,
        conversationsPerDay: trendState.ema_short_conversations_per_day,
      },
      longTerm: {
        drift: trendState.ema_long_drift,
        questionDensity: trendState.ema_long_question_density,
        conversationDepth: trendState.ema_long_conversation_depth,
        selfCorrection: trendState.ema_long_self_correction,
        messageLength: trendState.ema_long_msg_length,
        conversationsPerDay: trendState.ema_long_conversations_per_day,
      },
      gaps,
      totalConversationsIncorporated: trendState.total_conversations_incorporated,
      lastUpdated: trendState.last_updated_at,
    },
    snapshots: (snapshots || []).map((s: any) => ({
      periodStart: s.period_start,
      periodEnd: s.period_end,
      metrics: s.metrics,
    })),
  });
}
