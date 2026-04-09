/**
 * Kairos — Anthropic Client Resolution
 *
 * Resolves the correct Anthropic API key for each user.
 * Priority: user-stored key > server env var > error with guidance.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createServiceClient } from './supabase/server';

const PLACEHOLDER_KEY = 'sk-ant-your-key';

/**
 * Custom error for missing/invalid API keys.
 * Consumers check `instanceof AnthropicKeyError` to show
 * guidance UI instead of a generic error.
 */
export class AnthropicKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnthropicKeyError';
  }
}

/**
 * Get an Anthropic client configured with the best available API key.
 *
 * Resolution order:
 * 1. User-specific key from Supabase `users.settings.anthropic_api_key`
 * 2. Server-wide `ANTHROPIC_API_KEY` environment variable
 * 3. Throw `AnthropicKeyError` with guidance message
 */
export async function getAnthropicClient(userId?: string): Promise<Anthropic> {
  // 1. Try user-specific key
  if (userId) {
    try {
      const supabase = createServiceClient();
      const { data: user } = await supabase
        .from('users')
        .select('settings')
        .eq('id', userId)
        .single();

      const userKey = (user?.settings as Record<string, unknown>)?.anthropic_api_key;
      if (userKey && typeof userKey === 'string' && userKey.startsWith('sk-ant-') && userKey !== PLACEHOLDER_KEY) {
        return new Anthropic({ apiKey: userKey });
      }
    } catch {
      // DB query failed — fall through to env var
    }
  }

  // 2. Fall back to server env var
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY && envKey.startsWith('sk-ant-')) {
    return new Anthropic({ apiKey: envKey });
  }

  // 3. No valid key available
  throw new AnthropicKeyError(
    'No valid Anthropic API key configured. Please add your API key in Settings.'
  );
}

/**
 * Validate an API key by making a minimal API call.
 * Cost: ~$0.001 per validation.
 *
 * @returns `{ valid: true }` or `{ valid: false, error: "reason" }`
 */
export async function validateAnthropicKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  if (!apiKey.startsWith('sk-ant-')) {
    return { valid: false, error: 'Key must start with "sk-ant-"' };
  }

  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { valid: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('401') || message.includes('authentication') || message.includes('invalid')) {
      return { valid: false, error: 'Invalid API key. Please check and try again.' };
    }
    if (message.includes('429')) {
      // Rate limited but the key IS valid (auth passed)
      return { valid: true };
    }
    return { valid: false, error: `Validation failed: ${message}` };
  }
}
