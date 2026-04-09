import { CapturedMessage } from '../types';
import { PlatformAdapter, PlatformSelectors, extractTextContent, extractIdFromUrl } from './base';

/**
 * Claude.ai Adapter
 * 
 * DOM structure (as of Feb 2026):
 * - Conversation container: div with role="presentation" or main content area
 * - Messages: alternating user/assistant blocks
 * - User messages: [data-testid="user-message"] or similar
 * - Assistant messages: [data-testid="assistant-message"] or markdown content blocks
 * - Title: In the sidebar or header area
 * 
 * NOTE: Claude.ai's DOM changes frequently. These selectors should be treated
 * as a starting point — telemetry will flag breakage for fast updates.
 */
export class ClaudeAdapter implements PlatformAdapter {
  readonly platform = 'claude' as const;

  readonly selectors: PlatformSelectors = {
    messageContainer: '[class*="conversation-content"], main [role="presentation"], .flex-1.flex.flex-col',
    messageElement: '[data-testid*="message"], .font-claude-message, .font-user-message, [class*="Message"]',
    userMessage: '[data-testid="user-message"], .font-user-message, [class*="human"]',
    assistantMessage: '[data-testid="assistant-message"], .font-claude-message, [class*="assistant"]',
    messageContent: '[class*="markdown"], [class*="prose"], .whitespace-pre-wrap',
    conversationTitle: 'title, [class*="conversation-title"], nav a[href*="/chat/"].font-medium',
  };

  isConversationPage(): boolean {
    // Claude URLs: /chat/{id} or /new
    return /\/chat\/[a-f0-9-]+/.test(window.location.pathname);
  }

  getConversationId(): string | null {
    return extractIdFromUrl(/\/chat\/([a-f0-9-]+)/);
  }

  getConversationTitle(): string | null {
    // Try multiple approaches
    // 1. Active nav item in sidebar
    const navItem = document.querySelector('nav a[href*="/chat/"].font-medium, nav a[aria-current="page"]');
    if (navItem?.textContent?.trim()) return navItem.textContent.trim();

    // 2. Page title (usually "Claude" or conversation title)
    const title = document.title;
    if (title && title !== 'Claude' && title !== 'Claude.ai') return title;

    // 3. First user message as fallback
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
    const container = this.getMessageContainer();
    if (!container) return messages;

    // Find all message-like elements
    const elements = container.querySelectorAll(this.selectors.messageElement);
    
    if (elements.length === 0) {
      // Fallback: try to find alternating content blocks
      return this.extractMessagesFallback(container);
    }

    elements.forEach((el, index) => {
      const msg = this.parseMessageElement(el, index);
      if (msg) messages.push(msg);
    });

    return messages;
  }

  parseMessageElement(element: Element, index: number): CapturedMessage | null {
    const isUser = this.isUserMessage(element);
    const isAssistant = this.isAssistantMessage(element);
    
    if (!isUser && !isAssistant) return null;

    // Find the content within the message
    const contentEl = element.querySelector(this.selectors.messageContent) || element;
    const content = extractTextContent(contentEl);
    
    if (!content) return null;

    return {
      role: isUser ? 'user' : 'assistant',
      content,
      sequence: index,
      timestamp: new Date().toISOString(),
    };
  }

  private isUserMessage(element: Element): boolean {
    const selectors = this.selectors.userMessage.split(', ');
    return selectors.some(sel => element.matches(sel) || element.querySelector(sel) !== null);
  }

  private isAssistantMessage(element: Element): boolean {
    const selectors = this.selectors.assistantMessage.split(', ');
    return selectors.some(sel => element.matches(sel) || element.querySelector(sel) !== null);
  }

  /**
   * Fallback extraction: look for alternating content blocks when specific
   * selectors fail. Claude often uses a simple alternating pattern.
   */
  private extractMessagesFallback(container: Element): CapturedMessage[] {
    const messages: CapturedMessage[] = [];
    
    // Look for direct children that contain substantial text
    const children = Array.from(container.children).filter(
      child => (child.textContent?.trim().length || 0) > 5
    );

    children.forEach((child, index) => {
      const content = extractTextContent(child);
      if (!content) return;

      // Heuristic: even indices are user messages (Claude typically shows user first)
      // This is fragile but better than nothing as a fallback
      const role = index % 2 === 0 ? 'user' : 'assistant';
      messages.push({
        role: role as 'user' | 'assistant',
        content,
        sequence: index,
        timestamp: new Date().toISOString(),
      });
    });

    return messages;
  }
}
