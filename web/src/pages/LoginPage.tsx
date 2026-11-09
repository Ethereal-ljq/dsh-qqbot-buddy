/**
 * pages/LoginPage —— 控制台登录：token 换 HttpOnly 会话 cookie。
 *
 * 页面职责：探测 /api/health 展示服务可达性、提交 token、把 401/429/网络错误
 * 翻译成可执行的中文提示；成功后回到原 hash 路由。
 */
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, api, toApiError } from '../api/client';
import type { Health } from '../api/types';
import { Mark } from '../components/Mark';
import { StatusDot } from '../components/Status';
import { currentPath, navigate, routeOf } from '../router';
import { useApp } from '../state/AppContext';

function loginErrorMessage(error: ApiError): string {
  if (error.status === 401) return 'token 不正确，请核对后重试。';
  if (error.status === 429) return '尝试次数过多，登录已临时限速，请 5 分钟后再试。';
  if (error.status === 0) return error.message;
  return error.message + (error.code ? '（' + error.code + '）' : '');
}

export function LoginPage() {
  const { signIn, serverDown } = useApp();
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState<'checking' | 'ok' | 'fail'>('checking');
  const [probeTick, setProbeTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setReachable('checking');
    api.health()
      .then((value) => {
        if (!alive) return;
        setHealth(value);
        setReachable('ok');
      })
      .catch(() => {
        if (!alive) return;
        setReachable('fail');
      });
    return () => { alive = false; };
  }, [probeTick]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (value === '') {
      setError('请输入控制台 token。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(value);
      const path = currentPath();
      navigate(routeOf(path) ? path : '/overview', { replace: true });
    } catch (err) {
      setError(loginErrorMessage(toApiError(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-left">
        <div className="login-grid" aria-hidden="true" />
        <div className="login-left-inner">
          <div className="login-brand">
            <span className="login-mark"><Mark size={26} /></span>
            <div>
              <p className="login-wordmark">QQBot Buddy</p>
              <p className="login-wordmark-sub mono">dsh-qqbot-buddy · v2 控制台</p>
            </div>
          </div>

          <p className="login-claim">
            一个机器人一份记忆。<br />
            配置档只切换策略，不切换数据。
          </p>

          <div className="boot-log mono" aria-label="控制台启动信息">
            <p className="boot-line"><span className="boot-key">控制台</span><span className="boot-val">127.0.0.1:6198</span></p>
            <p className="boot-line"><span className="boot-key">鉴权</span><span className="boot-val">会话 cookie · CSRF 头</span></p>
            <p className="boot-line"><span className="boot-key">数据</span><span className="boot-val">SQLite · FTS5 trigram</span></p>
            <p className="boot-line">
              <span className="boot-key">服务</span>
              <span className="boot-val">
                <StatusDot tone={reachable === 'ok' ? 'ok' : reachable === 'fail' ? 'danger' : 'warn'} pulse={reachable === 'ok'} />
                {reachable === 'ok'
                  ? '可达 · v' + (health?.version || 'unknown')
                  : reachable === 'fail'
                    ? '不可达（插件进程未启动？）'
                    : '探测中…'}
              </span>
            </p>
          </div>

          <p className="login-left-foot mono">self-hosted · 127.0.0.1 · no cloud</p>
        </div>
      </section>

      <section className="login-right">
        <div className="login-panel">
          <header className="login-head">
            <p className="login-kicker mono">ACCESS</p>
            <h1 className="login-title">登录控制台</h1>
            <p className="login-desc">
              输入控制台 token 建立会话。token 在插件首次启动时生成，保存在数据目录的
              <code className="inline-code">console-token.txt</code>。
            </p>
          </header>

          {reachable === 'fail' ? (
            <div className="note note-error" role="alert">
              <span className="note-title">控制台服务不可达</span>
              <span className="note-text">{serverDown || '请确认 DSH 插件已启用，且控制台监听 127.0.0.1:6198。'}</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setProbeTick((tick) => tick + 1)}>重新探测</button>
            </div>
          ) : null}

          <form className="login-form" onSubmit={(event) => void submit(event)}>
            <label className="field-label" htmlFor="console-token">控制台 token</label>
            <div className="token-row">
              <input
                id="console-token"
                className="input mono token-input"
                type={visible ? 'text' : 'password'}
                value={token}
                autoComplete="current-password"
                autoFocus
                placeholder="粘贴 console-token.txt 中的 token"
                onChange={(event) => setToken(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setVisible((value) => !value)}
                aria-label={visible ? '隐藏 token' : '显示 token'}
              >
                {visible ? '隐藏' : '显示'}
              </button>
            </div>

            {error ? <p className="field-error login-error" role="alert">{error}</p> : null}

            <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
              {busy ? '正在验证…' : '登录'}
            </button>
          </form>

          <footer className="login-foot">
            <p>连续失败 5 次会限速 5 分钟；会话有效期 7 天。</p>
            <p className="mono login-foot-path">~/.dsh-qqbot/v2/console-token.txt</p>
          </footer>
        </div>
      </section>
    </div>
  );
}
