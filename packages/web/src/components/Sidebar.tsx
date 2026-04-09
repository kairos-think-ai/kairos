'use client';

import { createBrowserSupabaseClient } from '@/lib/supabase/client';

export type View = 'home' | 'explore' | 'trends' | 'projects' | 'settings';

interface SidebarProps {
  activeView?: View;
  onViewChange?: (view: View) => void;
  activePage?: 'dashboard' | 'import' | 'connect' | 'settings';
}

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '◉' },
  { id: 'explore', label: 'Explore', icon: '🔭' },
  { id: 'trends', label: 'Trends', icon: '📈' },
  { id: 'projects', label: 'Projects', icon: '📁' },
];

export default function Sidebar({ activeView, onViewChange, activePage = 'dashboard' }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="logo">
        <div className="logo-mark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <span className="logo-text">Kairos</span>
      </div>

      <nav className="nav-section">
        <div className="nav-section-label">Dashboard</div>
        {VIEWS.map(item => (
          <div
            key={item.id}
            className={`nav-item ${activePage === 'dashboard' && activeView === item.id ? 'active' : ''}`}
            onClick={() => {
              if (activePage === 'dashboard' && onViewChange) {
                onViewChange(item.id);
              } else {
                window.location.href = '/dashboard';
              }
            }}
            style={{ cursor: 'pointer' }}
          >
            <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>{item.icon}</span>
            {item.label}
          </div>
        ))}
      </nav>

      <nav className="nav-section">
        <div className="nav-section-label">Data</div>
        <a
          href="/import"
          className={`nav-item ${activePage === 'import' ? 'active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>↓</span>
          Import History
        </a>
        <a
          href="/connect"
          className={`nav-item ${activePage === 'connect' ? 'active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>↔</span>
          Connect to Claude
        </a>
      </nav>

      <nav className="nav-section" style={{ marginTop: 'auto' }}>
        <div className="nav-section-label">Settings</div>
        <a
          href="/settings"
          className={`nav-item ${activePage === 'settings' ? 'active' : ''}`}
          style={{ textDecoration: 'none', cursor: 'pointer' }}
        >
          <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>⚙</span>
          Settings
        </a>
        <div
          className="nav-item"
          onClick={() => {
            const html = document.documentElement;
            const current = html.getAttribute('data-theme');
            html.setAttribute('data-theme', current === 'light' ? '' : 'light');
          }}
          style={{ cursor: 'pointer' }}
        >
          <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>◐</span>
          Toggle Theme
        </div>
        <div
          className="nav-item"
          onClick={async () => {
            const supabase = createBrowserSupabaseClient();
            await supabase.auth.signOut();
            window.location.href = '/login';
          }}
          style={{ cursor: 'pointer' }}
        >
          <span style={{ fontSize: '14px', width: '18px', textAlign: 'center' }}>↪</span>
          Sign Out
        </div>
      </nav>
    </aside>
  );
}
