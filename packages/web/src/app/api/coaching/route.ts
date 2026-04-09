import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/coaching
 * Returns coaching insights for the current user (last 4 weeks).
 * Marks unseen insights as seen on fetch.
 *
 * PATCH /api/coaching
 * Records "was this helpful?" feedback on a coaching insight.
 * Body: { insightId: string, helpful: boolean }
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
    
    const sixWeeksAgo = new Date("2020-01-01");

    const { data: insights, error } = await supabase
      .from('coaching_insights')
      .select('id, observation, implication, experiment, category, data_points, period_start, period_end, seen_at, helpful, created_at')
      .eq('user_id', user.id)
      .gte('period_start', sixWeeksAgo.toISOString())
      .order('period_start', { ascending: false });

    if (error) throw error;

    // Mark unseen insights as seen
    const unseenIds = (insights || [])
      .filter((i: { seen_at: string | null }) => !i.seen_at)
      .map((i: { id: string }) => i.id);

    if (unseenIds.length > 0) {
      await supabase
        .from('coaching_insights')
        .update({ seen_at: new Date().toISOString() })
        .in('id', unseenIds);
    }

    return NextResponse.json({ insights: insights || [] });
  } catch (error) {
    console.error('[Coaching API] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
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
    const { insightId, helpful } = body;

    if (!insightId || typeof helpful !== 'boolean') {
      return NextResponse.json({ error: 'Invalid request: insightId and helpful (boolean) required' }, { status: 400 });
    }

    const { error } = await supabase
      .from('coaching_insights')
      .update({ helpful })
      .eq('id', insightId)
      .eq('user_id', user.id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Coaching API] Feedback error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
