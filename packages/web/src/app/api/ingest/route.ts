import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

// Inngest disabled for local dev (OpenTelemetry dependency issue)
// Pipeline is triggered manually via /api/pipeline/trigger instead
// import { inngest } from '@/lib/inngest/client';

// CORS headers for Chrome extension requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** Helper to return JSON with CORS headers */
function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders });
}

/**
 * OPTIONS /api/ingest — CORS preflight handler
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * POST /api/ingest
 *
 * Gateway ingestion endpoint. Receives conversation payloads from
 * Node #1 (browser extension) and stores them for analysis.
 *
 * This is the primary data path: Extension → Gateway → Supabase
 */
export async function POST(request: NextRequest) {
  // Authenticate the request
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  // Verify the user's session
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }

  try {
    const body = await request.json();
    const { conversations } = body;

    if (!conversations || !Array.isArray(conversations)) {
      return jsonResponse({ error: 'Invalid payload: expected conversations array' }, 400);
    }

    let ingested = 0;
    const errors: string[] = [];

    for (const convo of conversations) {
      try {
        // Upsert conversation (update if we already have it)
        const { data: conversation, error: convoError } = await supabase
          .from('conversations')
          .upsert({
            user_id: user.id,
            platform: convo.platform,
            platform_conversation_id: convo.platformConversationId,
            title: convo.title,
            url: convo.url,
            started_at: convo.capturedAt,
            message_count: convo.messages.length,
            metadata: convo.metadata || {},
            analysis_status: 'pending',  // (Re)trigger analysis
          }, {
            onConflict: 'user_id,platform,platform_conversation_id',
          })
          .select('id')
          .single();

        if (convoError) {
          errors.push(`Conversation ${convo.platformConversationId}: ${convoError.message}`);
          continue;
        }

        // Delete existing messages and re-insert (simpler than diffing)
        await supabase
          .from('messages')
          .delete()
          .eq('conversation_id', conversation.id);

        // Insert messages in batches
        const messageBatch = convo.messages.map((msg: any, index: number) => ({
          conversation_id: conversation.id,
          user_id: user.id,
          role: msg.role,
          content: msg.content,
          sequence: msg.sequence ?? index,
          timestamp: msg.timestamp || new Date().toISOString(),
          token_estimate: Math.ceil((msg.content?.length || 0) / 4),
        }));

        if (messageBatch.length > 0) {
          const { error: msgError } = await supabase
            .from('messages')
            .insert(messageBatch);

          if (msgError) {
            errors.push(`Messages for ${convo.platformConversationId}: ${msgError.message}`);
            continue;
          }
        }

        // Inngest disabled for local dev — pipeline triggered manually via /api/pipeline/trigger
        // When Inngest is configured (production), re-enable this to auto-trigger analysis

        ingested++;
      } catch (err) {
        errors.push(`${convo.platformConversationId}: ${String(err)}`);
      }
    }

    return jsonResponse({ ingested, errors });
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
}
