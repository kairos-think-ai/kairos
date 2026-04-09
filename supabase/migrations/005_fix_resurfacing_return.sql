-- Fix get_due_ideas to return resurfacing_id
-- The POST /api/resurface endpoint requires resurfacing_id to call
-- update_resurfacing_after_engagement, but the original function
-- only returned idea_id.

create or replace function public.get_due_ideas(p_user_id uuid, max_count integer default 3)
returns table(
  resurfacing_id uuid,
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
    ir.id as resurfacing_id,
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
