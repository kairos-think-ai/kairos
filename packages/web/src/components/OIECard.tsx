'use client';

import { useState } from 'react';

interface OIECardProps {
  observation: string;
  implication: string;
  experiment: string;
  collapsible?: boolean;
  defaultExpanded?: boolean;
}

export default function OIECard({
  observation,
  implication,
  experiment,
  collapsible = true,
  defaultExpanded = false,
}: OIECardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isOpen = !collapsible || expanded;

  return (
    <div
      onClick={collapsible ? () => setExpanded(!expanded) : undefined}
      style={{
        cursor: collapsible ? 'pointer' : 'default',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '10px',
        padding: '16px',
        transition: 'border-color 0.2s',
      }}
    >
      {/* Observation — always visible */}
      <div className="oie-observe" style={{ marginBottom: isOpen ? '10px' : '0' }}>
        {observation}
      </div>

      {isOpen && (
        <>
          {/* Implication */}
          <div className="oie-implication" style={{ marginBottom: '10px' }}>
            {implication}
          </div>
          {/* Experiment */}
          <div className="oie-experiment">
            {experiment}
          </div>
        </>
      )}

      {collapsible && !expanded && (
        <div style={{
          fontSize: '11px',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          marginTop: '8px',
        }}>
          Click to expand insight →
        </div>
      )}
    </div>
  );
}
