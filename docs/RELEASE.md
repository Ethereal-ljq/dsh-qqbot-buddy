# 发布指南

面向维护者。目标：一次发布从「改完代码」到「npm 上能装、装完能跑」只走一条可复现的路径。

## 0. 版本与通道

| 阶段 | 版本号 | npm 标签 | 安装命令 |
| --- | --- | --- | --- |
| 预发布（当前） | `1.0.0-alpha.N` | 发布到 `next`，验收后提升到 `latest` | `dsh plugin add dsh-qqbot-buddy` 或 `…@next` |
| 稳定版 | `1.0.0` | `latest` | `dsh plugin add dsh-qqbot-buddy` |

- `package.json` 里的 `publishConfig.tag` 固定为 `next`：`npm publish` 先只动 `next`，**不会**误伤 `latest`。
  跑完 §4 的验收后再提升：`npm dist-tag add dsh-qqbot-buddy@<版本> latest`。
  这样 `latest` 恒等于「验证过的最新版」，`next` 用来放刚发布还没验收的构建。
- `engines.dsh` 是兼容契约：改了依赖的宿主能力就同步改这个范围，dsh 会在加载前校验并给出可读的拒绝信息。
- **分支**：`v2` 是仓库默认分支与唯一开发线；v1 线已归档为 `v1-legacy` 分支 + `v1-archive` 标签（只读）。
  发布提交与 tag 都推到 `v2`。
- 版本号只在 `package.json` 里维护；`lib/version.js` 运行时读它，控制台和 `/api/state` 的版本号随之变化。

## 1. 发布前检查（缺一不可）

```bash
# 1) 控制台前端必须重新构建，dist 是随包发布的产物
npm run console:build

# 2) 单元测试（会顺带校验发布包清单、README 链接）
npm test

# 3) 独立环境安装验收：npm pack → 全新 DSH_HOME → 起实例 → 控制台 + dsh Web 全链路
npm run verify:standalone

# 4) 看会打进包里的文件（有没有多带测试、少带 dist / 模板）
npm pack --dry-run
```

`verify:standalone` 的常用参数：

```bash
node scripts/verify-standalone-install.mjs --keep                 # 保留临时目录，方便看日志
node scripts/verify-standalone-install.mjs --skip-boot            # 只验包内容与安装（不启动）
node scripts/verify-standalone-install.mjs --spec dsh-qqbot-buddy@next   # 验收线上 npm 包
node scripts/verify-standalone-install.mjs --root /tmp/my-check --console-port 6300 --web-port 3400
```

它做了什么（也是「独立安装」的定义）：

1. 用隔离的 `HOME`（npm / pnpm 缓存与 store 都在临时目录）`npm pack` 出发布包；
2. 校验包内容：必需文件齐全、不含 `test/` 与源码依赖、`web/dist` 与仓库当前构建一致、自带模板示例；
3. 在全新 `DSH_HOME` 里执行 `dsh plugin --profile web add <tarball>`（用户真实安装路径），
   校验 profile 自动登记 bundle、运行期依赖（`ws` / `qrcode` / `@tencent-connect/qqbot-nodejs`）装好；
4. `--dump-config` 校验插件与 agent preset 进树、没有兼容性告警；
5. 起一个隔离实例（独立 dataDir / workspaceRoot / 端口），验证控制台鉴权、`/api/state`、工具发现、配置档读写、
   首页静态资产来自安装包、`/qqbot-dashboard` 302 跳转、dsh Web boot 图里带客户端半；
6. 报告默认写到 `<root>/standalone-report.json`（跑完会清理临时目录，要留证据就用 `--json <文件>`），全绿才算通过。

## 2. 文档与截图

发布前确认：

- `README.md` 里的版本号、安装命令、功能表都是当期状态；**README 不内嵌图片**（npm 页面保持纯文本），
  截图统一放在 `docs/SCREENSHOTS.md` 用相对路径引用，两处都由 `test/package-manifest.test.js` 校验。
- `CHANGELOG.md` 补上本版本条目（新增 / 改进 / 修复 / 打包）。
- 文档改动同步 `docs/USER-GUIDE.md` 对应章节（安装、升级、排障）。

控制台截图重拍：起一个隔离实例（独立 `DSH_HOME` / dataDir / 端口），通过控制台 API 灌一点演示数据
（机器人、配置档、知识、记忆、TTS 供应商、自定义模板），再用 Playwright 逐页截图（WSL 下 headless 即可）：

```bash
npm run console:build
NODE_PATH=$(npm root -g) node your-demo-shots.mjs    # 自己的演示数据 + 截图脚本，放 .work/ 里即可，不进 git
```

截图存到 `docs/images/`，文件名沿用 `docs/SCREENSHOTS.md` 里已有的名字，避免改文档。
README 本身不内嵌图片（npm 页面保持纯文本），新增截图只加到 `docs/SCREENSHOTS.md`。

## 3. 提交、打标签、发布

```bash
# 版本号
npm version 1.0.0-alpha.6 --no-git-tag-version
# 提交
git add -A && git commit -m "chore(release): 1.0.0-alpha.6"
git tag v1.0.0-alpha.6
git push origin v2 --tags

# 发布（publishConfig.tag = next，自动发到 next；prepublishOnly 会再跑一遍单元测试）
npm publish
```

发布时 `prepublishOnly` 会执行 `npm test`；它不跑独立安装验收，那一步请在发布前手动做完。

> `npm publish` 的输出会写 `with tag latest`，那是 npm 的配置层默认值，**不代表实际发到的标签**：
> 真正写进 registry 的 dist-tag 来自 `publishConfig.tag`（npm 11 已用本地假 registry 抓 PUT 请求验证过：
> `"dist-tags": {"next": "1.0.0-alpha.6"}`）。想自己复核可以起一个本地假 registry 抓包：
>
> ```bash
> npm publish --ignore-scripts --registry http://127.0.0.1:4873/ --//127.0.0.1:4873/:_authToken=fake
> ```

## 4. 发布后验证

```bash
npm view dsh-qqbot-buddy dist-tags --json          # next 是否指向新版本
npm view dsh-qqbot-buddy version engines --json    # 元数据是否带上

# 用安装器干跑一遍（不写盘）
npx -y --package=dsh-qqbot-buddy@next dsh-qqbot-buddy-install --dry-run

# 端到端：直接验收 npm 上的包（会真的装进临时 DSH_HOME）
node scripts/verify-standalone-install.mjs --spec dsh-qqbot-buddy@next
```

两个实测踩过的坑：

- **刚发布时 `@next` 可能仍解析到旧版本**：npm registry 要几分钟才把新版本放进 packument，pnpm 还会缓存元数据。
  装的时候用精确版本（`dsh plugin --profile <名字> add dsh-qqbot-buddy@1.0.0-alpha.6`）最稳，或者等几分钟再装。
- **`pnpm add` 会顺手清理 profile 里没写进 `package.json` 的残留包**（extraneous）。
  如果用户的 node_modules 手动塞过东西，装完会看到一串 `-` 的删除日志；这些包本来也不受 dsh 管理，
  但发布说明里最好提醒一句「装完看一眼被清掉的包」。
- 新版本太新时 pnpm 的供应链策略会给 `pnpm-workspace.yaml` 追加 `minimumReleaseAgeExclude` 条目，属正常现象。

全部通过后把这一版提升为 `latest`（普通安装就能拿到）：

```bash
npm dist-tag add dsh-qqbot-buddy@1.0.0-alpha.6 latest
npm view dsh-qqbot-buddy dist-tags --json     # latest 与 next 应指向同一版本
npm view dsh-qqbot-buddy version              # 不带标签时解析到的版本
```

最后在 GitHub 上写 Release：摘要用 CHANGELOG 的对应小节，附安装命令与兼容范围。

## 5. 回滚与补救

| 情况 | 处理 |
| --- | --- |
| 只是标错了标签 | `npm dist-tag add dsh-qqbot-buddy@<正确版本> next` |
| 版本有问题但已发布 | `npm deprecate dsh-qqbot-buddy@<版本> "原因，请升级到 @next 的最新版本"`，然后尽快发修复版 |
| 用户已升级、数据库已迁移 | 迁移是向前单向的：让用户回滚前先恢复发布前备份（`<dataDir>` + `<workspace>/bots`） |
| 需要摘掉某个 dist-tag | `npm dist-tag rm dsh-qqbot-buddy next` 后重新指向正确版本 |

npm 不支持删除已发布版本（24 小时内可 unpublish，但不要依赖它），所以**发布前的独立安装验收是唯一的防线**。

## 6. 切稳定版

```bash
npm version 1.0.0 --no-git-tag-version
npm test && npm run verify:standalone
npm publish                     # 先发 next
npm dist-tag add dsh-qqbot-buddy@1.0.0 latest   # 验收后再提升
```

同时更新：

- `package.json` 的 `publishConfig.tag` 改为 `latest`（或保留 `next`、只在发布命令上带 `--tag latest`）；
- README「快速开始」与用户手册里的安装命令去掉 `@next`；
- `engines.dsh` 按稳定版 dsh 的实际兼容范围重写。

## 7. 常见问题

- **`dsh plugin add` 报 pnpm 找不到**：dsh 的插件管理依赖 pnpm，先 `npm i -g pnpm` 或在 PATH 里提供。
- **装完 dsh 说插件 incompatible**：`engines.dsh` 与运行中的 dsh 版本不匹配；
  要么升级 dsh，要么 `dsh plugin --profile <名字> allow-version dsh-qqbot-buddy@<版本> --dsh-version <dsh 版本> --accept-risk`。
- **控制台白屏 / 样式错乱**：多半是 `web/dist` 没重新构建就打包了；`npm run console:build` 后重新 `npm pack`。
- **独立安装验收里 `dsh Web 401`**：那是测试脚本没带 cookie 跟着 302 走；脚本已用自带 cookie jar 处理，
  手工验证时记得用控制台「dsh Web ↗」给出的带 token 链接。
