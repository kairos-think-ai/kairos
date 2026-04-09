/**
 * Types for the MAIN world fetch interceptor <-> ISOLATED world bridge communication.
 *
 * Architecture:
 * - interceptor.ts (MAIN world) wraps window.fetch, parses SSE streams
 * - Posts structured data to bridge.ts (ISOLATED world) via window.postMessage
 * - bridge.ts validates, enriches with DOM metadata, relays to service worker
 *
 * Security: MAIN world scripts cannot access chrome.* APIs.
 * Communication crosses the world boundary via postMessage only.
 */

// ============================================================
// MAIN → ISOLATED postMessage payloads
// ============================================================

/** A complete conversation turn captured from an SSE stream */
export interface InterceptedConversation {
  platform: string;
  conversationId: string | null;
  userMessage: string | null;
  assistantMessage: string;
  model: string | null;
  timestamp: string;
}

/** Streaming update posted during SSE accumulation (for real-time progress) */
export interface InterceptedStreamingUpdate {
  platform: string;
  conversationId: string | null;
  assistantMessage: string;
  isComplete: boolean;
}

// ============================================================
// SSE stream processing
// ============================================================

/** Accumulator for building complete messages from SSE deltas */
export interface MessageAccumulator {
  conversationId: string | null;
  userMessage: string | null;
  assistantMessage: string;
  model: string | null;
  isComplete: boolean;
}

/** Platform-specific endpoint configuration */
export interface EndpointMatcher {
  platform: 'claude' | 'chatgpt';
  /** Regex to match the API endpoint URL */
  urlPattern: RegExp;
  /** Expected response content-type for SSE */
  contentType: string;
  /** Platform-specific SSE line parser */
  parseSSE: (lines: string[], accumulator: MessageAccumulator) => void;
}

// ============================================================
// Claude.ai SSE types
// ============================================================

export type ClaudeSSEEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error';

// ============================================================
// ChatGPT SSE types (partial — only fields we use)
// ============================================================

export interface ChatGPTSSEChunk {
  conversation_id?: string;
  message?: {
    content?: {
      parts?: string[];
    };
    metadata?: {
      model_slug?: string;
    };
  };
}

// ============================================================
// postMessage protocol
// ============================================================

export const KAIROS_MSG_PREFIX = 'KAIROS_INTERCEPT';

export interface KairosInterceptMessage {
  type: `${typeof KAIROS_MSG_PREFIX}_COMPLETE` | `${typeof KAIROS_MSG_PREFIX}_STREAMING`;
  payload: InterceptedConversation | InterceptedStreamingUpdate;
}

// ============================================================
// Runtime validation
// ============================================================

/** Validate that a postMessage payload matches the InterceptedConversation shape */
export function isValidInterceptedPayload(payload: unknown): payload is InterceptedConversation {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.platform === 'string' &&
    typeof p.assistantMessage === 'string' &&
    typeof p.timestamp === 'string'
  );
}
