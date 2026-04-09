-- Kairos Database Schema — MCP Memory Fields
-- Migration: 006_mcp_memory_fields
--
-- Adds fields needed for MCP server memory layer:
--   conversations.summary  — AI-generated conversation summary (OpenSage-inspired graph compression)
--   conversation_connections.custom_type — AI-discovered connection types beyond the fixed enum

-- Conversation summaries for MCP tool responses (avoid dumping full text)
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS summary text;

-- AI-created connection types (OpenSage-inspired: let the curator discover new patterns)
ALTER TABLE public.conversation_connections
  ADD COLUMN IF NOT EXISTS custom_type text;

-- Index for summary-based search in kairos_recall
CREATE INDEX IF NOT EXISTS idx_conversations_summary
  ON public.conversations USING gin (to_tsvector('english', coalesce(summary, '')));
