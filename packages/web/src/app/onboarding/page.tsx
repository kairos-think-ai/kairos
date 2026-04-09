'use client';

import { useState, useEffect } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

// ============================================================
// Onboarding Flow: Welcome → Tier Selection → Get Started
// ============================================================

const KAIROS_EXTENSION_ID = 'kefkcnhkjknampbbfpjljhmldnphjmjg';

type Step = 'welcome' | 'tier' | 'setup';
type Tier = 'own' | 'trust' | 'mirror' | 'analyst';

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>('welcome');
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [extensionDetected, setExtensionDetected] = useState<boolean | null>(null);

  // Check if extension is installed
  useEffect(() => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          KAIROS_EXTENSION_ID,
          { type: 'PING' },
          (response) => {
            if (chrome.runtime.lastError) {
              setExtensionDetected(false);
            } else {
              setExtensionDetected(true);
            }
          }
        );
      } else {
        setExtensionDetected(false);
      }
    } catch {
      setExtensionDetected(false);
    }
  }, []);

  // When tier is selected, notify extension
  useEffect(() => {
    if (!selectedTier || !extensionDetected) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          KAIROS_EXTENSION_ID,
          { type: 'SET_PRIVACY_TIER', tier: selectedTier },
          () => { /* best-effort */ }
        );
      }
    } catch { /* ignore */ }
  }, [selectedTier, extensionDetected]);

  async function handleComplete() {
    // Mark onboarding as complete in Supabase user metadata
    const supabase = createBrowserSupabaseClient();
    await supabase.auth.updateUser({
      data: {
        onboarding_complete: true,
        privacy_tier: selectedTier,
      },
    });
    window.location.href = '/import';
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 20px',
    }}>
      <div style={{ maxWidth: '560px', width: '100%' }}>
        {step === 'welcome' && <WelcomeStep onNext={() => setStep('tier')} />}
        {step === 'tier' && (
          <TierStep
            selected={selectedTier}
            onSelect={setSelectedTier}
            onNext={() => setStep('setup')}
          />
        )}
        {step === 'setup' && (
          <SetupStep
            tier={selectedTier!}
            extensionDetected={extensionDetected}
            onComplete={handleComplete}
            onBack={() => setStep('tier')}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
// Step 1: Welcome
// ============================================================

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ textAlign: 'center' }}>
      {/* Logo */}
      <div style={{
        width: '64px',
        height: '64px',
        borderRadius: '16px',
        background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: '0 auto 24px',
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </div>

      <h1 style={{
        fontSize: '28px',
        fontWeight: 700,
        color: 'var(--text-primary)',
        marginBottom: '12px',
        letterSpacing: '-0.03em',
      }}>
        Welcome to Kairos
      </h1>

      <p style={{
        fontSize: '15px',
        color: 'var(--text-secondary)',
        lineHeight: '1.7',
        marginBottom: '32px',
        maxWidth: '440px',
        margin: '0 auto 32px',
      }}>
        Kairos helps you observe your thinking patterns across AI conversations — without judgment.
        Like meditation for your digital mind.
      </p>

      {/* What Kairos does */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '12px',
        marginBottom: '32px',
        textAlign: 'left',
      }}>
        {[
          { icon: '◐', title: 'Behavioral Mirror', desc: 'See how you communicate with AI — your patterns, pace, and style' },
          { icon: '◆', title: 'Idea Extraction', desc: 'Surface insights buried across conversations' },
          { icon: '↗', title: 'Drift Detection', desc: 'Track where conversations diverge from your intent' },
          { icon: '↻', title: 'Revisit Moments', desc: 'Never forget an important thought again' },
        ].map(item => (
          <div key={item.title} style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '16px',
          }}>
            <div style={{ fontSize: '18px', marginBottom: '8px' }}>{item.icon}</div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              {item.title}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5' }}>
              {item.desc}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onNext}
        style={{
          background: 'var(--accent)',
          color: '#fff',
          border: 'none',
          padding: '12px 32px',
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Get Started
      </button>
    </div>
  );
}

// ============================================================
// Step 2: Privacy Tier Selection
// ============================================================

function TierStep({ selected, onSelect, onNext }: {
  selected: Tier | null;
  onSelect: (tier: Tier) => void;
  onNext: () => void;
}) {
  return (
    <div>
      <h2 style={{
        fontSize: '22px',
        fontWeight: 700,
        color: 'var(--text-primary)',
        marginBottom: '8px',
        textAlign: 'center',
        letterSpacing: '-0.02em',
      }}>
        Choose Your Privacy Level
      </h2>
      <p style={{
        fontSize: '14px',
        color: 'var(--text-muted)',
        textAlign: 'center',
        marginBottom: '28px',
      }}>
        You can change this anytime. Both options keep your data secure.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '28px' }}>
        {/* Mirror Tier */}
        <TierCard
          tier="mirror"
          selected={selected === 'own'}
          onSelect={() => onSelect('own')}
          title="Own Tier"
          subtitle="Local-only"
          description="All data stays on your device. Behavioral patterns computed locally. Zero cloud sync."
          features={[
            'Conversation capture across platforms',
            'Local behavioral analysis (fluency score, patterns)',
            'Import/export as JSON',
            'Peak hours, engagement profiles',
          ]}
          badge="Privacy-first"
        />

        {/* Analyst Tier */}
        <TierCard
          tier="analyst"
          selected={selected === 'trust'}
          onSelect={() => onSelect('trust')}
          title="Trust Tier"
          subtitle="Cloud-powered"
          description="Data syncs to the cloud for AI-powered deep analysis. Encrypted in transit and at rest."
          features={[
            'Everything in Own Tier, plus:',
            'AI-powered idea extraction and clustering',
            'Drift detection and coaching insights',
            'Spaced repetition for key ideas',
          ]}
          badge="Full experience"
        />
      </div>

      <div style={{ textAlign: 'center' }}>
        <button
          onClick={onNext}
          disabled={!selected}
          style={{
            background: selected ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: selected ? '#fff' : 'var(--text-muted)',
            border: 'none',
            padding: '12px 32px',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: selected ? 'pointer' : 'not-allowed',
            transition: 'all 0.15s',
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function TierCard({ tier, selected, onSelect, title, subtitle, description, features, badge }: {
  tier: Tier;
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  description: string;
  features: string[];
  badge: string;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        background: 'var(--bg-secondary)',
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`,
        borderRadius: '12px',
        padding: '20px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {selected && <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent)' }} />}
          </div>
          <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{subtitle}</span>
        </div>
        <span style={{
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          padding: '3px 8px',
          borderRadius: '4px',
          background: tier === 'trust' ? 'var(--accent-dim)' : 'rgba(34, 197, 94, 0.1)',
          color: tier === 'trust' ? 'var(--accent)' : 'var(--success)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>{badge}</span>
      </div>

      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '12px', paddingLeft: '28px' }}>
        {description}
      </p>

      <ul style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.8', paddingLeft: '48px', margin: 0 }}>
        {features.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
    </div>
  );
}

// ============================================================
// Step 3: Setup (Extension + Import)
// ============================================================

function SetupStep({ tier, extensionDetected, onComplete, onBack }: {
  tier: Tier;
  extensionDetected: boolean | null;
  onComplete: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <h2 style={{
        fontSize: '22px',
        fontWeight: 700,
        color: 'var(--text-primary)',
        marginBottom: '8px',
        textAlign: 'center',
        letterSpacing: '-0.02em',
      }}>
        {tier === 'own' ? 'Set Up Own Tier' : 'Set Up Trust Tier'}
      </h2>
      <p style={{
        fontSize: '14px',
        color: 'var(--text-muted)',
        textAlign: 'center',
        marginBottom: '28px',
      }}>
        Two quick steps to start seeing your patterns.
      </p>

      {/* Step indicators */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '32px' }}>
        {/* Install Extension */}
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '10px',
          padding: '18px 20px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '14px',
        }}>
          <div style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: extensionDetected ? 'rgba(34, 197, 94, 0.15)' : 'var(--accent-dim)',
            color: extensionDetected ? 'var(--success)' : 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 700,
            flexShrink: 0,
            marginTop: '2px',
          }}>
            {extensionDetected ? '✓' : '1'}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              {extensionDetected ? 'Extension Installed' : 'Install the Browser Extension'}
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5', margin: 0 }}>
              {extensionDetected
                ? 'Kairos is capturing your AI conversations in the background.'
                : 'The extension captures your AI conversations on Claude, ChatGPT, and Gemini. Load it from chrome://extensions in developer mode.'}
            </p>
          </div>
        </div>

        {/* Import Conversations */}
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '10px',
          padding: '18px 20px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '14px',
        }}>
          <div style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 700,
            flexShrink: 0,
            marginTop: '2px',
          }}>2</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Import Existing Conversations
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.5', marginBottom: '10px' }}>
              Have conversations from Claude Code or ChatGPT exports? Import them to see patterns right away.
              Or skip this and let the extension capture new conversations.
            </p>
            <a
              href="/import"
              style={{
                fontSize: '12px',
                color: 'var(--accent)',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              Go to Import Page →
            </a>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            padding: '10px 20px',
            borderRadius: '8px',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          Back
        </button>
        <button
          onClick={onComplete}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            padding: '12px 32px',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {tier === 'own' ? 'Go to Import' : 'Open Dashboard'}
        </button>
      </div>
    </div>
  );
}
