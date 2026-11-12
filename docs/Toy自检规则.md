# Toy 发布自检：四项目共用规则（2026-11-12）

> 规则来源：《Toy 开发者 FAQ》2026-10-23「四、内容规范与合规」+ 发布页包体限制，
> 以及 2026-11 两次真实退件（内容审核 / 包体安全检查）。

`node scripts/check-toy.mjs`（`pnpm toy:check`）在四个项目里是**同一份规则**，只有顶部 `CONFIG` 不同。
`RULES_VERSION` 不一致就说明有人只改了一边。

## 机检的 11 组规则

| # | 规则 | 平台依据 |
|---|---|---|
| 1 | 包根有 `index.html`；入口 ≤ 1 MB；整包 ≤ 50 MB | FAQ 一·15 / 一·6 / 七·5 |
| 2 | 文件后缀在白名单内；无 sourcemap / 系统垃圾文件 | FAQ 七·1 |
| 3 | 无站根绝对路径 | Toy 跑在 `/toy/<slug>/` 子路径下 |
| 4 | 无站外资源加载 | FAQ 四·4 / 四·12 |
| 5 | 代码安全：无 eval / new Function / document.write / XHR / fetch / WebSocket / atob / webdriver / 调试全局 | 2026-11「包体安全检查未通过」 |
| 6 | 内容审核敏感字（按项目性质配置词表） | 2026-11「内容审核未通过」 |
| 7 | 站外 URL 文本只提示不分级 | 库的命名空间不是链接 |
| 8 | `index.html` 有 title / viewport；引用的资源都在包里 | 列表页显示与移动端适配 |
| 9 | 源码无 UGC 原语（textarea / contenteditable / file input / getUserMedia / MediaRecorder） | FAQ 四·5 |
| 10 | 源码无站外链接 | FAQ 四·4 |
| 11 | zip 包根是 `index.html`、无越界路径、后缀在白名单内 | 上传包结构 |

## 第三方基线（knownVendorHits）

第三方库里确实带风险 API，但自研代码用不到、也改不动上游时，允许登记**精确到「文件 + 规则」**的基线，
命中时降级为提示并打印原因。当前登记：

| 项目 | 文件 | 规则 | 原因 |
|---|---|---|---|
| CHAGS | — | — | 无（Phaser Loader 已被 `FEATURE_LOADER` 裁掉） |
| BambooBuddy | `common-*` | atob | zod 的 base64 / JWT 校验实现 |
| mathmindforge | `schemas-*` | atob | 同上 |
| mathmindforge | `vendor-phaser-*` | XHR / atob | Phaser 内置 Loader；该项目 vendor 是上游裁剪产物、没有 vendor-src 可重裁 |
| shfr | — | — | 无 |

## 自动化开关（四项目统一）

`navigator.webdriver` 这类「给无头浏览器开后门」的判断本身就是包体安全风险点，已统一改成构建期开关：

- 生产 / Toy 构建：`VITE_DEBUG_HOOKS` 未定义 → 整段被折叠成 `false`，字符串不进产物；
- e2e 构建：`apps/site/.env.e2e` 里的 `VITE_DEBUG_HOOKS=1`（`--mode e2e`）才打开，`pnpm e2e:dist` 已改成这条命令。

## 仍需人工确认（脚本判不了）

分类别选「游戏」（FAQ 一·13：未成年人自动无法游玩）、封面与图标、slug、可见状态。
