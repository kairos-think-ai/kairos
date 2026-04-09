/**
 * kairos_connections — find connected conversations.
 * Simplified for HTTP MCP endpoint.
 */

import { createServiceClient } from '@/lib/supabase/server';

export async function handleConnections(args: { conversation_id?: string; topic?: string; min_strength?: number }, userToken?: string) {
  try {
    const supabase = createServiceClient();

    let userId: string | null = null;
    if (userToken) {
      const { data: { user } } = await supabase.auth.getUser(userToken);
      userId = user?.id || null;
    }
    if (!userId) return { content: [{ type: 'text' as const, text: 'Not authenticated.' }] };

    const minStrength = args.min_strength || 0.1;

    const { data: connections } = await supabase
      .from('conversation_connections')
      .select('conversation_a_id, conversation_b_id, connection_type, strength, description')
      .eq('user_id', userId)
      .gte('strength', minStrength)
      .order('strength', { ascending: false })
      .limit(20);

    if (!connections || connections.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No connections found. Build connections by running the analysis pipeline.' }] };
    }

    // Get conversation titles
    const ids = [...new Set(connections.flatMap((c: any) => [c.conversation_a_id, c.conversation_b_id]))];
    const { data: convos } = await supabase
      .from('conversations')
      .select('id, title')
      .in('id', ids);

    const titleMap = new Map((convos || []).map((c: any) => [c.id, c.title || 'Untitled']));

    const lines = connections.map((c: any) =>
      `- **${titleMap.get(c.conversation_a_id)}** ↔ **${titleMap.get(c.conversation_b_id)}** (strength: ${c.strength.toFixed(2)}, type: ${c.connection_type})`
    );

    return {
      content: [{ type: 'text' as const, text: `## Connections\n\n${lines.join('\n')}` }],
    };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Connections failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}
