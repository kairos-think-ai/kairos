'use client';

import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import { useState } from 'react';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setLoading(true);
    setError(null);

    // Preserve the 'next' param so auth callback redirects back to the right place
    // (e.g., /oauth/consent?authorization_id=... when coming from MCP connector auth)
    const params = new URLSearchParams(window.location.search);
    const next = params.get('next') || '/';
    const callbackUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

    const supabase = createBrowserSupabaseClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callbackUrl,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
    }
    // If successful, browser redirects to Google — no need to handle here
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      gap: '24px',
      background: 'var(--bg-primary, #0A0A0F)',
      color: 'var(--text-primary, #F0F0F5)',
    }}>
      <div style={{
        width: '56px',
        height: '56px',
        borderRadius: '14px',
        background: 'var(--accent, #6366F1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </div>

      <h1 style={{ fontSize: '28px', fontWeight: 700, margin: 0 }}>Kairos</h1>
      <p style={{
        color: 'var(--text-muted, #555568)',
        fontSize: '14px',
        textAlign: 'center',
        maxWidth: '360px',
        margin: 0,
      }}>
        See what your mind is actually doing across your AI conversations.
      </p>

      <button
        onClick={handleGoogleSignIn}
        disabled={loading}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 24px',
          borderRadius: '8px',
          border: '1px solid var(--border, #333345)',
          background: 'var(--bg-secondary, #16161D)',
          color: 'var(--text-primary, #F0F0F5)',
          fontSize: '14px',
          fontWeight: 500,
          cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
          transition: 'all 150ms',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        {loading ? 'Redirecting...' : 'Continue with Google'}
      </button>

      {error && (
        <p style={{ color: 'var(--danger, #F43F5E)', fontSize: '13px', margin: 0 }}>{error}</p>
      )}

      <p style={{
        color: 'var(--text-muted, #555568)',
        fontSize: '11px',
        textAlign: 'center',
        maxWidth: '300px',
        marginTop: '16px',
      }}>
        Your conversation data is yours. See our privacy model to understand how Kairos handles your data.
      </p>
    </div>
  );
}
