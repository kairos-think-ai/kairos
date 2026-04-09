'use client';

interface Heatmap2DProps {
  hours: number[] | number[][];  // 1D (24 hours) or 2D (7 days × 24 hours)
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getCellColor(value: number, max: number): string {
  if (value === 0 || max === 0) return 'var(--ring-track)';
  const intensity = value / max;
  // Indigo gradient: ring-track (#222240) → ring-fill (#6366F1)
  const alpha = 0.15 + intensity * 0.85;
  return `rgba(99, 102, 241, ${alpha})`;
}

export default function Heatmap2D({ hours }: Heatmap2DProps) {
  // Determine if 1D or 2D
  const is2D = Array.isArray(hours[0]);

  if (is2D) {
    const data = hours as number[][];
    const max = Math.max(...data.flat(), 1);

    return (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '32px repeat(24, 1fr)', gap: '2px' }}>
          {/* Header row */}
          <div />
          {Array.from({ length: 24 }, (_, i) => (
            <div key={`h-${i}`} style={{
              fontSize: '8px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-muted)',
              textAlign: 'center',
              lineHeight: '14px',
            }}>
              {i % 6 === 0 ? `${i}` : ''}
            </div>
          ))}

          {/* Data rows */}
          {data.map((row, dayIndex) => (
            <div key={`row-${dayIndex}`} style={{ display: 'contents' }}>
              <div style={{
                fontSize: '9px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                lineHeight: '14px',
              }}>
                {DAY_LABELS[dayIndex] || ''}
              </div>
              {row.map((count, hourIndex) => (
                <div
                  key={`${dayIndex}-${hourIndex}`}
                  title={`${DAY_LABELS[dayIndex]} ${hourIndex}:00 — ${count} conversations`}
                  style={{
                    width: '100%',
                    aspectRatio: '1',
                    borderRadius: '2px',
                    background: getCellColor(count, max),
                    minHeight: '8px',
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 1D fallback — enhanced single row
  const data1D = hours as number[];
  const max = Math.max(...data1D, 1);

  return (
    <div>
      <div style={{ display: 'flex', gap: '2px', alignItems: 'flex-end', height: '48px' }}>
        {data1D.map((count, i) => (
          <div
            key={i}
            title={`${i}:00 — ${count} conversations`}
            style={{
              flex: 1,
              height: count > 0 ? `${Math.max(12, (count / max) * 100)}%` : '4px',
              background: getCellColor(count, max),
              borderRadius: '2px',
              minHeight: '4px',
              transition: 'height 0.3s',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px' }}>
        {[0, 6, 12, 18, 23].map(h => (
          <span key={h} style={{ fontSize: '9px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {h}:00
          </span>
        ))}
      </div>
    </div>
  );
}
