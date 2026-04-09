/**
 * Kairos Bridge — ISOLATED World Content Script
 *
 * Bridges data from the MAIN world fetch interceptor to the service worker.
 * Runs at document_idle in the extension's ISOLATED world (has chrome.* API access).
 *
 * Responsibilities:
 * 1. Listen for window.postMessage from interceptor.ts (MAIN world)
 * 2. Validate message origin and schema
 * 3. Enrich with DOM metadata (conversation title, URL, ID) via adapters
 * 4. Build ConversationPayload (same shape the service worker expects)
 * 5. Send to service worker via chrome.runtime.sendMessage
 * 6. Watch for SPA navigation and re-initialize
 *
 * The adapters (claude.ts, chatgpt.ts, etc.) are reused here for metadata
 * extraction only — title, URL, conversation ID from the DOM.
 */

import { getAdapter, PlatformAdapter } from '../adapters';
import { CapturedMessage, ConversationPayload, Platform } from '../types';
import { KAIROS_MSG_PREFIX, isValidInterceptedPayload, InterceptedConversation } from '../types/intercept';

// ============================================================
// State
// ============================================================

let adapter: PlatformAdapter | null = null;

/** Accumulated messages for the current conversation (full history) */
let conversationMessages: CapturedMessage[] = [];

/** Track the last URL to detect SPA navigation */
let lastUrl = '';

// ============================================================
// PostMessage listener
// ============================================================

/**
 * Validate that a postMessage event came from our interceptor,
 * not from a malicious page script or third-party script.
 */
function isValidKairosMessage(event: MessageEvent): boolean {
  // Must come from same origin
  if (event.origin !== window.location.origin) return false;
  // Must have our prefix
  if (typeof event.data?.type !== 'string') return false;
  if (!event.data.type.startsWith(KAIROS_MSG_PREFIX)) return false;
  // Validate payload schema
  return isValidInterceptedPayload(event.data.payload);
}

/**
 * Handle a complete conversation turn from the interceptor.
 * Builds a ConversationPayload and sends it to the service worker.
 */
function handleInterceptedComplete(payload: InterceptedConversation): void {
  const conversationId = payload.conversationId
    || adapter?.getConversationId()
    || `unknown-${Date.now()}`;

  console.log('[Kairos Bridge] Received intercepted turn:', payload.platform, 'conv:', conversationId, 'msgLen:', payload.assistantMessage?.length);

  // Add the user message to our running history (if present and not duplicate)
  if (payload.userMessage) {
    const lastMsg = conversationMessages[conversationMessages.length - 1];
    const isDuplicate = lastMsg?.role === 'user' && lastMsg.content === payload.userMessage;
    if (!isDuplicate) {
      conversationMessages.push({
        role: 'user',
        content: payload.userMessage,
        sequence: conversationMessages.length,
        timestamp: payload.timestamp,
      });
    }
  }

  // Add the assistant response
  conversationMessages.push({
    role: 'assistant',
    content: payload.assistantMessage,
    sequence: conversationMessages.length,
    timestamp: payload.timestamp,
  });

  // Build the payload in the exact shape the service worker expects
  const conversationPayload: ConversationPayload = {
    platform: (payload.platform as Platform) || adapter?.platform || 'other',
    platformConversationId: conversationId,
    title: adapter?.getConversationTitle() || null,
    url: adapter?.getConversationUrl() || window.location.href,
    messages: [...conversationMessages],
    metadata: {
      source: 'fetch_intercept',
      model: payload.model,
    },
    capturedAt: new Date().toISOString(),
  };

  // Send to service worker
  console.log('[Kairos Bridge] Sending CONVERSATION_UPDATE to service worker, messages:', conversationPayload.messages.length);
  chrome.runtime.sendMessage({
    type: 'CONVERSATION_UPDATE',
    payload: conversationPayload,
  }).then(() => {
    console.log('[Kairos Bridge] Successfully sent to service worker');
  }).catch(err => {
    // Service worker might be inactive — this is normal in MV3
    console.log('[Kairos Bridge] Could not reach service worker:', err.message);
  });
}

// ============================================================
// SPA navigation detection
// ============================================================

/**
 * Watch for SPA navigation (URL changes without full page reload).
 * When the user navigates to a new conversation, reset our state.
 */
function watchNavigation(): void {
  lastUrl = window.location.href;

  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log('[Kairos Bridge] Navigation detected, resetting state');

      // Reset conversation history for the new page
      conversationMessages = [];

      // Re-detect adapter (in case platform changed, though unlikely)
      adapter = getAdapter();
    }
  }, 1000);
}

// ============================================================
// Initialization
// ============================================================

function initialize(): void {
  chrome.storage.local.get(['isCapturing', 'platformsEnabled'], (result) => {
    const isCapturing = result.isCapturing !== false; // Default: on
    const platformsEnabled: string[] = result.platformsEnabled || ['claude', 'chatgpt', 'gemini'];

    if (!isCapturing) {
      console.log('[Kairos Bridge] Capture is paused');
      return;
    }

    adapter = getAdapter();
    if (!adapter) {
      console.log('[Kairos Bridge] No adapter for this page');
      return;
    }

    if (!platformsEnabled.includes(adapter.platform)) {
      console.log(`[Kairos Bridge] ${adapter.platform} is disabled`);
      return;
    }

    console.log(`[Kairos Bridge] Active on ${adapter.platform}`);

    // Listen for intercepted conversation turns from MAIN world
    window.addEventListener('message', (event: MessageEvent) => {
      if (!isValidKairosMessage(event)) return;

      const { type } = event.data;

      if (type === `${KAIROS_MSG_PREFIX}_COMPLETE`) {
        handleInterceptedComplete(event.data.payload as InterceptedConversation);
      }
      // STREAMING updates can be handled here for real-time progress if needed
    });

    // Watch for SPA navigation
    watchNavigation();

    // Listen for control messages from popup/service worker
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'PAUSE_CAPTURE') {
        console.log('[Kairos Bridge] Capture paused');
      }
      if (message.type === 'RESUME_CAPTURE') {
        console.log('[Kairos Bridge] Capture resumed');
      }
    });
  });
}

// Wait for page to be ready
if (document.readyState === 'complete') {
  initialize();
} else {
  window.addEventListener('load', initialize);
}
