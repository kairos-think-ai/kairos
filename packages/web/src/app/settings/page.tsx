'use client';

import { useState, useEffect, useCallback } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import Sidebar from '@/components/Sidebar';
import StatCard from '@/components/StatCard';
import { useToast, type ToastType } from '@/components/Toast';

interface DataCounts {
  conversations: number;
  ideas: number;
  idea_clusters: number;
  drift_reports: number;
  revisit_moments: number;
  coaching_insights: number;
  idea_resurfacing: number;
}

export default function SettingsPage() {
  const [counts, setCounts] = useState<DataCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { addToast } = useToast();

  // API key state
  const [apiKey, setApiKey] = useState('');
  const [apiKeySet, setApiKeySet] = useState(false);
  const [apiKeyMasked, setApiKeyMasked] = useState<string | null>(null);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [apiKeySuccess, setApiKeySuccess] = useState(false);

  const getSession = useCallback(async () => {
    const supabase = createBrowserSupabaseClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      window.location.href = '/login';
      return null;
    }
    return session;
  }, []);

  const fetchCounts = useCallback(async () => {
    setLoading(true);
    try {
      const session = await getSession();
      if (!session) return;

      const response = await fetch('/api/user/data', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const data = await response.json();
      setCounts(data.counts);
    } catch (err) {
      console.error('[Settings] Failed to fetch counts:', err);
      addToast('Failed to load data counts', 'error');
    } finally {
      setLoading(false);
    }
  }, [getSession, addToast]);

  const fetchSettings = useCallback(async () => {
    try {
      const session = await getSession();
      if (!session) return;

      const response = await fetch('/api/user/settings', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!response.ok) return;
      const data = await response.json();
      setApiKeySet(data.settings?.anthropic_api_key_set || false);
      setApiKeyMasked(data.settings?.anthropic_api_key_masked || null);
    } catch (err) {
      console.error('[Settings] Failed to fetch settings:', err);
    }
  }, [getSession]);

  useEffect(() => { fetchCounts(); fetchSettings(); }, [fetchCounts, fetchSettings]);

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;
    setApiKeySaving(true);
    setApiKeyError(null);
    setApiKeySuccess(false);

    try {
      const session = await getSession();
      if (!session) return;

      const response = await fetch('/api/user/settings', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ anthropic_api_key: apiKey }),
      });

      const data = await response.json();

      if (!response.ok) {
        setApiKeyError(data.error || 'Failed to save API key');
        return;
      }

      setApiKeySet(true);
      setApiKeyMasked(data.anthropic_api_key_masked);
      setApiKey('');
      setApiKeySuccess(true);
      addToast('API key saved and validated', 'success');
      setTimeout(() => setApiKeySuccess(false), 3000);
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleClearApiKey = async () => {
    setApiKeySaving(true);
    try {
      const session = await getSession();
      if (!session) return;

      await fetch('/api/user/settings', {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ anthropic_api_key: null }),
      });

      setApiKeySet(false);
      setApiKeyMasked(null);
      setApiKey('');
      addToast('API key removed', 'info');
    } catch {
      addToast('Failed to remove key', 'error');
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const session = await getSession();
      if (!session) return;

      const response = await fetch('/api/dashboard', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!response.ok) throw new Error(`Export failed: ${response.status}`);
      const data = await response.json();

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kairos-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast('Data exported successfully', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm !== 'DELETE') return;
    setDeleting(true);
    try {
      const session = await getSession();
      if (!session) return;

      const response = await fetch('/api/user/data', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      });

      if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
      const result = await response.json();
      addToast(`Deleted ${Object.values(result.counts as Record<string, number>).reduce((a: number, b: number) => a + b, 0)} records`, 'success');
      setDeleteConfirm('');
      fetchCounts();
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="dashboard-layout">
      <Sidebar activePage="settings" />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Settings & Data</h1>
          <p className="page-subtitle">Manage your cloud data, export, or delete everything</p>
        </div>

        {/* Privacy Tier */}
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Privacy Tier</h2>
          </div>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '16px',
          }}>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
              Your privacy tier is controlled from the Kairos browser extension popup.
              Change it there to switch between <strong style={{ color: 'var(--text-primary)' }}>Own Tier</strong> (local-only)
              and <strong style={{ color: 'var(--text-primary)' }}>Trust Tier</strong> (cloud-powered insights).
            </div>
          </div>
        </div>

        {/* Anthropic API Key */}
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Anthropic API Key</h2>
            {apiKeySet && <span className="section-badge">configured</span>}
          </div>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '16px',
          }}>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '12px' }}>
              Kairos uses Claude to analyze your conversations and detect unknown file formats.
              Enter your Anthropic API key to enable these features.
              Get a key at{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                console.anthropic.com
              </a>.
            </div>

            {apiKeySet && apiKeyMasked && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '12px',
                padding: '8px 12px',
                background: 'var(--bg-primary)',
                borderRadius: '6px',
                border: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                  {apiKeyMasked}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>(saved)</span>
                <button
                  onClick={handleClearApiKey}
                  disabled={apiKeySaving}
                  style={{
                    marginLeft: 'auto',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    fontSize: '12px',
                    cursor: apiKeySaving ? 'not-allowed' : 'pointer',
                  }}
                >
                  Remove
                </button>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setApiKeyError(null); }}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: `1px solid ${apiKeyError ? 'var(--danger)' : 'var(--border)'}`,
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: '13px',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <button
                onClick={handleSaveApiKey}
                disabled={!apiKey.trim() || apiKeySaving}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: 'none',
                  background: apiKey.trim() && !apiKeySaving ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: apiKey.trim() && !apiKeySaving ? '#fff' : 'var(--text-muted)',
                  fontSize: '13px',
                  cursor: apiKey.trim() && !apiKeySaving ? 'pointer' : 'not-allowed',
                }}
              >
                {apiKeySaving ? 'Validating...' : apiKeySet ? 'Update Key' : 'Save Key'}
              </button>
            </div>

            {apiKeyError && (
              <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>
                {apiKeyError}
              </div>
            )}
            {apiKeySuccess && (
              <div style={{ fontSize: '12px', color: '#4ade80', marginTop: '8px' }}>
                Key validated and saved successfully.
              </div>
            )}
          </div>
        </div>

        {/* OpenAI API Key */}
        <OpenAIKeySection getSession={getSession} addToast={addToast} />

        {/* Self-Hosted Supabase (Own Tier) */}
        <SupabaseOverrideSection getSession={getSession} addToast={addToast} />

        {/* Cloud Data Counts */}
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Cloud Data</h2>
            <span className="section-badge">{loading ? '...' : 'synced'}</span>
          </div>
          {loading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading data counts...</div>
          ) : counts ? (
            <div className="stats-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <StatCard label="Conversations" value={counts.conversations} />
              <StatCard label="Ideas" value={counts.ideas} accent />
              <StatCard label="Clusters" value={counts.idea_clusters} />
              <StatCard label="Drift Reports" value={counts.drift_reports} />
              <StatCard label="Revisit Moments" value={counts.revisit_moments} />
              <StatCard label="Coaching Insights" value={counts.coaching_insights} />
              <StatCard label="Resurfacing" value={counts.idea_resurfacing} />
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Unable to load data counts.</div>
          )}
        </div>

        {/* Export */}
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Export Data</h2>
          </div>
          <div style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '10px',
            padding: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Download all your cloud data as a JSON file
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              style={{
                padding: '8px 16px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                fontSize: '13px',
                cursor: exporting ? 'not-allowed' : 'pointer',
                opacity: exporting ? 0.6 : 1,
              }}
            >
              {exporting ? 'Exporting...' : 'Export JSON'}
            </button>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="section">
          <div className="section-header">
            <h2 className="section-title">Danger Zone</h2>
          </div>
          <div className="danger-zone">
            <h3>Delete All Cloud Data</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '16px' }}>
              This permanently deletes all your conversations, ideas, drift reports, coaching insights,
              and resurfacing data from the cloud. Local data stored in the browser extension is unaffected.
              This action cannot be undone.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <input
                type="text"
                placeholder='Type "DELETE" to confirm'
                value={deleteConfirm}
                onChange={e => setDeleteConfirm(e.target.value)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontSize: '13px',
                  fontFamily: 'var(--font-mono)',
                  width: '200px',
                }}
              />
              <button
                onClick={handleDelete}
                disabled={deleteConfirm !== 'DELETE' || deleting}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  border: '1px solid var(--danger)',
                  background: deleteConfirm === 'DELETE' ? 'var(--danger)' : 'transparent',
                  color: deleteConfirm === 'DELETE' ? '#fff' : 'var(--danger)',
                  fontSize: '13px',
                  cursor: deleteConfirm === 'DELETE' && !deleting ? 'pointer' : 'not-allowed',
                  opacity: deleteConfirm !== 'DELETE' || deleting ? 0.5 : 1,
                }}
              >
                {deleting ? 'Deleting...' : 'Delete My Data'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ============================================================
// OpenAI API Key Section (for embeddings)
// ============================================================

function OpenAIKeySection({ getSession, addToast }: { getSession: () => Promise<any>; addToast: (msg: string, type?: ToastType) => void }) {
  const [key, setKey] = useState('');
  const [keySet, setKeySet] = useState(false);
  const [keyMasked, setKeyMasked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function fetchStatus() {
      const session = await getSession();
      if (!session) return;
      try {
        const res = await fetch('/api/user/settings', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setKeySet(data.settings?.openai_api_key_set || false);
          setKeyMasked(data.settings?.openai_api_key_masked || null);
        }
      } catch {}
    }
    fetchStatus();
  }, [getSession]);

  const handleSave = async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const session = await getSession();
      if (!session) return;
      const res = await fetch('/api/user/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ openai_api_key: key }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save'); return; }
      setKeySet(true);
      setKeyMasked(data.openai_api_key_masked);
      setKey('');
      setSuccess(true);
      addToast('OpenAI API key saved', 'success');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const session = await getSession();
      if (!session) return;
      await fetch('/api/user/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ openai_api_key: null }),
      });
      setKeySet(false);
      setKeyMasked(null);
      setKey('');
      addToast('OpenAI key removed', 'info');
    } catch {
      addToast('Failed to remove key', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section">
      <div className="section-header">
        <h2 className="section-title">OpenAI API Key</h2>
        {keySet && <span className="section-badge">configured</span>}
      </div>
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '10px',
        padding: '16px',
      }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '12px' }}>
          Kairos uses OpenAI for message embeddings (similarity search, drift detection, clustering).
          Get a key at{' '}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            platform.openai.com
          </a>.
        </div>

        {keySet && keyMasked && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
            padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: '6px', border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{keyMasked}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>(saved)</span>
            <button onClick={handleClear} disabled={saving} style={{
              marginLeft: 'auto', padding: '4px 10px', borderRadius: '4px',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-muted)', fontSize: '12px', cursor: saving ? 'not-allowed' : 'pointer',
            }}>Remove</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <input type="password" placeholder="sk-proj-..." value={key}
            onChange={e => { setKey(e.target.value); setError(null); }}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: '6px',
              border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
              background: 'var(--bg-primary)', color: 'var(--text-primary)',
              fontSize: '13px', fontFamily: 'var(--font-mono)',
            }}
          />
          <button onClick={handleSave} disabled={!key.trim() || saving} style={{
            padding: '8px 16px', borderRadius: '6px', border: 'none',
            background: key.trim() && !saving ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: key.trim() && !saving ? '#fff' : 'var(--text-muted)',
            fontSize: '13px', cursor: key.trim() && !saving ? 'pointer' : 'not-allowed',
          }}>
            {saving ? 'Saving...' : keySet ? 'Update Key' : 'Save Key'}
          </button>
        </div>

        {error && <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>{error}</div>}
        {success && <div style={{ fontSize: '12px', color: '#4ade80', marginTop: '8px' }}>Key saved successfully.</div>}
      </div>
    </div>
  );
}

// ============================================================
// Supabase Override Section (Own Tier — self-hosted)
// ============================================================

function SupabaseOverrideSection({ getSession, addToast }: { getSession: () => Promise<any>; addToast: (msg: string, type?: ToastType) => void }) {
  const [url, setUrl] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [maskedUrl, setMaskedUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function fetchStatus() {
      const session = await getSession();
      if (!session) return;
      try {
        const res = await fetch('/api/user/settings', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setConfigured(data.settings?.supabase_url_set || false);
          setMaskedUrl(data.settings?.supabase_url_masked || null);
        }
      } catch {}
    }
    fetchStatus();
  }, [getSession]);

  const handleSave = async () => {
    if (!url.trim() || !serviceKey.trim()) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const session = await getSession();
      if (!session) return;
      const res = await fetch('/api/user/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabase_url: url, supabase_service_role_key: serviceKey }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save'); return; }
      setConfigured(true);
      setMaskedUrl(data.supabase_url_masked);
      setUrl('');
      setServiceKey('');
      setSuccess(true);
      addToast('Supabase configuration saved', 'success');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      const session = await getSession();
      if (!session) return;
      await fetch('/api/user/settings', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabase_url: null, supabase_service_role_key: null }),
      });
      setConfigured(false);
      setMaskedUrl(null);
      setUrl('');
      setServiceKey('');
      addToast('Supabase override removed — using Kairos hosted database', 'info');
    } catch {
      addToast('Failed to remove configuration', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="section">
      <div className="section-header">
        <h2 className="section-title">Self-Hosted Database (Own Tier)</h2>
        {configured && <span className="section-badge">configured</span>}
      </div>
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '10px',
        padding: '16px',
      }}>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6', marginBottom: '12px' }}>
          Optional: Use your own Supabase project instead of Kairos hosted database.
          Your data will be stored entirely in your Supabase — nothing touches Kairos servers.
          Get a free project at{' '}
          <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            supabase.com
          </a>.
          Tables are created automatically on first use.
        </div>

        {configured && maskedUrl && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
            padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: '6px', border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{maskedUrl}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>(connected)</span>
            <button onClick={handleClear} disabled={saving} style={{
              marginLeft: 'auto', padding: '4px 10px', borderRadius: '4px',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-muted)', fontSize: '12px', cursor: saving ? 'not-allowed' : 'pointer',
            }}>Remove</button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <input type="text" placeholder="https://your-project.supabase.co" value={url}
            onChange={e => { setUrl(e.target.value); setError(null); }}
            style={{
              padding: '8px 12px', borderRadius: '6px',
              border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
              background: 'var(--bg-primary)', color: 'var(--text-primary)',
              fontSize: '13px', fontFamily: 'var(--font-mono)',
            }}
          />
          <input type="password" placeholder="Service Role Key (eyJ...)" value={serviceKey}
            onChange={e => { setServiceKey(e.target.value); setError(null); }}
            style={{
              padding: '8px 12px', borderRadius: '6px',
              border: `1px solid ${error ? 'var(--danger)' : 'var(--border)'}`,
              background: 'var(--bg-primary)', color: 'var(--text-primary)',
              fontSize: '13px', fontFamily: 'var(--font-mono)',
            }}
          />
          <button onClick={handleSave} disabled={!url.trim() || !serviceKey.trim() || saving} style={{
            padding: '8px 16px', borderRadius: '6px', border: 'none',
            background: url.trim() && serviceKey.trim() && !saving ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: url.trim() && serviceKey.trim() && !saving ? '#fff' : 'var(--text-muted)',
            fontSize: '13px', cursor: url.trim() && serviceKey.trim() && !saving ? 'pointer' : 'not-allowed',
            alignSelf: 'flex-start',
          }}>
            {saving ? 'Connecting...' : configured ? 'Update Connection' : 'Connect'}
          </button>
        </div>

        {error && <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>{error}</div>}
        {success && <div style={{ fontSize: '12px', color: '#4ade80', marginTop: '8px' }}>Connected to your Supabase project. Tables will be created automatically.</div>}
      </div>
    </div>
  );
}
