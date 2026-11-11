/* ============================================================================
 * 30-models.js — PG.models
 * 山海 · 森之突袭 — 程序化 3D 模型库（负责：队友 models）
 * ----------------------------------------------------------------------------
 * 设计要点：
 *  1) 全库由 Three.js 基本几何体拼装（球 / 胶囊 / 锥 / 圆柱 / 环 / 挤出），
 *     无任何外部贴图，离线可用；题材为中国神话（山海秘境 · 上古异兽）。
 *  2) 压低 draw call：每个"动画节点"（root / head / tail / wing ...）内部的
 *     同类材质零件，在建完模后合并为一个带顶点色的 BufferGeometry。
 *     单只模型通常 3~6 个 draw call；全库共用材质。
 *  3) 模板只构建一次，make() 通过 group.clone(true) 复制（几何与材质共享 GPU
 *     资源），刷怪不会产生几何垃圾。
 *  4) 美术规范：脚底 y = 0，正面朝 -Z；update(dt, t) 处理呼吸 / 耳朵 / 尾巴 /
 *     翅膀 / 飘浮等细微动画。行者站立，右手前举，暴露 handAnchor 供挂法器。
 *  5) 分工：本文件负责 18 只异兽资料表、4 只灵兽与 4 位行者的模型、拼装 DSL、
 *     注册口与 PG.models API；14 只妖物由 32-beasts.js 通过 PG.models._dsl
 *     构建并 registerBuilders 注入；2D 图标与行者头像由 35-art.js 挂到
 *     PG.models.art，本文件只保留 icon / portrait 薄封装。
 * ==========================================================================*/

(() => {
  "use strict";

// ===========================================================================
// 0. 常量、数据表
// ===========================================================================
const TAU = Math.PI * 2;
const PI = Math.PI;
const PG = (window.PG = window.PG || {});
const T3 = window.THREE || null;   // 构建顺序保证 three.min.js 已先加载

// 异兽顺序（18 只，见 MYTHOLOGY 第 3 节）：4 灵兽在前，其余为妖物
const CREATURE_IDS = [
  'kui', 'qilin', 'bifang', 'xuanwu',
  'lushu', 'wugong', 'zhen', 'mumei',
  'xuanfeng', 'zheng', 'jiuwei', 'jiaoren',
  'chimei', 'wangliang', 'chiru', 'taotie', 'bashe', 'hundun',
];
const TRAINER_IDS = ['t_bolt', 't_leaf', 't_ember', 't_tide'];

// cn 中文名 | en 英文名 | type 属性键（拼音）| kind starter/enemy/elite/boss
// h 目标总高度（米）| r 碰撞半径参考值
const DATA = {
  kui:       { cn: '夔牛',   en: 'KUI',       type: 'lei',  kind: 'starter', h: 0.86, r: 0.30 },
  qilin:     { cn: '麒麟',   en: 'QILIN',     type: 'mu',   kind: 'starter', h: 1.00, r: 0.46 },
  bifang:    { cn: '毕方',   en: 'BIFANG',    type: 'huo',  kind: 'starter', h: 1.05, r: 0.36 },
  xuanwu:    { cn: '玄武',   en: 'XUANWU',    type: 'shui', kind: 'starter', h: 0.95, r: 0.36 },
  lushu:     { cn: '鹿蜀',   en: 'LUSHU',     type: 'shou', kind: 'enemy',   h: 0.66, r: 0.32 },
  wugong:    { cn: '蜈蚣精', en: 'WUGONG',    type: 'du',   kind: 'enemy',   h: 0.66, r: 0.30 },
  zhen:      { cn: '鸩鸟',   en: 'ZHEN',      type: 'du',   kind: 'enemy',   h: 0.62, r: 0.30 },
  mumei:     { cn: '木魅',   en: 'MUMEI',     type: 'mu',   kind: 'enemy',   h: 0.62, r: 0.30 },
  xuanfeng:  { cn: '玄蜂',   en: 'XUANFENG',  type: 'du',   kind: 'enemy',   h: 1.15, r: 0.45 },
  zheng:     { cn: '狰',     en: 'ZHENG',     type: 'shou', kind: 'enemy',   h: 1.35, r: 0.42 },
  jiuwei:    { cn: '九尾狐', en: 'JIUWEI',    type: 'yao',  kind: 'enemy',   h: 0.92, r: 0.34 },
  jiaoren:   { cn: '鲛人',   en: 'JIAOREN',   type: 'shui', kind: 'enemy',   h: 0.60, r: 0.28 },
  chimei:    { cn: '魑魅',   en: 'CHIMEI',    type: 'gui',  kind: 'enemy',   h: 0.85, r: 0.40 },
  wangliang: { cn: '魍魉',   en: 'WANGLIANG', type: 'gui',  kind: 'enemy',   h: 1.45, r: 0.50 },
  chiru:     { cn: '赤鱬',   en: 'CHIRU',     type: 'shui', kind: 'enemy',   h: 0.86, r: 0.34 },
  taotie:    { cn: '饕餮',   en: 'TAOTIE',    type: 'shou', kind: 'elite',   h: 2.20, r: 0.82 },
  bashe:     { cn: '巴蛇',   en: 'BASHE',     type: 'shou', kind: 'elite',   h: 1.75, r: 0.55 },
  hundun:    { cn: '混沌',   en: 'HUNDUN',    type: 'ling', kind: 'boss',    h: 1.90, r: 0.42 },
};

const TRAINER_DATA = {
  t_bolt:  { cn: '雷公', en: 'LEIGONG',  type: 'lei'  },
  t_leaf:  { cn: '句芒', en: 'GOUMANG',  type: 'mu'   },
  t_ember: { cn: '祝融', en: 'ZHURONG',  type: 'huo'  },
  t_tide:  { cn: '玄冥', en: 'XUANMING', type: 'shui' },
};

// 属性主色 / 暗色 / 中文（十一类，与 MYTHOLOGY 第 4 节逐字一致）
const TYPE_COLORS = {
  lei: '#ffd93d', mu: '#7ec850', huo: '#ff8a3d', shui: '#6fc3ff', feng: '#a9c0ea',
  du: '#b57ad8', yan: '#b3a68f', shou: '#d9c9a8', ling: '#7ad0c8', gui: '#8a6ac8', yao: '#f08bb4',
};
const TYPE_DARK = {
  lei: '#b58a00', mu: '#3f7a2c', huo: '#c2451a', shui: '#1f6fb2', feng: '#4a5f96',
  du: '#6a3a8f', yan: '#6b6152', shou: '#8a7650', ling: '#2f7f74', gui: '#4c3580', yao: '#a83f6a',
};
const TYPE_CN = {
  lei: '雷', mu: '木', huo: '火', shui: '水', feng: '风',
  du: '毒', yan: '岩', shou: '兽', ling: '灵', gui: '鬼', yao: '妖',
};

function infoOf(id) {
  const d = DATA[id];
  if (d) return { id: id, cn: d.cn, en: d.en, type: d.type, scale: 1, kind: d.kind, h: d.h, r: d.r };
  const t = TRAINER_DATA[id];
  if (t) return { id: id, cn: t.cn, en: t.en, type: t.type, scale: 1, kind: 'trainer', h: 1.8, r: 0.40 };
  return null;
}

// ===========================================================================
// 1. 材质 / 几何缓存（全库共用，保证同色同材质只创建一次）
// ===========================================================================
const MAT_CACHE = new Map();

// spec: { kind:'body'|'shine'|'rock'|'glass'|'glow', key, opacity?, c?, intensity? }
function matOf(spec) {
  let m = MAT_CACHE.get(spec.key);
  if (m) return m;
  if (!T3) throw new Error('PG.models: THREE 未加载');
  if (spec.kind === 'glow') {
    m = new T3.MeshStandardMaterial({
      color: spec.c, emissive: spec.c, emissiveIntensity: spec.intensity || 1.5,
      roughness: 0.45, metalness: 0.0,
    });
  } else if (spec.kind === 'glass') {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: spec.opacity,
      roughness: 0.22, metalness: 0.06, depthWrite: false,
    });
  } else if (spec.kind === 'shine') {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.22, metalness: 0.0,
    });
  } else if (spec.kind === 'rock') {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.03, flatShading: true,
    });
  } else {
    m = new T3.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.56, metalness: 0.02,
    });
  }
  m.name = 'pg_' + spec.key;
  MAT_CACHE.set(spec.key, m);
  return m;
}

const GEO_CACHE = new Map();
function cachedGeo(key, factory) {
  let g = GEO_CACHE.get(key);
  if (!g) { g = factory(); GEO_CACHE.set(key, g); }
  return g;
}
const f3 = (n) => Math.round(n * 1000) / 1000;

// 单位球（缩放通过矩阵完成，保证缓存复用）
const SPH = () => cachedGeo('sph', () => new T3.SphereGeometry(1, 14, 10));
const SPH_HI = () => cachedGeo('sphHi', () => new T3.SphereGeometry(1, 18, 12));
const CONE = () => cachedGeo('cone', () => new T3.ConeGeometry(1, 1, 14));
const CYL = () => cachedGeo('cyl', () => new T3.CylinderGeometry(1, 1, 1, 14));
const BOX = () => cachedGeo('box', () => new T3.BoxGeometry(1, 1, 1));
const HEMI = () => cachedGeo('hemi', () => new T3.SphereGeometry(1, 16, 8, 0, TAU, 0, PI / 2));
const TORUS = (R, tube, arc) => cachedGeo('t' + f3(R) + '_' + f3(tube) + '_' + f3(arc),
  () => new T3.TorusGeometry(R, tube, 6, 22, arc));
const CAPSULE = (r, len) => cachedGeo('c' + f3(r) + '_' + f3(len),
  () => new T3.CapsuleGeometry(r, len, 3, 10));
const ICO = (r, detail) => cachedGeo('i' + f3(r) + '_' + detail, () => new T3.IcosahedronGeometry(r, detail));

// 叶子 / 闪电 / 螳螂镰刀：用挤出几何获得漂亮轮廓（低段数，不增加多少面）
function leafGeo(w, h, depth) {
  return cachedGeo('leaf' + f3(w) + '_' + f3(h) + '_' + f3(depth), () => {
    const s = new T3.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(w * 0.55, h * 0.22, w * 0.62, h * 0.68, 0, h);
    s.bezierCurveTo(-w * 0.62, h * 0.68, -w * 0.55, h * 0.22, 0, 0);
    return new T3.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: depth * 0.35,
      bevelSize: depth * 0.35, bevelSegments: 1, steps: 1, curveSegments: 6,
    });
  });
}

// 闪电轮廓（灵兽紫电 / 妖物电弧通用）（XY 平面内，沿 +Y 生长，挤出厚度 depth）
function boltGeo(scale, depth) {
  return cachedGeo('bolt' + f3(scale) + '_' + f3(depth), () => {
    const pts = [
      [0.00, 0.00], [0.36, 0.00], [0.62, 0.34], [0.28, 0.40],
      [0.72, 0.70], [0.36, 0.76], [0.92, 1.10],
      [-0.10, 0.62], [0.18, 0.57], [-0.22, 0.26], [0.02, 0.22], [-0.30, 0.06],
    ];
    const s = new T3.Shape();
    s.moveTo(pts[0][0] * scale, pts[0][1] * scale);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0] * scale, pts[i][1] * scale);
    s.closePath();
    return new T3.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: depth * 0.4,
      bevelSize: depth * 0.4, bevelSegments: 1, steps: 1, curveSegments: 4,
    });
  });
}

// 弯钩刃（带钩的弯刀，XY 平面，+Y 为刀尖方向）
function scytheGeo(w, h, depth) {
  return cachedGeo('scy' + f3(w) + '_' + f3(h) + '_' + f3(depth), () => {
    const s = new T3.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(w * 0.62, h * 0.06, w * 0.95, h * 0.42, w * 0.78, h * 0.80);
    s.bezierCurveTo(w * 0.60, h * 0.56, w * 0.34, h * 0.34, 0, h * 0.20);
    s.lineTo(0, 0);
    return new T3.ExtrudeGeometry(s, {
      depth: depth, bevelEnabled: true, bevelThickness: depth * 0.4,
      bevelSize: depth * 0.4, bevelSegments: 1, steps: 1, curveSegments: 8,
    });
  });
}

// ===========================================================================
// 2. 顶点色合并拼装器（核心：把同节点同材质零件合并成一个 Mesh）
// ===========================================================================
const COLOR_CACHE = new Map();
function colorOf(hex) {
  let c = COLOR_CACHE.get(hex);
  if (!c) { c = new T3.Color(hex); COLOR_CACHE.set(hex, c); }
  return c;
}

let IDENTITY_Q = null;
function matrixOf(o) {
  if (!IDENTITY_Q) IDENTITY_Q = new T3.Quaternion();
  const p = new T3.Vector3(o.x || 0, o.y || 0, o.z || 0);
  let q = IDENTITY_Q;
  if (o.q) q = o.q;
  else if (o.rx || o.ry || o.rz) q = new T3.Quaternion().setFromEuler(new T3.Euler(o.rx || 0, o.ry || 0, o.rz || 0));
  const s = new T3.Vector3(o.sx == null ? 1 : o.sx, o.sy == null ? 1 : o.sy, o.sz == null ? 1 : o.sz);
  const m = new T3.Matrix4();
  m.compose(p, q, s);
  return m;
}

function specOf(o) {
  if (o.glow != null) {
    const inten = o.glowInt == null ? 1.5 : o.glowInt;
    return { kind: 'glow', key: 'g' + (o.glow >>> 0) + '_' + inten, c: o.glow, intensity: inten };
  }
  if (o.glass != null) {
    const op = Math.round((o.glass === true ? 0.5 : o.glass) * 100) / 100;
    return { kind: 'glass', key: 'gl' + op, opacity: op };
  }
  if (o.rock) return { kind: 'rock', key: 'rock' };
  if (o.shine) return { kind: 'shine', key: 'shine' };
  return { kind: 'body', key: 'body' };
}

// 把若干 {geo, color, m} 合并成一个带顶点色的 BufferGeometry
function mergeParts(parts, withColor) {
  const n = parts.length;
  let total = 0;
  const prep = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    const src = p.geo;
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (p.m) g.applyMatrix4(p.m);
    prep[i] = g;
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = withColor ? new Float32Array(total * 3) : null;
  let off = 0;
  for (let i = 0; i < n; i++) {
    const g = prep[i];
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, off * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, off * 2);
    if (col) {
      const c = parts[i].color;
      for (let v = 0; v < cnt; v++) {
        const bi = (off + v) * 3;
        col[bi] = c.r; col[bi + 1] = c.g; col[bi + 2] = c.b;
      }
    }
    off += cnt;
  }
  const geo = new T3.BufferGeometry();
  geo.setAttribute('position', new T3.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new T3.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new T3.BufferAttribute(uv, 2));
  if (col) geo.setAttribute('color', new T3.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

// 网格拼装器：node() 建动画节点，put() 塞零件，bake() 合并成极少 draw call
function Builder() {
  const root = new T3.Group();
  root.name = 'root';
  const nodeMap = { root: root };
  const buckets = { root: new Map() };

  const api = {
    root: root,
    // 新建动画节点（作为 parent 的子级）
    node: function (name, parentName, x, y, z) {
      const g = new T3.Group();
      g.name = name;
      g.position.set(x || 0, y || 0, z || 0);
      (nodeMap[parentName] || root).add(g);
      nodeMap[name] = g;
      buckets[name] = new Map();
      return g;
    },
    // 往节点里加一个零件：geo 几何、color 颜色、o 变换与材质选项
    put: function (nodeName, geo, color, o) {
      const opt = o || {};
      const spec = specOf(opt);
      let map = buckets[nodeName];
      if (!map) { map = new Map(); buckets[nodeName] = map; }
      let b = map.get(spec.key);
      if (!b) { b = { spec: spec, parts: [] }; map.set(spec.key, b); }
      b.parts.push({ geo: geo, color: colorOf(color), m: matrixOf(opt) });
    },
    // 合并每个节点的所有零件，生成最终 Mesh
    bake: function () {
      Object.keys(buckets).forEach(function (name) {
        const g = nodeMap[name];
        const map = buckets[name];
        if (!g || !map) return;
        map.forEach(function (b) {
          const spec = b.spec;
          const mat = matOf(spec);
          const geo = mergeParts(b.parts, spec.kind !== 'glow');
          const mesh = new T3.Mesh(geo, mat);
          mesh.name = 'mesh_' + name + '_' + spec.kind;
          mesh.castShadow = (spec.kind === 'body' || spec.kind === 'rock' || spec.kind === 'shine');
          mesh.receiveShadow = false;
          if (spec.kind === 'glass') mesh.renderOrder = 2;
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          g.add(mesh);
        });
        buckets[name] = null;
      });
    },
  };
  return api;
}

// 常用朝向工具：把 +Y 单位向量转到 dir
function quatY(dir) {
  return new T3.Quaternion().setFromUnitVectors(new T3.Vector3(0, 1, 0), dir.clone().normalize());
}

// 胶囊链（尾巴 / 长颈 / 行者四肢）：pts = [[x,y,z], ...]
function capChain(B, nodeName, pts, radii, color, o) {
  const opt = o || {};
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) continue;
    const r = radii[i - 1] == null ? radii[radii.length - 1] : radii[i - 1];
    B.put(nodeName, CAPSULE(r, Math.max(0.001, len - r * 0.5)), color, {
      x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2,
      q: quatY(new T3.Vector3(dx, dy, dz)),
      shine: opt.shine, rock: opt.rock, glass: opt.glass, glow: opt.glow, glowInt: opt.glowInt,
    });
  }
}

// ===========================================================================
// 3. 通用零件（眼睛 / 嘴 / 牙 / 腮红 / 爪子）
// ===========================================================================

// 眼睛：side = -1 左 / +1 右（视觉上的左右）
// style: 'simple' 黑豆眼 | 'oval' 竖椭圆 | 'full' 眼白+虹膜+瞳孔+高光
function addEye(B, node, side, o) {
  const st = o.style || 'simple';
  const r = o.r || 0.045;
  const spread = o.spread == null ? 0.09 : o.spread;
  const x = (o.x || 0) + side * spread;
  const y = o.y || 0;
  const z = o.z == null ? -0.18 : o.z;
  const wz = o.wz == null ? 0.6 : o.wz;
  const sy = o.sy == null ? 1.05 : o.sy;
  const tilt = (o.tilt || 0) * side;
  const look = o.look || 0;
  if (st === 'full') {
    // 眼白
    B.put(node, SPH(), o.white == null ? 0xffffff : o.white,
      { x: x, y: y, z: z, sx: r, sy: r * sy, sz: r * wz, rz: tilt, shine: true });
    // 虹膜
    B.put(node, SPH(), o.iris == null ? 0x2f6fa8 : o.iris,
      { x: x + look * r * 0.12, y: y - r * 0.06, z: z - r * wz * 0.50, sx: r * 0.64, sy: r * 0.64, sz: r * 0.34, shine: true });
    // 瞳孔
    B.put(node, SPH(), o.pupil == null ? 0x1d2430 : o.pupil,
      { x: x + look * r * 0.16, y: y - r * 0.04, z: z - r * wz * 0.70, sx: r * 0.33, sy: r * 0.35, sz: r * 0.20, shine: true });
  } else if (st === 'oval') {
    B.put(node, SPH(), o.pupil == null ? 0x232733 : o.pupil,
      { x: x, y: y, z: z, sx: r * 0.82, sy: r * 1.15, sz: r * wz, rz: tilt, shine: true });
  } else {
    B.put(node, SPH(), o.pupil == null ? 0x232733 : o.pupil,
      { x: x, y: y, z: z, sx: r, sy: r * sy, sz: r * wz, rz: tilt, shine: true });
  }
  // 高光（左上方的小白点，卡通眼必备）
  if (o.hi !== false) {
    const hr = r * (o.hiR || 0.30);
    B.put(node, SPH(), 0xffffff,
      { x: x - r * 0.26, y: y + r * 0.32, z: z - r * wz * 1.02, sx: hr, sy: hr, sz: hr * 0.6, shine: true });
  }
}
function addEyes(B, node, o) {
  addEye(B, node, -1, o);
  addEye(B, node, 1, o);
}

// 微笑弧线（U 形）：由半环旋转而成，贴合脸部
function addSmile(B, node, o) {
  const w = o.w == null ? 0.05 : o.w;
  const tube = o.tube == null ? w * 0.17 : o.tube;
  B.put(node, TORUS(w, tube, PI), o.color == null ? 0x3a2b30 : o.color,
    { x: o.x || 0, y: o.y || 0, z: o.z == null ? -0.2 : o.z, rz: PI, sz: 0.4, shine: !!o.shine });
}

// 张开的嘴（深色椭圆，可选舌头）
function addOpenMouth(B, node, o) {
  const w = o.w == null ? 0.06 : o.w;
  const h = o.h == null ? w * 0.9 : o.h;
  B.put(node, SPH(), o.color == null ? 0x2a1f28 : o.color,
    { x: o.x || 0, y: o.y || 0, z: o.z == null ? -0.2 : o.z, sx: w, sy: h, sz: w * 0.22, shine: !!o.shine });
  if (o.tongue != null) {
    B.put(node, SPH(), o.tongue,
      { x: o.x || 0, y: (o.y || 0) - h * 0.42, z: (o.z == null ? -0.2 : o.z) - w * 0.13, sx: w * 0.5, sy: h * 0.34, sz: w * 0.13, shine: true });
  }
}

// 下獠牙（锥体朝上，白色）
function addFangs(B, node, o) {
  const n = o.n || 2;
  const gap = o.gap || 0.05;
  for (let i = 0; i < n; i++) {
    const x = (o.x || 0) + (i - (n - 1) / 2) * gap;
    B.put(node, CONE(), o.color == null ? 0xfffdf2 : o.color, {
      x: x, y: o.y || 0, z: o.z == null ? -0.21 : o.z,
      sx: o.w || 0.013, sy: o.h || 0.032, sz: (o.w || 0.013) * 0.8, shine: true,
    });
  }
}

// 一排牙齿（方糖状，用于妖物的咧嘴大笑）
function addTeethRow(B, node, o) {
  const n = o.n || 5;
  const w = o.w || 0.02;
  const gap = o.gap || w * 1.12;
  for (let i = 0; i < n; i++) {
    const x = (o.x || 0) + (i - (n - 1) / 2) * gap;
    B.put(node, BOX(), o.color == null ? 0xfffdf2 : o.color, {
      x: x, y: o.y || 0, z: o.z == null ? -0.2 : o.z,
      sx: w, sy: o.h || w * 1.3, sz: w * 0.7, rz: o.rz || 0, shine: true,
    });
  }
}

// 圆腮红（灵兽的腮红）
function addCheeks(B, node, o) {
  const r = o.r || 0.06;
  for (let s = -1; s <= 1; s += 2) {
    B.put(node, SPH(), o.color == null ? 0xe8453c : o.color, {
      x: (o.x || 0) + s * (o.spread || 0.16), y: o.y || 0,
      z: o.z == null ? -0.16 : o.z, sx: r, sy: r * 0.9, sz: r * 0.35,
    });
  }
}

// 朝 -Z 的三根白爪（手 / 脚通用）
function addClaws(B, node, o) {
  const n = o.n || 3;
  const spread = o.spread || 0.018;
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * spread;
    B.put(node, CONE(), o.color == null ? 0xfff6e0 : o.color, {
      x: (o.x || 0) + a, y: o.y || 0, z: o.z || 0,
      sx: o.r || 0.013, sy: o.len || 0.034, sz: (o.r || 0.013) * 0.8,
      rx: o.rx == null ? -PI / 2 : o.rx, shine: true,
    });
  }
}

// 一只小脚：主脚掌 + 可选脚趾
function addFoot(B, node, x, y, z, sx, sy, sz, color, toeColor) {
  B.put(node, SPH(), color, { x: x, y: y, z: z, sx: sx, sy: sy, sz: sz });
  if (toeColor != null) addClaws(B, node, { x: x, y: y, z: z - sz * 0.75, r: sx * 0.16, len: sz * 0.30, spread: sx * 0.32, color: toeColor });
}

// 模型收尾：合并网格 + 自动测量包围盒（保证 height/radius 与视觉一致）
// opt: { scale: 统一缩放, y: 整体上/下平移, fitH: 自动缩放到达标高度 }
//（fitH 缩放落在根节点上，避免被动画循环里对 inner 的呼吸缩放覆盖）
function finishModel(B, anim, opt) {
  B.bake();
  const o = opt || {};
  // 统一套一层 inner 组，用于整体缩放 / 降地（保证脚底精确落在 y=0）
  const inner = new T3.Group();
  inner.name = 'inner';
  const kids = B.root.children.slice();
  for (let i = 0; i < kids.length; i++) inner.add(kids[i]);
  inner.position.y = o.y || 0;
  if (o.scale) inner.scale.setScalar(o.scale);
  B.root.add(inner);
  if (o.autoGround !== false) {
    const b0 = new T3.Box3().setFromObject(B.root);
    // 整体降地：保证脚底精确落在 y=0（悬空/入地一律修正）
    if (Math.abs(b0.min.y) > 0.0015) inner.position.y -= b0.min.y;
  }
  // fitH：按目标高度自动缩放
  //   fitInner=true 时缩放落在 inner 上，外层 root 保持 1 倍：
  //   - 灵兽会被 50-game 以 model.height 重新设 root.scale，若缩放放在 root 会被覆盖，
  //     放在 inner 才能保证视觉高度始终等于返回值；
  //   - 行者只放展示台，缩放落在 root 上即可。
  if (o.fitH) {
    const b1 = new T3.Box3().setFromObject(B.root);
    const h1 = b1.max.y - Math.min(0, b1.min.y);
    if (h1 > 1e-4) {
      const k = o.fitH / h1;
      if (o.fitInner) inner.scale.setScalar(inner.scale.x * k);
      else B.root.scale.setScalar(k);
      B.root.updateMatrixWorld(true);
      if (o.fitInner) {
        const b2 = new T3.Box3().setFromObject(B.root);
        if (Math.abs(b2.min.y) > 1e-4) inner.position.y -= b2.min.y;
      }
    }
  }
  const box = new T3.Box3().setFromObject(B.root);
  const minY = Math.min(0, box.min.y);
  const height = box.max.y - minY;
  const radius = Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
  return { group: B.root, height: height, radius: radius, anim: anim };
}

// ===========================================================================
// 4. 灵兽模型（四只，跟随行者出战）
// ===========================================================================

// —— 夔牛 KUI（lei）：单足雷牛，苍青牛身、紫电缠身、雷纹背 ——
function buildKui() {
  const B = Builder();
  const BODY = 0x6b7fa8, BODY_D = 0x51638c, BELLY = 0x9aaacb, HOOF = 0x39425a;
  const PUR = 0xb06bff, EYE = 0xffd93d, NOSE = 0x2f3a4e;

  // 牛身 + 腹部 + 单足（山海经：状如牛，苍身无角，一足）
  B.put('root', SPH(), BODY, { y: 0.50, sx: 0.215, sy: 0.235, sz: 0.285 });
  B.put('root', SPH(), BELLY, { y: 0.395, z: -0.01, sx: 0.175, sy: 0.155, sz: 0.248 });
  B.put('root', SPH(), BODY_D, { y: 0.665, z: -0.12, sx: 0.14, sy: 0.075, sz: 0.16 });   // 牛肩峰
  B.put('root', SPH(), BODY_D, { y: 0.40, z: 0.0, sx: 0.115, sy: 0.14, sz: 0.135 });
  B.put('root', CAPSULE(0.072, 0.24), BODY_D, { y: 0.25, z: 0.0 });
  B.put('root', CYL(), HOOF, { y: 0.10, z: 0.0, sx: 0.095, sy: 0.16, sz: 0.10 });
  B.put('root', SPH(), HOOF, { y: 0.026, z: -0.02, sx: 0.105, sy: 0.032, sz: 0.125 });

  // 尾巴（动画节点）
  const tail = B.node('tail', 'root', 0, 0.55, 0.22);
  capChain(B, 'tail', [[0, 0, 0], [0.015, 0.02, 0.08], [0.03, -0.03, 0.15], [0.03, 0.05, 0.19]], [0.048, 0.036, 0.026, 0.015], BODY_D);
  B.put('tail', CONE(), PUR, { x: 0.03, y: 0.10, z: 0.185, sx: 0.032, sy: 0.10, sz: 0.032, rx: -0.55, glow: PUR, glowInt: 1.6 });

  // 牛首（无角）
  B.node('head', 'root', 0, 0.615, -0.225);
  B.put('head', SPH_HI(), BODY, { y: 0.02, sx: 0.185, sy: 0.175, sz: 0.185 });
  B.put('head', SPH(), BELLY, { y: -0.045, z: -0.135, sx: 0.125, sy: 0.10, sz: 0.115 });
  B.put('head', SPH(), NOSE, { x: 0.045, y: -0.05, z: -0.238, sx: 0.020, sy: 0.014, sz: 0.010 });
  B.put('head', SPH(), NOSE, { x: -0.045, y: -0.05, z: -0.238, sx: 0.020, sy: 0.014, sz: 0.010 });
  addSmile(B, 'head', { y: -0.075, z: -0.222, w: 0.055, tube: 0.010, color: 0x3d4a66 });
  addEyes(B, 'head', { y: 0.035, z: -0.155, spread: 0.088, r: 0.046, style: 'full', iris: EYE, pupil: 0x2a2f44, wz: 0.55 });
  // 牛耳（无角，改为一对叶耳）
  B.put('head', leafGeo(0.05, 0.11, 0.018), BODY_D, { x: 0.165, y: 0.10, z: 0.01, rz: -1.05, rx: -0.35 });
  B.put('head', leafGeo(0.05, 0.11, 0.018), BODY_D, { x: -0.165, y: 0.10, z: 0.01, rz: 1.05, rx: -0.35 });
  // 额头雷纹
  B.put('head', boltGeo(0.085, 0.012), PUR, { x: -0.02, y: 0.10, z: -0.205, glow: PUR, glowInt: 1.9 });

  // 背脊雷纹 + 缠身紫电（动画节点：呼吸式明灭 / 抖动）
  const spark = B.node('spark', 'root', 0, 0, 0);
  B.put('spark', boltGeo(0.17, 0.018), PUR, { x: -0.13, y: 0.70, z: 0.02, rx: -PI / 2, ry: 0.28, glow: PUR, glowInt: 1.8 });
  B.put('spark', boltGeo(0.17, 0.018), PUR, { x: 0.12, y: 0.71, z: 0.10, rx: -PI / 2, ry: -0.42, glow: PUR, glowInt: 1.8 });
  B.put('spark', TORUS(0.20, 0.016, PI * 1.15), PUR, { y: 0.55, z: 0.02, rx: PI / 2, ry: 0.20, glow: PUR, glowInt: 1.5 });
  B.put('spark', SPH(), PUR, { x: 0.215, y: 0.42, z: 0.10, sx: 0.022, sy: 0.022, sz: 0.022, glow: PUR, glowInt: 2.2 });
  B.put('spark', SPH(), PUR, { x: -0.20, y: 0.60, z: -0.10, sx: 0.017, sy: 0.017, sz: 0.017, glow: PUR, glowInt: 2.2 });

  return finishModel(B, function (nodes, dt, t) {
    nodes.head.rotation.x = Math.sin(t * 1.2) * 0.06;
    nodes.head.rotation.z = Math.sin(t * 0.7) * 0.04;
    nodes.tail.rotation.z = Math.sin(t * 1.8) * 0.14;
    nodes.tail.rotation.x = Math.sin(t * 1.2 + 0.6) * 0.10;
    const sp = 0.94 + Math.sin(t * 6.5) * 0.06;
    nodes.spark.scale.set(sp, sp, sp);
    nodes.spark.rotation.y = Math.sin(t * 0.9) * 0.08;
  }, { fitH: 0.86, fitInner: true });
}

// —— 麒麟 QILIN（mu）：四足瑞兽，鳞身、鹿角、金鬃、灵芝尾 ——
function buildQilin() {
  const B = Builder();
  const JADE = 0x4fb99f, JADE_D = 0x3a8f7c, JADE_L = 0x9fe6cf;
  const GOLD = 0xe8b33a, CREAM = 0xf6f2da, HOOF = 0x2c5a4e, EYE = 0xffd93d;

  // 四足（瑞兽短腿 + 金蹄）
  [[0.155, -0.19], [-0.155, -0.19], [0.155, 0.21], [-0.155, 0.21]].forEach(function (p) {
    B.put('root', SPH(), JADE_D, { x: p[0], y: 0.42, z: p[1], sx: 0.085, sy: 0.12, sz: 0.10 });
    B.put('root', CAPSULE(0.062, 0.24), JADE_D, { x: p[0], y: 0.25, z: p[1] });
    B.put('root', SPH(), JADE, { x: p[0], y: 0.12, z: p[1], sx: 0.072, sy: 0.085, sz: 0.078 });
    B.put('root', CYL(), GOLD, { x: p[0], y: 0.05, z: p[1] - 0.01, sx: 0.066, sy: 0.09, sz: 0.068, shine: true });
    B.put('root', SPH(), HOOF, { x: p[0], y: 0.016, z: p[1] - 0.01, sx: 0.074, sy: 0.024, sz: 0.084 });
  });

  // 躯干 + 腹甲
  B.put('root', SPH(), JADE, { y: 0.62, sx: 0.235, sy: 0.25, sz: 0.35 });
  B.put('root', SPH(), CREAM, { y: 0.52, z: -0.03, sx: 0.185, sy: 0.17, sz: 0.29 });
  // 金鳞（背侧两列半环）
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      B.put('root', TORUS(0.048, 0.011, PI), GOLD, {
        x: (j ? 1 : -1) * (0.135 + i * 0.012), y: 0.70 - i * 0.055, z: -0.12 + i * 0.15,
        rx: PI / 2, ry: (j ? -1 : 1) * 0.5, sz: 0.6, shine: true,
      });
    }
  }

  // 颈（前上方）+ 金鬃
  B.put('root', CAPSULE(0.105, 0.20), JADE, { y: 0.80, z: -0.26, rx: -0.62 });
  for (let i = 0; i < 4; i++) {
    B.put('root', CONE(), GOLD, {
      x: (i % 2 ? 0.045 : -0.045), y: 0.90 - i * 0.075, z: -0.13 - i * 0.055,
      sx: 0.055 - i * 0.008, sy: 0.13, sz: 0.045, rx: 0.9 + i * 0.12, rz: (i % 2 ? 1 : -1) * 0.18, shine: true,
    });
  }

  // 头（动画节点）
  const head = B.node('head', 'root', 0, 0.94, -0.40);
  B.put('head', SPH_HI(), JADE, { sx: 0.16, sy: 0.15, sz: 0.185 });
  B.put('head', SPH(), CREAM, { y: -0.055, z: -0.145, sx: 0.095, sy: 0.078, sz: 0.095 });
  B.put('head', SPH(), 0x27463d, { x: 0.035, y: -0.045, z: -0.215, sx: 0.014, sy: 0.010, sz: 0.008 });
  B.put('head', SPH(), 0x27463d, { x: -0.035, y: -0.045, z: -0.215, sx: 0.014, sy: 0.010, sz: 0.008 });
  addSmile(B, 'head', { y: -0.085, z: -0.205, w: 0.042, tube: 0.008, color: 0x2f5a4e });
  addEyes(B, 'head', { y: 0.045, z: -0.145, spread: 0.082, r: 0.043, style: 'full', iris: EYE, pupil: 0x2a3a34, wz: 0.55 });
  // 鹿角（分叉金角）
  [-1, 1].forEach(function (s) {
    const bx = s * 0.075;
    B.put('head', CONE(), GOLD, { x: bx, y: 0.24, z: 0.0, sx: 0.026, sy: 0.17, sz: 0.026, rz: s * 0.30, shine: true });
    B.put('head', CONE(), GOLD, { x: bx + s * 0.055, y: 0.33, z: 0.015, sx: 0.021, sy: 0.12, sz: 0.021, rz: s * 0.85, shine: true });
    B.put('head', CONE(), GOLD, { x: bx + s * 0.012, y: 0.345, z: -0.055, sx: 0.019, sy: 0.11, sz: 0.019, rx: -0.65, shine: true });
  });

  // 灵芝尾（动画节点）
  const tail = B.node('tail', 'root', 0, 0.74, 0.30);
  B.put('tail', CAPSULE(0.05, 0.12), JADE_D, { y: 0.01, z: 0.02, rx: PI / 2 - 0.5 });
  for (let i = -2; i <= 2; i++) {
    B.put('tail', leafGeo(0.055, 0.17, 0.014), (i % 2) ? GOLD : JADE_L, {
      x: i * 0.045, y: 0.10 - Math.abs(i) * 0.012, z: 0.10, rz: i * 0.34, rx: -0.9, shine: (i % 2) === 0,
    });
  }
  B.put('tail', TORUS(0.05, 0.012, TAU), GOLD, { y: 0.02, z: 0.10, rx: PI / 2, shine: true });

  return finishModel(B, function (nodes, dt, t) {
    nodes.head.rotation.x = Math.sin(t * 1.05) * 0.055;
    nodes.head.rotation.z = Math.sin(t * 0.8) * 0.04;
    nodes.tail.rotation.z = Math.sin(t * 1.6) * 0.12;
    nodes.tail.rotation.x = Math.sin(t * 1.15 + 0.4) * 0.08;
  }, { fitH: 1.0, fitInner: true });
}

// —— 毕方 BIFANG（huo）：独足火鸟，鹤形赤羽、金喙、翅尖燃焰 ——
function buildBifang() {
  const B = Builder();
  const RED = 0xe8453c, RED_D = 0xb8302a, GOLD = 0xffd93d, GOLD_D = 0xe8b33a;
  const CREAM = 0xfff2d0, FLAME = 0xff8a2a;

  // 独足（鹤腿：细长金腿 + 三趾 + 后趾）
  B.put('root', CYL(), GOLD_D, { y: 0.26, sx: 0.024, sy: 0.52, sz: 0.024 });
  B.put('root', SPH(), GOLD_D, { y: 0.50, sx: 0.045, sy: 0.05, sz: 0.045 });
  for (let k = 0; k < 3; k++) {
    B.put('root', CONE(), GOLD, { x: (k - 1) * 0.045, y: 0.028, z: -0.055, sx: 0.018, sy: 0.10, sz: 0.016, rx: -1.15, rz: (k - 1) * 0.2 });
  }
  B.put('root', CONE(), GOLD, { y: 0.03, z: 0.07, sx: 0.016, sy: 0.08, sz: 0.014, rx: 1.25 });

  // 身体（鹤形斜置）+ 腹羽
  B.put('root', SPH(), RED, { y: 0.70, z: 0.02, sx: 0.17, sy: 0.19, sz: 0.235, rx: 0.16 });
  B.put('root', SPH(), CREAM, { y: 0.63, z: -0.09, sx: 0.115, sy: 0.125, sz: 0.13 });

  // 尾羽（动画节点，赤金长羽）
  const tail = B.node('tail', 'root', 0, 0.76, 0.20);
  for (let i = -2; i <= 2; i++) {
    B.put('tail', leafGeo(0.05, 0.30, 0.012), (i % 2) ? GOLD : RED_D, {
      x: i * 0.035, y: 0.02, z: 0.03, rz: i * 0.26, rx: 0.75 + Math.abs(i) * 0.08,
    });
  }

  // 长颈（动画节点）
  const neck = B.node('neck', 'root', 0, 0.80, -0.10);
  capChain(B, 'neck', [[0, 0, 0], [0, 0.13, -0.055], [0, 0.24, -0.09], [0, 0.31, -0.105]], [0.068, 0.058, 0.05, 0.045], RED);

  // 头（动画节点）
  const head = B.node('head', 'neck', 0, 0.355, -0.115);
  B.put('head', SPH(), RED, { y: 0.015, sx: 0.10, sy: 0.092, sz: 0.115 });
  B.put('head', SPH(), CREAM, { y: -0.02, z: -0.065, sx: 0.065, sy: 0.052, sz: 0.06 });
  // 金喙
  B.put('head', CONE(), GOLD, { y: -0.005, z: -0.145, sx: 0.042, sy: 0.155, sz: 0.036, rx: -PI / 2 - 0.12, shine: true });
  // 赤冠 + 火冠羽
  B.put('head', leafGeo(0.035, 0.15, 0.012), RED_D, { y: 0.16, z: 0.01, rx: -0.35 });
  B.put('head', leafGeo(0.028, 0.11, 0.010), FLAME, { y: 0.14, z: -0.03, rx: -0.7, glow: FLAME, glowInt: 1.5 });
  addEyes(B, 'head', { y: 0.045, z: -0.075, spread: 0.052, r: 0.028, style: 'full', iris: 0xffe066, pupil: 0x2a1a14, wz: 0.62 });

  // 双翼（动画节点）+ 翅尖燃焰
  [['wingL', -1], ['wingR', 1]].forEach(function (w) {
    const name = w[0], s = w[1];
    B.node(name, 'root', s * 0.13, 0.80, 0.0);
    for (let i = 0; i < 3; i++) {
      B.put(name, leafGeo(0.10 - i * 0.014, 0.30 - i * 0.03, 0.012), i === 1 ? GOLD : RED, {
        x: s * (0.10 + i * 0.075), y: 0.03 - i * 0.02, z: 0.02 + i * 0.05,
        rz: s * (-1.15 - i * 0.18), ry: s * 0.25, rx: -0.15,
      });
    }
    B.put(name, CONE(), FLAME, { x: s * 0.32, y: 0.05, z: 0.10, sx: 0.045, sy: 0.16, sz: 0.045, rz: s * -0.9, glow: FLAME, glowInt: 1.9 });
    B.put(name, CONE(), GOLD, { x: s * 0.36, y: 0.10, z: 0.10, sx: 0.026, sy: 0.10, sz: 0.026, rz: s * -0.9, glow: GOLD, glowInt: 2.2 });
  });

  return finishModel(B, function (nodes, dt, t) {
    const flap = Math.sin(t * 6.2);
    nodes.wingL.rotation.z = 0.18 + flap * 0.22;
    nodes.wingR.rotation.z = -0.18 - flap * 0.22;
    nodes.wingL.rotation.x = Math.sin(t * 4.1) * 0.08;
    nodes.wingR.rotation.x = Math.sin(t * 4.1 + 0.6) * 0.08;
    nodes.neck.rotation.x = Math.sin(t * 1.3) * 0.05;
    nodes.head.rotation.x = Math.sin(t * 1.1 + 0.6) * 0.06;
    nodes.head.rotation.y = Math.sin(t * 0.8) * 0.12;
    nodes.tail.rotation.z = Math.sin(t * 1.5) * 0.08;
    nodes.tail.rotation.x = Math.sin(t * 2.0 + 0.3) * 0.10;
  }, { fitH: 1.05, fitInner: true });
}

// —— 玄武 XUANWU（shui）：龟蛇合体，墨绿龟甲金纹、青色蛇颈缠绕 ——
function buildXuanwu() {
  const B = Builder();
  const SHELL = 0x2f4a3a, SHELL_L = 0x3f6450, SHELL_D = 0x1f3327, GOLD = 0xe8b33a;
  const SNAKE = 0x4fb9a8, SNAKE_D = 0x2f8f80, CREAM = 0xd8e8d4, EYE = 0xffd93d;

  // 四足（龟足）+ 尾
  [[0.215, -0.15], [-0.215, -0.15], [0.215, 0.17], [-0.215, 0.17]].forEach(function (p) {
    B.put('root', SPH(), SHELL_L, { x: p[0], y: 0.20, z: p[1], sx: 0.095, sy: 0.115, sz: 0.10 });
    B.put('root', SPH(), CREAM, { x: p[0], y: 0.045, z: p[1] - 0.02, sx: 0.095, sy: 0.045, sz: 0.10 });
  });
  const tail = B.node('tail', 'root', 0, 0.34, 0.30);
  B.put('tail', CONE(), SHELL_L, { z: 0.08, sx: 0.045, sy: 0.17, sz: 0.038, rx: PI / 2 + 0.45 });

  // 龟身 + 龟甲（半球）+ 金边 + 甲纹
  B.put('root', SPH(), SHELL_D, { y: 0.33, sx: 0.30, sy: 0.22, sz: 0.345 });
  B.put('root', HEMI(), SHELL, { y: 0.37, sx: 0.315, sy: 0.31, sz: 0.36 });
  B.put('root', TORUS(0.30, 0.024, TAU), GOLD, { y: 0.38, rx: PI / 2, sy: 1.14, shine: true });
  for (let i = 0; i < 3; i++) {
    B.put('root', TORUS(0.095 + i * 0.052, 0.011, PI * 0.9), GOLD, {
      x: (i - 1) * 0.07, y: 0.635 - i * 0.015, z: 0.03, rx: -1.15, ry: (i - 1) * 0.28, shine: true,
    });
  }

  // 龟首（动画节点）
  const head = B.node('head', 'root', 0, 0.42, -0.33);
  B.put('head', SPH(), SHELL_L, { y: 0.02, sx: 0.105, sy: 0.10, sz: 0.135 });
  B.put('head', SPH(), CREAM, { y: -0.01, z: -0.10, sx: 0.07, sy: 0.055, sz: 0.07 });
  addEyes(B, 'head', { y: 0.045, z: -0.10, spread: 0.058, r: 0.028, style: 'full', iris: EYE, pupil: 0x203028, wz: 0.6 });

  // 青蛇（动画节点）：从甲后绕到身前，蛇首昂起
  const serpent = B.node('serpent', 'root', 0, 0.42, 0.14);
  capChain(B, 'serpent', [
    [0, 0, 0], [0.20, 0.08, -0.02], [0.28, 0.22, -0.12], [0.20, 0.34, -0.24],
    [0.02, 0.36, -0.30], [-0.16, 0.30, -0.28], [-0.225, 0.20, -0.225],
  ], [0.072, 0.068, 0.06, 0.054, 0.048, 0.042, 0.038], SNAKE);
  [[0.20, 0.08, -0.02], [0.20, 0.34, -0.24], [-0.16, 0.30, -0.28]].forEach(function (p) {
    B.put('serpent', TORUS(0.055, 0.011, TAU), GOLD, { x: p[0], y: p[1], z: p[2], rx: 0.9, shine: true });
  });

  B.node('snakeHead', 'serpent', -0.235, 0.205, -0.225);
  B.put('snakeHead', SPH(), SNAKE, { y: 0.02, sx: 0.08, sy: 0.068, sz: 0.10 });
  B.put('snakeHead', SPH(), SNAKE_D, { y: -0.015, z: -0.09, sx: 0.045, sy: 0.03, sz: 0.045 });
  addEyes(B, 'snakeHead', { y: 0.05, z: -0.05, spread: 0.042, r: 0.024, style: 'full', iris: EYE, pupil: 0x1e2a24, wz: 0.62 });
  B.put('snakeHead', CAPSULE(0.007, 0.06), 0xd0432e, { y: -0.01, z: -0.155, rx: PI / 2 });
  B.put('snakeHead', CAPSULE(0.006, 0.035), 0xd0432e, { x: 0.018, y: -0.01, z: -0.19, rx: PI / 2, ry: 0.4 });
  B.put('snakeHead', CAPSULE(0.006, 0.035), 0xd0432e, { x: -0.018, y: -0.01, z: -0.19, rx: PI / 2, ry: -0.4 });

  return finishModel(B, function (nodes, dt, t) {
    nodes.head.rotation.x = Math.sin(t * 1.0) * 0.06;
    nodes.head.rotation.z = Math.sin(t * 0.7) * 0.045;
    nodes.tail.rotation.z = Math.sin(t * 1.5) * 0.12;
    nodes.serpent.rotation.y = Math.sin(t * 0.85) * 0.12;
    nodes.serpent.rotation.z = Math.sin(t * 1.15 + 0.4) * 0.06;
    nodes.snakeHead.rotation.x = Math.sin(t * 1.6 + 0.3) * 0.10;
    nodes.snakeHead.rotation.y = Math.sin(t * 1.1) * 0.14;
  }, { fitH: 0.95, fitInner: true });
}

// ===========================================================================
// 5. 行者模型（四位，站立 + 右手前举持法器）
// ===========================================================================
// 造型要点见 MYTHOLOGY 第 2 节：配色 / 服饰 / 头饰为中国神话风。
// 骨架与动画节点名与旧版一致：root / torso / head / armL / armR / handAnchor；
// 句芒额外有 hairL / hairR / cape，玄冥额外有 pony，雷公额外有 drum / tassel。
const TRAINER_LOOKS = {
  // 雷公：深蓝短打 + 鎏金云肩 + 雷纹头巾 + 束袖，背后小雷鼓，赤绳结
  t_bolt: {
    skin: 0xf0c8a0, hair: 0x2a2028,
    robe: 0x2f4a7a, robeD: 0x24395e, sleeve: 0x2a3f66,
    trim: 0xe8b33a, trimD: 0xc28e22, accent: 0xffd93d,
    pants: 0x263a5c, boot: 0x22304a, sole: 0x152033, glove: 0x3d2a22,
    sash: 0xd0432e, light: 0x8fa8d8,
  },
  // 句芒：青绿道袍 + 木纹护腕 + 鹿角木冠 + 藤蔓腰带，羽形披肩
  t_leaf: {
    skin: 0xf3cba8, hair: 0x3a2a1e,
    robe: 0x4e9c3f, robeD: 0x3a7a2c, sleeve: 0x6fbb4a,
    trim: 0xd8f0c0, trimD: 0xa8d890, accent: 0x7ec850,
    pants: 0x2f4a2a, boot: 0x6a4a2e, sole: 0x3f2a18, glove: 0x6a4a2e,
    sash: 0x7ac95a, light: 0x9fe08a, wood: 0x8a5a2a,
  },
  // 祝融：赤红甲胄 + 火焰纹披风 + 朱发束冠 + 金环臂钏
  t_ember: {
    skin: 0xe8b088, hair: 0xd0432e,
    robe: 0xd0432e, robeD: 0xa8301f, sleeve: 0xb8302a,
    trim: 0xe8b33a, trimD: 0xc28e22, accent: 0xff8a3d,
    pants: 0x3a2420, boot: 0x2b1a16, sole: 0x1a100d, glove: 0x2b1a16,
    sash: 0xe8b33a, light: 0xffc48a,
  },
  // 玄冥：玄青长袍 + 浪纹 + 龟甲护心 + 玉簪束发，蓝发
  t_tide: {
    skin: 0xefc8a8, hair: 0x3f8fc0,
    robe: 0x24485a, robeD: 0x18323f, sleeve: 0x2c5a70,
    trim: 0x7ad0c8, trimD: 0x4fb0a8, accent: 0x5ab8f0,
    pants: 0x1b2f3a, boot: 0x1b2f3a, sole: 0x101c24, glove: 0x2c5a70,
    sash: 0x7ad0c8, light: 0x9fe8e0,
  },
};

// 通用人形骨架：靴 / 腿 / 袍 / 腰带 + 躯干 + 头 + 双臂（右手前举持法器）
function buildTrainer(id) {
  const L = TRAINER_LOOKS[id] || TRAINER_LOOKS.t_bolt;
  const B = Builder();

  // ---------------- 下半身（不参与动画） ----------------
  [1, -1].forEach(function (s) {
    // 靴：靴筒 + 靴面 + 靴头 + 鞋底 + 靴口金边
    B.put('root', CAPSULE(0.072, 0.18), L.boot, { x: s * 0.105, y: 0.30, z: 0.0 });
    B.put('root', SPH(), L.boot, { x: s * 0.105, y: 0.135, z: -0.02, sx: 0.088, sy: 0.08, sz: 0.12 });
    B.put('root', SPH(), L.boot, { x: s * 0.105, y: 0.075, z: -0.10, sx: 0.072, sy: 0.05, sz: 0.075 });
    B.put('root', SPH(), L.sole, { x: s * 0.105, y: 0.028, z: -0.04, sx: 0.098, sy: 0.026, sz: 0.175 });
    B.put('root', SPH(), L.trim, { x: s * 0.105, y: 0.20, z: -0.01, sx: 0.085, sy: 0.013, sz: 0.11, shine: true });
    // 小腿 / 大腿 / 膝
    B.put('root', CAPSULE(0.058, 0.24), L.pants, { x: s * 0.105, y: 0.44, z: -0.005 });
    B.put('root', CAPSULE(0.079, 0.26), L.pants, { x: s * 0.10, y: 0.72, z: 0.0 });
    B.put('root', SPH(), L.pants, { x: s * 0.105, y: 0.555, z: -0.015, sx: 0.063, sy: 0.062, sz: 0.066 });
  });

  // 袍下摆：道袍 / 长袍为长裙，短打为胯前布片
  if (id === 't_leaf' || id === 't_tide') {
    B.put('root', CONE(), L.robeD, { y: 0.60, z: 0.015, sx: 0.285, sy: 0.68, sz: 0.245 });
    B.put('root', CONE(), L.robe, { y: 0.63, sx: 0.275, sy: 0.70, sz: 0.235 });
    B.put('root', TORUS(0.27, 0.018, TAU), L.trim, { y: 0.285, rx: PI / 2, sy: 1.0, shine: true });
  } else {
    B.put('root', CONE(), L.robe, { y: 0.83, sx: 0.19, sy: 0.30, sz: 0.155 });
    B.put('root', SPH(), L.robeD, { y: 0.80, z: -0.10, sx: 0.145, sy: 0.10, sz: 0.04 });
  }

  // 胯 + 腰带 + 腰扣
  B.put('root', SPH(), L.pants, { y: 0.93, sx: 0.175, sy: 0.115, sz: 0.125 });
  B.put('root', CYL(), L.sash, { y: 1.00, sx: 0.172, sy: 0.055, sz: 0.132 });
  B.put('root', SPH(), L.trim, { y: 1.00, z: -0.128, sx: 0.045, sy: 0.032, sz: 0.014, shine: true });
  // 腰带垂下的绳结
  B.put('root', CAPSULE(0.012, 0.10), L.sash, { x: 0.05, y: 0.93, z: -0.13, rx: 0.1 });
  B.put('root', CAPSULE(0.010, 0.08), L.sash, { x: 0.075, y: 0.92, z: -0.125, rx: 0.15, rz: 0.2 });

  // ---------------- 躯干（动画节点） ----------------
  const torso = B.node('torso', 'root', 0, 0.98, 0);
  B.put('torso', SPH_HI(), L.robe, { y: 0.22, sx: 0.185, sy: 0.245, sz: 0.132 });
  B.put('torso', SPH(), L.robeD, { y: 0.04, sx: 0.165, sy: 0.06, sz: 0.12 });
  // 交领（右衽）：两片斜襟在胸骨处交汇成 V
  B.put('torso', SPH(), L.trim, { x: -0.052, y: 0.285, z: -0.116, sx: 0.019, sy: 0.155, sz: 0.020, rz: 0.58, shine: true });
  B.put('torso', SPH(), L.trim, { x: 0.052, y: 0.285, z: -0.116, sx: 0.019, sy: 0.155, sz: 0.020, rz: -0.58, shine: true });
  B.put('torso', CYL(), L.trim, { y: 0.40, sx: 0.078, sy: 0.036, sz: 0.064, shine: true });
  // 肩 / 袖根
  B.put('torso', SPH(), L.sleeve, { x: 0.185, y: 0.34, z: 0.0, sx: 0.082, sy: 0.078, sz: 0.085 });
  B.put('torso', SPH(), L.sleeve, { x: -0.185, y: 0.34, z: 0.0, sx: 0.082, sy: 0.078, sz: 0.085 });
  // 脖子与头
  B.put('torso', CYL(), L.skin, { y: 0.42, sx: 0.058, sy: 0.07, sz: 0.058 });
  const head = B.node('head', 'torso', 0, 0.50, 0);

  // ---------------- 头部基础 ----------------
  B.put('head', SPH_HI(), L.skin, { y: 0.13, sx: 0.145, sy: 0.155, sz: 0.142 });
  B.put('head', SPH(), L.skin, { x: 0.142, y: 0.12, z: 0.005, sx: 0.032, sy: 0.048, sz: 0.03 });
  B.put('head', SPH(), L.skin, { x: -0.142, y: 0.12, z: 0.005, sx: 0.032, sy: 0.048, sz: 0.03 });
  addEyes(B, 'head', { y: 0.155, z: -0.118, spread: 0.056, r: 0.034, style: 'full', white: 0xfffdf8, iris: 0x3a2a20, pupil: 0x241c14, wz: 0.5, hiR: 0.28 });
  B.put('head', SPH(), L.hair, { x: 0.058, y: 0.215, z: -0.115, sx: 0.038, sy: 0.010, sz: 0.014, rz: id === 't_ember' ? 0.20 : 0.05 });
  B.put('head', SPH(), L.hair, { x: -0.058, y: 0.215, z: -0.115, sx: 0.038, sy: 0.010, sz: 0.014, rz: id === 't_ember' ? -0.20 : -0.05 });
  B.put('head', SPH(), L.skin, { y: 0.115, z: -0.142, sx: 0.018, sy: 0.016, sz: 0.018 });
  addSmile(B, 'head', { y: 0.058, z: -0.132, w: 0.032, tube: 0.008, color: 0x8a4a3a });
  B.put('head', SPH(), 0xff9a9a, { x: 0.10, y: 0.085, z: -0.105, sx: 0.028, sy: 0.016, sz: 0.014 });
  B.put('head', SPH(), 0xff9a9a, { x: -0.10, y: 0.085, z: -0.105, sx: 0.028, sy: 0.016, sz: 0.014 });

  // ---------------- 左臂（自然下垂） ----------------
  const armL = B.node('armL', 'torso', -0.205, 0.36, 0);
  B.put('armL', CAPSULE(0.058, 0.15), L.sleeve, { x: -0.012, y: -0.10, z: 0.0, rz: 0.06 });
  B.put('armL', SPH(), L.skin, { x: -0.02, y: -0.21, z: 0.0, sx: 0.052, sy: 0.052, sz: 0.052 });
  B.put('armL', CAPSULE(0.046, 0.17), L.skin, { x: -0.026, y: -0.32, z: -0.012, rz: 0.03 });
  B.put('armL', SPH(), L.skin, { x: -0.03, y: -0.43, z: -0.022, sx: 0.055, sy: 0.062, sz: 0.05 });
  B.put('armL', CYL(), L.glove, { x: -0.03, y: -0.39, z: -0.02, sx: 0.05, sy: 0.03, sz: 0.046 });
  for (let k = 0; k < 3; k++) {
    B.put('armL', CAPSULE(0.012, 0.045), L.skin, { x: -0.03 + (k - 1) * 0.024, y: -0.485, z: -0.03, rz: (k - 1) * 0.16 });
  }

  // ---------------- 右臂（前举握着法器） ----------------
  const armR = B.node('armR', 'torso', 0.205, 0.36, 0);
  B.put('armR', CAPSULE(0.060, 0.13), L.sleeve, { x: 0.022, y: -0.055, z: -0.085, rx: -0.62 });
  B.put('armR', SPH(), L.sleeve, { x: 0.05, y: -0.105, z: -0.165, sx: 0.055, sy: 0.055, sz: 0.055 });
  B.put('armR', CAPSULE(0.048, 0.15), L.skin, { x: 0.042, y: -0.085, z: -0.29, rx: -1.32 });
  B.put('armR', CYL(), L.glove, { x: 0.038, y: -0.05, z: -0.395, sx: 0.05, sy: 0.026, sz: 0.048, rx: -1.2 });
  B.put('armR', SPH(), L.skin, { x: 0.034, y: -0.025, z: -0.44, sx: 0.058, sy: 0.048, sz: 0.068 });
  for (let k = 0; k < 3; k++) {
    B.put('armR', CAPSULE(0.013, 0.045), L.skin, {
      x: 0.034 + (k - 1) * 0.026, y: -0.005, z: -0.49, rx: -PI / 2 + 0.25, rz: (k - 1) * 0.12,
    });
  }
  // 挂载点：90-main 可把法器挂到这里（跟随右臂动画）
  const anchor = new T3.Object3D();
  anchor.name = 'handAnchor';
  anchor.position.set(0.034, -0.02, -0.50);
  armR.add(anchor);

  // ---------------- 发型与专属配饰 ----------------
  if (id === 't_bolt') {
    // 雷公：雷纹头巾 + 鎏金云肩 + 束袖 + 背后小雷鼓 + 赤绳结
    B.put('head', HEMI(), L.robeD, { y: 0.19, z: 0.01, sx: 0.152, sy: 0.135, sz: 0.152 });
    B.put('head', TORUS(0.148, 0.020, TAU), L.robeD, { y: 0.165, z: 0.01, rx: PI / 2 - 0.10 });
    B.put('head', TORUS(0.150, 0.010, TAU), L.trim, { y: 0.128, z: 0.01, rx: PI / 2 - 0.10, shine: true });
    B.put('head', boltGeo(0.075, 0.012), L.accent, { y: 0.19, z: -0.145, glow: L.accent, glowInt: 1.4 });
    B.put('head', SPH(), L.hair, { x: 0.13, y: 0.08, z: 0.0, sx: 0.035, sy: 0.06, sz: 0.05 });
    B.put('head', SPH(), L.hair, { x: -0.13, y: 0.08, z: 0.0, sx: 0.035, sy: 0.06, sz: 0.05 });
    B.put('head', SPH(), L.hair, { y: 0.17, z: 0.10, sx: 0.10, sy: 0.07, sz: 0.055 });
    // 云肩：三片云头甲叠在双肩
    [-1, 1].forEach(function (s) {
      for (let i = 0; i < 3; i++) {
        B.put('torso', SPH(), L.trim, {
          x: s * (0.14 + i * 0.035), y: 0.35 - i * 0.035, z: -0.02 + i * 0.02,
          sx: 0.075 - i * 0.012, sy: 0.032, sz: 0.075, rz: s * (0.18 + i * 0.22), shine: true,
        });
      }
    });
    // 束袖（金口）
    B.put('armL', CYL(), L.trim, { x: -0.028, y: -0.245, z: -0.006, sx: 0.052, sy: 0.026, sz: 0.05, shine: true });
    B.put('armR', CYL(), L.trim, { x: 0.045, y: -0.10, z: -0.345, sx: 0.052, sy: 0.024, sz: 0.05, rx: -1.2, shine: true });
    // 背后小雷鼓
    const drum = B.node('drum', 'torso', 0, 0.20, 0.175);
    B.put('drum', CYL(), L.robeD, { sx: 0.105, sy: 0.06, sz: 0.105, rx: PI / 2 });
    B.put('drum', TORUS(0.104, 0.013, TAU), L.trim, { z: 0.031, shine: true });
    B.put('drum', TORUS(0.104, 0.013, TAU), L.trim, { z: -0.031, shine: true });
    B.put('drum', SPH(), 0xfff2d0, { z: 0.033, sx: 0.088, sy: 0.088, sz: 0.018 });
    B.put('drum', SPH(), 0xfff2d0, { z: -0.033, sx: 0.088, sy: 0.088, sz: 0.018 });
    B.put('drum', CAPSULE(0.010, 0.13), 0x6a4a2e, { x: 0.07, y: 0.07, z: 0.05, rz: 0.6, ry: 0.3 });
    B.put('drum', CAPSULE(0.010, 0.13), 0x6a4a2e, { x: -0.07, y: 0.07, z: 0.05, rz: -0.6, ry: -0.3 });
    // 赤绳结 + 流苏
    const tassel = B.node('tassel', 'torso', 0, 0.10, 0.16);
    B.put('tassel', SPH(), L.sash, { sx: 0.035, sy: 0.03, sz: 0.03 });
    B.put('tassel', CAPSULE(0.010, 0.10), L.sash, { y: -0.09 });
    B.put('tassel', CAPSULE(0.008, 0.08), L.sash, { x: 0.02, y: -0.09, rz: 0.2 });
    B.put('tassel', SPH(), L.trim, { y: -0.15, sx: 0.014, sy: 0.02, sz: 0.014, shine: true });
  } else if (id === 't_leaf') {
    // 句芒：青绿道袍 + 鹿角木冠 + 藤蔓腰带 + 木纹护腕 + 羽形披肩
    B.put('head', SPH(), L.hair, { y: 0.20, z: 0.02, sx: 0.150, sy: 0.115, sz: 0.150 });
    B.put('head', SPH(), L.hair, { y: 0.155, z: -0.085, sx: 0.135, sy: 0.085, sz: 0.085 });
    B.put('head', SPH(), L.hair, { x: 0.06, y: 0.16, z: -0.115, sx: 0.06, sy: 0.07, sz: 0.045, rz: -0.25 });
    B.put('head', SPH(), L.hair, { x: -0.06, y: 0.16, z: -0.115, sx: 0.06, sy: 0.07, sz: 0.045, rz: 0.25 });
    // 鹿角木冠（木纹分叉 + 横带）
    [-1, 1].forEach(function (s) {
      B.put('head', CONE(), L.wood, { x: s * 0.06, y: 0.27, z: 0.02, sx: 0.022, sy: 0.18, sz: 0.022, rz: s * 0.42 });
      B.put('head', CONE(), L.wood, { x: s * 0.105, y: 0.34, z: 0.03, sx: 0.017, sy: 0.12, sz: 0.017, rz: s * 0.95 });
      B.put('head', CONE(), L.wood, { x: s * 0.045, y: 0.37, z: -0.02, sx: 0.015, sy: 0.10, sz: 0.015, rx: -0.35, rz: s * 0.15 });
    });
    B.put('head', TORUS(0.132, 0.016, TAU), L.wood, { y: 0.205, z: 0.005, rx: PI / 2 - 0.12 });
    // 两侧长发（动画节点）
    B.node('hairL', 'head', -0.148, 0.15, 0.02);
    B.node('hairR', 'head', 0.148, 0.15, 0.02);
    capChain(B, 'hairL', [[-0.005, 0.01, 0.0], [-0.028, -0.10, 0.035], [-0.03, -0.22, 0.065], [-0.018, -0.32, 0.055]], [0.042, 0.036, 0.026, 0.015], L.hair);
    capChain(B, 'hairR', [[0.005, 0.01, 0.0], [0.028, -0.10, 0.035], [0.03, -0.22, 0.065], [0.018, -0.32, 0.055]], [0.042, 0.036, 0.026, 0.015], L.hair);
    B.put('hairL', SPH(), L.trim, { y: 0.04, z: 0.01, sx: 0.03, sy: 0.02, sz: 0.028 });
    B.put('hairR', SPH(), L.trim, { y: 0.04, z: 0.01, sx: 0.03, sy: 0.02, sz: 0.028 });
    // 羽形披肩（动画节点：随呼吸轻摆）
    const cape = B.node('cape', 'torso', 0, 0.34, 0.045);
    for (let i = -2; i <= 2; i++) {
      B.put('cape', leafGeo(0.075, 0.26, 0.014), (i % 2) ? L.trim : L.light, {
        x: i * 0.085, y: -0.02, z: 0.02 + Math.abs(i) * 0.01,
        rz: i * 0.22, rx: 0.30 + Math.abs(i) * 0.05,
      });
    }
    B.put('cape', SPH(), L.robe, { y: 0.02, z: 0.01, sx: 0.17, sy: 0.075, sz: 0.09 });
    // 木纹护腕
    B.put('armL', CYL(), L.wood, { x: -0.028, y: -0.24, z: -0.006, sx: 0.054, sy: 0.045, sz: 0.052 });
    B.put('armR', CYL(), L.wood, { x: 0.045, y: -0.10, z: -0.345, sx: 0.054, sy: 0.04, sz: 0.052, rx: -1.2 });
    // 藤蔓腰带 + 垂藤小叶
    B.put('root', CYL(), L.sash, { y: 1.00, sx: 0.176, sy: 0.04, sz: 0.132 });
    B.put('root', CAPSULE(0.012, 0.16), L.sash, { x: 0.08, y: 0.90, z: -0.12, rx: 0.15 });
    B.put('root', CAPSULE(0.010, 0.12), L.sash, { x: -0.06, y: 0.91, z: -0.125, rx: 0.10, rz: 0.12 });
    B.put('root', leafGeo(0.03, 0.07, 0.008), L.accent, { x: 0.095, y: 0.845, z: -0.125, rz: 0.6 });
    B.put('root', leafGeo(0.026, 0.06, 0.008), L.accent, { x: -0.075, y: 0.86, z: -0.128, rz: -0.5 });
    // 道袍前襟与下摆纹
    B.put('torso', SPH(), L.trim, { y: 0.14, z: -0.124, sx: 0.10, sy: 0.02, sz: 0.018, shine: true });
    B.put('root', TORUS(0.20, 0.012, PI), L.accent, { y: 0.46, z: -0.19, rx: PI / 2, ry: 0.0, sz: 0.8 });
  } else if (id === 't_ember') {
    // 祝融：朱发束冠 + 赤红甲胄 + 火焰纹披风 + 金环臂钏
    B.put('head', SPH(), L.hair, { y: 0.21, z: 0.02, sx: 0.148, sy: 0.115, sz: 0.148 });
    B.put('head', SPH(), L.hair, { y: 0.30, z: 0.05, sx: 0.085, sy: 0.075, sz: 0.085 });
    B.put('head', TORUS(0.075, 0.016, TAU), L.trim, { y: 0.30, z: 0.05, rx: PI / 2, shine: true });
    B.put('head', CONE(), L.trim, { y: 0.385, z: 0.05, sx: 0.026, sy: 0.09, sz: 0.026, shine: true });
    [-1, 1].forEach(function (s) {
      B.put('head', CONE(), L.accent, { x: s * 0.06, y: 0.35, z: 0.03, sx: 0.022, sy: 0.10, sz: 0.018, rz: s * 0.35, glow: L.accent, glowInt: 1.3 });
    });
    B.put('head', SPH(), L.hair, { x: 0.055, y: 0.175, z: -0.115, sx: 0.06, sy: 0.055, sz: 0.045, rz: -0.3 });
    B.put('head', SPH(), L.hair, { x: -0.055, y: 0.175, z: -0.115, sx: 0.06, sy: 0.055, sz: 0.045, rz: 0.3 });
    // 火焰纹披风（动画节点）
    const cape = B.node('cape', 'torso', 0, 0.34, 0.045);
    B.put('cape', CONE(), L.robeD, { y: -0.16, z: 0.03, sx: 0.255, sy: 0.44, sz: 0.225 });
    for (let i = 0; i < 3; i++) {
      B.put('cape', CONE(), L.accent, { x: (i - 1) * 0.09, y: -0.18 - Math.abs(i - 1) * 0.02, z: -0.10, sx: 0.026, sy: 0.12, sz: 0.018, rx: 0.5, glow: L.accent, glowInt: 1.5 });
    }
    B.put('cape', TORUS(0.20, 0.018, TAU), L.trim, { y: -0.36, rx: PI / 2, sz: 0.86, shine: true });
    // 赤红甲胄：胸片 + 肩甲
    B.put('torso', SPH(), L.robeD, { y: 0.25, z: -0.112, sx: 0.14, sy: 0.145, sz: 0.034 });
    B.put('torso', SPH(), L.trim, { y: 0.25, z: -0.118, sx: 0.148, sy: 0.152, sz: 0.028, shine: true });
    B.put('torso', CONE(), L.accent, { y: 0.25, z: -0.142, sx: 0.028, sy: 0.08, sz: 0.014, glow: L.accent, glowInt: 1.2 });
    [-1, 1].forEach(function (s) {
      B.put('torso', SPH(), L.robeD, { x: s * 0.20, y: 0.36, z: 0.0, sx: 0.09, sy: 0.075, sz: 0.095 });
      B.put('torso', TORUS(0.075, 0.012, PI), L.trim, { x: s * 0.205, y: 0.325, z: -0.03, rx: PI / 2, ry: s * 0.3, shine: true });
    });
    // 金环臂钏
    B.put('armL', TORUS(0.058, 0.011, TAU), L.trim, { x: -0.024, y: -0.16, z: -0.005, rx: PI / 2, shine: true });
    B.put('armR', TORUS(0.055, 0.011, TAU), L.trim, { x: 0.043, y: -0.09, z: -0.20, rx: -1.2, shine: true });
  } else {
    // 玄冥：蓝发玉簪 + 玄青长袍浪纹 + 龟甲护心
    B.put('head', SPH(), L.hair, { y: 0.20, z: 0.025, sx: 0.148, sy: 0.115, sz: 0.148 });
    B.put('head', SPH(), L.hair, { y: 0.30, z: 0.06, sx: 0.078, sy: 0.07, sz: 0.078 });
    B.put('head', CYL(), L.trim, { y: 0.315, z: 0.06, sx: 0.012, sy: 0.26, sz: 0.012, rx: PI / 2, shine: true });
    B.put('head', SPH(), L.light, { x: 0.10, y: 0.235, z: -0.06, sx: 0.045, sy: 0.022, sz: 0.06, rz: -0.4 });
    // 后马尾（动画节点）
    B.node('pony', 'head', 0, 0.17, 0.135);
    capChain(B, 'pony', [[0, 0.01, 0], [0.01, 0.08, 0.09], [0.02, 0.02, 0.19], [0.02, -0.10, 0.26], [0.01, -0.20, 0.30]], [0.052, 0.045, 0.035, 0.024, 0.013], L.hair);
    B.put('pony', TORUS(0.040, 0.012, TAU), L.trim, { y: 0.02, z: 0.02, rx: PI / 2 + 0.5, shine: true });
    B.put('pony', CAPSULE(0.016, 0.12), L.light, { x: 0.03, y: -0.02, z: 0.14, rx: 0.9, ry: 0.2 });
    // 龟甲护心（墨绿甲片 + 青玉边）
    B.put('torso', SPH(), 0x3f6450, { y: 0.25, z: -0.112, sx: 0.135, sy: 0.135, sz: 0.035 });
    B.put('torso', TORUS(0.105, 0.014, TAU), L.trim, { y: 0.25, z: -0.118, shine: true });
    B.put('torso', SPH(), 0x2f4a3a, { y: 0.25, z: -0.132, sx: 0.085, sy: 0.085, sz: 0.012 });
    // 浪纹（袍摆上的青玉弧线）
    for (let i = 0; i < 3; i++) {
      B.put('root', TORUS(0.075 + i * 0.02, 0.010, PI), L.trim, { x: (i - 1) * 0.085, y: 0.42 + i * 0.10, z: -0.205, rz: PI, shine: true });
    }
    B.put('root', TORUS(0.24, 0.012, PI), L.accent, { y: 0.34, z: -0.16, rx: PI / 2, sz: 0.85, glow: L.accent, glowInt: 1.1 });
  }

  // ---------------- 待机动画 ----------------
  const anim = function (nodes, dt, t) {
    const br = Math.sin(t * 1.55);
    nodes.torso.scale.y = 1 + br * 0.010;
    nodes.torso.rotation.z = Math.sin(t * 0.62) * 0.012;
    nodes.head.rotation.x = Math.sin(t * 0.95) * 0.028;
    nodes.head.rotation.y = Math.sin(t * 0.48 + 1.2) * 0.07;
    // 持法器手保持稳定，只留一两毫米呼吸位移
    nodes.armR.rotation.x = Math.sin(t * 1.55 + 0.6) * 0.012;
    nodes.armR.rotation.z = Math.sin(t * 0.62) * 0.008;
    nodes.armL.rotation.x = Math.sin(t * 1.3 + 1.7) * 0.035;
    if (nodes.hairL) {
      nodes.hairL.rotation.z = Math.sin(t * 1.8) * 0.10;
      nodes.hairL.rotation.x = Math.sin(t * 1.3 + 0.5) * 0.07;
      nodes.hairR.rotation.z = -Math.sin(t * 1.8 + 0.4) * 0.10;
      nodes.hairR.rotation.x = Math.sin(t * 1.3 + 0.9) * 0.07;
    }
    if (nodes.pony) {
      nodes.pony.rotation.z = Math.sin(t * 1.65) * 0.09;
      nodes.pony.rotation.x = Math.sin(t * 1.2 + 0.8) * 0.07;
    }
    if (nodes.cape) {
      nodes.cape.rotation.x = Math.sin(t * 1.4) * 0.022;
      nodes.cape.rotation.z = Math.sin(t * 0.9 + 0.5) * 0.018;
    }
    if (nodes.drum) {
      nodes.drum.rotation.z = Math.sin(t * 1.1) * 0.05;
    }
    if (nodes.tassel) {
      nodes.tassel.rotation.z = Math.sin(t * 1.4) * 0.14;
      nodes.tassel.rotation.x = Math.sin(t * 1.05) * 0.10;
    }
  };

  return finishModel(B, anim, { fitH: 1.8 });
}

// ===========================================================================
// 6. 模板缓存与注册口
// ===========================================================================
// 4 灵兽在本文件注册；14 只妖物由 32-beasts.js 调用 registerBuilders 注入。
const PARTNER_BUILDERS = {
  kui: buildKui, qilin: buildQilin, bifang: buildBifang, xuanwu: buildXuanwu,
};
const BEAST_BUILDERS = {};
const TEMPLATES = new Map();

function builderFor(id) {
  if (TRAINER_LOOKS[id]) return buildTrainer;
  if (PARTNER_BUILDERS[id]) return PARTNER_BUILDERS[id];
  if (BEAST_BUILDERS[id]) return BEAST_BUILDERS[id];
  return null;
}

// 查找顺序：行者 → 4 灵兽 → 32-beasts 注册的妖物
function getTemplate(id) {
  let tpl = TEMPLATES.get(id);
  if (tpl) return tpl;
  if (!T3) throw new Error('PG.models: THREE 未加载，无法构建 3D 模型');
  const fn = builderFor(id);
  if (!fn) throw new Error('PG.models: 未知模型 id "' + id + '"（妖物需由 32-beasts.js 注册）');
  tpl = fn(id);
  const isTrainer = !!TRAINER_LOOKS[id];
  tpl.group.name = (isTrainer ? 'trainer_' : 'model_') + id;
  tpl.group.userData.modelId = id;
  TEMPLATES.set(id, tpl);
  return tpl;
}

// 32-beasts.js 注入 14 只妖物的 builder（key = 异兽 id）
function registerBuilders(map) {
  if (!map) return BEAST_BUILDERS;
  Object.keys(map).forEach(function (k) {
    if (typeof map[k] !== 'function') return;
    BEAST_BUILDERS[k] = map[k];
    TEMPLATES.delete(k);
  });
  return BEAST_BUILDERS;
}

// 克隆模板并收集命名动画节点（几何与材质共享，克隆开销极小）
function instantiate(id) {
  const tpl = getTemplate(id);
  const group = tpl.group.clone(true);
  const nodes = { root: group };
  group.traverse(function (o) {
    if (o !== group && o.name) nodes[o.name] = o;
  });
  const state = { phase: Math.random() * TAU, seed: Math.random() };
  const refs = {
    group: group,
    height: tpl.height,
    radius: tpl.radius,
    nodes: nodes,
    update: function (dt, t) {
      try {
        tpl.anim(nodes, dt, (t || 0) + state.phase, state);
      } catch (e) {
        if (!refs._animErr) { refs._animErr = true; console.warn('PG.models 动画异常(' + id + ')：', e); }
      }
    },
  };
  return refs;
}

function makeBeast(id) {
  const refs = instantiate(id);
  return {
    group: refs.group,
    height: refs.height,
    radius: refs.radius,
    update: refs.update,
    id: id,
  };
}

function makeTrainerModel(id) {
  const refs = instantiate(id);
  const anchor = refs.nodes.handAnchor || null;
  return {
    group: refs.group,
    height: refs.height,
    update: refs.update,
    handAnchor: anchor,
    id: id,
  };
}

// ===========================================================================
// 7. 对外 API
// ===========================================================================
// 2D 委托：图标 / 头像由 35-art.js 挂在 PG.models.art 上；未加载时返回 null
function icon(id, size) {
  try {
    const A = PG.models && PG.models.art;
    return (A && typeof A.icon === 'function') ? A.icon(id, size) : null;
  } catch (e) { return null; }
}
function portrait(id, size) {
  try {
    const A = PG.models && PG.models.art;
    return (A && typeof A.portrait === 'function') ? A.portrait(id, size) : null;
  } catch (e) { return null; }
}

// 预热模板（可选，游戏启动时调用可避免首刷卡顿）；未注册的妖物直接跳过
function warmup(ids) {
  const list = ids || CREATURE_IDS.concat(TRAINER_IDS);
  for (let i = 0; i < list.length; i++) {
    try { getTemplate(list[i]); } catch (e) { /* 忽略单只失败（如 32-beasts 尚未加载） */ }
  }
  return true;
}

PG.models = {
  CREATURES: CREATURE_IDS.slice(),
  TRAINERS: TRAINER_IDS.slice(),
  TYPES: Object.keys(TYPE_COLORS),
  TYPE_COLORS: TYPE_COLORS,
  TYPE_DARK: TYPE_DARK,
  TYPE_CN: TYPE_CN,
  has: function (id) { return !!DATA[id] || !!TRAINER_DATA[id]; },
  info: infoOf,
  make: function (id) {
    if (!DATA[id]) throw new Error('PG.models.make: 未知异兽 id "' + id + '"');
    return makeBeast(id);
  },
  makeTrainer: function (id) {
    if (!TRAINER_DATA[id]) throw new Error('PG.models.makeTrainer: 未知行者 id "' + id + '"');
    return makeTrainerModel(id);
  },
  portrait: portrait,
  icon: icon,
  warmup: warmup,
  registerBuilders: registerBuilders,
  art: null,
  // 供 32-beasts.js 使用的拼装 DSL（成员清单见 docs/MYTHOLOGY.md 第 8.1 节）
  _dsl: {
    Builder: Builder, SPH: SPH, SPH_HI: SPH_HI, CONE: CONE, CYL: CYL, BOX: BOX,
    HEMI: HEMI, TORUS: TORUS, CAPSULE: CAPSULE, ICO: ICO,
    leafGeo: leafGeo, boltGeo: boltGeo, scytheGeo: scytheGeo, capChain: capChain,
    addEye: addEye, addEyes: addEyes, addSmile: addSmile, addOpenMouth: addOpenMouth,
    addFangs: addFangs, addTeethRow: addTeethRow, addCheeks: addCheeks,
    addClaws: addClaws, addFoot: addFoot, finishModel: finishModel,
    quatY: quatY, TAU: TAU, PI: PI,
  },
  // 调试用：查看模板高度 / draw call 估算
  stats: function (id) {
    const t = getTemplate(id);
    let meshes = 0;
    t.group.traverse(function (o) { if (o.isMesh) meshes++; });
    return { id: id, height: t.height, radius: t.radius, meshes: meshes };
  },
  silhouetteColor: function (id) {
    const d = DATA[id];
    if (d && TYPE_COLORS[d.type]) return TYPE_COLORS[d.type];
    const td = TRAINER_DATA[id];
    return (td && TYPE_COLORS[td.type]) || '#ffffff';
  },
};

})();
