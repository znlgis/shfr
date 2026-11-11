# 山海 · 森之突袭 · 项目契约（所有 Agent 必读）

交付物：单文件 HTML 游戏 `dist/山海森之突袭_V1.html`（内含 three.js r160 + 全部代码 + 全部 CSS，双击即玩、可离线）。
工程根目录：`D:\self\code\zgshsj`（MSYS 路径 `/d/self/code/zgshsj`）。
**题材：中国神话（山海经 / 上古神话），不得含任何旧 IP 名称、角色或造型元素。设计真源：`docs/MYTHOLOGY.md`（先读它）。**

## 1. 构建方式

源码分模块写在 `./src/`，由 `node build.mjs` 拼成单文件交付物（three.min.js 内联 + CSS 内联 + 按顺序内联 JS）。
另外 `node build.mjs --dev` 会生成 `./dev.html`（用 <script src> 引用各模块，改完刷新即见，调试用）。

构建顺序（不可改）：
```
vendor/three.min.js -> src/10-audio.js -> src/20-world.js -> src/30-models.js
                    -> src/32-beasts.js -> src/35-art.js -> src/40-util.js -> src/50-game.js
                    -> src/80-hud.js -> src/85-ui.js -> src/90-main.js
CSS: src/70-ui.css, src/75-hud.css（后者最后加载）
```

## 2. 文件所有权（严格分工，禁止修改他人文件）

| 文件 | 负责人 | 内容 |
|---|---|---|
| src/10-audio.js | 队友 world | WebAudio 程序化音效 + 音乐（TIMBRES 改 thunder/wood/fire/water） |
| src/20-world.js | 队友 world | 山海古林场景：地形/树/花/蘑菇/水塘/牌坊/祭坛/石鼎/光柱/萤火虫/天空/雾 |
| src/30-models.js | 队友 models | 3D 模型库核心：DATA / 4 灵兽 / 4 行者 / DSL / 注册口 / PG.models API |
| src/32-beasts.js | 队友 beasts | 14 只妖物 3D 模型（通过 PG.models._dsl 构建，末尾 registerBuilders） |
| src/35-art.js | 队友 art | 2D 图标（18）与行者头像（4），挂到 PG.models.art |
| src/40-util.js | Lead | 通用工具（基本不动） |
| src/50-game.js | Lead | 角色配置、法器、敌人 AI、波次、计分、粒子、相机 |
| src/80-hud.js | 队友 ui | 战斗 HUD 与触屏控制 |
| src/85-ui.js | 队友 ui | 标题/选角/暂停/结算界面逻辑与文案 |
| src/70-ui.css | 队友 ui | 全屏界面样式（--sh-* 变量、铜钱图标） |
| src/75-hud.css | 队友 ui | HUD 样式 |
| src/90-main.js | Lead | 启动、渲染器、光照、输入、主循环、标题展示台 |
| build.mjs / src/index.html | Lead | 构建与页面壳（标题、启动文案） |
| tests/* | 见任务卡 | 自测页与验收脚本 |
| README.md / docs/CONTRACT.md / docs/MYTHOLOGY.md / package.json | Lead | 文档与元信息 |

只写自己的文件。要别人的改动，先在本文件/任务里说明并找 Lead。

## 3. 运行时全局命名空间 `window.PG`

所有模块挂在 `window.PG` 下，IIFE 包裹，禁止 ES module 语法（因为是拼接进单 `<script>`）。
依赖方向：10-audio / 20-world / 30-models / 32-beasts / 35-art 不依赖业务模块；50-game 可调用 audio/world/models/ui；85-ui 只管 DOM 与自己；90-main 负责接线。
所有跨模块调用必须 `try { } catch {}` 保护或先判断存在，避免一个模块挂了全游戏白屏。

### 3.1 PG.util（Lead 提供，src/40-util.js）
```js
PG.util = { clamp, lerp, damp, smoothstep, rand, randInt, pick, chance, TAU,
  dirXZ(fromX,fromZ,toX,toZ) -> Vector2, disposeTree(obj), project(v, camera, w, h), now() }
```

### 3.2 PG.audio（world 实现）
```js
PG.audio = { init(), sfx(name, opts), music(cue), setMuted(bool), isMuted(), setVolume(v), getVolume(), setDuck(v) }
```
必须支持的 sfx 名（缺一个就静音返回，不许抛错）：
`ui_hover ui_click ui_back select shot shot_alt reload empty hit crit kill hurt heal wave jump dash boss_roar win lose levelup combo orb spawn amb`
`opts.weapon / opts.type` 传角色属性键（lei/mu/huo/shui），音色映射见 MYTHOLOGY.md。

### 3.3 PG.world（world 实现）
```js
PG.world = {
  build(scene, THREE, opts) -> world
}
// world = { group, radius: 62, update(dt,t,camera), groundY(x,z),
//   colliders: [{x,z,r}], spawnPoints: [{x,z}] (>=12), landmarks: [{x,z,type}],
//   sunDir: Vector3, reset() }
// landmarks type: 'altar' | 'pond' | 'ring' | 'rock'（原 'shrine' 改名 'altar'）
```

### 3.4 PG.models（models / beasts / art 实现）
```js
PG.models = {
  CREATURES: [18 ids], TRAINERS: [4 ids],
  has(id), info(id) -> {id,cn,en,type,scale,kind},   // kind: 'starter'|'enemy'|'elite'|'boss'|'trainer'
  make(id) -> {group,height,radius,update(dt,t)},     // 18 只异兽
  makeTrainer(id) -> {group,height,update,handAnchor},// 4 位行者（站立，脚 y=0，面向 -Z）
  portrait(id,size) -> canvas, icon(id,size) -> canvas,
  stats(id), silhouetteColor(id), warmup(ids),
  registerBuilders(map),                              // 32-beasts.js 注入 14 只妖物
  _dsl: { Builder, SPH, SPH_HI, CONE, CYL, BOX, HEMI, TORUS, CAPSULE, ICO,
          leafGeo, boltGeo, scytheGeo, capChain, addEye, addEyes, addSmile,
          addOpenMouth, addFangs, addTeethRow, addCheeks, addClaws, addFoot,
          finishModel, quatY, TAU, PI },
  art: { icon(id,size), portrait(id,size), has(id) }  // 35-art.js 挂载
}
```
id / 名称 / 类型 / 高度半径一律以 `docs/MYTHOLOGY.md` 第 2、3 节为准。
模型规范：纯程序化（球/胶囊/圆环/锥/圆柱/盒 + MeshStandardMaterial），不用外部贴图；饱和卡通配色；**脚底 y=0，朝向 -Z**；`update(dt,t)` 做呼吸/翅膀/尾巴等小动画。
高度：小型 0.6~0.9，中型 0.9~1.5，饕餮 2.2，混沌 1.9，行者 1.8。

### 3.5 PG.ui（ui 实现，签名不变）
```js
PG.ui = { mount(rootEl), screen(name), setCharacters(list), on(evt,fn), hud(state),
  banner(title,sub,ms), toast(text,ms), subtitle(who,text,ms), hitmarker(kind),
  damageFrom(angleRad), killfeed(text,kind), damageNumber(sx,sy,text,kind),
  setCrosshair(v,spread), setAmmoWarn(v), setObjectives(list), fps(v), isTouch(),
  setPlayerCard(card), hudVisible(v), setResult(r) }
```
`setCharacters(list)` 每项：`{ id, cn, en, type:'lei'|'mu'|'huo'|'shui', color, weapon, passive, ult,
  stats:{hp,dmg,rate,spd}, portrait:canvas, partner, partnerCn, partnerIcon:canvas }`
`hud(state)` 字段不变：`{ hp,hpMax,wave,waveTotal,enemiesLeft,score,combo,comboMax,ammo,ammoMax,
  reserve,weaponName,weaponColor,reloading,reloadT,dashCd,dashMax,boss:{name,hp,hpMax}|null,charge,time,fps }`

### 3.6 主循环契约（src/90-main.js，Lead）
`PG.game.start(characterId)` 开始一局；`PG.game.pause()/resume()/restart()`；`PG.game.state` 为状态对象。

## 4. 美术与风格（山海国风，明亮）

- 明亮、饱和、圆润、可爱；主色见 MYTHOLOGY.md 第 7 节；描边鎏金 #e8b33a、强调朱砂 #d0432e。
- 中国神话特征：云纹、雷纹、青铜纹、鳞片、羽翎、角、玉饰、铜钱、朱砂绳；**不要**日式神社牌楼/灯笼、旧 IP 的球状图标与造型。
- UI：白色/半透明白圆角卡片 + 3px 鎏金描边 + 柔阴影 + 粗圆体字；按钮有按压位移；数字用大号粗体。
- 字体栈：`'PingFang SC','Microsoft YaHei','YouYuan','幼圆',system-ui,sans-serif`，标题 900 字重 + 字距。

## 5. 自测（每个负责人必须做）

本机可直接跑无头 Edge 截图（Windows 路径，别用 /d/ 形式）：
```bash
cd /d/self/code/zgshsj
node --check src/<你的文件>.js
node build.mjs --dev
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader \
  --hide-scrollbars --window-size=1280,800 --virtual-time-budget=8000 \
  --screenshot='D:\self\code\zgshsj\_shots\<name>.png' \
  'file:///D:/self/code/zgshsj/dev.html'
```
然后用 read_image 看截图，确认没有黑屏/报错/错位。自建单元测试页放 `./tests/<your-module>.html`（归属见任务卡）。

## 6. 验收

Lead 集成后跑整局自动验收 + 截图；交付物必须：双击打开即显示标题界面 → 选行者 → 进入古林 → 能移动射击 → 妖物来袭 → 有 HUD/音效 → 死亡/胜利结算 → 可重开。全仓禁用词 0 次（见 MYTHOLOGY.md 顶部清单）。

## 7. 世界观与设计（摘要）

**标题**：山海 · 森之突袭 ｜ SHAN HAI: FOREST RAID
**一句话**：混沌之气侵入山海秘境，上古妖物纷纷苏醒。你作为行者，带着灵兽深入古林，用法器击退妖物，直捣山海之眼。
**流程**：启动加载 → 标题（实时古林背景）→ 选行者（4 选 1）→ 古林战斗（8 波，第 8 波 BOSS 混沌）→ 结算。
四位行者：雷公（lei，灵兽夔牛）、句芒（mu，麒麟）、祝融（huo，毕方）、玄冥（shui，玄武）。
十八异兽与八波阵容、对白、配色：见 `docs/MYTHOLOGY.md` 第 2~6 节。