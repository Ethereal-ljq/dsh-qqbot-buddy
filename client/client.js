window.__ModuleLoader__.load({
  id: "dsh-qqbot-buddy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const h = react.createElement;

    // ── 常量 ──────────────────────────────────────────────────
    /** 管理 API 前缀（与 lib/web/routes.js 保持一致） */
    const API = "/qqbot-buddy/api";
    /** 样式注入标记：重复加载时先移除再注入，保证样式总是当前版本 */
    const STYLE_ID = "qqbot-buddy-settings-style";
    // 第四批重构：8 个 tab（频率+触发合并为“回复与触发”，Agent+模型合并为“Agent 与模型”）
    const TABS = [
      { id: "overview", label: "概览" },
      { id: "reply", label: "回复与触发" },
      { id: "agent", label: "Agent 与模型" },
      { id: "persona", label: "人设" },
      { id: "phrases", label: "口头禅" },
      { id: "stickers", label: "表情包" },
      { id: "memory", label: "记忆与自我改进" },
      { id: "commands", label: "命令与权限" },
    ];
    /** 功能开关（顺序与 DESIGN settings.features 一致）。 */
    const FEATURE_ITEMS = [
      { key: "workspace", label: "工作区访问", help: "fs 读写/编辑 + glob/grep 工具" },
      { key: "web", label: "联网搜索", help: "web_search / web_fetch 抓取网页" },
      { key: "stickers", label: "表情包", help: "qqbot_send_file 发送图片/文件" },
      { key: "vision", label: "看图", help: "qqbot_describe_image 理解图片内容" },
      { key: "memory", label: "长期记忆", help: "memory_save/search/read/list 记忆工具" },
    ];
    /** reasoningEffort 下拉选项（空 = 跟随模型 / 宿主默认）。 */
    const EFFORT_OPTIONS = [
      { id: "", name: "跟随默认" },
      { id: "low", name: "low" },
      { id: "medium", name: "medium" },
      { id: "high", name: "high" },
      { id: "max", name: "max" },
    ];

    // ── 基础工具 ──────────────────────────────────────────────
    function msgOf(error) {
      if (error && typeof error.message === "string" && error.message) return error.message;
      return String(error);
    }

    function clone(value) {
      if (value === undefined) return undefined;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (error) {
        return value;
      }
    }

    function sameJSON(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
      if (bytes < 1024) return bytes + " B";
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
      return (bytes / 1024 / 1024).toFixed(2) + " MB";
    }

    function formatTime(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
      try {
        return new Date(ms).toLocaleString("zh-CN", { hour12: false });
      } catch (error) {
        return new Date(ms).toISOString();
      }
    }

    /** 兼容 epoch 毫秒与 ISO 字符串的时间展示。 */
    function formatTimestamp(value) {
      if (typeof value === "number" && Number.isFinite(value)) return formatTime(value);
      if (typeof value === "string" && value.trim() !== "") {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? formatTime(ms) : value;
      }
      return "—";
    }

    function formatDuration(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
      const totalSeconds = Math.floor(ms / 1000);
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (days > 0) return days + " 天 " + hours + " 小时";
      if (hours > 0) return hours + " 小时 " + minutes + " 分钟";
      if (minutes > 0) return minutes + " 分钟 " + seconds + " 秒";
      return seconds + " 秒";
    }

    function parseKeywords(text) {
      const seen = new Set();
      const out = [];
      for (const part of String(text || "").split(/[,，、\n\r]+/)) {
        let word = part.trim();
        if (word === "") continue;
        if (word.length > 40) word = word.slice(0, 40);
        if (seen.has(word)) continue;
        seen.add(word);
        out.push(word);
        if (out.length >= 50) break;
      }
      return out;
    }

    function parseTags(text) {
      const seen = new Set();
      const out = [];
      for (const part of String(text || "").split(/[,，、\n\r]+/)) {
        let tag = part.trim();
        if (tag === "") continue;
        if (tag.length > 30) tag = tag.slice(0, 30);
        if (seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
        if (out.length >= 20) break;
      }
      return out;
    }

    // ── 同源 fetch 封装（错误统一转成 Error，方便 UI 展示） ──
    async function requestJson(method, url, payload) {
      const init = { method: method, cache: "no-store" };
      if (payload !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(payload);
      }
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        throw new Error("无法连接管理接口（插件是否已加载？）：" + msgOf(error));
      }
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok || (body && body.ok === false)) {
        const reason =
          body && typeof body.error === "string" && body.error
            ? body.error
            : "请求失败（HTTP " + response.status + "）";
        throw new Error(reason);
      }
      return body === null ? { ok: true } : body;
    }

    function apiGet(url) {
      return requestJson("GET", url);
    }

    function apiPost(url, payload) {
      return requestJson("POST", url, payload === undefined ? {} : payload);
    }

    /**
     * 读取原始响应：绑定接口需要区分 404（bind-routes 未加载）与业务错误，
     * 因此不能直接用 requestJson（它会把非 2xx 变成 Error）。
     */
    async function requestRaw(url, options) {
      let response;
      try {
        response = await fetch(url, options || { cache: "no-store" });
      } catch (error) {
        throw new Error("无法连接绑定接口（插件是否已加载？）：" + msgOf(error));
      }
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      return { status: response.status, ok: response.ok, body: body };
    }

    /** 把 {provider, model, reasoningEffort} 渲染成一行可读文本。 */
    function modelText(selection) {
      if (!selection) return "跟随宿主默认";
      const provider = typeof selection.provider === "string" ? selection.provider : "";
      const model = typeof selection.model === "string" ? selection.model : "";
      const effort = typeof selection.reasoningEffort === "string" ? selection.reasoningEffort : "";
      if (provider === "" && model === "") return "跟随宿主默认";
      const base = provider !== "" ? provider + " / " + (model === "" ? "?" : model) : model;
      return effort !== "" ? base + "（reasoning: " + effort + "）" : base;
    }

    const MODEL_SOURCE_LABELS = { settings: "设置页", config: "插件配置", host: "宿主默认" };
    function modelSourceLabel(source) {
      return MODEL_SOURCE_LABELS[source] || "宿主默认";
    }

    // ── 样式（只注入一次；类名前缀 qqb-，主题变量带兜底） ────
    const STYLE_TEXT = [
      ".qqb-root { display: flex; flex-direction: column; gap: 14px; width: 100%; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary, #1f2328); }",
      ".qqb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }",
      ".qqb-head-main { display: flex; flex-direction: column; gap: 2px; }",
      ".qqb-title { margin: 0; font-size: 16px; font-weight: 600; }",
      ".qqb-sub { margin: 0; font-size: 12px; opacity: 0.7; }",
      ".qqb-head-status { display: flex; align-items: center; gap: 8px; }",
      ".qqb-badge { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; border: 1px solid transparent; }",
      ".qqb-badge--ok { color: var(--dsw-alias-success, #1a7f37); background: rgba(26, 127, 55, 0.12); border-color: rgba(26, 127, 55, 0.3); }",
      ".qqb-badge--warn { color: var(--dsw-alias-warning, #9a6700); background: rgba(154, 103, 0, 0.12); border-color: rgba(154, 103, 0, 0.3); }",
      ".qqb-badge--off { opacity: 0.65; border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35)); }",
      ".qqb-tabs { display: flex; gap: 6px; flex-wrap: wrap; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22)); }",
      ".qqb-tab { font: inherit; font-size: 13px; padding: 5px 14px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; opacity: 0.75; }",
      ".qqb-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); opacity: 1; }",
      ".qqb-tab--active { background: var(--dsw-alias-brand, #4d6bfe); color: #fff; opacity: 1; }",
      ".qqb-page { display: flex; flex-direction: column; gap: 14px; }",
      ".qqb-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22)); background: var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.04)); }",
      ".qqb-card-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }",
      ".qqb-card-title { margin: 0; font-size: 14px; font-weight: 600; }",
      ".qqb-card-hint { font-size: 12px; opacity: 0.6; }",
      ".qqb-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }",
      ".qqb-field-label { font-size: 13px; font-weight: 500; }",
      ".qqb-help { margin: 0; font-size: 12px; line-height: 1.5; opacity: 0.65; }",
      ".qqb-row { display: flex; align-items: center; gap: 12px; justify-content: space-between; flex-wrap: wrap; }",
      ".qqb-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }",
      ".qqb-input, .qqb-area, .qqb-select { box-sizing: border-box; width: 100%; padding: 7px 9px; border-radius: 8px; font: inherit; font-size: 13px; color: inherit; outline: none; border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35)); background: var(--dsw-alias-bg-input, rgba(128, 128, 128, 0.08)); }",
      ".qqb-input:focus, .qqb-area:focus, .qqb-select:focus { border-color: var(--dsw-alias-brand, #4d6bfe); }",
      ".qqb-input--num { width: 130px; }",
      ".qqb-area { min-height: 110px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.6; }",
      ".qqb-area--tall { min-height: 360px; }",
      ".qqb-btn { font: inherit; font-size: 13px; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit; border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4)); background: transparent; transition: background-color 0.15s ease, opacity 0.15s ease; }",
      ".qqb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }",
      ".qqb-btn:disabled { opacity: 0.45; cursor: default; }",
      ".qqb-btn--primary { background: var(--dsw-alias-brand, #4d6bfe); border-color: transparent; color: #fff; font-weight: 500; }",
      ".qqb-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-brand-strong, #3b5cf0); }",
      ".qqb-btn--danger { color: var(--dsw-alias-danger, #d1242f); border-color: rgba(209, 36, 47, 0.35); }",
      ".qqb-btn--danger:hover:not(:disabled) { background: rgba(209, 36, 47, 0.1); }",
      ".qqb-btn--sm { padding: 4px 10px; font-size: 12px; }",
      ".qqb-switch { position: relative; flex: none; width: 38px; height: 21px; padding: 0; border: none; border-radius: 999px; cursor: pointer; background: rgba(128, 128, 128, 0.35); transition: background-color 0.15s ease; }",
      ".qqb-switch[aria-checked='true'] { background: var(--dsw-alias-brand, #4d6bfe); }",
      ".qqb-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px; border-radius: 50%; background: #fff; transition: transform 0.15s ease; }",
      ".qqb-switch[aria-checked='true']::after { transform: translateX(17px); }",
      ".qqb-switch:disabled { opacity: 0.45; cursor: default; }",
      ".qqb-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35)); border-radius: 999px; overflow: hidden; }",
      ".qqb-seg-btn { font: inherit; font-size: 12px; padding: 5px 14px; border: none; background: transparent; color: inherit; cursor: pointer; opacity: 0.75; }",
      ".qqb-seg-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); opacity: 1; }",
      ".qqb-seg-btn--active { background: var(--dsw-alias-brand, #4d6bfe); color: #fff; opacity: 1; }",
      ".qqb-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }",
      ".qqb-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 10px; }",
      ".qqb-stat { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.22)); }",
      ".qqb-stat-num { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }",
      ".qqb-stat-label { font-size: 12px; opacity: 0.65; }",
      ".qqb-kv { display: flex; flex-direction: column; gap: 4px; min-width: 0; }",
      ".qqb-kv-row { display: flex; gap: 12px; align-items: baseline; font-size: 12.5px; min-width: 0; }",
      ".qqb-kv-label { flex: none; width: 92px; opacity: 0.6; }",
      ".qqb-kv-value { min-width: 0; word-break: break-all; }",
      ".qqb-kv-value--err { color: var(--dsw-alias-danger, #d1242f); }",
      ".qqb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }",
      ".qqb-summary { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: 13px; background: rgba(77, 107, 254, 0.08); border: 1px solid rgba(77, 107, 254, 0.22); }",
      ".qqb-list { display: flex; flex-direction: column; }",
      ".qqb-list-item { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 7px 0; border-bottom: 0.5px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28)); }",
      ".qqb-list-item:last-child { border-bottom: none; }",
      ".qqb-list-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }",
      ".qqb-list-meta { font-size: 12px; opacity: 0.6; }",
      ".qqb-file { font: inherit; font-size: 13px; padding: 3px 0; border: none; background: transparent; color: inherit; cursor: pointer; text-align: left; opacity: 0.85; }",
      ".qqb-file:hover { text-decoration: underline; opacity: 1; }",
      ".qqb-file--active { color: var(--dsw-alias-brand, #4d6bfe); font-weight: 600; opacity: 1; }",
      ".qqb-pre { margin: 0; padding: 10px 12px; border-radius: 8px; max-height: 280px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; background: rgba(128, 128, 128, 0.08); }",
      ".qqb-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
      ".qqb-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 4px; }",
      ".qqb-footer-note { display: flex; flex-direction: column; gap: 2px; min-height: 18px; }",
      ".qqb-note { margin: 0; font-size: 12px; opacity: 0.8; }",
      ".qqb-note--ok { color: var(--dsw-alias-success, #1a7f37); opacity: 1; }",
      ".qqb-note--err { color: var(--dsw-alias-danger, #d1242f); opacity: 1; }",
      ".qqb-dirty { color: var(--dsw-alias-warning, #9a6700); opacity: 1; }",
      ".qqb-loading, .qqb-empty { margin: 0; padding: 12px 0; font-size: 12.5px; opacity: 0.65; }",
      ".qqb-error-block { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }",
      ".qqb-tag { display: inline-flex; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; background: rgba(128, 128, 128, 0.14); }",
      ".qqb-bind { display: flex; flex-direction: column; gap: 10px; }",
      ".qqb-qr { display: block; width: 220px; max-width: 100%; border-radius: 10px; background: #fff; padding: 10px; box-sizing: border-box; }",
      ".qqb-note--warn { color: var(--dsw-alias-warning, #9a6700); opacity: 1; }",
      ".qqb-select { width: 100%; max-width: 360px; }",
      ".qqb-sticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }",
      ".qqb-sticker-card { font: inherit; font-size: 13px; color: inherit; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25)); background: transparent; }",
      ".qqb-sticker-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }",
      ".qqb-sticker-card--active { border-color: var(--dsw-alias-brand, #4d6bfe); }",
      ".qqb-sticker-thumb { display: block; width: 100%; height: 110px; object-fit: contain; border-radius: 8px; background: rgba(128, 128, 128, 0.1); }",
      ".qqb-sticker-thumb--empty { display: flex; align-items: center; justify-content: center; font-size: 28px; opacity: 0.55; }",
      ".qqb-sticker-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }",
      ".qqb-sticker-source { font-size: 11px; opacity: 0.6; }",
      "@media (max-width: 640px) { .qqb-tabs { gap: 4px; } .qqb-tab { padding: 4px 10px; font-size: 12px; } .qqb-grid-2 { grid-template-columns: 1fr; } .qqb-select { max-width: none; } }",
      "@media (prefers-color-scheme: dark) { .qqb-root { color: #e6e6e6; } .qqb-card { background: rgba(255, 255, 255, 0.03); } .qqb-pre { background: rgba(255, 255, 255, 0.06); } .qqb-input, .qqb-area, .qqb-select { background: rgba(255, 255, 255, 0.06); } }",
    ].join("\n");

    function ensureStyles() {
      if (typeof document === "undefined") return function () {};
      // 重复加载先去重：移除旧样式节点，随后重新注入当前版本
      const existing = document.getElementById(STYLE_ID);
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style);
      };
    }

    function useStyles() {
      react.useEffect(function () {
        return ensureStyles();
      }, []);
    }

    // ── hooks ─────────────────────────────────────────────────
    /** 草稿状态：外部值变化（保存后 reload）时同步，不影响正在编辑的脏数据。 */
    function useDraft(value) {
      const [draft, setDraft] = react.useState(function () {
        return clone(value);
      });
      const lastJSON = react.useRef(JSON.stringify(value));
      react.useEffect(function () {
        const currentJSON = JSON.stringify(value);
        if (currentJSON !== lastJSON.current) {
          lastJSON.current = currentJSON;
          setDraft(clone(value));
        }
      }, [value]);
      return [draft, setDraft];
    }

    /**
     * 保存动作封装：统一维护 saving / saved / error 状态。
     * task 内的异常会被捕获，绝不让 Promise 变成 unhandled rejection。
     */
    function useSaver(reload) {
      const [status, setStatus] = react.useState({ state: "idle", message: "" });
      const run = react.useCallback(
        async function (task, successMessage) {
          setStatus({ state: "saving", message: "正在保存…" });
          try {
            await task();
            if (typeof reload === "function") {
              try {
                await reload();
              } catch (error) {
                /* reload 自己会记录错误，这里只兜底 */
              }
            }
            setStatus({ state: "saved", message: successMessage || "已保存" });
          } catch (error) {
            setStatus({ state: "error", message: msgOf(error) });
          }
        },
        [reload],
      );
      return [status, run];
    }

    /** 概览页 5 秒轮询；页面不可见时暂停，卸载时清理定时器。 */
    function usePolling(reload, intervalMs) {
      react.useEffect(
        function () {
          const timer = setInterval(function () {
            if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
            if (typeof reload === "function") void reload();
          }, intervalMs);
          return function () {
            clearInterval(timer);
          };
        },
        [reload, intervalMs],
      );
    }

    // ── 通用小组件 ────────────────────────────────────────────
    function Card(props) {
      return h(
        "section",
        { className: "qqb-card" },
        props.title || props.hint
          ? h(
              "div",
              { className: "qqb-card-head" },
              props.title ? h("h3", { className: "qqb-card-title" }, props.title) : null,
              props.hint ? h("span", { className: "qqb-card-hint" }, props.hint) : null,
            )
          : null,
        props.children,
      );
    }

    function LoadingBlock(props) {
      return h("p", { className: "qqb-loading" }, (props && props.text) || "正在加载…");
    }

    function ErrorBlock(props) {
      return h(
        "div",
        { className: "qqb-error-block" },
        h("p", { className: "qqb-note qqb-note--err" }, "⚠️ " + props.text),
        props.onRetry
          ? h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--sm",
                onClick: function () {
                  void props.onRetry();
                },
              },
              "重试",
            )
          : null,
      );
    }

    function StatusLine(props) {
      const status = props.status;
      if (status && status.state === "saving") return h("p", { className: "qqb-note" }, "正在保存…");
      if (status && status.state === "error") return h("p", { className: "qqb-note qqb-note--err" }, "⚠️ " + status.message);
      if (props.dirty) return h("p", { className: "qqb-note qqb-dirty" }, props.dirtyText || "有未保存的修改");
      if (status && status.state === "saved") return h("p", { className: "qqb-note qqb-note--ok" }, "✓ " + status.message);
      return null;
    }

    function SaveBar(props) {
      const busy = props.status && props.status.state === "saving";
      return h(
        "div",
        { className: "qqb-footer" },
        h("div", { className: "qqb-footer-note" }, h(StatusLine, { status: props.status, dirty: props.dirty, dirtyText: props.note })),
        h(
          "button",
          {
            type: "button",
            className: "qqb-btn qqb-btn--primary",
            disabled: props.disabled === true || busy || !props.dirty,
            onClick: function () {
              void props.onSave();
            },
          },
          busy ? "正在保存…" : props.label || "保存",
        ),
      );
    }

    function Switch(props) {
      return h(
        "div",
        { className: "qqb-field" },
        h(
          "div",
          { className: "qqb-row" },
          h(
            "div",
            { className: "qqb-row-main" },
            h("span", { className: "qqb-field-label" }, props.label),
            props.help ? h("p", { className: "qqb-help" }, props.help) : null,
          ),
          h(
            "button",
            {
              type: "button",
              className: "qqb-switch",
              role: "switch",
              "aria-checked": props.checked ? "true" : "false",
              disabled: props.disabled === true,
              onClick: function () {
                if (props.disabled === true) return;
                props.onChange(!props.checked);
              },
            },
            null,
          ),
        ),
      );
    }

    function TextField(props) {
      return h(
        "div",
        { className: "qqb-field" },
        h("label", { className: "qqb-field-label" }, props.label),
        h("input", {
          type: props.type || "text",
          className: "qqb-input" + (props.mono ? " qqb-mono" : ""),
          value: props.value === undefined || props.value === null ? "" : String(props.value),
          placeholder: props.placeholder || "",
          spellCheck: false,
          onChange: function (event) {
            props.onChange(event.currentTarget.value);
          },
        }),
        props.help ? h("p", { className: "qqb-help" }, props.help) : null,
      );
    }

    function AreaField(props) {
      const style = props.rows ? { minHeight: props.rows * 24 + 20 } : undefined;
      return h(
        "div",
        { className: "qqb-field" },
        h("span", { className: "qqb-field-label" }, props.label),
        h("textarea", {
          className: "qqb-area",
          style: style,
          value: props.value === undefined || props.value === null ? "" : String(props.value),
          placeholder: props.placeholder || "",
          spellCheck: false,
          onChange: function (event) {
            props.onChange(event.currentTarget.value);
          },
        }),
        props.help ? h("p", { className: "qqb-help" }, props.help) : null,
      );
    }

    function NumberField(props) {
      const [text, setText] = react.useState(function () {
        return props.value === undefined || props.value === null ? "" : String(props.value);
      });
      react.useEffect(
        function () {
          setText(props.value === undefined || props.value === null ? "" : String(props.value));
        },
        [props.value],
      );
      function clampNumber(n) {
        let value = n;
        if (typeof props.min === "number") value = Math.max(props.min, value);
        if (typeof props.max === "number") value = Math.min(props.max, value);
        return value;
      }
      function commit() {
        const n = Number(text);
        if (text.trim() === "" || !Number.isFinite(n)) {
          setText(props.value === undefined || props.value === null ? "" : String(props.value));
          return;
        }
        const value = clampNumber(n);
        setText(String(value));
        if (value !== props.value) props.onChange(value);
      }
      return h(
        "div",
        { className: "qqb-field" },
        h("label", { className: "qqb-field-label" }, props.label),
        h("input", {
          type: "number",
          className: "qqb-input qqb-input--num",
          value: text,
          min: props.min,
          max: props.max,
          step: props.step,
          onChange: function (event) {
            const next = event.currentTarget.value;
            setText(next);
            const n = Number(next);
            if (next.trim() !== "" && Number.isFinite(n)) {
              const value = clampNumber(n);
              if (value !== props.value) props.onChange(value);
            }
          },
          onBlur: commit,
          onKeyDown: function (event) {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          },
        }),
        props.help ? h("p", { className: "qqb-help" }, props.help) : null,
      );
    }

    function ChoiceGroup(props) {
      return h(
        "div",
        { className: "qqb-field" },
        props.label ? h("span", { className: "qqb-field-label" }, props.label) : null,
        h(
          "div",
          { className: "qqb-seg", role: "radiogroup" },
          props.options.map(function (option) {
            const active = props.value === option.value;
            return h(
              "button",
              {
                key: option.value,
                type: "button",
                role: "radio",
                "aria-checked": active ? "true" : "false",
                className: "qqb-seg-btn" + (active ? " qqb-seg-btn--active" : ""),
                onClick: function () {
                  if (!active) props.onChange(option.value);
                },
              },
              option.label,
            );
          }),
        ),
        props.help ? h("p", { className: "qqb-help" }, props.help) : null,
      );
    }

    function SelectField(props) {
      return h(
        "div",
        { className: "qqb-field" },
        h("label", { className: "qqb-field-label" }, props.label),
        h(
          "select",
          {
            className: "qqb-select",
            value: props.value,
            disabled: props.disabled === true,
            onChange: function (event) {
              props.onChange(event.currentTarget.value);
            },
          },
          (props.options || []).map(function (option) {
            return h("option", { key: option.id, value: option.id }, option.name);
          }),
        ),
        props.help ? h("p", { className: "qqb-help" }, props.help) : null,
      );
    }

    /** 已开启功能的中文列表（概览摘要用）。 */
    function enabledFeatureLabels(features) {
      const labels = [];
      for (const item of FEATURE_ITEMS) {
        if (!features || features[item.key] !== false) labels.push(item.label);
      }
      return labels.length > 0 ? labels.join("、") : "无";
    }

    function kvRow(label, value, isError) {
      return h(
        "div",
        { className: "qqb-kv-row", key: label },
        h("span", { className: "qqb-kv-label" }, label),
        h("span", { className: "qqb-kv-value" + (isError ? " qqb-kv-value--err" : "") }, value === undefined || value === null || value === "" ? "—" : String(value)),
      );
    }

    function statItem(label, value) {
      return h(
        "div",
        { className: "qqb-stat", key: label },
        h("span", { className: "qqb-stat-num" }, String(value === undefined || value === null ? 0 : value)),
        h("span", { className: "qqb-stat-label" }, label),
      );
    }

    // ── 连接与绑定卡片（概览页内：扫码 / 手动填写凭据） ──────
    function BindingCard(props) {
      const [bind, setBind] = react.useState(null);
      const [phaseError, setPhaseError] = react.useState("");
      const [missing, setMissing] = react.useState(false);
      const [status, setStatus] = react.useState({ state: "idle", message: "" });
      const [busy, setBusy] = react.useState(false);
      const [manualOpen, setManualOpen] = react.useState(false);
      const [appIdInput, setAppIdInput] = react.useState("");
      const [appSecretInput, setAppSecretInput] = react.useState("");
      const bindRef = react.useRef(null);
      const reloadRef = react.useRef(props.reload);
      reloadRef.current = props.reload;

      const load = react.useCallback(async function () {
        try {
          const result = await requestRaw(API + "/bind/state");
          if (result.status === 404) {
            // bind-routes.js 未加载：降级为手动填写表单
            bindRef.current = null;
            setMissing(true);
            setBind(null);
            setPhaseError("");
            return;
          }
          if (!result.ok || !result.body || result.body.ok === false) {
            const reason =
              result.body && typeof result.body.error === "string" && result.body.error
                ? result.body.error
                : "读取绑定状态失败（HTTP " + result.status + "）";
            throw new Error(reason);
          }
          const previous = bindRef.current;
          bindRef.current = result.body;
          setBind(result.body);
          setMissing(false);
          setPhaseError("");
          // 绑定成功：刷新 /api/state（appId / ready 展示）并提示已写入 profile
          if (result.body.phase === "bound" && (!previous || previous.phase !== "bound")) {
            setStatus({ state: "saved", message: "绑定成功，凭据已写入 profile（重启 DSH 后仍有效）" });
            if (typeof reloadRef.current === "function") void reloadRef.current();
          }
        } catch (error) {
          setPhaseError(msgOf(error));
        }
      }, []);

      react.useEffect(function () {
        void load();
        // waiting / starting / saving 阶段每 2s 轮询；页面不可见时暂停，卸载时清理定时器
        const timer = setInterval(function () {
          if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
          const current = bindRef.current;
          const phase = current && typeof current.phase === "string" ? current.phase : "";
          if (phase === "waiting" || phase === "starting" || phase === "saving") void load();
        }, 2000);
        return function () {
          clearInterval(timer);
        };
      }, [load]);

      async function runAction(task, successMessage) {
        if (busy) return;
        setBusy(true);
        setStatus({ state: "saving", message: "正在处理…" });
        try {
          await task();
          setStatus({ state: "saved", message: successMessage || "操作成功" });
          await load();
          if (typeof reloadRef.current === "function") void reloadRef.current();
        } catch (error) {
          setStatus({ state: "error", message: msgOf(error) });
        } finally {
          setBusy(false);
        }
      }

      function refreshQr() {
        void runAction(async function () {
          await apiPost(API + "/bind/refresh", {});
        }, "已刷新绑定二维码");
      }

      function submitManual() {
        const appId = appIdInput.trim();
        const appSecret = appSecretInput.trim();
        if (appId === "" || appSecret === "") {
          setStatus({ state: "error", message: "AppID 与 AppSecret 均为必填" });
          return;
        }
        void runAction(async function () {
          await apiPost(API + "/bind/manual", { appId: appId, appSecret: appSecret });
          setAppSecretInput("");
          setManualOpen(false);
        }, "凭据已保存，绑定流程已启动");
      }

      function doUnbind() {
        if (typeof window !== "undefined" && !window.confirm("确定解绑当前 QQ 机器人吗？解绑后会立即下线并重新生成绑定二维码。")) return;
        void runAction(async function () {
          await apiPost(API + "/bind/unbind", {});
        }, "已解绑，正在生成新的绑定二维码");
      }

      const phase = bind && typeof bind.phase === "string" ? bind.phase : "";
      const waiting = phase === "waiting";
      const starting = phase === "starting";
      const saving = phase === "saving";
      const failed = phase === "failed";
      const bound = phase === "bound";
      const showManualForm = missing || manualOpen || phase === "" || phase === "idle" || failed;

      const manualForm = h(
        "div",
        { className: "qqb-field" },
        h(
          "div",
          { className: "qqb-grid-2" },
          h(TextField, {
            label: "AppID",
            value: appIdInput,
            placeholder: "QQ 机器人 AppID",
            onChange: setAppIdInput,
          }),
          h(TextField, {
            label: "AppSecret",
            value: appSecretInput,
            type: "password",
            placeholder: "QQ 机器人 AppSecret",
            onChange: setAppSecretInput,
          }),
        ),
        h(
          "div",
          { className: "qqb-toolbar" },
          h(
            "button",
            { type: "button", className: "qqb-btn qqb-btn--primary", disabled: busy, onClick: submitManual },
            busy ? "正在保存…" : "保存并绑定",
          ),
          h("span", { className: "qqb-help" }, "凭据写入 profile 的 cordis.patch.yml（原子写 + 0600），重启后仍有效"),
        ),
      );

      let body = null;
      if (bound) {
        body = h(
          "div",
          { className: "qqb-bind" },
          h("div", { className: "qqb-kv" }, kvRow("AppID", bind.appId || "—"), kvRow("状态", "已绑定")),
          h("p", { className: "qqb-help" }, "凭据已写入 profile（cordis.patch.yml），重启 DSH 后仍然有效。"),
          h(
            "div",
            { className: "qqb-toolbar" },
            h("button", { type: "button", className: "qqb-btn qqb-btn--danger", disabled: busy, onClick: doUnbind }, "解绑"),
            h(
              "button",
              { type: "button", className: "qqb-btn", disabled: busy, onClick: function () { setManualOpen(!manualOpen); } },
              manualOpen ? "收起手动填写" : "手动重新绑定",
            ),
          ),
        );
      } else if (waiting) {
        body = h(
          "div",
          { className: "qqb-bind" },
          bind.qrSvg ? h("img", { className: "qqb-qr", src: bind.qrSvg, alt: "QQ 机器人扫码绑定二维码" }) : null,
          bind.url
            ? h(
                "a",
                { className: "qqb-help", href: bind.url, target: "_blank", rel: "noreferrer noopener" },
                "二维码显示异常？在浏览器中打开绑定链接",
              )
            : null,
          h("p", { className: "qqb-help" }, "使用手机 QQ 扫描二维码完成授权，凭据会自动写入 profile 并热切换机器人。"),
          h(
            "div",
            { className: "qqb-toolbar" },
            h("button", { type: "button", className: "qqb-btn", disabled: busy, onClick: refreshQr }, busy ? "正在刷新…" : "刷新二维码"),
            h("button", { type: "button", className: "qqb-btn qqb-btn--sm", disabled: busy, onClick: function () { setManualOpen(!manualOpen); } }, "手动填写"),
            h("span", { className: "qqb-help" }, "等待扫码中，每 2 秒自动刷新状态"),
          ),
        );
      } else if (starting || saving) {
        body = h(
          "div",
          { className: "qqb-bind" },
          h("p", { className: "qqb-note qqb-note--warn" }, starting ? "正在启动扫码绑定流程…" : "扫码成功，正在保存凭据并热切换机器人…"),
          h(
            "div",
            { className: "qqb-toolbar" },
            h("button", { type: "button", className: "qqb-btn", disabled: busy, onClick: refreshQr }, "刷新二维码"),
          ),
        );
      } else if (failed) {
        body = h(
          "div",
          { className: "qqb-bind" },
          h(
            "p",
            { className: "qqb-note qqb-note--err" },
            "绑定失败：" + (typeof bind.reason === "string" && bind.reason !== "" ? bind.reason : "未知原因"),
          ),
          h(
            "div",
            { className: "qqb-toolbar" },
            h("button", { type: "button", className: "qqb-btn", disabled: busy, onClick: refreshQr }, "重试"),
          ),
        );
      } else if (missing) {
        body = h("p", { className: "qqb-note qqb-note--warn" }, "绑定服务未启用（未加载 lib/web/bind-routes.js），可在下方手动填写凭据。");
      } else if (phase === "idle") {
        // idle 是中性相位：可能已绑定、配置为不自动绑定，或绑定服务未就绪。
        // 文案不告警、不判定服务不可用；只提供可操作入口（刷新二维码 + 下方手动填写表单）。
        body = h(
          "div",
          { className: "qqb-bind" },
          h(
            "p",
            { className: "qqb-help" },
            "扫码绑定未自动启动（可能已绑定、配置为不自动绑定，或绑定服务未就绪）。可以点击「刷新二维码」开始扫码，或在下方手动填写 AppID / AppSecret。",
          ),
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              { type: "button", className: "qqb-btn", disabled: busy, onClick: refreshQr },
              busy ? "正在启动…" : "刷新二维码",
            ),
            h("span", { className: "qqb-help" }, "扫码成功后凭据会自动写入 profile 并热切换机器人"),
          ),
        );
      } else if (bind) {
        body = h("p", { className: "qqb-help" }, "当前绑定阶段：" + phase + "（可在下方手动填写凭据）");
      }

      return h(
        Card,
        { title: "连接与绑定", hint: "扫码或手动填写 QQ 机器人凭据" },
        h(StatusLine, { status: status, dirty: false }),
        phaseError && !bind ? h(ErrorBlock, { text: "读取绑定状态失败：" + phaseError, onRetry: load }) : null,
        phaseError && bind ? h("p", { className: "qqb-note qqb-note--warn" }, "状态刷新失败：" + phaseError) : null,
        body,
        showManualForm ? manualForm : null,
      );
    }

    // ── 概览页 ────────────────────────────────────────────────
    function OverviewPage(props) {
      const reload = props.reload;
      usePolling(reload, 5000);
      const [status, run] = useSaver(reload);

      const snapshot = props.snapshot;
      if (!snapshot) return h(LoadingBlock, { text: "正在读取 QQ 机器人状态…" });

      const bot = snapshot.bot || {};
      const stats = snapshot.stats || {};
      const settings = snapshot.settings || {};
      const reply = settings.reply || {};
      const memorySettings = settings.memory || {};
      const effective = snapshot.effective || {};
      const modelInfo = snapshot.model || {};
      const agentInfo = snapshot.agent || {};
      const featuresInfo = snapshot.features || {};
      const paths = snapshot.paths || {};
      const pending = Array.isArray(bot.pending) ? bot.pending : [];
      const effectivePending = Array.isArray(effective.pending) ? effective.pending : [];

      function patchReply(partial) {
        void run(async function () {
          await apiPost(API + "/settings", { patch: { reply: partial } });
        }, "设置已保存");
      }

      function patchMemory(partial) {
        void run(async function () {
          await apiPost(API + "/settings", { patch: { memory: partial } });
        }, "设置已保存");
      }

      function doAction(action, confirmText) {
        if (confirmText && typeof window !== "undefined" && !window.confirm(confirmText)) return;
        void run(async function () {
          await apiPost(API + "/action", { action: action });
        }, "操作已执行");
      }

      const ready = bot.ready === true;
      const connected = typeof bot.appId === "string" && bot.appId !== "";
      const stateText = ready ? "已连接" : connected ? "未连接" : "未配置凭据";
      const stateClass = ready ? "qqb-badge--ok" : "qqb-badge--warn";

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "连接状态", hint: "缺失凭据时只注册路由，不启动 QQ 连接" },
          h(
            "div",
            { className: "qqb-kv" },
            kvRow("AppID", bot.appId || "未配置"),
            h(
              "div",
              { className: "qqb-kv-row", key: "连接" },
              h("span", { className: "qqb-kv-label" }, "连接"),
              h("span", { className: "qqb-kv-value" }, h("span", { className: "qqb-badge " + stateClass }, stateText)),
            ),
            kvRow("运行时长", formatDuration(bot.uptimeMs)),
            kvRow("活跃会话", bot.sessionCount || 0),
            kvRow("待回复", pending.length),
            kvRow("当前模型", modelText(modelInfo.effective) + "（" + modelSourceLabel(modelInfo.source) + "）"),
            bot.lastError ? kvRow("最近错误", bot.lastError, true) : null,
          ),
          h(StatusLine, { status: status, dirty: false }),
        ),
        h(BindingCard, { reload: reload }),
        h(
          Card,
          { title: "统计", hint: "只统计本次插件进程内的数据" },
          h(
            "div",
            { className: "qqb-stat-grid" },
            statItem("收到消息", stats.received),
            statItem("触发回复", stats.triggered),
            statItem("跳过", stats.skipped),
            statItem("已回复", stats.replies),
          ),
          h(
            "div",
            { className: "qqb-kv" },
            kvRow("最近回复", formatTime(stats.lastReplyAt)),
            kvRow("最近触发原因", stats.lastTriggerReason),
          ),
        ),
        h(
          Card,
          { title: "当前生效策略", hint: "设置修改后即时生效，无需重启" },
          h("p", { className: "qqb-summary" }, effective.summary || "—"),
          h(
            "div",
            { className: "qqb-kv" },
            kvRow(
              "Agent 预设",
              agentInfo.builtIn === true ? "内置组合（qqbot-buddy）" : agentInfo.effectivePreset || "—",
            ),
            kvRow("功能开关", enabledFeatureLabels(featuresInfo)),
          ),
          effectivePending.length > 0
            ? h(
                "div",
                { className: "qqb-list" },
                effectivePending.map(function (item, index) {
                  const key = (item && item.peerKey ? item.peerKey : "peer") + "-" + index;
                  const label = item && item.peerKey ? item.peerKey : "未知会话";
                  const count = item && typeof item.count === "number" ? item.count : 1;
                  return h(
                    "div",
                    { className: "qqb-list-item", key: key },
                    h("span", { className: "qqb-mono" }, label),
                    h("span", { className: "qqb-list-meta" }, "待回复 " + count + " 条"),
                  );
                }),
              )
            : null,
        ),
        h(
          Card,
          { title: "快速开关", hint: "修改立即保存" },
          h(Switch, {
            label: "自动回复总开关",
            help: "关闭后不再自动回复任何消息（/命令仍可用）",
            checked: reply.enabled !== false,
            onChange: function (value) {
              patchReply({ enabled: value });
            },
          }),
          h(Switch, {
            label: "群聊自动回复",
            help: "关闭后群聊只响应 @ / 回复 / 关键词等强制触发",
            checked: reply.groupEnabled !== false,
            onChange: function (value) {
              patchReply({ groupEnabled: value });
            },
          }),
          h(Switch, {
            label: "私聊自动回复",
            help: "关闭后私聊消息不再触发回复",
            checked: reply.c2cEnabled !== false,
            onChange: function (value) {
              patchReply({ c2cEnabled: value });
            },
          }),
          h(Switch, {
            label: "长期记忆",
            help: "关闭后不再注入 / 收集长期记忆",
            checked: memorySettings.enabled !== false,
            onChange: function (value) {
              patchMemory({ enabled: value });
            },
          }),
          h(StatusLine, { status: status, dirty: false }),
        ),
        h(
          Card,
          { title: "维护操作" },
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn",
                onClick: function () {
                  doAction("clear-pending");
                },
              },
              "清空待回复队列",
            ),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn",
                onClick: function () {
                  doAction("reconnect");
                },
              },
              "重新连接",
            ),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--danger",
                onClick: function () {
                  doAction("reset-settings", "确定恢复所有默认设置吗？人设文件与记忆文件不会被删除。");
                },
              },
              "恢复默认设置",
            ),
          ),
          h(StatusLine, { status: status, dirty: false }),
        ),
        h(
          Card,
          { title: "运行路径", hint: "只读" },
          h(
            "div",
            { className: "qqb-kv qqb-mono" },
            kvRow("工作区", paths.cwd),
            kvRow("人设", paths.persona),
            kvRow("记忆", paths.memory),
            kvRow("状态", paths.stateDir),
            kvRow("媒体", paths.mediaDir),
          ),
        ),
      );
    }

    // ── 回复频率页 ────────────────────────────────────────────
    function FrequencyPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const reply = settings ? settings.reply || {} : {};
      const adaptiveSetting = reply.adaptive && typeof reply.adaptive === "object" ? reply.adaptive : {};
      const mappedReply = Object.assign({}, reply, {
        bubbleSplit: reply.bubbleSplit === "marker" || reply.bubbleSplit === "off" ? reply.bubbleSplit : "auto",
        adaptive: {
          debounceSeconds: typeof adaptiveSetting.debounceSeconds === "number" ? adaptiveSetting.debounceSeconds : 4,
          cooldownSeconds: typeof adaptiveSetting.cooldownSeconds === "number" ? adaptiveSetting.cooldownSeconds : 12,
          maxWaitSeconds: typeof adaptiveSetting.maxWaitSeconds === "number" ? adaptiveSetting.maxWaitSeconds : 20,
          requireRelevance: adaptiveSetting.requireRelevance !== false,
        },
      });
      const [draft, setDraft] = useDraft(mappedReply);
      const [status, run] = useSaver(props.reload);

      if (!settings) return h(LoadingBlock, { text: "正在加载回复频率设置…" });

      const dirty = !sameJSON(draft, mappedReply);
      const mode = draft.groupMode || "count";
      const probability = typeof draft.probability === "number" ? draft.probability : 0;
      const adaptiveDraft = draft.adaptive && typeof draft.adaptive === "object" ? draft.adaptive : {};

      function patch(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      // 嵌套 adaptive：切换模式时保留其它 adaptive 值，只改被点的字段
      function patchAdaptive(partial) {
        setDraft(function (prev) {
          const base = prev.adaptive && typeof prev.adaptive === "object" ? prev.adaptive : {};
          return Object.assign({}, prev, { adaptive: Object.assign({}, base, partial) });
        });
      }

      function save() {
        void run(async function () {
          await apiPost(API + "/settings", { patch: { reply: clone(draft) } });
        }, "回复频率已保存");
      }

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "回复频率", hint: "强制触发优先于频率策略" },
          h(Switch, {
            label: "自动回复总开关",
            help: "关闭后机器人完全不自动回复（/命令仍响应）",
            checked: draft.enabled !== false,
            onChange: function (value) {
              patch({ enabled: value });
            },
          }),
          h(Switch, {
            label: "群聊自动回复",
            help: "关闭后群聊只响应强制触发",
            checked: draft.groupEnabled !== false,
            onChange: function (value) {
              patch({ groupEnabled: value });
            },
          }),
          h(ChoiceGroup, {
            label: "群聊回复策略",
            value: mode,
            options: [
              { value: "all", label: "每条都回" },
              { value: "count", label: "累计 N 条" },
              { value: "interval", label: "时间间隔" },
              { value: "probability", label: "概率回复" },
              { value: "adaptive", label: "自适应（推荐）" },
            ],
            onChange: function (value) {
              patch({ groupMode: value });
            },
            help: "群聊不再每条必回：按累计条数 / 时间间隔 / 概率择机回复；自适应模式会等群聊安静下来再回，并遵守冷却与最长等待。",
          }),
          h(ChoiceGroup, {
            label: "气泡拆分",
            value: draft.bubbleSplit || "auto",
            options: [
              { value: "auto", label: "空行自动拆（默认）" },
              { value: "marker", label: "只发一条" },
              { value: "off", label: "永不拆分" },
            ],
            onChange: function (value) {
              patch({ bubbleSplit: value });
            },
            help: "空行自动拆：模型用空行分段时，每段发成一条消息（需要拆的正常拆）。只发一条：空行只当换行。",
          }),
          mode === "count"
            ? h(
                "div",
                { className: "qqb-grid-2" },
                h(NumberField, {
                  label: "累计条数 N",
                  help: "群里累计收到 N 条消息后回复一次（1-200）",
                  value: draft.countThreshold,
                  min: 1,
                  max: 200,
                  step: 1,
                  onChange: function (value) {
                    patch({ countThreshold: value });
                  },
                }),
                h(NumberField, {
                  label: "等待上限（秒）",
                  help: "最早一条 pending 等待超过该秒数也会回复，0 表示关闭（0-86400）",
                  value: draft.flushAfterSeconds,
                  min: 0,
                  max: 86400,
                  step: 1,
                  onChange: function (value) {
                    patch({ flushAfterSeconds: value });
                  },
                }),
              )
            : null,
          mode === "interval"
            ? h(NumberField, {
                label: "最小间隔（秒）",
                help: "距离上次回复至少间隔 N 秒（5-86400）",
                value: draft.intervalSeconds,
                min: 5,
                max: 86400,
                step: 1,
                onChange: function (value) {
                  patch({ intervalSeconds: value });
                },
              })
            : null,
          mode === "probability"
            ? h(NumberField, {
                label: "回复概率（0-1）",
                help: "每条群消息按该概率独立决定是否回复；当前约 " + Math.round(probability * 100) + "%",
                value: draft.probability,
                min: 0,
                max: 1,
                step: 0.05,
                onChange: function (value) {
                  patch({ probability: value });
                },
              })
            : null,
          mode === "adaptive"
            ? h(
                "div",
                { className: "qqb-field" },
                h(
                  "div",
                  { className: "qqb-grid-2" },
                  h(NumberField, {
                    label: "静默秒数",
                    help: "最后一条群消息后静默 N 秒触发一次回复（0-30）",
                    value: adaptiveDraft.debounceSeconds,
                    min: 0,
                    max: 30,
                    step: 1,
                    onChange: function (value) {
                      patchAdaptive({ debounceSeconds: value });
                    },
                  }),
                  h(NumberField, {
                    label: "冷却秒数",
                    help: "回复后进入冷却，期间只攒消息不发（0-600）",
                    value: adaptiveDraft.cooldownSeconds,
                    min: 0,
                    max: 600,
                    step: 1,
                    onChange: function (value) {
                      patchAdaptive({ cooldownSeconds: value });
                    },
                  }),
                  h(NumberField, {
                    label: "最长等待秒数",
                    help: "从批次首条消息起最长等待，到点强制触发（2-300）",
                    value: adaptiveDraft.maxWaitSeconds,
                    min: 2,
                    max: 300,
                    step: 1,
                    onChange: function (value) {
                      patchAdaptive({ maxWaitSeconds: value });
                    },
                  }),
                ),
                h(Switch, {
                  label: "只回问句 / 媒体",
                  help: "开启后，批次里没有问句、图片或文件时整批丢弃（只记录不回复）",
                  checked: adaptiveDraft.requireRelevance !== false,
                  onChange: function (value) {
                    patchAdaptive({ requireRelevance: value });
                  },
                }),
              )
            : null,
          h(NumberField, {
            label: "全局最小间隔（秒）",
            help: "任意两次非强制回复之间的最小间隔，0 表示不限制（0-3600）",
            value: draft.minGapSeconds,
            min: 0,
            max: 3600,
            step: 1,
            onChange: function (value) {
              patch({ minGapSeconds: value });
            },
          }),
          h(Switch, {
            label: "私聊自动回复",
            help: "关闭后私聊消息不触发回复",
            checked: draft.c2cEnabled !== false,
            onChange: function (value) {
              patch({ c2cEnabled: value });
            },
          }),
          h("p", { className: "qqb-summary" }, (snapshot.effective && snapshot.effective.summary) || "—"),
          h(SaveBar, { dirty: dirty, status: status, onSave: save, note: "有未保存的回复频率修改", label: "保存回复频率" }),
        ),
      );
    }

    // ── 触发规则页 ────────────────────────────────────────────
    function TriggersPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const triggers = settings ? settings.triggers || {} : {};
      const keywords = Array.isArray(triggers.keywords) ? triggers.keywords : [];
      const [draft, setDraft] = useDraft({
        onMention: triggers.onMention !== false,
        onReplyToBot: triggers.onReplyToBot !== false,
        keywordsText: keywords.join("\n"),
      });
      const [status, run] = useSaver(props.reload);

      if (!settings) return h(LoadingBlock, { text: "正在加载触发规则…" });

      const parsedWords = parseKeywords(draft.keywordsText);
      const dirty =
        draft.onMention !== (settings.triggers.onMention !== false) ||
        draft.onReplyToBot !== (settings.triggers.onReplyToBot !== false) ||
        !sameJSON(parsedWords, keywords);

      function patch(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      function save() {
        void run(async function () {
          await apiPost(API + "/settings", {
            patch: {
              triggers: {
                onMention: draft.onMention,
                onReplyToBot: draft.onReplyToBot,
                keywords: parsedWords,
              },
            },
          });
        }, "触发规则已保存");
      }

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "触发规则", hint: "命中任一强制规则时忽略回复频率策略" },
          h(Switch, {
            label: "@机器人 必回",
            help: "群聊中 @ 机器人时直接回复",
            checked: draft.onMention,
            onChange: function (value) {
              patch({ onMention: value });
            },
          }),
          h(Switch, {
            label: "回复机器人消息必回",
            help: "引用 / 回复机器人消息时直接回复",
            checked: draft.onReplyToBot,
            onChange: function (value) {
              patch({ onReplyToBot: value });
            },
          }),
          h(AreaField, {
            label: "必回关键词",
            help: "子串命中即回复；用逗号或换行分隔，最多 50 个，每个不超过 40 字。",
            value: draft.keywordsText,
            rows: 5,
            placeholder: "例如：\n机器人\n小助手\n阿漆",
            onChange: function (value) {
              patch({ keywordsText: value });
            },
          }),
          h(
            "div",
            { className: "qqb-toolbar" },
            h("span", { className: "qqb-tag" }, "已识别 " + parsedWords.length + " 个关键词"),
            parsedWords.length > 0 ? h("span", { className: "qqb-help" }, parsedWords.slice(0, 6).join("、") + (parsedWords.length > 6 ? " …" : "")) : null,
          ),
          h(SaveBar, { dirty: dirty, status: status, onSave: save, note: "有未保存的触发规则修改", label: "保存触发规则" }),
        ),
      );
    }

    // ── Agent 预设与功能开关页 ───────────────────────────────
    function AgentPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const agentSettings = settings ? settings.agent || {} : {};
      const featuresSettings = settings ? settings.features || {} : {};
      const mapped = {
        preset: typeof agentSettings.preset === "string" ? agentSettings.preset : "",
        features: {
          workspace: featuresSettings.workspace !== false,
          web: featuresSettings.web !== false,
          stickers: featuresSettings.stickers !== false,
          vision: featuresSettings.vision !== false,
          memory: featuresSettings.memory !== false,
        },
      };
      const [draft, setDraft] = useDraft(mapped);
      // 额外放行工具（skill / mcp_* / 第三方插件工具）
      const toolsSettings = settings ? settings.tools || {} : {};
      const mappedTools = {
        extraAllowedText: Array.isArray(toolsSettings.extraAllowed) ? toolsSettings.extraAllowed.join("\n") : "",
      };
      const [toolsDraft, setToolsDraft] = useDraft(mappedTools);
      const [toolsStatus, runTools] = useSaver(props.reload);
      const [presetsData, setPresetsData] = react.useState(null);
      const [presetsLoading, setPresetsLoading] = react.useState(true);
      const [presetsError, setPresetsError] = react.useState("");
      const loadPresets = react.useCallback(async function () {
        setPresetsLoading(true);
        try {
          const data = await apiGet(API + "/presets");
          setPresetsData(data);
          setPresetsError("");
        } catch (error) {
          setPresetsData(null);
          setPresetsError(msgOf(error));
        } finally {
          setPresetsLoading(false);
        }
      }, []);
      react.useEffect(function () {
        void loadPresets();
      }, [loadPresets]);
      const [saveStatus, runSave] = useSaver(props.reload);
      const [applyStatus, runApply] = useSaver(props.reload);

      if (!settings) return h(LoadingBlock, { text: "正在加载 Agent 设置…" });

      const agentInfo = snapshot.agent || {};
      const dirty = !sameJSON(draft, mapped);
      const toolsDirty = !sameJSON(toolsDraft, mappedTools);
      const selectedPreset = typeof draft.preset === "string" ? draft.preset : "";
      const hostPresetMode = selectedPreset !== "" && selectedPreset !== "qqbot-buddy";
      const presets = presetsData && Array.isArray(presetsData.presets) ? presetsData.presets : [];
      const presetsUnavailable =
        presetsError !== "" ||
        (presetsData !== null &&
          presets.length === 0 &&
          typeof presetsData.note === "string" &&
          presetsData.note !== "");

      const presetOptions = [{ id: "", name: "内置组合（推荐）" }];
      for (const preset of presets) {
        if (!preset || typeof preset.id !== "string" || preset.id === "") continue;
        const base = typeof preset.name === "string" && preset.name !== "" && preset.name !== preset.id
          ? preset.name + "（" + preset.id + "）"
          : preset.id;
        presetOptions.push({ id: preset.id, name: preset.broken === true ? base + " · 加载异常" : base });
      }
      if (selectedPreset !== "" && !presetOptions.some(function (option) { return option.id === selectedPreset; })) {
        presetOptions.push({ id: selectedPreset, name: selectedPreset + "（自定义）" });
      }

      function patchPreset(value) {
        setDraft(function (prev) {
          return Object.assign({}, prev, { preset: value });
        });
      }

      function patchFeature(key, value) {
        setDraft(function (prev) {
          return Object.assign({}, prev, {
            features: Object.assign({}, prev.features, { [key]: value }),
          });
        });
      }

      function saveExtraTools() {
        void runTools(async function () {
          await apiPost(API + "/settings", {
            patch: { tools: { extraAllowed: parseLineList(toolsDraft.extraAllowedText) } },
          });
        }, "额外放行工具已保存（下一条消息生效，建议点「应用到当前会话」）");
      }

      function saveAgent() {
        void runSave(async function () {
          await apiPost(API + "/settings", {
            patch: { agent: { preset: draft.preset }, features: clone(draft.features) },
          });
        }, "Agent 设置已保存（对之后新建/恢复的会话生效）");
      }

      function applyAgent() {
        void runApply(async function () {
          await apiPost(API + "/action", { action: "apply-model" });
        }, "已重置 bot 会话，下一条消息将使用新设置");
      }

      const presetField = presetsUnavailable
        ? h(TextField, {
            label: "Preset ID（手动输入）",
            value: draft.preset,
            placeholder: "留空 = 内置组合（qqbot-buddy）",
            help:
              presetsError !== ""
                ? "读取预设列表失败：" + presetsError
                : (presetsData && typeof presetsData.note === "string" && presetsData.note !== ""
                    ? presetsData.note
                    : "可手动填写宿主 agent preset id。"),
            onChange: function (value) {
              patchPreset(value.trim());
            },
          })
        : h(SelectField, {
            label: "Agent Preset",
            value: draft.preset,
            options: presetOptions,
            disabled: presetsLoading,
            help: "首项「内置组合（推荐）」= 插件自带的 qqbot-buddy 组合；选择宿主 preset 后工作区/联网由该 preset 决定。",
            onChange: function (value) {
              patchPreset(value);
            },
          });

      const featureSwitches = FEATURE_ITEMS.map(function (item) {
        const disabled = hostPresetMode && (item.key === "workspace" || item.key === "web");
        return h(Switch, {
          key: item.key,
          label: item.label,
          help: disabled ? item.help + "（由所选宿主预设决定，保存后不生效）" : item.help,
          checked: draft.features[item.key] !== false,
          disabled: disabled,
          onChange: function (value) {
            patchFeature(item.key, value);
          },
        });
      });

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "Agent 预设", hint: "决定 bot 会话使用的宿主组合 / 工具集" },
          h(
            "div",
            { className: "qqb-kv" },
            kvRow(
              "当前生效预设",
              agentInfo.builtIn === true ? "内置组合（qqbot-buddy）" : agentInfo.effectivePreset || "—",
            ),
            kvRow("部署默认预设", presetsData && presetsData.defaultPreset ? presetsData.defaultPreset : "—"),
            kvRow("已保存选择", agentSettings.preset ? agentSettings.preset : "内置组合（推荐）"),
          ),
          presetField,
          presetsError !== ""
            ? h(
                "p",
                { className: "qqb-note qqb-note--warn" },
                "读取预设列表失败（" + presetsError + "），已降级为手动输入 preset id。",
              )
            : null,
          presetsData && typeof presetsData.note === "string" && presetsData.note !== ""
            ? h("p", { className: "qqb-help" }, presetsData.note)
            : null,
          hostPresetMode
            ? h(
                "p",
                { className: "qqb-note qqb-note--warn" },
                "已选择宿主预设：工作区 / 联网开关由该预设自带的工具决定（保存但不生效）；表情包 / 看图 / 记忆仍受开关控制。",
              )
            : null,
        ),
        h(
          Card,
          { title: "功能开关", hint: "决定 bot 会话可用的工具范围" },
          featureSwitches,
          h(
            "p",
            { className: "qqb-help" },
            "工作区=fs/glob/grep；联网=web_search/web_fetch；表情包=qqbot_send_file；看图=qqbot_describe_image；记忆=memory_* 工具。内置组合下保存后对新会话生效。",
          ),
        ),
        h(
          Card,
          { title: "保存与应用", hint: "修改只影响新会话" },
          h(
            "p",
            { className: "qqb-help" },
            "修改只影响之后新建/恢复的会话；点「应用到当前会话」会重置 bot 上下文（保留 sessions.json 映射），下一条消息使用新设置。",
          ),
          h(SaveBar, { dirty: dirty, status: saveStatus, onSave: saveAgent, note: "Agent 设置有未保存的修改", label: "保存 Agent 设置" }),
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn",
                disabled: (applyStatus && applyStatus.state === "saving") || dirty,
                onClick: function () {
                  void applyAgent();
                },
              },
              "应用到当前会话",
            ),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--sm",
                disabled: presetsLoading,
                onClick: function () {
                  void loadPresets();
                },
              },
              presetsLoading ? "刷新中…" : "刷新预设列表",
            ),
            h("span", { className: "qqb-help" }, dirty ? "先保存再应用" : "重置内存中的 bot 会话，下一条消息使用新设置。"),
          ),
          h(StatusLine, { status: applyStatus, dirty: false }),
        ),
        h(
          Card,
          {
            title: "额外放行工具（高级）",
            hint: "skill / MCP / 第三方插件工具；内置组合默认只放行本插件工具",
          },
          h(
            "p",
            { className: "qqb-help" },
            "每行一个工具名。常用：skill（加载 ~/.dsh/skills 里的技能）、MCP 工具（名称以宿主注册为准，可在插件管理里查看）。"
              + "内置组合下会把它们加入白名单；切到宿主预设时会把它们从屏蔽名单里移除。改完建议点上面的「应用到当前会话」。",
          ),
          h(AreaField, {
            label: "允许的工具名",
            rows: 5,
            value: toolsDraft.extraAllowedText || "",
            placeholder: "skill\nmcp__filesystem__read_file",
            help: "留空 = 不额外放行（保持当前精简能力）。只写工具名，不要写参数。",
            onChange: function (value) {
              setToolsDraft({ extraAllowedText: value });
            },
          }),
          h(SaveBar, {
            dirty: toolsDirty,
            status: toolsStatus,
            onSave: saveExtraTools,
            note: "额外放行工具有未保存的修改",
          }),
        ),
      );
    }

    // ── 模型页（provider / model / reasoningEffort） ──────────
    function ModelPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const modelSettings = settings ? settings.model || {} : {};
      const currentModel = {
        provider: typeof modelSettings.provider === "string" ? modelSettings.provider : "",
        model: typeof modelSettings.model === "string" ? modelSettings.model : "",
        reasoningEffort: typeof modelSettings.reasoningEffort === "string" ? modelSettings.reasoningEffort : "",
      };
      const [draft, setDraft] = useDraft(currentModel);
      const [modelsData, setModelsData] = react.useState(null);
      const [modelsLoading, setModelsLoading] = react.useState(true);
      const [modelsError, setModelsError] = react.useState("");
      const loadModels = react.useCallback(async function () {
        setModelsLoading(true);
        try {
          const data = await apiGet(API + "/models");
          setModelsData(data);
          setModelsError("");
        } catch (error) {
          setModelsData(null);
          setModelsError(msgOf(error));
        } finally {
          setModelsLoading(false);
        }
      }, []);
      react.useEffect(function () {
        void loadModels();
      }, [loadModels]);
      const [saveStatus, runSave] = useSaver(props.reload);
      const [applyStatus, runApply] = useSaver(props.reload);

      if (!settings) return h(LoadingBlock, { text: "正在加载模型设置…" });

      const info = snapshot.model || {};
      const effective = info.effective || {};
      const selected = info.selected || currentModel;
      const dirty = !sameJSON(draft, currentModel);

      const providers = modelsData && Array.isArray(modelsData.providers) ? modelsData.providers : [];
      const providerOptions = [{ id: "", name: "跟随宿主默认" }];
      for (const provider of providers) {
        if (provider && typeof provider.id === "string" && provider.id !== "") {
          providerOptions.push({ id: provider.id, name: provider.name || provider.id });
        }
      }
      if (draft.provider !== "" && !providerOptions.some(function (option) { return option.id === draft.provider; })) {
        providerOptions.push({ id: draft.provider, name: draft.provider + "（自定义）" });
      }
      const activeProvider = providers.find(function (provider) { return provider.id === draft.provider; });
      const modelEntries = activeProvider && Array.isArray(activeProvider.models) ? activeProvider.models : [];
      const modelOptions = [{ id: "", name: "跟随宿主默认" }];
      if (draft.model !== "" && !modelEntries.some(function (entry) { return entry.id === draft.model; })) {
        modelOptions.push({ id: draft.model, name: draft.model + "（自定义）" });
      }
      for (const entry of modelEntries) modelOptions.push({ id: entry.id, name: entry.name || entry.id });
      const effortOptions = EFFORT_OPTIONS.slice();
      if (
        draft.reasoningEffort !== "" &&
        !effortOptions.some(function (option) { return option.id === draft.reasoningEffort; })
      ) {
        effortOptions.push({ id: draft.reasoningEffort, name: draft.reasoningEffort + "（自定义）" });
      }
      // 接口报错，或宿主没有可枚举的 provider 时，降级为手动文本输入
      const fallbackText = modelsError !== "" || (modelsData !== null && providers.length === 0);

      function patch(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      function renderSelect(label, value, options, onChange, help, disabled) {
        return h(
          "div",
          { className: "qqb-field" },
          h("label", { className: "qqb-field-label" }, label),
          h(
            "select",
            {
              className: "qqb-select",
              value: value,
              disabled: disabled === true,
              onChange: function (event) {
                onChange(event.currentTarget.value);
              },
            },
            options.map(function (option) {
              return h("option", { key: option.id, value: option.id }, option.name);
            }),
          ),
          help ? h("p", { className: "qqb-help" }, help) : null,
        );
      }

      function saveModel() {
        void runSave(async function () {
          await apiPost(API + "/settings", { patch: { model: clone(draft) } });
        }, "模型设置已保存（对之后新建/恢复的会话生效）");
      }

      function applyModel() {
        void runApply(async function () {
          await apiPost(API + "/action", { action: "apply-model" });
        }, "已重置 bot 会话，下一条消息将使用新模型");
      }

      const hostDefault =
        modelsData && modelsData.default ? modelText(modelsData.default) : modelsLoading ? "读取中…" : "不可用";
      const currentText = modelText(effective) + "（来源：" + modelSourceLabel(info.source) + "）";

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "模型路由", hint: "选择 QQ bot 使用的 provider / model；保存后由新会话使用" },
          h(
            "div",
            { className: "qqb-kv" },
            kvRow("宿主默认模型", hostDefault),
            kvRow("当前生效模型", currentText),
            kvRow("已保存选择", modelText(selected)),
          ),
          modelsError
            ? h(
                "p",
                { className: "qqb-note qqb-note--warn" },
                "模型列表不可用（" + modelsError + "），已降级为手动输入 provider / model。",
              )
            : null,
          modelsData && typeof modelsData.note === "string" && modelsData.note !== ""
            ? h("p", { className: "qqb-help" }, modelsData.note)
            : null,
          modelsLoading && !modelsData ? h("p", { className: "qqb-help" }, "正在读取宿主模型列表…") : null,
          fallbackText
            ? h(
                "div",
                { className: "qqb-grid-2" },
                h(TextField, {
                  label: "Provider（手动输入）",
                  value: draft.provider,
                  placeholder: "例如 deepseek",
                  onChange: function (value) {
                    patch({ provider: value.trim() });
                  },
                }),
                h(TextField, {
                  label: "Model（手动输入）",
                  value: draft.model,
                  placeholder: "例如 deepseek-chat",
                  onChange: function (value) {
                    patch({ model: value.trim() });
                  },
                }),
              )
            : h(
                "div",
                { className: "qqb-grid-2" },
                renderSelect(
                  "Provider",
                  draft.provider,
                  providerOptions,
                  function (value) {
                    patch({ provider: value, model: "" });
                  },
                  "首项「跟随宿主默认」表示不覆盖；其余选项来自宿主 llm 服务。",
                  modelsLoading,
                ),
                modelEntries.length > 0
                  ? renderSelect(
                      "Model",
                      draft.model,
                      modelOptions,
                      function (value) {
                        patch({ model: value });
                      },
                      "留空表示跟随宿主默认。",
                      modelsLoading,
                    )
                  : h(TextField, {
                      label: "Model",
                      value: draft.model,
                      placeholder: draft.provider === "" ? "跟随宿主默认" : "输入模型 id",
                      help: "该 provider 未提供模型列表，可直接填写模型 id。",
                      onChange: function (value) {
                        patch({ model: value.trim() });
                      },
                    }),
              ),
          renderSelect(
            "Reasoning Effort",
            draft.reasoningEffort,
            effortOptions,
            function (value) {
              patch({ reasoningEffort: value });
            },
            "空 = 跟随模型 / 宿主默认；部分模型不支持该参数，填错会由适配器忽略或报错。",
            false,
          ),
          h(SaveBar, { dirty: dirty, status: saveStatus, onSave: saveModel, note: "模型选择有未保存的修改", label: "保存模型设置" }),
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn",
                disabled: (applyStatus && applyStatus.state === "saving") || dirty,
                onClick: function () {
                  void applyModel();
                },
              },
              "应用到当前会话",
            ),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--sm",
                disabled: modelsLoading,
                onClick: function () {
                  void loadModels();
                },
              },
              modelsLoading ? "刷新中…" : "刷新模型列表",
            ),
            h(
              "span",
              { className: "qqb-help" },
              dirty ? "先保存再应用" : "重置内存中的 bot 会话（保留 sessions.json 映射），下一条消息使用新模型。",
            ),
          ),
          h(StatusLine, { status: applyStatus, dirty: false }),
        ),
      );
    }

    // ── 表情包页 ─────────────────────────────────────────────
    function StickerThumb(props) {
      const [failed, setFailed] = react.useState(false);
      const item = props.item || {};
      if (failed || !item.url) {
        return h("div", { className: "qqb-sticker-thumb qqb-sticker-thumb--empty" }, "🖼");
      }
      return h("img", {
        className: "qqb-sticker-thumb",
        src: item.url,
        alt: item.name || "表情包",
        loading: "lazy",
        onError: function () {
          setFailed(true);
        },
      });
    }

    function StickersPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const featuresSettings = settings ? settings.features || {} : {};
      const stickerSettings = settings ? settings.stickers || {} : {};
      const mapped = {
        featuresStickers: featuresSettings.stickers !== false,
        collectEnabled: stickerSettings.collectEnabled !== false,
        dailyLimit: typeof stickerSettings.dailyLimit === "number" ? stickerSettings.dailyLimit : 10,
      };
      const [draft, setDraft] = useDraft(mapped);
      const [data, setData] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      const [loadError, setLoadError] = react.useState("");
      const load = react.useCallback(async function () {
        setLoading(true);
        try {
          const result = await apiGet(API + "/stickers");
          setData(result);
          setLoadError("");
        } catch (error) {
          setLoadError(msgOf(error));
        } finally {
          setLoading(false);
        }
      }, []);
      react.useEffect(function () {
        void load();
      }, [load]);

      const [saveStatus, runSave] = useSaver(props.reload);
      const [uploadStatus, runUpload] = useSaver(load);
      const [editStatus, runEdit] = useSaver(load);

      const [selectedName, setSelectedName] = react.useState("");
      const [editEmotion, setEditEmotion] = react.useState("");
      const [editTagsText, setEditTagsText] = react.useState("");
      const [editNote, setEditNote] = react.useState("");

      const [uploadFileName, setUploadFileName] = react.useState("");
      const [uploadDataUrl, setUploadDataUrl] = react.useState("");
      const [uploadEmotion, setUploadEmotion] = react.useState("");
      const [uploadNote, setUploadNote] = react.useState("");
      const [uploadError, setUploadError] = react.useState("");

      if (!settings) return h(LoadingBlock, { text: "正在加载表情包设置…" });

      const items = data && Array.isArray(data.items) ? data.items : [];
      const selectedItem = items.find(function (item) { return item.name === selectedName; }) || null;
      const dirty = !sameJSON(draft, mapped);
      const maxMB = data && typeof data.maxMB === "number" ? data.maxMB : stickerSettings.maxMB || 8;
      const dir = data && typeof data.dir === "string" && data.dir !== "" ? data.dir : stickerSettings.dir || "—";
      // GET /api/stickers 的 todayCount 由服务端提供（近 24h 收藏数，可能缺失）
      const todayCount = data && typeof data.todayCount === "number" ? data.todayCount : null;
      const dailyLimitValue = typeof draft.dailyLimit === "number" ? draft.dailyLimit : 10;
      const itemTags = selectedItem && Array.isArray(selectedItem.tags) ? selectedItem.tags : [];
      const editDirty =
        selectedItem !== null &&
        (editEmotion.trim() !== selectedItem.emotion ||
          !sameJSON(parseTags(editTagsText), itemTags) ||
          editNote.trim() !== selectedItem.note);

      function patchToggle(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      function saveToggles() {
        void runSave(async function () {
          await apiPost(API + "/settings", {
            patch: {
              features: { stickers: draft.featuresStickers },
              stickers: { collectEnabled: draft.collectEnabled, dailyLimit: draft.dailyLimit },
            },
          });
        }, "表情包设置已保存");
      }

      function openItem(item) {
        setSelectedName(item.name);
        setEditEmotion(item.emotion || "");
        setEditTagsText(Array.isArray(item.tags) ? item.tags.join("，") : "");
        setEditNote(item.note || "");
      }

      function closeEditor() {
        setSelectedName("");
      }

      function saveItem() {
        if (!selectedItem) return;
        void runEdit(async function () {
          await apiPost(API + "/stickers/update", {
            name: selectedItem.name,
            emotion: editEmotion.trim(),
            tags: parseTags(editTagsText),
            note: editNote.trim(),
          });
        }, "表情信息已保存");
      }

      function deleteItem() {
        if (!selectedItem) return;
        if (typeof window !== "undefined" && !window.confirm("确定删除表情「" + selectedItem.name + "」吗？此操作不可撤销。")) return;
        const name = selectedItem.name;
        void runEdit(async function () {
          await apiPost(API + "/stickers/delete", { name: name });
          setSelectedName("");
        }, "表情已删除");
      }

      function pickFile(event) {
        const files = event && event.currentTarget ? event.currentTarget.files : null;
        const file = files && files[0] ? files[0] : null;
        setUploadError("");
        if (!file) {
          setUploadFileName("");
          setUploadDataUrl("");
          return;
        }
        if (typeof file.size === "number" && file.size > maxMB * 1024 * 1024) {
          setUploadFileName("");
          setUploadDataUrl("");
          setUploadError("文件超过单张上限 " + maxMB + "MB");
          return;
        }
        if (typeof FileReader === "undefined") {
          setUploadError("当前环境不支持读取本地文件");
          return;
        }
        const reader = new FileReader();
        reader.onload = function () {
          setUploadDataUrl(typeof reader.result === "string" ? reader.result : "");
          setUploadFileName(file.name || "");
        };
        reader.onerror = function () {
          setUploadError("读取本地文件失败");
        };
        reader.readAsDataURL(file);
      }

      function submitUpload() {
        if (uploadDataUrl === "") {
          setUploadError("请选择要上传的图片文件");
          return;
        }
        void runUpload(async function () {
          await apiPost(API + "/stickers/upload", {
            dataUrl: uploadDataUrl,
            emotion: uploadEmotion.trim(),
            note: uploadNote.trim(),
          });
          setUploadDataUrl("");
          setUploadFileName("");
          setUploadEmotion("");
          setUploadNote("");
          setUploadError("");
        }, "表情已上传");
      }

      const uploading = uploadStatus && uploadStatus.state === "saving";
      const editing = editStatus && editStatus.state === "saving";

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "表情包设置", hint: "管理 bot 可发送的表情图片" },
          h(
            "div",
            { className: "qqb-kv" },
            kvRow("目录", dir),
            kvRow("单张上限", maxMB + " MB（settings.stickers.maxMB，只读）"),
            kvRow("每日收藏上限", dailyLimitValue + " 张 / 24 小时"),
            todayCount !== null ? kvRow("今日已收藏", todayCount + " / " + dailyLimitValue + " 张") : null,
            kvRow("库内数量", items.length + " 个"),
          ),
          h(Switch, {
            label: "启用表情包",
            help: "关闭后 bot 不再注入表情目录、也不暴露发送/收藏工具（管理类 API 不受影响）",
            checked: draft.featuresStickers,
            onChange: function (value) {
              patchToggle({ featuresStickers: value });
            },
          }),
          h(Switch, {
            label: "允许 bot 收藏",
            help: "允许 bot 用 qqbot_sticker_save 把喜欢的表情/贴图收藏进库",
            checked: draft.collectEnabled,
            onChange: function (value) {
              patchToggle({ collectEnabled: value });
            },
          }),
          h(NumberField, {
            label: "每日收藏上限",
            help: "bot 通过工具自动收藏时，近 24 小时最多 N 张（1-100）；API 手动上传不受限制",
            value: draft.dailyLimit,
            min: 1,
            max: 100,
            step: 1,
            onChange: function (value) {
              patchToggle({ dailyLimit: value });
            },
          }),
          h(SaveBar, {
            dirty: dirty,
            status: saveStatus,
            onSave: saveToggles,
            note: "表情包设置有未保存的修改",
            label: "保存设置",
          }),
        ),
        h(
          Card,
          { title: "表情库", hint: loading ? "读取中…" : "点击卡片编辑" },
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              { type: "button", className: "qqb-btn qqb-btn--sm", disabled: loading, onClick: function () { void load(); } },
              loading ? "刷新中…" : "刷新列表",
            ),
            h("span", { className: "qqb-help" }, "缩略图通过 /api/stickers/file 获取；加载失败显示占位"),
          ),
          // 编辑/删除的反馈也在这里展示：删除成功后编辑器会收起，提示不能跟着消失
          h(StatusLine, { status: editStatus, dirty: false }),
          loadError ? h(ErrorBlock, { text: "读取表情库失败：" + loadError, onRetry: load }) : null,
          !loading && !loadError && items.length === 0
            ? h("p", { className: "qqb-empty" }, "表情库还是空的：可以在下方上传图片，或让 bot 在聊天中收藏喜欢的表情。")
            : null,
          items.length > 0
            ? h(
                "div",
                { className: "qqb-sticker-grid" },
                items.map(function (item) {
                  const active = selectedName === item.name;
                  return h(
                    "button",
                    {
                      key: item.name,
                      type: "button",
                      className: "qqb-sticker-card" + (active ? " qqb-sticker-card--active" : ""),
                      onClick: function () {
                        openItem(item);
                      },
                    },
                    h(StickerThumb, { item: item }),
                    h("span", { className: "qqb-sticker-name" }, item.name),
                    item.emotion ? h("span", { className: "qqb-tag" }, item.emotion) : null,
                    item.source ? h("span", { className: "qqb-sticker-source" }, "来源：" + item.source) : null,
                  );
                }),
              )
            : null,
        ),
        selectedItem
          ? h(
              Card,
              { title: "编辑表情", hint: selectedItem.name, key: "sticker-editor" },
              h(
                "div",
                { className: "qqb-row" },
                h("span", { className: "qqb-mono" }, selectedItem.name),
                h("button", { type: "button", className: "qqb-btn qqb-btn--sm", onClick: closeEditor }, "收起"),
              ),
              h(TextField, {
                label: "emotion（情绪标签）",
                value: editEmotion,
                placeholder: "例如：大笑",
                help: "展示在表情目录里，也会进入 system prompt 的可用表情列表（建议简短）。",
                onChange: setEditEmotion,
              }),
              h(TextField, {
                label: "tags（逗号分隔）",
                value: editTagsText,
                placeholder: "例如：开心，日常",
                onChange: setEditTagsText,
              }),
              h(AreaField, {
                label: "note（备注）",
                value: editNote,
                rows: 2,
                onChange: setEditNote,
              }),
              h(SaveBar, {
                dirty: editDirty,
                status: editStatus,
                onSave: saveItem,
                note: "表情信息有未保存的修改",
                label: "保存表情",
              }),
              h(
                "div",
                { className: "qqb-toolbar" },
                h(
                  "button",
                  { type: "button", className: "qqb-btn qqb-btn--danger", disabled: editing, onClick: deleteItem },
                  "删除表情",
                ),
                h("span", { className: "qqb-help" }, "删除后不可恢复；文件与元数据会一起移除"),
              ),
            )
          : null,
        h(
          Card,
          { title: "上传表情", hint: "单张不超过 " + maxMB + "MB，支持 png/jpg/jpeg/gif/webp" },
          h(
            "div",
            { className: "qqb-field" },
            h("label", { className: "qqb-field-label" }, "选择图片"),
            h("input", {
              type: "file",
              className: "qqb-input",
              accept: "image/png,image/jpeg,image/gif,image/webp",
              onChange: pickFile,
            }),
            uploadFileName ? h("p", { className: "qqb-help" }, "已选择：" + uploadFileName) : null,
          ),
          h(TextField, {
            label: "emotion（可选）",
            value: uploadEmotion,
            placeholder: "例如：大笑",
            onChange: setUploadEmotion,
          }),
          h(AreaField, {
            label: "note（可选）",
            value: uploadNote,
            rows: 2,
            onChange: setUploadNote,
          }),
          uploadError ? h("p", { className: "qqb-note qqb-note--err" }, "⚠️ " + uploadError) : null,
          h(
            "div",
            { className: "qqb-footer" },
            h("div", { className: "qqb-footer-note" }, h(StatusLine, { status: uploadStatus, dirty: false })),
            h(
              "button",
              { type: "button", className: "qqb-btn qqb-btn--primary", disabled: uploading || uploadDataUrl === "", onClick: submitUpload },
              uploading ? "正在上传…" : "上传表情",
            ),
          ),
        ),
      );
    }

    // ── 人设页 ────────────────────────────────────────────────
    function PersonaPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const personaSettings = settings ? settings.persona || {} : {};
      const mapped = {
        mode: personaSettings.mode === "append" ? "append" : "replace",
        suppressRuntimeContext: personaSettings.suppressRuntimeContext !== false,
        groupExtraPrompt: typeof personaSettings.groupExtraPrompt === "string" ? personaSettings.groupExtraPrompt : "",
        directExtraPrompt: typeof personaSettings.directExtraPrompt === "string" ? personaSettings.directExtraPrompt : "",
      };
      const [draft, setDraft] = useDraft(mapped);

      // 功能性提示词（与人设分开存 settings.prompts）
      const promptsSettings = settings && settings.prompts ? settings.prompts : {};
      // 内置默认（服务端 /api/state 下发）：文本为空时直接显示默认值，而不是留空
      const promptDefaults = snapshot && snapshot.promptDefaults && typeof snapshot.promptDefaults === "object" ? snapshot.promptDefaults : {};
      const mappedPrompts = {
        toolGuide: {
          enabled: !(promptsSettings.toolGuide && promptsSettings.toolGuide.enabled === false),
          text: promptsSettings.toolGuide && typeof promptsSettings.toolGuide.text === "string" ? promptsSettings.toolGuide.text : "",
        },
        sendGuide: {
          enabled: !(promptsSettings.sendGuide && promptsSettings.sendGuide.enabled === false),
          text: promptsSettings.sendGuide && typeof promptsSettings.sendGuide.text === "string" ? promptsSettings.sendGuide.text : "",
        },
        rhythmGuide: {
          enabled: !(promptsSettings.rhythmGuide && promptsSettings.rhythmGuide.enabled === false),
          text: promptsSettings.rhythmGuide && typeof promptsSettings.rhythmGuide.text === "string" ? promptsSettings.rhythmGuide.text : "",
        },
        stickerGuide: {
          enabled: !(promptsSettings.stickerGuide && promptsSettings.stickerGuide.enabled === false),
          text: promptsSettings.stickerGuide && typeof promptsSettings.stickerGuide.text === "string" ? promptsSettings.stickerGuide.text : "",
        },
      };
      const [promptsDraft, setPromptsDraft] = useDraft(mappedPrompts);
      const [promptsStatus, runPrompts] = useSaver(props.reload);

      const [persona, setPersona] = react.useState(null);
      const [text, setText] = react.useState("");
      const [loading, setLoading] = react.useState(true);
      const [loadError, setLoadError] = react.useState("");
      const loadedRef = react.useRef(false);
      const loadPersona = react.useCallback(async function () {
        // 首次加载才展示 loading；保存后的刷新保持 textarea 不闪烁
        if (!loadedRef.current) setLoading(true);
        try {
          const data = await apiGet(API + "/persona");
          setPersona(data);
          setText(typeof data.text === "string" ? data.text : "");
          setLoadError("");
          loadedRef.current = true;
        } catch (error) {
          setLoadError(msgOf(error));
        } finally {
          setLoading(false);
        }
      }, []);
      react.useEffect(
        function () {
          void loadPersona();
        },
        [loadPersona],
      );
      const [textStatus, runText] = useSaver(loadPersona);
      const [restoreStatus, runRestore] = useSaver(loadPersona);
      const [settingsStatus, runSettings] = useSaver(props.reload);

      if (!settings) return h(LoadingBlock, { text: "正在加载人设设置…" });

      const baseText = persona && typeof persona.text === "string" ? persona.text : "";
      const textDirty = persona !== null && text !== baseText;
      const settingsDirty = !sameJSON(draft, mapped);
      const promptsDirty = !sameJSON(promptsDraft, mappedPrompts);

      function patchPrompt(key, partial) {
        setPromptsDraft(function (prev) {
          const base = prev[key] && typeof prev[key] === "object" ? prev[key] : { enabled: true, text: "" };
          const next = Object.assign({}, prev);
          next[key] = Object.assign({}, base, partial);
          return next;
        });
      }

      function savePrompts() {
        void runPrompts(async function () {
          await apiPost(API + "/settings", { patch: { prompts: clone(promptsDraft) } });
        }, "功能提示词已保存（下一条消息生效）");
      }

      function patch(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      function saveText() {
        void runText(async function () {
          await apiPost(API + "/persona", { text: text });
        }, "人设已保存（旧版本已自动备份）");
      }

      function restore(name) {
        if (typeof window !== "undefined" && !window.confirm("确定用备份「" + name + "」覆盖当前人设吗？当前人设会先自动备份。")) return;
        void runRestore(async function () {
          await apiPost(API + "/persona/restore", { name: name });
        }, "已从备份恢复人设");
      }

      function saveSettings() {
        void runSettings(async function () {
          await apiPost(API + "/settings", { patch: { persona: clone(draft) } });
        }, "人设策略已保存");
      }

      const backups = persona && Array.isArray(persona.backups) ? persona.backups : [];

      return h(
        "div",
        { className: "qqb-page" },
        h(PersonaCardsPanel, {
          personaText: text,
          onChanged: async function (reloadPersona) {
            if (reloadPersona === true) await loadPersona();
            if (typeof props.reload === "function") await props.reload();
          },
        }),
        h(
          Card,
          {
            title: "功能提示词（与人格无关）",
            hint: "发消息格式 / 工具约定 / 群聊节奏 / 表情包规则；下面显示的是当前生效文本（含内置默认）",
          },
          h(
            "p",
            { className: "qqb-help" },
            "这些是行为约束，不写进 persona.md。文本框里直接显示当前生效内容：改了就保存为自定义，点「恢复默认」回到内置默认，关掉开关则完全不注入。",
          ),
          [
            { key: "toolGuide", label: "工具与能力边界" },
            { key: "sendGuide", label: "消息格式与长短" },
            { key: "rhythmGuide", label: "群聊节奏" },
            { key: "stickerGuide", label: "表情包规则" },
          ].map(function (item) {
            const entry = promptsDraft[item.key] || { enabled: true, text: "" };
            const defaultText = typeof promptDefaults[item.key] === "string" ? promptDefaults[item.key] : "";
            const customText = typeof entry.text === "string" ? entry.text : "";
            const shown = customText !== "" ? customText : defaultText;
            const usingDefault = customText === "";
            return h(
              "div",
              { className: "qqb-field", key: item.key },
              h(Switch, {
                label: "启用「" + item.label + "」",
                checked: entry.enabled !== false,
                onChange: function (value) {
                  patchPrompt(item.key, { enabled: value });
                },
              }),
              entry.enabled !== false
                ? h(
                    "div",
                    null,
                    h(AreaField, {
                      label: item.label + (usingDefault ? "（内置默认）" : "（自定义）"),
                      rows: 8,
                      value: shown,
                      help: item.key === "stickerGuide"
                        ? "保存后表情包库目录（随收藏变化）会自动追加在这段后面。"
                        : "这里显示当前生效文本；修改后保存即覆盖内置默认。",
                      onChange: function (value) {
                        patchPrompt(item.key, { text: value });
                      },
                    }),
                    usingDefault
                      ? null
                      : h(
                          "div",
                          { className: "qqb-toolbar" },
                          h(
                            "button",
                            {
                              type: "button",
                              className: "qqb-btn qqb-btn--sm",
                              onClick: function () {
                                patchPrompt(item.key, { text: "" });
                              },
                            },
                            "恢复默认",
                          ),
                        ),
                  )
                : null,
            );
          }),
          h(SaveBar, {
            dirty: promptsDirty,
            status: promptsStatus,
            onSave: savePrompts,
            note: "功能提示词有未保存的修改",
          }),
        ),
        h(
          Card,
          { title: "人设内容", hint: "保存后下一轮对话立即生效" },
          loading
            ? h(LoadingBlock, { text: "正在读取人设文件…" })
            : loadError
              ? h(ErrorBlock, { text: "读取人设失败：" + loadError, onRetry: loadPersona })
              : h(
                  "div",
                  { className: "qqb-field" },
                  h("textarea", {
                    className: "qqb-area qqb-area--tall",
                    value: text,
                    spellCheck: false,
                    placeholder: "在这里编写机器人的人设……",
                    onChange: function (event) {
                      setText(event.currentTarget.value);
                    },
                  }),
                  h(
                    "div",
                    { className: "qqb-kv" },
                    kvRow("文件路径", persona && persona.path ? persona.path : "—"),
                    kvRow("大小", persona ? formatBytes(persona.bytes) + " · " + (persona.lines || 0) + " 行" : "—"),
                    kvRow("最近修改", persona ? formatTime(persona.mtime) : "—"),
                  ),
                  h(SaveBar, {
                    dirty: textDirty,
                    status: textStatus,
                    onSave: saveText,
                    note: "人设正文有未保存的修改",
                    label: "保存人设",
                  }),
                ),
        ),
        h(
          Card,
          { title: "备份与回滚", hint: "每次保存前自动备份上一版" },
          backups.length > 0
            ? h(
                "div",
                { className: "qqb-list" },
                backups.map(function (item) {
                  return h(
                    "div",
                    { className: "qqb-list-item", key: item.name },
                    h(
                      "div",
                      { className: "qqb-list-main" },
                      h("span", { className: "qqb-mono" }, item.name),
                      h("span", { className: "qqb-list-meta" }, formatBytes(item.size) + " · " + formatTime(item.mtime)),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "qqb-btn qqb-btn--sm",
                        onClick: function () {
                          restore(item.name);
                        },
                      },
                      "恢复",
                    ),
                  );
                }),
              )
            : h("p", { className: "qqb-empty" }, "暂无备份：保存人设时会自动备份上一版本"),
          h(StatusLine, { status: restoreStatus, dirty: false }),
        ),
        h(
          Card,
          { title: "人设策略", hint: "控制人设如何参与 system prompt 组合" },
          h(ChoiceGroup, {
            label: "人设模式",
            value: draft.mode,
            options: [
              { value: "replace", label: "替换（完整替代系统提示）" },
              { value: "append", label: "追加（拼在宿主提示之后）" },
            ],
            onChange: function (value) {
              patch({ mode: value });
            },
            help: "替换模式完全接管系统提示，适合 chatonly 风格；追加模式保留宿主默认提示。",
          }),
          h(Switch, {
            label: "关闭动态运行上下文",
            help: "开启后不再向 system prompt 注入时间 / 工作区等运行上下文",
            checked: draft.suppressRuntimeContext,
            onChange: function (value) {
              patch({ suppressRuntimeContext: value });
            },
          }),
          h(AreaField, {
            label: "群聊额外 prompt",
            help: "仅群聊会话追加，例如要求回复时 @ 对方",
            value: draft.groupExtraPrompt,
            rows: 3,
            onChange: function (value) {
              patch({ groupExtraPrompt: value });
            },
          }),
          h(AreaField, {
            label: "私聊额外 prompt",
            help: "仅私聊会话追加",
            value: draft.directExtraPrompt,
            rows: 3,
            onChange: function (value) {
              patch({ directExtraPrompt: value });
            },
          }),
          h(SaveBar, {
            dirty: settingsDirty,
            status: settingsStatus,
            onSave: saveSettings,
            note: "人设策略有未保存的修改",
          }),
        ),

      );
    }

    // ── 口头禅页 ────────────────────────────────────────────
    function PhrasesPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const phraseSettings = settings ? settings.phrases || {} : {};
      const [draft, setDraft] = useDraft(phraseSettings);
      const [settingsStatus, runSettings] = useSaver(props.reload);
      const [suggestions, setSuggestions] = react.useState([]);
      const [suggestStatus, setSuggestStatus] = react.useState("");
      const [suggestError, setSuggestError] = react.useState("");
      const [suggesting, setSuggesting] = react.useState(false);
      // 打开页面就自动扫描长期记忆，候选直接可见（加入后才启用）。
      react.useEffect(function () {
        void loadSuggestions();
      }, []);

      if (!settings) return h(LoadingBlock, { text: "正在加载口头禅设置…" });
      const items = Array.isArray(draft.items) ? draft.items : [];
      const dirty = !sameJSON(draft, phraseSettings);

      function patchPhrases(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }
      function patchItem(index, partial) {
        setDraft(function (prev) {
          const list = Array.isArray(prev.items) ? prev.items.slice() : [];
          list[index] = Object.assign({}, list[index], partial);
          return Object.assign({}, prev, { items: list });
        });
      }
      function addItem(text, note) {
        setDraft(function (prev) {
          const list = Array.isArray(prev.items) ? prev.items.slice() : [];
          const value = typeof text === "string" ? text.trim() : "";
          if (value !== "" && list.some(function (item) { return String(item.text || "").trim().toLowerCase() === value.toLowerCase(); })) return prev;
          list.push({ text: value, note: typeof note === "string" ? note : "", enabled: true });
          return Object.assign({}, prev, { items: list });
        });
      }
      function removeItem(index) {
        setDraft(function (prev) {
          const list = Array.isArray(prev.items) ? prev.items.slice() : [];
          list.splice(index, 1);
          return Object.assign({}, prev, { items: list });
        });
      }
      async function loadSuggestions() {
        setSuggesting(true);
        setSuggestStatus("正在扫描长期记忆…");
        setSuggestError("");
        try {
          const data = await apiGet(API + "/phrases/suggestions");
          const list = Array.isArray(data.suggestions) ? data.suggestions : [];
          // 防御：别把用户昵称当口头禅（昵称引号出现在「口头禅/常说」之前）。
          const filtered = list.filter(function (item) {
            const note = String(item && item.note ? item.note : "");
            const text = String(item && item.text ? item.text : "");
            const at = note.indexOf(text);
            if (at < 0) return true;
            const trigger = note.search(/口头禅|口头语|口癖|说话风格|常说|经常说/);
            return trigger < 0 || at >= trigger;
          });
          setSuggestions(filtered);
          setSuggestStatus(filtered.length ? "找到 " + filtered.length + " 条候选" : "没有从记忆中提取到新的口头禅");
        } catch (error) {
          setSuggestError(msgOf(error));
          setSuggestStatus("");
        } finally {
          setSuggesting(false);
        }
      }

      return h(
        react.Fragment,
        null,
        h(
          Card,
          { title: "口头禅", hint: "从对话里学到的口癖单独管理；独立注入 prompt，不写进 persona.md" },
          h(Switch, {
            label: "启用口头禅",
            help: "关闭后 prompt 不再注入【口头禅】段，已配置的条目保留",
            checked: draft.enabled !== false,
            onChange: function (value) {
              patchPhrases({ enabled: value });
            },
          }),
          items.length === 0
            ? h("p", { className: "qqb-empty" }, "还没有口头禅。可以手动添加，或从长期记忆里提取。")
            : items.map(function (item, index) {
                return h(
                  "div",
                  { className: "qqb-field", key: "phrase-" + index, style: { borderTop: index ? "1px solid var(--qqb-border, #eee)" : "none", paddingTop: index ? 10 : 0, marginTop: index ? 10 : 0 } },
                  h(
                    "div",
                    { className: "qqb-grid-2" },
                    h(TextField, {
                      label: "口头禅",
                      value: item.text || "",
                      placeholder: "如：哦对了 / onp",
                      onChange: function (value) { patchItem(index, { text: value }); },
                    }),
                    h(TextField, {
                      label: "备注 / 用法（可选）",
                      value: item.note || "",
                      placeholder: "如：表示想到一件事",
                      onChange: function (value) { patchItem(index, { note: value }); },
                    }),
                  ),
                  h(
                    "div",
                    { className: "qqb-actions" },
                    h(Switch, {
                      label: "启用",
                      checked: item.enabled !== false,
                      onChange: function (value) { patchItem(index, { enabled: value }); },
                    }),
                    h("button", { type: "button", className: "qqb-btn qqb-btn--ghost", onClick: function () { removeItem(index); } }, "删除"),
                  ),
                );
              }),
          h(
            "div",
            { className: "qqb-actions" },
            h("button", { type: "button", className: "qqb-btn", onClick: function () { addItem("", ""); } }, "添加一条"),
          ),
          h(SaveBar, { dirty: dirty, status: settingsStatus, onSave: function () { return runSettings(function () { return apiPost(API + "/settings", { patch: { phrases: clone(draft) } }); }); }, note: "口头禅有未保存的修改" }),
        ),
        h(
          Card,
          { title: "从长期记忆提取", hint: "扫描 MEMORY.md 里 #口头禅 / #说话风格 / #接梗 等事实，提取引号里的口头禅" },
          h(
            "div",
            { className: "qqb-actions" },
            h("button", { type: "button", className: "qqb-btn qqb-btn--ghost", disabled: suggesting, onClick: function () { void loadSuggestions(); } }, suggesting ? "扫描中…" : "扫描长期记忆"),
          ),
          suggestStatus ? h("p", { className: "qqb-help" }, suggestStatus) : null,
          suggestError ? h("p", { className: "qqb-note qqb-note--err" }, "⚠️ " + suggestError) : null,
          suggestions.length > 0
            ? h(
                "div",
                { className: "qqb-list" },
                suggestions.map(function (item, index) {
                  return h(
                    "div",
                    { className: "qqb-list-item", key: "sug-" + index },
                    h("span", null, item.text),
                    h(
                      "button",
                      { type: "button", className: "qqb-btn qqb-btn--ghost", onClick: function () { addItem(item.text, item.note || ""); } },
                      "加入",
                    ),
                  );
                }),
              )
            : null,
        ),
      );
    }

    // ── 自我改进页 ────────────────────────────────────────────
    function MemoryPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const memorySettings = settings ? settings.memory || {} : {};
      const [draft, setDraft] = useDraft(memorySettings);
      const [settingsStatus, runSettings] = useSaver(props.reload);

      const [layout, setLayout] = react.useState(null);
      const [layoutError, setLayoutError] = react.useState("");
      const loadLayout = react.useCallback(async function () {
        try {
          const data = await apiGet(API + "/memory");
          setLayout(data);
          setLayoutError("");
        } catch (error) {
          setLayoutError(msgOf(error));
        }
      }, []);
      react.useEffect(
        function () {
          void loadLayout();
        },
        [loadLayout],
      );

      const [currentFile, setCurrentFile] = react.useState(null);
      const [fileText, setFileText] = react.useState("");
      const [fileError, setFileError] = react.useState("");
      const [fileStatus, runFile] = useSaver(loadLayout);
      const openFile = react.useCallback(async function (name) {
        try {
          const data = await apiGet(API + "/memory/file?path=" + encodeURIComponent(name));
          const content = typeof data.text === "string" ? data.text : "";
          setCurrentFile({ name: name, path: typeof data.path === "string" ? data.path : name, original: content });
          setFileText(content);
          setFileError("");
        } catch (error) {
          setFileError(msgOf(error));
        }
      }, []);

      const [appendText, setAppendText] = react.useState("");
      const [appendTags, setAppendTags] = react.useState("");
      const [appendStatus, runAppend] = useSaver(loadLayout);

      const [collecting, setCollecting] = react.useState(false);
      const [collectMessage, setCollectMessage] = react.useState("");

      const [promptScope, setPromptScope] = react.useState("group");
      const [promptText, setPromptText] = react.useState("");
      const [promptError, setPromptError] = react.useState("");
      const previewPrompt = react.useCallback(
        async function () {
          try {
            const data = await apiGet(API + "/prompt?scope=" + encodeURIComponent(promptScope));
            setPromptText(typeof data.text === "string" ? data.text : String(data.text === undefined || data.text === null ? "" : data.text));
            setPromptError("");
          } catch (error) {
            setPromptError(msgOf(error));
          }
        },
        [promptScope],
      );
      react.useEffect(
        function () {
          void previewPrompt();
        },
        [previewPrompt],
      );

      if (!settings) return h(LoadingBlock, { text: "正在加载自我改进设置…" });

      const auto = draft.autoCollect || {};
      const dirty = !sameJSON(draft, memorySettings);
      const files = layout && Array.isArray(layout.files) ? layout.files : [];
      const fileDirty = currentFile !== null && fileText !== currentFile.original;

      function patchMemory(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      function patchAuto(partial) {
        setDraft(function (prev) {
          const base = prev.autoCollect || {};
          return Object.assign({}, prev, { autoCollect: Object.assign({}, base, partial) });
        });
      }

      function saveSettings() {
        void runSettings(async function () {
          await apiPost(API + "/settings", { patch: { memory: clone(draft) } });
        }, "自我改进设置已保存");
      }

      function saveFile() {
        if (!currentFile) return;
        const target = currentFile.name;
        void runFile(async function () {
          await apiPost(API + "/memory/file", { path: target, text: fileText });
          setCurrentFile(function (prev) {
            return prev && prev.name === target ? Object.assign({}, prev, { original: fileText }) : prev;
          });
        }, "记忆文件已保存");
      }

      function submitAppend() {
        const content = appendText.trim();
        if (content === "") return;
        void runAppend(async function () {
          await apiPost(API + "/memory/append", { text: content, tags: parseTags(appendTags) });
          setAppendText("");
          setAppendTags("");
        }, "已记入长期记忆");
      }

      async function collectNow() {
        if (collecting) return;
        setCollecting(true);
        setCollectMessage("正在调用模型提炼…");
        try {
          const result = await apiPost(API + "/memory/collect", {});
          const added = Array.isArray(result.added) ? result.added.length : 0;
          const scanned = typeof result.scannedMessages === "number" ? result.scannedMessages : 0;
          setCollectMessage("已提炼 " + added + " 条事实（扫描 " + scanned + " 条消息）");
          await loadLayout();
        } catch (error) {
          setCollectMessage("提炼失败：" + msgOf(error));
        } finally {
          setCollecting(false);
        }
      }

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "记忆设置", hint: "记忆写入工作区目录，下一轮自动读回 system prompt" },
          h(Switch, {
            label: "启用长期记忆",
            help: "关闭后不再注入记忆，也不再自动收集",
            checked: draft.enabled !== false,
            onChange: function (value) {
              patchMemory({ enabled: value });
            },
          }),
          h(TextField, {
            label: "记忆目录",
            help: "必须是绝对路径；默认 <工作区>/memory",
            value: draft.dir || "",
            mono: true,
            onChange: function (value) {
              patchMemory({ dir: value });
            },
          }),
          h(NumberField, {
            label: "注入上限（字符）",
            help: "MEMORY.md 注入 system prompt 的最大字符数，0 表示不注入（0-20000）",
            value: draft.injectMaxChars,
            min: 0,
            max: 20000,
            step: 100,
            onChange: function (value) {
              patchMemory({ injectMaxChars: value });
            },
          }),
          h(Switch, {
            label: "自动收集",
            help: "每 N 轮回复后调用模型提炼值得长期记住的事实",
            checked: auto.enabled !== false,
            onChange: function (value) {
              patchAuto({ enabled: value });
            },
          }),
          h(
            "div",
            { className: "qqb-grid-2" },
            h(NumberField, {
              label: "收集间隔（轮）",
              help: "每 N 轮回复提炼一次（1-100）",
              value: auto.everyRounds,
              min: 1,
              max: 100,
              step: 1,
              onChange: function (value) {
                patchAuto({ everyRounds: value });
              },
            }),
            h(NumberField, {
              label: "单次最多事实数",
              help: "每次提炼最多写入的事实条数（1-20）",
              value: auto.maxFacts,
              min: 1,
              max: 20,
              step: 1,
              onChange: function (value) {
                patchAuto({ maxFacts: value });
              },
            }),
            h(NumberField, {
              label: "单条事实上限（字符）",
              help: "单条事实的最大长度（50-2000）",
              value: auto.maxFactChars,
              min: 50,
              max: 2000,
              step: 50,
              onChange: function (value) {
                patchAuto({ maxFactChars: value });
              },
            }),
          ),
          h(TextField, {
            label: "提炼 Provider",
            help: "留空使用宿主默认模型",
            value: auto.provider || "",
            onChange: function (value) {
              patchAuto({ provider: value });
            },
          }),
          h(TextField, {
            label: "提炼 Model",
            help: "留空使用宿主默认模型",
            value: auto.model || "",
            onChange: function (value) {
              patchAuto({ model: value });
            },
          }),
          h(SaveBar, { dirty: dirty, status: settingsStatus, onSave: saveSettings, note: "记忆设置有未保存的修改" }),
        ),
        h(
          Card,
          {
            title: "长期记忆（当前注入）",
            hint: layout && layout.exists === false ? "记忆目录尚未创建" : (layout && layout.dir ? layout.dir : ""),
          },
          h(
            "p",
            { className: "qqb-help" },
            "已记住 " + ((layout && Array.isArray(layout.facts)) ? layout.facts.length : 0) + " 条"
              + ((layout && layout.memoryEnabled === false) ? " · 长期记忆已关闭" : "")
              + ((layout && typeof layout.injectMaxChars === "number")
                ? " · 注入 " + (layout.injectedChars || 0) + "/" + layout.injectMaxChars + " 字符"
                  + (layout.truncated ? "（超出部分已截断）" : "")
                : ""),
          ),
          h(
            "div",
            { className: "qqb-actions", style: { marginBottom: 8 } },
            h("button", { type: "button", className: "qqb-btn qqb-btn--ghost", onClick: function () { void loadLayout(); } }, "刷新"),
          ),
          layout && Array.isArray(layout.facts) && layout.facts.length > 0
            ? h(
                "div",
                { className: "qqb-list", style: { maxHeight: 360, overflowY: "auto" } },
                layout.facts.slice().reverse().map(function (fact, index) {
                  return h(
                    "div",
                    { className: "qqb-list-item", key: fact.date + "-" + index, style: { display: "block" } },
                    h(
                      "div",
                      { className: "qqb-list-meta" },
                      fact.date + (fact.tags && fact.tags.length ? " · " + fact.tags.map(function (tag) { return "#" + tag; }).join(" ") : ""),
                    ),
                    h("div", null, fact.text),
                  );
                }),
              )
            : h("p", { className: "qqb-empty" }, layout && layout.memoryEnabled === false ? "长期记忆已关闭" : "还没有长期记忆（聊天里说值得记住的事，或手动记一笔）"),
        ),
        h(
          Card,
          {
            title: "自我改进提示词",
            hint: "与人设分开：persona.md 只负责人设/语气；学习与记忆规则放在这里",
          },
          h(AreaField, {
            label: "自我改进提示词",
            rows: 6,
            value: draft.selfImprovePrompt || "",
            placeholder: "留空使用内置默认（推荐）",
            help: "作为独立的【自我改进】段注入 system prompt，不会修改 persona.md；留空则使用内置默认学习规则。",
            onChange: function (value) {
              patchMemory({ selfImprovePrompt: value });
            },
          }),
          h(AreaField, {
            label: "记忆提炼提示词（高级）",
            rows: 6,
            value: draft.collectorPrompt || "",
            placeholder: "留空使用内置默认；可用 {{maxFacts}} / {{maxFactChars}} 占位",
            help: "自动收集记忆时给提炼模型的 prompt，与聊天人设无关；留空使用内置默认。",
            onChange: function (value) {
              patchMemory({ collectorPrompt: value });
            },
          }),
          h(SaveBar, { dirty: dirty, status: settingsStatus, onSave: saveSettings, note: "自我改进提示词有未保存的修改" }),
        ),
        h(
          Card,
          { title: "记忆文件", hint: layout && layout.dir ? layout.dir : "读取中…" },
          layoutError ? h(ErrorBlock, { text: "读取记忆目录失败：" + layoutError, onRetry: loadLayout }) : null,
          files.length === 0
            ? h("p", { className: "qqb-empty" }, layout && layout.exists === false ? "记忆目录尚未创建（首次保存记忆时会自动创建）" : "暂无记忆文件")
            : null,
          files.length > 0
            ? h(
                "div",
                { className: "qqb-list" },
                files.map(function (file) {
                  const active = currentFile !== null && currentFile.name === file.name;
                  return h(
                    "div",
                    { className: "qqb-list-item", key: file.name },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "qqb-file" + (active ? " qqb-file--active" : ""),
                        onClick: function () {
                          void openFile(file.name);
                        },
                      },
                      file.name,
                    ),
                    h("span", { className: "qqb-list-meta" }, formatBytes(file.size) + " · " + formatTime(file.mtime)),
                  );
                }),
              )
            : null,
          fileError ? h("p", { className: "qqb-note qqb-note--err" }, "⚠️ " + fileError) : null,
          currentFile
            ? h(
                "div",
                { className: "qqb-field" },
                h(
                  "div",
                  { className: "qqb-row" },
                  h("span", { className: "qqb-field-label qqb-mono" }, currentFile.path),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "qqb-btn qqb-btn--sm",
                      onClick: function () {
                        setCurrentFile(null);
                        setFileText("");
                        setFileError("");
                      },
                    },
                    "关闭",
                  ),
                ),
                h("textarea", {
                  className: "qqb-area",
                  value: fileText,
                  spellCheck: false,
                  onChange: function (event) {
                    setFileText(event.currentTarget.value);
                  },
                }),
                h(SaveBar, { dirty: fileDirty, status: fileStatus, onSave: saveFile, note: "该记忆文件有未保存的修改", label: "保存文件" }),
              )
            : null,
        ),
        h(
          Card,
          { title: "手动记一笔", hint: "写入长期记忆并维护去重索引" },
          h(AreaField, {
            label: "手记内容",
            help: "记录值得长期记住的事实 / 偏好 / 约定，不要记寒暄",
            value: appendText,
            rows: 3,
            placeholder: "例如：阿漆喜欢晚上聊天，讨厌被催",
            onChange: setAppendText,
          }),
          h(TextField, {
            label: "标签",
            help: "可选，用逗号分隔，例如：偏好,作息",
            value: appendTags,
            onChange: setAppendTags,
          }),
          h(
            "div",
            { className: "qqb-footer" },
            h("div", { className: "qqb-footer-note" }, h(StatusLine, { status: appendStatus, dirty: false })),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--primary",
                disabled: appendText.trim() === "" || (appendStatus && appendStatus.state === "saving"),
                onClick: function () {
                  submitAppend();
                },
              },
              "记录",
            ),
          ),
        ),
        h(
          Card,
          { title: "立即提炼", hint: "手动触发一次自动收集" },
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn",
                disabled: collecting,
                onClick: function () {
                  void collectNow();
                },
              },
              collecting ? "正在提炼…" : "立即提炼",
            ),
            h("span", { className: "qqb-help" }, collectMessage || "会消耗一次模型调用；失败不影响正常回复"),
          ),
          h(
            "p",
            { className: "qqb-help" },
            "自动收集：" + (auto.enabled === false ? "已关闭" : "每 " + (auto.everyRounds === undefined ? "?" : auto.everyRounds) + " 轮提炼一次"),
          ),
        ),
        h(
          Card,
          { title: "System prompt 预览", hint: "当前设置下组合出的人设 + 记忆 + 行为指引" },
          h(
            "div",
            { className: "qqb-toolbar" },
            h(ChoiceGroup, {
              value: promptScope,
              options: [
                { value: "group", label: "群聊" },
                { value: "direct", label: "私聊" },
              ],
              onChange: setPromptScope,
            }),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--sm",
                onClick: function () {
                  void previewPrompt();
                },
              },
              "刷新",
            ),
          ),
          promptError
            ? h("p", { className: "qqb-note qqb-note--err" }, "⚠️ " + promptError)
            : h("pre", { className: "qqb-pre" }, promptText || "（空）"),
        ),
      );
    }

    // ── 人格卡面板（人设页顶部；POST/GET /qqbot-buddy/api/persona/cards） ──
    const PERSONA_CARD_API = {
      list: API + "/persona/cards",
      create: API + "/persona/cards",
      update: API + "/persona/cards/update",
      content: API + "/persona/cards/content",
      activate: API + "/persona/cards/activate",
      delete: API + "/persona/cards/delete",
    };

    function PersonaCardsPanel(props) {
      const [data, setData] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      const [loadError, setLoadError] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [status, setStatus] = react.useState({ state: "idle", message: "" });
      const [newName, setNewName] = react.useState("");
      const [newDescription, setNewDescription] = react.useState("");
      // 「自行新增」：手动填写内容新建人格卡（不依赖当前人设）
      const [draftOpen, setDraftOpen] = react.useState(false);
      const [draftContent, setDraftContent] = react.useState("");
      // 编辑已有卡的内容（读取卡正文后覆盖保存）
      const [contentEditId, setContentEditId] = react.useState("");
      const [contentEditText, setContentEditText] = react.useState("");
      const [contentEditLoading, setContentEditLoading] = react.useState(false);
      const [editingId, setEditingId] = react.useState("");
      const [editName, setEditName] = react.useState("");
      const [editDescription, setEditDescription] = react.useState("");

      const load = react.useCallback(async function () {
        setLoading(true);
        try {
          const result = await apiGet(PERSONA_CARD_API.list);
          setData(result);
          setLoadError("");
        } catch (error) {
          setData(null);
          setLoadError(msgOf(error));
        } finally {
          setLoading(false);
        }
      }, []);
      react.useEffect(
        function () {
          void load();
        },
        [load],
      );

      async function runAction(task, successMessage, options) {
        const opts = options && typeof options === "object" ? options : {};
        if (busy) return;
        setBusy(true);
        setStatus({ state: "saving", message: "正在处理…" });
        try {
          const result = await task();
          await load();
          // 只有真正改写了人设文件的操作才重载正文，避免把 textarea 里未保存的编辑覆盖掉
          const reloadPersona =
            opts.reloadPersona === true ||
            (typeof opts.reloadPersonaWhen === "function" ? opts.reloadPersonaWhen(result) === true : false);
          if (typeof props.onChanged === "function") await props.onChanged(reloadPersona);
          setStatus({ state: "saved", message: successMessage || "操作成功" });
        } catch (error) {
          setStatus({ state: "error", message: msgOf(error) });
        } finally {
          setBusy(false);
        }
      }

      const cards = data && Array.isArray(data.cards) ? data.cards : [];
      const cardCount = data && typeof data.cardCount === "number" ? data.cardCount : cards.length;
      const activeId = data && typeof data.activeId === "string" ? data.activeId : "";
      const activeCard = data && data.active && typeof data.active === "object" ? data.active : cards.find(function (card) { return card.active === true; });
      const custom = data && data.custom === true;
      const currentText = typeof props.personaText === "string" ? props.personaText : "";
      const activeName = activeCard && typeof activeCard.name === "string" ? activeCard.name : "";
      const personaInfo = data && data.persona && typeof data.persona === "object" ? data.persona : null;

      function activate(card) {
        if (!card || card.active === true) return;
        void runAction(
          async function () {
            await apiPost(PERSONA_CARD_API.activate, { id: card.id });
          },
          "已切换人格卡（人设已更新）",
          { reloadPersona: true },
        );
      }

      function createCard() {
        const name = newName.trim();
        if (name === "") {
          setStatus({ state: "error", message: "请先填写新卡名称" });
          return;
        }
        if (currentText.trim() === "") {
          setStatus({ state: "error", message: "当前人设内容为空，无法存为新卡" });
          return;
        }
        void runAction(async function () {
          await apiPost(PERSONA_CARD_API.create, {
            name: name,
            description: newDescription.trim(),
            content: currentText,
          });
          setNewName("");
          setNewDescription("");
        }, "已把当前人设存为新卡");
      }

      /** 手动新建卡：内容来自下方文本域，而不是当前人设。 */
      function createCardManual() {
        const name = newName.trim();
        if (name === "") {
          setStatus({ state: "error", message: "请先填写新卡名称" });
          return;
        }
        const content = draftContent.trim();
        if (content === "") {
          setStatus({ state: "error", message: "请填写人格卡内容（人设正文）" });
          return;
        }
        void runAction(async function () {
          const result = await apiPost(PERSONA_CARD_API.create, {
            name: name,
            description: newDescription.trim(),
            content: content,
          });
          setNewName("");
          setNewDescription("");
          setDraftContent("");
          setDraftOpen(false);
          return result;
        }, "已新建人格卡（自定义内容），可点「使用」切换到它");
      }

      function updateCurrentCard() {
        if (activeId === "" && !activeCard) {
          setStatus({ state: "error", message: "当前没有使用中的人格卡，请先把人设存为新卡" });
          return;
        }
        const id = activeId !== "" ? activeId : activeCard.id;
        if (currentText.trim() === "") {
          setStatus({ state: "error", message: "当前人设内容为空，无法更新卡片" });
          return;
        }
        if (typeof window !== "undefined" && !window.confirm("用当前人设内容覆盖人格卡「" + (activeName || id) + "」吗？")) return;
        void runAction(async function () {
          await apiPost(PERSONA_CARD_API.update, { id: id, content: currentText });
        }, "已用当前人设更新当前卡");
      }

      /** 打开某张卡的正文编辑（先读取卡内容）。 */
      async function openContentEdit(card) {
        if (!card || !card.id) return;
        setContentEditId(card.id);
        setContentEditText("");
        setContentEditLoading(true);
        setStatus({ state: "idle", message: "" });
        try {
          const data = await apiGet(PERSONA_CARD_API.content + "?id=" + encodeURIComponent(card.id));
          setContentEditText(typeof data.content === "string" ? data.content : "");
        } catch (error) {
          setStatus({ state: "error", message: msgOf(error) });
          setContentEditId("");
        } finally {
          setContentEditLoading(false);
        }
      }

      /** 保存卡正文；若保存的是「使用中」的卡，则同步写回当前人设。 */
      function saveContentEdit(card) {
        const text = contentEditText.trim();
        if (text === "") {
          setStatus({ state: "error", message: "人格卡内容不能为空" });
          return;
        }
        const isActive = card.active === true;
        void runAction(
          async function () {
            await apiPost(PERSONA_CARD_API.update, { id: card.id, content: text });
            // 改的是当前使用中的卡：再 activate 一次，把新内容写回人设（自动备份旧人设）
            if (isActive) await apiPost(PERSONA_CARD_API.activate, { id: card.id });
            setContentEditId("");
            setContentEditText("");
          },
          isActive ? "人格卡内容已保存，并同步到当前人设" : "人格卡内容已保存",
          { reloadPersona: isActive },
        );
      }

      function startEdit(card) {
        setEditingId(card.id);
        setEditName(typeof card.name === "string" ? card.name : "");
        setEditDescription(typeof card.description === "string" ? card.description : "");
      }

      function saveEdit(card) {
        const name = editName.trim();
        if (name === "") {
          setStatus({ state: "error", message: "人格卡名称不能为空" });
          return;
        }
        void runAction(async function () {
          await apiPost(PERSONA_CARD_API.update, {
            id: card.id,
            name: name,
            description: editDescription.trim(),
          });
          setEditingId("");
        }, "人格卡信息已保存");
      }

      function removeCard(card) {
        if (typeof window !== "undefined" && !window.confirm("确定删除人格卡「" + (card.name || card.id) + "」吗？不会删除当前人设文件。")) return;
        void runAction(
          async function () {
            return await apiPost(PERSONA_CARD_API.delete, { id: card.id });
          },
          "人格卡已删除",
          {
            reloadPersonaWhen: function (result) {
              // 只有删除「当前使用中」的卡才可能改变人设判定；普通删除不覆盖 textarea
              return !result || result.wasActive !== false;
            },
          },
        );
      }

      return h(
        Card,
        { title: "人格卡", hint: "保存多套人设，一键切换（active = 当前人设与该卡一致）" },
        loading
          ? h(LoadingBlock, { text: "正在读取人格卡…" })
          : loadError
            ? h(ErrorBlock, { text: "读取人格卡失败：" + loadError, onRetry: load })
            : h(
                "div",
                null,
                h(
                  "div",
                  { className: "qqb-kv" },
                  kvRow("当前卡片", activeName !== "" ? activeName : custom ? "自定义（未保存为卡）" : "—"),
                  kvRow("卡片数量", cardCount + " 张"),
                  kvRow(
                    "当前人设",
                    personaInfo
                      ? (typeof personaInfo.chars === "number" ? personaInfo.chars + " 字" : "—") +
                          (typeof personaInfo.path === "string" && personaInfo.path !== ""
                            ? " · " + personaInfo.path + (personaInfo.exists === false ? "（文件不存在）" : "")
                            : "")
                      : "—",
                  ),
                ),
                custom
                  ? h(
                      "p",
                      { className: "qqb-note qqb-note--warn" },
                      "当前人设是自定义内容（与任何人格卡都不一致）：可以「存为新卡」，或用「更新当前卡」覆盖使用中的卡。",
                    )
                  : null,
                cards.length === 0
                  ? h("p", { className: "qqb-empty" }, "还没有人格卡：把当前人设存为新卡后即可一键切换。")
                  : h(
                      "div",
                      { className: "qqb-list" },
                      cards.map(function (card) {
                        const editing = editingId === card.id;
                        return h(
                          "div",
                          { className: "qqb-list-item", key: card.id },
                          h(
                            "div",
                            { className: "qqb-list-main" },
                            h(
                              "div",
                              { className: "qqb-toolbar" },
                              h("span", { className: "qqb-field-label" }, typeof card.name === "string" && card.name !== "" ? card.name : card.id),
                              card.active === true ? h("span", { className: "qqb-tag" }, "使用中") : null,
                              card.missing === true ? h("span", { className: "qqb-tag" }, "文件缺失") : null,
                            ),
                            typeof card.description === "string" && card.description !== ""
                              ? h("span", { className: "qqb-list-meta" }, card.description)
                              : null,
                            h(
                              "span",
                              { className: "qqb-list-meta" },
                              (typeof card.chars === "number" ? card.chars : 0) +
                                " 字 · 更新于 " +
                                formatTimestamp(card.updatedAt === undefined || card.updatedAt === null ? card.createdAt : card.updatedAt),
                            ),
                            contentEditId === card.id
                              ? h(
                                  "div",
                                  { className: "qqb-field" },
                                  contentEditLoading
                                    ? h(LoadingBlock, { text: "正在读取卡内容…" })
                                    : h(AreaField, {
                                        label: "卡内容（人设正文）",
                                        rows: 8,
                                        value: contentEditText,
                                        placeholder: "编辑这套人格的人设正文",
                                        help: card.active === true
                                          ? "这是当前使用中的卡：保存后会同时写回当前人设（旧人设自动备份）。"
                                          : "只修改这张卡的内容；点「使用」才会切换过去。",
                                        onChange: setContentEditText,
                                      }),
                                  h(
                                    "div",
                                    { className: "qqb-toolbar" },
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "qqb-btn qqb-btn--primary qqb-btn--sm",
                                        disabled: busy || contentEditLoading,
                                        onClick: function () {
                                          saveContentEdit(card);
                                        },
                                      },
                                      "保存内容",
                                    ),
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "qqb-btn qqb-btn--sm",
                                        onClick: function () {
                                          setContentEditId("");
                                          setContentEditText("");
                                        },
                                      },
                                      "取消",
                                    ),
                                  ),
                                )
                              : null,
                            editing
                              ? h(
                                  "div",
                                  { className: "qqb-field" },
                                  h(TextField, {
                                    label: "名称",
                                    value: editName,
                                    onChange: setEditName,
                                  }),
                                  h(TextField, {
                                    label: "描述",
                                    value: editDescription,
                                    placeholder: "这套人设适合什么场景",
                                    onChange: setEditDescription,
                                  }),
                                  h(
                                    "div",
                                    { className: "qqb-toolbar" },
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        className: "qqb-btn qqb-btn--primary qqb-btn--sm",
                                        disabled: busy,
                                        onClick: function () {
                                          saveEdit(card);
                                        },
                                      },
                                      "保存",
                                    ),
                                    h(
                                      "button",
                                      { type: "button", className: "qqb-btn qqb-btn--sm", onClick: function () { setEditingId(""); } },
                                      "取消",
                                    ),
                                  ),
                                )
                              : null,
                          ),
                          h(
                            "div",
                            { className: "qqb-toolbar" },
                            h(
                              "button",
                              {
                                type: "button",
                                className: "qqb-btn qqb-btn--sm",
                                disabled: busy || card.active === true,
                                onClick: function () {
                                  activate(card);
                                },
                              },
                              card.active === true ? "使用中" : "使用",
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "qqb-btn qqb-btn--sm",
                                disabled: busy,
                                onClick: function () {
                                  startEdit(card);
                                },
                              },
                              "改名称/描述",
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "qqb-btn qqb-btn--sm",
                                disabled: busy || card.missing === true,
                                onClick: function () {
                                  if (contentEditId === card.id) {
                                    setContentEditId("");
                                    setContentEditText("");
                                  } else {
                                    void openContentEdit(card);
                                  }
                                },
                              },
                              contentEditId === card.id ? "收起内容" : "编辑内容",
                            ),
                            h(
                              "button",
                              {
                                type: "button",
                                className: "qqb-btn qqb-btn--sm qqb-btn--danger",
                                disabled: busy,
                                onClick: function () {
                                  removeCard(card);
                                },
                              },
                              "删除",
                            ),
                          ),
                        );
                      }),
                    ),
              ),
        h(
          "div",
          { className: "qqb-field" },
          h("span", { className: "qqb-field-label" }, "把当前人设存为新卡"),
          h(
            "div",
            { className: "qqb-grid-2" },
            h(TextField, {
              label: "名称",
              value: newName,
              placeholder: "例如：温柔版 / 高冷版",
              onChange: setNewName,
            }),
            h(TextField, {
              label: "描述（可选）",
              value: newDescription,
              placeholder: "例如：适合深夜闲聊",
              onChange: setNewDescription,
            }),
          ),
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              { type: "button", className: "qqb-btn qqb-btn--primary", disabled: busy, onClick: createCard },
              busy ? "正在保存…" : "存为新卡",
            ),
            activeId !== "" || activeCard
              ? h(
                  "button",
                  { type: "button", className: "qqb-btn", disabled: busy, onClick: updateCurrentCard },
                  "用当前人设覆盖当前卡",
                )
              : null,
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn",
                disabled: busy,
                onClick: function () {
                  setDraftOpen(!draftOpen);
                },
              },
              draftOpen ? "收起手动新建" : "手动新建卡（自定义内容）",
            ),
            h("span", { className: "qqb-help" }, "「存为新卡」取人设 textarea 当前值；想直接写一套新人设，用「手动新建卡」"),
          ),
          draftOpen
            ? h(
                "div",
                { className: "qqb-field" },
                h(AreaField, {
                  label: "新卡内容（人设正文）",
                  rows: 8,
                  value: draftContent,
                  placeholder: "直接写这套人格的人设，例如：你是……，说话风格……。保存后可在列表里点「使用」切换。",
                  help: "这里的内容不会立刻替换当前人设；只有点「使用」才会写回 persona 文件（旧人设自动备份）。",
                  onChange: setDraftContent,
                }),
                h(
                  "div",
                  { className: "qqb-toolbar" },
                  h(
                    "button",
                    { type: "button", className: "qqb-btn qqb-btn--primary", disabled: busy, onClick: createCardManual },
                    busy ? "正在保存…" : "保存新卡",
                  ),
                  h(
                    "button",
                    { type: "button", className: "qqb-btn", onClick: function () { setDraftOpen(false); } },
                    "取消",
                  ),
                ),
              )
            : null,
        ),
        h(StatusLine, { status: status, dirty: false }),
      );
    }

    // ── 命令与权限页 ─────────────────────────────────────────
    /** 每行/逗号分隔 → 去空去重数组（openid 与昵称共用）。 */
    function parseLineList(textValue) {
      const seen = new Set();
      const out = [];
      for (const part of String(textValue || "").split(/[\n,，;；]+/)) {
        const value = part.trim();
        if (value === "") continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value.slice(0, 128));
        if (out.length >= 100) break;
      }
      return out;
    }

    function CommandsPage(props) {
      const snapshot = props.snapshot;
      const settings = snapshot && snapshot.settings ? snapshot.settings : null;
      const admin = settings && settings.admin ? settings.admin : {};
      const mapped = {
        enabled: admin.enabled === true,
        openidsText: Array.isArray(admin.openids) ? admin.openids.join("\n") : "",
        namesText: Array.isArray(admin.names) ? admin.names.join("\n") : "",
      };
      const [draft, setDraft] = useDraft(mapped);
      const [data, setData] = react.useState(null);
      const [loading, setLoading] = react.useState(true);
      const [loadError, setLoadError] = react.useState("");
      const load = react.useCallback(async function () {
        setLoading(true);
        try {
          const result = await apiGet(API + "/commands");
          setData(result);
          setLoadError("");
        } catch (error) {
          setData(null);
          setLoadError(msgOf(error));
        } finally {
          setLoading(false);
        }
      }, []);
      react.useEffect(
        function () {
          void load();
        },
        [load],
      );
      const [status, run] = useSaver(props.reload);

      if (!settings) return h(LoadingBlock, { text: "正在加载命令与权限设置…" });

      const dirty = !sameJSON(draft, mapped);
      const commands = data && Array.isArray(data.commands) ? data.commands : [];
      const openidCount = parseLineList(draft.openidsText).length;
      const nameCount = parseLineList(draft.namesText).length;

      function patch(partial) {
        setDraft(function (prev) {
          return Object.assign({}, prev, partial);
        });
      }

      function saveAdmin() {
        void run(async function () {
          await apiPost(API + "/settings", {
            patch: {
              admin: {
                enabled: draft.enabled,
                openids: parseLineList(draft.openidsText),
                names: parseLineList(draft.namesText),
              },
            },
          });
        }, "管理员设置已保存");
      }

      return h(
        "div",
        { className: "qqb-page" },
        h(
          Card,
          { title: "命令列表", hint: "在 QQ 里发送以 / 开头的命令；管理命令只有管理员可用" },
          h(
            "div",
            { className: "qqb-toolbar" },
            h(
              "button",
              { type: "button", className: "qqb-btn qqb-btn--sm", disabled: loading, onClick: function () { void load(); } },
              loading ? "刷新中…" : "刷新命令列表",
            ),
            h("span", { className: "qqb-help" }, "发送 /id 可查看自己的昵称与 openid（配置管理员用）"),
          ),
          loading
            ? h(LoadingBlock, { text: "正在读取命令列表…" })
            : loadError
              ? h(ErrorBlock, { text: "读取命令列表失败：" + loadError, onRetry: load })
              : commands.length === 0
                ? h("p", { className: "qqb-empty" }, "暂无命令目录（后端 COMMAND_CATALOG 为空或接口尚未就绪）。")
                : h(
                    "div",
                    { className: "qqb-list" },
                    commands.map(function (command) {
                      const name = typeof command.name === "string" ? command.name : "";
                      if (name === "") return null;
                      const usage = typeof command.usage === "string" && command.usage !== "" ? command.usage : "/" + name;
                      const aliases = Array.isArray(command.aliases) ? command.aliases.filter(function (alias) { return typeof alias === "string" && alias !== ""; }) : [];
                      return h(
                        "div",
                        { className: "qqb-list-item", key: name },
                        h(
                          "div",
                          { className: "qqb-list-main" },
                          h("span", { className: "qqb-mono" }, usage),
                          h(
                            "span",
                            { className: "qqb-list-meta" },
                            (typeof command.description === "string" ? command.description : "") +
                              (aliases.length > 0 ? " · 别名：" + aliases.join("、") : ""),
                          ),
                        ),
                        command.adminOnly === true ? h("span", { className: "qqb-tag" }, "仅管理员") : null,
                      );
                    }),
                  ),
        ),
        h(
          Card,
          { title: "管理员", hint: "限制会改变状态的命令" },
          h(Switch, {
            label: "启用管理员限制",
            help: "开启且名单非空时，只有名单内的 QQ 用户能执行 /new /reset /clear /resume /stop 等会改变状态的命令；关闭或名单为空时保持不限制。",
            checked: draft.enabled,
            onChange: function (value) {
              patch({ enabled: value });
            },
          }),
          h(AreaField, {
            label: "管理员 openid（每行一个）",
            help: "推荐用 openid（稳定）：在 QQ 里发送 /id 查看自己的昵称与 openid；也可用逗号分隔。",
            value: draft.openidsText,
            rows: 4,
            placeholder: "例如：\nA1B2C3D4...\nE5F6G7H8...",
            onChange: function (value) {
              patch({ openidsText: value });
            },
          }),
          h(AreaField, {
            label: "管理员昵称（每行一个，兜底）",
            help: "昵称可能变化，仅在 openid 缺失时兜底；每行一个，也可用逗号分隔。",
            value: draft.namesText,
            rows: 3,
            placeholder: "例如：阿漆",
            onChange: function (value) {
              patch({ namesText: value });
            },
          }),
          h(
            "p",
            { className: "qqb-help" },
            "当前生效：" +
              (draft.enabled && (openidCount > 0 || nameCount > 0)
                ? "已启用（openid " + openidCount + " 个 / 昵称 " + nameCount + " 个）"
                : "未生效（未启用或名单为空，保持不限制）"),
          ),
          h(SaveBar, {
            dirty: dirty,
            status: status,
            onSave: saveAdmin,
            note: "管理员设置有未保存的修改",
            label: "保存管理员设置",
          }),
        ),
      );
    }

    // ── 组合 tab：回复与触发 / Agent 与模型 ──────────────────
    function ReplyTab(props) {
      return h(
        "div",
        { className: "qqb-page" },
        h(FrequencyPage, props),
        h(TriggersPage, props),
      );
    }

    function AgentModelTab(props) {
      return h(
        "div",
        { className: "qqb-page" },
        h(AgentPage, props),
        h(ModelPage, props),
      );
    }

    // ── 设置页 Section 主体 ──────────────────────────────────
    function Section() {
      useStyles();
      const [tab, setTab] = react.useState("overview");
      const [snapshot, setSnapshot] = react.useState(null);
      const [loadError, setLoadError] = react.useState("");
      const [refreshing, setRefreshing] = react.useState(false);

      const reload = react.useCallback(async function () {
        setRefreshing(true);
        try {
          const data = await apiGet(API + "/state");
          setSnapshot(data);
          setLoadError("");
          return data;
        } catch (error) {
          setLoadError(msgOf(error));
          return null;
        } finally {
          setRefreshing(false);
        }
      }, []);

      react.useEffect(
        function () {
          void reload();
        },
        [reload],
      );

      const bot = snapshot && snapshot.bot ? snapshot.bot : {};
      const ready = bot.ready === true;
      const configured = typeof bot.appId === "string" && bot.appId !== "";
      const badgeText = !snapshot ? "加载中…" : ready ? "已连接" : configured ? "未连接" : "未配置凭据";
      const badgeClass = ready ? "qqb-badge--ok" : configured ? "qqb-badge--warn" : "qqb-badge--off";

      const pages = {
        overview: OverviewPage,
        reply: ReplyTab,
        agent: AgentModelTab,
        persona: PersonaPage,
        phrases: PhrasesPage,
        stickers: StickersPage,
        memory: MemoryPage,
        commands: CommandsPage,
      };
      const ActivePage = pages[tab] || OverviewPage;

      return h(
        "div",
        { className: "qqb-root" },
        h(
          "div",
          { className: "qqb-head" },
          h(
            "div",
            { className: "qqb-head-main" },
            h("h2", { className: "qqb-title" }, "QQ 机器人"),
            h("p", { className: "qqb-sub" }, "回复与触发 · Agent 与模型 · 人设与人格卡 · 口头禅 · 表情包 · 记忆与自我改进 · 命令与权限"),
          ),
          h(
            "div",
            { className: "qqb-head-status" },
            h("span", { className: "qqb-badge " + badgeClass }, badgeText),
            h(
              "button",
              {
                type: "button",
                className: "qqb-btn qqb-btn--sm",
                disabled: refreshing,
                onClick: function () {
                  void reload();
                },
              },
              refreshing ? "刷新中…" : "刷新",
            ),
          ),
        ),
        loadError ? h(ErrorBlock, { text: "读取状态失败：" + loadError, onRetry: reload }) : null,
        h(
          "nav",
          { className: "qqb-tabs", role: "tablist" },
          TABS.map(function (item) {
            const active = tab === item.id;
            return h(
              "button",
              {
                key: item.id,
                type: "button",
                role: "tab",
                "aria-selected": active ? "true" : "false",
                className: "qqb-tab" + (active ? " qqb-tab--active" : ""),
                onClick: function () {
                  setTab(item.id);
                },
              },
              item.label,
            );
          }),
        ),
        h(ActivePage, { snapshot: snapshot, reload: reload }),
      );
    }

    // ── 插件出口（与官方 client bundle 同款结构） ────────────
    const inject = ["slots"];

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots) return;
      ctx.effect(
        function () {
          return slots.inject("settings.section", function () {
            return slots.register(
              { name: "settings.section", id: "qqbot-buddy", order: 40, label: "QQ 机器人" },
              Section,
            );
          });
        },
        "qqbot-buddy.settings",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
