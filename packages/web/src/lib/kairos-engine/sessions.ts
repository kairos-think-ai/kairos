/**
 * Kairos Engine — Session Detection (L3)
 *
 * Groups temporally proximate conversations (<2hr gap) into sessions.
 * Triggered after conversation/analyzed event via Inngest.
 *
 * A session represents a contiguous block of AI interaction,
 * potentially spanning multiple conversations and platforms.
 */

import { createServiceClient } from '../supabase/server';

const SESSION_GAP_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

/**
 * After a conversation is analyzed, check if it belongs to an existing session
 * or if a new session should be created.
 *
 * Algorithm:
 * 1. Get the conversation's timestamps
 * 2. Look for existing sessions within +-2hr window
 * 3. If found, add conversation to that session
 * 4. If not, find nearby conversations and create a new session
 */
export async function detectAndGroupSession(
  conversationId: string,
  userId: string
): Promise<{ sessionId: string | null; isNew: boolean }> {
  const supabase = createServiceClient();

  // 1. Get the conversation's timestamps
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, started_at, ended_at, platform')
    .eq('id', conversationId)
    .single();

  if (!conversation) return { sessionId: null, isNew: false };

  const convoStart = new Date(conversation.started_at);
  const convoEnd = new Date(conversation.ended_at || conversation.started_at);
  const windowStart = new Date(convoStart.getTime() - SESSION_GAP_MS);
  const windowEnd = new Date(convoEnd.getTime() + SESSION_GAP_MS);

  // 2. Find existing sessions that overlap with this window
  const { data: existingSessions } = await supabase
    .from('sessions')
    .select('id, started_at, ended_at, conversation_ids')
    .eq('user_id', userId)
    .gte('ended_at', windowStart.toISOString())
    .lte('started_at', windowEnd.toISOString())
    .order('started_at', { ascending: true })
    .limit(5);

  if (existingSessions && existingSessions.length > 0) {
    // Add to the first matching session
    const session = existingSessions[0];
    const convIds: string[] = session.conversation_ids || [];

    if (convIds.includes(conversationId)) {
      // Already in this session
      return { sessionId: session.id, isNew: false };
    }

    convIds.push(conversationId);

    // Expand session boundaries if needed
    const newStart = new Date(Math.min(
      new Date(session.started_at).getTime(),
      convoStart.getTime()
    ));
    const newEnd = new Date(Math.max(
      new Date(session.ended_at || session.started_at).getTime(),
      convoEnd.getTime()
    ));

    await supabase
      .from('sessions')
      .update({
        conversation_ids: convIds,
        started_at: newStart.toISOString(),
        ended_at: newEnd.toISOString(),
        analysis_status: 'pending',
      })
      .eq('id', session.id);

    return { sessionId: session.id, isNew: false };
  }

  // 3. Find nearby conversations not yet in any session
  const { data: nearbyConversations } = await supabase
    .from('conversations')
    .select('id, started_at, ended_at')
    .eq('user_id', userId)
    .gte('started_at', windowStart.toISOString())
    .lte('started_at', windowEnd.toISOString())
    .order('started_at', { ascending: true });

  // Only the current conversation in the window — no session yet
  // (sessions need at least the current conversation; they'll grow
  // as more conversations arrive within the 2hr window)
  const allConvIds = (nearbyConversations || []).map((c: { id: string }) => c.id);
  if (!allConvIds.includes(conversationId)) {
    allConvIds.push(conversationId);
  }

  // Compute session time boundaries
  const allConvs = nearbyConversations || [];
  const sessionStart = allConvs.length > 0
    ? allConvs[0].started_at
    : conversation.started_at;
  const lastConv = allConvs.length > 0
    ? allConvs[allConvs.length - 1]
    : conversation;
  const sessionEnd = lastConv.ended_at || lastConv.started_at;

  // 4. Create a new session
  const { data: newSession } = await supabase
    .from('sessions')
    .insert({
      user_id: userId,
      started_at: sessionStart,
      ended_at: sessionEnd,
      conversation_ids: allConvIds,
      platform: conversation.platform,
      analysis_status: 'pending',
    })
    .select('id')
    .single();

  return {
    sessionId: newSession?.id || null,
    isNew: true,
  };
}
