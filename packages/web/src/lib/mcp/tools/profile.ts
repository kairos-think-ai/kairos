/**
 * kairos_profile tool handler for the HTTP MCP endpoint.
 * Mirrors packages/mcp/src/tools/profile.ts but uses the web package's Supabase client.
 */

import { createServiceClient } from '@/lib/supabase/server';

export async function handleProfile(userToken?: string) {
  try {
    const supabase = createServiceClient();
    const sections: string[] = [];

    // Resolve user ID from token
    let userId: string | null = null;
    if (userToken) {
      const { data: { user } } = await supabase.auth.getUser(userToken);
      userId = user?.id || null;
    }
    if (!userId) {
      return {
        content: [{ type: 'text' as const, text: '## Kairos Thinking Profile\n\nNot authenticated. Please connect with your Kairos account.' }],
      };
    }

    // 1. Engagement metrics
    const { data: engagedConvos } = await supabase
      .from('conversations')
      .select('engagement_profile')
      .eq('user_id', userId)
      .not('engagement_profile', 'is', null)
      .order('started_at', { ascending: false })
      .limit(100);

    const profiles = (engagedConvos || []).map((c: any) => c.engagement_profile).filter(Boolean);

    if (profiles.length > 0) {
      const avg = (key: string) => {
        const vals = profiles.map((p: any) => p[key] || 0);
        return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
      };

      const verificationRate = avg('verificationRate');
      const generationRatio = avg('generationRatio');
      const passiveAcceptanceRate = avg('passiveAcceptanceRate');

      const lines = [
        '### How they think',
        `- Generates own ideas ${(generationRatio * 100).toFixed(0)}% of the time${generationRatio > 0.5 ? ' — ask what they think before explaining' : ''}`,
        `- Verifies AI claims ${(verificationRate * 100).toFixed(0)}% of the time${verificationRate < 0.2 ? ' — show reasoning proactively' : ''}`,
        `- Passively accepts ${(passiveAcceptanceRate * 100).toFixed(0)}% of the time${passiveAcceptanceRate > 0.3 ? ' — invite evaluation before proceeding' : ''}`,
        `- Based on ${profiles.length} classified conversations`,
      ];

      // Drift stats
      const { data: drifts } = await supabase
        .from('drift_reports')
        .select('drift_score')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (drifts && drifts.length > 0) {
        const avgDrift = drifts.reduce((sum: number, d: any) => sum + d.drift_score, 0) / drifts.length;
        lines.push(`- Drifts from intent ${(avgDrift * 100).toFixed(0)}% of the time${avgDrift > 0.4 ? ' — check alignment every 5-6 turns' : ''}`);
      }

      sections.push(lines.join('\n'));
    }

    // 2. Top concepts
    const { data: entities } = await supabase
      .from('entities')
      .select('name, type, importance_score, document_frequency')
      .eq('user_id', userId)
      .neq('status', 'archived')
      .order('importance_score', { ascending: false })
      .limit(20);

    if (entities && entities.length > 0) {
      const deep = entities.filter((e: any) => e.document_frequency >= 3);
      const emerging = entities.filter((e: any) => e.document_frequency >= 1 && e.document_frequency < 3);
      const lines = ['### Their world'];
      if (deep.length > 0) lines.push(`- Deep expertise: ${deep.slice(0, 8).map((e: any) => e.name).join(', ')}`);
      if (emerging.length > 0) lines.push(`- Exploring: ${emerging.slice(0, 6).map((e: any) => e.name).join(', ')}`);
      sections.push(lines.join('\n'));
    }

    // 3. Recent coaching insights
    const { data: insights } = await supabase
      .from('coaching_insights')
      .select('observation, experiment')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(2);

    if (insights && insights.length > 0) {
      const lines = ['### Recent coaching'];
      for (const i of insights) {
        lines.push(`- ${i.observation}${i.experiment ? ` Try: ${i.experiment}` : ''}`);
      }
      sections.push(lines.join('\n'));
    }

    if (sections.length === 0) {
      return {
        content: [{ type: 'text' as const, text: '## Kairos Thinking Profile\n\nNo data yet. Import conversations to build your thinking profile.' }],
      };
    }

    const profile = [
      '## About this user (Kairos Thinking Profile)',
      '',
      ...sections,
      '',
      '### Available tools',
      '- kairos_coach: Analyze current conversation engagement + provide coaching',
      '- kairos_recall: Find related past conversations and ideas by topic',
      '- kairos_reflect: View detailed behavioral patterns and metrics',
      '- kairos_resurface: Get ideas due for spaced repetition review',
      '- kairos_connections: Explore how concepts connect across conversations',
    ].join('\n');

    return { content: [{ type: 'text' as const, text: profile }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Profile failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
