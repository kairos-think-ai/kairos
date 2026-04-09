-- Kairos Database Schema
-- Migration: 001_initial_schema
-- Architecture: Gateway Attention State Model (encrypted at rest via Supabase)

-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "vector";  -- pgvector for idea embeddings

-- ============================================================
-- CORE: Users & Settings
-- ============================================================

create table public.users (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  display_name text,
  avatar_url text,
  -- Attention profile (calibrated over time)
  attention_profile jsonb default '{}'::jsonb,
  -- User preferences
  settings jsonb default '{
    "platforms_enabled": ["claude", "chatgpt", "gemini", "copilot"],
    "capture_paused": false,
    "email_digest": true,
    "digest_frequency": "weekly",
    "timezone": "UTC"
  }'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- NODE LAYER: Raw Signal Capture
-- ============================================================

create type platform_type as enum ('claude', 'chatgpt', 'gemini', 'copilot', 'other');
create type message_role as enum ('user', 'assistant', 'system');
create type analysis_status as enum ('pending', 'processing', 'completed', 'failed');

create table public.conversations (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  platform platform_type not null,
  platform_conversation_id text,  -- ID from the source platform
  title text,
  started_at timestamptz not null,
  ended_at timestamptz,
  message_count integer default 0,
  -- Analysis state
  analysis_status analysis_status default 'pending',
  analyzed_at timestamptz,
  -- Metadata from the node
  url text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique(user_id, platform, platform_conversation_id)
);

create table public.messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role message_role not null,
  content text not null,
  sequence integer not null,  -- Order within conversation
  timestamp timestamptz,
  -- Token estimate for cost tracking
  token_estimate integer,
  created_at timestamptz default now(),

  unique(conversation_id, sequence)
);

-- ============================================================
-- SKILL OUTPUTS: Analysis Results
-- ============================================================

-- Skill: idea-extractor
create table public.ideas (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  summary text not null,
  context text,  -- Surrounding context from conversation
  category text,  -- e.g., 'product', 'technical', 'strategic', 'personal'
  importance_score float default 0.5,  -- 0-1, calibrated by importance-scorer skill
  embedding vector(1536),  -- For similarity search
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Idea clustering (cross-conversation pattern detection)
create table public.idea_clusters (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  label text not null,
  description text,
  idea_count integer default 0,
  -- Cluster health
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  recurrence_count integer default 1,  -- How many conversations touch this cluster
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table public.idea_cluster_members (
  idea_id uuid not null references public.ideas(id) on delete cascade,
  cluster_id uuid not null references public.idea_clusters(id) on delete cascade,
  similarity_score float,
  primary key (idea_id, cluster_id)
);

-- Skill: intent-classifier + drift-analyzer
create type drift_category as enum (
  'on_track',        -- Stayed on original intent
  'productive_drift', -- Drifted but to something useful
  'rabbit_hole',      -- Deep tangent, unclear value
  'context_switch',   -- Completely changed topics
  'exploratory'       -- No clear intent, browsing/thinking
);

create table public.drift_reports (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid unique not null references public.conversations(id) on delete cascade,
  -- What user intended
  inferred_intent text not null,
  intent_category text,  -- e.g., 'coding', 'writing', 'research', 'planning'
  intent_confidence float,
  -- What actually happened
  actual_outcome text not null,
  outcome_category text,
  -- The drift
  drift_score float not null,  -- 0 (on track) to 1 (completely off)
  drift_category drift_category not null,
  -- Topic trajectory (ordered list of topic shifts)
  trajectory jsonb default '[]'::jsonb,
  -- e.g., [{"topic": "API design", "message_range": [1,5]}, {"topic": "auth patterns", "message_range": [6,12]}]
  created_at timestamptz default now()
);

-- Skill: action-item-extractor
create type action_status as enum ('surfaced', 'acknowledged', 'completed', 'dismissed', 'stale');

create table public.action_items (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  description text not null,
  status action_status default 'surfaced',
  -- Tracking
  surfaced_at timestamptz default now(),
  acknowledged_at timestamptz,
  completed_at timestamptz,
  dismissed_at timestamptz,
  -- Auto-stale after N days with no follow-up
  stale_after_days integer default 14,
  created_at timestamptz default now()
);

-- Skill: revisit-moments (the "Revisit Moments" feature from the tweet)
create type revisit_reason as enum (
  'high_engagement',    -- Lots of back-and-forth on this idea
  'never_followed_up',  -- Important idea, zero follow-up
  'contradiction',      -- User said opposite things in different convos
  'recurring_theme',    -- Keeps coming up across conversations
  'decision_unmade',    -- Decision was discussed but not made
  'connection_found'    -- Links to something from a different conversation
);

create table public.revisit_moments (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- Can reference an idea, action item, or conversation
  idea_id uuid references public.ideas(id) on delete set null,
  action_item_id uuid references public.action_items(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  -- The moment
  title text not null,
  description text not null,
  reason revisit_reason not null,
  importance_score float default 0.5,
  -- User interaction
  surfaced_at timestamptz default now(),
  seen_at timestamptz,
  revisited_at timestamptz,
  dismissed_at timestamptz,
  -- Delivery tracking
  delivered_via text,  -- 'dashboard', 'email', 'extension'
  created_at timestamptz default now()
);

-- ============================================================
-- CRON/HEARTBEAT: Scheduled Processing State
-- ============================================================

create table public.processing_queue (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  skill_name text not null,  -- Which skill to run
  priority integer default 0,
  status analysis_status default 'pending',
  attempts integer default 0,
  max_attempts integer default 3,
  error_message text,
  scheduled_for timestamptz default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================

create index idx_conversations_user on public.conversations(user_id, created_at desc);
create index idx_conversations_status on public.conversations(analysis_status) where analysis_status = 'pending';
create index idx_messages_conversation on public.messages(conversation_id, sequence);
create index idx_ideas_user on public.ideas(user_id, created_at desc);
-- ivfflat index for embedding similarity search — add later when we have data
-- create index idx_ideas_embedding on public.ideas using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index idx_ideas_cluster on public.idea_cluster_members(cluster_id);
create index idx_drift_conversation on public.drift_reports(conversation_id);
create index idx_action_items_user_status on public.action_items(user_id, status);
create index idx_revisit_moments_user on public.revisit_moments(user_id, surfaced_at desc);
create index idx_revisit_unseen on public.revisit_moments(user_id) where seen_at is null;
create index idx_processing_queue on public.processing_queue(status, scheduled_for) where status = 'pending';

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ideas enable row level security;
alter table public.idea_clusters enable row level security;
alter table public.idea_cluster_members enable row level security;
alter table public.drift_reports enable row level security;
alter table public.action_items enable row level security;
alter table public.revisit_moments enable row level security;
alter table public.processing_queue enable row level security;

-- Users can only access their own data
create policy "Users read own data" on public.users for select using (auth.uid() = id);
create policy "Users update own data" on public.users for update using (auth.uid() = id);

create policy "Users read own conversations" on public.conversations for all using (auth.uid() = user_id);
create policy "Users read own messages" on public.messages for all
  using (conversation_id in (select id from public.conversations where user_id = auth.uid()));

create policy "Users read own ideas" on public.ideas for all using (auth.uid() = user_id);
create policy "Users read own clusters" on public.idea_clusters for all using (auth.uid() = user_id);
create policy "Users read own cluster members" on public.idea_cluster_members for all
  using (cluster_id in (select id from public.idea_clusters where user_id = auth.uid()));

create policy "Users read own drift reports" on public.drift_reports for all
  using (conversation_id in (select id from public.conversations where user_id = auth.uid()));

create policy "Users read own action items" on public.action_items for all using (auth.uid() = user_id);
create policy "Users read own revisit moments" on public.revisit_moments for all using (auth.uid() = user_id);
create policy "Users read own queue" on public.processing_queue for all using (auth.uid() = user_id);

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Auto-update updated_at timestamp
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_updated_at before update on public.users
  for each row execute function public.handle_updated_at();
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.handle_updated_at();
create trigger idea_clusters_updated_at before update on public.idea_clusters
  for each row execute function public.handle_updated_at();

-- Auto-create user profile on auth signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
