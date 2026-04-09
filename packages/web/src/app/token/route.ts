import { NextResponse } from 'next/server';

/**
 * OAuth Token Proxy
 *
 * Forwards token exchange requests to Supabase's token endpoint.
 * Claude.ai calls this to exchange auth codes for access tokens
 * and to refresh expired tokens.
 */
export async function POST(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  // Read the request body
  const body = await req.text();

  // Forward to Supabase's token endpoint
  const res = await fetch(`${supabaseUrl}/auth/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': req.headers.get('content-type') || 'application/x-www-form-urlencoded',
      // Forward authorization header if present (for client_secret_basic)
      ...(req.headers.get('authorization')
        ? { Authorization: req.headers.get('authorization')! }
        : {}),
    },
    body,
  });

  const data = await res.text();

  return new Response(data, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'application/json',
    },
  });
}
