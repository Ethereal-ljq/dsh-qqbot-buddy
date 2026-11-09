# dsh-qqbot-buddy v2

DSH（DeepSeek Harness）的 QQ 机器人插件 **v2 重写**。相对 v0.22 的四条主线：

1. **独立管理控制台**（`127.0.0.1:6198`，自带 token 登录）——不再挤在 DSH 设置页里。
2. **配置档 + 会话级配置**（Bot → Profile → Scope 三层），一个机器人一份记忆。
3. **工具/技能发现与管理**，并修掉「冷会话 prompt 覆盖导致掉工具」。
4. **SQLite + FTS5** 持久化记忆与知识库（`node:sqlite` 内置模块，零原生依赖）。
5. **每个 bot 独立工作目录**（`<workspace>/bots/<botId>`），靠 `workingDirectory` 服务实现，不再所有 bot 挤一个 cwd。

> 状态：M0（地基）进行中。设计契约见 [docs/DESIGN-v2.md](docs/DESIGN-v2.md)。

## 开发

```bash
npm test          # 单元测试（node:test）
npm run console:build   # 构建控制台前端（web/）
```
