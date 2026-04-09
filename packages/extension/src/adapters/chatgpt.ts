import { CapturedMessage } from '../types';
import { PlatformAdapter, PlatformSelectors, extractTextContent, extractIdFromUrl } from './base';

/**
 * ChatGPT Adapter (chatgpt.com / chat.openai.com)
 *
 * DOM structure evolves frequently. This adapter uses multiple fallback
 * selectors for resilience. Known patterns (as of Feb 2026):
 *
 * Pattern A (current): [data-message-author-role="user"|"assistant"]
 * Pattern B (turn-based): [data-testid="conversation-turn-N"]
 * Pattern C (article-based): article with nested role elements
 *
 * Conversation URLs:
 * - /c/{uuid} — standard conversations
 * - /g/{uuid} — GPT conversations (custom GPTs)
 * - / — new conversation (no ID yet, captured from SSE stream)
 */
export class ChatGPTAdapter implements PlatformAdapter {
  readonly platform = 'chatgpt' as const;

  readonly selectors: PlatformSelectors = {
    // Multiple container patterns — ChatGPT reshuffles these frequently
    messageContainer: [
      'main [class*="react-scroll-to-bottom"]',
      'main .flex.flex-col.items-center',
      'main [role="presentation"]',
      'main > div > div > div',
    ].join(', '),
    // Message element selectors — try most specific first
    messageElement: [
      '[data-message-author-role]',
      '[data-testid*="conversation-turn"]',
      'article[data-testid]',
      'main [data-message-id]',
    ].join(', '),
    userMessage: '[data-message-author-role="user"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    // Content selectors — markdown rendering containers
    messageContent: [
      '.markdown.prose',
      '[class*="markdown"]',
      '.whitespace-pre-wrap',
      '[data-message-author-role] > div > div',
    ].join(', '),
    // Title selectors — sidebar active conversation
    conversationTitle: [
      'title',
      'nav a[aria-current="page"]',
      'nav a.bg-token-sidebar-surface-secondary',
      'nav li.relative a.flex',
    ].join(', '),
  };

  isConversationPage(): boolean {
    // Match /c/{uuid}, /g/{uuid}, or even root / (new conversation)
    return /\/[cg]\/[a-f0-9-]+/.test(window.location.pathname) ||
           window.location.pathname === '/';
  }

  getConversationId(): string | null {
    return extractIdFromUrl(/\/[cg]\/([a-f0-9-]+)/);
    // Note: for new conversations at /, the ID comes from the SSE stream
  }

  getConversationTitle(): string | null {
    // 1. Page title (most reliable — ChatGPT sets it to conversation title)
    const title = document.title;
    if (title && title !== 'ChatGPT' && title !== 'New chat') return title;

    // 2. Active sidebar item
    const activeNav = document.querySelector('nav a[aria-current="page"]');
    if (activeNav?.textContent?.trim()) return activeNav.textContent.trim();

    // 3. Highlighted sidebar item
    const navItem = document.querySelector('nav a.bg-token-sidebar-surface-secondary');
    if (navItem?.textContent?.trim()) return navItem.textContent.trim();

    return null;
  }

  getConversationUrl(): string {
    return window.location.href;
  }

  getMessageContainer(): Element | null {
    const selectors = this.selectors.messageContainer.split(', ');
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  extractMessages(): CapturedMessage[] {
    const messages: CapturedMessage[] = [];
    const elements = document.querySelectorAll(this.selectors.messageElement);

    elements.forEach((el, index) => {
      const msg = this.parseMessageElement(el, index);
      if (msg) messages.push(msg);
    });

    return messages;
  }

  parseMessageElement(element: Element, index: number): CapturedMessage | null {
    // Strategy 1: Direct role attribute on this element
    const role = element.getAttribute('data-message-author-role') as 'user' | 'assistant' | null;

    if (role === 'user' || role === 'assistant') {
      const contentEl = element.querySelector(this.selectors.messageContent) || element;
      const content = extractTextContent(contentEl);
      if (!content) return null;

      return { role, content, sequence: index, timestamp: new Date().toISOString() };
    }

    // Strategy 2: Child element has the role attribute (turn-based containers)
    const userChild = element.querySelector('[data-message-author-role="user"]');
    const assistantChild = element.querySelector('[data-message-author-role="assistant"]');

    if (userChild || assistantChild) {
      const target = (userChild || assistantChild) as Element;
      const detectedRole = userChild ? 'user' : 'assistant';
      const contentEl = target.querySelector(this.selectors.messageContent) || target;
      const content = extractTextContent(contentEl);
      if (!content) return null;

      return {
        role: detectedRole as 'user' | 'assistant',
        content,
        sequence: index,
        timestamp: new Date().toISOString(),
      };
    }

    // Strategy 3: data-message-id without role — try to infer from position
    // (even indices = user, odd = assistant is fragile but better than nothing)
    if (element.hasAttribute('data-message-id')) {
      const contentEl = element.querySelector(this.selectors.messageContent) || element;
      const content = extractTextContent(contentEl);
      if (!content || content.length < 3) return null;

      return {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content,
        sequence: index,
        timestamp: new Date().toISOString(),
      };
    }

    return null;
  }
}
