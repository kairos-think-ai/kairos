'use client';

import { useEffect, useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

/**
 * Landing Page — What users see before signup.
 * Authenticated users are redirected to /dashboard.
 */
export default function LandingPage() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      const supabase = createBrowserSupabaseClient();

      // Handle OAuth PKCE code — Supabase redirects here with ?code=
      // when the Site URL is the landing page
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
          window.location.href = '/dashboard';
          return;
        }
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        window.location.href = '/dashboard';
        return;
      }
      setChecking(false);
    }
    checkAuth();
  }, []);

  if (checking) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-muted)',
      }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Nav */}
      <nav style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '24px 40px',
        maxWidth: '1100px',
        width: '100%',
        margin: '0 auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '28px', height: '28px',
            background: 'linear-gradient(135deg, #E5A54B 0%, #F0B560 100%)',
            borderRadius: '7px',
          }} />
          <span style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em' }}>
            Kairos
          </span>
        </div>
        <a href="/login" style={{
          padding: '8px 20px',
          borderRadius: '8px',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-primary)',
          fontSize: '14px',
          fontWeight: 500,
          textDecoration: 'none',
          transition: 'border-color 0.2s',
        }}>
          Sign in
        </a>
      </nav>

      {/* Hero */}
      <main style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 40px',
        maxWidth: '800px',
        margin: '0 auto',
        textAlign: 'center',
      }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '3rem',
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: '-0.03em',
          marginBottom: '24px',
          background: 'linear-gradient(135deg, #F0F0F5 0%, #8888A0 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          Know how you think with AI
        </h1>

        <p style={{
          fontSize: '18px',
          lineHeight: 1.7,
          color: 'var(--text-secondary)',
          maxWidth: '600px',
          marginBottom: '40px',
        }}>
          You've had hundreds of AI conversations. Are you a sharper thinker than three months ago?
          Kairos observes your patterns — engagement, drift, ideas — and coaches you in real-time.
        </p>

        <a href="/login" style={{
          display: 'inline-block',
          padding: '14px 36px',
          borderRadius: '10px',
          background: '#E5A54B',
          color: '#0A0A0F',
          fontSize: '16px',
          fontWeight: 600,
          textDecoration: 'none',
          transition: 'background 0.2s',
          marginBottom: '64px',
        }}>
          Get Started
        </a>

        {/* Features */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '24px',
          width: '100%',
          maxWidth: '720px',
        }}>
          <FeatureCard
            icon="◉"
            title="Thinking Patterns"
            description="See how you engage — when you're deeply thinking vs passively accepting. Track verification, generation, and drift."
          />
          <FeatureCard
            icon="◇"
            title="Ideas That Resurface"
            description="Every idea extracted from your conversations, surfaced at the right time through spaced repetition."
          />
          <FeatureCard
            icon="↻"
            title="Real-Time Coaching"
            description="Connect Kairos to Claude. It knows your patterns and coaches you mid-conversation — for both you and Claude."
          />
        </div>

        {/* Trust line */}
        <p style={{
          fontSize: '13px',
          color: 'var(--text-muted)',
          marginTop: '48px',
          marginBottom: '32px',
          maxWidth: '500px',
          lineHeight: 1.6,
        }}>
          Your data is yours. Kairos runs analysis on your conversations — it never trains on them,
          sells them, or shares them. You can export or delete everything at any time.
        </p>
      </main>

      {/* Footer */}
      <footer style={{
        textAlign: 'center',
        padding: '24px',
        fontSize: '12px',
        color: 'var(--text-muted)',
      }}>
        Kairos
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      borderRadius: '12px',
      padding: '24px',
      border: '1px solid var(--border-subtle)',
      textAlign: 'left',
    }}>
      <div style={{
        fontSize: '24px',
        marginBottom: '12px',
        opacity: 0.6,
      }}>
        {icon}
      </div>
      <div style={{
        fontSize: '15px',
        fontWeight: 600,
        color: 'var(--text-primary)',
        marginBottom: '8px',
      }}>
        {title}
      </div>
      <div style={{
        fontSize: '13px',
        color: 'var(--text-muted)',
        lineHeight: 1.6,
      }}>
        {description}
      </div>
    </div>
  );
}
