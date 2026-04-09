'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import Sidebar, { type View } from '@/components/Sidebar';

const HomeView = dynamic(() => import('@/components/views/HomeView'), { ssr: false });
const ExploreView = dynamic(() => import('@/components/views/ExploreView'), { ssr: false });
const TrendsView = dynamic(() => import('@/components/views/TrendsView'), { ssr: false });
const ProjectsView = dynamic(() => import('@/components/views/ProjectsView'), { ssr: false });

export default function DashboardPage() {
  const [activeView, setActiveView] = useState<View>('home');
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

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

  if (!authenticated) return null;

  return (
    <div className="dashboard-layout">
      <Sidebar
        activeView={activeView}
        onViewChange={setActiveView}
        activePage="dashboard"
      />
      <main className="main-content">
        {activeView === 'home' && <HomeView />}
        {activeView === 'explore' && <ExploreView />}
        {activeView === 'trends' && <TrendsView />}
        {activeView === 'projects' && <ProjectsView />}
      </main>
    </div>
  );
}
