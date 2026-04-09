import { Platform, CapturedMessage } from '../types';

/**
 * PlatformAdapter — the standard interface for Node sensing capabilities.
 * 
 * Each AI platform has a unique DOM structure. Adapters isolate this complexity
 * behind a common interface. The content script detects which platform we're on
 * and loads the appropriate adapter.
 * 
 * Architecture: These are "sub-nodes" within Node #1 (the browser extension).
 * Each adapter exposes sensing capabilities for its platform.
 */
export interface PlatformAdapter {
  /** Which platform this adapter handles */
  readonly platform: Platform;

  /** Selectors and patterns used to find conversation elements */
  readonly selectors: PlatformSelectors;

  /** Check if we're currently on a conversation page */
  isConversationPage(): boolean;

  /** Extract a unique ID for the current conversation */
  getConversationId(): string | null;

  /** Extract the conversation title */
  getConversationTitle(): string | null;

  /** Get the current page URL */
  getConversationUrl(): string;

  /** Extract all currently visible messages */
  extractMessages(): CapturedMessage[];

  /** Get the container element to observe for new messages */
  getMessageContainer(): Element | null;

  /** Parse a single message element into our format */
  parseMessageElement(element: Element, index: number): CapturedMessage | null;
}

export interface PlatformSelectors {
  /** Selector for the message list container */
  messageContainer: string;
  /** Selector for individual message elements */
  messageElement: string;
  /** Selector for user messages specifically */
  userMessage: string;
  /** Selector for assistant messages specifically */
  assistantMessage: string;
  /** Selector for message text content */
  messageContent: string;
  /** Selector for conversation title */
  conversationTitle: string;
}

/**
 * Detect which platform we're on based on the URL
 */
export function detectPlatform(): Platform | null {
  const hostname = window.location.hostname;
  if (hostname === 'claude.ai') return 'claude';
  if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return 'chatgpt';
  if (hostname === 'gemini.google.com') return 'gemini';
  return null;
}

/**
 * Safely extract text content from an element, handling nested code blocks etc.
 */
export function extractTextContent(element: Element): string {
  // Clone to avoid modifying the DOM
  const clone = element.cloneNode(true) as Element;

  // Preserve code block formatting
  clone.querySelectorAll('pre').forEach(pre => {
    pre.textContent = '\n```\n' + (pre.textContent || '') + '\n```\n';
  });

  // Preserve inline code
  clone.querySelectorAll('code:not(pre code)').forEach(code => {
    code.textContent = '`' + (code.textContent || '') + '`';
  });

  return (clone.textContent || '').trim();
}

/**
 * Generate a stable ID from URL path segments
 */
export function extractIdFromUrl(pattern: RegExp): string | null {
  const match = window.location.pathname.match(pattern);
  return match ? match[1] : null;
}
