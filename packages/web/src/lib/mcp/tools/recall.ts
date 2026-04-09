/**
 * kairos_recall — search past conversations by topic.
 * Simplified version for HTTP MCP endpoint.
 */

import { createServiceClient } from '@/lib/supabase/server';

export async function handleRecall(query: string, maxResults: number, includeMessages: boolean, userToken?: string) {
  try {
    const supabase = createServiceClient();

    let userId: string | null = null;
    if (userToken) {
      const { data: { user } } = await supabase.auth.getUser(userToken);
      userId = user?.id || null;
    }
    if (!userId) return { content: [{ type: 'text' as const, text: 'Not authenticated.' }] };

    // Search entities by name
    const { data: entities } = await supabase
      .from('entities')
      .select('id, name, type, importance_score')
      .eq('user_id', userId)
      .ilike('name', `%${query}%`)
      .neq('status', 'archived')
      .order('importance_score', { ascending: false })
      .limit(5);

    // Get conversations via entity mentions
    const entityIds = (entities || []).map((e: any) => e.id);
    let conversationIds: string[] = [];

    if (entityIds.length > 0) {
      const { data: mentions } = await supabase
        .from('entity_mentions')
        .select('conversation_id')
        .in('entity_id', entityIds)
        .limit(50);
      conversationIds = [...new Set((mentions || []).map((m: any) => m.conversation_id))] as string[];
    }

    // Also search by title
    const { data: titleMatches } = await supabase
      .from('conversations')
      .select('id')
      .eq('user_id', userId)
      .ilike('title', `%${query}%`)
      .limit(10);

    const titleIds = (titleMatches || []).map((c: any) => c.id);
    const allIds = [...new Set([...conversationIds, ...titleIds])].slice(0, maxResults);

    if (allIds.length === 0) {
      return { content: [{ type: 'text' as const, text: `No conversations found for "${query}".` }] };
    }

    // Fetch full conversations
    const { data: conversations } = await supabase
      .from('conversations')
      .select('id, title, platform, started_at, message_count, summary')
      .in('id', allIds);

    // Fetch ideas for these conversations
    const { data: ideas } = await supabase
      .from('ideas')
      .select('summary, category, importance_score, conversation_id')
      .in('conversation_id', allIds)
      .order('importance_score', { ascending: false })
      .limit(20);

    const sections = (conversations || []).map((c: any) => {
      const convIdeas = (ideas || []).filter((i: any) => i.conversation_id === c.id);
      let text = `### ${c.title || 'Untitled'}\n`;
      text += `Platform: ${c.platform} · ${c.message_count} messages · ${c.started_at?.slice(0, 10)}\n`;
      if (c.summary) text += `Summary: ${c.summary}\n`;
      if (convIdeas.length > 0) {
        text += `Ideas:\n${convIdeas.slice(0, 3).map((i: any) => `- ${i.summary} (${i.category})`).join('\n')}`;
      }
      return text;
    });

    return {
      content: [{ type: 'text' as const, text: `## Recall: "${query}"\n\nFound ${conversations?.length || 0} conversations.\n\n${sections.join('\n\n')}` }],
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Recall failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}
