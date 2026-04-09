import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/concepts/:entityId
 *
 * Returns detail for a single concept: related conversations, ideas, stats.
 * Used when user clicks a node in the Explore view.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { entityId: string } }
) {
  const supabase = createServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(
    request.headers.get('Authorization')?.slice(7) || ''
  );
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const entityId = params.entityId;

  // Get entity details
  const { data: entity } = await supabase
    .from('entities')
    .select('*')
    .eq('id', entityId)
    .single();

  if (!entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  // Get conversations mentioning this entity
  const { data: mentions } = await supabase
    .from('entity_mentions')
    .select('conversation_id, context, sentiment')
    .eq('entity_id', entityId);

  const convoIds = [...new Set((mentions || []).map((m: any) => m.conversation_id))];

  // Get conversation details
  let conversations: any[] = [];
  if (convoIds.length > 0) {
    const { data: convos } = await supabase
      .from('conversations')
      .select('id, title, started_at, message_count, engagement_profile')
      .in('id', convoIds)
      .order('started_at', { ascending: false });
    conversations = convos || [];
  }

  // Get ideas from these conversations
  let ideas: any[] = [];
  if (convoIds.length > 0) {
    const { data: ideaData } = await supabase
      .from('ideas')
      .select('id, summary, category, importance_score, conversation_id')
      .in('conversation_id', convoIds)
      .order('importance_score', { ascending: false })
      .limit(10);
    ideas = ideaData || [];
  }

  // Get drift reports for these conversations
  let driftReports: any[] = [];
  if (convoIds.length > 0) {
    const { data: drifts } = await supabase
      .from('drift_reports')
      .select('conversation_id, drift_score, drift_category')
      .in('conversation_id', convoIds);
    driftReports = drifts || [];
  }

  // Get connected entities (share conversations with this entity)
  const { data: allMentions } = await supabase
    .from('entity_mentions')
    .select('entity_id, conversation_id')
    .in('conversation_id', convoIds)
    .neq('entity_id', entityId)
    .limit(500);

  const connectedCounts: Record<string, number> = {};
  for (const m of (allMentions || [])) {
    connectedCounts[m.entity_id] = (connectedCounts[m.entity_id] || 0) + 1;
  }

  const connectedEntityIds = Object.entries(connectedCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id]) => id);

  let connectedEntities: any[] = [];
  if (connectedEntityIds.length > 0) {
    const { data: connected } = await supabase
      .from('entities')
      .select('id, name, type, importance_score')
      .in('id', connectedEntityIds)
      .neq('status', 'archived');
    connectedEntities = (connected || []).map((e: any) => ({
      ...e,
      sharedConversations: connectedCounts[e.id] || 0,
    }));
  }

  return NextResponse.json({
    entity,
    conversations: conversations.map(c => ({
      id: c.id,
      title: c.title,
      startedAt: c.started_at,
      messageCount: c.message_count,
      drift: driftReports.find(d => d.conversation_id === c.id),
      engagement: c.engagement_profile,
    })),
    ideas,
    connectedEntities: connectedEntities.sort((a, b) => b.sharedConversations - a.sharedConversations),
  });
}
