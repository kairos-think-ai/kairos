/**
 * Shared MCP Server for Kairos (HTTP transport).
 *
 * Uses registerTool with z.object() inputSchema so Claude.ai
 * can see the parameter definitions for each tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

let _currentUserToken: string | null = null;

export function setCurrentUserToken(token: string | null) {
  _currentUserToken = token;
}

export function createKairosServer() {
  const server = new McpServer({
    name: 'kairos',
    version: '0.1.0',
  });

  // kairos_profile — no parameters
  server.tool(
    'kairos_profile',
    'Returns your thinking profile: engagement metrics, concepts, coaching insights. Use at conversation start.',
    async () => {
      const { handleProfile } = await import('./tools/profile');
      return handleProfile(_currentUserToken || undefined);
    },
  );

  // kairos_coach — needs messages parameter
  server.registerTool(
    'kairos_coach',
    {
      title: 'Coach Current Conversation',
      description: 'Analyze current conversation for engagement patterns, drift, and provide coaching. You MUST pass the recent conversation messages.',
      inputSchema: z.object({
        messages: z.array(z.object({
          role: z.string(),
          content: z.string(),
        })).describe('Recent conversation messages. Include at least the last 10-20 turns.'),
        intent: z.string().optional().describe('What the user is trying to accomplish'),
        focus: z.string().optional().describe('engagement, drift, ideas, or all'),
      }) as any,
    },
    async (args: any) => {
      const { handleCoach } = await import('./tools/coach');
      return handleCoach({
        messages: args.messages,
        intent: args.intent,
        focus: args.focus || 'all',
        userToken: _currentUserToken || undefined,
      });
    },
  );

  // kairos_recall — needs query parameter
  server.registerTool(
    'kairos_recall',
    {
      title: 'Recall Past Conversations',
      description: 'Search conversation history by topic, entity, or keyword.',
      inputSchema: z.object({
        query: z.string().describe('Topic, entity name, or keyword to search for'),
        max_results: z.number().optional().describe('Max conversations to return (default 5)'),
      }) as any,
    },
    async (args: any) => {
      const { handleRecall } = await import('./tools/recall');
      return handleRecall(args.query, args.max_results || 5, false, _currentUserToken || undefined);
    },
  );

  // kairos_reflect
  server.registerTool(
    'kairos_reflect',
    {
      title: 'Reflect on Patterns',
      description: 'Get insights about your AI conversation patterns: metrics, coaching, behavioral signals.',
      inputSchema: z.object({
        period: z.string().optional().describe('today, week, month, or all (default: week)'),
        focus: z.string().optional().describe('attention, drift, coaching, or all (default: all)'),
      }) as any,
    },
    async (args: any) => {
      const { handleReflect } = await import('./tools/reflect');
      return handleReflect(args.period || 'week', args.focus || 'all', _currentUserToken || undefined);
    },
  );

  // kairos_connections
  server.registerTool(
    'kairos_connections',
    {
      title: 'Find Connected Conversations',
      description: 'Explore connections between conversations via pheromone-weighted graph.',
      inputSchema: z.object({
        topic: z.string().optional().describe('Search by topic'),
        min_strength: z.number().optional().describe('Minimum connection strength 0-1 (default 0.1)'),
      }) as any,
    },
    async (args: any) => {
      const { handleConnections } = await import('./tools/connections');
      return handleConnections({ ...args, min_strength: args.min_strength || 0.1 }, _currentUserToken || undefined);
    },
  );

  // kairos_resurface
  server.registerTool(
    'kairos_resurface',
    {
      title: 'Resurface Ideas',
      description: 'Get ideas due for revisiting via spaced repetition.',
      inputSchema: z.object({
        max_ideas: z.number().optional().describe('Maximum ideas to return (default 3)'),
      }) as any,
    },
    async (args: any) => {
      const { handleResurface } = await import('./tools/resurface');
      return handleResurface(args.max_ideas || 3, undefined, _currentUserToken || undefined);
    },
  );

  return server;
}
