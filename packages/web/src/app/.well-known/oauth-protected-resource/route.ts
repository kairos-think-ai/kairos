import { NextResponse } from 'next/server';

/**
 * OAuth Protected Resource Metadata (RFC 9728)
 *
 * Points to our own domain as the authorization server (we proxy
 * to Supabase). This way both spec-compliant clients and Claude.ai
 * (which has a bug ignoring metadata URLs) hit the same proxy routes.
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  return NextResponse.json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: ['openid', 'profile', 'email'],
    bearer_methods_supported: ['header'],
  });
}
