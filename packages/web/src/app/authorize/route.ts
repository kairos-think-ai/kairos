import { NextResponse } from 'next/server';

/**
 * OAuth Authorize Proxy
 *
 * Redirects to Supabase's authorization endpoint with all query params.
 * Claude.ai sends users here to start the OAuth flow.
 */
export async function GET(req: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const url = new URL(req.url);

  // Forward all query params to Supabase's authorize endpoint
  const supabaseAuthUrl = new URL(`${supabaseUrl}/auth/v1/oauth/authorize`);
  url.searchParams.forEach((value, key) => {
    supabaseAuthUrl.searchParams.set(key, value);
  });

  return NextResponse.redirect(supabaseAuthUrl.toString());
}
