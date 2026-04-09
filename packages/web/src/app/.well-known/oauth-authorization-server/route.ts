import { NextResponse } from 'next/server';

/**
 * OAuth Authorization Server Metadata (RFC 8414)
 *
 * Returns Supabase's OAuth metadata but with endpoint URLs rewritten
 * to our domain. This is needed because Claude.ai ignores the actual
 * endpoint URLs from metadata and uses paths relative to the MCP server
 * domain (confirmed bug: anthropics/claude-ai-mcp#82).
 *
 * By serving rewritten metadata, we support BOTH:
 * - Clients that follow the spec (Claude Code, ChatGPT) → use URLs from metadata
 * - Claude.ai → ignores metadata URLs but hits the same paths anyway
 */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  // Fetch Supabase's actual metadata
  const res = await fetch(
    `${supabaseUrl}/.well-known/oauth-authorization-server/auth/v1`,
    { next: { revalidate: 3600 } }, // Cache for 1 hour
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: 'Failed to fetch OAuth metadata from Supabase' },
      { status: 502 },
    );
  }

  const metadata = await res.json();

  // Rewrite endpoint URLs to our domain (proxy routes handle forwarding)
  return NextResponse.json({
    ...metadata,
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    // Keep Supabase's JWKS and userinfo endpoints (no proxy needed for these)
    jwks_uri: metadata.jwks_uri,
    userinfo_endpoint: metadata.userinfo_endpoint,
  });
}
