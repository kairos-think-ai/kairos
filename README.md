# Kairos

The human capability layer for AI conversations.

Kairos analyzes how you think with AI. It tracks engagement patterns, detects drift from your intent, extracts ideas, maps your concept graph, and coaches you in real-time across conversations.

## What It Does

- **Thinking Profile** — see your verification rate, idea generation ratio, drift patterns, and engagement breakdown across all your AI conversations
- **Live Coaching** — mid-conversation, Kairos detects when you're passively accepting, drifting, or not verifying, and coaches both you and the AI
- **Concept Graph** — force-directed visualization of your ideas and how they connect, with Louvain community detection
- **Idea Resurfacing** — spaced repetition surfaces forgotten ideas at the right time
- **7 Universal Metrics** — verification rate, generation ratio, iteration depth, drift rate, discovery entropy, idea follow-through, cognitive load

## Architecture

```
packages/
  core/       — @kairos/core: engagement classifier, coaching engine, stats, graph algorithms
  mcp/        — MCP server: 7 tools for Claude/Gemini integration
  web/        — Next.js dashboard: 5 views, force-directed graph, OAuth, API routes
  extension/  — Chrome extension: real-time conversation capture
  plugin/     — Claude Code plugin: SessionStart hooks, skills

supabase/
  migrations/ — Database schema (14 migrations)
```

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/kairos-think-ai/kairos.git
cd kairos
npm install
```

### 2. Set up Supabase

Create a project at [supabase.com](https://supabase.com). Then:

1. Go to **SQL Editor** and run this bootstrap function (one-time):

```sql
CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS void AS $$
BEGIN
  EXECUTE query;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

2. Enable **Google OAuth** in Authentication > Providers > Google
3. Copy your project URL, anon key, and service role key from Settings > API

### 3. Configure environment

```bash
cp packages/web/.env.example packages/web/.env.local
```

Fill in your Supabase credentials, Anthropic API key, and OpenAI API key.

### 4. Run

```bash
npm run dev --workspace=packages/web
```

Open [localhost:3000](http://localhost:3000). Database migrations run automatically on first start.

### 5. Deploy

Deploy to Vercel:

```bash
vercel --prod
```

Set the root directory to `packages/web` and add your environment variables in the Vercel dashboard.

## Connect to Claude

### Claude.ai (web)

1. Go to **Settings > Connectors > Add Custom Connector**
2. Enter your deployment URL: `https://your-app.vercel.app/api/mcp`
3. Authenticate with your Kairos account
4. Ask Claude: "Load my Kairos thinking profile"

### Claude Code (CLI)

```bash
claude mcp add kairos --transport http https://your-app.vercel.app/api/mcp
```

### Claude Desktop

Connectors sync from Claude.ai automatically.

## MCP Tools

| Tool | What it does |
|---|---|
| `kairos_profile` | Your thinking profile: metrics, concepts, coaching insights |
| `kairos_coach` | Live analysis of current conversation + coaching guidance |
| `kairos_recall` | Search past conversations by topic (graph traversal + embeddings) |
| `kairos_reflect` | Behavioral signals, 7 universal metrics, OIE coaching |
| `kairos_resurface` | Ideas due for spaced repetition review |
| `kairos_connections` | Explore concept connections across conversations |
| `kairos_import` | Import conversation exports (Claude, ChatGPT, Gemini) |

## Coaching Architecture

**Layer 1 — Always-On Profile:** Your thinking profile is available to the AI from the start of every conversation. It knows your patterns, expertise, and ideas to resurface.

**Layer 2 — On-Demand Coach:** Mid-conversation, the AI (or you) can call `kairos_coach` to analyze the current conversation against your historical baseline. It detects passive acceptance, drift, and verification gaps.

**Layer 3 — Real-Time Nudges:** The browser extension detects engagement patterns turn-by-turn and shows subtle coaching indicators during Claude.ai conversations.

## Engine (@kairos/core)

Pure computation, no database dependencies. The methodology:

- **Turn-level engagement classification** — 6 states adapted from Mozannar CUPS (CHI 2024): Deep Engagement, Passive Acceptance, Verification, Prompt Crafting, Redirecting, Deferred
- **Louvain community detection** — algorithmic concept clustering with modularity optimization
- **HDBSCAN clustering** — topic detection from message embeddings
- **Centroid drift curve** — measures how conversations diverge from their starting point
- **Personalized PageRank** — graph-first retrieval from the knowledge graph (from HippoRAG, NeurIPS 2024)
- **Modified Leitner** — spaced repetition with engagement feedback propagation

## Self-Hosting

You bring:
- A [Supabase](https://supabase.com) project (database + auth)
- An [Anthropic](https://console.anthropic.com) API key (for conversation analysis)
- An [OpenAI](https://platform.openai.com) API key (for message embeddings)
- Google OAuth credentials (configured in Supabase)
- A hosting platform (Vercel, Railway, or any Node.js host)

We provide: the full product code, database migrations (auto-applied on deploy), and the MCP server.

## Contributing

Issues and pull requests welcome. The engine (`packages/core`) is where the methodology lives. The classifier, clustering, and coaching algorithms are all there.

## License

MIT
