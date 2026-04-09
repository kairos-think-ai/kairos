import { NextResponse } from 'next/server';

/**
 * OAuth Dynamic Client Registration Proxy (RFC 7591)
 *
 * Forwards client registration requests to Supabase's registration endpoint.
 * Claude.ai calls this to auto-register as an OAuth client.
 */
export async function POST(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const body = await req.text();

  const res = await fetch(`${supabaseUrl}/auth/v1/oauth/clients/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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
