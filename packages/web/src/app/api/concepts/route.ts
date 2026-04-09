import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/concepts
 *
 * Returns the entity graph: active concepts + connections.
 * User-facing name: "Your Thinking Map"
 *
 * Response shape matches what react-force-graph expects:
 * { nodes: [...], links: [...] }
 */
export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(
    request.headers.get('Authorization')?.slice(7) || ''
  );
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get active + dormant entities (not archived)
  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, type, importance_score, confidence, document_frequency, status, mention_count')
    .eq('user_id', user.id)
    .neq('status', 'archived')
    .order('importance_score', { ascending: false });

  // Get connections with strength
  const { data: connections } = await supabase
    .from('conversation_connections')
    .select('id, conversation_a_id, conversation_b_id, connection_type, custom_type, strength, description')
    .eq('user_id', user.id)
    .gte('strength', 0.1)
    .order('strength', { ascending: false });

  // Map category → color for visualization
  const categoryColors: Record<string, string> = {
    concept: '#8B5CF6',      // purple
    technology: '#3B82F6',   // blue
    tool: '#06B6D4',         // cyan
    company: '#10B981',      // emerald
    person: '#F59E0B',       // amber
    project_name: '#EC4899', // pink
    decision: '#EF4444',     // red
    goal: '#6366F1',         // indigo
    other: '#6B7280',        // gray
  };

  // Normalize importance to 0-1 range (relative to max in dataset)
  const maxImportance = Math.max(...(entities || []).map((e: any) => e.importance_score || 0), 1);

  // Format as graph data
  const nodes = (entities || []).map((e: any) => {
    const importance = (e.importance_score || 0) / maxImportance; // 0-1
    return {
      id: e.id,
      name: e.name,
      category: e.type,
      importance,
      importanceRaw: e.importance_score,
      confidence: e.confidence,
      documentFrequency: e.document_frequency,
      status: e.status,
      color: categoryColors[e.type] || '#6B7280',
      size: Math.max(3, Math.min(15, importance * 15)),
    };
  });

  // For links, we need to map conversation connections to entity connections
  // The graph should show entity-to-entity links (entities that co-occur in conversations)
  // Build entity co-occurrence from entity_mentions
  const { data: mentions } = await supabase
    .from('entity_mentions')
    .select('entity_id, conversation_id')
    .in('entity_id', (entities || []).map((e: any) => e.id))
    .limit(5000);

  // Build entity-to-entity links based on shared conversations
  const entityConvos: Record<string, Set<string>> = {};
  for (const m of (mentions || [])) {
    if (!entityConvos[m.entity_id]) entityConvos[m.entity_id] = new Set();
    entityConvos[m.entity_id].add(m.conversation_id);
  }

  const entityIds = (entities || []).map((e: any) => e.id);
  const linkMap = new Map<string, { source: string; target: string; sharedConvos: number }>();

  for (let i = 0; i < entityIds.length; i++) {
    for (let j = i + 1; j < entityIds.length; j++) {
      const a = entityIds[i];
      const b = entityIds[j];
      const aConvos = entityConvos[a] || new Set();
      const bConvos = entityConvos[b] || new Set();
      const shared = [...aConvos].filter(c => bConvos.has(c)).length;
      if (shared > 0) {
        const key = [a, b].sort().join(':');
        linkMap.set(key, { source: a, target: b, sharedConvos: shared });
      }
    }
  }

  const links = [...linkMap.values()].map(l => ({
    source: l.source,
    target: l.target,
    strength: Math.min(1, l.sharedConvos * 0.2), // Normalize
    sharedConversations: l.sharedConvos,
  }));

  return NextResponse.json({
    nodes,
    links,
    totalEntities: entities?.length || 0,
    totalConnections: links.length,
    conversationConnections: connections?.length || 0,
  });
}
