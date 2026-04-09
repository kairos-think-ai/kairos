import { Platform } from '../types';
import { PlatformAdapter, detectPlatform } from './base';
import { ClaudeAdapter } from './claude';
import { ChatGPTAdapter } from './chatgpt';
import { GeminiAdapter } from './gemini';

const adapters: Partial<Record<Platform, () => PlatformAdapter>> = {
  claude: () => new ClaudeAdapter(),
  chatgpt: () => new ChatGPTAdapter(),
  gemini: () => new GeminiAdapter(),
};

/**
 * Get the appropriate adapter for the current page.
 * Returns null if we're not on a supported platform.
 */
export function getAdapter(): PlatformAdapter | null {
  const platform = detectPlatform();
  if (!platform || platform === 'other') return null;
  
  try {
    return adapters[platform]();
  } catch {
    console.warn(`[Kairos] No adapter available for platform: ${platform}`);
    return null;
  }
}

export { detectPlatform } from './base';
export type { PlatformAdapter } from './base';
