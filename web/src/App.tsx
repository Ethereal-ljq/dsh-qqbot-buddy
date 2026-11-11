/**
 * App —— 根组件：登录守卫、hash 路由分发、Layout 与 Toast 装配。
 */
import { useEffect } from 'react';

import { Layout } from './components/Layout';
import { Mark } from './components/Mark';
import { ToastHost } from './components/Toast';
import { EmptyState } from './components/EmptyState';
import { AuditPage } from './pages/AuditPage';
import { BotsPage } from './pages/BotsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LoginPage } from './pages/LoginPage';
import { MembersPage } from './pages/MembersPage';
import { MemoryPage } from './pages/MemoryPage';
import { ModelsPage } from './pages/ModelsPage';
import { OverviewPage } from './pages/OverviewPage';
import { PersonasPage } from './pages/PersonasPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { SettingsPage } from './pages/SettingsPage';
import { StickersPage } from './pages/StickersPage';
import { ToolsPage } from './pages/ToolsPage';
import { navigate, routeOf, useRoutePath } from './router';
import { AppProvider, useApp } from './state/AppContext';

function Splash() {
  return (
    <div className="splash">
      <span className="splash-mark"><Mark size={30} /></span>
      <p className="splash-title">QQBot Buddy 控制台</p>
      <p className="splash-desc mono">正在确认会话…</p>
      <span className="splash-bar" aria-hidden="true" />
    </div>
  );
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="page">
      <section className="panel">
        <div className="panel-pad">
          <EmptyState
            title="页面不存在"
            description={<span>路由 <code className="inline-code mono">{path}</code> 没有对应页面；左侧导航可回到已开放的功能。</span>}
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/overview')}>返回总览</button>}
          />
        </div>
      </section>
    </div>
  );
}

function renderRoute(path: string) {
  switch (path) {
    case '/overview': return <OverviewPage />;
    case '/bots': return <BotsPage />;
    case '/profiles': return <ProfilesPage />;
    case '/models': return <ModelsPage />;
    case '/settings': return <SettingsPage />;
    case '/tools': return <ToolsPage />;
    case '/knowledge': return <KnowledgePage />;
    case '/memory': return <MemoryPage />;
    case '/members': return <MembersPage />;
    case '/personas': return <PersonasPage />;
    case '/stickers': return <StickersPage />;
    case '/audit': return <AuditPage />;
    default: return <NotFound path={path} />;
  }
}

function Shell() {
  const path = useRoutePath();
  const { auth } = useApp();
  const route = routeOf(path);

  useEffect(() => {
    const label = auth === 'in' ? route?.label : auth === 'checking' ? '启动中' : '登录';
    document.title = (label || '控制台') + ' · QQBot Buddy';
  }, [auth, route?.label]);

  if (auth === 'checking') return <Splash />;
  if (auth === 'out') return <LoginPage />;

  return <Layout path={path}>{renderRoute(path)}</Layout>;
}

export function App() {
  return (
    <AppProvider>
      <Shell />
      <ToastHost />
    </AppProvider>
  );
}
