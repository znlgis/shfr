# 山海 · 森之突袭 — 中国神话主题设计规格（唯一真源）

> 所有 Agent 动手前必读。本文件定义全部命名、id、配色、文案与跨文件接口。
> 本作已整体改为中国神话题材：交付物（src / tests / docs / dist / README / package.json）中**不得出现旧 IP 的物种名、角色名、作品名与英文 id**（旧内容对照可查 git 历史提交）。
> 内部技术 id `t_bolt / t_leaf / t_ember / t_tide` 保留不变，它们只是"技能槽位"的技术编号，不含 IP 含义；但界面文案一律用行者名。

---

## 1. 世界观

**标题**：山海 · 森之突袭 ｜ **SHAN HAI: FOREST RAID**
**一句话**：混沌之气侵入山海秘境，上古妖物纷纷苏醒。你作为"行者"，带着灵兽深入古林，用法器击退妖物，直捣山海之眼。

流程：启动加载 → 标题（实时古林背景）→ 选行者（4 选 1）→ 古林战斗（8 波，第 8 波 BOSS）→ 结算（胜/负）。

阶段命名：`山海秘境`（森林）、`古林`、`山海之眼`（终局）、`祭坛`、`牌坊`、`石鼎`。

---

## 2. 四位行者（可选角色）

| id | 中文 | 英文 | 属性 | 灵兽 | 法器（全称 / 短名） | 被动 | 灵兽技 |
|---|---|---|---|---|---|---|---|
| t_bolt | 雷公 | LEIGONG | lei 雷 | kui 夔牛 | 雷光锤 / 雷光锤 | 聚雷：命中累积雷气，满 5 层下一发必定暴击 | 天雷引：连锁闪电，劈中 8 米内最多 6 只妖物 |
| t_leaf | 句芒 | GOUMANG | mu 木 | qilin 麒麟 | 灵种杖 / 灵种 | 春生：脱战 4 秒后缓慢回复体力 | 万物生：灵雨护体，回血并减速周围妖物 |
| t_ember | 祝融 | ZHURONG | huo 火 | bifang 毕方 | 离火铳 / 离火 | 余烬：击杀后 2 秒内伤害 +40% | 焚天业火：以自身为中心的爆炎新星，范围灼烧 |
| t_tide | 玄冥 | XUANMING | shui 水 | xuanwu 玄武 | 玄水枪 / 玄水 | 潮汐：每第 5 发伤害翻倍并回复 2 点体力 | 玄冥水盾：3 秒无敌，冲开周围所有敌人 |

角色主色（UI 选角卡 / 武器光效）：t_bolt `#ffd93d`、t_leaf `#8ed36a`、t_ember `#ff8a3d`、t_tide `#5ab8f0`。
造型要点（人形，高 1.8，脚在 y=0，面向 -Z，右手前举持法器）：
- 雷公：深蓝短打 + 鎏金云肩 + 雷纹头巾 + 束袖，背后小雷鼓，赤绳结。
- 句芒：青绿道袍 + 木纹护腕 + 鹿角木冠 + 藤蔓腰带，羽形披肩。
- 祝融：赤红甲胄 + 火焰纹披风 + 朱发束冠 + 金环臂钏。
- 玄冥：玄青长袍 + 浪纹 + 龟甲护心 + 玉簪束发，蓝发。

---

## 3. 十八只异兽（4 灵兽 + 14 妖物）

`id / 中文 / 英文 / 属性 / kind / 高度 h / 半径 r / 主色 / 造型要点 / 玩法槽位`

| id | 中文 | en | 属性 | kind | h | r | 主色 | 造型要点 | 槽位（原行为） |
|---|---|---|---|---|---|---|---|---|---|
| kui | 夔牛 | KUI | lei | starter | 0.86 | 0.30 | 苍青 #6b7fa8 + 紫电 #b06bff | 单足雷牛：牛身、无角、一足、紫电缠身、雷纹背 | 旧槽位 1（melee 小体型伙伴） |
| qilin | 麒麟 | QILIN | mu | starter | 1.00 | 0.46 | 青玉 #4fb99f + 鎏金 #e8b33a | 四足瑞兽：鳞身、鹿角、金鬃、灵芝尾 | 旧槽位 2（伙伴） |
| bifang | 毕方 | BIFANG | huo | starter | 1.05 | 0.36 | 赤 #e8453c + 金 #ffd93d | 独足火鸟：鹤形、赤羽、金喙、翅尖燃焰 | 旧槽位 3（伙伴） |
| xuanwu | 玄武 | XUANWU | shui | starter | 0.95 | 0.36 | 墨绿 #2f4a3a + 金 #e8b33a | 龟蛇合体：墨绿龟甲金纹、青色蛇颈缠绕 | 旧槽位 4（伙伴） |
| lushu | 鹿蜀 | LUSHU | shou | enemy | 0.66 | 0.32 | 米白 #e8e2d2 + 虎纹 #b8894a + 赤尾 #d0432e | 马形白身、虎纹、赤尾、长耳 | 旧槽位 5（melee） |
| wugong | 蜈蚣精 | WUGONG | du | enemy | 0.66 | 0.30 | 深褐 #5a3a2a + 赭 #b8743a + 毒绿 #9bd44a | 多节蜈蚣、百足、毒颚、触须 | 旧槽位 6（ranged 毒） |
| zhen | 鸩鸟 | ZHEN | du | enemy | 0.62 | 0.30 | 毒紫 #8a5fbf + 黑紫 #4a2f6a | 毒羽鸟、金喙、赤目、尾羽长 | 旧槽位 7（flyer） |
| mumei | 木魅 | MUMEI | mu | enemy | 0.62 | 0.30 | 树皮 #6a4a2e + 苔绿 #7ec850 | 树桩妖、苔绿树冠、树皮脸、根须手 | 旧槽位 8（melee） |
| xuanfeng | 玄蜂 | XUANFENG | du | enemy | 1.15 | 0.45 | 玄黑 #2b2b36 + 金纹 #e8b33a | 玄黑巨蜂、金环纹、毒针、灰蓝薄翅 | 旧槽位 9（ranged 快） |
| zheng | 狰 | ZHENG | shou | enemy | 1.35 | 0.42 | 赤褐 #c2452e + 骨白 #f0e6d2 | 赤豹、独角、五尾、獠牙、鬃毛 | 旧槽位 10（dash） |
| jiuwei | 九尾狐 | JIUWEI | yao | enemy | 0.92 | 0.34 | 白 #f4f1e8 + 赤尾尖 #e8453c | 白狐、九条飘尾、金瞳、额间朱纹 | 旧槽位 11（strafe） |
| jiaoren | 鲛人 | JIAOREN | shui | enemy | 0.60 | 0.28 | 青白 #cfe8e2 + 青鳞 #4fb9c9 | 人鱼、长发、鳞尾、珠光、张口吟唱 | 旧槽位 12（sing） |
| chimei | 魑魅 | CHIMEI | gui | enemy | 0.85 | 0.40 | 紫雾 #8a6ac8 + 青光 #7af0d0 | 无足飘浮精魅、雾状下摆、青光眼、长耳 | 旧槽位 13（float/ghost） |
| wangliang | 魍魉 | WANGLIANG | gui | enemy | 1.45 | 0.50 | 墨紫 #3a2a4a + 赤目 #e8453c | 墨影魍魉、双角、烟雾下摆、利爪 | 旧槽位 14（teleport/ghost） |
| chiru | 赤鱬 | CHIRU | shui | enemy | 0.86 | 0.34 | 赤 #e8563c + 金鳍 #ffd93d | 鱼身人面、大眼、金鳍、吐水泡 | 旧槽位 15（ranged 水） |
| taotie | 饕餮 | TAOTIE | shou | elite | 2.20 | 0.82 | 青铜 #6b8a5a + 鎏金 #e8b33a | 青铜巨兽、巨口獠牙、羊角、金纹、腹大 | 旧槽位 16（heavy elite） |
| bashe | 巴蛇 | BASHE | shou | elite | 1.75 | 0.55 | 墨绿 #3f6a4a + 黄腹 #c9b46a | 巨蛇、金瞳、盘绕、鳞纹 | 旧槽位 17（ranged 落石 elite） |
| hundun | 混沌 | HUNDUN | ling | boss | 1.90 | 0.42 | 黄囊 #e8c86a + 赤光 #e8453c | 无面黄囊、六足四翼、赤光流转、浑敦无目 | BOSS（双阶段） |

造型一律为**纯程序化几何拼装**（球/胶囊/环/锥/柱/盒 + MeshStandardMaterial），禁用外部贴图；饱和卡通、圆润可爱，但必须有明确的中国神话辨识特征（角/鳞/羽/云纹/青铜纹）。

---

## 4. 属性（type）体系

类型键改为拼音，旧键（electric/grass/fire/water/bug/flying/poison/normal/psychic/ghost/rock）全部移除。

| 键 | 中文 | 主色 | 暗色 |
|---|---|---|---|
| lei | 雷 | #ffd93d | #b58a00 |
| mu | 木 | #7ec850 | #3f7a2c |
| huo | 火 | #ff8a3d | #c2451a |
| shui | 水 | #6fc3ff | #1f6fb2 |
| feng | 风 | #a9c0ea | #4a5f96 |
| du | 毒 | #b57ad8 | #6a3a8f |
| yan | 岩 | #b3a68f | #6b6152 |
| shou | 兽 | #d9c9a8 | #8a7650 |
| ling | 灵 | #7ad0c8 | #2f7f74 |
| gui | 鬼 | #8a6ac8 | #4c3580 |
| yao | 妖 | #f08bb4 | #a83f6a |

`TYPE_CN = { lei:'雷', mu:'木', huo:'火', shui:'水', feng:'风', du:'毒', yan:'岩', shou:'兽', ling:'灵', gui:'鬼', yao:'妖' }`

---

## 5. 波次（8 波，第 8 波 BOSS）

| 波 | 名称 | 阵容 | 提示语（灵兽说） |
|---|---|---|---|
| 1 | 林间异动 | lushu×5, wugong×3 | 山里的灵气乱了……有东西在盯着我们！ |
| 2 | 妖群来袭 | lushu×4, wugong×4, zhen×3 | 它们被混沌之气侵蚀了，别心软！ |
| 3 | 古木伏击 | mumei×4, zhen×3, xuanfeng×2 | 左边的古木在动——树魅在聚气！ |
| 4 | 玄蜂之刺 | xuanfeng×5, jiuwei×3, wugong×4 | 混沌之气越来越浓，别停下！ |
| 5 | 百鬼夜行 | chimei×4, jiuwei×3, zheng×2, jiaoren×2 | 雾里……有东西在飘。 |
| 6 | 凶兽突袭 | zheng×4, xuanfeng×4, chiru×3 | 迅捷的凶兽来了，用冲刺闪避！ |
| 7 | 凶兽镇守 | taotie×1, bashe×1, wangliang×2, mumei×4 | 两只凶兽守在祭坛前——集中火力！ |
| 8 | 混沌之核 | hundun×1（boss） | 那……那是混沌？它竟没有面目！ |

BOSS 行为保留原双阶段（弹幕 / 瞬移 / 召唤），召唤小怪从 `chimei`、`wangliang` 中挑；
BOSS 召唤台词：`subtitle('混沌', '更多混沌……从山泽深处涌出来了！')`。
`jiaoren` 的 sing 行为提示：`toast('鲛人的歌声让你脚步沉滞…')`。

---

## 6. 界面文案（逐字使用）

**启动页**（src/index.html）：logo 标记 `山海`；副文案 `正在进入山海秘境…`
**90-main 启动步骤**：`正在唤醒山海秘境…` / `召唤上古灵兽…` / `编织古林光影…` / `校准伏魔法器…` / `准备就绪`

**标题屏**：
- 顶部飘带：`山海秘境 · 混沌来袭`
- 大标题两行：`山海` + `森之突袭`；英文 `SHAN HAI` · `FOREST RAID`
- 标语：`混沌之气侵入山海秘境，上古妖物纷纷苏醒。带上灵兽，从古林一路打到山海之眼。`
- 标签：`8 波关卡`、`第 8 波 BOSS · 混沌`、`4 位行者可选`
- 主按钮：`开始探险`；提示：`按 Enter 或点击按钮开始 · 建议全屏游玩`；版本：`v1.0 · 单文件离线版`

**选角屏**：kicker `行者卷宗 · 四选一`；标题 `选择你的行者`；副标题 `灵兽会随你进入古林，法器与异能各不相同`；
技名标签 `灵兽技`；按钮 `确认出发`；提示 `← → 选择 · Enter 出发 · Esc 返回标题`；兜底名 `行者` / `灵兽` / `法器`。

**暂停屏**：`已暂停`；`古林的时间也为你停驻`；`继续游戏` / `重新开始` / `返回标题`；提示 `Esc 或 Enter 继续游戏 · R 重新开始`；按键表里 Q 写作 `灵兽技`。

**结算屏**：胜利标题 `山泽安宁！`；失败 `挑战失败`；胜利 kicker `第 N 波 · 混沌之核已净化`；失败 kicker `第 N 波 · 山海古径`；
引号署名 `「灵兽名」`；胜利台词 `成功了！山泽的暗影散了——多谢你，行者！`；失败台词 `别灰心，行者……我们再试一次，山林还等着我们！`
统计：`抵达波次 / 总得分 / 最高连击 / 坚持时间`；按钮 `再战一局`（负）`再来一局`、`返回标题`；底注 `Enter 再战一局 · Esc 返回标题`；评价标签 `本局评价`。

**HUD**：伙伴标签 `灵兽 <名>`；灵兽技按钮 `灵兽技`；目标清单 `清剿第 N 波妖物`、`击败混沌` / `守住山海祭坛`。
**击杀反馈**：`击败 <中文名>  +<分数>`。
**武器/角色兜底**：`伏魔法器`（FPS 左侧注释与兜底文案用）。

---

## 7. 配色（UI）

明亮卡通 + 国风：
| 变量含义 | 值 |
|---|---|
| 鎏金（描边/强调） | `#e8b33a` |
| 朱砂（主强调红） | `#d0432e` |
| 石青（次强调蓝） | `#2f6fae` |
| 苔绿 | `#4e9c3f` |
| 墨 | `#24313f` |
| 天青（背景） | `#9fe0ff` |
| 米白卡片 | `#ffffff` / `rgba(255,255,255,.92)` |
| 辅助橙 | `#f09b3c` |
| 青玉 | `#2f9e8f` |

CSS 变量名 `--pk-*` 改为 `--sh-*`（sh = shanhai），全文件同步改名；注释统一为"山海国风"。
旧品牌球状图标删除，改为 `.ui-coin`：鎏金铜钱（外圆 + 内方孔），用于主按钮图标。
`.deco-ball` 改为 `.deco-orb`（纯柔光圆斑，不含 IP 造型），文案注释同步。
标题飘带渐变改为朱砂→鎏金：`linear-gradient(90deg, rgba(208,67,46,.96), rgba(232,179,58,.96))`。
彩带/粒子色板改为：`#e8b33a #d0432e #2f6fae #4e9c3f #f09b3c #2f9e8f #ffffff`。

---

## 8. 技术接口（跨文件强契约）

构建顺序（build.mjs JS_ORDER）：
`10-audio.js → 20-world.js → 30-models.js → 32-beasts.js → 35-art.js → 40-util.js → 50-game.js → 80-hud.js → 85-ui.js → 90-main.js`

### 8.1 src/30-models.js（负责人：models）
- `CREATURE_IDS`（18 个，顺序：kui qilin bifang xuanwu lushu wugong zhen mumei xuanfeng zheng jiuwei jiaoren chimei wangliang chiru taotie bashe hundun）与 `TRAINER_IDS`（4 个，id 不变）。
- `DATA` 含全部 18 只的 `{cn,en,type,kind,h,r}`（按第 3 节）；`TRAINER_DATA` 含 4 位行者。
- 保留并复用现有 Builder / 合并网格 / finishModel 机制；只重建 4 只灵兽 + 4 位行者的人类模型。
- **暴露 DSL 给 32-beasts.js**：`PG.models._dsl = { Builder, SPH, SPH_HI, CONE, CYL, BOX, HEMI, TORUS, CAPSULE, ICO, leafGeo, boltGeo, scytheGeo, capChain, addEye, addEyes, addSmile, addOpenMouth, addFangs, addTeethRow, addCheeks, addClaws, addFoot, finishModel, quatY, TAU, PI }`
- **暴露注册口**：`PG.models.registerBuilders(map)`，把 map 合并到内部 `BEAST_BUILDERS`；`getTemplate` 查找顺序：trainer → PARTNER_BUILDERS（kui/qilin/bifang/xuanwu）→ BEAST_BUILDERS（32-beasts 注册的 14 只）。
- `PG.models` API：`CREATURES`、`TRAINERS`、`has(id)`、`info(id)`、`make(id)`、`makeTrainer(id)`、`stats(id)`、`silhouetteColor(id)`、`warmup(ids)`，以及 **2D 委托**：`icon(id,size)` / `portrait(id,size)` → `PG.models.art && PG.models.art.icon(...)`（art 未加载时返回 null 且不抛错）。
- 文件内不得出现旧 IP 的物种名/角色名/英文 id（含注释、变量名、错误信息）；旧命名的全局前缀一律改名（`CREATURE_*`、`BEAST_BUILDERS` 等）。

### 8.2 src/32-beasts.js（新建，负责人：beasts）
- IIFE；`const M = window.PG.models; const { Builder, SPH, ... } = M._dsl;`（构建顺序保证 30-models 先加载）。
- 实现 14 只妖物的 build 函数（lushu wugong zhen mumei xuanfeng zheng jiuwei jiaoren chimei wangliang chiru taotie bashe hundun），每个返回 `finishModel(B, animFn)`。
- 末尾 `M.registerBuilders({ lushu: buildLushu, ... });`
- 动画节点命名只用 [a-z0-9_]；模型脚底 y=0、面向 -Z；高度/半径以 DATA 为准（finishModel 会自动量，但形体要贴合第 3 节）。

### 8.3 src/35-art.js（新建，负责人：art）
- IIFE；自带 Canvas2D 绘制工具（mkCanvas / cCir / cEll / cShp / cRR / cLin / cRad / cSpark / cEye / cSmile / iconBG 等，从旧版 30-models 的 2D 段迁移改写）。
- 实现 18 个妖物圆形图标（`ICONS[id](g)`）+ 4 位行者半身头像（`drawTrainerPortrait(g,id)`）；右下属性徽章沿用 `drawSymbol`，符号按属性：lei 雷纹 bolt、mu 叶 leaf、huo 火 flame、shui 水 drop（其余属性可复用最近符号）。
- 末尾 `PG.models.art = { icon: icon, portrait: portrait, has: function(id){...} };`（icon/portrait 带缓存，尺寸 round、最小 16/32）。
- 不得依赖 30-models 的内部变量：需要资料时用 `PG.models.info(id)`；配色用本文件自己的 ART 色表（第 3 节主色）。

### 8.4 其余文件
- `src/50-game.js`（Lead）：CHARS / ENEMIES / CN / WAVES 全部换新；第一人称法器外观重做；BOSS 召唤与技能提示；跑分与行为逻辑不变（id 槽位不变）。
- `src/90-main.js`（Lead）：boot 文案、标题展示台（灵兽 vs 行者）、`poke` 内部命名改 `beast`、HUD 灵兽标签。
- `src/85-ui.js / 70-ui.css / 75-hud.css / 80-hud.js`（ui）：第 6/7 节全部文案与配色；`TYPE_CN` 换新键；`.ui-ball`→`.ui-coin`；HUD 注释/标签。
- `src/20-world.js / 10-audio.js`（world）：日式牌楼→中式牌坊、旧式祭殿→祭坛、石灯笼→石鼎香炉、注释文案；audio 的 TIMBRES 键改 `thunder/wood/fire/water`，注释去 IP 词。
- `src/index.html`、`build.mjs`、`package.json`、`README.md`、`docs/CONTRACT.md`、`tests/*`、`docs/screenshots/*`、`dist/*`（Lead）。

---

## 9. 验收口径（每个负责人自测）

1. `node --check <自己的文件>` 通过；`node build.mjs --dev` 成功（dev.html 生成）。
2. 自己的文件里旧 IP 词 0 次：按 `git show HEAD:README.md` 中旧版命名表逐条 `grep -in` 自查（旧物种名、旧角色名、作品名、英文 id）。
3. 用无头 Edge 打开自己的测试页/截图，肉眼确认模型/图标/界面正常、无黑屏、无 JS 错误：
```bash
node build.mjs --dev
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --hide-scrollbars --window-size=1280,800 --virtual-time-budget=8000 --screenshot='D:\self\code\zgshsj\_shots\<name>.png' 'file:///D:/self/code/zgshsj/dev.html'
```
4. 完成后 send_message 给 lead：改了什么、证据（截图路径 / 关键 grep 结果）、遗留问题。