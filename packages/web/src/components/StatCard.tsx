'use client';

interface StatCardProps {
  label: string;
  value: string | number;
  accent?: boolean;
  trend?: {
    direction: 'up' | 'down' | 'flat';
    value: string;
  };
}

export default function StatCard({ label, value, accent, trend }: StatCardProps) {
  const trendColor = trend
    ? trend.direction === 'up' ? 'var(--success)' :
      trend.direction === 'down' ? 'var(--danger)' : 'var(--text-muted)'
    : undefined;

  const trendArrow = trend
    ? trend.direction === 'up' ? '↑' :
      trend.direction === 'down' ? '↓' : '→'
    : '';

  return (
    <div className="stat-card">
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value-row" style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <div className={`stat-card-value ${accent ? 'accent' : ''}`}>{value}</div>
        {trend && (
          <span style={{
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            color: trendColor,
            fontWeight: 600,
          }}>
            {trendArrow} {trend.value}
          </span>
        )}
      </div>
    </div>
  );
}
