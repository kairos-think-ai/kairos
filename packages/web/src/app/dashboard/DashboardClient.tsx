'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import Sidebar, { type View } from '@/components/Sidebar';

const HomeView = dynamic(() => import('@/components/views/HomeView'), { ssr: false });
const ExploreView = dynamic(() => import('@/components/views/ExploreView'), { ssr: false });
const TrendsView = dynamic(() => import('@/components/views/TrendsView'), { ssr: false });
const ProjectsView = dynamic(() => import('@/components/views/ProjectsView'), { ssr: false });

export default function DashboardClient() {
  const [activeView, setActiveView] = useState<View>('home');

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
