/**
 * kairos_reflect — behavioral signals + coaching insights.
 * Simplified version for HTTP MCP endpoint.
 */

import { createServiceClient } from '@/lib/supabase/server';

export async function handleReflect(period: string, focus: string, userToken?: string) {
  try {
    const supabase = createServiceClient();

    let userId: string | null = null;
    if (userToken) {
      const { data: { user } } = await supabase.auth.getUser(userToken);
      userId = user?.id || null;
    }
    if (!userId) return { content: [{ type: 'text' as const, text: 'Not authenticated.' }] };

    const now = new Date();
    const periodStart = getPeriodStart(period, now);
    const sections: string[] = [];

    // Engagement metrics
    if (focus === 'all' || focus === 'attention' || focus === 'engagement') {
      const { data: convos } = await supabase
        .from('conversations')
        .select('engagement_profile')
        .eq('user_id', userId)
        .gte('started_at', periodStart.toISOString())
        .not('engagement_profile', 'is', null);

      const profiles = (convos || []).map((c: any) => c.engagement_profile).filter(Boolean);
      if (profiles.length > 0) {
        const avg = (key: string) => {
          const vals = profiles.map((p: any) => p[key] || 0);
          return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
        };

        const states = ['DEEP_ENGAGEMENT', 'PASSIVE_ACCEPTANCE', 'VERIFICATION', 'PROMPT_CRAFTING', 'REDIRECTING', 'DEFERRED'];
        const avgDist: Record<string, number> = {};
        for (const s of states) {
          const vals = profiles.map((p: any) => p.stateDistribution?.[s] || 0);
          avgDist[s] = vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
        }

        sections.push(
          `## Thinking Metrics (${period})\n` +
          `Based on ${profiles.length} conversations.\n\n` +
          `- Verification Rate: ${(avg('verificationRate') * 100).toFixed(1)}%\n` +
          `- Generation Ratio: ${(avg('generationRatio') * 100).toFixed(1)}%\n` +
          `- Passive Acceptance: ${(avg('passiveAcceptanceRate') * 100).toFixed(1)}%\n\n` +
          `Engagement distribution:\n` +
          states.map(s => `- ${s}: ${(avgDist[s] * 100).toFixed(1)}%`).join('\n')
        );
      }
    }

    // Drift
    if (focus === 'all' || focus === 'drift') {
      const { data: drifts } = await supabase
        .from('drift_reports')
        .select('drift_score, drift_category')
        .eq('user_id', userId)
        .gte('created_at', periodStart.toISOString());

      if (drifts && drifts.length > 0) {
        const avgDrift = drifts.reduce((sum: number, d: any) => sum + d.drift_score, 0) / drifts.length;
        sections.push(
          `## Drift Analysis (${period})\n` +
          `- Average drift: ${avgDrift.toFixed(2)}\n` +
          `- Conversations: ${drifts.length}`
        );
      }
    }

    // Coaching
    if (focus === 'all' || focus === 'coaching') {
      const { data: insights } = await supabase
        .from('coaching_insights')
        .select('observation, implication, experiment, category')
        .eq('user_id', userId)
        .gte('created_at', periodStart.toISOString())
        .order('created_at', { ascending: false })
        .limit(3);

      if (insights && insights.length > 0) {
        sections.push(
          `## Coaching Insights\n\n` +
          insights.map((i: any) =>
            `**Observe:** ${i.observation}\n` +
            (i.implication ? `**Implication:** ${i.implication}\n` : '') +
            (i.experiment ? `**Experiment:** ${i.experiment}` : '')
          ).join('\n\n')
        );
      }
    }

    if (sections.length === 0) {
      sections.push('No data available for this period. Import and analyze conversations first.');
    }

    return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Reflect failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

function getPeriodStart(period: string, now: Date): Date {
  const start = new Date(now);
  switch (period) {
    case 'today': start.setHours(0, 0, 0, 0); break;
    case 'week': start.setDate(start.getDate() - 7); break;
    case 'month': start.setMonth(start.getMonth() - 1); break;
    case 'all': start.setFullYear(2020); break;
    default: start.setDate(start.getDate() - 7);
  }
  return start;
}
