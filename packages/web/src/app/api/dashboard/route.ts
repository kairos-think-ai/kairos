import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import {
  computeConversationProfile,
  computeWeeklyFingerprint,
  classifyInteractionStyle,
  computeFluencyScore,
  computeRelationshipHealth,
  type MessageData,
  type ConversationData,
} from '@/lib/kairos-engine/behavioral-signals';

/**
 * GET /api/dashboard
 *
 * Returns all data needed to render the Kairos dashboard:
 * - Idea clusters
 * - Recent drift reports
 * - Forgotten threads
 * - Revisit moments
 * - Summary stats
 * - Behavioral signals (weekly fingerprint, engagement profiles, interaction style)
 */
export async function GET(request: NextRequest) {
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
    // Behavioral analysis window: all time during alpha (imported data can be months old)
    // Once live capture is active, narrow to 30 days.
    const lookbackStart = new Date('2020-01-01');
    const weekStart = lookbackStart.toISOString();

    // Fetch all dashboard data in parallel
    const [
      conversationsRes,
      ideasRes,
      clustersRes,
      driftRes,
      actionItemsRes,
      revisitRes,
      recentMessagesRes,
    ] = await Promise.all([
      // Total conversations (include metadata for prompt efficiency scores)
      supabase
        .from('conversations')
        .select('id, platform, title, started_at, message_count, analysis_status, metadata')
        .eq('user_id', user.id)
        .order('started_at', { ascending: false })
        .limit(100),

      // All ideas with conversation context
      supabase
        .from('ideas')
        .select(`
          id, summary, context, category, importance_score, created_at,
          conversations(title, platform, started_at)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200),

      // Idea clusters
      supabase
        .from('idea_clusters')
        .select(`
          id, label, description, idea_count, recurrence_count,
          first_seen_at, last_seen_at
        `)
        .eq('user_id', user.id)
        .order('last_seen_at', { ascending: false }),

      // Drift reports
      supabase
        .from('drift_reports')
        .select(`
          id, inferred_intent, actual_outcome, drift_score, drift_category,
          trajectory, intent_category,
          conversations(id, title, platform, started_at)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50),

      // Active action items (not completed/dismissed)
      supabase
        .from('action_items')
        .select(`
          id, description, status, surfaced_at, stale_after_days,
          conversations(title, platform)
        `)
        .eq('user_id', user.id)
        .in('status', ['surfaced', 'acknowledged'])
        .order('surfaced_at', { ascending: false }),

      // Unseen revisit moments
      supabase
        .from('revisit_moments')
        .select('*')
        .eq('user_id', user.id)
        .is('dismissed_at', null)
        .order('importance_score', { ascending: false })
        .limit(20),

      // Messages from last 7 days for behavioral signal computation
      // Joins through conversations to get platform + started_at for each message's conversation
      // Filter via conversations.user_id (not messages.user_id which may be NULL)
      // Filter via timestamp (actual conversation time, not created_at which is import time)
      supabase
        .from('messages')
        .select('conversation_id, role, content, timestamp, sequence, conversations!inner(id, platform, started_at, message_count)')
        .eq('conversations.user_id', user.id)
        .gte('timestamp', weekStart)
        .order('sequence', { ascending: true }),
    ]);

    // Calculate stats
    const conversations = conversationsRes.data || [];
    const ideas = ideasRes.data || [];
    const driftReports = driftRes.data || [];
    const actionItems = actionItemsRes.data || [];

    const avgDrift = driftReports.length > 0
      ? driftReports.reduce((sum: number, d: any) => sum + d.drift_score, 0) / driftReports.length
      : 0;

    const platformCounts = conversations.reduce((acc: Record<string, number>, c: any) => {
      acc[c.platform] = (acc[c.platform] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const topPlatform = Object.entries(platformCounts)
      .sort(([, a], [, b]) => (b as number) - (a as number))[0]?.[0] || 'unknown';

    // Compute average prompt efficiency from conversations with efficiency data
    const efficiencyScores = conversations
      .map((c: any) => c.metadata?.prompt_efficiency?.score)
      .filter((s: any): s is number => typeof s === 'number');

    const avgEfficiency = efficiencyScores.length > 0
      ? Math.round(
          (efficiencyScores.reduce((sum: number, s: number) => sum + s, 0) / efficiencyScores.length) * 100
        ) / 100
      : null;

    // Identify forgotten threads (action items that are stale)
    const now = new Date();
    const forgottenThreads = actionItems
      .filter((item: any) => {
        const surfaced = new Date(item.surfaced_at);
        const daysSince = (now.getTime() - surfaced.getTime()) / (1000 * 60 * 60 * 24);
        return daysSince > (item.stale_after_days || 14) && item.status === 'surfaced';
      })
      .map((item: any) => ({
        id: item.id,
        type: 'action_item' as const,
        description: item.description,
        sourceConversation: (item as any).conversations?.title || 'Unknown',
        platform: (item as any).conversations?.platform || 'unknown',
        daysSinceSurfaced: Math.floor(
          (now.getTime() - new Date(item.surfaced_at).getTime()) / (1000 * 60 * 60 * 24)
        ),
        importanceScore: 0.5,
      }));

    // ============================================================
    // Behavioral Signals Computation (works for both Mirror and Analyst)
    // ============================================================
    const recentMessages = recentMessagesRes.data || [];

    // Group messages by conversation for behavioral analysis
    const conversationMessagesMap = new Map<string, {
      messages: MessageData[];
      platform: string;
      started_at: string;
      message_count: number;
    }>();

    for (const msg of recentMessages) {
      const convId = msg.conversation_id;
      const convMeta = (msg as any).conversations;
      if (!convMeta) continue;

      if (!conversationMessagesMap.has(convId)) {
        conversationMessagesMap.set(convId, {
          messages: [],
          platform: convMeta.platform,
          started_at: convMeta.started_at,
          message_count: convMeta.message_count || 0,
        });
      }
      conversationMessagesMap.get(convId)!.messages.push({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        timestamp: msg.timestamp,
        sequence: msg.sequence,
      });
    }

    // Build ConversationData for fingerprint computation
    const weekConversations: ConversationData[] = [];
    for (const [id, data] of conversationMessagesMap) {
      weekConversations.push({
        id,
        platform: data.platform,
        started_at: data.started_at,
        message_count: data.message_count || data.messages.length,
        messages: data.messages.sort((a, b) => a.sequence - b.sequence),
      });
    }

    // Compute per-conversation engagement profiles (for top 20 conversations)
    const engagementProfiles = weekConversations.slice(0, 20).map(conv =>
      computeConversationProfile(conv.id, conv.messages)
    );

    // Compute weekly fingerprint and interaction style
    const weeklyFingerprint = computeWeeklyFingerprint(weekConversations);
    const interactionStyle = weekConversations.length >= 3
      ? classifyInteractionStyle(weeklyFingerprint, engagementProfiles)
      : null;

    // Compute Fluency Score and Relationship Health signals
    const fluencyScore = computeFluencyScore(weeklyFingerprint, engagementProfiles, weekConversations);
    const relationshipHealth = computeRelationshipHealth(weekConversations);

    return NextResponse.json({
      ideaClusters: clustersRes.data || [],
      ideas: ideas,
      recentDrift: driftReports.map((d: any) => ({
        conversationId: (d as any).conversations?.id,
        conversationTitle: (d as any).conversations?.title || 'Untitled',
        platform: (d as any).conversations?.platform || 'unknown',
        startedAt: (d as any).conversations?.started_at,
        inferredIntent: d.inferred_intent,
        actualOutcome: d.actual_outcome,
        driftScore: d.drift_score,
        driftCategory: d.drift_category,
        trajectory: d.trajectory,
      })),
      forgottenThreads,
      revisitMoments: revisitRes.data || [],
      stats: {
        totalConversations: conversations.length,
        totalIdeas: ideas.length,
        avgDriftScore: Math.round(avgDrift * 100) / 100,
        topPlatform,
        activeThreads: actionItems.length,
        forgottenThreads: forgottenThreads.length,
        avgEfficiency,
      },
      // Behavioral signals — works for both Mirror and Analyst tiers
      behavioral: {
        weeklyFingerprint,
        interactionStyle,
        fluencyScore,
        relationshipHealth,
        engagementProfiles: engagementProfiles.map(p => ({
          conversationId: p.conversationId,
          engagementArc: p.engagementArc,
          questionDensity: p.questionDensity,
          selfCorrectionCount: p.selfCorrectionCount,
          avgUserMessageLength: Math.round(p.avgUserMessageLength),
          userMessageCount: p.userMessageCount,
          userMessageLengths: p.userMessageLengths,
        })),
      },
    });
  } catch (error) {
    console.error('[Dashboard API] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
