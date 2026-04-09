import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { validateAnthropicKey } from '@/lib/anthropic';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * GET /api/user/settings
 *
 * Returns the user's settings with the API key masked.
 * Never returns the full key.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }

  const { data: userData } = await supabase
    .from('users')
    .select('settings')
    .eq('id', user.id)
    .single();

  const settings = (userData?.settings || {}) as Record<string, unknown>;

  // Mask the API key: show only first 7 + last 4 chars
  let maskedKey: string | null = null;
  const rawKey = settings.anthropic_api_key;
  if (rawKey && typeof rawKey === 'string') {
    if (rawKey.length > 15) {
      maskedKey = rawKey.slice(0, 7) + '...' + rawKey.slice(-4);
    } else {
      maskedKey = rawKey.slice(0, 4) + '...';
    }
  }

  // Mask OpenAI key too
  let maskedOpenAIKey: string | null = null;
  const rawOpenAIKey = settings.openai_api_key;
  if (rawOpenAIKey && typeof rawOpenAIKey === 'string') {
    if (rawOpenAIKey.length > 15) {
      maskedOpenAIKey = rawOpenAIKey.slice(0, 10) + '...' + rawOpenAIKey.slice(-4);
    } else {
      maskedOpenAIKey = rawOpenAIKey.slice(0, 4) + '...';
    }
  }

  // Mask Supabase URL
  let maskedSupabaseUrl: string | null = null;
  const rawSupabaseUrl = settings.supabase_url;
  if (rawSupabaseUrl && typeof rawSupabaseUrl === 'string') {
    maskedSupabaseUrl = rawSupabaseUrl.replace(/https:\/\/([^.]+)\.supabase\.co/, 'https://$1.supabase.co');
  }

  // Return settings without the full keys
  const safeSettings = { ...settings };
  delete safeSettings.anthropic_api_key;
  delete safeSettings.openai_api_key;
  delete safeSettings.supabase_service_role_key;

  return jsonResponse({
    settings: {
      ...safeSettings,
      anthropic_api_key_set: !!rawKey,
      anthropic_api_key_masked: maskedKey,
      openai_api_key_set: !!rawOpenAIKey,
      openai_api_key_masked: maskedOpenAIKey,
      supabase_url_set: !!rawSupabaseUrl,
      supabase_url_masked: maskedSupabaseUrl,
    },
  });
}

/**
 * PATCH /api/user/settings
 *
 * Update user settings. Currently supports:
 * - anthropic_api_key: Validates the key before saving
 *
 * Body: { anthropic_api_key?: string | null }
 */
export async function PATCH(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.slice(7);
  const supabase = createServiceClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // Handle API key update
  if ('anthropic_api_key' in body) {
    const newKey = body.anthropic_api_key;

    // Get current settings
    const { data: currentUser } = await supabase
      .from('users')
      .select('settings')
      .eq('id', user.id)
      .single();

    const currentSettings = ((currentUser?.settings || {}) as Record<string, unknown>);

    // Allow clearing the key
    if (newKey === null || newKey === '') {
      delete currentSettings.anthropic_api_key;

      await supabase
        .from('users')
        .update({ settings: currentSettings, updated_at: new Date().toISOString() })
        .eq('id', user.id);

      return jsonResponse({ updated: true, anthropic_api_key_set: false });
    }

    // Validate the key
    if (typeof newKey !== 'string') {
      return jsonResponse({ error: 'API key must be a string' }, 400);
    }

    const validation = await validateAnthropicKey(newKey);
    if (!validation.valid) {
      return jsonResponse({ error: validation.error, code: 'invalid_key' }, 422);
    }

    // Save to settings jsonb
    currentSettings.anthropic_api_key = newKey;

    const { error: updateError } = await supabase
      .from('users')
      .update({ settings: currentSettings, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) {
      console.error('[Settings] Failed to save API key:', updateError);
      return jsonResponse({ error: 'Failed to save settings' }, 500);
    }

    // Return masked key
    const masked = newKey.length > 15
      ? newKey.slice(0, 7) + '...' + newKey.slice(-4)
      : newKey.slice(0, 4) + '...';

    return jsonResponse({
      updated: true,
      anthropic_api_key_set: true,
      anthropic_api_key_masked: masked,
    });
  }

  // Handle OpenAI API key update
  if ('openai_api_key' in body) {
    const newKey = body.openai_api_key;

    const { data: currentUser } = await supabase
      .from('users')
      .select('settings')
      .eq('id', user.id)
      .single();

    const currentSettings = ((currentUser?.settings || {}) as Record<string, unknown>);

    if (newKey === null || newKey === '') {
      delete currentSettings.openai_api_key;
      await supabase
        .from('users')
        .update({ settings: currentSettings, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      return jsonResponse({ updated: true, openai_api_key_set: false });
    }

    if (typeof newKey !== 'string') {
      return jsonResponse({ error: 'API key must be a string' }, 400);
    }

    // Basic validation: must start with sk-
    if (!newKey.startsWith('sk-')) {
      return jsonResponse({ error: 'Invalid OpenAI key format (should start with sk-)' }, 422);
    }

    currentSettings.openai_api_key = newKey;
    const { error: updateError } = await supabase
      .from('users')
      .update({ settings: currentSettings, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) {
      return jsonResponse({ error: 'Failed to save settings' }, 500);
    }

    const masked = newKey.length > 15
      ? newKey.slice(0, 10) + '...' + newKey.slice(-4)
      : newKey.slice(0, 4) + '...';

    return jsonResponse({
      updated: true,
      openai_api_key_set: true,
      openai_api_key_masked: masked,
    });
  }

  // Handle Supabase override (Own tier)
  if ('supabase_url' in body || 'supabase_service_role_key' in body) {
    const { data: currentUser } = await supabase
      .from('users')
      .select('settings')
      .eq('id', user.id)
      .single();

    const currentSettings = ((currentUser?.settings || {}) as Record<string, unknown>);

    // Clear both if either is null
    if (body.supabase_url === null || body.supabase_service_role_key === null) {
      delete currentSettings.supabase_url;
      delete currentSettings.supabase_service_role_key;
      await supabase
        .from('users')
        .update({ settings: currentSettings, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      return jsonResponse({ updated: true, supabase_url_set: false });
    }

    const newUrl = body.supabase_url;
    const newKey = body.supabase_service_role_key;

    if (typeof newUrl !== 'string' || !newUrl.includes('supabase.co')) {
      return jsonResponse({ error: 'Invalid Supabase URL (should end with .supabase.co)' }, 422);
    }
    if (typeof newKey !== 'string' || !newKey.startsWith('eyJ')) {
      return jsonResponse({ error: 'Invalid service role key format' }, 422);
    }

    currentSettings.supabase_url = newUrl;
    currentSettings.supabase_service_role_key = newKey;

    const { error: updateError } = await supabase
      .from('users')
      .update({ settings: currentSettings, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (updateError) {
      return jsonResponse({ error: 'Failed to save settings' }, 500);
    }

    return jsonResponse({
      updated: true,
      supabase_url_set: true,
      supabase_url_masked: newUrl,
    });
  }

  return jsonResponse({ error: 'No recognized settings fields in request' }, 400);
}
