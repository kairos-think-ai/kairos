import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/resurface
 * Returns ideas due for resurfacing (SM-2 scheduled).
 *
 * POST /api/resurface
 * Records user engagement with a resurfaced idea.
 * Body: { resurfacingId: string, engagement: 'click' | 'revisit' | 'dismiss' | 'act' }
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
    const { data, error } = await supabase.rpc('get_due_ideas', {
      p_user_id: user.id,
      max_count: 5,
    });

    if (error) throw error;

    // The RPC doesn't return idea_resurfacing.id, but the UI needs it
    // for engagement recording. Look it up separately.
    const ideaIds = (data || []).map((d: any) => d.idea_id);
    let resurfacingMap = new Map<string, string>();

    if (ideaIds.length > 0) {
      const { data: resurfacingRows } = await supabase
        .from('idea_resurfacing')
        .select('id, idea_id')
        .in('idea_id', ideaIds)
        .eq('user_id', user.id);

      resurfacingMap = new Map(
        (resurfacingRows || []).map((r: any) => [r.idea_id, r.id])
      );
    }

    const ideas = (data || []).map((idea: any) => ({
      ...idea,
      resurfacing_id: resurfacingMap.get(idea.idea_id) || null,
    }));

    return NextResponse.json({ ideas });
  } catch (error) {
    console.error('[Resurface API] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

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
    const body = await request.json();
    const { resurfacingId, engagement } = body;

    if (!resurfacingId || !['click', 'revisit', 'dismiss', 'act'].includes(engagement)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { error } = await supabase.rpc('update_resurfacing_after_engagement', {
      p_resurfacing_id: resurfacingId,
      p_engagement_type: engagement,
    });

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Resurface API] Engagement error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
