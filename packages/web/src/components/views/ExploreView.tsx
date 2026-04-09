'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

const GraphCanvas = dynamic(
  () => import('@/components/graph/GraphCanvas'),
  { ssr: false },
);

/**
 * ExploreView — "Your Thinking Map"
 *
 * Force-directed graph of concepts connected by shared conversations.
 * Built on d3-force (simulation) + Canvas 2D (rendering) for full control.
 * Detail panel shows conversations, ideas, and connected concepts for the selected node.
 */

interface GraphNode {
  id: string;
  name: string;
  category: string;
  importance: number;
  color: string;
  size: number;
  documentFrequency: number;
}

interface GraphLink {
  source: string;
  target: string;
  strength: number;
  sharedConversations: number;
}

interface ConceptDetail {
  entity: any;
  conversations: any[];
  ideas: any[];
  connectedEntities: any[];
}

export default function ExploreView() {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [minConnections, setMinConnections] = useState(0);
  const [hideWeakLinks, setHideWeakLinks] = useState(false);

  useEffect(() => {
    async function fetchGraph() {
      const supabase = createBrowserSupabaseClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }

      const res = await fetch('/api/concepts', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setNodes(data.nodes || []);
        setLinks(data.links || []);
      }
      setLoading(false);
    }
    fetchGraph();
  }, []);

  const handleNodeClick = useCallback(async (nodeId: string) => {
    // Empty string = deselect (clicked empty space)
    if (!nodeId) {
      setSelected(null);
      setDetail(null);
      return;
    }

    setSelected(nodeId);
    setDetailLoading(true);

    const supabase = createBrowserSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    const res = await fetch(`/api/concepts/${nodeId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    if (res.ok) {
      setDetail(await res.json());
    }
    setDetailLoading(false);
  }, []);

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading your thinking map...</div>;
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Your Thinking Map</h1>
          <p className="page-subtitle">
            {nodes.length} concepts · {links.length} connections
          </p>
        </div>
        <input
          type="text"
          placeholder="Search concepts..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            padding: '8px 14px',
            borderRadius: '8px',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            fontSize: '13px',
            width: '200px',
            outline: 'none',
          }}
        />
      </div>

      {/* Graph controls */}
      <div style={{
        display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '12px',
        fontSize: '12px', color: 'var(--text-muted)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Thought Depth
          <input
            type="range" min="0" max="5" value={minConnections}
            onChange={e => setMinConnections(Number(e.target.value))}
            style={{ width: '100px', accentColor: 'var(--accent-gold)' }}
          />
          <span style={{ minWidth: '20px' }}>{minConnections}+</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-mono)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer' }}>
          <input
            type="checkbox" checked={hideWeakLinks}
            onChange={e => setHideWeakLinks(e.target.checked)}
            style={{ accentColor: 'var(--accent-gold)' }}
          />
          Strong links only
        </label>
      </div>

      <div style={{ display: 'flex', gap: '1rem', height: 'calc(100vh - 240px)' }}>
        {/* Force-directed graph */}
        <div style={{
          flex: 1,
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          position: 'relative',
        }}>
          <GraphCanvas
            nodes={nodes}
            links={links}
            selectedNodeId={selected}
            searchQuery={searchQuery}
            minConnections={minConnections || undefined}
            minLinkStrength={hideWeakLinks ? 0.3 : undefined}
            onNodeClick={handleNodeClick}
          />
        </div>

        {/* Detail panel */}
        {selected && (
          <div style={{
            width: '360px',
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            border: '1px solid var(--border-subtle)',
            padding: '20px',
            overflowY: 'auto',
          }}>
            {detailLoading ? (
              <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
            ) : detail ? (
              <>
                {/* Entity header */}
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                    {detail.entity.name}
                  </h3>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    {detail.entity.type} · appears in {detail.conversations.length} conversations
                  </div>
                  {detail.entity.importance_score != null && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      importance: {(detail.entity.importance_score * 100).toFixed(0)}%
                      {detail.entity.confidence != null && ` · confidence: ${(detail.entity.confidence * 100).toFixed(0)}%`}
                    </div>
                  )}
                </div>

                {/* Conversations */}
                {detail.conversations.length > 0 && (
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{
                      fontSize: '11px', textTransform: 'uppercase',
                      color: 'var(--text-muted)', letterSpacing: '0.05em',
                      marginBottom: '8px',
                    }}>
                      Conversations
                    </div>
                    {detail.conversations.slice(0, 8).map((c: any) => (
                      <div key={c.id} style={{
                        padding: '8px 0',
                        borderBottom: '1px solid var(--border-subtle)',
                        fontSize: '13px',
                      }}>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                          {c.title || 'Untitled'}
                        </div>
                        <div style={{
                          color: 'var(--text-muted)', fontSize: '11px', marginTop: '2px',
                          display: 'flex', alignItems: 'center', gap: '8px',
                        }}>
                          <span>{c.messageCount} messages</span>
                          {c.drift && (
                            <span style={{
                              padding: '1px 6px', borderRadius: '4px', fontSize: '10px',
                              background: c.drift.drift_category === 'on_track' ? '#10B98115' :
                                         c.drift.drift_category === 'productive_drift' ? '#6366F115' : '#F59E0B15',
                              color: c.drift.drift_category === 'on_track' ? '#10B981' :
                                     c.drift.drift_category === 'productive_drift' ? '#6366F1' : '#F59E0B',
                            }}>
                              {c.drift.drift_category?.replace(/_/g, ' ')}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Connected concepts */}
                {detail.connectedEntities.length > 0 && (
                  <div style={{ marginBottom: '20px' }}>
                    <div style={{
                      fontSize: '11px', textTransform: 'uppercase',
                      color: 'var(--text-muted)', letterSpacing: '0.05em',
                      marginBottom: '8px',
                    }}>
                      Connected Concepts
                    </div>
                    {detail.connectedEntities.slice(0, 8).map((e: any) => (
                      <div
                        key={e.id}
                        onClick={() => handleNodeClick(e.id)}
                        style={{
                          padding: '6px 0', cursor: 'pointer',
                          fontSize: '13px', color: 'var(--accent-indigo)',
                          display: 'flex', justifyContent: 'space-between',
                        }}
                      >
                        <span>{e.name}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                          {e.sharedConversations} shared
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Ideas */}
                {detail.ideas.length > 0 && (
                  <div>
                    <div style={{
                      fontSize: '11px', textTransform: 'uppercase',
                      color: 'var(--text-muted)', letterSpacing: '0.05em',
                      marginBottom: '8px',
                    }}>
                      Key Ideas ({detail.ideas.length})
                    </div>
                    {detail.ideas.slice(0, 6).map((idea: any) => (
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
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
