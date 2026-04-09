import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * POST /api/resurface/seed
 *
 * Seeds the SM-2 resurfacing queue with existing ideas.
 * Enrolls high-importance ideas (score >= 0.5) that aren't
 * already in the queue. Sets initial intervals so ideas
 * start appearing immediately.
 *
 * This is a one-time bootstrap for imported conversation data.
 * After this, the post-analysis pipeline will auto-enroll new ideas.
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
    // Get all ideas for this user with importance score >= 0.5
    const { data: ideas, error: ideasError } = await supabase
      .from('ideas')
      .select('id, importance_score, category')
      .eq('user_id', user.id)
      .gte('importance_score', 0.5)
      .order('importance_score', { ascending: false });

    if (ideasError) throw ideasError;
    if (!ideas || ideas.length === 0) {
      return NextResponse.json({ seeded: 0, message: 'No high-importance ideas to seed' });
    }

    // Get existing resurfacing entries to avoid duplicates
    const { data: existing } = await supabase
      .from('idea_resurfacing')
      .select('idea_id')
      .eq('user_id', user.id);

    const existingIds = new Set((existing || []).map((e: any) => e.idea_id));

    // Filter to only ideas not already in the queue
    const newIdeas = ideas.filter((i: any) => !existingIds.has(i.id));

    if (newIdeas.length === 0) {
      return NextResponse.json({ seeded: 0, message: 'All eligible ideas are already in the queue' });
    }

    // Stagger initial surfacing: spread across the next few days
    // Higher importance ideas surface sooner
    const now = new Date();
    const resurfacingRows = newIdeas.map((idea: any, index: number) => {
      // First batch surfaces immediately, subsequent batches stagger by hours
      const hoursDelay = Math.floor(index / 3) * 4; // 3 ideas per batch, 4 hours apart
      const surfaceAt = new Date(now.getTime() + hoursDelay * 60 * 60 * 1000);

      // Determine enrollment reason based on importance
      const reason = idea.importance_score >= 0.8
        ? 'high_importance'
        : idea.importance_score >= 0.6
          ? 'cluster_member'
          : 'unresolved_decision';

      return {
        user_id: user.id,
        idea_id: idea.id,
        interval_days: 1,        // SM-2 initial interval
        ease_factor: 2.5,        // SM-2 default ease
        next_surface_at: surfaceAt.toISOString(),
        times_surfaced: 0,
        enrollment_reason: reason,
        is_active: true,
      };
    });

    // Insert in batches of 50
    let seeded = 0;
    for (let i = 0; i < resurfacingRows.length; i += 50) {
      const batch = resurfacingRows.slice(i, i + 50);
      const { error: insertError } = await supabase
        .from('idea_resurfacing')
        .upsert(batch, { onConflict: 'user_id,idea_id' });

      if (insertError) {
        console.error('[Resurface Seed] Batch insert error:', insertError);
        continue;
      }
      seeded += batch.length;
    }

    return NextResponse.json({
      seeded,
      total_ideas: ideas.length,
      already_queued: existingIds.size,
      message: `Seeded ${seeded} ideas for spaced repetition`,
    });
  } catch (error) {
    console.error('[Resurface Seed] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
