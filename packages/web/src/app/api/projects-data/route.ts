import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

/**
 * GET /api/projects-data
 *
 * Returns all projects with conversation counts and summary stats.
 * User-facing name: "Your Projects"
 */
export async function GET(request: NextRequest) {
  const supabase = createServiceClient();
  const { data: { user }, error } = await supabase.auth.getUser(
    request.headers.get('Authorization')?.slice(7) || ''
  );
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get projects
  const { data: projects } = await supabase
    .from('projects')
    .select('id, label, description, status, first_seen_at, last_seen_at, stats')
    .eq('user_id', user.id)
    .order('last_seen_at', { ascending: false });

  if (!projects || projects.length === 0) {
    return NextResponse.json({ projects: [], message: 'No projects yet.' });
  }

  // Get conversation counts per project
  const { data: links } = await supabase
    .from('conversation_projects')
    .select('project_id, conversation_id, confidence');

  const projectConvoCounts: Record<string, number> = {};
  for (const l of (links || [])) {
    projectConvoCounts[l.project_id] = (projectConvoCounts[l.project_id] || 0) + 1;
  }

  // Get idea counts per project (via conversation links)
  const projectConvoIds: Record<string, string[]> = {};
  for (const l of (links || [])) {
    if (!projectConvoIds[l.project_id]) projectConvoIds[l.project_id] = [];
    projectConvoIds[l.project_id].push(l.conversation_id);
  }

  const enriched = projects.map((p: any) => ({
    id: p.id,
    name: p.label,
    description: p.description,
    status: p.status,
    firstSeen: p.first_seen_at,
    lastSeen: p.last_seen_at,
    conversationCount: projectConvoCounts[p.id] || 0,
    stats: p.stats,
  }));

  return NextResponse.json({ projects: enriched });
}
