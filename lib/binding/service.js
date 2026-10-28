/**
 * binding/service —— 扫码绑定状态机（宿主内唯一事实源）。
 *
 * 契约见 DESIGN.md「绑定服务契约」：
 *   createBindingService({logger, profileDir, getCredentials, onBound, onUnbind, source,
 *                          connectFn, renderQr})
 *     start()                         幂等；未绑定时开跑扫码（已有凭据则不动）
 *     refresh()                       丢弃当前二维码任务并重建
 *     manual(appId, appSecret)        手动填写凭据 → 持久化 → onBound
 *     unbind()                        清 patch 凭据 → onUnbind → 重新进入扫码
 *     wireState()                     线上状态投影（appSecret 永不出现）
 *     isBound()
 *     dispose()                       终止轮询（插件卸载 / HMR）
 *
 * 相位：idle → starting → waiting ⇄ (onQrExpired 仅记录，connector 自行刷新二维码)
 *        waiting → saving → bound | failed
 *        failed 由 refresh()/start() 重试；bound 由 unbind() 回到 starting。
 *
 * 设计要点：
 * - 回调式 `startQrConnect`（connectFn 可注入，测试不联网）；
 * - 每次启动递增 generation，旧二维码任务（refresh/dispose 触发）的回调一律丢弃；
 * - 所有异常只写 phase.reason + logger.warn/error，绝不产生 unhandled rejection；
 * - 凭据落盘失败 → failed（凭据不完整时不会覆盖原 patch）。
 */
import { startQrConnect } from '@tencent-connect/qqbot-connector';

import { removeCredentials, updateCredentials } from './persist.js';
import { renderQrSvgDataUrl } from './qr.js';

/** 二维码 URL 的默认 source 标记（拼进 q.qq.com 链接便于统计来源）。 */
const DEFAULT_SOURCE = 'dsh-qqbot-buddy';
/** appId / appSecret 长度上限（与官方绑定路由一致，防超大 body 落盘）。 */
const MAX_APP_ID_LENGTH = 128;
const MAX_APP_SECRET_LENGTH = 256;

function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeLog(logger, level, message) {
  try {
    const sink = logger && typeof logger[level] === 'function' ? logger : null;
    if (sink !== null) sink[level](message);
  } catch {
    /* 日志失败不能打挂状态机 */
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 归一化 connector 回调里的凭据（兼容数组 / 单对象 / 缺字段）。 */
function normalizeCredentials(input) {
  let value = input;
  if (Array.isArray(value)) value = value[0];
  if (value === null || typeof value !== 'object') return null;
  const appId = typeof value.appId === 'string' ? value.appId.trim() : '';
  const appSecret = typeof value.appSecret === 'string' ? value.appSecret.trim() : '';
  if (appId === '' || appSecret === '') return null;
  return { appId, appSecret };
}

/**
 * 创建绑定服务实例。
 *
 * @param {object} [options]
 * @param {object} [options.logger] 日志（info/warn/error）
 * @param {string} [options.profileDir] dsh profile 目录（凭据落盘目标）
 * @param {() => {appId?: string, appSecret?: string}} [options.getCredentials] 当前运行时凭据
 * @param {(credentials: {appId: string, appSecret: string}) => any} [options.onBound] 绑定成功回调（可 async）
 * @param {() => any} [options.onUnbind] 解绑回调（可 async）
 * @param {string} [options.source] 二维码 URL 来源标记
 * @param {Function} [options.connectFn] 注入 startQrConnect（测试用）
 * @param {(url: string, logger: object) => Promise<string|undefined>} [options.renderQr] 注入二维码渲染
 * @returns {object} 绑定服务
 */
export function createBindingService(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const logger = opts.logger ?? console;
  const profileDir = typeof opts.profileDir === 'string' ? opts.profileDir.trim() : '';
  const getCredentials = typeof opts.getCredentials === 'function' ? opts.getCredentials : () => ({});
  const onBound = typeof opts.onBound === 'function' ? opts.onBound : null;
  const onUnbind = typeof opts.onUnbind === 'function' ? opts.onUnbind : null;
  const source = isNonEmptyString(opts.source) ? opts.source.trim() : DEFAULT_SOURCE;
  const connectFn = typeof opts.connectFn === 'function' ? opts.connectFn : startQrConnect;
  const renderQr = typeof opts.renderQr === 'function' ? opts.renderQr : renderQrSvgDataUrl;

  /** 当前相位：{kind:'idle'|'starting'|'waiting'|'saving'|'failed'|'bound', ...} */
  let phase = initialPhase();
  /** 二维码任务代号：每次启动/取消递增，旧回调据此作废。 */
  let generation = 0;
  let activeAbort = null;
  let activeStop = null;
  let disposed = false;

  /** 初始相位：运行时已有凭据 → bound，否则 idle（等 index.js 调 start()）。 */
  function initialPhase() {
    let credentials;
    try {
      credentials = getCredentials();
    } catch (error) {
      safeLog(logger, 'warn', '[qqbot-buddy] 读取运行时凭据失败: ' + errText(error));
      return { kind: 'idle' };
    }
    const creds = normalizeCredentials(credentials);
    return creds === null ? { kind: 'idle' } : { kind: 'bound', appId: creds.appId };
  }

  function setPhase(next) {
    phase = next;
  }

  /**
   * 取消当前二维码任务：先递增代号，再 stop()/abort()。
   * 代号先递增保证旧任务即便同步回调 onFailure 也会被当作过期事件丢弃。
   */
  function cancelActive() {
    generation += 1;
    const stop = activeStop;
    const controller = activeAbort;
    activeStop = null;
    activeAbort = null;
    if (typeof stop === 'function') {
      try {
        stop();
      } catch (error) {
        safeLog(logger, 'warn', '[qqbot-buddy] 停止旧扫码任务失败: ' + errText(error));
      }
    }
    if (controller !== null) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  /** 启动一次二维码任务（内部会先取消旧任务）。 */
  function launch() {
    if (disposed) return;
    if (typeof connectFn !== 'function') {
      setPhase({ kind: 'failed', reason: '扫码连接器不可用（未安装 @tencent-connect/qqbot-connector）' });
      return;
    }
    cancelActive();
    generation += 1;
    const gen = generation;
    setPhase({ kind: 'starting' });

    const controller = new AbortController();
    activeAbort = controller;
    const callbacks = {
      onQrDisplayed: (url) => {
        void handleQrDisplayed(gen, url).catch((error) => {
          safeLog(logger, 'warn', '[qqbot-buddy] 二维码渲染失败: ' + errText(error));
        });
      },
      onSuccess: (credentials) => {
        handleSuccess(gen, credentials);
      },
      onFailure: (error) => {
        handleFailure(gen, error);
      },
      onQrExpired: () => {
        handleQrExpired(gen);
      },
    };

    let stop;
    try {
      stop = connectFn(callbacks, {
        displayQrCodeToConsole: false,
        signal: controller.signal,
        source,
      });
    } catch (error) {
      if (disposed || gen !== generation) return;
      cancelActive();
      const reason = '启动扫码失败：' + errText(error);
      setPhase({ kind: 'failed', reason });
      safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
      return;
    }

    if (gen !== generation) {
      // 回调在 connectFn 内部同步触发了 refresh/dispose：丢弃返回的 stop
      if (typeof stop === 'function') {
        try {
          stop();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    activeStop = typeof stop === 'function' ? stop : null;
  }

  /** 二维码就绪 → 渲染 SVG（失败只降级为链接）→ waiting。 */
  async function handleQrDisplayed(gen, url) {
    if (disposed || gen !== generation) return;
    if (typeof url !== 'string' || url.trim() === '') return;
    let qrSvg;
    try {
      qrSvg = await renderQr(url, logger);
    } catch (error) {
      safeLog(logger, 'warn', '[qqbot-buddy] 二维码 SVG 渲染失败（页面降级为链接）: ' + errText(error));
    }
    // 渲染期间可能已被 refresh()/dispose()/success 淘汰
    if (disposed || gen !== generation) return;
    setPhase({
      kind: 'waiting',
      url,
      qrSvg: typeof qrSvg === 'string' && qrSvg !== '' ? qrSvg : undefined,
      issuedAt: Date.now(),
    });
  }

  /** 扫码成功 → saving → 落盘 → bound + onBound。 */
  function handleSuccess(gen, credentials) {
    if (disposed || gen !== generation) return;
    const creds = normalizeCredentials(credentials);
    if (creds === null) {
      cancelActive();
      const reason = '扫码未返回有效凭据（appId/appSecret 缺失）';
      setPhase({ kind: 'failed', reason });
      safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
      return;
    }
    // 成功后 connector 流程已结束；主动 stop 防止残留轮询
    cancelActive();
    setPhase({ kind: 'saving' });
    const result = commit(creds);
    if (result.ok) {
      safeLog(logger, 'info', '[qqbot-buddy] 扫码绑定成功 AppID=' + creds.appId);
    }
  }

  /** 扫码失败 → failed（含原因）。 */
  function handleFailure(gen, error) {
    if (disposed || gen !== generation) return;
    cancelActive();
    const message = errText(error).trim();
    const reason = message === '' ? '扫码绑定失败（未提供原因）' : message;
    setPhase({ kind: 'failed', reason });
    safeLog(logger, 'warn', '[qqbot-buddy] 扫码绑定失败: ' + reason);
  }

  /** 二维码过期：connector 会自行刷新，这里只记录（不改相位）。 */
  function handleQrExpired(gen) {
    if (disposed || gen !== generation) return;
    safeLog(logger, 'debug', '[qqbot-buddy] 二维码已过期，等待 connector 刷新');
  }

  /** 凭据落盘（同步 fs，抛错转 {ok:false,error}）。 */
  function persistCredentials(creds) {
    if (profileDir === '') {
      return {
        ok: false,
        error: '未定位到 profile 目录，无法保存凭据（请检查部署路径或改用环境变量）',
      };
    }
    try {
      const result = updateCredentials(profileDir, creds);
      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || '保存凭据失败');
      }
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: '保存凭据失败：' + errText(error) };
    }
  }

  /** 调用 onBound：同步抛出 / Promise reject 都只记 warn，不影响已保存的 bound 态。 */
  function invokeOnBound(creds) {
    if (onBound === null) return;
    try {
      const maybe = onBound({ appId: creds.appId, appSecret: creds.appSecret });
      Promise.resolve(maybe).catch((error) => {
        safeLog(logger, 'warn', '[qqbot-buddy] 应用新凭据失败（凭据已保存，重启后生效）: ' + errText(error));
      });
    } catch (error) {
      safeLog(logger, 'warn', '[qqbot-buddy] 应用新凭据失败（凭据已保存，重启后生效）: ' + errText(error));
    }
  }

  /** 落盘 + 切 bound + onBound（扫码/手动共用）。 */
  function commit(creds) {
    const saved = persistCredentials(creds);
    if (!saved.ok) {
      const reason = saved.error;
      setPhase({ kind: 'failed', reason });
      safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
      return { ok: false, error: reason };
    }
    setPhase({ kind: 'bound', appId: creds.appId });
    safeLog(
      logger,
      'info',
      '[qqbot-buddy] 凭据已保存到 ' + saved.result.path + '（AppID=' + creds.appId + '）',
    );
    invokeOnBound(creds);
    return { ok: true };
  }

  /** 启动绑定流程（幂等：已在扫码 / 已绑定 / 已释放时不动）。 */
  function start() {
    if (disposed) return;
    try {
      if (phase.kind === 'bound') return;
      if (activeAbort !== null) return;
      launch();
    } catch (error) {
      safeLog(logger, 'error', '[qqbot-buddy] 启动绑定流程失败: ' + errText(error));
    }
  }

  /** 刷新二维码：丢弃当前任务并重建（failed/idle 也可用来重试）。 */
  function refresh() {
    if (disposed) return;
    try {
      if (phase.kind === 'bound') return;
      launch();
    } catch (error) {
      safeLog(logger, 'error', '[qqbot-buddy] 刷新二维码失败: ' + errText(error));
    }
  }

  /**
   * 手动填写凭据：校验 → 停止扫码 → saving → 落盘 → bound + onBound。
   * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
   */
  async function manual(rawAppId, rawAppSecret) {
    try {
      if (disposed) return { ok: false, error: '绑定服务已释放' };
      const appId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
      const appSecret = typeof rawAppSecret === 'string' ? rawAppSecret.trim() : '';
      if (appId === '') return { ok: false, error: 'appId 不能为空' };
      if (appSecret === '') return { ok: false, error: 'appSecret 不能为空' };
      if (appId.length > MAX_APP_ID_LENGTH) {
        return { ok: false, error: 'appId 过长（最多 ' + MAX_APP_ID_LENGTH + ' 字符）' };
      }
      if (appSecret.length > MAX_APP_SECRET_LENGTH) {
        return { ok: false, error: 'appSecret 过长（最多 ' + MAX_APP_SECRET_LENGTH + ' 字符）' };
      }
      cancelActive(); // 手动提交视为放弃当前扫码任务
      setPhase({ kind: 'saving' });
      const result = commit({ appId, appSecret });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, message: '凭据已保存，正在应用' };
    } catch (error) {
      const reason = '手动绑定失败：' + errText(error);
      setPhase({ kind: 'failed', reason });
      safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
      return { ok: false, error: reason };
    }
  }

  /**
   * 解绑：先删 patch 凭据 → onUnbind → 回到 idle 并重建扫码任务。
   * @returns {Promise<{ok: boolean, message?: string, error?: string}>}
   */
  async function unbind() {
    try {
      if (disposed) return { ok: false, error: '绑定服务已释放' };
      if (profileDir === '') {
        return { ok: false, error: '未定位到 profile 目录，无法清除凭据' };
      }
      let removed;
      try {
        removed = removeCredentials(profileDir);
      } catch (error) {
        const reason = '清除凭据失败：' + errText(error);
        safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
        return { ok: false, error: reason };
      }
      if (!removed || removed.ok !== true) {
        const reason = '清除凭据失败（未知原因）';
        safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
        return { ok: false, error: reason };
      }
      cancelActive();
      setPhase({ kind: 'idle' });
      safeLog(logger, 'info', '[qqbot-buddy] 已从 patch 清除凭据（changed=' + removed.changed + '）');

      if (onUnbind !== null) {
        try {
          await Promise.resolve(onUnbind());
        } catch (error) {
          safeLog(logger, 'warn', '[qqbot-buddy] 解绑回调失败（凭据已清除）: ' + errText(error));
        }
      }

      if (disposed) return { ok: true, message: '已解绑' };
      // 解绑后重新进入扫码流程（starting → waiting）
      start();
      return {
        ok: true,
        message: removed.changed
          ? '已解绑，正在重新生成绑定二维码'
          : '已解绑（本无已保存凭据），正在重新生成绑定二维码',
      };
    } catch (error) {
      const reason = '解绑失败：' + errText(error);
      safeLog(logger, 'error', '[qqbot-buddy] ' + reason);
      return { ok: false, error: reason };
    }
  }

  /**
   * 状态投影（路由层直接透出）。
   * phase: idle | starting | waiting | saving | failed | bound
   * idle 表示「绑定流程从未启动」（如 bindOnMissingCredentials=false 或已绑定后释放），
   * UI 据此展示手动填写表单 / 等待，而不是一直显示 "正在启动"。
   * 任何相位都不包含 appSecret（bound 仅回显非机密的 appId）。
   * @returns {{phase: string, appId?: string, url?: string, qrSvg?: string, reason?: string, issuedAt?: number}}
   */
  function wireState() {
    switch (phase.kind) {
      case 'bound':
        return { phase: 'bound', appId: phase.appId };
      case 'waiting': {
        const state = { phase: 'waiting', url: phase.url, issuedAt: phase.issuedAt };
        if (typeof phase.qrSvg === 'string' && phase.qrSvg !== '') state.qrSvg = phase.qrSvg;
        return state;
      }
      case 'saving':
        return { phase: 'saving' };
      case 'failed':
        return { phase: 'failed', reason: phase.reason };
      case 'starting':
        return { phase: 'starting' };
      case 'idle':
      default:
        return { phase: 'idle' };
    }
  }

  /** 是否处于已绑定态。 */
  function isBound() {
    return !disposed && phase.kind === 'bound';
  }

  /** 终止一切轮询（插件卸载 / HMR）；幂等。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      cancelActive();
    } catch (error) {
      safeLog(logger, 'warn', '[qqbot-buddy] 释放绑定服务失败: ' + errText(error));
    }
    setPhase({ kind: 'idle' });
  }

  return {
    start,
    refresh,
    manual,
    unbind,
    wireState,
    isBound,
    dispose,
  };
}

export default { createBindingService };
