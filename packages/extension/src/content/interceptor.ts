/**
 * Kairos Fetch Interceptor — MAIN World Content Script
 *
 * Runs at document_start in the page's MAIN world to wrap window.fetch
 * BEFORE any page scripts execute. This lets us intercept SSE streaming
 * responses from AI platform APIs (Claude.ai, ChatGPT) at the network
 * level — far more reliable than DOM scraping.
 *
 * Architecture:
 * - Saves original window.fetch, replaces with instrumented version
 * - Detects POST requests to known SSE endpoints
 * - Uses Response.body.tee() for non-destructive stream duplication
 * - Returns untouched stream fork to page (zero interference)
 * - Reads our fork, accumulates assistant message from SSE events
 * - Posts completed conversation turns to ISOLATED world via postMessage
 *
 * Security:
 * - MAIN world scripts CANNOT access chrome.* APIs
 * - All outbound communication is via window.postMessage only
 * - Entire fetch wrapper is wrapped in try/catch for safety
 * - If anything fails, original fetch behavior is preserved
 *
 * This file must bundle as a self-contained IIFE (no import statements)
 * because MAIN world content scripts don't support ES modules in MV3.
 */

// ============================================================
// All types are inlined (no imports allowed in MAIN world script)
// ============================================================

interface MessageAccumulator {
  conversationId: string | null;
  userMessage: string | null;
  assistantMessage: string;
  model: string | null;
  isComplete: boolean;
}

interface EndpointMatcher {
  platform: 'claude' | 'chatgpt';
  urlPattern: RegExp;
  parseSSE: (lines: string[], accumulator: MessageAccumulator) => void;
  extractConversationId: (url: string) => string | null;
  extractUserMessage: (body: unknown) => string | null;
}

// ============================================================
// Constants
// ============================================================

const KAIROS_MSG_PREFIX = 'KAIROS_INTERCEPT';
const MAX_MESSAGE_SIZE = 1_048_576; // 1MB cap to prevent memory pressure

// ============================================================
// Platform-specific SSE parsers
// ============================================================

/**
 * Parse Claude.ai SSE events — adaptive multi-format parser.
 *
 * Claude streams events with `event:` and `data:` lines.
 * This parser is intentionally loose to handle format changes:
 *
 * - Checks `data.delta.text` WITHOUT requiring delta.type === "text_delta"
 *   → catches text from any delta event, including future format changes
 * - Also checks `data.completion` for legacy/alternative streaming format
 * - Extended thinking events have `delta.thinking` (not `delta.text`) → naturally skipped
 * - Detects stream completion from event name, stop_reason field, or message_delta
 */
function parseClaudeSSE(lines: string[], acc: MessageAccumulator): void {
  let currentEvent = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
      continue;
    }

    if (!line.startsWith('data: ')) continue;
    const rawData = line.slice(6);

    try {
      const data = JSON.parse(rawData);
      const eventKey = currentEvent || data.type || 'unknown';

      // Model extraction — check multiple possible locations
      if (!acc.model) {
        acc.model = data.message?.model || data.model || null;
      }

      // Text accumulation — Format A: any delta with a .text field
      // Works for content_block_delta with text_delta, and any future delta format
      if (typeof data.delta?.text === 'string' && data.delta.text) {
        if (acc.assistantMessage.length < MAX_MESSAGE_SIZE) {
          acc.assistantMessage += data.delta.text;
        }
      }

      // Text accumulation — Format B: legacy completion format (accumulated, not delta)
      if (typeof data.completion === 'string' && data.completion) {
        if (data.completion.length <= MAX_MESSAGE_SIZE) {
          acc.assistantMessage = data.completion;
        }
      }

      // Stream completion — check multiple signals
      if (
        eventKey === 'message_stop' ||
        data.stop_reason != null ||
        (eventKey === 'message_delta' && data.delta?.stop_reason)
      ) {
        acc.isComplete = true;
      }
    } catch {
      // Skip malformed data lines
    }
  }
}

/**
 * Parse ChatGPT SSE events — adaptive multi-format parser.
 *
 * ChatGPT streams `data: {json}` lines. Historically, each chunk contains the
 * accumulated message content (not deltas). The stream ends with `data: [DONE]`.
 *
 * This parser handles BOTH accumulated and delta modes:
 * - Accumulated: `data.message.content.parts[0]` is the full text so far → assign
 * - Delta: smaller chunks that need concatenation → append
 *
 * Detection: If a chunk's content is shorter than what we've already accumulated,
 * it's likely a delta. We track this per-stream via a flag on the accumulator.
 *
 * Also detects completion from:
 * - `data: [DONE]` (standard SSE termination)
 * - `message.status === "finished_successfully"` (ChatGPT-specific)
 * - `message.end_turn === true` (ChatGPT turn completion signal)
 */
function parseChatGPTSSE(lines: string[], acc: MessageAccumulator): void {
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const jsonStr = line.slice(6).trim();

    if (jsonStr === '[DONE]') {
      acc.isComplete = true;
      return;
    }

    try {
      const data = JSON.parse(jsonStr);

      // Extract conversation ID from first chunk
      if (data.conversation_id && !acc.conversationId) {
        acc.conversationId = data.conversation_id;
      }

      // Extract model info — check multiple locations
      if (!acc.model) {
        acc.model = data.message?.metadata?.model_slug
          || data.message?.metadata?.default_model_slug
          || null;
      }

      // Only process assistant messages with text content
      if (data.message?.author?.role && data.message.author.role !== 'assistant') {
        continue;
      }

      // Skip non-text content types (tool_calls, images, etc.)
      const contentType = data.message?.content?.content_type;
      if (contentType && contentType !== 'text') {
        continue;
      }

      // Text extraction — handle both accumulated and delta modes
      const content = data.message?.content?.parts?.[0];
      if (typeof content === 'string' && content.length <= MAX_MESSAGE_SIZE) {
        if (content.length >= acc.assistantMessage.length) {
          // Accumulated mode: new content is longer or equal — replace
          acc.assistantMessage = content;
        } else if (content.length > 0 && content.length < 200) {
          // Delta mode heuristic: short chunk that's smaller than accumulated text
          // Append it (but guard against double-counting by checking if current
          // text already ends with this content)
          if (!acc.assistantMessage.endsWith(content)) {
            acc.assistantMessage += content;
          }
        }
        // If content is long but shorter than accumulated, it might be a
        // partial re-render — keep existing (don't regress)
      }

      // Completion detection — message.status is more reliable than [DONE] alone
      if (
        data.message?.status === 'finished_successfully' ||
        data.message?.end_turn === true
      ) {
        acc.isComplete = true;
      }
    } catch {
      // Skip malformed data lines
    }
  }
}

// ============================================================
// Endpoint matchers
// ============================================================

const ENDPOINTS: EndpointMatcher[] = [
  {
    platform: 'claude',
    // Claude.ai sends chat completions to this endpoint pattern
    urlPattern: /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/,
    parseSSE: parseClaudeSSE,
    extractConversationId(url: string): string | null {
      const match = url.match(/\/chat_conversations\/([^/]+)\//);
      return match ? match[1] : null;
    },
    extractUserMessage(body: unknown): string | null {
      try {
        const obj = body as Record<string, unknown>;
        if (typeof obj.prompt === 'string') return obj.prompt;
        if (Array.isArray(obj.messages)) {
          const last = (obj.messages as Array<{ role?: string; content?: string }>).findLast(
            m => m.role === 'user'
          );
          if (last && typeof last.content === 'string') return last.content;
        }
      } catch { /* best-effort */ }
      return null;
    },
  },
  {
    platform: 'chatgpt',
    // ChatGPT backend API conversation endpoint
    urlPattern: /\/backend-api\/conversation$/,
    parseSSE: parseChatGPTSSE,
    extractConversationId(url: string): string | null {
      // ChatGPT provides conversation_id in the SSE stream, not the URL
      // The URL is just /backend-api/conversation for new + existing chats
      return null;
    },
    extractUserMessage(body: unknown): string | null {
      try {
        const obj = body as Record<string, unknown>;
        if (Array.isArray(obj.messages)) {
          const last = (obj.messages as Array<{ content?: { parts?: string[] } }>).findLast(
            m => m.content?.parts
          );
          if (last?.content?.parts) return last.content.parts.join('\n');
        }
      } catch { /* best-effort */ }
      return null;
    },
  },
];

// ============================================================
// SSE stream processor
// ============================================================

/**
 * Read a tee'd ReadableStream, accumulate SSE events into a complete
 * conversation turn, then post it to the ISOLATED world.
 */
async function processStream(
  stream: ReadableStream<Uint8Array>,
  matcher: EndpointMatcher,
  userMessage: string | null,
  url: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const acc: MessageAccumulator = {
    conversationId: matcher.extractConversationId(url),
    userMessage,
    assistantMessage: '',
    model: null,
    isComplete: false,
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Normalize CRLF → LF (Claude.ai uses \r\n, SSE splitting needs \n\n)
      buffer += chunk.replace(/\r\n/g, '\n');

      // SSE events are separated by double newlines
      const events = buffer.split('\n\n');
      buffer = events.pop() || ''; // Keep incomplete event in buffer

      for (const event of events) {
        if (!event.trim()) continue;
        const lines = event.split('\n');
        matcher.parseSSE(lines, acc);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Stream complete — post the accumulated message to ISOLATED world
  if (acc.assistantMessage) {
    acc.isComplete = true;
    console.log('[Kairos Interceptor] Stream complete! Assistant msg length:', acc.assistantMessage.length, 'convId:', acc.conversationId);
    postToIsolatedWorld(acc, matcher.platform);
  } else {
    console.log('[Kairos Interceptor] Stream ended but no assistant message accumulated');
  }
}

// ============================================================
// Cross-world communication
// ============================================================

function postToIsolatedWorld(acc: MessageAccumulator, platform: string): void {
  window.postMessage({
    type: `${KAIROS_MSG_PREFIX}_COMPLETE`,
    payload: {
      platform,
      conversationId: acc.conversationId,
      userMessage: acc.userMessage,
      assistantMessage: acc.assistantMessage,
      model: acc.model,
      timestamp: new Date().toISOString(),
    },
  }, window.location.origin);
}

// ============================================================
// Fetch interception
// ============================================================

const originalFetch = window.fetch;

/**
 * Instrumented fetch that intercepts SSE responses from AI platform APIs.
 * For non-matching requests, passes through to original fetch with zero overhead.
 */
async function interceptedFetch(
  this: typeof globalThis,
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const [input, init] = args;
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const method = init?.method?.toUpperCase() || 'GET';

  // Log POST requests to AI platform APIs (skip analytics/tracking)
  if (method === 'POST' && (url.includes('claude.ai') || url.includes('chatgpt.com') || url.includes('chat.openai.com'))) {
    console.log('[Kairos Interceptor] POST →', url.substring(0, 150));
  }

  // Only intercept POST requests to known SSE endpoints
  const matcher = (method === 'POST')
    ? ENDPOINTS.find(e => e.urlPattern.test(url))
    : null;

  if (!matcher) {
    return originalFetch.apply(this, args);
  }

  console.log('[Kairos Interceptor] URL MATCHED!', matcher.platform, '→', url.substring(0, 100));

  // Extract user message from request body (best-effort, before forwarding)
  let userMessage: string | null = null;
  try {
    if (init?.body) {
      let bodyText: string | null = null;

      if (typeof init.body === 'string') {
        bodyText = init.body;
      } else if (init.body instanceof Blob) {
        // Blob body — read as text (async but best-effort)
        try { bodyText = await init.body.text(); } catch { /* skip */ }
      } else if (init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body)) {
        // ArrayBuffer or TypedArray — decode as UTF-8
        const decoder = new TextDecoder();
        bodyText = decoder.decode(init.body);
      }

      if (bodyText) {
        const parsed = JSON.parse(bodyText);
        userMessage = matcher.extractUserMessage(parsed);
      }
    }
  } catch {
    // Body parsing is best-effort — don't block the request
  }

  // Call original fetch
  const response = await originalFetch.apply(this, args);

  // Only intercept responses with a streamable body
  const contentType = response.headers.get('content-type') || '';
  console.log('[Kairos Interceptor] Response content-type:', contentType, 'has body:', !!response.body);

  // Primary check: standard SSE content-type
  const isSSE = contentType.includes('text/event-stream');
  // Fallback: for known SSE endpoints, accept octet-stream or missing content-type
  // (some platforms change content-type headers without changing the actual format)
  const isKnownSSEEndpoint = isSSE || contentType.includes('application/octet-stream') || contentType === '';

  if (!isKnownSSEEndpoint || !response.body) {
    console.log('[Kairos Interceptor] Skipping — not SSE-compatible or no body');
    return response;
  }

  // Non-destructive stream duplication
  const [forPage, forKairos] = response.body.tee();

  // Process our copy asynchronously (fire and forget)
  processStream(forKairos, matcher, userMessage, url).catch(err => {
    // AbortError is expected — Claude's frontend aborts requests on retry/navigation
    if (err.name === 'AbortError') return;
    console.log('[Kairos Interceptor] Stream processing error:', err);
  });

  // Return the untouched copy to the page — zero interference
  return new Response(forPage, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// ============================================================
// Install the interceptor
// ============================================================

// Safety wrapper: if anything in our interceptor fails, original fetch is preserved
window.fetch = async function(
  this: typeof globalThis,
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  try {
    return await interceptedFetch.apply(this, args);
  } catch (err) {
    console.log('[Kairos Interceptor] Error, passing through to original fetch:', err);
    return originalFetch.apply(this, args);
  }
};

console.log('[Kairos Interceptor] Fetch interceptor installed');
