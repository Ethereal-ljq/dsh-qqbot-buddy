/**
 * dsh-qqbot-buddy — 客户端半（浏览器 bundle）。
 *
 * dsh 的客户端模块系统加载本文件（package.json：`exports["./client"]` +
 * `dsh.client.platform = "web"`），把它当成一个前端 Cordis 插件来装配。
 *
 * 贡献内容：dsh Web 会话头部「…」弹出菜单里的一项「QQBot 大屏」，与官方
 * 「复制会话为 Markdown / 下载 Session 日志 / 在应用中打开 / 反馈」并列。
 * 点击后新标签页打开 /qqbot-dashboard（Host 半注册的同源 302 路由），
 * 由 Host 读取 console 配置跳到真正的控制台地址（默认 http://127.0.0.1:6198/）。
 *
 * 为什么用客户端模块而不是往 index.html 注入 DOM 脚本：
 *   dsh 0.2.x 的会话头部按钮已经收进「…」弹出菜单，旧的 DOM 选择器
 *   （[data-open-target="directory"]）在新版界面里不再存在；
 *   官方给外部插件的稳定扩展点是 Client 的 contextMenus（target=sessionHeader）。
 *
 * 约束：工厂里只能 require 模块表里的基础模块（react），不要 import 宿主实现。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qqbot-buddy',
  factory: (require) => {
    var module = { exports: {} };
    var React = require('react');

    /** 会话头部菜单项 id / 图标 slot key / 控制台跳转路由。 */
    var MENU_ID = 'qqbot-buddy.console';
    var ICON_KEY = 'qqbot-buddy.console';
    var ROUTE = '/qqbot-dashboard';

    /** 大屏图标（16×16，currentColor 描边，跟随菜单深浅色主题）。 */
    function ConsoleIcon() {
      return React.createElement(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('rect', {
          x: 1.6, y: 2.6, width: 12.8, height: 8.2, rx: 1.4,
          stroke: 'currentColor', strokeWidth: 1.3,
        }),
        React.createElement('path', {
          d: 'M5.6 13.8h4.8M8 10.8v3',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }),
        React.createElement('path', {
          d: 'M4.4 8.7V7.9M6.6 8.7V6.2M8.8 8.7V6.9M11 8.7V5.4',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
        }),
      );
    }

    /**
     * 只在新标签页打开控制台，绝不在当前页跳转。
     *
     * 不用 window.open：带 noopener 时按规范返回 null，无法区分「弹窗被拦」与
     * 「正常打开」，之前据此写的 current-page 兜底会在每次点击时把当前页也跳走。
     * 改为 <a target="_blank" rel="noopener noreferrer"> 点击：必然只开新标签页，
     * 且不会被窗口引用语义坑到。菜单项本身来自用户点击手势，不受弹窗拦截影响。
     */
    function openConsole() {
      var link = document.createElement('a');
      link.href = ROUTE;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      (document.body || document.documentElement).appendChild(link);
      link.click();
      link.remove();
    }

    /**
     * 客户端插件体：注册图标 + 会话头部菜单项。
     * @param {object} ctx - 客户端 Cordis 上下文（含 slots / contextMenus 服务）。
     */
    function apply(ctx) {
      ctx.slots.inject('contextMenu.icon', function* () {
        yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, ConsoleIcon);
      });
      ctx.effect(() => ctx.contextMenus.register({
        id: MENU_ID,
        target: 'sessionHeader',
        // 官方：复制/下载 order=100，在应用中打开 order=500，反馈 order=600。
        // 放在 500 之后、600 之前，与「在应用中打开」同组显示。
        order: 550,
        resolve: function () {
          return [{
            id: 'open',
            label: 'QQBot 大屏',
            icon: { key: ICON_KEY },
            run: openConsole,
          }];
        },
      }), 'qqbot-buddy: session header console entry');
    }

    module.exports = { apply: apply, inject: ['slots', 'contextMenus'] };
    return module.exports;
  },
});
