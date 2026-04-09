/**
 * kairos_resurface — spaced repetition ideas.
 * Simplified for HTTP MCP endpoint.
 */

import { createServiceClient } from '@/lib/supabase/server';

export async function handleResurface(maxIdeas: number, engage?: { idea_id: string; action: string }, userToken?: string) {
  try {
    const supabase = createServiceClient();

    let userId: string | null = null;
    if (userToken) {
      const { data: { user } } = await supabase.auth.getUser(userToken);
      userId = user?.id || null;
    }
    if (!userId) return { content: [{ type: 'text' as const, text: 'Not authenticated.' }] };

    // Handle engagement
    if (engage) {
      const { error } = await supabase.rpc('update_resurfacing_after_engagement', {
        p_resurfacing_id: engage.idea_id,
        p_engagement_type: engage.action,
      });
      if (error) {
        return { content: [{ type: 'text' as const, text: `Engagement failed: ${error.message}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Engagement recorded: ${engage.action}` }] };
    }

    // Fetch due ideas
    const { data: ideas, error } = await supabase.rpc('get_due_ideas', {
      p_user_id: userId,
      max_count: maxIdeas,
    });

    if (error) {
      return { content: [{ type: 'text' as const, text: `Resurface failed: ${error.message}` }], isError: true };
    }

    if (!ideas || ideas.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No ideas due for resurfacing. All caught up!' }] };
    }

    const lines = ideas.map((idea: any) =>
      `### ${idea.category}\n` +
      `"${idea.summary}"\n` +
      `Importance: ${(idea.importance_score || 0).toFixed(1)} · ` +
      `Surfaced ${idea.times_surfaced || 0}x · ` +
      `Interval: ${idea.interval_days || 1}d`
    );

    return {
      content: [{ type: 'text' as const, text: `## Ideas to Revisit\n\n${lines.join('\n\n')}` }],
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Resurface failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}
