'use client';

export interface ResurfaceIdea {
  resurfacing_id: string;
  idea_id: string;
  summary: string;
  category: string;
  importance_score: number;
  interval_days: number;
  times_surfaced: number;
  enrollment_reason: string;
}

interface ResurfaceCardProps {
  idea: ResurfaceIdea;
  onEngage: (resurfacingId: string, engagement: 'click' | 'revisit' | 'dismiss' | 'act') => void;
}

const ENGAGEMENT_BUTTONS: { type: 'revisit' | 'act' | 'click' | 'dismiss'; label: string; icon: string; color: string }[] = [
  { type: 'revisit', label: 'Revisit', icon: '↻', color: 'var(--success)' },
  { type: 'act', label: 'Act on it', icon: '→', color: 'var(--accent)' },
  { type: 'click', label: 'Noted', icon: '·', color: 'var(--text-secondary)' },
  { type: 'dismiss', label: 'Later', icon: '↓', color: 'var(--text-muted)' },
];

export default function ResurfaceCard({ idea, onEngage }: ResurfaceCardProps) {
  return (
    <div className="resurface-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          padding: '2px 8px',
          borderRadius: '4px',
          background: 'var(--accent-dim)',
          color: 'var(--accent)',
        }}>
          {idea.category}
        </span>
        <span style={{
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
        }}>
          {Math.round(idea.importance_score * 100)}%
        </span>
      </div>

      <p style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: '1.5', margin: '0 0 10px 0' }}>
        {idea.summary}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
        <span style={{
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {idea.enrollment_reason.replace(/_/g, ' ')}
        </span>
        <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
          interval: {idea.interval_days}d · surfaced {idea.times_surfaced}x
        </span>
      </div>

      <div className="resurface-actions">
        {ENGAGEMENT_BUTTONS.map(btn => (
          <button
            key={btn.type}
            className="resurface-btn"
            onClick={() => onEngage(idea.resurfacing_id, btn.type)}
            style={{ '--btn-color': btn.color } as React.CSSProperties}
          >
            <span style={{ marginRight: '4px' }}>{btn.icon}</span>
            {btn.label}
          </button>
        ))}
      </div>
    </div>
  );
}
