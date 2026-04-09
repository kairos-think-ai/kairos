/**
 * HTTP MCP Endpoint — /api/mcp
 *
 * Serves the Kairos MCP server over Streamable HTTP.
 * Auth: Returns 401 with WWW-Authenticate for unauthenticated requests,
 * triggering the MCP OAuth discovery flow.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createKairosServer, setCurrentUserToken } from '@/lib/mcp/server';

async function handleMcpRequest(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;

  // Extract auth token
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // If no token, return 401 to trigger OAuth discovery
  // Exception: allow unauthenticated OPTIONS for CORS preflight
  if (!token && req.method !== 'OPTIONS') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Authentication required' },
      id: null,
    }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  // Set user token for this request
  setCurrentUserToken(token);

  // Create fresh server + transport per request (stateless)
  const server = createKairosServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(req);
    return response;
  } finally {
    setCurrentUserToken(null);
    await transport.close();
    await server.close();
  }
}

export async function GET(req: Request) {
  return handleMcpRequest(req);
}

export async function POST(req: Request) {
  return handleMcpRequest(req);
}

export async function DELETE(req: Request) {
  return handleMcpRequest(req);
}

export const maxDuration = 60;
