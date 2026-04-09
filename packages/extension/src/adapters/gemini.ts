import { CapturedMessage } from '../types';
import { PlatformAdapter, PlatformSelectors, extractTextContent } from './base';

/**
 * Gemini Adapter (gemini.google.com)
 * 
 * Gemini uses a web component-heavy structure with custom elements.
 * Message containers are often inside shadow DOMs, so we may need
 * to traverse shadow roots.
 */
export class GeminiAdapter implements PlatformAdapter {
  readonly platform = 'gemini' as const;

  readonly selectors: PlatformSelectors = {
    messageContainer: '.conversation-container, main, [class*="conversation"]',
    messageElement: 'message-content, [class*="message-row"], .model-response-text, .query-text',
    userMessage: '.query-text, [class*="user-query"], [data-message-type="user"]',
    assistantMessage: '.model-response-text, [class*="model-response"], [data-message-type="model"]',
    messageContent: '.markdown, .message-content, [class*="response-text"]',
    conversationTitle: 'title, [class*="conversation-title"]',
  };

  isConversationPage(): boolean {
    return /\/app\/[a-f0-9]+/.test(window.location.pathname) ||
           window.location.pathname.includes('/app');
  }

  getConversationId(): string | null {
    const match = window.location.pathname.match(/\/app\/([a-f0-9]+)/);
    return match ? match[1] : `gemini-${Date.now()}`;
  }

  getConversationTitle(): string | null {
    const title = document.title;
    if (title && !title.includes('Gemini')) return title;
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
    return document.querySelector('main');
  }

  extractMessages(): CapturedMessage[] {
    const messages: CapturedMessage[] = [];
    
    // Gemini often uses custom elements, try querying broadly
    const userMessages = document.querySelectorAll(this.selectors.userMessage);
    const assistantMessages = document.querySelectorAll(this.selectors.assistantMessage);

    // Interleave user and assistant messages
    const maxLen = Math.max(userMessages.length, assistantMessages.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < userMessages.length) {
        const content = extractTextContent(userMessages[i]);
        if (content) {
          messages.push({
            role: 'user',
            content,
            sequence: messages.length,
            timestamp: new Date().toISOString(),
          });
        }
      }
      if (i < assistantMessages.length) {
        const content = extractTextContent(assistantMessages[i]);
        if (content) {
          messages.push({
            role: 'assistant',
            content,
            sequence: messages.length,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    return messages;
  }

  parseMessageElement(element: Element, index: number): CapturedMessage | null {
    const isUser = element.matches(this.selectors.userMessage);
    const content = extractTextContent(element);
    if (!content) return null;

    return {
      role: isUser ? 'user' : 'assistant',
      content,
      sequence: index,
      timestamp: new Date().toISOString(),
    };
  }
}
