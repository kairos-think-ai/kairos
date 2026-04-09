/**
 * kairos_coach tool handler for the HTTP MCP endpoint.
 * Uses @kairos/core for live classification + the web Supabase client for baseline.
 */

import { createServiceClient } from '@/lib/supabase/server';
import {
  classifyLiveMessages,
  detectDriftFromText,
  compareToBaseline,
  generateCoachingGuidance,
  computeEngagementProfile,
  type CoachMessage,
  type StoredBaseline,
} from '@kairos/core';

interface CoachInput {
  messages?: Array<{ role: string; content: string }>;
  intent?: string;
  focus?: string;
  userToken?: string;
}

export async function handleCoach(args: CoachInput) {
  try {
    // Parse messages
    let messages: CoachMessage[] = [];
    if (args.messages && args.messages.length > 0) {
      messages = args.messages
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
              : String(m.content),
        }));
    }

    if (messages.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No conversation messages to analyze. Pass messages to get coaching.' }],
      };
    }

    // Live classification
    const { classifications, questionDensity, selfCorrectionCount } = classifyLiveMessages(messages);
    const liveProfile = computeEngagementProfile(classifications);
    const drift = detectDriftFromText(messages, args.intent);

    // Fetch baseline from DB
    let baseline: StoredBaseline | null = null;
    if (args.userToken) {
      const supabase = createServiceClient();
      const { data: { user } } = await supabase.auth.getUser(args.userToken);
      if (user) {
        const { data: convos } = await supabase
          .from('conversations')
          .select('engagement_profile')
          .eq('user_id', user.id)
          .not('engagement_profile', 'is', null)
          .limit(50);

        const profiles = (convos || []).map((c: any) => c.engagement_profile).filter(Boolean);
        if (profiles.length > 0) {
          const avg = (key: string) => {
            const vals = profiles.map((p: any) => p[key] || 0);
            return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
          };
          baseline = {
            verificationRate: avg('verificationRate'),
            generationRatio: avg('generationRatio'),
            passiveAcceptanceRate: avg('passiveAcceptanceRate'),
          };
        }
      }
    }

    // Compare + generate coaching
    const deviations = baseline ? compareToBaseline(liveProfile, baseline, questionDensity, selfCorrectionCount) : [];
    const recentStates = classifications.slice(-10).map(c => c.state);
    const coaching = generateCoachingGuidance(deviations, drift, recentStates, []);

    // ── Write back: store conversation + engagement profile ──────
    // This closes the feedback loop — every coached conversation
    // enters the database and updates the baseline for future coaching.
    if (args.userToken) {
      try {
        const supabase = createServiceClient();
        const { data: { user } } = await supabase.auth.getUser(args.userToken);

        if (user) {
          // Generate a stable conversation ID from message content
          const userMsgs = messages.filter(m => m.role === 'user');
          const fingerprint = userMsgs.slice(0, 3).map(m => m.content.slice(0, 100)).join('|');
          const hash = Array.from(new TextEncoder().encode(fingerprint))
            .reduce((h, b) => ((h << 5) - h + b) | 0, 0);
          const platformConvId = `live-coach-${Math.abs(hash).toString(36)}`;

          // Upsert conversation
          const { data: convo } = await supabase
            .from('conversations')
            .upsert({
              user_id: user.id,
              platform: 'claude',
              platform_conversation_id: platformConvId,
              title: args.intent || `Live conversation (${userMsgs.length} turns)`,
              started_at: new Date().toISOString(),
              message_count: messages.length,
              analysis_status: 'completed',
              engagement_profile: liveProfile,
              metadata: { source: 'kairos_coach', analyzed_at: new Date().toISOString() },
            }, {
              onConflict: 'user_id,platform,platform_conversation_id',
            })
            .select('id')
            .single();

          // Store messages if conversation was created/updated
          if (convo?.id) {
            // Delete old messages and re-insert (same pattern as ingest)
            await supabase.from('messages').delete().eq('conversation_id', convo.id);

            const messageRows = messages.map((m, i) => ({
              conversation_id: convo.id,
              user_id: user.id,
              role: m.role,
              content: m.content,
              sequence: i,
              timestamp: new Date().toISOString(),
            }));

            await supabase.from('messages').insert(messageRows);
          }
        }
      } catch {
        // Write-back is best-effort — don't fail the coaching response
      }
    }

    // Format response
    const sections: string[] = [];

    sections.push(
      `## Current Conversation Analysis\n` +
      `- Turns analyzed: ${classifications.length}\n` +
      `- Verification rate: ${(liveProfile.verificationRate * 100).toFixed(0)}%${baseline ? ` (baseline: ${(baseline.verificationRate * 100).toFixed(0)}%)` : ''}\n` +
      `- Generation ratio: ${(liveProfile.generationRatio * 100).toFixed(0)}%${baseline ? ` (baseline: ${(baseline.generationRatio * 100).toFixed(0)}%)` : ''}\n` +
      `- Passive acceptance: ${(liveProfile.passiveAcceptanceRate * 100).toFixed(0)}%${baseline ? ` (baseline: ${(baseline.passiveAcceptanceRate * 100).toFixed(0)}%)` : ''}\n` +
      `- Drift: ${drift.status}${drift.description ? ` — ${drift.description}` : ''}`
    );

    const significant = deviations.filter(d => d.isSignificant);
    if (significant.length > 0) {
      sections.push(`## Alerts\n` + significant.map(d =>
        `- ${d.label}: ${(d.current * 100).toFixed(0)}% (${d.direction} than baseline ${(d.baseline * 100).toFixed(0)}%)`
      ).join('\n'));
    }

    if (coaching.forClaude.length > 0) {
      sections.push(`## Guidance for Claude\n` + coaching.forClaude.map(c => `- ${c}`).join('\n'));
    }

    if (coaching.forUser.length > 0) {
      sections.push(`## Suggestions for the User\n` + coaching.forUser.map(c => `- ${c}`).join('\n'));
    }

    if (significant.length === 0 && coaching.forClaude.length === 0) {
      sections.push('## Status\nEngagement looks healthy. No coaching needed right now.');
    }

    return { content: [{ type: 'text' as const, text: sections.join('\n\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Coach failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}
