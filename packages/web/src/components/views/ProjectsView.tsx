'use client';

import { useState, useEffect } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

/**
 * ProjectsView — "Your Projects"
 *
 * Shows Claude Projects imported from the export, with conversation counts,
 * idea counts, top concepts, last activity, and engagement mode.
 *
 * Click-through opens a detail panel with conversations, ideas, and drift.
 */

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  conversationCount: number;
  ideaCount?: number;
  topConcepts?: string[];
  engagementMode?: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

interface ProjectDetail {
  conversations: Array<{
    id: string;
    title: string;
    messageCount: number;
    startedAt: string;
    driftCategory?: string;
    engagementArc?: string;
  }>;
  ideas: Array<{
    id: string;
    summary: string;
    category: string;
    importance_score: number;
  }>;
}

export default function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    async function fetchProjects() {
      const supabase = createBrowserSupabaseClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }

      const res = await fetch('/api/projects-data', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
      setLoading(false);
    }
    fetchProjects();
  }, []);

  const handleProjectClick = async (projectId: string) => {
    if (selectedProject === projectId) {
      setSelectedProject(null);
      setDetail(null);
      return;
    }

    setSelectedProject(projectId);
    setDetailLoading(true);

    const supabase = createBrowserSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    // Try to fetch project detail if endpoint exists
    const res = await fetch(`/api/projects-data/${projectId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch(() => null);

    if (res?.ok) {
      setDetail(await res.json());
    } else {
      setDetail(null);
    }
    setDetailLoading(false);
  };

  const formatTimeAgo = (dateStr: string | null) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    const now = new Date();
    const days = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    return `${Math.floor(days / 30)} months ago`;
  };

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading projects...</div>;
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Your Projects</h1>
        <p className="page-subtitle">
          {projects.length > 0
            ? `${projects.length} projects tracked`
            : 'Projects appear when you import Claude.ai conversations with project associations'}
        </p>
      </div>

      {projects.length > 0 ? (
        <div style={{ display: 'flex', gap: '1rem' }}>
          {/* Project cards grid */}
          <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: '1rem',
            alignContent: 'start',
          }}>
            {projects.map(p => (
              <div
                key={p.id}
                onClick={() => handleProjectClick(p.id)}
                style={{
                  background: 'var(--bg-secondary)',
                  borderRadius: '12px',
                  padding: '20px',
                  border: selectedProject === p.id
                    ? '1.5px solid var(--accent)'
                    : '1px solid var(--border-subtle)',
                  cursor: 'pointer',
                  transition: 'border-color 0.2s',
                }}
              >
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  marginBottom: '8px',
                }}>
                  <div style={{
                    fontSize: '16px', fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}>
                    {p.name}
                  </div>
                  <span style={{
                    padding: '2px 8px', borderRadius: '4px',
                    background: p.status === 'active' ? '#10B98115' : '#6B728015',
                    color: p.status === 'active' ? '#10B981' : '#6B7280',
                    fontSize: '11px', fontWeight: 500,
                  }}>
                    {p.status}
                  </span>
                </div>

                {p.description && (
                  <div style={{
                    fontSize: '12px', color: 'var(--text-muted)',
                    lineHeight: '1.5', marginBottom: '12px',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    display: '-webkit-box', WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical' as any,
                  }}>
                    {p.description.slice(0, 200)}
                  </div>
                )}

                {/* Stats row */}
                <div style={{
                  display: 'flex', gap: '16px', fontSize: '12px',
                  color: 'var(--text-muted)', marginBottom: '8px',
                }}>
                  <span>{p.conversationCount} conversation{p.conversationCount !== 1 ? 's' : ''}</span>
                  {p.ideaCount != null && <span>{p.ideaCount} ideas</span>}
                </div>

                {/* Top concepts */}
                {p.topConcepts && p.topConcepts.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    {p.topConcepts.slice(0, 4).map(concept => (
                      <span key={concept} style={{
                        fontSize: '11px', padding: '2px 8px',
                        borderRadius: '10px',
                        background: '#6366F115', color: '#6366F1',
                        border: '1px solid #6366F130',
                      }}>
                        {concept}
                      </span>
                    ))}
                  </div>
                )}

                {/* Footer: last active + engagement mode */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '11px', color: 'var(--text-muted)',
                }}>
                  {p.lastSeen && <span>Last active: {formatTimeAgo(p.lastSeen)}</span>}
                  {p.engagementMode && (
                    <span style={{ fontStyle: 'italic' }}>
                      Mostly {p.engagementMode.toLowerCase()}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Detail panel */}
          {selectedProject && (
            <div style={{
              width: '340px',
              background: 'var(--bg-secondary)',
              borderRadius: '12px',
              border: '1px solid var(--border-subtle)',
              padding: '20px',
              overflowY: 'auto',
              maxHeight: 'calc(100vh - 200px)',
              position: 'sticky',
              top: '32px',
            }}>
              {detailLoading ? (
                <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
              ) : detail ? (
                <>
                  <div style={{
                    fontSize: '11px', textTransform: 'uppercase',
                    color: 'var(--text-muted)', letterSpacing: '0.05em',
                    marginBottom: '12px',
                  }}>
                    Conversations
                  </div>
                  {detail.conversations.map(c => (
                    <div key={c.id} style={{
                      padding: '8px 0',
                      borderBottom: '1px solid var(--border-subtle)',
                      fontSize: '13px',
                    }}>
                      <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                        {c.title || 'Untitled'}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px' }}>
                        {c.messageCount} messages
                        {c.driftCategory && ` · drift: ${c.driftCategory}`}
                        {c.engagementArc && ` · ${c.engagementArc}`}
                      </div>
                    </div>
                  ))}

                  {detail.ideas.length > 0 && (
                    <>
                      <div style={{
                        fontSize: '11px', textTransform: 'uppercase',
                        color: 'var(--text-muted)', letterSpacing: '0.05em',
                        marginTop: '20px', marginBottom: '12px',
                      }}>
                        Top Ideas
                      </div>
                      {detail.ideas.slice(0, 5).map(idea => (
                        <div key={idea.id} style={{
                          padding: '8px 0',
                          borderBottom: '1px solid var(--border-subtle)',
                          fontSize: '12px', color: 'var(--text-secondary)',
                          lineHeight: '1.5',
                        }}>
                          <span style={{
                            fontSize: '10px', padding: '1px 6px',
                            borderRadius: '4px', background: 'var(--accent-dim)',
                            color: 'var(--accent)', marginRight: '6px',
                          }}>
                            {idea.category}
                          </span>
                          {idea.summary}
                        </div>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
                  Project detail view coming soon. Conversations and ideas for this project will appear here.
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{
          textAlign: 'center', padding: '80px 24px',
          color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: '40px', opacity: 0.2, marginBottom: '16px' }}>📁</div>
          <div style={{ fontSize: '14px' }}>No projects yet.</div>
          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            Import conversations from Claude.ai to see your projects here.
          </div>
        </div>
      )}
    </>
  );
}
