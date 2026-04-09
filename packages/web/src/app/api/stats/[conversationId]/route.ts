import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/stats/:conversationId
 *
 * Returns per-conversation stats: engagement breakdown, drift, ideas, entities.
 * User-facing: "Conversation Detail"
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { conversationId: string } }
) {
  const supabase = createServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(
    request.headers.get('Authorization')?.slice(7) || ''
  );
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const convoId = params.conversationId;

  // Get conversation
  const { data: convo } = await supabase
    .from('conversations')
    .select('id, title, platform, started_at, message_count, summary, engagement_profile, behavioral_profile, analysis_status')
    .eq('id', convoId)
    .eq('user_id', user.id)
    .single();

  if (!convo) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  // Get drift report
  const { data: drift } = await supabase
    .from('drift_reports')
    .select('inferred_intent, intent_category, drift_score, drift_category, actual_outcome, trajectory')
    .eq('conversation_id', convoId)
    .single();

  // Get ideas
  const { data: ideas } = await supabase
    .from('ideas')
    .select('id, summary, category, importance_score, source_quote')
    .eq('conversation_id', convoId)
    .order('importance_score', { ascending: false });

  // Get turn-level engagement classifications
  const { data: engagements } = await supabase
    .from('turn_engagement')
    .select('sequence, state, confidence, classification_method, reasoning')
    .eq('conversation_id', convoId)
    .order('sequence');

  // Get entities mentioned in this conversation
  const { data: mentions } = await supabase
    .from('entity_mentions')
    .select('entity_id, context')
    .eq('conversation_id', convoId);

  let entities: any[] = [];
  if (mentions && mentions.length > 0) {
    const entityIds = [...new Set(mentions.map((m: any) => m.entity_id))];
    const { data: entityData } = await supabase
      .from('entities')
      .select('id, name, type, importance_score')
      .in('id', entityIds)
      .neq('status', 'archived');
    entities = entityData || [];
  }

  // Get project associations
  const { data: projectLinks } = await supabase
    .from('conversation_projects')
    .select('project_id, confidence, source')
    .eq('conversation_id', convoId);

  let projects: any[] = [];
  if (projectLinks && projectLinks.length > 0) {
    const projectIds = projectLinks.map((l: any) => l.project_id);
    const { data: projectData } = await supabase
      .from('projects')
      .select('id, label')
      .in('id', projectIds);
    projects = (projectData || []).map((p: any) => ({
      ...p,
      confidence: projectLinks.find((l: any) => l.project_id === p.id)?.confidence,
    }));
  }

  return NextResponse.json({
    conversation: {
      id: convo.id,
      title: convo.title,
      platform: convo.platform,
      startedAt: convo.started_at,
      messageCount: convo.message_count,
      summary: convo.summary,
      analysisStatus: convo.analysis_status,
    },
    drift: drift ? {
      intent: drift.inferred_intent,
      intentCategory: drift.intent_category,
      score: drift.drift_score,
      category: drift.drift_category,
      outcome: drift.actual_outcome,
      trajectory: drift.trajectory,
    } : null,
    engagement: {
      profile: convo.engagement_profile,
      turns: engagements || [],
    },
    ideas: ideas || [],
    entities,
    projects,
  });
}
