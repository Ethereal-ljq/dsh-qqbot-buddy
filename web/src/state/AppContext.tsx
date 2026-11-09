/**
 * state/AppContext —— 应用级状态：登录态、全局快照、机器人作用域、SSE 事件与通知。
 *
 * 约定：
 *  - 页面不各自轮询 /api/state，统一从这里取快照并调 reloadState()；
 *  - botId === '' 表示“全部机器人”（仅总览/机器人页有意义，其余页面会提示选择）；
 *  - /api/events 断线后指数退避重连，事件驱动快照刷新。
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { ApiError, api, onUnauthorized, toApiError } from '../api/client';
import type { Bot, Health, Profile, SessionInfo, SseEvent, SseStatus, StateSnapshot } from '../api/types';

const BOT_STORAGE_KEY = 'qqbot.console.botId';

export type AuthState = 'checking' | 'in' | 'out';
export type ToastKind = 'ok' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
}

interface AppContextValue {
  auth: AuthState;
  session: SessionInfo | null;
  serverDown: string | null;
  health: Health | null;
  state: StateSnapshot | null;
  stateError: ApiError | null;
  loadingState: boolean;
  reloadState: () => Promise<void>;
  botId: string;
  setBotId: (id: string) => void;
  bots: Bot[];
  bot: Bot | null;
  profiles: Profile[];
  activeProfile: Profile | null;
  sse: SseStatus;
  events: SseEvent[];
  toasts: ToastItem[];
  notify: (kind: ToastKind, message: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function readStoredBot(): string {
  try { return window.localStorage.getItem(BOT_STORAGE_KEY) || ''; } catch { return ''; }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [serverDown, setServerDown] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [stateError, setStateError] = useState<ApiError | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [botId, setBotIdState] = useState<string>(readStoredBot);
  const [sse, setSse] = useState<SseStatus>('connecting');
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toastSeq = useRef(0);
  const authRef = useRef<AuthState>(auth);
  const stateTimer = useRef<number | null>(null);
  const botPicked = useRef(false);

  useEffect(() => { authRef.current = auth; }, [auth]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((kind: ToastKind, message: string, detail?: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message, detail }]);
    window.setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4200);
  }, [dismissToast]);

  const reloadState = useCallback(async () => {
    setLoadingState(true);
    try {
      const next = await api.state();
      setState(next);
      setStateError(null);
      setServerDown(null);
    } catch (err) {
      setStateError(toApiError(err));
    } finally {
      setLoadingState(false);
    }
  }, []);

  const scheduleStateReload = useCallback(() => {
    if (stateTimer.current !== null) return;
    stateTimer.current = window.setTimeout(() => {
      stateTimer.current = null;
      void reloadState();
    }, 400);
  }, [reloadState]);

  // 启动：探测会话（401 = 未登录；网络错误 = 服务未启动）
  useEffect(() => {
    let alive = true;
    api.session()
      .then((info) => {
        if (!alive) return;
        setSession(info);
        setServerDown(null);
        setAuth('in');
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const apiError = toApiError(err);
        if (apiError.status === 401) {
          setAuth('out');
        } else {
          setServerDown(apiError.message);
          setAuth('out');
        }
      });
    return () => { alive = false; };
  }, []);

  // 登录后：健康信息 + 全局快照
  useEffect(() => {
    if (auth !== 'in') return;
    let alive = true;
    api.health()
      .then((value) => { if (alive) setHealth(value); })
      .catch(() => { /* health 失败不阻塞控制台 */ });
    void reloadState();
    return () => { alive = false; };
  }, [auth, reloadState]);

  // 401 广播：会话失效时退回登录页
  useEffect(() => onUnauthorized(() => {
    if (authRef.current === 'in') notify('info', '登录会话已失效，请重新登录');
    setSession(null);
    setState(null);
    setAuth('out');
  }), [notify]);

  // SSE：事件驱动刷新 + 指数退避重连
  useEffect(() => {
    if (auth !== 'in') {
      setSse('connecting');
      return;
    }
    let closed = false;
    let source: EventSource | null = null;
    let retry = 0;
    let timer: number | null = null;

    const connect = () => {
      if (closed) return;
      setSse('connecting');
      source = new EventSource('/api/events', { withCredentials: true });
      source.onopen = () => {
        retry = 0;
        setSse('live');
      };
      const handle = (eventName: string) => (message: MessageEvent<string>) => {
        let data: unknown = message.data;
        try { data = JSON.parse(message.data); } catch { /* 纯文本事件保留原文 */ }
        setEvents((prev) => {
          const seq = (prev[0]?.seq ?? 0) + 1;
          return [{ seq, event: eventName, at: Date.now(), data }, ...prev].slice(0, 80);
        });
        if (eventName === 'bot/status' || eventName === 'job/progress') scheduleStateReload();
      };
      source.onmessage = handle('message');
      for (const name of ['hello', 'bot/status', 'log', 'job/progress']) {
        source.addEventListener(name, handle(name) as EventListener);
      }
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        setSse('down');
        retry = Math.min(retry + 1, 6);
        timer = window.setTimeout(connect, Math.min(15000, 800 * 2 ** retry));
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
      source?.close();
    };
  }, [auth, scheduleStateReload]);

  useEffect(() => () => {
    if (stateTimer.current !== null) window.clearTimeout(stateTimer.current);
  }, []);

  // 首次拿到 bot 列表时恢复/选择作用域
  useEffect(() => {
    if (!state || botPicked.current) return;
    botPicked.current = true;
    const stored = readStoredBot();
    if (stored && state.bots.some((bot) => bot.id === stored)) {
      setBotIdState(stored);
    } else if (state.bots[0]) {
      setBotIdState(state.bots[0].id);
      try { window.localStorage.setItem(BOT_STORAGE_KEY, state.bots[0].id); } catch { /* 忽略隐私模式失败 */ }
    }
  }, [state]);

  const setBotId = useCallback((id: string) => {
    setBotIdState(id);
    try { window.localStorage.setItem(BOT_STORAGE_KEY, id); } catch { /* 忽略隐私模式失败 */ }
  }, []);

  const signIn = useCallback(async (token: string) => {
    await api.login(token);
    const info = await api.session().catch(() => ({ authenticated: true }) as SessionInfo);
    setSession(info);
    setServerDown(null);
    setAuth('in');
  }, []);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* 会话已失效也继续本地登出 */ }
    setSession(null);
    setState(null);
    setEvents([]);
    setSse('connecting');
    setAuth('out');
  }, []);

  const bots = useMemo(() => state?.bots ?? [], [state]);
  const bot = useMemo(() => bots.find((item) => item.id === botId) ?? null, [bots, botId]);
  const profiles = useMemo(
    () => (state?.profiles ?? []).filter((item) => !botId || item.botId === botId),
    [state, botId],
  );
  const activeProfile = useMemo(() => {
    if (!botId) return null;
    const activeId = state?.activeProfiles[botId];
    return profiles.find((item) => item.id === activeId)
      ?? profiles.find((item) => item.isDefault)
      ?? profiles[0]
      ?? null;
  }, [state, botId, profiles]);

  const value = useMemo<AppContextValue>(() => ({
    auth, session, serverDown, health, state, stateError, loadingState, reloadState,
    botId, setBotId, bots, bot, profiles, activeProfile, sse, events, toasts, notify, dismissToast,
    signIn, signOut,
  }), [
    auth, session, serverDown, health, state, stateError, loadingState, reloadState,
    botId, setBotId, bots, bot, profiles, activeProfile, sse, events, toasts, notify, dismissToast,
    signIn, signOut,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp 必须在 <AppProvider> 内使用');
  return value;
}
