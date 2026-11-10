/**
 * dsh Web 客户端插件：在侧边栏底部（sidebar.footer.action 槽位）加一个
 * 「QQ」快捷入口，点击后跳到 QQBot 控制台。
 *
 * 入口地址不走硬编码端口：服务端注册了同源路由 /qqbot-dashboard，会读取本插件
 * 当前配置的 console 地址并 302 过去，这样改端口/监听地址都不需要改前端。
 *
 * 说明：这是 dsh Web 的 client module（window.__ModuleLoader__ 协议），
 * 只在安装了本插件的 web profile 里出现；纯前端、无构建依赖。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-buddy',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const jsx = require('react/jsx-runtime');

    const inject = ['slots'];
    const PAGE = 'QQBot 控制台';

    /** 侧边栏底部的 QQ 快捷入口（外链走同源 302）。 */
    function QqbotDashboardAction() {
      return jsx.jsxs('a', {
        href: '/qqbot-dashboard',
        target: '_blank',
        rel: 'noreferrer',
        title: PAGE + '（在新标签页打开）',
        'aria-label': PAGE,
        className: 'qqbot-dashboard-entry',
        style: {
          position: 'fixed',
          right: '16px',
          bottom: '16px',
          zIndex: 40,
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
          padding: '6px 10px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
          background: 'var(--dsw-alias-bg-layer-2, rgba(20,20,20,.72))',
          color: 'var(--dsw-alias-label-primary, inherit)',
          textDecoration: 'none',
          fontSize: '12px',
          fontWeight: 600,
          letterSpacing: '0.02em',
          lineHeight: 1,
          boxShadow: '0 2px 10px rgba(0,0,0,.18)',
        },
        children: [
          jsx.jsx('span', { 'aria-hidden': 'true', children: 'QQ 控制台' }),
        ],
      });
    }

    function apply(ctx) {
      // shell.overlay 是覆盖层列表槽位：不会被折叠侧栏的 hover mask 挡住，
      // 用 fixed 定位放在左下角，任何页面都能点。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'qqbot-dashboard',
        order: 20,
      }, QqbotDashboardAction));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
