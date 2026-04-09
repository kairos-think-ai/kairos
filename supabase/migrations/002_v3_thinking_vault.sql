-- Kairos Database Schema — v3.0 Thinking Vault Migration
-- Migration: 002_v3_thinking_vault
-- Architecture: 5-layer Thinking Vault + 7-level analysis pipeline + 2-tier privacy model
--
-- New tables:
--   audit_log              — Cross-cutting audit trail (from AgentVault pattern)
--   behavioral_profile     — L1 digital phenotyping (Tier 1: The Mirror)
--   sessions               — L3 session grouping (temporally proximate conversations)
--   projects               — L4 auto-detected project clusters
--   conversation_connections — L4 Pulse layer (emergent cross-conversation links)
--   entities               — L3 Constellation (named entities across conversations)
--   entity_mentions         — Entity occurrence tracking
--   idea_resurfacing       — SM-2 spaced repetition for ideas
--   temporal_snapshots     — L6 periodic thinking evolution snapshots
--   coaching_insights      — L7 OIE-framework insights
--
-- Schema changes to existing tables:
--   users.privacy_tier     — 2-tier model (mirror/analyst)
--   ideas.embedding        — vector(1024) for Voyage AI embeddings
--   drift_reports.user_id  — Added for direct RLS
--   messages.user_id       — Added for direct queries

-- ============================================================
-- SCHEMA CHANGES TO EXISTING TABLES
-- ============================================================

-- Add privacy tier to users (The Mirror vs The Analyst)
create type privacy_tier as enum ('mirror', 'analyst');
alter table public.users add column if not exists privacy_tier privacy_tier default 'mirror';

-- Add user_id to drift_reports for direct RLS queries
alter table public.drift_reports add column if not exists user_id uuid references public.users(id) on delete cascade;

-- Backfill user_id on drift_reports from conversations
update public.drift_reports dr
  set user_id = c.user_id
  from public.conversations c
  where dr.conversation_id = c.id
  and dr.user_id is null;

-- Add user_id to messages for direct queries
alter table public.messages add column if not exists user_id uuid references public.users(id) on delete cascade;

-- Backfill user_id on messages from conversations
update public.messages m
  set user_id = c.user_id
  from public.conversations c
  where m.conversation_id = c.id
  and m.user_id is null;

-- ============================================================
-- AUDIT TRAIL (Cross-cutting — from AgentVault pattern)
-- Every operation on user data is logged here.
-- ============================================================

create table public.audit_log (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- What happened
  skill_name text not null,          -- e.g., 'idea-extractor', 'drift-analyzer', 'system'
  action text not null,              -- e.g., 'read', 'analyze', 'cloud_send', 'export'
  -- What was affected
  conversation_id uuid references public.conversations(id) on delete set null,
  data_type text,                    -- e.g., 'conversation', 'idea', 'embedding'
  -- Where did the result go
  destination text default 'local',  -- 'local', 'cloud', 'claude_api', 'export'
  -- Context
  details jsonb default '{}'::jsonb, -- Flexible metadata (item count, error messages, etc.)
  duration_ms integer,               -- How long the operation took
  created_at timestamptz default now()
);

-- ============================================================
-- L1: BEHAVIORAL PROFILE (Tier 1 — The Mirror)
-- Digital phenotyping: timing, platform, structure patterns.
-- No conversation content stored here — metadata only.
-- ============================================================

create table public.behavioral_profile (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  date date not null,                         -- One profile per user per day
  -- Timing patterns (chronobiological)
  platform_switches integer default 0,        -- Cross-platform switches in the day
  total_sessions integer default 0,           -- Number of distinct work sessions
  avg_session_duration_minutes float,         -- Mean session length
  peak_hour integer,                          -- Hour with most activity (0-23)
  conversation_count_by_hour jsonb default '{}'::jsonb,  -- {"9": 3, "14": 5, "22": 1}
  -- Attention patterns
  fragmentation_score float,                  -- 0 (focused) to 1 (fragmented)
  avg_messages_per_conversation float,        -- Depth of engagement
  avg_conversation_duration_minutes float,    -- How long conversations last
  question_ratio float,                       -- Fraction of messages containing "?"
  -- Platform distribution
  platform_distribution jsonb default '{}'::jsonb,  -- {"claude": 5, "chatgpt": 2}
  -- Computed
  created_at timestamptz default now(),

  unique(user_id, date)
);

-- ============================================================
-- L3: SESSIONS (Temporally proximate conversations)
-- Conversations within <2hr gap are grouped into a session.
-- ============================================================

create table public.sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  -- Content
  conversation_ids jsonb default '[]'::jsonb,  -- Array of conversation UUIDs
  platform text,                               -- Primary platform (most messages)
  -- Analysis (L3 session-level analysis)
  session_analysis jsonb default '{}'::jsonb,  -- {goals, outcomes, key_decisions, ...}
  analysis_status analysis_status default 'pending',
  analyzed_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- L4: PROJECTS (Auto-detected from clusters spanning 2+ weeks)
-- ============================================================

create table public.projects (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  label text not null,
  description text,
  -- Linked items
  conversation_ids jsonb default '[]'::jsonb,  -- Array of conversation UUIDs
  cluster_ids jsonb default '[]'::jsonb,       -- Array of idea_cluster UUIDs
  -- Lifecycle
  status text default 'active',                -- 'active', 'dormant', 'completed'
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- L4: CONVERSATION CONNECTIONS (Pulse Layer)
-- Emergent cross-conversation links that strengthen through use
-- and weaken through non-use (ant colony / pheromone model).
-- ============================================================

create type connection_type as enum (
  'semantic_similarity',   -- Embedding cosine similarity
  'shared_entity',         -- Same entity mentioned in both
  'temporal_proximity',    -- Close in time
  'topic_continuation',    -- Same topic, later conversation
  'contradiction',         -- Opposing views
  'evolution',             -- Idea evolved from one to another
  'user_linked'            -- User explicitly connected them
);

create table public.conversation_connections (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  conversation_a_id uuid not null references public.conversations(id) on delete cascade,
  conversation_b_id uuid not null references public.conversations(id) on delete cascade,
  -- Connection metadata
  connection_type connection_type not null,
  strength float default 0.5,                -- 0-1, strengthens on co-access, decays over time
  description text,                          -- Human-readable explanation
  -- Pulse dynamics
  discovered_at timestamptz default now(),
  last_accessed_at timestamptz,
  access_count integer default 0,            -- Strengthens on access (stigmergic)
  -- Decay tracking: connections weaken if not accessed
  -- strength = base_strength * exp(-decay_rate * days_since_access)
  decay_rate float default 0.01,

  -- No duplicate connections between same two conversations
  unique(conversation_a_id, conversation_b_id, connection_type)
);

-- ============================================================
-- L3: ENTITIES (Constellation — named entities)
-- Lightweight property graph for pattern completion queries.
-- ============================================================

create type entity_type as enum (
  'person', 'technology', 'concept', 'project_name',
  'tool', 'company', 'decision', 'goal', 'other'
);

create table public.entities (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  type entity_type not null,
  -- Aggregates
  first_mentioned_at timestamptz,
  last_mentioned_at timestamptz,
  mention_count integer default 1,
  -- Metadata
  aliases jsonb default '[]'::jsonb,   -- Alternate names for this entity
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),

  unique(user_id, name, type)
);

create table public.entity_mentions (
  id uuid primary key default uuid_generate_v4(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- Context
  context text,              -- Surrounding text snippet
  message_sequence integer,  -- Which message in the conversation
  sentiment text,            -- 'positive', 'negative', 'neutral'
  created_at timestamptz default now()
);

-- ============================================================
-- SM-2 SPACED REPETITION FOR IDEAS
-- Adapted SM-2 algorithm: resurface important ideas at expanding
-- intervals, modulated by importance, connections, and cluster activity.
-- ============================================================

create table public.idea_resurfacing (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  idea_id uuid not null references public.ideas(id) on delete cascade,
  -- SM-2 algorithm state
  interval_days integer default 1,         -- Current interval (1 → 3 → 7 → 14 → 30)
  ease_factor float default 2.5,           -- SM-2 ease factor (modulated by feedback)
  next_surface_at timestamptz not null,    -- When to show this idea next
  -- Tracking
  times_surfaced integer default 0,
  -- Last user engagement type
  last_engagement text,                    -- 'click', 'revisit', 'dismiss', 'act'
  last_engagement_at timestamptz,
  -- Auto-enrollment reason
  enrollment_reason text,                  -- 'high_importance', 'cluster_member', 'unresolved_decision'
  -- Lifecycle
  is_active boolean default true,          -- False = user permanently dismissed
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique(user_id, idea_id)
);

-- ============================================================
-- L6: TEMPORAL SNAPSHOTS
-- Periodic snapshots of thinking patterns for evolution tracking.
-- ============================================================

create type snapshot_type as enum ('daily', 'weekly', 'monthly');

create table public.temporal_snapshots (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  snapshot_type snapshot_type not null,
  -- Metrics blob
  metrics jsonb not null default '{}'::jsonb,
  -- Example metrics:
  -- {
  --   "conversation_count": 12,
  --   "idea_count": 34,
  --   "avg_drift_score": 0.42,
  --   "top_categories": ["technical", "product"],
  --   "platform_distribution": {"claude": 8, "chatgpt": 4},
  --   "new_entities": 5,
  --   "connection_count": 12,
  --   "fragmentation_score": 0.3
  -- }
  created_at timestamptz default now(),

  unique(user_id, period_start, snapshot_type)
);

-- ============================================================
-- L7: COACHING INSIGHTS (OIE Framework)
-- Observe → Implication → Experiment
-- ============================================================

create table public.coaching_insights (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  -- OIE structure
  observation text not null,    -- Factual, specific, numbered
  implication text,             -- Tentative, "might" / "could"
  experiment text,              -- Optional, never prescriptive
  -- Metadata
  category text,                -- e.g., 'attention_pattern', 'drift_trend', 'idea_evolution'
  data_points jsonb default '[]'::jsonb,  -- References to supporting data
  period_start timestamptz,
  period_end timestamptz,
  -- User interaction
  seen_at timestamptz,
  helpful boolean,              -- User feedback: was this useful?
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Audit log: query by user, skill, or time range
create index idx_audit_log_user on public.audit_log(user_id, created_at desc);
create index idx_audit_log_skill on public.audit_log(skill_name, created_at desc);
create index idx_audit_log_conversation on public.audit_log(conversation_id) where conversation_id is not null;

-- Behavioral profile: daily lookup
create index idx_behavioral_profile_user_date on public.behavioral_profile(user_id, date desc);

-- Sessions: user timeline
create index idx_sessions_user on public.sessions(user_id, started_at desc);
create index idx_sessions_status on public.sessions(analysis_status) where analysis_status = 'pending';

-- Projects: user projects
create index idx_projects_user on public.projects(user_id, last_seen_at desc);
create index idx_projects_active on public.projects(user_id, status) where status = 'active';

-- Connections (Pulse): find connections for a conversation
create index idx_connections_convo_a on public.conversation_connections(conversation_a_id);
create index idx_connections_convo_b on public.conversation_connections(conversation_b_id);
create index idx_connections_user on public.conversation_connections(user_id, discovered_at desc);
create index idx_connections_strength on public.conversation_connections(user_id, strength desc) where strength > 0.1;

-- Entities: lookup and search
create index idx_entities_user on public.entities(user_id, mention_count desc);
create index idx_entities_name on public.entities(user_id, name);
create index idx_entity_mentions_entity on public.entity_mentions(entity_id, created_at desc);
create index idx_entity_mentions_conversation on public.entity_mentions(conversation_id);

-- Idea resurfacing: find ideas due for resurfacing
create index idx_resurfacing_due on public.idea_resurfacing(user_id, next_surface_at)
  where is_active = true;
create index idx_resurfacing_idea on public.idea_resurfacing(idea_id);

-- Temporal snapshots: user + period lookup
create index idx_temporal_snapshots_user on public.temporal_snapshots(user_id, period_start desc);

-- Coaching insights: user timeline
create index idx_coaching_insights_user on public.coaching_insights(user_id, created_at desc);
create index idx_coaching_insights_unseen on public.coaching_insights(user_id)
  where seen_at is null;

-- Drift reports: now has user_id for direct queries
create index idx_drift_reports_user on public.drift_reports(user_id, created_at desc)
  where user_id is not null;

-- Messages: user_id for direct queries
create index idx_messages_user on public.messages(user_id, created_at desc)
  where user_id is not null;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.audit_log enable row level security;
alter table public.behavioral_profile enable row level security;
alter table public.sessions enable row level security;
alter table public.projects enable row level security;
alter table public.conversation_connections enable row level security;
alter table public.entities enable row level security;
alter table public.entity_mentions enable row level security;
alter table public.idea_resurfacing enable row level security;
alter table public.temporal_snapshots enable row level security;
alter table public.coaching_insights enable row level security;

-- Users can only access their own data
create policy "Users read own audit log" on public.audit_log for select using (auth.uid() = user_id);
create policy "Users read own behavioral profile" on public.behavioral_profile for all using (auth.uid() = user_id);
create policy "Users read own sessions" on public.sessions for all using (auth.uid() = user_id);
create policy "Users read own projects" on public.projects for all using (auth.uid() = user_id);
create policy "Users read own connections" on public.conversation_connections for all using (auth.uid() = user_id);
create policy "Users read own entities" on public.entities for all using (auth.uid() = user_id);
create policy "Users read own entity mentions" on public.entity_mentions for all
  using (entity_id in (select id from public.entities where user_id = auth.uid()));
create policy "Users read own resurfacing" on public.idea_resurfacing for all using (auth.uid() = user_id);
create policy "Users read own temporal snapshots" on public.temporal_snapshots for all using (auth.uid() = user_id);
create policy "Users read own coaching insights" on public.coaching_insights for all using (auth.uid() = user_id);

-- Audit log is append-only for users (no update/delete via RLS)
create policy "Users insert own audit log" on public.audit_log for insert with check (auth.uid() = user_id);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at on new tables
create trigger projects_updated_at before update on public.projects
  for each row execute function public.handle_updated_at();

create trigger idea_resurfacing_updated_at before update on public.idea_resurfacing
  for each row execute function public.handle_updated_at();

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Decay connection strength based on time since last access
-- Called by a weekly cron job
create or replace function public.decay_connection_strengths()
returns void as $$
begin
  update public.conversation_connections
  set strength = greatest(
    0.01,  -- Minimum strength (never fully zero — can always be rediscovered)
    strength * exp(-decay_rate * extract(epoch from (now() - coalesce(last_accessed_at, discovered_at))) / 86400)
  )
  where is_distinct_from(
    strength,
    greatest(
      0.01,
      strength * exp(-decay_rate * extract(epoch from (now() - coalesce(last_accessed_at, discovered_at))) / 86400)
    )
  );
end;
$$ language plpgsql security definer;

-- Strengthen connection on access (Pulse stigmergic pattern)
create or replace function public.strengthen_connection(connection_uuid uuid)
returns void as $$
begin
  update public.conversation_connections
  set
    strength = least(1.0, strength + 0.1),
    access_count = access_count + 1,
    last_accessed_at = now()
  where id = connection_uuid;
end;
$$ language plpgsql security definer;

-- Get ideas due for resurfacing (SM-2 scheduler)
-- Returns up to max_count ideas that are past their next_surface_at date
create or replace function public.get_due_ideas(p_user_id uuid, max_count integer default 3)
returns table(
  idea_id uuid,
  summary text,
  category text,
  importance_score float,
  interval_days integer,
  times_surfaced integer,
  enrollment_reason text
) as $$
begin
  return query
  select
    ir.idea_id,
    i.summary,
    i.category,
    i.importance_score,
    ir.interval_days,
    ir.times_surfaced,
    ir.enrollment_reason
  from public.idea_resurfacing ir
  join public.ideas i on i.id = ir.idea_id
  where ir.user_id = p_user_id
    and ir.is_active = true
    and ir.next_surface_at <= now()
  order by i.importance_score desc, ir.next_surface_at asc
  limit max_count;
end;
$$ language plpgsql security definer;

-- Update SM-2 state after user engagement
create or replace function public.update_resurfacing_after_engagement(
  p_resurfacing_id uuid,
  p_engagement_type text  -- 'click', 'revisit', 'dismiss', 'act'
)
returns void as $$
declare
  ease_delta float;
  current_ease float;
  current_interval integer;
  new_ease float;
  new_interval integer;
begin
  -- Engagement → ease factor adjustments
  case p_engagement_type
    when 'click' then ease_delta := 0.1;
    when 'revisit' then ease_delta := 0.15;
    when 'act' then ease_delta := 0.3;
    when 'dismiss' then ease_delta := -0.2;
    else ease_delta := 0.0;
  end case;

  select ease_factor, interval_days
  into current_ease, current_interval
  from public.idea_resurfacing
  where id = p_resurfacing_id;

  -- Update ease factor (clamped to [1.3, 5.0])
  new_ease := greatest(1.3, least(5.0, current_ease + ease_delta));

  -- Calculate next interval
  -- Base progression: 1 → 3 → 7 → 14 → 30
  -- Modulated by ease factor
  if current_interval <= 1 then
    new_interval := 3;
  elsif current_interval <= 3 then
    new_interval := 7;
  elsif current_interval <= 7 then
    new_interval := 14;
  elsif current_interval <= 14 then
    new_interval := 30;
  else
    new_interval := round(current_interval * new_ease)::integer;
  end if;

  -- If dismissed, set longer interval but don't deactivate (try again later)
  if p_engagement_type = 'dismiss' then
    new_interval := greatest(new_interval, 30);
  end if;

  update public.idea_resurfacing
  set
    ease_factor = new_ease,
    interval_days = new_interval,
    next_surface_at = now() + (new_interval || ' days')::interval,
    times_surfaced = times_surfaced + 1,
    last_engagement = p_engagement_type,
    last_engagement_at = now()
  where id = p_resurfacing_id;
end;
$$ language plpgsql security definer;
