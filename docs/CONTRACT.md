# 宝可梦森林射击 · 项目契约（所有 Agent 必读）

交付物：单文件 HTML 游戏 `D:\self\ai-work\dsh-work\宝可梦森之突袭_V1.html`（内含 three.js r160 + 全部代码 + 全部 CSS，双击即玩、可离线）。

工程根目录：`D:\self\code\zgshsj`（MSYS 路径 `/d/self/code/zgshsj`）。

## 1. 构建方式

源码分模块写在 `./src/`，由 `node build.mjs` 拼成单文件交付物（three.min.js 内联 + CSS 内联 + 按顺序内联 JS）。
另外 `node build.mjs --dev` 会生成 `./dev.html`（用 <script src> 引用各模块，改完刷新即见，调试用）。

构建顺序（不可改）：
```
vendor/three.min.js  ->  src/10-audio.js  ->  src/20-world.js  ->  src/30-models.js
                     ->  src/40-util.js   ->  src/50-game.js   ->  src/85-ui.js  ->  src/90-main.js
CSS: src/70-ui.css
```

## 2. 文件所有权（严格分工，禁止修改他人文件）

| 文件 | 负责人 | 内容 |
|---|---|---|
| src/10-audio.js | 队友 audio | WebAudio 程序化音效 + 音乐 |
| src/20-world.js | 队友 forest | 宝可梦森林场景：地形/树/花/蘑菇/光柱/萤火虫/天空/雾 |
| src/30-models.js | 队友 creatures | 宝可梦与训练家程序化 3D 模型库 + 2D 头像 |
| src/40-util.js | Lead | 通用工具 |
| src/50-game.js | Lead | 玩家控制、武器、敌人 AI、波次、计分、粒子、相机 |
| src/85-ui.js | 队友 ui | 标题/选角/HUD/暂停/结算等全部 DOM 界面逻辑 |
| src/70-ui.css | 队友 ui | 上述界面的全部样式 |
| src/90-main.js | Lead | 启动、主循环、模块接线 |
| build.mjs / src/index.html | Lead | 构建 |

只写自己的文件。要别人的改动，先读契约，改契约请找 Lead。

## 3. 运行时全局命名空间 `window.PG`

所有模块挂在 `window.PG` 下，IIFE 包裹，禁止 ES module 语法（因为是拼接进单 `<script>`）。
依赖方向：10-audio / 20-world / 30-models 不依赖其他业务模块；50-game 可以调用 audio/world/models；85-ui 只管 DOM 与自己；90-main 负责接线。
所有跨模块调用必须 `try { } catch {}` 保护或先判断存在，避免一个模块挂了全游戏白屏。

### 3.1 PG.util（Lead 提供，src/40-util.js）
```js
PG.util = {
  clamp(v,a,b), lerp(a,b,t), damp(a,b,lambda,dt), smoothstep(e0,e1,x),
  rand(a,b), randInt(a,b), pick(arr), chance(p), TAU,
  // 视线角度：返回 {x,z} 单位向量
  dirXZ(fromX,fromZ,toX,toZ) -> THREE.Vector2 归一化,
  disposeTree(obj),  // 递归释放 geometry/material
  now()
}
```

### 3.2 PG.audio（src/10-audio.js 实现）
```js
PG.audio = {
  init(),                    // 首次用户手势后调用；内部幂等；创建 AudioContext
  sfx(name, opts),           // opts: {vol=1, rate=1, pan=0, delay=0}
  music(cue),                // 'title' | 'forest' | 'battle' | 'boss' | 'win' | 'lose' | 'none'
  setMuted(bool), isMuted() -> bool
  setVolume(v), getVolume() -> 0..1
  setDuck(v)                 // 菜单时压低背景音乐（0..1）
}
```
必须支持的 sfx 名（缺一个就静音返回，不许抛错）：
`ui_hover ui_click ui_back select shot shot_alt reload empty hit crit kill hurt heal wave jump dash boss_roar win lose levelup combo orb spawn amb`

### 3.3 PG.world（src/20-world.js 实现）
```js
PG.world = {
  build(scene, THREE, opts) -> world
}
// world = {
//   group: THREE.Group,          // 已加入 scene 的根节点
//   radius: 62,                  // 可活动半径（圆形场地）
//   update(dt, t, camera),       // 每帧动画（风、光柱、萤火虫、水面）
//   groundY(x, z) -> number,     // 地面高度（只要不平地就返回对应高度，默认 0）
//   colliders: [{x, z, r}],      // 圆柱碰撞体（树干/岩石），玩家与敌人绕开
//   spawnPoints: [{x, z}],       // 敌人刷新点（在场地边缘一圈，至少 12 个）
//   landmarks: [{x,z,type}],     // 神龛、蘑菇圈、水塘等（type: 'shrine'|'pond'|'ring'|'rock'）
//   sunDir: THREE.Vector3,       // 主光方向（用于手部/角色受光）
//   reset()                      // 重开时复位动态元素
// }
```

### 3.4 PG.models（src/30-models.js 实现）
```js
PG.models = {
  make(id) -> { group, height, update(dt, t), radius },   // 宝可梦 3D 模型
  makeTrainer(id) -> { group, height, update(dt, t) },     // 训练家 3D 模型（站立，脚在 y=0，面向 -Z）
  portrait(id, size) -> HTMLCanvasElement,                 // 训练家 2D 头像（方形，宝可梦风格）
  icon(id, size) -> HTMLCanvasElement,                     // 宝可梦 2D 图标
  info(id) -> { id, cn, en, type, scale, kind },           // kind: 'starter'|'enemy'|'elite'|'boss'
  has(id) -> bool
  POKEMON: [ ...ids ], TRAINERS: [ ...ids ]
}
```
必须实现的宝可梦 id：
`pikachu bulbasaur charmander squirtle caterpie weedle pidgey oddish beedrill scyther gastly gengar snorlax mewtwo onix meowth jigglypuff psyduck`
必须实现的训练家 id：`t_bolt t_leaf t_ember t_tide`（雷/草/火/水四位训练家）。
模型规范：纯程序化（球/胶囊/圆环/锥/圆柱/盒 + MeshStandardMaterial），不用外部贴图；饱和卡通配色；**脚底在 y=0，朝向 -Z**；`update(dt,t)` 做呼吸/耳朵/尾巴等小动画；高度：小型 0.6~0.9，中型 1.0~1.5，卡比兽 2.2，超梦 1.9，训练家 1.8。

### 3.5 PG.ui（src/85-ui.js + 70-ui.css 实现）
```js
PG.ui = {
  mount(rootEl),                       // 创建所有 DOM（rootEl = #ui），只调一次
  screen(name),                        // 'boot'|'title'|'select'|'game'|'pause'|'dead'|'win'|'hidden'
  setCharacters(list),                 // 选角数据：见下
  on(evt, fn),                         // 'start'|'select'|'launch'|'resume'|'restart'|'quit'|'mute'
  hud(state),                          // 每帧更新（内部节流），state 见下
  banner(title, sub, ms),              // 居中大字（波次提示）
  toast(text, ms),
  subtitle(who, text, ms),             // 底部对白（伙伴宝可梦说话）
  hitmarker(kind),                     // 'hit'|'crit'|'kill'
  damageFrom(angleRad),                // 受击方向弧（相对屏幕中心）
  killfeed(text, kind),
  damageNumber(sx, sy, text, kind),    // 屏幕坐标飘字，'dmg'|'crit'|'heal'
  setCrosshair(v, spread),             // v: 0 隐藏 / 1 显示 / 2 开镜；spread: 0..1
  setAmmoWarn(v),                      // 低弹量闪烁
  setObjectives(list),                 // 左上目标清单
  fps(v),
  isTouch() -> bool
}
```
`setCharacters(list)` 每项：
```js
{ id:'t_bolt', cn:'雷恩', en:'RAIDEN', type:'electric', color:'#ffd93d',
  weapon:'雷电发射器', passive:'连锁闪电：命中叠加电荷，满层暴击',
  stats:{ hp:100, dmg:22, rate:0.16, spd:1.06, range:1 },   // 0..1 之外的显示用
  portrait: HTMLCanvasElement }
```
`hud(state)` 字段：
```js
{ hp, hpMax, wave, waveTotal, enemiesLeft, score, combo, comboMax,
  ammo, ammoMax, reserve, weaponName, weaponColor, reloading, reloadT,
  dashCd, dashMax, boss:{name,hp,hpMax} | null, charge:0..1, time, fps }
```

### 3.6 主循环契约（src/90-main.js，Lead 实现）
`PG.game.start(characterId)` 开始一局；`PG.game.pause()/resume()/restart()`；`PG.game.state` 为状态对象。

## 4. 美术与风格（宝可梦整体风格，明亮）

- 明亮、饱和、圆润、可爱：青草绿 `#7ec850` `#4e9c3f`，阳光黄 `#ffd93d`，天蓝 `#9fe0ff` `#3aa0e8`，白 `#ffffff`，墨蓝 `#24313f`，强调红 `#e8453c`。
- 卡通比例：大头、短肢、圆角；高光边缘（可用 SECOND 光源/自发光 rim）；不要写实、不要灰暗、不要脏污。
- UI：白色/半透明白圆角卡片 + 3px 黄色描边 + 柔阴影 + 粗圆体字；按钮有按压位移；数字用大号粗体。
- 字体栈：`'PingFang SC','Microsoft YaHei','YouYuan','幼圆',system-ui,sans-serif`，标题用 900 字重 + 字距。

## 5. 自测（每个队友必须做）

本机可直接跑无头 Edge 截图（Windows 路径，别用 /d/ 形式）：
```bash
cd /d/self/code/zgshsj
node build.mjs --dev
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader \
  --hide-scrollbars --window-size=1280,800 --virtual-time-budget=8000 \
  --screenshot='D:\self\code\zgshsj\_shots\<name>.png' \
  'file:///D:/self/ai-work/dsh-work/./dev.html'
```
然后用 read_image 看截图，确认没有黑屏/报错。自建单元测试页放 `./tests/<your-module>.html` 也行。
控制台错误可加 `--enable-logging=stderr --v=1` 观察，或页面里把 error 画到 DOM 上。

## 6. 验收

Lead 集成后跑整局截图 + 自动脚本检查；交付物必须：双击打开即显示标题界面 → 选角 → 进入森林 → 能移动射击 → 敌人来袭 → 有 HUD/音效 → 死亡/胜利结算 → 可重开。
## 7. 游戏设计（统一的世界观与文案，UI/音频/模型都对齐这里）

**标题**：《宝可梦 · 森之突袭》 | POKÉMON: FOREST RAID
**一句话**：森林深处涌出暗影能量，野生宝可梦陷入狂暴。你作为训练家，带着伙伴宝可梦深入森之秘径，用招式发射器击退它们，直捣暗影核心。

**流程**：启动加载 → 标题界面（实时森林背景）→ 选择训练家（4 选 1）→ 进入森林战斗（8 波，第 8 波是 BOSS）→ 结算（胜利/失败）。

**四位可选训练家**（id / 中文名 / 英文 / 属性 / 伙伴 / 武器 / 被动）：
| id | 中文 | 英文 | 属性 | 伙伴 | 武器 | 被动 |
|---|---|---|---|---|---|---|
| t_bolt | 雷恩 | RAIDEN | 电 electric | 皮卡丘 pikachu | 电光弹（射速快、弹道直） | 静电场：命中累加电荷，满 5 层下一次必定暴击 |
| t_leaf | 芽衣 | MAY | 草 grass | 妙蛙种子 bulbasaur | 种子散弹（一次 3 发扩散） | 光合作用：脱战 4 秒后缓慢回血，回复速度 ×1.5 |
| t_ember | 炎武 | BLAZE | 火 fire | 小火龙 charmander | 火花炮（高伤、射速慢、范围灼烧） | 余烬：击杀后 2 秒内伤害 +40% |
| t_tide | 波琳 | MARINA | 水 water | 杰尼龟 squirtle | 水压枪（穿透、弹道直） | 潮汐：每第 5 发伤害 ×2 且命中回复 2 HP |

**敌人阵容**（由 models 提供模型，game 负责行为）：
- 小怪：caterpie 绿毛虫、weedle 独角虫、pidgey 波波（会飞扑）、oddish 走路草
- 中怪：beedrill 大针蜂（快、远程毒针）、scyther 飞天螳螂（冲刺斩）、meowth 喵喵（狡诈走位）、jigglypuff 胖丁（唱歌减速）
- 特殊：gastly 鬼斯（飘浮、半透明）、gengar 耿鬼（瞬移）、psyduck 可达鸭（混乱水枪）
- 精英：snorlax 卡比兽（高血、地震）、onix 大岩蛇（远程落石）
- BOSS：mewtwo 超梦（第 8 波，双阶段：能量弹幕 → 瞬移追猎）

**对白风格**（UI 的 subtitle 用）：
- 开局：伙伴宝可梦「森林里全是暴走的宝可梦……小心，有东西在盯着我们！」
- 波次 4：「暗影能量越来越浓了，别停下！」
- BOSS：「那……那是超梦？它的眼睛是红色的！」
- 通关：「成功了！森林的暗影散了——谢谢你，训练家！」

**配色（UI 用）**：背景卡片 #ffffff / rgba(255,255,255,.92)，描边 #ffcb05（宝可梦黄），主字 #24313f，强调红 #e8453c，青草绿 #4e9c3f，天蓝 #3aa0e8，辅助 #ff9f43。
