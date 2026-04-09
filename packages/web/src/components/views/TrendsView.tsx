'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import BentoCard from '@/components/BentoCard';

const Sparkline = dynamic(() => import('@/components/Sparkline'), { ssr: false });
const Heatmap2D = dynamic(() => import('@/components/Heatmap2D'), { ssr: false });

/**
 * TrendsView — "Your Thinking Over Time"
 *
 * Shows how metrics evolve. Uses Level 4 EMAs when populated,
 * falls back to per-conversation aggregates.
 * Progressive disclosure: "We're learning your patterns" for < 15 conversations.
 *
 * Consolidates: old Behavioral view (heatmap, depth distribution, engagement sparklines)
 *             + old Trends data (EMA short/long term)
 */

interface TrendMetric {
  label: string;
  shortTerm: number;
  longTerm: number;
  gap: number;
  description: string;
  lowerIsBetter?: boolean;
  history?: number[];
  color?: string;
}

export default function TrendsView() {
  const [data, setData] = useState<any>(null);
  const [dashboard, setDashboard] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAll() {
      const supabase = createBrowserSupabaseClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { setLoading(false); return; }

      const headers = { Authorization: `Bearer ${session.access_token}` };

      const [trendsRes, dashRes] = await Promise.all([
        fetch('/api/trends', { headers }).then(r => r.ok ? r.json() : null),
        fetch('/api/dashboard', { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);

      setData(trendsRes);
      setDashboard(dashRes);
      setLoading(false);
    }
    fetchAll();
  }, []);

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Loading trends...</div>;
  }

  if (!data || data.disclosureState === 'new') {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Your Thinking Over Time</h1>
          <p className="page-subtitle">Trends will appear after you import conversations</p>
        </div>
        <div style={{
          textAlign: 'center', padding: '80px 24px', color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: '40px', opacity: 0.2, marginBottom: '16px' }}>📈</div>
          <div style={{ fontSize: '14px' }}>Import conversations to start tracking trends.</div>
          <a href="/import" style={{
            display: 'inline-block', marginTop: '16px',
            padding: '8px 20px', borderRadius: '8px',
            background: '#6366F1', color: 'white',
            fontSize: '13px', fontWeight: 500, textDecoration: 'none',
          }}>Import →</a>
        </div>
      </>
    );
  }

  if (data.disclosureState === 'early') {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Your Thinking Over Time</h1>
          <p className="page-subtitle">
            {data.totalConversations} conversations analyzed — trends become reliable with more data
          </p>
        </div>
        <div style={{
          background: 'var(--bg-secondary)', borderRadius: '10px',
          padding: '20px', border: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1.6',
        }}>
          We're learning your patterns. Meaningful trends will appear after more conversations.
          Keep importing and using Claude — your thinking patterns will become visible over time.
        </div>
      </>
    );
  }

  const trends = data.trends;
  const behavioral = dashboard?.behavioral;
  const fp = behavioral?.weeklyFingerprint;
  const engagementProfiles = behavioral?.engagementProfiles || [];

  const trendCards: TrendMetric[] = trends ? [
    {
      label: 'Drift',
      shortTerm: trends.shortTerm.drift,
      longTerm: trends.longTerm.drift,
      gap: trends.gaps.drift,
      description: 'How much you drift from your intent',
      lowerIsBetter: true,
      color: '#F59E0B',
    },
    {
      label: 'Question Density',
      shortTerm: trends.shortTerm.questionDensity,
      longTerm: trends.longTerm.questionDensity,
      gap: trends.gaps.questionDensity,
      description: 'How often you ask questions',
      color: '#6366F1',
    },
    {
      label: 'Conversation Depth',
      shortTerm: trends.shortTerm.conversationDepth,
      longTerm: trends.longTerm.conversationDepth,
      gap: trends.gaps.conversationDepth,
      description: 'Average turns per conversation',
      color: '#10B981',
    },
    {
      label: 'Self-Correction',
      shortTerm: trends.shortTerm.selfCorrection,
      longTerm: trends.longTerm.selfCorrection,
      gap: trends.gaps.selfCorrection,
      description: 'How often you revise your thinking',
      color: '#8B5CF6',
    },
  ] : [];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Your Thinking Over Time</h1>
        <p className="page-subtitle">
          {data.totalConversations} conversations · {data.disclosureState === 'active' ? 'early trends' : 'established patterns'}
        </p>
      </div>

      {/* Trend metric cards with sparklines */}
      {trendCards.length > 0 && (
        <div className="bento-grid" style={{ marginBottom: '1.5rem' }}>
          {trendCards.map(t => (
            <TrendCard key={t.label} metric={t} />
          ))}
        </div>
      )}

      {!trends && (
        <div style={{
          background: 'var(--bg-secondary)', borderRadius: '10px',
          padding: '20px', border: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)', fontSize: '13px', marginBottom: '1.5rem',
        }}>
          Trend computation not yet active. Trends will populate as more conversations are analyzed.
        </div>
      )}

      {/* Engagement sparklines from behavioral data */}
      {engagementProfiles.length > 0 && (
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Engagement Profiles</h2>
            <span className="section-badge">{engagementProfiles.length} conversations</span>
          </div>
          <div style={{
            background: 'var(--bg-secondary)',
            borderRadius: '10px',
            padding: '16px',
            border: '1px solid var(--border-subtle)',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {engagementProfiles.slice(0, 8).map((p: any) => (
                <div key={p.conversationId} style={{
                  display: 'grid',
                  gridTemplateColumns: '100px 1fr auto auto auto',
                  gap: '12px',
                  alignItems: 'center',
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border-subtle)',
                }}>
                  <Sparkline data={p.userMessageLengths || []} fill />
                  <span style={{
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'capitalize',
                    color: p.engagementArc === 'deepening' ? 'var(--success)' :
                           p.engagementArc === 'disengaging' ? 'var(--danger)' : 'var(--text-secondary)',
                  }}>{p.engagementArc}</span>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    {p.userMessageCount} msgs
                  </span>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    Q:{Math.round((p.questionDensity || 0) * 100)}%
                  </span>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                    SC:{p.selfCorrectionCount || 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Activity heatmap + depth distribution from behavioral data */}
      {fp && (
        <div className="bento-grid" style={{ marginBottom: '1.5rem' }}>
          <BentoCard span={2}>
            <div style={{
              fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px',
            }}>Peak Hours</div>
            <Heatmap2D hours={fp.peakHours} />
          </BentoCard>

          <BentoCard>
            <div style={{
              fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px',
            }}>Depth Distribution</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                { label: 'Short (1-5)', count: fp.depthDistribution?.short || 0 },
                { label: 'Medium (6-15)', count: fp.depthDistribution?.medium || 0 },
                { label: 'Deep (16+)', count: fp.depthDistribution?.deep || 0 },
              ].map(d => (
                <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                    {d.label}
                  </span>
                  <span style={{ fontSize: '16px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                    {d.count}
                  </span>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      )}

      {/* Behavioral stats row */}
      {fp && (
        <div className="bento-grid" style={{ marginBottom: '1.5rem' }}>
          <BentoCard>
            <div className="stat-card-label">Avg Depth</div>
            <div className="stat-card-value" style={{ fontSize: '24px' }}>
              {fp.avgConversationDepth} <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>msgs</span>
            </div>
          </BentoCard>
          <BentoCard>
            <div className="stat-card-label">Avg Question Rate</div>
            <div className="stat-card-value" style={{ fontSize: '24px' }}>
              {Math.round((fp.avgQuestionDensity || 0) * 100)}%
            </div>
          </BentoCard>
          <BentoCard>
            <div className="stat-card-label">Metacognition</div>
            <div className="stat-card-value accent" style={{ fontSize: '24px' }}>
              {(fp.metacognitionIndex || 0).toFixed(1)}
            </div>
          </BentoCard>
        </div>
      )}
    </>
  );
}

function TrendCard({ metric }: { metric: TrendMetric }) {
  const { label, shortTerm, longTerm, gap, description, lowerIsBetter, color } = metric;
  const improving = lowerIsBetter ? gap < 0 : gap > 0;
  const arrow = Math.abs(gap) < 0.01 ? '→' : improving ? '↑' : '↓';
  const arrowColor = Math.abs(gap) < 0.01 ? 'var(--text-muted)' : improving ? '#10B981' : '#F59E0B';

  // Generate a simple trend line from short/long term values
  const trendData = [longTerm, longTerm * 0.95 + shortTerm * 0.05, longTerm * 0.8 + shortTerm * 0.2, longTerm * 0.5 + shortTerm * 0.5, shortTerm];

  return (
    <BentoCard>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
            {label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {shortTerm.toFixed(2)}
            </span>
            <span style={{ fontSize: '1.2rem', color: arrowColor, fontWeight: 600 }}>
              {arrow}
            </span>
          </div>
        </div>
        <Sparkline
          data={trendData}
          width={80}
          height={32}
          fill
          color={color || 'var(--accent)'}
        />
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        {description} · baseline: {longTerm.toFixed(2)}
      </div>
    </BentoCard>
  );
}
