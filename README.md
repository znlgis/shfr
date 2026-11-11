# 山海 · 森之突袭（SHAN HAI: FOREST RAID）

一款**单文件、可离线双击游玩**的山海经题材 3D 第一人称射击游戏（WebGL / Three.js r160）。
标题卡 → 选行者 → 第一人称战斗 → 结算，世界是**明亮卡通的山海古林孤岛**：混沌之气侵入秘境，上古妖物纷纷苏醒。

> 代码、美术、音频全部程序化生成：没有任何外部贴图 / 模型 / 音频文件，除了内联的 three.js。

![标题界面](docs/screenshots/01-title.png)

## 直接游玩

双击打开 **[dist/山海森之突袭_V1.html](dist/山海森之突袭_V1.html)** 即可（约 1.1 MB，浏览器需支持 WebGL2）。

## 玩法

| 操作 | 键位 |
|---|---|
| 移动 | `W A S D` |
| 瞄准 | 鼠标（点击画面锁定指针；无法锁定指针的环境下可按住左键拖动） |
| 射击 | 鼠标左键（按住连发） |
| 装填 | `R` |
| 冲刺（短暂无敌） | `Shift` |
| 跳跃 | `Space` |
| 灵兽技 | `Q` |
| 暂停 | `Esc` / `P` |
| 选行者 | `←` `→` / `1-4`，`Enter` 出发 |
| 音效开关 / 音量 | 标题界面、暂停界面 |

触屏设备会自动显示虚拟摇杆与 开火 / 装填 / 冲刺 / 跳跃 / 灵兽技 按钮。

## 关卡与角色

**8 波推进 + BOSS**
1. 林间异动（鹿蜀、蜈蚣精）→ 2. 妖群来袭（+鸩鸟）→ 3. 古木伏击（木魅、鸩鸟、玄蜂）→ 4. 玄蜂之刺（+九尾狐）→ 5. 百鬼夜行（魑魅、狰、鲛人）→ 6. 凶兽突袭（狰、玄蜂、赤鱬）→ 7. 凶兽镇守（饕餮、巴蛇、魍魉）→ 8. **混沌之核：混沌（两阶段：弹幕 / 瞬移 / 召唤）**

每个波次间会恢复体力与能量；被击败会进入失败结算，通关按分数给 **S / A / B / C / D** 评价。

**4 位可选行者**

| 行者 | 属性 / 灵兽 | 法器 | 被动 / 灵兽技 |
|---|---|---|---|
| 雷公 LEIGONG | 雷 · 夔牛 | 雷光锤（高速直射） | 聚雷：命中积雷气，满 5 层下一发必暴击 · 天雷引（连锁闪电） |
| 句芒 GOUMANG | 木 · 麒麟 | 灵种杖（5 连发） | 春生：脱战 4 秒后回血 · 万物生（回血 + 减速） |
| 祝融 ZHURONG | 火 · 毕方 | 离火铳（范围爆炸） | 余烬：击杀后 2 秒增伤 40% · 焚天业火（范围爆炎） |
| 玄冥 XUANMING | 水 · 玄武 | 玄水枪（穿透） | 每第 5 发双倍并回血 · 玄冥水盾（3 秒无敌） |

## 技术要点

- **单文件构建**：`node build.mjs` 把 three.js、10 个 JS 模块、2 个 CSS 合并成 `dist/*.html`；`node build.mjs --dev` 生成用 `<script src>` 分文件加载的 `dev.html`，改完刷新即可调试。
- **全程序化美术**：18 只山海异兽 / 4 位行者由几何体拼装成模型并顶点色合批（单模型平均 7 draw call），古林由 InstancedMesh 承载 5200 草 / 589 花 / 46 蘑菇等；2D 头像与图标用 Canvas2D 绘制。
- **程序化音频**：WebAudio 合成 24 种音效 + 6 套循环音乐（标题 / 古林 / 战斗 / BOSS / 胜利 / 失败），支持静音、音量、菜单压低。
- **性能**：1280×800 集成场景 draw call ≈ 87（主场景 66 + 武器层 21），场景三角形约 67.5 万，真实 GPU 下约 95fps。

## 工程结构

```
.
├── build.mjs              构建脚本（单文件 / dev 两种产物）
├── package.json           npm scripts（build / dev / test / shot）
├── src/
│   ├── index.html         页面壳（占位符注入 CSS/JS）
│   ├── 10-audio.js        PG.audio  程序化音效与音乐
│   ├── 20-world.js        PG.world  山海古林场景（地形/树/水塘/牌坊/祭坛/粒子）
│   ├── 30-models.js       PG.models 模型库核心（DATA / 4 灵兽 / 4 行者 / DSL / API）
│   ├── 32-beasts.js       14 只妖物 3D 模型（注册进 PG.models）
│   ├── 35-art.js          18 个 2D 图标 + 4 位行者半身像（PG.models.art）
│   ├── 40-util.js         PG.util   通用工具
│   ├── 50-game.js         PG.game   玩家/法器/敌人 AI/波次/BOSS/粒子
│   ├── 80-hud.js          战斗 HUD 与触屏控制
│   ├── 85-ui.js           标题/选角/暂停/结算界面
│   ├── 90-main.js         启动、渲染器、光照、输入、主循环
│   ├── 70-ui.css          全屏界面样式
│   └── 75-hud.css         HUD 样式
├── tests/
│   ├── playtest.mjs       无头 Edge 自动对局验收（25 项检查）
│   ├── shot.mjs           无头截图工具
│   └── *.html             各模块自测页（forest / creatures / beasts / art / audio / ui）
├── vendor/three.min.js    three.js r160（构建时内联）
├── docs/
│   ├── MYTHOLOGY.md       中国神话设计规格（id / 命名 / 配色 / 文案）
│   ├── CONTRACT.md        模块契约（API / 分工 / 美术规范）
│   └── screenshots/       验收截图
└── dist/                  构建产物（可直接双击游玩）
```

## 构建与验收

```bash
npm run build        # -> dist/山海森之突袭_V1.html
npm run dev          # -> dev.html（分文件加载，调试用）
npm test             # 无头 Edge 自动对局验收（需要安装 Edge）
```

自动化验收（`tests/playtest.mjs`，CDP 驱动，零依赖）覆盖：启动 → 标题 → 键盘进入选角 → 出发 →
战斗命中/击杀/得分 → 受击掉血 → Esc 暂停/继续 → 失败结算 → 重开归零 → 真实打通 8 波 → 胜利结算，
同时统计 draw call / 三角形 / 帧时间并收集所有 JS 错误口径。

## 截图

| | |
|---|---|
| ![选角](docs/screenshots/02-select.png) | ![战斗](docs/screenshots/03-battle.png) |
| 四选一选角 | 古林战斗与 HUD |
| ![暂停](docs/screenshots/04-pause.png) | ![胜利](docs/screenshots/05-win.png) |
| 暂停 | 胜利结算 |

![山海异兽模型总览](docs/screenshots/07-creatures.png)

## 已知说明

- 在无头软件渲染器（SwiftShader）下，`InstancedMesh` + 顶点色的草会出现洋红/青色三角伪影，这是渲染器缺陷；真实 GPU 下颜色正常（已 A/B 验证）。
- 无头截图若在 CSS 入场动画结束前抓取，可能少显示部分界面元素；真实浏览器无此问题。

## License

MIT（见 [LICENSE](LICENSE)）。
