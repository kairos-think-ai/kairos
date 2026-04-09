import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getAnthropicClient, AnthropicKeyError } from '@/lib/anthropic';

const MODEL = 'claude-sonnet-4-5-20250929';

const SCHEMA_INFERENCE_PROMPT = (sample: string) => `You are analyzing a data export file to determine its structure for parsing.
Here is a structural skeleton of the data (long text content has been replaced with type markers for privacy):

${sample}

Identify the structure and return ONLY a JSON object with this exact shape:
{
  "platform": "<claude|chatgpt|gemini|openclaw|other>",
  "formatName": "<descriptive name like 'Claude 2026 Export' or 'ChatGPT Conversation Export'>",
  "conversationsPath": "<path to conversations array from root, use 'root' if the top-level is already the array>",
  "fields": {
    "id": "<field name for conversation ID, e.g. 'uuid' or 'id'>",
    "title": "<field name for conversation title, e.g. 'name' or 'title'>",
    "createdAt": "<field name for creation timestamp, e.g. 'created_at' or 'create_time'>"
  },
  "messageFields": {
    "path": "<field name for messages array within each conversation, e.g. 'chat_messages' or 'messages'>",
    "role": "<field name for sender role, e.g. 'sender' or 'role'>",
    "roleMap": { "<original_value>": "user", "<original_value>": "assistant" },
    "content": "<field name for message text content, e.g. 'text' or 'content'>",
    "contentArray": {
      "path": "<if content is an array of typed blocks, the field name for that array, e.g. 'content'>",
      "typeField": "<field within each block for block type, e.g. 'type'>",
      "textField": "<field within each block for text content, e.g. 'text'>",
      "includeTypes": ["<types to include, e.g. 'text'>"]
    },
    "timestamp": "<field name for message timestamp, e.g. 'created_at'>"
  }
}

Rules:
- If content is a simple string field (not an array of blocks), omit contentArray entirely.
- If content is an array of typed blocks (e.g. [{type: "text", text: "..."}, {type: "thinking", ...}]), include contentArray and set includeTypes to only text-bearing types (exclude "thinking", "tool_use", etc).
- Detect the platform from field naming conventions and data patterns.
- roleMap must map the EXACT original role values to "user" or "assistant" (e.g. {"human": "user", "assistant": "assistant"} or {"user": "user", "assistant": "assistant"}).
- If a field doesn't exist in the data, use the closest match or a reasonable default.
- Respond with ONLY the JSON object. No explanation, no markdown fences.`;

/**
 * POST /api/infer-schema
 *
 * Accepts a structural skeleton of an unknown export file and uses
 * Claude Sonnet to infer the SchemaMapping needed to parse it.
 *
 * Body: { sample: string }
 * Returns: { schema: SchemaMapping }
 */
export async function POST(request: NextRequest) {
  // ── Auth ─────────────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  // ── Parse request ────────────────────────────────────────────
  let sample: string;
  try {
    const body = await request.json();
    sample = body.sample;
    if (!sample || typeof sample !== 'string') {
      return NextResponse.json({ error: 'Missing "sample" field' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // ── Call Claude Sonnet ───────────────────────────────────────
  try {
    const anthropic = await getAnthropicClient(user.id);

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: SCHEMA_INFERENCE_PROMPT(sample),
      }],
    });

    // Extract text from response
    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Strip markdown fences if present, then parse JSON
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const schema = JSON.parse(cleaned);

    console.log(`[Kairos] Schema inferred for format: ${schema.formatName} (platform: ${schema.platform})`);

    return NextResponse.json({ schema });
  } catch (err) {
    if (err instanceof AnthropicKeyError) {
      return NextResponse.json(
        { error: 'api_key_required', message: err.message },
        { status: 422 }
      );
    }
    console.error('[Kairos] Schema inference failed:', err);
    return NextResponse.json(
      { error: 'Schema inference failed', details: String(err) },
      { status: 500 }
    );
  }
}
