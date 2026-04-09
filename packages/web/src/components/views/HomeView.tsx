'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import StatCard from '@/components/StatCard';
import BentoCard from '@/components/BentoCard';
import type { ResurfaceIdea } from '@/components/ResurfaceCard';

const ResurfaceCard = dynamic(() => import('@/components/ResurfaceCard'), { ssr: false });
const OIECard = dynamic(() => import('@/components/OIECard'), { ssr: false });

/**
 * HomeView — "Your Thinking Patterns"
 *
 * The first thing users see. Designed to deliver insight in 10 seconds:
 * - Three headline metrics (verification, generation, drift)
 * - Quick stats (conversations, ideas, concepts, connections)
 * - Top concepts (what you keep thinking about)
 * - Resurfacing ideas with action buttons (spaced repetition)
 * - How you engaged (engagement state breakdown)
 * - Coaching insights (OIE: Observe, Implication, Experiment)
 */

interface MetricsData {
  totalConversations: number;
  totalIdeas: number;
  classifiedConversations: number;
  metrics: {
    verificationRate: number;
    generationRatio: number;
    passiveAcceptanceRate: number;
    driftRate: number;
  } | null;
  engagement: {
    stateDistribution: Record<string, number>;
    totalStructural: number;
    totalLLM: number;
  } | null;
}

interface ConceptsData {
  nodes: Array<{
    id: string;
    name: string;
    category: string;
    importance: number;
    color: string;
    size: number;
  }>;
  links: Array<{
    source: string;
    target: string;
    strength: number;
    sharedConversations: number;
  }>;
  totalEntities: number;
  totalConnections: number;
}

interface CoachingInsight {
  id: string;
  observation: string;
  implication: string;
  experiment: string;
  category: string;
  data_points: number;
  helpful: boolean | null;
}

type DisclosureState = 'new' | 'early' | 'active' | 'established';

function getDisclosureState(totalConversations: number): DisclosureState {
  if (totalConversations === 0) return 'new';
  if (totalConversations <= 3) return 'early';
  if (totalConversations <= 10) return 'active';
  return 'established';
}

export default function HomeView() {
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [concepts, setConcepts] = useState<ConceptsData | null>(null);
  const [resurfaceIdeas, setResurfaceIdeas] = useState<ResurfaceIdea[]>([]);
  const [coaching, setCoaching] = useState<CoachingInsight[]>([]);
  const [loading, setLoading] = useState(true);

  const getSession = useCallback(async () => {
    const supabase = createBrowserSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();
    return session;
  }, []);

  useEffect(() => {
    async function fetchAll() {
      const session = await getSession();
      if (!session?.access_token) { setLoading(false); return; }

      const headers = { Authorization: `Bearer ${session.access_token}` };

      const [metricsRes, conceptsRes, resurfaceRes, coachingRes] = await Promise.all([
        fetch('/api/metrics', { headers }).then(r => r.ok ? r.json() : null),
        fetch('/api/concepts', { headers }).then(r => r.ok ? r.json() : null),
        fetch('/api/resurface', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/coaching', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      setMetrics(metricsRes);
      setConcepts(conceptsRes);
      setResurfaceIdeas(resurfaceRes?.ideas || []);
      setCoaching(coachingRes?.insights?.slice(0, 3) || []);
      setLoading(false);
    }
    fetchAll();
  }, [getSession]);

  const handleResurfaceEngage = async (resurfacingId: string, engagement: 'click' | 'revisit' | 'dismiss' | 'act') => {
    setResurfaceIdeas(prev => prev.filter(i => i.resurfacing_id !== resurfacingId));

    const session = await getSession();
    if (!session?.access_token) return;

    await fetch('/api/resurface', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ resurfacingId, engagement }),
    });
  };

  if (loading) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-muted)', fontSize: '14px' }}>
        Loading your thinking patterns...
      </div>
    );
  }

  const m = metrics?.metrics;
  const eng = metrics?.engagement;
  const disclosure = getDisclosureState(metrics?.totalConversations || 0);

  // Find the strongest connection for the "Connection Discovered" card
  const topConnection = concepts?.links?.length
    ? concepts.links.reduce((best, link) => link.strength > best.strength ? link : best, concepts.links[0])
    : null;

  const getNodeName = (id: string) => concepts?.nodes?.find(n => n.id === id)?.name || id;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Your Thinking Patterns</h1>
        <p className="page-subtitle">
          {metrics?.totalConversations
            ? `Across ${metrics.totalConversations} conversations`
            : 'Import conversations to see your patterns'}
        </p>
      </div>

      {/* Progressive disclosure */}
      {disclosure === 'new' && <OnboardingPrompt />}
      {disclosure === 'early' && <EarlyDataNote count={metrics?.totalConversations || 0} />}

      {/* Three headline metrics */}
      {m && (
        <div className="bento-grid" style={{ marginBottom: '1.5rem' }}>
          <BentoCard>
            <MetricCard
              label="You verify AI claims"
              value={`${Math.round((m.verificationRate || 0) * 100)}%`}
              sublabel="of your turns"
              color="#10B981"
            />
          </BentoCard>
          <BentoCard>
            <MetricCard
              label="You generate your own ideas"
              value={`${Math.round((m.generationRatio || 0) * 100)}%`}
              sublabel="of your turns"
              color="var(--accent-indigo)"
            />
          </BentoCard>
          <BentoCard>
            <MetricCard
              label="You drift from your intent"
              value={`${Math.round((m.driftRate || 0) * 100)}%`}
              sublabel="of the time"
              color="#F59E0B"
            />
          </BentoCard>
        </div>
      )}

      {/* Quick stats row */}
      <div className="stats-row" style={{ marginBottom: '1.5rem' }}>
        <StatCard label="Conversations" value={metrics?.totalConversations || 0} />
        <StatCard label="Ideas" value={metrics?.totalIdeas || 0} accent />
        <StatCard label="Concepts" value={concepts?.totalEntities || 0} />
        <StatCard label="Connections" value={concepts?.totalConnections || 0} />
      </div>

      {/* Top concepts */}
      {concepts && concepts.nodes.length > 0 && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">What You Think About</h2>
            <span className="section-badge">{concepts.totalEntities} concepts</span>
          </div>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '16px',
            background: 'var(--bg-secondary)',
            borderRadius: '10px',
            border: '1px solid var(--border-subtle)',
          }}>
            {concepts.nodes.slice(0, 15).map(node => (
              <span key={node.id} style={{
                padding: '6px 12px',
                borderRadius: '20px',
                fontSize: '13px',
                fontWeight: 500,
                color: node.color,
                background: `${node.color}15`,
                border: `1px solid ${node.color}30`,
                whiteSpace: 'nowrap',
              }}>
                {node.name}
                <span style={{ color: 'var(--text-muted)', marginLeft: '4px', fontSize: '11px' }}>
                  ({node.importance.toFixed(2)})
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Connection Discovered */}
      {topConnection && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Connection Discovered</h2>
          </div>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: '10px',
            padding: '20px',
            border: '1px solid var(--border-subtle)',
            borderLeft: '3px solid var(--accent-indigo)',
          }}>
            <div style={{ fontSize: '14px', color: 'var(--text-primary)', lineHeight: '1.6' }}>
              <strong style={{ color: 'var(--accent-indigo)' }}>{getNodeName(topConnection.source)}</strong>
              {' '}and{' '}
              <strong style={{ color: 'var(--accent-indigo)' }}>{getNodeName(topConnection.target)}</strong>
              {' '}share {topConnection.sharedConversations} conversation{topConnection.sharedConversations !== 1 ? 's' : ''}.
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
              Connection strength: {(topConnection.strength * 100).toFixed(0)}%
            </div>
          </div>
        </div>
      )}

      {/* Resurfacing ideas with action buttons */}
      {resurfaceIdeas.length > 0 && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Ideas to Revisit</h2>
            <span className="section-badge">{resurfaceIdeas.length} due</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {resurfaceIdeas.slice(0, 3).map(idea => (
              <ResurfaceCard
                key={idea.resurfacing_id}
                idea={idea}
                onEngage={handleResurfaceEngage}
              />
            ))}
          </div>
        </div>
      )}

      {/* Engagement breakdown */}
      {eng && eng.stateDistribution && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">How You Engage</h2>
            <span className="section-badge">{metrics?.classifiedConversations || 0} classified</span>
          </div>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: '10px',
            padding: '16px',
            border: '1px solid var(--border-subtle)',
          }}>
            {ENGAGEMENT_STATES.map(s => {
              const pct = (eng.stateDistribution[s.key] || 0) * 100;
              return (
                <div key={s.key} style={{
                  display: 'flex', alignItems: 'center',
                  marginBottom: '8px', gap: '12px',
                }}>
                  <div style={{ width: '140px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {s.label}
                  </div>
                  <div style={{
                    flex: 1, height: '8px',
                    background: 'var(--border)', borderRadius: '4px',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${pct}%`, height: '100%',
                      background: s.color, borderRadius: '4px',
                      transition: 'width 0.5s ease',
                    }} />
                  </div>
                  <div style={{
                    width: '45px', textAlign: 'right',
                    fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500,
                  }}>
                    {Math.round(pct)}%
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
              {eng.totalStructural} structural + {eng.totalLLM} LLM classified turns
            </div>
          </div>
        </div>
      )}

      {/* Coaching insights (OIE cards) */}
      {coaching.length > 0 && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Coaching Insights</h2>
            <span className="section-badge">{coaching.length} recent</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {coaching.map(insight => (
              <div key={insight.id}>
                <div style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: `${CATEGORY_COLORS[insight.category] || 'var(--text-muted)'}18`,
                    color: CATEGORY_COLORS[insight.category] || 'var(--text-muted)',
                  }}>
                    {insight.category}
                  </span>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    {insight.data_points} data points
                  </span>
                </div>
                <OIECard
                  observation={insight.observation}
                  implication={insight.implication}
                  experiment={insight.experiment}
                  collapsible
                  defaultExpanded={false}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No data state */}
      {(!metrics || metrics.totalConversations === 0) && disclosure === 'new' && (
        <div style={{
          textAlign: 'center', padding: '48px 24px',
          color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
            Start observing your thinking
          </div>
          <div style={{ fontSize: '13px', maxWidth: '400px', margin: '0 auto', lineHeight: '1.6' }}>
            Import your Claude conversations to see your thinking patterns,
            ideas, and engagement metrics.
          </div>
          <a href="/import" style={{
            display: 'inline-block', marginTop: '20px',
            padding: '10px 24px', borderRadius: '8px',
            background: 'var(--accent)', color: '#0A0A0F',
            fontSize: '14px', fontWeight: 600, textDecoration: 'none',
          }}>
            Import Conversations →
          </a>
        </div>
      )}
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function MetricCard({ label, value, sublabel, color }: {
  label: string; value: string; sublabel: string; color: string;
}) {
  return (
    <>
      <div style={{
        color: 'var(--text-muted)', fontSize: '12px',
        textTransform: 'uppercase', letterSpacing: '0.05em',
        marginBottom: '8px',
      }}>
        {label}
      </div>
      <div style={{ fontSize: '2.5rem', fontWeight: 700, color, lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
        {sublabel}
      </div>
    </>
  );
}

function OnboardingPrompt() {
  return (
    <div className="bento-grid" style={{ marginBottom: '24px' }}>
      <BentoCard span={2}>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '12px',
            background: 'var(--accent-dim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: '24px' }}>◉</span>
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Start by importing a conversation
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
              Import your Claude conversation history to see your thinking patterns.
            </div>
          </div>
        </div>
        <a href="/import" style={{
          display: 'inline-flex', marginTop: '16px',
          padding: '8px 16px', borderRadius: '8px',
          background: 'var(--accent)', color: 'white',
          fontSize: '13px', fontWeight: 500, textDecoration: 'none',
        }}>
          Import History →
        </a>
      </BentoCard>
      <BentoCard>
        <div style={{
          fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em',
          color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px',
        }}>Or install the extension</div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
          The Kairos browser extension captures conversations as you chat, automatically.
        </div>
      </BentoCard>
    </div>
  );
}

function EarlyDataNote({ count }: { count: number }) {
  return (
    <div style={{
      background: 'var(--accent-dim)',
      border: '1px solid var(--border-subtle)',
      borderRadius: '8px',
      padding: '10px 14px',
      marginBottom: '24px',
      display: 'flex', alignItems: 'center', gap: '10px',
    }}>
      <span style={{ fontSize: '14px' }}>◐</span>
      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
        Based on {count} conversation{count !== 1 ? 's' : ''}. Need 3+ for behavioral patterns and 10+ for full insights.
      </span>
    </div>
  );
}

const ENGAGEMENT_STATES = [
  { key: 'DEEP_ENGAGEMENT', label: 'Deep Engagement', color: 'var(--accent-indigo)' },
  { key: 'PROMPT_CRAFTING', label: 'Prompt Crafting', color: '#8B5CF6' },
  { key: 'VERIFICATION', label: 'Verification', color: '#10B981' },
  { key: 'REDIRECTING', label: 'Redirecting', color: '#F59E0B' },
  { key: 'PASSIVE_ACCEPTANCE', label: 'Passive', color: '#EF4444' },
  { key: 'DEFERRED', label: 'Deferred', color: '#6B7280' },
];

const CATEGORY_COLORS: Record<string, string> = {
  delegation: 'var(--accent)',
  iteration: 'var(--success)',
  discernment: 'var(--accent-gold)',
  breadth: 'var(--accent-hover)',
};
