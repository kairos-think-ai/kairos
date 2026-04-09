import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/metrics
 *
 * Returns the 7 Universal Metrics aggregated from engagement profiles.
 * User-facing names: "Your Thinking Patterns"
 */
export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(
    request.headers.get('Authorization')?.slice(7) || ''
  );
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get conversations with engagement profiles
  const { data: convos } = await supabase
    .from('conversations')
    .select('engagement_profile, analysis_status')
    .eq('user_id', user.id)
    .eq('analysis_status', 'completed')
    .not('engagement_profile', 'is', null);

  if (!convos || convos.length === 0) {
    return NextResponse.json({
      totalConversations: 0,
      metrics: null,
      engagement: null,
      message: 'No engagement data yet. Import and analyze conversations first.',
    });
  }

  // Aggregate engagement profiles
  const profiles = convos.map((c: any) => c.engagement_profile).filter(Boolean);
  const states = ['DEEP_ENGAGEMENT', 'PASSIVE_ACCEPTANCE', 'VERIFICATION', 'PROMPT_CRAFTING', 'REDIRECTING', 'DEFERRED'];

  const avgDist: Record<string, number> = {};
  for (const s of states) {
    const vals = profiles.map((p: any) => p.stateDistribution?.[s] || 0);
    avgDist[s] = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
  }

  const avgVerification = profiles.reduce((sum: number, p: any) => sum + (p.verificationRate || 0), 0) / profiles.length;
  const avgGeneration = profiles.reduce((sum: number, p: any) => sum + (p.generationRatio || 0), 0) / profiles.length;
  const avgPassive = profiles.reduce((sum: number, p: any) => sum + (p.passiveAcceptanceRate || 0), 0) / profiles.length;

  // Get drift stats
  const { data: drifts } = await supabase
    .from('drift_reports')
    .select('drift_score, drift_category')
    .eq('user_id', user.id);

  const avgDrift = drifts && drifts.length > 0
    ? drifts.reduce((sum: number, d: any) => sum + d.drift_score, 0) / drifts.length
    : 0;

  // Get total conversations
  const { count: totalConvos } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);

  // Get total ideas
  const { count: totalIdeas } = await supabase
    .from('ideas')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);

  return NextResponse.json({
    totalConversations: totalConvos || 0,
    totalIdeas: totalIdeas || 0,
    classifiedConversations: profiles.length,
    metrics: {
      verificationRate: avgVerification,
      generationRatio: avgGeneration,
      passiveAcceptanceRate: avgPassive,
      driftRate: avgDrift,
      // These require additional computation
      discoveryEntropy: null,  // TODO: aggregate from per-conversation stats
      ideaFollowThrough: null, // TODO: compute from resurfacing engagement
      cognitiveLoad: null,     // TODO: aggregate from per-conversation stats
    },
    engagement: {
      stateDistribution: avgDist,
      totalStructural: profiles.reduce((sum: number, p: any) => sum + (p.structurallyClassified || 0), 0),
      totalLLM: profiles.reduce((sum: number, p: any) => sum + (p.llmClassified || 0), 0),
    },
  });
}
