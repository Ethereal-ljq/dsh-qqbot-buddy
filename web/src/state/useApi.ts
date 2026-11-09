/**
 * state/useApi —— 页面级异步数据读取与动作状态（loading / error / reload）。
 *
 * 只依赖 React 与 api/client：不引数据请求库。
 */
import { useCallback, useEffect, useState } from 'react';

import { ApiError, toApiError } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * 读取一次数据；deps 变化时自动重取，组件卸载/依赖变化时 abort。
 * loader 身份不参与依赖，避免内联箭头函数导致死循环。
 */
export function useApi<T>(loader: (signal: AbortSignal) => Promise<T>, deps: ReadonlyArray<unknown>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);
    loader(controller.signal)
      .then((result) => {
        if (!alive) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(toApiError(err));
        setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // loader 故意不进入依赖：调用方用 deps 精确控制重取时机
  }, [...deps, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error, loading, reload };
}

export interface ActionState {
  busy: boolean;
  error: ApiError | null;
  run: <T>(task: () => Promise<T>) => Promise<T | null>;
  clear: () => void;
}

/** 一次性写操作：按钮忙碌态 + 错误收敛。 */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const clear = useCallback(() => setError(null), []);
  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await task();
    } catch (err) {
      setError(toApiError(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear };
}
