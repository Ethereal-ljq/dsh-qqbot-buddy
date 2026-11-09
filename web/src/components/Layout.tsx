/**
 * components/Layout —— 控制台外壳：左侧分组导航 + 顶栏（面包屑/机器人作用域/SSE）+ 事件横条。
 *
 * 布局是固定后台骨架：sidebar 228px，顶栏 50px，事件横条 28px；
 * 窄屏（<900px）侧栏变成抽屉式导航。键盘 "/" 聚焦当前页搜索框。
 */
import { useEffect, useState, type ReactNode } from 'react';

import { fmtTimeSmart, summarizeEvent, truncate } from '../lib/format';
import { routeOf, NAV_GROUPS, type RouteDef } from '../router';
import { useApp } from '../state/AppContext';
import { Mark } from './Mark';
import { StatusDot } from './Status';

const EVENT_LABEL: Record<string, string> = {
  hello: '已连接',
  'bot/status': '机器人状态',
  'job/progress': '任务进度',
  log: '日志',
  message: '事件',
};

function NavItem({ route, active, onClick }: { route: RouteDef; active: boolean; onClick: () => void }) {
  return (
    <a
      href={'#' + route.path}
      className={'nav-item' + (active ? ' active' : '') + (route.pending ? ' pending' : '')}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="nav-label">{route.label}</span>
      {route.pending ? <span className="nav-flag">待接入</span> : null}
    </a>
  );
}

export function Layout({ path, children }: { path: string; children: ReactNode }) {
  const {
    state, health, botId, setBotId, sse, events, loadingState, reloadState, signOut,
  } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  const route = routeOf(path);
  const version = health?.version || state?.version || '0.1.0';
  const consoleHost = state?.console.host || '127.0.0.1';
  const consolePort = state?.console.port || 6198;
  const latest = events[0];
  const botHostOnline = state?.runtime.online ?? false;

  useEffect(() => { setNavOpen(false); }, [path]);

  // "/" 聚焦当前页搜索框（pages 给搜索输入加 data-search-input）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const search = document.querySelector<HTMLInputElement>('[data-search-input]');
      if (!search) return;
      event.preventDefault();
      search.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const bots = state?.bots ?? [];
  const sseLabel = sse === 'live' ? '事件流实时' : sse === 'connecting' ? '事件流连接中' : '事件流断开 · 重连中';

  return (
    <div className={'app' + (navOpen ? ' nav-open' : '')}>
      <aside className="sidebar">
        <a className="brand" href="#/overview" aria-label="返回总览">
          <span className="brand-mark"><Mark size={19} /></span>
          <span className="brand-text">
            <span className="brand-name">QQBot Buddy</span>
            <span className="brand-sub">控制台 · 本机</span>
          </span>
        </a>

        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => (
                <NavItem
                  key={item.path}
                  route={item}
                  active={route?.path === item.path}
                  onClick={() => setNavOpen(false)}
                />
              ))}
            </div>
          ))}
        </nav>

        <footer className="sidebar-foot">
          <div className="sf-line">
            <StatusDot tone={health ? 'ok' : 'warn'} pulse={sse === 'live'} />
            <span>{health ? '控制台在线' : '控制台连接中'}</span>
            <span className="sf-version mono">v{version}</span>
          </div>
          <div className="sf-line sf-host">
            <StatusDot tone={botHostOnline ? 'ok' : 'idle'} />
            <span>机器人宿主{botHostOnline ? '在线' : '未连接'}</span>
          </div>
          <div className="sf-meta mono">{consoleHost}:{consolePort}</div>
          <div className="sf-meta">QQBot Buddy · dsh 插件</div>
        </footer>
      </aside>

      <button
        type="button"
        className="nav-scrim"
        aria-label="关闭导航"
        onClick={() => setNavOpen(false)}
      />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn nav-toggle"
            aria-label={navOpen ? '关闭导航' : '打开导航'}
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <span aria-hidden="true">{navOpen ? '×' : '≡'}</span>
          </button>

          <div className="crumb" aria-label="面包屑">
            <span className="crumb-group">{route?.group || '控制台'}</span>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <span className="crumb-current">{route?.label || '未知页面'}</span>
            {route?.pending ? <span className="crumb-pending">待接入</span> : null}
          </div>

          <div className="topbar-right">
            <label className="scope-select">
              <span className="scope-select-label">机器人</span>
              <select
                className="input select-compact"
                value={botId}
                onChange={(event) => setBotId(event.target.value)}
              >
                <option value="">全部机器人</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>{bot.name}</option>
                ))}
              </select>
            </label>
            <span className={'sse-pill sse-' + sse} title={sseLabel}>
              <StatusDot tone={sse === 'live' ? 'ok' : sse === 'connecting' ? 'warn' : 'danger'} pulse={sse === 'live'} />
              <span className="sse-text">{sse === 'live' ? '实时' : sse === 'connecting' ? '连接中' : '断开'}</span>
            </span>
            <button
              type="button"
              className={'btn btn-ghost btn-sm refresh-btn' + (loadingState ? ' busy' : '')}
              onClick={() => void reloadState()}
              disabled={loadingState}
              title="刷新全局快照"
            >
              {loadingState ? '刷新中…' : '刷新'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>退出</button>
          </div>
        </header>

        <div className={'rail rail-' + sse} aria-live="off">
          <span className="rail-state">
            <StatusDot tone={sse === 'live' ? 'ok' : sse === 'connecting' ? 'warn' : 'danger'} pulse={sse === 'live'} />
            {sse === 'live' ? 'SSE' : sse === 'connecting' ? '连接中' : '离线'}
          </span>
          <span className="rail-sep" aria-hidden="true">│</span>
          {latest ? (
            <>
              <span className="rail-event mono">{EVENT_LABEL[latest.event] || latest.event}</span>
              <span className="rail-text">{truncate(summarizeEvent(latest.data) || '（无负载）', 160)}</span>
              <span className="rail-time mono">{fmtTimeSmart(latest.at)}</span>
            </>
          ) : (
            <span className="rail-text">等待事件…（/api/events 会在登录后自动订阅）</span>
          )}
        </div>

        <main className="content" key={path}>{children}</main>
      </div>
    </div>
  );
}
