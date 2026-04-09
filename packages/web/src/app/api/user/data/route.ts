import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * GET /api/user/data
 *
 * Returns counts of all cloud data tables for the current user.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }

  try {
    const [convos, ideas, clusters, driftReports, moments, coaching, resurfacing] = await Promise.all([
      supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('ideas').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('idea_clusters').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('drift_reports').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('revisit_moments').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('coaching_insights').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      supabase.from('idea_resurfacing').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    ]);

    return jsonResponse({
      counts: {
        conversations: convos.count || 0,
        ideas: ideas.count || 0,
        idea_clusters: clusters.count || 0,
        drift_reports: driftReports.count || 0,
        revisit_moments: moments.count || 0,
        coaching_insights: coaching.count || 0,
        idea_resurfacing: resurfacing.count || 0,
      },
    });
  } catch (error) {
    console.error('[User Data] Count error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
}

/**
 * DELETE /api/user/data
 *
 * Delete all of a user's cloud data from Supabase.
 * This is the "Delete my cloud data" action from the extension/dashboard.
 * Local IndexedDB data is unaffected (handled by the extension).
 *
 * Auth: Bearer token (same pattern as /api/ingest)
 */
export async function DELETE(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }

  try {
    const counts: Record<string, number> = {};

    // Delete in order to respect foreign key constraints
    // (most dependent tables first)

    // 1. Revisit moments
    const { count: revisitCount } = await supabase
      .from('revisit_moments')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    counts.revisit_moments = revisitCount || 0;

    // 2. Action items
    const { count: actionCount } = await supabase
      .from('action_items')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    counts.action_items = actionCount || 0;

    // 3. Idea cluster members (via cluster)
    const { data: clusters } = await supabase
      .from('idea_clusters')
      .select('id')
      .eq('user_id', user.id);

    if (clusters && clusters.length > 0) {
      const clusterIds = clusters.map((c: { id: string }) => c.id);
      const { count: memberCount } = await supabase
        .from('idea_cluster_members')
        .delete({ count: 'exact' })
        .in('cluster_id', clusterIds);
      counts.idea_cluster_members = memberCount || 0;
    }

    // 4. Idea clusters
    const { count: clusterCount } = await supabase
      .from('idea_clusters')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    counts.idea_clusters = clusterCount || 0;

    // 5. Ideas
    const { count: ideaCount } = await supabase
      .from('ideas')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    counts.ideas = ideaCount || 0;

    // 6. Drift reports (via conversation)
    const { data: convos } = await supabase
      .from('conversations')
      .select('id')
      .eq('user_id', user.id);

    if (convos && convos.length > 0) {
      const convoIds = convos.map((c: { id: string }) => c.id);
      const { count: driftCount } = await supabase
        .from('drift_reports')
        .delete({ count: 'exact' })
        .in('conversation_id', convoIds);
      counts.drift_reports = driftCount || 0;

      // 7. Messages (via conversation)
      const { count: msgCount } = await supabase
        .from('messages')
        .delete({ count: 'exact' })
        .in('conversation_id', convoIds);
      counts.messages = msgCount || 0;
    }

    // 8. Processing queue
    const { count: queueCount } = await supabase
      .from('processing_queue')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    counts.processing_queue = queueCount || 0;

    // 9. Conversations (last — most other tables reference this)
    const { count: convoCount } = await supabase
      .from('conversations')
      .delete({ count: 'exact' })
      .eq('user_id', user.id);
    counts.conversations = convoCount || 0;

    // 10. Audit log (cloud-side, if it exists)
    try {
      const { count: auditCount } = await supabase
        .from('audit_log')
        .delete({ count: 'exact' })
        .eq('user_id', user.id);
      counts.audit_log = auditCount || 0;
    } catch {
      // audit_log may not exist — that's fine
    }

    console.log(`[User Data] Deleted cloud data for user ${user.id}:`, counts);

    return jsonResponse({
      deleted: true,
      userId: user.id,
      counts,
    });

  } catch (error) {
    console.error('[User Data] Deletion error:', error);
    return jsonResponse({ error: String(error) }, 500);
  }
}
