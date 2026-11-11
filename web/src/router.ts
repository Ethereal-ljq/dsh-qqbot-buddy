/**
 * router —— 极简 hash 路由与导航清单。
 *
 * 不引 react-router：hash 路由让控制台静态托管无需 SPA fallback 也能直达任意页面，
 * 对服务端只要求托管 web/dist 一个静态目录。
 */
import { useSyncExternalStore } from 'react';

export interface RouteDef {
  path: string;
  label: string;
  group: string;
  /** 页面能力尚未接入：导航里标灰并显示“待接入”。 */
  pending?: boolean;
}

export const DEFAULT_ROUTE = '/overview';

export const ROUTES: RouteDef[] = [
  { path: '/overview', label: '总览', group: '运行' },
  { path: '/bots', label: '机器人', group: '运行' },
  { path: '/profiles', label: '配置档与绑定', group: '配置' },
  { path: '/models', label: '模型', group: '配置' },
  { path: '/settings', label: '设置', group: '配置' },
  { path: '/tools', label: '工具与技能', group: '配置' },
  { path: '/knowledge', label: '知识库', group: '数据' },
  { path: '/memory', label: '记忆', group: '数据' },
  { path: '/members', label: '群友库', group: '数据' },
  { path: '/personas', label: '人格卡', group: '数据' },
  { path: '/stickers', label: '表情包', group: '数据' },
  { path: '/audit', label: '审计日志', group: '系统' },
];

export interface NavGroup {
  label: string;
  items: RouteDef[];
}

/** 按 ROUTES 顺序分组，sidebar 直接消费。 */
export const NAV_GROUPS: NavGroup[] = (() => {
  const groups: NavGroup[] = [];
  for (const route of ROUTES) {
    let group = groups.find((item) => item.label === route.group);
    if (!group) {
      group = { label: route.group, items: [] };
      groups.push(group);
    }
    group.items.push(route);
  }
  return groups;
})();

const ROUTE_BY_PATH = new Map(ROUTES.map((route) => [route.path, route]));

export function routeOf(path: string): RouteDef | undefined {
  return ROUTE_BY_PATH.get(path);
}

/** 把 location.hash 归一成 /path；空值与未知形态回退默认路由语义。 */
export function normalizePath(raw: string): string {
  let value = raw || '';
  if (value.startsWith('#')) value = value.slice(1);
  if (!value.startsWith('/')) value = '/' + value;
  const [pathPart] = value.split('?');
  const path = pathPart.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

function readPath(): string {
  if (typeof window === 'undefined') return DEFAULT_ROUTE;
  const path = normalizePath(window.location.hash);
  return path === '/' ? DEFAULT_ROUTE : path;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onHashChange = () => listener();
  window.addEventListener('hashchange', onHashChange);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', onHashChange);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function currentPath(): string {
  return readPath();
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const target = path.startsWith('/') ? path : '/' + path;
  const hash = '#' + target;
  if (window.location.hash === hash) return;
  if (options.replace) {
    const url = window.location.pathname + window.location.search + hash;
    window.history.replaceState(null, '', url);
    notify();
  } else {
    window.location.hash = hash;
  }
}

/** 订阅 hash 变化；SSR/首帧无 hash 时返回默认路由。 */
export function useRoutePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => DEFAULT_ROUTE);
}
