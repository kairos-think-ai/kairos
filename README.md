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

2. Enable **Google OAuth** in Authentication > Providers > Google. You'll need a Google Cloud OAuth client — create one at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials), set the authorized redirect URI to `https://<your-project>.supabase.co/auth/v1/callback`, then paste the Client ID and Secret into Supabase.
3. Add your app's URL to Supabase **Authentication > URL Configuration > Site URL** (e.g. `http://localhost:3000` for dev, your Vercel URL for prod) and add the same URL plus `/auth/callback` to **Redirect URLs**.
4. Copy your project URL, anon key, and service role key from Settings > API.

### 3. Configure environment

```bash
cp packages/web/.env.example packages/web/.env.local
```

Fill in your Supabase credentials, Anthropic API key, and Voyage AI API key.

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

### 6. Load the Chrome extension (optional, for real-time capture)

The browser extension captures Claude.ai / ChatGPT / Gemini conversations as they happen and shows live coaching nudges. It's optional — you can also use the dashboard import flow without it.

1. Build the extension:
   ```bash
   npx esbuild packages/extension/src/background/service-worker.ts \
     --bundle --format=esm --target=chrome120 \
     --outfile=packages/extension/dist/src/background/service-worker.js
   ```
   (Content scripts for MAIN and ISOLATED worlds need separate builds — see `packages/extension/README.md`.)

2. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**. Select `packages/extension/dist/`.

3. Chrome assigns your install a unique extension ID. Copy it from the extensions page.

4. Tell the dashboard about it. The current code hardcodes a development extension ID in three places:
   - `packages/web/src/app/import/page.tsx`
   - `packages/web/src/app/onboarding/page.tsx`
   - `packages/web/src/app/page.tsx`

   Search for `KAIROS_EXTENSION_ID` and replace the value with your own ID. (We're moving this to an env var — see issue tracker.)

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
- A [Voyage AI](https://www.voyageai.com) API key (for message embeddings)
- Google OAuth credentials (configured in Supabase)
- A hosting platform (Vercel, Railway, or any Node.js host)

We provide: the full product code, database migrations (auto-applied on deploy), and the MCP server.

## Contributing

Issues and pull requests welcome. The engine (`packages/core`) is where the methodology lives. The classifier, clustering, and coaching algorithms are all there.

## License

Apache 2.0 — see [LICENSE](LICENSE).
