#!/usr/bin/env node
/**
 * Kairos MCP Server
 *
 * A memory and attention-coaching layer for Claude.
 * Gives Claude persistent memory of your conversation patterns,
 * ideas, and attention habits across sessions.
 *
 * Tools:
 *   kairos_profile   — Compile thinking profile for system prompt injection (Layer 1)
 *   kairos_coach     — Live conversation analysis + coaching guidance (Layer 2)
 *   kairos_import    — Ingest Claude conversation exports (ZIP/JSONL)
 *   kairos_recall    — Retrieve past conversations by topic (graph-first, embedding-fallback)
 *   kairos_reflect   — Get behavioral signals and coaching insights for your patterns
 *   kairos_connections — Find related conversations via the connection graph
 *   kairos_resurface — Get ideas due for revisiting (SM-2 spaced repetition)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { handleImport } from "./tools/import.js";
import { handleRecall } from "./tools/recall.js";
import { handleReflect } from "./tools/reflect.js";
import { handleConnections } from "./tools/connections.js";
import { handleResurface } from "./tools/resurface.js";
import { handleProfile } from "./tools/profile.js";
import { handleCoach } from "./tools/coach.js";

const server = new McpServer({
  name: "kairos",
  version: "0.1.0",
});

// ── kairos_import ──────────────────────────────────────────────────────
server.registerTool("kairos_import", {
  title: "Import Conversations",
  description:
    "Import AI conversation history into Kairos memory. " +
    "Accepts a file path to a Claude export ZIP, ChatGPT JSON export, " +
    "or Claude Code JSONL file. Parsed conversations are stored in the " +
    "memory graph for recall, analysis, and coaching.",
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the export file (ZIP, JSON, or JSONL)"),
    format: z.enum(["claude-export", "chatgpt-export", "claude-code-jsonl", "auto"])
      .default("auto")
      .describe("Export format. Use 'auto' to detect automatically."),
  }),
  annotations: {
    destructiveHint: false,
    readOnlyHint: false,
  },
}, async (args) => {
  return handleImport(args.file_path, args.format);
});

// ── kairos_recall ──────────────────────────────────────────────────────
server.registerTool("kairos_recall", {
  title: "Recall Past Conversations",
  description:
    "Search your conversation history by topic, entity, or keyword. " +
    "Uses graph traversal first (fast, precise) then embedding similarity " +
    "as fallback (fuzzy, broader). Returns conversation summaries with " +
    "key ideas, decisions, and connections to other conversations. " +
    "Use this when you want to remember what was discussed about a topic.",
  inputSchema: z.object({
    query: z.string().describe("Topic, entity name, or keyword to search for"),
    max_results: z.number().default(5).describe("Maximum conversations to return"),
    include_messages: z.boolean().default(false).describe("Include message excerpts (returns summaries only by default)"),
  }),
  annotations: {
    readOnlyHint: true,
  },
}, async (args) => {
  return handleRecall(args.query, args.max_results, args.include_messages);
});

// ── kairos_reflect ─────────────────────────────────────────────────────
server.registerTool("kairos_reflect", {
  title: "Reflect on Patterns",
  description:
    "Get insights about your AI conversation patterns and attention habits. " +
    "Returns behavioral signals (peak hours, fragmentation score, drift tendencies), " +
    "coaching insights using the OIE framework (Observe, Implication, Experiment), " +
    "and interaction style analysis. Works on metadata — no conversation content needed " +
    "at Mirror tier. Use this to help the user understand their thinking patterns.",
  inputSchema: z.object({
    period: z.enum(["today", "week", "month", "all"]).default("week").describe("Time period to analyze"),
    focus: z.enum(["attention", "drift", "coaching", "all"]).default("all").describe("What aspect to focus on"),
  }),
  annotations: {
    readOnlyHint: true,
  },
}, async (args) => {
  return handleReflect(args.period, args.focus);
});

// ── kairos_connections ─────────────────────────────────────────────────
server.registerTool("kairos_connections", {
  title: "Find Connected Conversations",
  description:
    "Explore connections between conversations in your history. " +
    "Connections include: semantic similarity, shared entities, topic continuation, " +
    "contradictions, idea evolution, and temporal proximity. Connection strength " +
    "follows a pheromone model — frequently co-accessed conversations strengthen, " +
    "neglected connections fade. Use this to discover hidden patterns across conversations.",
  inputSchema: z.object({
    conversation_id: z.string().optional().describe("UUID of a conversation to find connections for"),
    topic: z.string().optional().describe("Or search by topic to find connected conversation clusters"),
    connection_types: z.array(z.string()).optional().describe("Filter by connection type: semantic_similarity, shared_entity, topic_continuation, contradiction, evolution"),
    min_strength: z.number().default(0.1).describe("Minimum connection strength 0-1"),
  }),
  annotations: {
    readOnlyHint: true,
  },
}, async (args) => {
  return handleConnections(args);
});

// ── kairos_resurface ───────────────────────────────────────────────────
server.registerTool("kairos_resurface", {
  title: "Resurface Ideas",
  description:
    "Get ideas from past conversations that are due for revisiting. " +
    "Uses SM-2 spaced repetition: important ideas surface at expanding " +
    "intervals (1 → 3 → 7 → 14 → 30 days), modulated by your engagement. " +
    "Ideas are enrolled based on: high importance score, unresolved decisions, " +
    "recurring themes, or cluster membership. Returns up to 3 ideas with " +
    "their context and connection graph. Proactively use this at the start " +
    "of conversations to remind the user of forgotten threads.",
  inputSchema: z.object({
    max_ideas: z.number().default(3).describe("Maximum ideas to return"),
    engage: z.object({
      idea_id: z.string().describe("UUID of the idea to engage with"),
      action: z.enum(["click", "revisit", "dismiss", "act"]).describe("Type of engagement"),
    }).optional().describe("Record engagement with a previously surfaced idea (updates SM-2 scheduling)"),
  }),
  annotations: {
    readOnlyHint: false, // engage action writes to DB
    destructiveHint: false,
  },
}, async (args) => {
  return handleResurface(args.max_ideas, args.engage);
});

// ── kairos_profile ────────────────────────────────────────────────────
server.registerTool("kairos_profile", {
  title: "Get Thinking Profile",
  description:
    "Returns your complete thinking profile formatted for system prompt injection. " +
    "Includes: engagement metrics (verification rate, generation ratio, drift rate), " +
    "top concepts and expertise areas, active projects, ideas due for resurfacing, " +
    "coaching insights, and behavioral fingerprint. Use this at the start of a " +
    "conversation to understand the user's thinking patterns. All available Kairos " +
    "tools are listed in the response.",
  inputSchema: z.object({}),
  annotations: {
    readOnlyHint: true,
  },
}, async () => {
  return handleProfile();
});

// ── kairos_coach ──────────────────────────────────────────────────────
server.registerTool("kairos_coach", {
  title: "Coach Current Conversation",
  description:
    "Analyze the current conversation's engagement patterns and provide coaching. " +
    "Pass the conversation messages and Kairos will: (1) classify each turn's " +
    "engagement state (deep, passive, verification, etc.), (2) detect topic drift, " +
    "(3) compare engagement to the user's historical baseline, (4) generate " +
    "specific coaching guidance for both Claude and the user. " +
    "Call this when you notice the user becoming passive, when the conversation " +
    "drifts, or when the user asks for feedback on their thinking patterns.",
  inputSchema: z.object({
    messages: z.array(z.object({
      role: z.string().describe("'user' or 'assistant'"),
      content: z.union([z.string(), z.array(z.any()), z.any()]).describe("Message content (string or content blocks)"),
    })).optional().describe("Current conversation messages. Pass as many as available."),
    intent: z.string().optional().describe("What the user is trying to accomplish in this conversation"),
    focus: z.enum(["engagement", "drift", "ideas", "all"]).default("all").describe("What aspect to analyze"),
    session_file: z.string().optional().describe("Path to Claude Code session JSONL file for full conversation history"),
  }),
  annotations: {
    readOnlyHint: true,
  },
}, async (args) => {
  return handleCoach({
    messages: args.messages as Array<{ role: string; content: string }> | undefined,
    intent: args.intent,
    focus: args.focus,
    sessionFile: args.session_file,
  });
});

// ── Start server ───────────────────────────────────────────────────────

async function main() {
  // Run pending database migrations before starting (if enabled)
  const { runMigrations } = await import("./migrate.js");
  const migrationResult = await runMigrations();
  if (migrationResult.failed) {
    console.error(`[Kairos] Migration failed: ${migrationResult.failed.file} — ${migrationResult.failed.error}`);
    console.error("[Kairos] Server starting anyway — some features may not work correctly.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Kairos MCP server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start Kairos MCP server:", err);
  process.exit(1);
});
