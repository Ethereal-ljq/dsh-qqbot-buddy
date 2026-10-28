/**
 * test/helpers/fake-ctx.js —— 最小 Cordis ctx 模拟，供单测与集成测试复用。
 *
 * 只实现本插件实际用到的能力，避免为了测试引入 cordis 运行时依赖：
 * - ctx.get(name) / ctx.set(name, value) / ctx.provide(name, value)：服务容器；
 * - ctx.on(event, fn) / ctx.emit(event, ...args)：事件总线；
 * - ctx.effect(fn, label)：与 Cordis 一致——回调立即执行，返回值作为 disposer，
 *   ctx.dispose() 时逆序执行（用于断言插件是否正确释放定时器/监听）；
 * - ctx.logger：记录 info/warn/error/debug 调用，方便断言"错误被吞掉只记日志"；
 * - ctx.webServer.register(def)：记录 HTTP 路由注册，可断言路由/清理；
 * - ctx.tools.register(def)：记录工具注册，可断言工具名/参数 schema。
 *
 * 该文件不是测试文件（文件名不匹配 *.test.js），不会被 node --test 直接执行。
 */

/** 创建记录型 logger；child() 共享同一 entries，便于断言整棵日志。 */
export function createFakeLogger(entries = []) {
  const make = (level) => (...args) => {
    entries.push({ level, args, at: Date.now() });
  };
  const logger = {
    entries,
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    /** 派生 logger：仍写入同一个 entries，便于断言。 */
    child: () => createFakeLogger(entries),
    /** 按级别取日志参数列表，测试里少写过滤代码。 */
    byLevel(level) {
      return entries.filter((entry) => entry.level === level).map((entry) => entry.args);
    },
  };
  return logger;
}

/** 构造一个可用的 fake req/res 对（handler 由 ctx.webServer.register 注册时使用）。 */
export function createFakeReqRes({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const responseChunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    finished: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    writeHead(code, extraHeaders) {
      this.statusCode = code;
      if (extraHeaders) {
        for (const [name, value] of Object.entries(extraHeaders)) this.setHeader(name, value);
      }
      return this;
    },
    write(chunk) {
      responseChunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) responseChunks.push(String(chunk));
      this.finished = true;
      return this;
    },
    /** 聚合后的响应体文本。 */
    get text() {
      return responseChunks.join('');
    },
  };
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    body,
    /** 供直接 await 的 handler 读取 JSON body 时使用。 */
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, 'utf8');
    },
  };
  return { req, res };
}

/**
 * @param {object} [options]
 * @param {Record<string, unknown>|Map<string, unknown>} [options.services] 预置服务（如 settings/llm）
 * @param {object} [options.logger] createFakeLogger() 产物；默认新建
 */
export function createFakeCtx({ services, logger } = {}) {
  const log = logger ?? createFakeLogger();
  const registry = new Map(
    services instanceof Map ? services : Object.entries(services ?? {}),
  );
  if (!registry.has('logger')) registry.set('logger', log);
  const eventListeners = new Map();
  const disposers = [];
  const routes = [];
  const toolDefs = [];
  const state = { disposed: false };

  const removeRoute = (def) => {
    const index = routes.indexOf(def);
    if (index >= 0) routes.splice(index, 1);
  };
  const removeTool = (def) => {
    const index = toolDefs.indexOf(def);
    if (index >= 0) toolDefs.splice(index, 1);
  };

  const ctx = {
    logger: log,
    /** 兼容 Cordis 的 ctx.get(serviceName)。 */
    get(name) {
      return registry.get(name);
    },
    /** 兼容 Cordis 的 ctx.set(serviceName, value)。 */
    set(name, value) {
      registry.set(name, value);
    },
    /** 注册服务并返回撤销函数。 */
    provide(name, value) {
      const had = registry.has(name);
      const previous = registry.get(name);
      registry.set(name, value);
      return () => {
        if (had) registry.set(name, previous);
        else registry.delete(name);
      };
    },
    /** 订阅事件；返回退订函数。 */
    on(event, listener) {
      if (typeof listener !== 'function') return () => {};
      const key = String(event);
      if (!eventListeners.has(key)) eventListeners.set(key, new Set());
      eventListeners.get(key).add(listener);
      return () => {
        eventListeners.get(key)?.delete(listener);
      };
    },
    /** 触发事件；单个监听抛错不影响其他监听（与 Cordis 事件隔离语义一致）。 */
    emit(event, ...args) {
      const set = eventListeners.get(String(event));
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(...args);
        } catch (error) {
          log.error('fake-ctx: 事件监听异常', String(error && error.message));
        }
      }
    },
    /** 与 Cordis 一致：立即执行回调，把返回的 disposer 收集起来。 */
    effect(callback, label = '') {
      try {
        const dispose = callback();
        if (typeof dispose === 'function') disposers.push({ label, dispose });
      } catch (error) {
        // Cordis effect 抛错会打挂插件树；测试里记录后抛给调用方，避免静默通过。
        throw error;
      }
    },
    /** 逆序释放所有 effect，模拟 ctx 销毁。 */
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      for (const { dispose } of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          log.error('fake-ctx: disposer 异常', String(error && error.message));
        }
      }
      disposers.length = 0;
      for (const listeners of eventListeners.values()) listeners.clear();
    },
    get disposed() {
      return state.disposed;
    },
    webServer: {
      /** 记录路由注册；返回撤销函数。 */
      register(def) {
        const normalized = { kind: def?.kind, path: def?.path, handler: def?.handler };
        routes.push(normalized);
        return () => removeRoute(normalized);
      },
      /** 已注册路由快照（测试断言用）。 */
      get routes() {
        return [...routes];
      },
    },
    tools: {
      /** 记录工具注册；返回撤销函数。 */
      register(def) {
        const normalized = { name: def?.name, description: def?.description, parameters: def?.parameters, execute: def?.execute };
        toolDefs.push(normalized);
        return () => removeTool(normalized);
      },
      /** 已注册工具快照（测试断言用）。 */
      get registered() {
        return [...toolDefs];
      },
    },
  };
  return ctx;
}

export default createFakeCtx;
