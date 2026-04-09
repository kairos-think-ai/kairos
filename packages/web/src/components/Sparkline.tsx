'use client';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  fill?: boolean;    // show translucent area fill below line
  color?: string;
}

export default function Sparkline({
  data,
  width = 100,
  height = 24,
  fill = false,
  color = 'var(--accent)',
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <div style={{
        width,
        height,
        background: 'var(--bg-tertiary)',
        borderRadius: '4px',
      }} />
    );
  }

  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${height - (v / max) * height}`).join(' ');

  // Close the path for fill area
  const fillPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      {fill && (
        <polygon
          points={fillPoints}
          fill={color}
          opacity="0.1"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
