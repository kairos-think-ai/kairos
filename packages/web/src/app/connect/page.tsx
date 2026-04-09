'use client';

import { useState, useEffect } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import Sidebar from '@/components/Sidebar';

type Platform = 'claude-ai' | 'claude-code' | 'claude-desktop';

export default function ConnectPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [activePlatform, setActivePlatform] = useState<Platform>('claude-ai');
  const [copied, setCopied] = useState<string | null>(null);

  const mcpUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/mcp`
    : 'https://your-kairos-app.vercel.app/api/mcp';

  useEffect(() => {
    async function checkAuth() {
      const supabase = createBrowserSupabaseClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.location.href = '/login';
        return;
      }
      setAuthenticated(true);
    }
    checkAuth();
  }, []);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  if (authenticated === null) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-muted)',
      }}>
        Loading...
      </div>
    );
  }

  const platforms: Array<{ id: Platform; label: string; icon: string }> = [
    { id: 'claude-ai', label: 'Claude.ai', icon: '◉' },
    { id: 'claude-code', label: 'Claude Code', icon: '>' },
    { id: 'claude-desktop', label: 'Claude Desktop', icon: '◇' },
  ];

  return (
    <div className="dashboard-layout">
      <Sidebar activeView="home" onViewChange={() => {}} activePage="connect" />
      <main className="main-content">
        <div className="page-header">
          <h1 className="page-title">Connect to Claude</h1>
          <p className="page-subtitle">
            Add Kairos to your Claude conversations for real-time thinking coaching
          </p>
        </div>

        {/* Platform tabs */}
        <div style={{
          display: 'flex', gap: '8px', marginBottom: '24px',
        }}>
          {platforms.map(p => (
            <button
              key={p.id}
              onClick={() => setActivePlatform(p.id)}
              style={{
                padding: '10px 20px',
                borderRadius: '8px',
                border: activePlatform === p.id ? '1.5px solid var(--accent)' : '1px solid var(--border-subtle)',
                background: activePlatform === p.id ? 'rgba(99, 102, 241, 0.1)' : 'var(--bg-secondary)',
                color: activePlatform === p.id ? '#6366F1' : 'var(--text-secondary)',
                fontSize: '14px',
                fontWeight: activePlatform === p.id ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 0.15s',
                display: 'flex', alignItems: 'center', gap: '8px',
              }}
            >
              <span style={{ fontSize: '16px' }}>{p.icon}</span>
              {p.label}
            </button>
          ))}
        </div>

        {/* Platform-specific instructions */}
        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: '12px',
          border: '1px solid var(--border-subtle)',
          padding: '28px',
          maxWidth: '640px',
        }}>
          {activePlatform === 'claude-ai' && (
            <ClaudeAiInstructions mcpUrl={mcpUrl} copied={copied} onCopy={copyToClipboard} />
          )}
          {activePlatform === 'claude-code' && (
            <ClaudeCodeInstructions mcpUrl={mcpUrl} copied={copied} onCopy={copyToClipboard} />
          )}
          {activePlatform === 'claude-desktop' && (
            <ClaudeDesktopInstructions />
          )}
        </div>

        {/* What happens next */}
        <div style={{
          marginTop: '24px', maxWidth: '640px',
          fontSize: '13px', color: 'var(--text-muted)', lineHeight: '1.6',
        }}>
          Once connected, Kairos gives Claude access to your thinking profile, engagement patterns,
          and coaching tools. Start any conversation by asking Claude to "load my Kairos profile"
          or use the "Start with Kairos" prompt.
        </div>
      </main>
    </div>
  );
}

function ClaudeAiInstructions({ mcpUrl, copied, onCopy }: {
  mcpUrl: string; copied: string | null; onCopy: (text: string, id: string) => void;
}) {
  return (
    <>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 20px 0' }}>
        Add Kairos to Claude.ai
      </h2>

      <Step number={1} title="Open Connectors settings">
        Go to <strong>claude.ai</strong> &gt; click your profile &gt; <strong>Settings</strong> &gt; <strong>Connectors</strong>
      </Step>

      <Step number={2} title="Add Custom Connector">
        Click <strong>"Add custom connector"</strong> and paste this URL:
        <CodeBlock text={mcpUrl} copied={copied === 'mcp-url'} onCopy={() => onCopy(mcpUrl, 'mcp-url')} />
      </Step>

      <Step number={3} title="Save and start chatting">
        Save the connector. In any new conversation, ask Claude:
        <CodeBlock
          text="Load my Kairos thinking profile"
          copied={copied === 'prompt'}
          onCopy={() => onCopy('Load my Kairos thinking profile', 'prompt')}
        />
      </Step>
    </>
  );
}

function ClaudeCodeInstructions({ mcpUrl, copied, onCopy }: {
  mcpUrl: string; copied: string | null; onCopy: (text: string, id: string) => void;
}) {
  const addCommand = `claude mcp add kairos --transport http ${mcpUrl}`;

  return (
    <>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 20px 0' }}>
        Add Kairos to Claude Code
      </h2>

      <Step number={1} title="Add the MCP server">
        Run this command in your terminal:
        <CodeBlock text={addCommand} copied={copied === 'cc-cmd'} onCopy={() => onCopy(addCommand, 'cc-cmd')} />
      </Step>

      <Step number={2} title="Start a new session">
        Open Claude Code. Kairos tools are now available. Try:
        <CodeBlock
          text="/kairos:coach"
          copied={copied === 'cc-skill'}
          onCopy={() => onCopy('/kairos:coach', 'cc-skill')}
        />
      </Step>

      <div style={{
        marginTop: '16px', padding: '12px',
        background: 'rgba(99, 102, 241, 0.06)',
        borderRadius: '8px', border: '1px solid rgba(99, 102, 241, 0.15)',
        fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6',
      }}>
        <strong>Available tools:</strong> kairos_profile, kairos_coach, kairos_recall, kairos_reflect, kairos_resurface, kairos_connections
      </div>
    </>
  );
}

function ClaudeDesktopInstructions() {
  return (
    <>
      <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 20px 0' }}>
        Add Kairos to Claude Desktop
      </h2>

      <Step number={1} title="Connect via Claude.ai first">
        Claude Desktop syncs connectors from your Claude.ai account.
        Follow the <strong>Claude.ai</strong> instructions above to add the Kairos connector.
      </Step>

      <Step number={2} title="Open Claude Desktop">
        The Kairos connector will automatically appear in Claude Desktop.
        No additional configuration needed.
      </Step>

      <div style={{
        marginTop: '16px', padding: '12px',
        background: 'rgba(99, 102, 241, 0.06)',
        borderRadius: '8px', border: '1px solid rgba(99, 102, 241, 0.15)',
        fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6',
      }}>
        Remote connectors configured on Claude.ai automatically sync to Claude Desktop.
        Local MCP servers (stdio) require separate configuration.
      </div>
    </>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '20px', display: 'flex', gap: '14px' }}>
      <div style={{
        width: '28px', height: '28px', borderRadius: '50%',
        background: 'rgba(99, 102, 241, 0.12)',
        color: '#6366F1', fontSize: '14px', fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        {number}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
          {title}
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div
      onClick={onCopy}
      style={{
        marginTop: '8px',
        padding: '10px 14px',
        borderRadius: '8px',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-subtle)',
        fontFamily: 'var(--font-mono)',
        fontSize: '13px',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        wordBreak: 'break-all',
      }}
    >
      <span>{text}</span>
      <span style={{
        fontSize: '11px',
        color: copied ? 'var(--success)' : 'var(--text-muted)',
        flexShrink: 0,
      }}>
        {copied ? 'Copied' : 'Copy'}
      </span>
    </div>
  );
}
