'use client';

import { useEffect, useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';

/**
 * OAuth Consent Page
 *
 * When a third-party app (like Claude.ai) wants to access the user's
 * Kairos data, Supabase redirects here with an `authorization_id`.
 *
 * This page:
 * 1. Checks if the user is logged in (redirects to login if not)
 * 2. Fetches the authorization details (client name, scopes)
 * 3. Shows a consent screen
 * 4. On approve: calls Supabase to approve the authorization
 * 5. Supabase redirects back to the third-party app with an auth code
 */
export default function OAuthConsentPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authDetails, setAuthDetails] = useState<any>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    async function init() {
      const supabase = createBrowserSupabaseClient();

      // Check if user is logged in
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        // Redirect to login, come back here after
        const currentUrl = window.location.href;
        window.location.href = `/login?next=${encodeURIComponent(currentUrl)}`;
        return;
      }

      // Get the authorization_id from URL
      const params = new URLSearchParams(window.location.search);
      const authorizationId = params.get('authorization_id');

      if (!authorizationId) {
        setError('Missing authorization ID. Please try connecting again from Claude.');
        setLoading(false);
        return;
      }

      try {
        // Fetch authorization details from Supabase
        const { data, error: authError } = await (supabase.auth as any).oauth.getAuthorizationDetails(authorizationId);

        if (authError) {
          setError(authError.message || 'Failed to load authorization details');
          setLoading(false);
          return;
        }

        setAuthDetails({ ...data, authorizationId });
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load authorization details');
        setLoading(false);
      }
    }

    init();
  }, []);

  const handleApprove = async () => {
    setApproving(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { data, error: approveError } = await (supabase.auth as any).oauth.approveAuthorization(authDetails.authorizationId);

      if (approveError) {
        setError(approveError.message || 'Failed to approve');
        setApproving(false);
        return;
      }

      // Redirect to the client's callback (e.g., Claude Code's localhost server)
      if (data?.redirect_to) {
        window.location.href = data.redirect_to;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve authorization');
      setApproving(false);
    }
  };

  const handleDeny = async () => {
    try {
      const supabase = createBrowserSupabaseClient();
      const { data } = await (supabase.auth as any).oauth.denyAuthorization(authDetails.authorizationId);
      if (data?.redirect_to) {
        window.location.href = data.redirect_to;
        return;
      }
    } catch {
      window.location.href = '/dashboard';
    }
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh',
        background: 'var(--bg-primary)', color: 'var(--text-primary)',
      }}>
        <div style={{ fontSize: '16px', color: 'var(--text-muted)' }}>Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: '16px',
        background: 'var(--bg-primary)', color: 'var(--text-primary)',
      }}>
        <div style={{ fontSize: '16px', fontWeight: 600, color: '#EF4444' }}>
          Connection Error
        </div>
        <div style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '400px', textAlign: 'center' }}>
          {error}
        </div>
        <a href="/connect" style={{
          marginTop: '8px', padding: '8px 20px', borderRadius: '8px',
          background: '#6366F1', color: 'white', fontSize: '14px', textDecoration: 'none',
        }}>
          Back to Connect
        </a>
      </div>
    );
  }

  const clientName = authDetails?.client?.name || authDetails?.client?.client_name || 'An application';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh',
      background: 'var(--bg-primary)', color: 'var(--text-primary)',
    }}>
      <div style={{
        maxWidth: '420px', width: '100%', padding: '32px',
        background: 'var(--bg-secondary)', borderRadius: '16px',
        border: '1px solid var(--border-subtle)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '48px', height: '48px', margin: '0 auto 12px',
            background: 'linear-gradient(135deg, #6366F1 0%, #818CF8 100%)',
            borderRadius: '12px',
          }} />
          <div style={{ fontSize: '20px', fontWeight: 700 }}>Kairos</div>
        </div>

        {/* Request */}
        <div style={{
          textAlign: 'center', marginBottom: '24px',
          fontSize: '15px', color: 'var(--text-secondary)', lineHeight: '1.6',
        }}>
          <strong style={{ color: 'var(--text-primary)' }}>{clientName}</strong> wants to access
          your Kairos thinking profile, conversation history, and coaching tools.
        </div>

        {/* Permissions */}
        <div style={{
          background: 'var(--bg-primary)', borderRadius: '10px',
          padding: '16px', marginBottom: '24px',
          border: '1px solid var(--border-subtle)',
        }}>
          <div style={{
            fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em',
            color: 'var(--text-muted)', marginBottom: '12px',
          }}>
            This will allow access to:
          </div>
          {[
            'Your thinking profile and engagement metrics',
            'Past conversations and extracted ideas',
            'Coaching and behavioral insights',
            'Concept graph and connections',
          ].map((perm, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '13px', color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}>
              <span style={{ color: '#6366F1' }}>✓</span>
              {perm}
            </div>
          ))}
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={handleDeny}
            style={{
              flex: 1, padding: '12px',
              borderRadius: '8px', border: '1px solid var(--border-subtle)',
              background: 'transparent', color: 'var(--text-secondary)',
              fontSize: '14px', fontWeight: 500, cursor: 'pointer',
            }}
          >
            Deny
          </button>
          <button
            onClick={handleApprove}
            disabled={approving}
            style={{
              flex: 2, padding: '12px',
              borderRadius: '8px', border: 'none',
              background: approving ? 'var(--bg-tertiary)' : '#6366F1',
              color: approving ? 'var(--text-muted)' : 'white',
              fontSize: '14px', fontWeight: 600,
              cursor: approving ? 'not-allowed' : 'pointer',
            }}
          >
            {approving ? 'Connecting...' : 'Allow Access'}
          </button>
        </div>

        <div style={{
          textAlign: 'center', marginTop: '16px',
          fontSize: '12px', color: 'var(--text-muted)',
        }}>
          You can revoke access at any time from Settings.
        </div>
      </div>
    </div>
  );
}
