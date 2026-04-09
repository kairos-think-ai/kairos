'use client';

import { ReactNode } from 'react';

interface BentoCardProps {
  children: ReactNode;
  span?: 1 | 2 | 3;
  rowSpan?: 1 | 2;
  className?: string;
}

export default function BentoCard({ children, span = 1, rowSpan = 1, className = '' }: BentoCardProps) {
  const spanClass = span > 1 ? `bento-span-${span}` : '';
  const rowClass = rowSpan > 1 ? 'bento-row-2' : '';

  return (
    <div className={`bento-card ${spanClass} ${rowClass} ${className}`.trim()}>
      {children}
    </div>
  );
}
