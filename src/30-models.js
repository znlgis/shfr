/* ============================================================================
 * 30-models.js — PG.models
 * 宝可梦 / 训练家 程序化 3D 模型库 + 2D 头像与图标（负责：队友 creatures）
 * ----------------------------------------------------------------------------
 * 设计要点：
 *  1) 全部模型由 Three.js 基本几何体拼装（球 / 胶囊 / 锥 / 圆柱 / 环 / 挤出），
 *     无任何外部贴图，离线可用。
 *  2) 压低 draw call：每个"动画节点"（root / head / tail / wing ...）内部的
 *     同类材质零件，在建完模后合并为一个带顶点色的 BufferGeometry。
 *     单只宝可梦通常 3~6 个 draw call；全库共用材质。
 *  3) 模板只构建一次，make() 通过 group.clone(true) 复制（几何与材质共享 GPU
 *     资源），刷怪不会产生几何垃圾。
 *  4) 美术规范：脚底 y = 0，正面朝 -Z；update(dt, t) 处理呼吸 / 耳朵 / 尾巴 /
 *     翅膀 / 飘浮等细微动画。训练家站立，一只手前举，暴露 handAnchor 供挂武器。
 *  5) portrait / icon 为纯 Canvas2D 手绘（渐变 / 圆角 / 柔和描边），不依赖 THREE。
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

// 顺序与契约 3.4 一致：伙伴 -> 小怪 -> 中怪 -> 特殊 -> 精英 -> BOSS
const POKEMON_IDS = [
  'pikachu', 'bulbasaur', 'charmander', 'squirtle',
  'caterpie', 'weedle', 'pidgey', 'oddish',
  'beedrill', 'scyther', 'gastly', 'gengar',
  'snorlax', 'mewtwo', 'onix', 'meowth', 'jigglypuff', 'psyduck',
];
const TRAINER_IDS = ['t_bolt', 't_leaf', 't_ember', 't_tide'];

// cn: 官方中文名 | en: 英文名 | type: 属性 | kind: starter/enemy/elite/boss
// h: 目标总高度（米）| r: 碰撞半径参考值
const DATA = {
  pikachu:    { cn: '皮卡丘',   en: 'PIKACHU',    type: 'electric', kind: 'starter', h: 0.86, r: 0.30 },
  bulbasaur:  { cn: '妙蛙种子', en: 'BULBASAUR',  type: 'grass',    kind: 'starter', h: 1.00, r: 0.46 },
  charmander: { cn: '小火龙',   en: 'CHARMANDER', type: 'fire',     kind: 'starter', h: 1.05, r: 0.36 },
  squirtle:   { cn: '杰尼龟',   en: 'SQUIRTLE',   type: 'water',    kind: 'starter', h: 0.95, r: 0.36 },
  caterpie:   { cn: '绿毛虫',   en: 'CATERPIE',   type: 'bug',      kind: 'enemy',   h: 0.66, r: 0.32 },
  weedle:     { cn: '独角虫',   en: 'WEEDLE',     type: 'poison',   kind: 'enemy',   h: 0.66, r: 0.30 },
  pidgey:     { cn: '波波',     en: 'PIDGEY',     type: 'flying',   kind: 'enemy',   h: 0.62, r: 0.30 },
  oddish:     { cn: '走路草',   en: 'ODDISH',     type: 'grass',    kind: 'enemy',   h: 0.62, r: 0.30 },
  beedrill:   { cn: '大针蜂',   en: 'BEEDRILL',   type: 'bug',      kind: 'enemy',   h: 1.15, r: 0.45 },
  scyther:    { cn: '飞天螳螂', en: 'SCYTHER',    type: 'bug',      kind: 'enemy',   h: 1.35, r: 0.42 },
  gastly:     { cn: '鬼斯',     en: 'GASTLY',     type: 'ghost',    kind: 'enemy',   h: 0.85, r: 0.40 },
  gengar:     { cn: '耿鬼',     en: 'GENGAR',     type: 'ghost',    kind: 'enemy',   h: 1.45, r: 0.50 },
  snorlax:    { cn: '卡比兽',   en: 'SNORLAX',    type: 'normal',   kind: 'elite',   h: 2.20, r: 0.82 },
  mewtwo:     { cn: '超梦',     en: 'MEWTWO',     type: 'psychic',  kind: 'boss',    h: 1.90, r: 0.42 },
  onix:       { cn: '大岩蛇',   en: 'ONIX',       type: 'rock',     kind: 'elite',   h: 1.75, r: 0.55 },
  meowth:     { cn: '喵喵',     en: 'MEOWTH',     type: 'normal',   kind: 'enemy',   h: 0.92, r: 0.34 },
  jigglypuff: { cn: '胖丁',     en: 'JIGGLYPUFF', type: 'normal',   kind: 'enemy',   h: 0.60, r: 0.28 },
  psyduck:    { cn: '可达鸭',   en: 'PSYDUCK',    type: 'water',    kind: 'enemy',   h: 0.86, r: 0.34 },
};

const TRAINER_DATA = {
  t_bolt:  { cn: '雷恩', en: 'RAIDEN', type: 'electric' },
  t_leaf:  { cn: '芽衣', en: 'MAY',    type: 'grass' },
  t_ember: { cn: '炎武', en: 'BLAZE',  type: 'fire' },
  t_tide:  { cn: '波琳', en: 'MARINA', type: 'water' },
};

// 属性主色（2D 图标背景 / 头像圆环 / UI 呼应）
const TYPE_COLORS = {
  electric: '#ffd93d', grass: '#7ec850', fire: '#ff8a3d', water: '#6fc3ff',
  bug: '#a8c93a', flying: '#a9c0ea', poison: '#b57ad8', normal: '#d9c9a8',
  psychic: '#e58acb', ghost: '#8a6ac8', rock: '#b3a68f',
};
const TYPE_DARK = {
  electric: '#b58a00', grass: '#3f7a2c', fire: '#c2451a', water: '#1f6fb2',
  bug: '#5f7a12', flying: '#4a5f96', poison: '#6a3a8f', normal: '#8a7650',
  psychic: '#9c3f79', ghost: '#4c3580', rock: '#6b6152',
};

function infoOf(id) {
  const d = DATA[id];
  if (d) return { id: id, cn: d.cn, en: d.en, type: d.type, scale: 1, kind: d.kind };
  const t = TRAINER_DATA[id];
  if (t) return { id: id, cn: t.cn, en: t.en, type: t.type, scale: 1, kind: 'trainer' };
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

// 皮卡丘尾巴的闪电轮廓（XY 平面内，沿 +Y 生长，挤出厚度 depth）
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

// 飞天螳螂的镰刀（带钩的弯刀，XY 平面，+Y 为刀尖方向）
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

// 胶囊链（尾巴 / 大岩蛇 / 训练家四肢）：pts = [[x,y,z], ...]
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

// 一排牙齿（方糖状，用于耿鬼的大笑）
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

// 圆腮红（皮卡丘的红脸颊）
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
// opt: { scale: 统一缩放, y: 整体上/下平移 }（用于把偏小/悬空的模型校准到契约高度与脚底 y=0）
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
  const box = new T3.Box3().setFromObject(B.root);
  const minY = Math.min(0, box.min.y);
  const height = box.max.y - minY;
  const radius = Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
  return { group: B.root, height: height, radius: radius, anim: anim };
}

// ===========================================================================
// 4. 宝可梦模型（一）伙伴四只
// ===========================================================================

// —— 皮卡丘：黄胖子 + 长耳朵黑尖 + 红脸颊 + 闪电尾巴 ——
function buildPikachu() {
  const B = Builder();
  const YEL = 0xffd93d, BLK = 0x2f2b2a, BRN = 0x9a6a35, RED = 0xe8453c;

  // 身体 / 脚 / 手臂 / 背部条纹（不参与动画，合并成一个网格）
  B.put('root', SPH(), YEL, { y: 0.27, sx: 0.195, sy: 0.215, sz: 0.185 });
  B.put('root', SPH(), YEL, { x: 0.105, y: 0.048, z: -0.02, sx: 0.082, sy: 0.05, sz: 0.105 });
  B.put('root', SPH(), YEL, { x: -0.105, y: 0.048, z: -0.02, sx: 0.082, sy: 0.05, sz: 0.105 });
  B.put('root', SPH(), YEL, { x: 0.188, y: 0.27, z: -0.015, sx: 0.058, sy: 0.105, sz: 0.058, rz: -0.28 });
  B.put('root', SPH(), YEL, { x: -0.188, y: 0.27, z: -0.015, sx: 0.058, sy: 0.105, sz: 0.058, rz: 0.28 });
  B.put('root', SPH(), BRN, { y: 0.385, z: 0.148, sx: 0.078, sy: 0.02, sz: 0.045, rx: -0.42 });
  B.put('root', SPH(), BRN, { y: 0.315, z: 0.172, sx: 0.068, sy: 0.018, sz: 0.042, rx: -0.18 });

  // 头
  B.node('head', 'root', 0, 0.46, 0);
  B.put('head', SPH(), YEL, { y: 0.04, sx: 0.21, sy: 0.20, sz: 0.195 });
  addCheeks(B, 'head', { y: 0.0, z: -0.155, spread: 0.148, r: 0.055 });
  addEyes(B, 'head', { y: 0.068, z: -0.172, spread: 0.078, r: 0.034, style: 'oval', pupil: 0x232733 });
  B.put('head', SPH(), 0x3a2a28, { y: 0.033, z: -0.198, sx: 0.013, sy: 0.009, sz: 0.01 });
  addSmile(B, 'head', { y: 0.002, z: -0.186, w: 0.028, color: 0x5a3a32 });

  // 长耳朵（两个动画节点）
  const earL = B.node('earL', 'head', -0.082, 0.155, 0.012);
  const earR = B.node('earR', 'head', 0.082, 0.155, 0.012);
  earL.rotation.z = 0.30; earR.rotation.z = -0.30;
  [['earL', -1], ['earR', 1]].forEach(function (e) {
    const name = e[0], sgn = e[1];
    B.put(name, SPH(), YEL, { x: sgn * 0.012, y: 0.075, sx: 0.042, sy: 0.098, sz: 0.038 });
    B.put(name, CONE(), BLK, { x: sgn * 0.024, y: 0.207, sx: 0.044, sy: 0.085, sz: 0.04 });
  });

  // 闪电尾巴（动画节点）
  const tail = B.node('tail', 'root', 0.045, 0.17, 0.155);
  tail.rotation.z = -0.18; tail.rotation.y = 0.25;
  B.put('tail', SPH(), BRN, { y: 0.02, sx: 0.055, sy: 0.05, sz: 0.045 });
  B.put('tail', boltGeo(0.26, 0.032), YEL, { y: 0.05, sx: 1, sy: 1, sz: 1 });

  return finishModel(B, function (nodes, dt, t) {
    const s = Math.sin(t * 2.0);
    nodes.inner.scale.y = 1 + s * 0.013;
    nodes.head.rotation.x = Math.sin(t * 1.6) * 0.05;
    nodes.head.rotation.z = Math.sin(t * 0.83) * 0.035;
    const tw = Math.sin(t * 2.4);
    nodes.earL.rotation.z = 0.30 + tw * 0.09;
    nodes.earR.rotation.z = -0.30 - tw * 0.09;
    nodes.earL.rotation.x = Math.sin(t * 3.0) * 0.05;
    nodes.earR.rotation.x = Math.sin(t * 3.0 + 0.5) * 0.05;
    nodes.tail.rotation.z = -0.18 + Math.sin(t * 1.35) * 0.10;
    nodes.tail.rotation.y = 0.25 + Math.sin(t * 1.1) * 0.14;
  });
}

// —— 妙蛙种子：四足 + 背上的花苞 + 尖耳朵 + 深绿斑点 ——
function buildBulbasaur() {
  const B = Builder();
  const GRN = 0x7fc9a8, DGRN = 0x4c9a63, SPOT = 0x3f8f5a, BELLY = 0xcfe8c8;
  const BULB = 0x63b24d, BULB_D = 0x3f8a37, LEAF = 0x59a844;

  // 躯干 + 四肢
  B.put('root', SPH(), GRN, { y: 0.42, sx: 0.30, sy: 0.245, sz: 0.335 });
  // 腹部浅色
  B.put('root', SPH(), BELLY, { y: 0.34, z: -0.20, sx: 0.20, sy: 0.13, sz: 0.13 });
  // 四条短腿
  B.put('root', SPH(), GRN, { x: 0.205, y: 0.17, z: 0.20, sx: 0.092, sy: 0.15, sz: 0.105 });
  B.put('root', SPH(), GRN, { x: -0.205, y: 0.17, z: 0.20, sx: 0.092, sy: 0.15, sz: 0.105 });
  B.put('root', SPH(), GRN, { x: 0.205, y: 0.17, z: -0.19, sx: 0.092, sy: 0.15, sz: 0.105 });
  B.put('root', SPH(), GRN, { x: -0.205, y: 0.17, z: -0.19, sx: 0.092, sy: 0.15, sz: 0.105 });
  // 脚趾（白色小爪）
  addClaws(B, 'root', { x: 0.205, y: 0.035, z: -0.26, r: 0.02, len: 0.045, spread: 0.028 });
  addClaws(B, 'root', { x: -0.205, y: 0.035, z: -0.26, r: 0.02, len: 0.045, spread: 0.028 });
  // 背部斑点
  B.put('root', SPH(), SPOT, { x: 0.10, y: 0.60, z: 0.10, sx: 0.075, sy: 0.02, sz: 0.065 });
  B.put('root', SPH(), SPOT, { x: -0.13, y: 0.57, z: 0.02, sx: 0.06, sy: 0.018, sz: 0.055 });
  B.put('root', SPH(), SPOT, { x: 0.20, y: 0.50, z: 0.24, sx: 0.05, sy: 0.016, sz: 0.05 });

  // 头
  B.node('head', 'root', 0, 0.50, -0.30);
  B.put('head', SPH(), GRN, { y: 0.055, sx: 0.255, sy: 0.225, sz: 0.245 });
  B.put('head', SPH(), GRN, { y: 0.0, z: -0.17, sx: 0.16, sy: 0.10, sz: 0.13 });
  addSmile(B, 'head', { y: -0.055, z: -0.245, w: 0.085, tube: 0.014, color: 0x2f5a44 });
  B.put('head', SPH(), DGRN, { x: 0.042, y: 0.012, z: -0.285, sx: 0.013, sy: 0.009, sz: 0.01 });
  B.put('head', SPH(), DGRN, { x: -0.042, y: 0.012, z: -0.285, sx: 0.013, sy: 0.009, sz: 0.01 });
  addEyes(B, 'head', { y: 0.075, z: -0.185, spread: 0.135, r: 0.062, style: 'full', iris: 0xd05462, pupil: 0x2a2230, wz: 0.55 });
  // 头顶斑点
  B.put('head', SPH(), SPOT, { x: 0.09, y: 0.23, z: 0.02, sx: 0.06, sy: 0.016, sz: 0.05 });
  B.put('head', SPH(), SPOT, { x: -0.06, y: 0.245, z: 0.06, sx: 0.045, sy: 0.014, sz: 0.04 });
  // 尖耳朵
  B.put('head', CONE(), DGRN, { x: 0.185, y: 0.20, z: 0.03, sx: 0.075, sy: 0.11, sz: 0.05, rz: -0.55 });
  B.put('head', CONE(), DGRN, { x: -0.185, y: 0.20, z: 0.03, sx: 0.075, sy: 0.11, sz: 0.05, rz: 0.55 });

  // 花苞（动画节点：轻微呼吸/摇晃）
  B.node('bulb', 'root', 0, 0.62, 0.255);
  B.put('bulb', SPH(), BULB, { y: 0.14, sx: 0.265, sy: 0.25, sz: 0.26 });
  // 花苞上的深色纹路
  B.put('bulb', SPH(), BULB_D, { x: 0.12, y: 0.20, z: -0.10, sx: 0.075, sy: 0.025, sz: 0.065, rz: -0.4 });
  B.put('bulb', SPH(), BULB_D, { x: -0.10, y: 0.17, z: 0.12, sx: 0.065, sy: 0.022, sz: 0.06, rz: 0.5 });
  B.put('bulb', SPH(), BULB_D, { x: 0.02, y: 0.10, z: 0.19, sx: 0.07, sy: 0.022, sz: 0.05 });
  // 顶端叶片
  B.put('bulb', leafGeo(0.085, 0.19, 0.02), LEAF, { x: 0.008, y: 0.32, rx: -0.05, ry: 0.2, sz: 1 });
  B.put('bulb', leafGeo(0.075, 0.17, 0.02), LEAF, { x: 0.08, y: 0.31, rz: -0.55, rx: -0.35 });
  B.put('bulb', leafGeo(0.075, 0.17, 0.02), LEAF, { x: -0.08, y: 0.31, rz: 0.55, rx: -0.35 });
  B.put('bulb', leafGeo(0.065, 0.15, 0.02), LEAF, { x: 0.0, y: 0.31, rz: PI * 0.92, rx: 0.45 });

  return finishModel(B, function (nodes, dt, t) {
    const s = Math.sin(t * 1.7);
    nodes.inner.scale.y = 1 + s * 0.012;
    nodes.head.rotation.x = Math.sin(t * 1.2) * 0.045;
    nodes.head.rotation.z = Math.sin(t * 0.7) * 0.03;
    nodes.bulb.rotation.z = Math.sin(t * 1.35) * 0.06;
    nodes.bulb.rotation.x = Math.sin(t * 1.05 + 0.7) * 0.045;
    nodes.bulb.scale.setScalar(1 + Math.sin(t * 1.5) * 0.02);
  });
}

// —— 小火龙：橙色小恐龙 + 奶油色肚皮 + 尾巴上的火焰 ——
function buildCharmander() {
  const B = Builder();
  const ORG = 0xff8a3d, DORG = 0xe2642a, CREAM = 0xffe2b0, CLAW = 0xfff6e0;

  // 双腿 / 脚
  B.put('root', SPH(), ORG, { x: 0.098, y: 0.21, z: 0.0, sx: 0.075, sy: 0.16, sz: 0.085 });
  B.put('root', SPH(), ORG, { x: -0.098, y: 0.21, z: 0.0, sx: 0.075, sy: 0.16, sz: 0.085 });
  B.put('root', SPH(), ORG, { x: 0.10, y: 0.045, z: -0.045, sx: 0.085, sy: 0.045, sz: 0.115 });
  B.put('root', SPH(), ORG, { x: -0.10, y: 0.045, z: -0.045, sx: 0.085, sy: 0.045, sz: 0.115 });
  addClaws(B, 'root', { x: 0.10, y: 0.035, z: -0.15, r: 0.014, len: 0.038, spread: 0.022, color: CLAW });
  addClaws(B, 'root', { x: -0.10, y: 0.035, z: -0.15, r: 0.014, len: 0.038, spread: 0.022, color: CLAW });

  // 躯干 + 肚皮
  B.put('root', SPH(), ORG, { y: 0.45, sx: 0.175, sy: 0.225, sz: 0.16 });
  B.put('root', SPH(), CREAM, { y: 0.38, z: -0.115, sx: 0.115, sy: 0.15, sz: 0.065 });
  // 小手臂
  B.put('root', SPH(), ORG, { x: 0.175, y: 0.46, z: -0.02, sx: 0.052, sy: 0.10, sz: 0.052, rz: -0.55 });
  B.put('root', SPH(), ORG, { x: -0.175, y: 0.46, z: -0.02, sx: 0.052, sy: 0.10, sz: 0.052, rz: 0.55 });
  addClaws(B, 'root', { x: 0.19, y: 0.38, z: -0.07, r: 0.012, len: 0.03, spread: 0.018, rz: -0.55, color: CLAW });
  addClaws(B, 'root', { x: -0.19, y: 0.38, z: -0.07, r: 0.012, len: 0.03, spread: 0.018, rz: 0.55, color: CLAW });

  // 头
  B.node('head', 'root', 0, 0.76, -0.02);
  B.put('head', SPH(), ORG, { y: 0.03, sx: 0.185, sy: 0.175, sz: 0.17 });
  // 口鼻
  B.put('head', SPH(), ORG, { y: -0.03, z: -0.145, sx: 0.125, sy: 0.085, sz: 0.10 });
  B.put('head', SPH(), CREAM, { y: -0.075, z: -0.155, sx: 0.085, sy: 0.045, sz: 0.06 });
  addSmile(B, 'head', { y: -0.055, z: -0.21, w: 0.05, tube: 0.009, color: 0x8a3a24 });
  B.put('head', SPH(), 0x8a3a24, { x: 0.028, y: -0.02, z: -0.238, sx: 0.008, sy: 0.006, sz: 0.006 });
  B.put('head', SPH(), 0x8a3a24, { x: -0.028, y: -0.02, z: -0.238, sx: 0.008, sy: 0.006, sz: 0.006 });
  addEyes(B, 'head', { y: 0.045, z: -0.15, spread: 0.105, r: 0.052, style: 'full', iris: 0x2f9ebd, pupil: 0x202834, wz: 0.55 });
  // 头顶小角（雏龙的可爱感）
  B.put('head', CONE(), ORG, { y: 0.185, z: -0.03, sx: 0.035, sy: 0.055, sz: 0.03, rx: -0.25 });

  // 尾巴（动画节点）+ 火焰
  const tail = B.node('tail', 'root', 0, 0.30, 0.14);
  capChain(B, 'tail', [[0, 0, 0], [0.015, 0.09, 0.10], [0.02, 0.20, 0.17], [0.01, 0.32, 0.21]], [0.07, 0.055, 0.042, 0.028], ORG);
  // 火焰：外焰（橙）+ 内焰（黄）两个叠加锥
  const flame = B.node('flame', 'tail', 0.01, 0.35, 0.225);
  B.put('flame', CONE(), 0xff6a1a, { y: 0.075, sx: 0.075, sy: 0.17, sz: 0.075, glow: 0xff5a00, glowInt: 1.7 });
  B.put('flame', CONE(), 0xffb43d, { y: 0.095, z: -0.02, sx: 0.042, sy: 0.11, sz: 0.042, glow: 0xffa000, glowInt: 2.1 });
  B.put('flame', CONE(), 0xfff2a0, { y: 0.24, sx: 0.02, sy: 0.05, sz: 0.02, glow: 0xfff0a0, glowInt: 2.2 });

  return finishModel(B, function (nodes, dt, t) {
    const s = Math.sin(t * 1.9);
    nodes.inner.scale.y = 1 + s * 0.012;
    nodes.head.rotation.x = Math.sin(t * 1.4) * 0.05;
    nodes.head.rotation.z = Math.sin(t * 0.9) * 0.03;
    nodes.tail.rotation.z = Math.sin(t * 1.5) * 0.10;
    nodes.tail.rotation.x = Math.sin(t * 1.1 + 0.5) * 0.06;
    const fl = 1 + Math.sin(t * 8.5) * 0.13 + Math.sin(t * 13.7) * 0.07;
    nodes.flame.scale.set(1 + Math.sin(t * 7.3) * 0.07, fl, 1 + Math.cos(t * 9.1) * 0.07);
    nodes.flame.rotation.y = t * 1.7;
  }, { scale: 1.04 });
}

// —— 杰尼龟：浅蓝小龟 + 背后棕色龟壳 + 奶油色壳边 + 大眼 ——
function buildSquirtle() {
  const B = Builder();
  const BLU = 0x7fc7f5, DBLU = 0x5aa8dd, CREAM = 0xffe9b8, SHELL = 0xa96a3c, SHELL_D = 0x82502c, CLAW = 0xfff6e0;

  // 腿 / 脚
  B.put('root', SPH(), BLU, { x: 0.105, y: 0.115, z: -0.02, sx: 0.075, sy: 0.10, sz: 0.09 });
  B.put('root', SPH(), BLU, { x: -0.105, y: 0.115, z: -0.02, sx: 0.075, sy: 0.10, sz: 0.09 });
  B.put('root', SPH(), CREAM, { x: 0.105, y: 0.035, z: -0.075, sx: 0.08, sy: 0.04, sz: 0.095 });
  B.put('root', SPH(), CREAM, { x: -0.105, y: 0.035, z: -0.075, sx: 0.08, sy: 0.04, sz: 0.095 });
  addClaws(B, 'root', { x: 0.105, y: 0.03, z: -0.155, r: 0.013, len: 0.032, spread: 0.022, color: CLAW });
  addClaws(B, 'root', { x: -0.105, y: 0.03, z: -0.155, r: 0.013, len: 0.032, spread: 0.022, color: CLAW });

  // 躯干 + 浅色肚皮
  B.put('root', SPH(), BLU, { y: 0.34, sx: 0.19, sy: 0.215, sz: 0.17 });
  B.put('root', SPH(), CREAM, { y: 0.30, z: -0.10, sx: 0.115, sy: 0.13, sz: 0.075 });
  // 手臂 + 手
  B.put('root', SPH(), BLU, { x: 0.18, y: 0.38, z: -0.02, sx: 0.055, sy: 0.10, sz: 0.055, rz: -0.6 });
  B.put('root', SPH(), BLU, { x: -0.18, y: 0.38, z: -0.02, sx: 0.055, sy: 0.10, sz: 0.055, rz: 0.6 });
  addClaws(B, 'root', { x: 0.20, y: 0.30, z: -0.06, r: 0.012, len: 0.028, spread: 0.018, rz: -0.5, color: CLAW });
  addClaws(B, 'root', { x: -0.20, y: 0.30, z: -0.06, r: 0.012, len: 0.028, spread: 0.018, rz: 0.5, color: CLAW });

  // 龟壳（半球 + 奶油色壳边 + 深棕纹路）
  B.put('root', HEMI(), SHELL, { y: 0.40, z: 0.055, sx: 0.215, sy: 0.205, sz: 0.20, rx: PI / 2 });
  B.put('root', TORUS(0.20, 0.026, TAU), CREAM, { y: 0.40, z: 0.062 });
  B.put('root', SPH(), SHELL_D, { x: 0.085, y: 0.55, z: 0.13, sx: 0.065, sy: 0.05, sz: 0.07 });
  B.put('root', SPH(), SHELL_D, { x: -0.095, y: 0.50, z: 0.14, sx: 0.06, sy: 0.045, sz: 0.065 });
  B.put('root', SPH(), SHELL_D, { y: 0.61, z: 0.04, sx: 0.06, sy: 0.045, sz: 0.07 });

  // 头
  B.node('head', 'root', 0, 0.63, -0.01);
  B.put('head', SPH(), BLU, { y: 0.035, sx: 0.16, sy: 0.155, sz: 0.15 });
  B.put('head', SPH(), BLU, { y: -0.02, z: -0.125, sx: 0.105, sy: 0.075, sz: 0.085 });
  addSmile(B, 'head', { y: -0.05, z: -0.178, w: 0.045, tube: 0.009, color: 0x2f5a70 });
  B.put('head', SPH(), DBLU, { x: 0.025, y: -0.005, z: -0.205, sx: 0.008, sy: 0.006, sz: 0.006 });
  B.put('head', SPH(), DBLU, { x: -0.025, y: -0.005, z: -0.205, sx: 0.008, sy: 0.006, sz: 0.006 });
  addEyes(B, 'head', { y: 0.045, z: -0.128, spread: 0.092, r: 0.055, style: 'full', iris: 0x9a5a42, pupil: 0x241d20, wz: 0.55 });

  // 小尾巴（动画节点）
  B.node('tail', 'root', 0, 0.20, 0.145);
  capChain(B, 'tail', [[0, 0, 0], [0, 0.045, 0.06], [0, 0.10, 0.085]], [0.045, 0.033, 0.02], BLU);
  B.put('tail', CONE(), CREAM, { y: 0.115, z: 0.09, sx: 0.03, sy: 0.055, sz: 0.025, rx: -0.9 });

  return finishModel(B, function (nodes, dt, t) {
    const s = Math.sin(t * 1.8);
    nodes.inner.scale.y = 1 + s * 0.012;
    nodes.head.rotation.x = Math.sin(t * 1.3) * 0.05;
    nodes.head.rotation.z = Math.sin(t * 0.8) * 0.035;
    nodes.tail.rotation.z = Math.sin(t * 2.0) * 0.18;
    nodes.tail.rotation.x = Math.sin(t * 1.4) * 0.10;
  }, { scale: 1.15 });
}


// ===========================================================================
// 5. 宝可梦模型（二）小怪：绿毛虫 / 独角虫 / 波波 / 走路草
// ===========================================================================

// —— 绿毛虫：一节一节的绿色毛毛虫 + 额头红触角 + 黄色环节斑 ——
function buildCaterpie() {
  const B = Builder();
  const GRN = 0xa8d84a, GRN_D = 0x7fb52f, YEL = 0xffe14d, RED = 0xe8453c, DARK = 0x2b3038;

  // 身体节点顺序：head（前） -> s1 -> s2 -> s3 -> s4（尾），做波浪式蠕动
  const segDefs = [
    ['seg1', 0.225, -0.105, 0.155, 0.145],
    ['seg2', 0.205, 0.035, 0.140, 0.135],
    ['seg3', 0.185, 0.160, 0.125, 0.120],
    ['seg4', 0.170, 0.270, 0.100, 0.100],
  ];
  for (let i = 0; i < segDefs.length; i++) {
    const d = segDefs[i];
    B.node(d[0], 'root', 0, d[1], d[2]);
    const r = d[3], len = d[4];
    B.put(d[0], SPH(), i % 2 === 0 ? GRN : 0xb2df55, { sx: r, sy: r * 0.92, sz: len });
    // 侧面黄色环节斑
    B.put(d[0], SPH(), YEL, { x: r * 0.82, y: 0.012, sx: r * 0.30, sy: r * 0.34, sz: r * 0.30 });
    B.put(d[0], SPH(), YEL, { x: -r * 0.82, y: 0.012, sx: r * 0.30, sy: r * 0.34, sz: r * 0.30 });
    // 小短腿
    B.put(d[0], SPH(), GRN_D, { x: r * 0.55, y: -r * 0.78, z: 0, sx: r * 0.22, sy: r * 0.30, sz: r * 0.22 });
    B.put(d[0], SPH(), GRN_D, { x: -r * 0.55, y: -r * 0.78, z: 0, sx: r * 0.22, sy: r * 0.30, sz: r * 0.22 });
  }
  // 尾巴小圆球
  B.put('seg4', SPH(), GRN, { y: 0.03, z: 0.10, sx: 0.075, sy: 0.07, sz: 0.075 });

  // 头（动画节点）
  B.node('head', 'root', 0, 0.245, -0.255);
  B.put('head', SPH(), GRN, { sx: 0.175, sy: 0.165, sz: 0.165 });
  // 大眼：白眼球 + 黑瞳 + 高光
  addEyes(B, 'head', { y: 0.03, z: -0.135, spread: 0.105, r: 0.065, style: 'full', white: 0xfffdf0, iris: DARK, pupil: DARK, wz: 0.55 });
  // 眼下小腮点
  B.put('head', SPH(), 0xffb2c0, { x: 0.128, y: -0.045, z: -0.095, sx: 0.026, sy: 0.018, sz: 0.015 });
  B.put('head', SPH(), 0xffb2c0, { x: -0.128, y: -0.045, z: -0.095, sx: 0.026, sy: 0.018, sz: 0.015 });
  addSmile(B, 'head', { y: -0.055, z: -0.145, w: 0.035, tube: 0.008, color: 0x3a5a24 });
  // 额头红色触角
  B.put('head', CONE(), RED, { y: 0.185, z: -0.02, sx: 0.032, sy: 0.115, sz: 0.03, rx: -0.35 });
  B.put('head', SPH(), RED, { y: 0.25, z: -0.045, sx: 0.026, sy: 0.026, sz: 0.026 });

  return finishModel(B, function (nodes, dt, t) {
    const names = ['seg1', 'seg2', 'seg3', 'seg4'];
    for (let i = 0; i < names.length; i++) {
      const n = nodes[names[i]];
      n.position.y = segDefs[i][1] + Math.sin(t * 3.2 - i * 0.8) * 0.016;
      n.rotation.x = Math.sin(t * 3.2 - i * 0.8) * 0.07;
    }
    nodes.head.position.y = 0.245 + Math.sin(t * 3.2 + 0.6) * 0.014;
    nodes.head.rotation.x = Math.sin(t * 2.1) * 0.06;
    nodes.head.rotation.z = Math.sin(t * 0.9) * 0.05;
  }, { scale: 1.30 });
}

// —— 独角虫：土黄节段身体 + 红色尖角 + 尾针 ——
function buildWeedle() {
  const B = Builder();
  const TAN = 0xe8d38a, TAN_D = 0xd2b96b, RED = 0xe8654f, CREAM = 0xfff3cf, DARK = 0x2a2a30;

  const segDefs = [
    ['seg1', 0.225, -0.10, 0.150, 0.135],
    ['seg2', 0.210, 0.03, 0.140, 0.130],
    ['seg3', 0.195, 0.15, 0.125, 0.120],
    ['seg4', 0.180, 0.255, 0.105, 0.105],
  ];
  for (let i = 0; i < segDefs.length; i++) {
    const d = segDefs[i];
    B.node(d[0], 'root', 0, d[1], d[2]);
    const r = d[3], len = d[4];
    B.put(d[0], SPH(), i % 2 === 0 ? TAN : 0xefdfa0, { sx: r, sy: r * 0.93, sz: len });
    // 环节高光带
    B.put(d[0], SPH(), TAN_D, { y: r * 0.55, sx: r * 0.82, sy: r * 0.16, sz: len * 0.92 });
    B.put(d[0], SPH(), TAN_D, { x: r * 0.55, y: -r * 0.7, sx: r * 0.2, sy: r * 0.28, sz: r * 0.2 });
    B.put(d[0], SPH(), TAN_D, { x: -r * 0.55, y: -r * 0.7, sx: r * 0.2, sy: r * 0.28, sz: r * 0.2 });
  }
  // 尾针（朝后上方）
  B.put('seg4', CONE(), CREAM, { y: 0.02, z: 0.19, sx: 0.035, sy: 0.14, sz: 0.035, rx: 1.9, shine: true });

  // 头
  B.node('head', 'root', 0, 0.245, -0.255);
  B.put('head', SPH(), TAN, { sx: 0.165, sy: 0.155, sz: 0.16 });
  // 头顶/脸颊环纹（独角虫标志性环状节）
  B.put('head', SPH(), TAN_D, { y: 0.10, z: -0.02, sx: 0.145, sy: 0.035, sz: 0.14 });
  B.put('head', SPH(), TAN_D, { y: -0.055, z: -0.03, sx: 0.15, sy: 0.03, sz: 0.14 });
  // 向前突出的口鼻
  B.put('head', CONE(), TAN, { y: -0.015, z: -0.155, sx: 0.085, sy: 0.14, sz: 0.075, rx: -PI / 2 });
  addEyes(B, 'head', { y: 0.035, z: -0.115, spread: 0.085, r: 0.062, style: 'full', white: 0xfffdf0, iris: DARK, pupil: DARK, wz: 0.55 });
  // 头顶大红角（略向前弯）
  B.put('head', CONE(), RED, { y: 0.20, z: -0.015, sx: 0.05, sy: 0.19, sz: 0.045, rx: -0.22 });
  B.put('head', SPH(), RED, { y: 0.30, z: -0.05, sx: 0.045, sy: 0.045, sz: 0.042 });
  // 嘴
  B.put('head', SPH(), 0x8a5a3a, { y: -0.085, z: -0.155, sx: 0.038, sy: 0.012, sz: 0.012 });
  // 小脸颊
  B.put('head', SPH(), 0xffc0b0, { x: 0.12, y: -0.035, z: -0.10, sx: 0.024, sy: 0.016, sz: 0.015 });
  B.put('head', SPH(), 0xffc0b0, { x: -0.12, y: -0.035, z: -0.10, sx: 0.024, sy: 0.016, sz: 0.015 });

  return finishModel(B, function (nodes, dt, t) {
    const names = ['seg1', 'seg2', 'seg3', 'seg4'];
    for (let i = 0; i < names.length; i++) {
      const n = nodes[names[i]];
      n.position.y = segDefs[i][1] + Math.sin(t * 3.6 - i * 0.9) * 0.014;
      n.rotation.x = Math.sin(t * 3.6 - i * 0.9) * 0.065;
    }
    nodes.head.position.y = 0.245 + Math.sin(t * 3.6 + 0.7) * 0.013;
    nodes.head.rotation.x = Math.sin(t * 2.3) * 0.055;
    nodes.head.rotation.z = Math.sin(t * 1.1) * 0.05;
  }, { scale: 1.18 });
}

// —— 波波：圆滚滚的小鸟 + 头顶三根冠羽 + 粉色喙 ——
function buildPidgey() {
  const B = Builder();
  const BRN = 0xc99a5b, BRN_D = 0xa87a3f, CREAM = 0xffe9b0, PINK = 0xf2a89e, DARK = 0x3a2a22;

  // 身体（大圆球）
  B.put('root', SPH(), BRN, { y: 0.28, sx: 0.19, sy: 0.20, sz: 0.175 });
  // 奶油色肚皮
  B.put('root', SPH(), CREAM, { y: 0.245, z: -0.115, sx: 0.115, sy: 0.135, sz: 0.075 });
  // 尾羽（三片扁羽）
  B.put('root', leafGeo(0.055, 0.17, 0.015), BRN_D, { z: 0.15, y: 0.20, rx: PI / 2 + 0.25, rz: 0 });
  B.put('root', leafGeo(0.05, 0.15, 0.015), BRN_D, { x: 0.05, z: 0.15, y: 0.21, rx: PI / 2 + 0.22, rz: -0.35 });
  B.put('root', leafGeo(0.05, 0.15, 0.015), BRN_D, { x: -0.05, z: 0.15, y: 0.21, rx: PI / 2 + 0.22, rz: 0.35 });
  // 脚（粉色三趾）
  B.put('root', SPH(), PINK, { x: 0.075, y: 0.028, z: -0.02, sx: 0.045, sy: 0.026, sz: 0.055 });
  B.put('root', SPH(), PINK, { x: -0.075, y: 0.028, z: -0.02, sx: 0.045, sy: 0.026, sz: 0.055 });
  addClaws(B, 'root', { x: 0.075, y: 0.018, z: -0.06, r: 0.009, len: 0.028, spread: 0.016, color: PINK, rx: -PI / 2 });
  addClaws(B, 'root', { x: -0.075, y: 0.018, z: -0.06, r: 0.009, len: 0.028, spread: 0.016, color: PINK, rx: -PI / 2 });

  // 头
  B.node('head', 'root', 0, 0.43, -0.015);
  B.put('head', SPH(), BRN, { sx: 0.155, sy: 0.145, sz: 0.145 });
  // 冠羽（三片，向后上方）
  B.put('head', leafGeo(0.035, 0.13, 0.014), CREAM, { y: 0.10, z: 0.02, rx: -0.55, rz: 0 });
  B.put('head', leafGeo(0.03, 0.105, 0.012), CREAM, { x: 0.045, y: 0.095, z: 0.02, rx: -0.5, rz: -0.3 });
  B.put('head', leafGeo(0.03, 0.105, 0.012), CREAM, { x: -0.045, y: 0.095, z: 0.02, rx: -0.5, rz: 0.3 });
  // 黑眼罩条纹
  B.put('head', SPH(), BRN_D, { x: 0.075, y: 0.035, z: -0.10, sx: 0.062, sy: 0.035, sz: 0.035, rz: -0.25 });
  B.put('head', SPH(), BRN_D, { x: -0.075, y: 0.035, z: -0.10, sx: 0.062, sy: 0.035, sz: 0.035, rz: 0.25 });
  addEyes(B, 'head', { y: 0.035, z: -0.13, spread: 0.072, r: 0.040, style: 'oval', pupil: DARK });
  // 粉色喙
  B.put('head', CONE(), PINK, { y: -0.03, z: -0.155, sx: 0.038, sy: 0.085, sz: 0.034, rx: -PI / 2 });
  B.put('head', SPH(), PINK, { y: -0.055, z: -0.10, sx: 0.03, sy: 0.022, sz: 0.03 });

  // 翅膀（两个动画节点）
  const wings = [
    ['wingL', -1, -0.19, 0.30, 0.0, 0.18],
    ['wingR', 1, 0.19, 0.30, 0.0, -0.18],
  ];
  wings.forEach(function (w) {
    const n = B.node(w[0], 'root', w[2], w[3], w[4]);
    n.rotation.z = w[5];
    B.put(w[0], SPH(), BRN_D, { x: -w[1] * 0.02, y: 0.02, sx: 0.075, sy: 0.14, sz: 0.055, rz: -w[1] * 0.25 });
    // 三根翼尖羽毛
    for (let i = 0; i < 3; i++) {
      B.put(w[0], leafGeo(0.026, 0.09 - i * 0.012, 0.01), BRN_D, {
        x: -w[1] * (0.01 + i * 0.018), y: -0.055 - i * 0.018, z: 0.0,
        rx: -0.2, rz: -w[1] * (0.1 + i * 0.14),
      });
    }
  });

  return finishModel(B, function (nodes, dt, t) {
    nodes.inner.scale.y = 1 + Math.sin(t * 2.1) * 0.012;
    nodes.head.rotation.x = Math.sin(t * 1.5) * 0.06;
    nodes.head.rotation.z = Math.sin(t * 0.9) * 0.04;
    const flap = Math.sin(t * 7.5) * 0.16;
    nodes.wingL.rotation.z = 0.28 + flap;
    nodes.wingR.rotation.z = -0.28 - flap;
    nodes.wingL.rotation.x = Math.sin(t * 7.5 + 0.4) * 0.08;
    nodes.wingR.rotation.x = Math.sin(t * 7.5 + 0.4) * 0.08;
  });
}

// —— 走路草：蓝紫圆脸 + 头顶五片草叶 ——
function buildOddish() {
  const B = Builder();
  const BLU = 0x5c6bb0, BLU_D = 0x46538f, LEAF = 0x53a83c, LEAF_D = 0x3d8a2b, EYE = 0xd84a4a;

  // 脚（圆钝的蓝色小腿）
  B.put('root', SPH(), BLU_D, { x: 0.085, y: 0.05, z: -0.015, sx: 0.06, sy: 0.05, sz: 0.075 });
  B.put('root', SPH(), BLU_D, { x: -0.085, y: 0.05, z: -0.015, sx: 0.06, sy: 0.05, sz: 0.075 });
  // 身体（圆球）
  B.put('root', SPH(), BLU, { y: 0.225, sx: 0.185, sy: 0.185, sz: 0.18 });
  B.put('root', SPH(), 0x6d7cbe, { y: 0.17, z: -0.09, sx: 0.115, sy: 0.10, sz: 0.075 });
  // 脸
  addEyes(B, 'root', { y: 0.235, z: -0.155, spread: 0.075, r: 0.055, style: 'full', iris: EYE, pupil: 0x2a1a1a, wz: 0.55 });
  addSmile(B, 'root', { y: 0.155, z: -0.175, w: 0.032, tube: 0.008, color: 0x2a2a48 });
  B.put('root', SPH(), 0x2a2a48, { x: 0.0, y: 0.14, z: -0.186, sx: 0.008, sy: 0.008, sz: 0.006 });
  // 眼睛上方的小眼睑（让它看起来更呆萌）
  B.put('root', SPH(), BLU_D, { x: 0.075, y: 0.29, z: -0.13, sx: 0.055, sy: 0.014, sz: 0.03, rz: -0.12 });
  B.put('root', SPH(), BLU_D, { x: -0.075, y: 0.29, z: -0.13, sx: 0.055, sy: 0.014, sz: 0.03, rz: 0.12 });

  // 头顶五片草叶（动画节点）
  B.node('leaves', 'root', 0, 0.37, 0.0);
  const leafDefs = [
    [0.0, 0.0, -0.28, 0.06, 0.30, 0.0],
    [0.075, 0.0, -0.10, 0.055, 0.27, -0.5],
    [-0.075, 0.0, -0.10, 0.055, 0.27, 0.5],
    [0.085, 0.0, 0.20, 0.05, 0.24, -0.95],
    [-0.085, 0.0, 0.20, 0.05, 0.24, 0.95],
  ];
  for (let i = 0; i < leafDefs.length; i++) {
    const d = leafDefs[i];
    B.put('leaves', leafGeo(d[3], d[4], 0.018), i % 2 === 0 ? LEAF : LEAF_D, {
      x: d[0], y: 0.0, z: d[1], rz: d[5], rx: d[2],
    });
  }

  return finishModel(B, function (nodes, dt, t) {
    nodes.inner.scale.y = 1 + Math.sin(t * 1.9) * 0.014;
    nodes.leaves.rotation.z = Math.sin(t * 1.5) * 0.07;
    nodes.leaves.rotation.x = Math.sin(t * 1.1 + 0.6) * 0.055;
    nodes.leaves.rotation.y = Math.sin(t * 0.8) * 0.09;
  });
}

// ===========================================================================
// 6. 宝可梦模型（三）中怪：大针蜂 / 飞天螳螂
// ===========================================================================

// —— 大针蜂：黄黑条纹 + 巨型红复眼 + 双手白针 + 薄翅 ——
function buildBeedrill() {
  const B = Builder();
  const YEL = 0xffd23d, BLK = 0x2c2a2e, RED = 0xe8453c, CREAM = 0xfff6e0, WING = 0xd8ecff;

  // 悬停时的腿（细黑腿，脚尖接近地面）
  const legXs = [-0.10, 0.10];
  legXs.forEach(function (lx) {
    B.put('root', CAPSULE(0.014, 0.30), BLK, { x: lx, y: 0.33, z: 0.02, rz: lx > 0 ? -0.22 : 0.22 });
    B.put('root', CAPSULE(0.012, 0.22), BLK, { x: lx * 1.7, y: 0.14, z: -0.02, rz: lx > 0 ? -0.5 : 0.5 });
  });

  // 腹部（下垂向后，带黑环与白尾针）
  B.node('abdomen', 'root', 0, 0.34, 0.14);
  B.put('abdomen', SPH(), YEL, { y: 0.0, z: 0.06, sx: 0.135, sy: 0.145, sz: 0.16 });
  B.put('abdomen', SPH(), BLK, { y: -0.02, z: 0.145, sx: 0.128, sy: 0.135, sz: 0.045 });
  B.put('abdomen', SPH(), BLK, { y: -0.05, z: 0.235, sx: 0.10, sy: 0.105, sz: 0.04 });
  B.put('abdomen', CONE(), CREAM, { y: -0.04, z: 0.31, sx: 0.045, sy: 0.19, sz: 0.045, rx: 1.35, shine: true });

  // 胸部（黄底黑纹）
  B.put('root', SPH(), YEL, { y: 0.60, sx: 0.165, sy: 0.195, sz: 0.155 });
  B.put('root', SPH(), BLK, { y: 0.60, z: 0.02, sx: 0.168, sy: 0.045, sz: 0.16, rx: 0.12 });
  B.put('root', SPH(), BLK, { y: 0.72, z: 0.01, sx: 0.155, sy: 0.035, sz: 0.15 });

  // 头（大复眼 + 触角 + 口器）
  B.node('head', 'root', 0, 0.87, -0.02);
  B.put('head', SPH(), YEL, { sy: 0.13, sx: 0.155, sz: 0.145 });
  B.put('head', SPH(), RED, { x: 0.105, y: 0.015, z: -0.075, sx: 0.075, sy: 0.095, sz: 0.075, shine: true });
  B.put('head', SPH(), RED, { x: -0.105, y: 0.015, z: -0.075, sx: 0.075, sy: 0.095, sz: 0.075, shine: true });
  B.put('head', SPH(), 0xff9a8a, { x: 0.085, y: 0.05, z: -0.13, sx: 0.022, sy: 0.022, sz: 0.012, shine: true });
  B.put('head', SPH(), 0xff9a8a, { x: -0.085, y: 0.05, z: -0.13, sx: 0.022, sy: 0.022, sz: 0.012, shine: true });
  // 触角
  B.put('head', CAPSULE(0.012, 0.13), BLK, { x: 0.05, y: 0.145, z: -0.02, rz: -0.35, rx: -0.2 });
  B.put('head', CAPSULE(0.012, 0.13), BLK, { x: -0.05, y: 0.145, z: -0.02, rz: 0.35, rx: -0.2 });
  B.put('head', SPH(), BLK, { x: 0.085, y: 0.215, z: -0.04, sx: 0.022, sy: 0.022, sz: 0.022 });
  B.put('head', SPH(), BLK, { x: -0.085, y: 0.215, z: -0.04, sx: 0.022, sy: 0.022, sz: 0.022 });
  // 口器（两根短灰刺）
  B.put('head', CONE(), CREAM, { x: 0.028, y: -0.115, z: -0.09, sx: 0.018, sy: 0.07, sz: 0.016, rx: 2.6, shine: true });
  B.put('head', CONE(), CREAM, { x: -0.028, y: -0.115, z: -0.09, sx: 0.018, sy: 0.07, sz: 0.016, rx: 2.6, shine: true });

  // 双臂（动画节点 + 白色大针）
  const arms = [['armL', -1], ['armR', 1]];
  arms.forEach(function (a) {
    const name = a[0], s = a[1];
    const n = B.node(name, 'root', s * 0.155, 0.66, 0.0);
    n.rotation.z = s * 0.35;
    B.put(name, CAPSULE(0.028, 0.13), BLK, { x: s * 0.03, y: -0.075, z: -0.01, rz: s * 0.18 });
    B.put(name, CAPSULE(0.024, 0.11), YEL, { x: s * 0.055, y: -0.185, z: -0.06, rx: -0.5, rz: s * 0.1 });
    // 白针（招牌武器）
    B.put(name, CONE(), CREAM, { x: s * 0.06, y: -0.20, z: -0.22, sx: 0.05, sy: 0.26, sz: 0.05, rx: -1.35, shine: true });
    B.put(name, SPH(), YEL, { x: s * 0.06, y: -0.165, z: -0.075, sx: 0.042, sy: 0.042, sz: 0.042 });
  });

  // 翅膀（动画节点：高频扇动）
  B.node('wings', 'root', 0, 0.72, 0.08);
  B.put('wings', leafGeo(0.085, 0.30, 0.006), WING, { x: 0.095, y: 0.045, rz: 0.95, rx: -0.5, glass: 0.5 });
  B.put('wings', leafGeo(0.075, 0.25, 0.006), WING, { x: -0.095, y: 0.045, rz: -0.95, rx: -0.5, glass: 0.5 });
  B.put('wings', leafGeo(0.055, 0.18, 0.006), WING, { x: 0.06, y: -0.02, rz: 0.65, rx: -0.4, glass: 0.42 });
  B.put('wings', leafGeo(0.055, 0.18, 0.006), WING, { x: -0.06, y: -0.02, rz: -0.65, rx: -0.4, glass: 0.42 });

  return finishModel(B, function (nodes, dt, t) {
    // 蜂类悬停：整体轻微上下浮，翅膀高频抖动
    nodes.inner.position.y = (Math.sin(t * 5.2) * 0.5 + 0.5) * 0.035;
    nodes.head.rotation.x = Math.sin(t * 2.2) * 0.05;
    nodes.abdomen.rotation.x = Math.sin(t * 2.6) * 0.07;
    nodes.armL.rotation.x = Math.sin(t * 2.0) * 0.10;
    nodes.armR.rotation.x = Math.sin(t * 2.0 + 1.4) * 0.10;
    nodes.wings.rotation.z = Math.sin(t * 42) * 0.16;
    nodes.wings.rotation.x = Math.sin(t * 37 + 0.8) * 0.10;
    nodes.wings.scale.y = 1 + Math.sin(t * 42) * 0.08;
  });
}

// —— 飞天螳螂：细长绿色身体 + 巨型奶油色镰刀臂 + 半透明翅 ——
function buildScyther() {
  const B = Builder();
  const GRN = 0x8ed04a, GRN_D = 0x63a632, CREAM = 0xfff2c4, DARK = 0x2f3a28, BLADE = 0xfff7dc, WING = 0xdcf0ff;

  // 双腿（反关节，脚尖轻点地面）
  [-1, 1].forEach(function (s) {
    B.put('root', CAPSULE(0.032, 0.30), GRN, { x: s * 0.115, y: 0.55, z: 0.02, rz: s * 0.12, rx: 0.10 });
    B.put('root', CAPSULE(0.026, 0.30), GRN_D, { x: s * 0.145, y: 0.28, z: -0.035, rz: s * 0.16, rx: -0.18 });
    B.put('root', SPH(), GRN_D, { x: s * 0.16, y: 0.045, z: -0.10, sx: 0.045, sy: 0.030, sz: 0.085 });
    addClaws(B, 'root', { x: s * 0.16, y: 0.035, z: -0.185, r: 0.012, len: 0.03, spread: 0.018, color: CREAM });
  });

  // 腹部（后翘的虫腹 + 奶油色环带）
  B.node('abdomen', 'root', 0, 0.55, 0.15);
  capChain(B, 'abdomen', [[0, 0.0, 0.0], [0, -0.05, 0.18], [0, -0.02, 0.34]], [0.095, 0.065, 0.03], GRN);
  B.put('abdomen', SPH(), CREAM, { y: -0.06, z: 0.12, sx: 0.085, sy: 0.02, sz: 0.11, rx: 0.35 });
  B.put('abdomen', SPH(), CREAM, { y: -0.045, z: 0.27, sx: 0.05, sy: 0.016, sz: 0.06, rx: 0.2 });

  // 躯干 + 胸前奶油护甲
  B.put('root', SPH(), GRN, { y: 0.78, sx: 0.145, sy: 0.235, sz: 0.125 });
  B.put('root', SPH(), CREAM, { y: 0.74, z: -0.085, sx: 0.09, sy: 0.16, sz: 0.055 });
  B.put('root', SPH(), CREAM, { y: 0.86, z: -0.075, sx: 0.085, sy: 0.045, sz: 0.05, rz: 0.1 });
  // 肩膀尖刺
  B.put('root', CONE(), GRN_D, { x: 0.16, y: 0.94, z: 0.0, sx: 0.045, sy: 0.10, sz: 0.04, rz: -0.9 });
  B.put('root', CONE(), GRN_D, { x: -0.16, y: 0.94, z: 0.0, sx: 0.045, sy: 0.10, sz: 0.04, rz: 0.9 });

  // 头（细长、有尖嘴和长触角）
  B.node('head', 'root', 0, 1.04, -0.02);
  B.put('head', SPH(), GRN, { y: 0.01, sx: 0.135, sy: 0.145, sz: 0.135 });
  // 尖尖的口鼻
  B.put('head', CONE(), GRN_D, { y: -0.03, z: -0.155, sx: 0.055, sy: 0.11, sz: 0.05, rx: -PI / 2 });
  // 额头冠（尖角）
  B.put('head', CONE(), GRN_D, { y: 0.155, z: -0.03, sx: 0.035, sy: 0.10, sz: 0.03, rx: -0.45 });
  addEyes(B, 'head', { y: 0.045, z: -0.105, spread: 0.078, r: 0.038, style: 'oval', pupil: DARK, tilt: -0.2 });
  // 长触角（向后上方）
  B.put('head', CAPSULE(0.010, 0.25), GRN_D, { x: 0.055, y: 0.17, z: 0.06, rx: 0.85, rz: -0.2 });
  B.put('head', CAPSULE(0.010, 0.25), GRN_D, { x: -0.055, y: 0.17, z: 0.06, rx: 0.85, rz: 0.2 });

  // 双臂 + 大镰刀（动画节点）
  const armDefs = [
    ['armL', -1, 0.92, 0.35],
    ['armR', 1, 0.98, 0.55],
  ];
  // 先放两条细臂的其余部分
  armDefs.forEach(function (a) {
    const name = a[0], s = a[1];
    const n = B.node(name, 'root', s * 0.15, 0.92, 0.0);
    n.rotation.z = s * a[2];
    n.rotation.x = -0.15;
    B.put(name, CAPSULE(0.030, 0.20), GRN, { x: s * 0.02, y: -0.13, z: 0, rz: s * 0.08 });
    B.put(name, CAPSULE(0.026, 0.17), GRN_D, { x: s * 0.035, y: -0.30, z: -0.04, rx: -0.35 });
    // 镰刀：白色刀刃 + 绿色刀柄
    B.put(name, SPH(), GRN, { x: s * 0.045, y: -0.40, z: -0.10, sx: 0.035, sy: 0.045, sz: 0.035 });
    // 大镰刀：从手腕向前伸出，稍微外翻，正面能看清刀形
    B.put(name, scytheGeo(0.19, 0.54, 0.04), BLADE, {
      x: s * 0.055, y: -0.40, z: -0.16, rx: PI / 2 - 0.18, rz: s * -0.30, ry: s * 0.35,
    });
    B.put(name, scytheGeo(0.12, 0.34, 0.024), 0xd8c9a0, {
      x: s * 0.058, y: -0.41, z: -0.145, rx: PI / 2 - 0.16, rz: s * -0.24, ry: s * 0.35,
    });
  });

  // 翅膀（两片，半透明）
  B.node('wings', 'root', 0, 0.92, 0.10);
  B.put('wings', leafGeo(0.065, 0.22, 0.006), WING, { x: 0.075, y: 0.02, rz: 0.75, rx: -0.55, glass: 0.45 });
  B.put('wings', leafGeo(0.065, 0.22, 0.006), WING, { x: -0.075, y: 0.02, rz: -0.75, rx: -0.55, glass: 0.45 });

  return finishModel(B, function (nodes, dt, t) {
    nodes.inner.scale.y = 1 + Math.sin(t * 1.7) * 0.010;
    nodes.head.rotation.x = Math.sin(t * 1.5) * 0.045;
    nodes.head.rotation.y = Math.sin(t * 0.8) * 0.12;
    nodes.abdomen.rotation.x = Math.sin(t * 1.2) * 0.05;
    nodes.armL.rotation.z = -0.35 + Math.sin(t * 1.6) * 0.05;
    nodes.armR.rotation.z = 0.55 + Math.sin(t * 1.6 + 0.8) * 0.06;
    nodes.armR.rotation.x = -0.15 + Math.sin(t * 1.1) * 0.05;
    nodes.wings.rotation.z = Math.sin(t * 30) * 0.07;
    nodes.wings.rotation.x = Math.sin(t * 26) * 0.05;
  });
}



// ===========================================================================
// 7. 宝可梦模型（四）幽灵 / 精英 / BOSS
// ===========================================================================

// —— 鬼斯：深紫雾团 + 白色大眼 + 獠牙 + 周围游动的紫色瓦斯 ——
function buildGastly() {
  const B = Builder();
  const PUR = 0x5a3a8e, PUR_D = 0x3e2768, GAS = 0x9366d8, WHITE = 0xfffdf4, DARK = 0x241a33;

  // 核心雾团（半透明深紫球）
  B.node('core', 'root', 0, 0.52, 0);
  B.put('core', SPH(), PUR, { sx: 0.225, sy: 0.235, sz: 0.215, glass: 0.9 });
  B.put('core', SPH(), PUR_D, { y: -0.06, z: 0.06, sx: 0.20, sy: 0.20, sz: 0.19, glass: 0.55 });
  // 脸：白色大眼睛 + 黑瞳 + 高光
  addEyes(B, 'core', { y: 0.045, z: -0.175, spread: 0.088, r: 0.072, style: 'full', white: WHITE, iris: DARK, pupil: DARK, wz: 0.5, hiR: 0.24 });
  // 咧嘴大笑（深色）+ 两颗上獠牙
  addOpenMouth(B, 'core', { y: -0.10, z: -0.16, w: 0.105, h: 0.055, color: 0x2a1c3d });
  addFangs(B, 'core', { n: 2, gap: 0.105, x: 0, y: -0.078, z: -0.205, w: 0.017, h: 0.045 });
  addFangs(B, 'core', { n: 2, gap: 0.13, x: 0, y: -0.145, z: -0.195, w: 0.013, h: 0.032 });
  // 眉毛（怒）
  B.put('core', SPH(), PUR_D, { x: 0.088, y: 0.135, z: -0.15, sx: 0.06, sy: 0.016, sz: 0.03, rz: 0.32 });
  B.put('core', SPH(), PUR_D, { x: -0.088, y: 0.135, z: -0.15, sx: 0.06, sy: 0.016, sz: 0.03, rz: -0.32 });

  // 周围瓦斯团（三个动画节点，缓慢游动）
  const puffs = [
    ['gasA', [[0.0, -0.19, 0.10, 0.15], [0.17, -0.11, -0.03, 0.10], [-0.16, -0.13, 0.02, 0.11]]],
    ['gasB', [[0.0, 0.13, 0.14, 0.13], [0.15, 0.20, 0.02, 0.085], [-0.14, 0.17, 0.05, 0.09]]],
    ['gasC', [[0.20, -0.02, -0.05, 0.12], [-0.21, -0.02, -0.04, 0.115], [0.0, -0.26, -0.03, 0.09]]],
  ];
  puffs.forEach(function (p) {
    B.node(p[0], 'root', 0, 0.52, 0);
    for (let i = 0; i < p[1].length; i++) {
      const s = p[1][i];
      B.put(p[0], SPH(), GAS, { x: s[0], y: s[1], z: s[2], sx: s[3], sy: s[3] * 0.92, sz: s[3], glass: 0.34 });
    }
  });

  return finishModel(B, function (nodes, dt, t) {
    nodes.inner.position.y = (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.07;
    nodes.core.rotation.y = Math.sin(t * 0.7) * 0.14;
    nodes.core.rotation.z = Math.sin(t * 0.9) * 0.05;
    nodes.gasA.rotation.y = t * 0.55;
    nodes.gasA.position.y = 0.52 + Math.sin(t * 1.3) * 0.03;
    nodes.gasB.rotation.y = -t * 0.42;
    nodes.gasB.position.y = 0.52 + Math.sin(t * 1.1 + 1.0) * 0.035;
    nodes.gasC.rotation.y = t * 0.33;
    nodes.gasC.position.y = 0.52 + Math.sin(t * 1.45 + 2.0) * 0.03;
    const s = 1 + Math.sin(t * 2.2) * 0.05;
    nodes.gasA.scale.setScalar(s);
    nodes.gasB.scale.setScalar(2 - s);
  });
}

// —— 耿鬼：紫色胖鬼 + 红眼 + 咧嘴大牙 + 两侧尖耳朵 ——
function buildGengar() {
  const B = Builder();
  const PUR = 0x6b4c9a, PUR_D = 0x553a80, PUR_L = 0x8a6ab8, WHITE = 0xfffdf2, RED = 0xe8453c;

  // 腿 / 脚
  B.put('root', SPH(), PUR, { x: 0.155, y: 0.20, z: 0.01, sx: 0.105, sy: 0.20, sz: 0.11 });
  B.put('root', SPH(), PUR, { x: -0.155, y: 0.20, z: 0.01, sx: 0.105, sy: 0.20, sz: 0.11 });
  B.put('root', SPH(), PUR_L, { x: 0.155, y: 0.045, z: -0.05, sx: 0.115, sy: 0.045, sz: 0.15 });
  B.put('root', SPH(), PUR_L, { x: -0.155, y: 0.045, z: -0.05, sx: 0.115, sy: 0.045, sz: 0.15 });
  addClaws(B, 'root', { x: 0.155, y: 0.04, z: -0.185, r: 0.014, len: 0.035, spread: 0.024, color: WHITE });
  addClaws(B, 'root', { x: -0.155, y: 0.04, z: -0.185, r: 0.014, len: 0.035, spread: 0.024, color: WHITE });

  // 大圆身子
  B.put('root', SPH(), PUR, { y: 0.58, sx: 0.335, sy: 0.38, sz: 0.30 });
  B.put('root', SPH(), PUR_L, { y: 0.50, z: -0.16, sx: 0.22, sy: 0.26, sz: 0.14 });
  // 背部尖刺
  B.put('root', CONE(), PUR_D, { y: 0.82, z: 0.20, sx: 0.07, sy: 0.17, sz: 0.06, rx: 0.75 });
  B.put('root', CONE(), PUR_D, { x: 0.16, y: 0.76, z: 0.22, sx: 0.06, sy: 0.14, sz: 0.05, rx: 0.7, rz: -0.25 });
  B.put('root', CONE(), PUR_D, { x: -0.16, y: 0.76, z: 0.22, sx: 0.06, sy: 0.14, sz: 0.05, rx: 0.7, rz: 0.25 });

  // 双臂（动画节点）
  const arms = [['armL', -1, 0.30, 0.72], ['armR', 1, 0.30, 0.72]];
  arms.forEach(function (a) {
    const name = a[0], s = a[1], ax = a[2], ay = a[3];
    B.node(name, 'root', s * ax, ay, -0.02);
    B.put(name, CAPSULE(0.075, 0.20), PUR, { x: s * 0.05, y: -0.14, z: -0.02, rz: s * -0.55 });
    B.put(name, SPH(), PUR_L, { x: s * 0.135, y: -0.285, z: -0.04, sx: 0.085, sy: 0.075, sz: 0.085 });
    for (let i = 0; i < 3; i++) {
      B.put(name, CONE(), WHITE, {
        x: s * (0.115 + i * 0.045), y: -0.335, z: -0.09,
        sx: 0.018, sy: 0.075, sz: 0.016, rz: s * (0.15 + i * 0.2), rx: -0.9, shine: true,
      });
    }
  });

  // 头（大圆头 + 两侧尖耳）
  B.node('head', 'root', 0, 1.10, -0.01);
  B.put('head', SPH_HI(), PUR, { y: 0.06, sx: 0.285, sy: 0.265, sz: 0.27 });
  B.put('head', SPH(), PUR_L, { y: 0.035, z: -0.115, sx: 0.215, sy: 0.19, sz: 0.16 });
  // 两侧大尖耳
  B.put('head', CONE(), PUR, { x: 0.245, y: 0.16, z: 0.03, sx: 0.10, sy: 0.22, sz: 0.085, rz: -0.85, shine: false });
  B.put('head', CONE(), PUR, { x: -0.245, y: 0.16, z: 0.03, sx: 0.10, sy: 0.22, sz: 0.085, rz: 0.85 });
  B.put('head', CONE(), PUR_D, { x: 0.20, y: 0.14, z: 0.01, sx: 0.062, sy: 0.15, sz: 0.05, rz: -0.85 });
  B.put('head', CONE(), PUR_D, { x: -0.20, y: 0.14, z: 0.01, sx: 0.062, sy: 0.15, sz: 0.05, rz: 0.85 });
  // 红眼（眼窝 + 红瞳 + 高光）
  addEyes(B, 'head', { y: 0.075, z: -0.238, spread: 0.115, r: 0.075, style: 'full', white: 0xff8a80, iris: RED, pupil: 0x3a1020, wz: 0.55, hiR: 0.24 });
  // 发光红瞳（鬼气）：两枚自发光小球叠在虹膜前
  B.put('head', SPH(), 0xff3a2a, { x: 0.115, y: 0.075, z: -0.30, sx: 0.034, sy: 0.036, sz: 0.022, glow: 0xff2a1a, glowInt: 2.2 });
  B.put('head', SPH(), 0xff3a2a, { x: -0.115, y: 0.075, z: -0.30, sx: 0.034, sy: 0.036, sz: 0.022, glow: 0xff2a1a, glowInt: 2.2 });
  // 大咧笑：黑色大嘴 + 上下一排白牙
  addOpenMouth(B, 'head', { y: -0.105, z: -0.245, w: 0.205, h: 0.058, color: 0x241536 });
  addTeethRow(B, 'head', { n: 7, w: 0.026, y: -0.038, z: -0.256, h: 0.046 });
  addTeethRow(B, 'head', { n: 7, w: 0.023, y: -0.163, z: -0.254, h: 0.040 });
  addFangs(B, 'head', { n: 2, gap: 0.135, x: 0, y: -0.045, z: -0.272, w: 0.017, h: 0.045 });

  return finishModel(B, function (nodes, dt, t) {
    const bob = Math.sin(t * 1.5);
    nodes.inner.position.y = (bob * 0.5 + 0.5) * 0.04;
    const sq = 1 + Math.sin(t * 1.9) * 0.016;
    nodes.inner.scale.set(1 + (1 - sq) * 0.5, sq, 1 + (1 - sq) * 0.5);
    nodes.head.rotation.z = Math.sin(t * 1.1) * 0.05;
    nodes.head.rotation.x = Math.sin(t * 1.7) * 0.04;
    nodes.armL.rotation.z = -0.25 + Math.sin(t * 1.8) * 0.13;
    nodes.armR.rotation.z = 0.25 - Math.sin(t * 1.8 + 0.6) * 0.13;
    nodes.armL.rotation.x = Math.sin(t * 1.3) * 0.10;
    nodes.armR.rotation.x = Math.sin(t * 1.3 + 1.2) * 0.10;
  });
}

// —— 卡比兽：巨大胖圆米色肚皮 + 睡脸 + 打呼气泡 ——
function buildSnorlax() {
  const B = Builder();
  const TEAL = 0x3f6b78, TEAL_D = 0x355966, CREAM = 0xf2e2b8, CREAM_D = 0xdcc79a;

  // 大脚掌（奶油色，前伸）
  B.put('root', SPH(), CREAM, { x: 0.30, y: 0.10, z: -0.24, sx: 0.20, sy: 0.10, sz: 0.28 });
  B.put('root', SPH(), CREAM, { x: -0.30, y: 0.10, z: -0.24, sx: 0.20, sy: 0.10, sz: 0.28 });
  addClaws(B, 'root', { x: 0.30, y: 0.07, z: -0.48, r: 0.022, len: 0.055, spread: 0.075, color: 0xfff8e6 });
  addClaws(B, 'root', { x: -0.30, y: 0.07, z: -0.48, r: 0.022, len: 0.055, spread: 0.075, color: 0xfff8e6 });
  // 短腿
  B.put('root', SPH(), TEAL, { x: 0.28, y: 0.30, z: -0.02, sx: 0.17, sy: 0.24, sz: 0.18 });
  B.put('root', SPH(), TEAL, { x: -0.28, y: 0.30, z: -0.02, sx: 0.17, sy: 0.24, sz: 0.18 });

  // 巨大身体
  B.put('root', SPH_HI(), TEAL, { y: 1.20, sx: 0.66, sy: 0.82, sz: 0.56 });
  // 米色大肚皮
  B.put('root', SPH(), CREAM, { y: 0.98, z: -0.38, sx: 0.45, sy: 0.44, sz: 0.24 });
  B.put('root', SPH(), CREAM_D, { y: 0.62, z: -0.30, sx: 0.33, sy: 0.18, sz: 0.19 });
  // 手臂（动画节点）
  ['armL', 'armR'].forEach(function (name, i) {
    const s = i === 0 ? -1 : 1;
    B.node(name, 'root', s * 0.56, 1.24, -0.12);
    B.put(name, CAPSULE(0.135, 0.30), TEAL, { x: s * 0.04, y: -0.17, z: -0.03, rz: s * -0.22 });
    B.put(name, SPH(), CREAM, { x: s * 0.055, y: -0.40, z: -0.07, sx: 0.135, sy: 0.115, sz: 0.13 });
    for (let k = 0; k < 3; k++) {
      B.put(name, CONE(), 0xfff8e6, {
        x: s * (0.02 + k * 0.045), y: -0.48, z: -0.12,
        sx: 0.02, sy: 0.06, sz: 0.018, rx: -1.0, rz: s * 0.1, shine: true,
      });
    }
  });

  // 头（与身体连接的大圆头 + 睡脸）
  B.node('head', 'root', 0, 1.72, -0.10);
  B.put('head', SPH_HI(), TEAL, { y: 0.10, sx: 0.44, sy: 0.38, sz: 0.40 });
  // 米色脸盘
  B.put('head', SPH(), CREAM, { y: 0.06, z: -0.26, sx: 0.34, sy: 0.275, sz: 0.17 });
  // 闭眼（∩ 弧线）
  B.put('head', TORUS(0.072, 0.014, PI), 0x2c3a40, { x: 0.145, y: 0.12, z: -0.42, sz: 0.35 });
  B.put('head', TORUS(0.072, 0.014, PI), 0x2c3a40, { x: -0.145, y: 0.12, z: -0.42, sz: 0.35 });
  // 嘴（小 w）
  addSmile(B, 'head', { y: -0.10, z: -0.425, w: 0.05, tube: 0.011, color: 0x6a5a3a });
  // 小耳朵
  B.put('head', CONE(), TEAL, { x: 0.335, y: 0.40, z: 0.02, sx: 0.09, sy: 0.17, sz: 0.08, rz: -0.5 });
  B.put('head', CONE(), TEAL, { x: -0.335, y: 0.40, z: 0.02, sx: 0.09, sy: 0.17, sz: 0.08, rz: 0.5 });
  B.put('head', CONE(), TEAL_D, { x: 0.325, y: 0.40, z: -0.005, sx: 0.05, sy: 0.11, sz: 0.04, rz: -0.5 });
  B.put('head', CONE(), TEAL_D, { x: -0.325, y: 0.40, z: -0.005, sx: 0.05, sy: 0.11, sz: 0.04, rz: 0.5 });
  // 脸颊小肉
  B.put('head', SPH(), CREAM_D, { x: 0.28, y: -0.02, z: -0.24, sx: 0.09, sy: 0.07, sz: 0.07 });

  // 打呼的鼻泡（动画节点）
  B.node('snore', 'head', 0.02, -0.06, -0.46);
  B.put('snore', SPH(), 0xfffdf2, { sx: 0.022, sy: 0.022, sz: 0.022, glass: 0.6 });
  B.put('snore', SPH(), 0xfffdf2, { x: 0.045, y: 0.05, sx: 0.014, sy: 0.014, sz: 0.014, glass: 0.45 });

  return finishModel(B, function (nodes, dt, t) {
    // 深呼吸：整个身体缓慢起伏
    const br = Math.sin(t * 0.85);
    nodes.inner.scale.y = 1 + br * 0.012;
    nodes.head.rotation.z = Math.sin(t * 0.5) * 0.02;
    nodes.armL.rotation.z = 0.10 + br * 0.03;
    nodes.armR.rotation.z = -0.10 - br * 0.03;
    // 鼻泡：从嘴边升起再淡出（用缩放模拟）
    const p = (t * 0.45) % 1;
    nodes.snore.position.y = -0.06 + p * 0.26;
    nodes.snore.position.x = 0.02 + Math.sin(p * 5.5) * 0.03;
    const sc = Math.sin(p * PI);
    nodes.snore.scale.setScalar(Math.max(0.001, sc));
  });
}

// —— 超梦：紫白修长身体 + 头侧双冠 + 粗长尾巴 + 紫色大眼 ——
function buildMewtwo() {
  const B = Builder();
  const BODY = 0xd9c9ec, BODY_D = 0xb9a4d8, PUR = 0x8a4fd8, CREAM = 0xefe6f7, DARK = 0x2a1f3a;

  // 脚（两趾大脚）
  [-1, 1].forEach(function (s) {
    B.put('root', SPH(), BODY, { x: s * 0.145, y: 0.075, z: -0.07, sx: 0.10, sy: 0.065, sz: 0.155 });
    B.put('root', CONE(), BODY_D, { x: s * 0.115, y: 0.055, z: -0.19, sx: 0.035, sy: 0.08, sz: 0.03, rx: -PI / 2, shine: true });
    B.put('root', CONE(), BODY_D, { x: s * 0.18, y: 0.055, z: -0.18, sx: 0.033, sy: 0.075, sz: 0.03, rx: -PI / 2, shine: true });
    // 小腿 / 大腿
    B.put('root', CAPSULE(0.058, 0.30), BODY, { x: s * 0.145, y: 0.38, z: -0.02, rx: 0.06 });
    B.put('root', SPH(), BODY, { x: s * 0.148, y: 0.52, z: -0.03, sx: 0.065, sy: 0.06, sz: 0.06 });
    B.put('root', CAPSULE(0.082, 0.26), BODY, { x: s * 0.15, y: 0.70, z: 0.0, rx: -0.08 });
    B.put('root', SPH(), BODY, { x: s * 0.145, y: 0.15, z: -0.04, sx: 0.058, sy: 0.05, sz: 0.06 });
  });
  // 脖子 + 胸腔（把头和身体连起来）
  B.put('root', CAPSULE(0.075, 0.16), BODY, { y: 1.44, z: -0.005 });
  B.put('root', SPH(), BODY, { y: 1.38, sx: 0.20, sy: 0.13, sz: 0.15 });
  // 骨盆
  B.put('root', SPH(), BODY, { y: 0.86, sx: 0.19, sy: 0.14, sz: 0.16 });
  // 躯干
  B.put('root', SPH(), BODY, { y: 1.14, sx: 0.235, sy: 0.27, sz: 0.165 });
  // 深紫胸腹
  B.put('root', SPH(), BODY_D, { y: 1.16, z: -0.045, sx: 0.145, sy: 0.19, sz: 0.125 });
  // 肩
  B.put('root', SPH(), BODY, { x: 0.18, y: 1.32, sx: 0.10, sy: 0.085, sz: 0.10 });
  B.put('root', SPH(), BODY, { x: -0.18, y: 1.32, sx: 0.10, sy: 0.085, sz: 0.10 });

  // 双臂（动画节点：微微浮起）
  ['armL', 'armR'].forEach(function (name, i) {
    const s = i === 0 ? -1 : 1;
    const n = B.node(name, 'root', s * 0.20, 1.34, 0);
    n.rotation.z = s * 0.35;
    B.put(name, CAPSULE(0.055, 0.18), BODY, { x: s * 0.06, y: -0.14, z: -0.01 });
    B.put(name, SPH(), BODY, { x: s * 0.10, y: -0.26, z: -0.035, sx: 0.05, sy: 0.048, sz: 0.05 });
    B.put(name, CAPSULE(0.048, 0.19), BODY, { x: s * 0.115, y: -0.34, z: -0.06, rx: -0.35 });
    B.put(name, SPH(), BODY, { x: s * 0.13, y: -0.46, z: -0.11, sx: 0.048, sy: 0.052, sz: 0.045 });
    // 三根手指
    for (let k = 0; k < 3; k++) {
      B.put(name, CAPSULE(0.011, 0.055), BODY_D, {
        x: s * (0.10 + k * 0.022), y: -0.50, z: -0.15,
        rx: -0.9, rz: s * (k - 1) * 0.25,
      });
    }
  });

  // 头（含头冠与眼睛）
  B.node('head', 'root', 0, 1.66, -0.02);
  B.put('head', SPH_HI(), BODY, { y: 0.03, sx: 0.155, sy: 0.175, sz: 0.155 });
  // 面部浅色
  B.put('head', SPH(), CREAM, { y: -0.02, z: -0.10, sx: 0.115, sy: 0.11, sz: 0.085 });
  // 紫色大眼（略斜）
  addEyes(B, 'head', { y: 0.045, z: -0.125, spread: 0.088, r: 0.052, style: 'full', white: 0xf4eefc, iris: PUR, pupil: 0x231436, wz: 0.55, tilt: 0.15, hiR: 0.28 });
  // 小嘴
  B.put('head', SPH(), BODY_D, { y: -0.075, z: -0.155, sx: 0.032, sy: 0.008, sz: 0.012 });
  // 头侧双冠（向后上方延伸的两根角）
  capChain(B, 'head', [[0.085, 0.10, 0.04], [0.175, 0.18, 0.16], [0.20, 0.17, 0.30]], [0.036, 0.028, 0.015], BODY_D);
  capChain(B, 'head', [[-0.085, 0.10, 0.04], [-0.175, 0.18, 0.16], [-0.20, 0.17, 0.30]], [0.036, 0.028, 0.015], BODY_D);
  // 头顶中央小凸起
  B.put('head', SPH(), BODY_D, { y: 0.185, z: -0.02, sx: 0.045, sy: 0.055, sz: 0.045 });

  // 长尾巴（动画节点，从后腰伸出、垂到地面再翘起）
  const tail = B.node('tail', 'root', 0, 0.80, 0.16);
  capChain(B, 'tail', [
    [0, 0.03, 0.0], [0, -0.08, 0.12], [0, -0.24, 0.22], [0, -0.42, 0.28],
    [0, -0.55, 0.37], [0, -0.55, 0.50], [0, -0.46, 0.58],
  ], [0.08, 0.066, 0.052, 0.042, 0.032, 0.024, 0.016], BODY);
  B.put('tail', SPH(), BODY_D, { y: -0.455, z: 0.59, sx: 0.028, sy: 0.028, sz: 0.028 });

  return finishModel(B, function (nodes, dt, t) {
    const br = Math.sin(t * 1.4);
    nodes.inner.scale.y = 1 + br * 0.008;
    nodes.head.rotation.x = Math.sin(t * 1.1) * 0.04;
    nodes.head.rotation.y = Math.sin(t * 0.7) * 0.08;
    const sway = Math.sin(t * 1.2);
    nodes.tail.rotation.z = sway * 0.10;
    nodes.tail.rotation.y = sway * 0.14;
    nodes.armL.rotation.z = -0.35 + Math.sin(t * 1.0) * 0.06;
    nodes.armR.rotation.z = 0.35 - Math.sin(t * 1.0 + 0.5) * 0.06;
    nodes.armL.rotation.x = Math.sin(t * 0.9) * 0.05;
    nodes.armR.rotation.x = Math.sin(t * 0.9 + 1.3) * 0.05;
  });
}



// ===========================================================================
// 8. 宝可梦模型（五）大岩蛇 / 喵喵 / 胖丁 / 可达鸭
// ===========================================================================

// —— 大岩蛇：一串灰色巨岩从地下钻出 + 头顶尖角 + 大眼 ——
function buildOnix() {
  const B = Builder();
  const G1 = 0x9aa3ab, G2 = 0x8b959d, G3 = 0xaeb6bd, TAN = 0xb8a889, DARK = 0x3a4048;

  // 岩石节段：[name, y, z, radius, 颜色]
  const segs = [
    ['seg0', 0.20, 0.42, 0.31, G2],
    ['seg1', 0.38, 0.38, 0.30, G1],
    ['seg2', 0.58, 0.22, 0.28, G3],
    ['seg3', 0.80, 0.02, 0.255, G2],
    ['seg4', 1.02, -0.16, 0.225, G1],
    ['seg5', 1.22, -0.30, 0.20, G3],
  ];
  // X 方向叠加侧弯，使正面视角也能读出蛇形轮廓
  const segX = [0.24, 0.16, 0.02, -0.12, -0.24, -0.32];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    B.node(s[0], 'root', segX[i], s[1], s[2]);
    const r = s[3];
    // 主体岩块（低多边形，flatShading 材质给出岩石切面）
    B.put(s[0], ICO(1, 1), s[4], { sx: r, sy: r * 0.86, sz: r * 0.94, ry: i * 0.9, rz: i * 0.35, rock: true });
    // 附加碎岩
    B.put(s[0], ICO(1, 0), s[4] === G1 ? G3 : G2, {
      x: r * 0.55, y: r * 0.35, z: r * 0.30, sx: r * 0.38, sy: r * 0.30, sz: r * 0.34, rock: true, ry: i * 2.1,
    });
    // 沙色斑块
    B.put(s[0], SPH(), TAN, { x: -r * 0.45, y: r * 0.30, z: r * 0.45, sx: r * 0.26, sy: r * 0.18, sz: r * 0.22, ry: 0.4, rock: true });
    // 相邻岩块之间的暗色连接
    if (i > 0) {
      B.put(s[0], SPH(), 0x5f676e, { y: -r * 0.75, z: 0.01, sx: r * 0.55, sy: r * 0.4, sz: r * 0.55, rock: true });
    }
  }

  // 头（岩石头 + 大眼睛 + 尖角）
  B.node('head', 'root', -0.36, 1.48, -0.34);
  B.put('head', ICO(1, 1), G3, { y: 0.06, sx: 0.225, sy: 0.195, sz: 0.235, ry: 0.4, rock: true });
  B.put('head', ICO(1, 0), G2, { x: 0.12, y: 0.18, z: 0.03, sx: 0.10, sy: 0.085, sz: 0.09, rock: true, rx: 0.4 });
  B.put('head', ICO(1, 0), G2, { x: -0.13, y: 0.15, z: 0.01, sx: 0.09, sy: 0.075, sz: 0.085, rock: true, rz: -0.3 });
  // 白色大眼 + 黑瞳 + 高光
  addEyes(B, 'head', { y: 0.05, z: -0.185, spread: 0.10, r: 0.062, style: 'full', white: 0xfffdf4, iris: DARK, pupil: DARK, wz: 0.55 });
  // 怒眉（深灰岩条）
  B.put('head', BOX(), 0x6a727a, { x: 0.10, y: 0.13, z: -0.175, sx: 0.13, sy: 0.032, sz: 0.05, rz: 0.28, rock: true });
  B.put('head', BOX(), 0x6a727a, { x: -0.10, y: 0.13, z: -0.175, sx: 0.13, sy: 0.032, sz: 0.05, rz: -0.28, rock: true });
  // 头顶尖角
  B.put('head', CONE(), G3, { y: 0.27, z: 0.0, sx: 0.075, sy: 0.24, sz: 0.07, rx: -0.2, rock: true });
  B.put('head', CONE(), G1, { x: 0.16, y: 0.22, z: 0.03, sx: 0.045, sy: 0.13, sz: 0.04, rz: -0.55, rock: true });
  B.put('head', CONE(), G1, { x: -0.16, y: 0.22, z: 0.03, sx: 0.045, sy: 0.13, sz: 0.04, rz: 0.55, rock: true });
  // 嘴（一条深色缝 + 两颗小牙）
  B.put('head', BOX(), 0x4a4048, { y: -0.075, z: -0.20, sx: 0.11, sy: 0.022, sz: 0.03, rock: true });
  B.put('head', CONE(), 0xfffdf4, { x: 0.045, y: -0.09, z: -0.215, sx: 0.016, sy: 0.04, sz: 0.014, rx: PI, shine: true });
  B.put('head', CONE(), 0xfffdf4, { x: -0.045, y: -0.09, z: -0.215, sx: 0.016, sy: 0.04, sz: 0.014, rx: PI, shine: true });

  return finishModel(B, function (nodes, dt, t) {
    // 岩蛇：从尾部到头部依次摇摆
    const names = ['seg0', 'seg1', 'seg2', 'seg3', 'seg4', 'seg5'];
    for (let i = 0; i < names.length; i++) {
      const n = nodes[names[i]];
      const ph = t * 1.5 - i * 0.55;
      n.rotation.z = Math.sin(ph) * 0.045;
      n.rotation.x = Math.sin(ph + 1.0) * 0.035;
      n.position.y = segs[i][1] + Math.sin(ph + 0.4) * 0.012;
    }
    nodes.head.rotation.z = Math.sin(t * 1.5 - 3.3) * 0.06;
    nodes.head.rotation.x = Math.sin(t * 1.1) * 0.04;
    nodes.head.position.y = 1.48 + Math.sin(t * 1.5 - 2.9) * 0.014;
    nodes.head.position.x = -0.36;
  });
}

// —— 喵喵：奶油猫 + 额头金币 + 胡须 + 卷尾巴 ——
function buildMeowth() {
  const B = Builder();
  const CRM = 0xf7e6b0, CRM_D = 0xdfc98c, BRN = 0x8a5a2a, GOLD = 0xffc81a, GOLD_D = 0xd89a00, PINK = 0xf2a0a8, DARK = 0x2a2430;

  // 腿 / 脚
  B.put('root', SPH(), CRM, { x: 0.095, y: 0.16, z: 0.0, sx: 0.07, sy: 0.13, sz: 0.08 });
  B.put('root', SPH(), CRM, { x: -0.095, y: 0.16, z: 0.0, sx: 0.07, sy: 0.13, sz: 0.08 });
  B.put('root', SPH(), CRM_D, { x: 0.095, y: 0.035, z: -0.045, sx: 0.085, sy: 0.035, sz: 0.115 });
  B.put('root', SPH(), CRM_D, { x: -0.095, y: 0.035, z: -0.045, sx: 0.085, sy: 0.035, sz: 0.115 });

  // 身体
  B.put('root', SPH(), CRM, { y: 0.34, sx: 0.16, sy: 0.185, sz: 0.145 });
  B.put('root', SPH(), 0xfff2cc, { y: 0.30, z: -0.10, sx: 0.10, sy: 0.11, sz: 0.06 });
  // 手臂
  B.put('root', SPH(), CRM, { x: 0.16, y: 0.38, z: -0.01, sx: 0.045, sy: 0.085, sz: 0.045, rz: -0.5 });
  B.put('root', SPH(), CRM, { x: -0.16, y: 0.38, z: -0.01, sx: 0.045, sy: 0.085, sz: 0.045, rz: 0.5 });
  addClaws(B, 'root', { x: 0.175, y: 0.315, z: -0.045, r: 0.011, len: 0.026, spread: 0.017, rz: -0.5, color: 0xfff8e0 });
  addClaws(B, 'root', { x: -0.175, y: 0.315, z: -0.045, r: 0.011, len: 0.026, spread: 0.017, rz: 0.5, color: 0xfff8e0 });

  // 头
  B.node('head', 'root', 0, 0.62, -0.01);
  B.put('head', SPH(), CRM, { y: 0.02, sx: 0.195, sy: 0.185, sz: 0.18 });
  // 额头金币（小判）
  B.put('head', CYL(), GOLD, { y: 0.13, z: -0.155, sx: 0.062, sy: 0.022, sz: 0.048, rx: PI / 2, shine: true });
  B.put('head', CYL(), GOLD_D, { y: 0.13, z: -0.158, sx: 0.045, sy: 0.026, sz: 0.034, rx: PI / 2, shine: true });
  B.put('head', CYL(), GOLD, { y: 0.13, z: -0.162, sx: 0.03, sy: 0.028, sz: 0.024, rx: PI / 2, shine: true });
  // 耳朵（奶油色 + 棕色尖端 + 粉色内耳）
  B.put('head', CONE(), CRM, { x: 0.135, y: 0.19, z: 0.01, sx: 0.07, sy: 0.14, sz: 0.055, rz: -0.38 });
  B.put('head', CONE(), CRM, { x: -0.135, y: 0.19, z: 0.01, sx: 0.07, sy: 0.14, sz: 0.055, rz: 0.38 });
  B.put('head', CONE(), BRN, { x: 0.16, y: 0.27, z: 0.01, sx: 0.042, sy: 0.08, sz: 0.035, rz: -0.38 });
  B.put('head', CONE(), BRN, { x: -0.16, y: 0.27, z: 0.01, sx: 0.042, sy: 0.08, sz: 0.035, rz: 0.38 });
  B.put('head', CONE(), PINK, { x: 0.128, y: 0.185, z: -0.035, sx: 0.038, sy: 0.09, sz: 0.025, rz: -0.38 });
  B.put('head', CONE(), PINK, { x: -0.128, y: 0.185, z: -0.035, sx: 0.038, sy: 0.09, sz: 0.025, rz: 0.38 });
  // 眼睛（竖椭圆黑眼 + 高光）
  addEyes(B, 'head', { y: 0.045, z: -0.155, spread: 0.088, r: 0.052, style: 'oval', pupil: DARK, hiR: 0.28 });
  // 鼻子与嘴（猫嘴 ω）
  B.put('head', CONE(), PINK, { y: -0.025, z: -0.192, sx: 0.022, sy: 0.030, sz: 0.020, rx: PI, shine: true });
  addSmile(B, 'head', { x: 0.022, y: -0.055, z: -0.188, w: 0.020, tube: 0.006, color: 0x5a4432 });
  addSmile(B, 'head', { x: -0.022, y: -0.055, z: -0.188, w: 0.020, tube: 0.006, color: 0x5a4432 });
  // 两侧胡须（各三根）
  for (let i = 0; i < 3; i++) {
    const a = (i - 1) * 0.28;
    B.put('head', CAPSULE(0.0045, 0.115), 0x4a3a2a, { x: 0.17, y: -0.02 + i * 0.02, z: -0.075, rz: PI / 2 + 0.15 + a, shine: false });
    B.put('head', CAPSULE(0.0045, 0.115), 0x4a3a2a, { x: -0.17, y: -0.02 + i * 0.02, z: -0.075, rz: -PI / 2 - 0.15 - a, shine: false });
  }

  // 尾巴（动画节点，向上卷曲 + 棕色尖端）
  B.node('tail', 'root', 0, 0.24, 0.145);
  capChain(B, 'tail', [[0, 0, 0], [0, 0.07, 0.09], [0, 0.18, 0.13], [0, 0.29, 0.10]], [0.034, 0.028, 0.022, 0.016], CRM);
  B.put('tail', SPH(), BRN, { y: 0.32, z: 0.07, sx: 0.032, sy: 0.045, sz: 0.032 });
  B.put('tail', CONE(), BRN, { y: 0.365, z: 0.06, sx: 0.026, sy: 0.05, sz: 0.024, rx: 0.25 });

  return finishModel(B, function (nodes, dt, t) {
    nodes.inner.scale.y = 1 + Math.sin(t * 2.0) * 0.012;
    nodes.head.rotation.x = Math.sin(t * 1.4) * 0.05;
    nodes.head.rotation.z = Math.sin(t * 0.9) * 0.05;
    nodes.head.rotation.y = Math.sin(t * 0.55) * 0.10;
    nodes.tail.rotation.z = Math.sin(t * 1.8) * 0.16;
    nodes.tail.rotation.x = Math.sin(t * 1.2) * 0.10;
  });
}

// —— 胖丁：粉色圆球 + 大蓝眼 + 头顶卷毛 + 兔耳 ——
function buildJigglypuff() {
  const B = Builder();
  const PINK = 0xffb7d0, PINK_D = 0xf29ab8, PINK_L = 0xffd3e2, TEAL = 0x3fb8d8, DARK = 0x22303c, WHITE = 0xfffdf8;

  // 小脚
  B.put('root', SPH(), PINK_D, { x: 0.085, y: 0.045, z: -0.035, sx: 0.075, sy: 0.042, sz: 0.09 });
  B.put('root', SPH(), PINK_D, { x: -0.085, y: 0.045, z: -0.035, sx: 0.075, sy: 0.042, sz: 0.09 });
  // 圆身体
  B.put('root', SPH_HI(), PINK, { y: 0.245, sx: 0.215, sy: 0.215, sz: 0.20 });
  B.put('root', SPH(), PINK_L, { y: 0.20, z: -0.10, sx: 0.135, sy: 0.13, sz: 0.085 });
  // 小手
  B.put('root', SPH(), PINK, { x: 0.175, y: 0.235, z: -0.045, sx: 0.048, sy: 0.075, sz: 0.048, rz: -0.45 });
  B.put('root', SPH(), PINK, { x: -0.175, y: 0.235, z: -0.045, sx: 0.048, sy: 0.075, sz: 0.048, rz: 0.45 });

  // 耳朵（动画节点）
  const earL = B.node('earL', 'root', -0.115, 0.40, 0.01);
  const earR = B.node('earR', 'root', 0.115, 0.40, 0.01);
  earL.rotation.z = 0.28; earR.rotation.z = -0.28;
  [['earL', -1], ['earR', 1]].forEach(function (e) {
    const name = e[0], s = e[1];
    B.put(name, CONE(), PINK, { x: s * 0.008, y: 0.075, sx: 0.055, sy: 0.16, sz: 0.045 });
    B.put(name, CONE(), PINK_D, { x: s * 0.008, y: 0.055, z: -0.018, sx: 0.030, sy: 0.10, sz: 0.022 });
  });

  // 头顶卷毛（动画节点）
  B.node('tuft', 'root', 0, 0.435, 0.015);
  B.put('tuft', TORUS(0.045, 0.017, PI * 1.45), PINK_D, { rz: -0.4, rx: 0.2 });
  B.put('tuft', CONE(), PINK_D, { x: 0.028, y: 0.055, z: 0.02, sx: 0.024, sy: 0.06, sz: 0.022, rz: -0.7 });

  // 大眼睛（招牌：大蓝眼 + 大高光）
  addEyes(B, 'root', { y: 0.275, z: -0.165, spread: 0.078, r: 0.070, style: 'full', white: WHITE, iris: TEAL, pupil: DARK, wz: 0.5, hiR: 0.34 });
  // 小嘴
  addSmile(B, 'root', { y: 0.185, z: -0.185, w: 0.024, tube: 0.007, color: 0x7a3a52 });
  // 腮红
  B.put('root', SPH(), 0xff9ab6, { x: 0.14, y: 0.205, z: -0.115, sx: 0.04, sy: 0.024, sz: 0.02 });
  B.put('root', SPH(), 0xff9ab6, { x: -0.14, y: 0.205, z: -0.115, sx: 0.04, sy: 0.024, sz: 0.02 });

  return finishModel(B, function (nodes, dt, t) {
    const sq = Math.sin(t * 2.4);
    nodes.inner.scale.set(1 + sq * 0.018, 1 - sq * 0.018, 1 + sq * 0.018);
    nodes.earL.rotation.z = 0.28 + Math.sin(t * 2.0) * 0.10;
    nodes.earR.rotation.z = -0.28 - Math.sin(t * 2.0 + 0.6) * 0.10;
    nodes.tuft.rotation.z = Math.sin(t * 1.7) * 0.14;
    nodes.tuft.rotation.x = Math.sin(t * 1.3) * 0.10;
  }, { scale: 1.07 });
}

// —— 可达鸭：黄身 + 奶油嘴 + 三根呆毛 + 双手抱头的呆萌姿势 ——
function buildPsyduck() {
  const B = Builder();
  const YEL = 0xffe066, YEL_D = 0xe8c44a, CREAM = 0xfff4d2, DARK = 0x2a2a34;

  // 脚（奶油色鸭掌）
  B.put('root', SPH(), CREAM, { x: 0.11, y: 0.045, z: -0.05, sx: 0.10, sy: 0.042, sz: 0.14 });
  B.put('root', SPH(), CREAM, { x: -0.11, y: 0.045, z: -0.05, sx: 0.10, sy: 0.042, sz: 0.14 });
  addClaws(B, 'root', { x: 0.11, y: 0.035, z: -0.175, r: 0.012, len: 0.032, spread: 0.03, color: CREAM, rx: -PI / 2 });
  addClaws(B, 'root', { x: -0.11, y: 0.035, z: -0.175, r: 0.012, len: 0.032, spread: 0.03, color: CREAM, rx: -PI / 2 });

  // 身体
  B.put('root', SPH(), YEL, { y: 0.36, sx: 0.185, sy: 0.22, sz: 0.17 });
  B.put('root', SPH(), CREAM, { y: 0.32, z: -0.11, sx: 0.11, sy: 0.13, sz: 0.065 });
  // 小尾巴
  B.put('root', CONE(), YEL_D, { y: 0.32, z: 0.175, sx: 0.06, sy: 0.13, sz: 0.05, rx: -1.2 });
  // 手臂：从肩部弯到脑袋两侧（抱头）
  ['armL', 'armR'].forEach(function (name, i) {
    const s = i === 0 ? -1 : 1;
    const n = B.node(name, 'root', s * 0.155, 0.47, -0.01);
    B.put(name, CAPSULE(0.036, 0.13), YEL, { x: s * 0.055, y: 0.02, z: -0.02, rz: s * -0.9, rx: -0.25 });
    B.put(name, CAPSULE(0.032, 0.11), YEL, { x: s * 0.10, y: 0.13, z: -0.05, rz: s * -0.45 });
    B.put(name, SPH(), CREAM, { x: s * 0.115, y: 0.185, z: -0.075, sx: 0.062, sy: 0.055, sz: 0.062 });
    for (let k = 0; k < 3; k++) {
      B.put(name, CAPSULE(0.010, 0.035), CREAM, {
        x: s * (0.10 + k * 0.018), y: 0.20, z: -0.115, rx: -1.2, rz: s * (k - 1) * 0.3,
      });
    }
  });

  // 头
  B.node('head', 'root', 0, 0.64, -0.01);
  B.put('head', SPH_HI(), YEL, { y: 0.02, sx: 0.195, sy: 0.185, sz: 0.185 });
  // 奶油色鸭嘴
  B.put('head', SPH(), CREAM, { y: -0.035, z: -0.17, sx: 0.115, sy: 0.045, sz: 0.10 });
  B.put('head', CONE(), CREAM, { y: -0.045, z: -0.24, sx: 0.085, sy: 0.10, sz: 0.06, rx: -PI / 2 });
  B.put('head', SPH(), YEL_D, { y: -0.062, z: -0.185, sx: 0.09, sy: 0.022, sz: 0.075 });
  // 呆萌大眼 + 小黑点瞳孔
  addEyes(B, 'head', { y: 0.055, z: -0.145, spread: 0.088, r: 0.052, style: 'full', white: 0xfffdf6, iris: 0x1f1f26, pupil: 0x1f1f26, wz: 0.5, hiR: 0.33 });
  // 三根呆毛
  B.put('head', CAPSULE(0.010, 0.09), DARK, { x: 0.0, y: 0.225, z: -0.02, rx: 0.25 });
  B.put('head', CAPSULE(0.010, 0.075), DARK, { x: 0.045, y: 0.215, z: -0.015, rz: -0.45, rx: 0.25 });
  B.put('head', CAPSULE(0.010, 0.075), DARK, { x: -0.045, y: 0.215, z: -0.015, rz: 0.45, rx: 0.25 });

  return finishModel(B, function (nodes, dt, t) {
    // 抱头摇晃 + 轻微颤抖（经典可达鸭头痛）
    nodes.inner.rotation.z = Math.sin(t * 2.2) * 0.05;
    nodes.inner.rotation.x = Math.sin(t * 1.7 + 0.6) * 0.03;
    nodes.head.rotation.z = Math.sin(t * 2.6 + 0.3) * 0.07;
    nodes.head.rotation.x = Math.sin(t * 1.9) * 0.04;
    nodes.armL.rotation.z = Math.sin(t * 11) * 0.03;
    nodes.armR.rotation.z = -Math.sin(t * 11 + 0.8) * 0.03;
  });
}



// ===========================================================================
// 9. 训练家模型（四名，站立 + 一只手前举握武器）
// ===========================================================================
const TRAINER_LOOKS = {
  t_bolt: {
    skin: 0xf2c79f, hair: 0x2c2b33, top: 0xffd93d, sleeve: 0x2c2b33,
    trim: 0xffffff, pants: 0x33333e, shoe: 0xf7f7f7, sole: 0x2c2b33, glove: 0x2c2b33,
  },
  t_leaf: {
    skin: 0xf3cba8, hair: 0x7a5230, top: 0x4e9c3f, sleeve: 0x6fbb4a,
    trim: 0xfff4c8, pants: 0x2f4a2a, shoe: 0x8a5a2a, sole: 0x5f3f1e, glove: 0x4e9c3f,
  },
  t_ember: {
    skin: 0xdfa77d, hair: 0x3a2018, top: 0xe8453c, sleeve: 0xb8302a,
    trim: 0xffb43d, pants: 0x3a3028, shoe: 0x2b2620, sole: 0x18130f, glove: 0x2b2620,
  },
  t_tide: {
    skin: 0xf1c4a4, hair: 0x2aa8b8, top: 0x2a7fd0, sleeve: 0x1f66b0,
    trim: 0x6fe0ef, pants: 0x235f9e, shoe: 0x1b3f6b, sole: 0x142f52, glove: 0x1f66b0,
  },
};

// 通用人形骨架：腿 / 鞋 / 胯 / 腰带 + 躯干 + 头 + 双臂（右手前举）
function buildTrainer(id) {
  const L = TRAINER_LOOKS[id] || TRAINER_LOOKS.t_bolt;
  const B = Builder();

  // ---------------- 下半身（不参与动画） ----------------
  [1, -1].forEach(function (s) {
    // 鞋：鞋面 + 白色/深色鞋底 + 鞋头
    B.put('root', SPH(), L.shoe, { x: s * 0.105, y: 0.075, z: -0.035, sx: 0.095, sy: 0.058, sz: 0.16 });
    B.put('root', SPH(), L.sole, { x: s * 0.105, y: 0.030, z: -0.03, sx: 0.10, sy: 0.028, sz: 0.175 });
    B.put('root', SPH(), L.trim, { x: s * 0.105, y: 0.088, z: -0.10, sx: 0.075, sy: 0.022, sz: 0.06 });
    // 小腿 / 大腿
    B.put('root', CAPSULE(0.058, 0.30), L.pants, { x: s * 0.105, y: 0.30, z: -0.005 });
    B.put('root', CAPSULE(0.078, 0.28), L.pants, { x: s * 0.10, y: 0.71, z: 0.0 });
    // 裤侧条纹
    B.put('root', SPH(), L.trim, { x: s * 0.145, y: 0.66, z: 0.0, sx: 0.014, sy: 0.24, sz: 0.03 });
    // 膝盖
    B.put('root', SPH(), L.pants, { x: s * 0.105, y: 0.50, z: -0.015, sx: 0.062, sy: 0.06, sz: 0.065 });
  });
  // 胯 + 腰带
  B.put('root', SPH(), L.pants, { y: 0.93, sx: 0.175, sy: 0.115, sz: 0.125 });
  B.put('root', CYL(), L.sole, { y: 1.00, sx: 0.168, sy: 0.045, sz: 0.128 });
  B.put('root', SPH(), L.trim, { x: 0, y: 1.00, z: -0.125, sx: 0.04, sy: 0.032, sz: 0.012, shine: true });

  // ---------------- 躯干（动画节点） ----------------
  const torso = B.node('torso', 'root', 0, 0.98, 0);
  // 上衣
  B.put('torso', SPH_HI(), L.top, { y: 0.22, sx: 0.185, sy: 0.245, sz: 0.132 });
  B.put('torso', SPH(), L.top, { y: 0.04, sx: 0.165, sy: 0.06, sz: 0.12 });
  // 肩部圆润
  B.put('torso', SPH(), L.sleeve, { x: 0.185, y: 0.34, z: 0.0, sx: 0.082, sy: 0.078, sz: 0.085 });
  B.put('torso', SPH(), L.sleeve, { x: -0.185, y: 0.34, z: 0.0, sx: 0.082, sy: 0.078, sz: 0.085 });
  // 衣领 / 下摆
  B.put('torso', CYL(), L.trim, { y: 0.40, sx: 0.075, sy: 0.035, sz: 0.062 });
  B.put('torso', SPH(), L.trim, { y: 0.02, z: -0.10, sx: 0.13, sy: 0.03, sz: 0.04 });
  // 脖子与头
  B.put('torso', CYL(), L.skin, { y: 0.42, sx: 0.058, sy: 0.07, sz: 0.058 });
  const head = B.node('head', 'torso', 0, 0.50, 0);

  // ---------------- 头部 ----------------
  B.put('head', SPH_HI(), L.skin, { y: 0.13, sx: 0.145, sy: 0.155, sz: 0.142 });
  // 耳朵
  B.put('head', SPH(), L.skin, { x: 0.142, y: 0.12, z: 0.005, sx: 0.032, sy: 0.048, sz: 0.03 });
  B.put('head', SPH(), L.skin, { x: -0.142, y: 0.12, z: 0.005, sx: 0.032, sy: 0.048, sz: 0.03 });
  // 眼睛（白 + 深色虹膜 + 高光）
  addEyes(B, 'head', { y: 0.155, z: -0.118, spread: 0.056, r: 0.034, style: 'full', white: 0xfffdf8, iris: 0x3a2a20, pupil: 0x241c14, wz: 0.5, hiR: 0.28 });
  // 眉毛
  B.put('head', SPH(), L.hair, { x: 0.058, y: 0.215, z: -0.115, sx: 0.038, sy: 0.010, sz: 0.014, rz: id === 't_ember' ? 0.18 : 0.05 });
  B.put('head', SPH(), L.hair, { x: -0.058, y: 0.215, z: -0.115, sx: 0.038, sy: 0.010, sz: 0.014, rz: id === 't_ember' ? -0.18 : -0.05 });
  // 鼻子 / 嘴 / 腮红
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
  // 手套
  B.put('armL', CYL(), L.glove, { x: -0.03, y: -0.39, z: -0.02, sx: 0.05, sy: 0.03, sz: 0.046 });
  for (let k = 0; k < 3; k++) {
    B.put('armL', CAPSULE(0.012, 0.045), L.skin, { x: -0.03 + (k - 1) * 0.024, y: -0.485, z: -0.03, rz: (k - 1) * 0.16 });
  }

  // ---------------- 右臂（前举握着武器） ----------------
  const armR = B.node('armR', 'torso', 0.205, 0.36, 0);
  // 上臂（袖）
  B.put('armR', CAPSULE(0.060, 0.13), L.sleeve, { x: 0.022, y: -0.055, z: -0.085, rx: -0.62 });
  B.put('armR', SPH(), L.sleeve, { x: 0.05, y: -0.105, z: -0.165, sx: 0.055, sy: 0.055, sz: 0.055 });
  // 前臂（皮肤）
  B.put('armR', CAPSULE(0.048, 0.15), L.skin, { x: 0.042, y: -0.085, z: -0.29, rx: -1.32 });
  // 手腕 / 手套
  B.put('armR', CYL(), L.glove, { x: 0.038, y: -0.05, z: -0.395, sx: 0.05, sy: 0.026, sz: 0.048, rx: -1.2 });
  // 手
  B.put('armR', SPH(), L.skin, { x: 0.034, y: -0.025, z: -0.44, sx: 0.058, sy: 0.048, sz: 0.068 });
  // 手指（向前握住枪柄）
  for (let k = 0; k < 3; k++) {
    B.put('armR', CAPSULE(0.013, 0.045), L.skin, {
      x: 0.034 + (k - 1) * 0.026, y: -0.005, z: -0.49, rx: -PI / 2 + 0.25, rz: (k - 1) * 0.12,
    });
  }
  // 挂载点：90-main 可把武器挂到这里（跟随手臂动画）
  const anchor = new T3.Object3D();
  anchor.name = 'handAnchor';
  anchor.position.set(0.034, -0.02, -0.50);
  armR.add(anchor);

  // ---------------- 发型与专属配饰 ----------------
  if (id === 't_bolt') {
    // 雷恩：黄黑棒球帽 + 耳边短发 + 胸前闪电徽章
    B.put('head', HEMI(), L.top, { y: 0.175, z: 0.01, sx: 0.152, sy: 0.125, sz: 0.152 });
    B.put('head', TORUS(0.148, 0.020, TAU), L.hair, { y: 0.155, z: 0.01, rx: PI / 2 });
    // 帽檐（向前）
    B.put('head', SPH(), L.hair, { y: 0.155, z: -0.145, sx: 0.135, sy: 0.024, sz: 0.105, rx: -0.12 });
    // 帽子上的闪电小标
    B.put('head', CONE(), L.hair, { y: 0.225, z: -0.135, sx: 0.02, sy: 0.05, sz: 0.012, rz: 0.3, rx: -0.5 });
    // 耳边短发
    B.put('head', SPH(), L.hair, { x: 0.125, y: 0.075, z: 0.0, sx: 0.035, sy: 0.06, sz: 0.05 });
    B.put('head', SPH(), L.hair, { x: -0.125, y: 0.075, z: 0.0, sx: 0.035, sy: 0.06, sz: 0.05 });
    B.put('head', SPH(), L.hair, { y: 0.155, z: 0.095, sx: 0.10, sy: 0.07, sz: 0.055 });
    // 运动服：白色肩条 + 黑色闪电胸标 + 号码条
    B.put('torso', SPH(), L.trim, { x: 0.135, y: 0.315, z: -0.075, sx: 0.03, sy: 0.075, sz: 0.04, rz: -0.4 });
    B.put('torso', SPH(), L.trim, { x: -0.135, y: 0.315, z: -0.075, sx: 0.03, sy: 0.075, sz: 0.04, rz: 0.4 });
    B.put('torso', boltGeo(0.10, 0.012), L.hair, { y: 0.30, z: -0.128, sx: 0.75, sy: 0.75, sz: 1 });
    B.put('torso', SPH(), L.sleeve, { y: 0.14, z: -0.117, sx: 0.10, sy: 0.022, sz: 0.02 });
  } else if (id === 't_leaf') {
    // 芽衣：绿色斗篷 + 棕色双马尾 + 叶形发夹
    B.put('head', SPH(), L.hair, { y: 0.185, z: 0.02, sx: 0.150, sy: 0.115, sz: 0.150 });
    B.put('head', SPH(), L.hair, { y: 0.155, z: -0.085, sx: 0.135, sy: 0.085, sz: 0.085 });
    // 刘海
    B.put('head', SPH(), L.hair, { x: 0.06, y: 0.16, z: -0.115, sx: 0.06, sy: 0.07, sz: 0.045, rz: -0.25 });
    B.put('head', SPH(), L.hair, { x: -0.06, y: 0.16, z: -0.115, sx: 0.06, sy: 0.07, sz: 0.045, rz: 0.25 });
    // 双马尾
    const hairL = B.node('hairL', 'head', -0.145, 0.15, 0.02);
    const hairR = B.node('hairR', 'head', 0.145, 0.15, 0.02);
    capChain(B, 'hairL', [[-0.01, 0.02, 0.0], [-0.035, -0.10, 0.03], [-0.03, -0.24, 0.06], [-0.015, -0.34, 0.05]], [0.045, 0.038, 0.028, 0.016], L.hair);
    capChain(B, 'hairR', [[0.01, 0.02, 0.0], [0.035, -0.10, 0.03], [0.03, -0.24, 0.06], [0.015, -0.34, 0.05]], [0.045, 0.038, 0.028, 0.016], L.hair);
    B.put('hairL', SPH(), 0xffe9b8, { y: 0.06, z: 0.01, sx: 0.035, sy: 0.022, sz: 0.032 });
    B.put('hairR', SPH(), 0xffe9b8, { y: 0.06, z: 0.01, sx: 0.035, sy: 0.022, sz: 0.032 });
    // 叶形发夹
    B.put('head', leafGeo(0.035, 0.085, 0.012), L.sleeve, { x: 0.13, y: 0.19, z: -0.06, rx: -0.4, rz: -0.75 });
    // 斗篷（可摆动）
    const cape = B.node('cape', 'torso', 0, 0.34, 0.035);
    B.put('cape', CONE(), L.top, { y: -0.13, z: 0.02, sx: 0.245, sy: 0.38, sz: 0.22 });
    B.put('cape', SPH(), L.top, { y: 0.03, z: 0.02, sx: 0.18, sy: 0.09, sz: 0.17 });
    B.put('cape', TORUS(0.185, 0.02, TAU), L.trim, { y: -0.315, rx: PI / 2, sz: 0.9 });
    // 兜帽
    B.put('torso', SPH(), L.top, { y: 0.43, z: 0.09, sx: 0.10, sy: 0.085, sz: 0.09 });
    B.put('torso', SPH(), L.sleeve, { y: 0.30, z: 0.14, sx: 0.16, sy: 0.13, sz: 0.055 });
    // 胸前衣扣
    B.put('torso', SPH(), L.trim, { y: 0.22, z: -0.13, sx: 0.014, sy: 0.014, sz: 0.01, shine: true });
    B.put('torso', SPH(), L.trim, { y: 0.12, z: -0.128, sx: 0.014, sy: 0.014, sz: 0.01, shine: true });
    // 短裙下摆
    B.put('torso', CONE(), L.top, { y: -0.02, z: 0.0, sx: 0.24, sy: 0.20, sz: 0.19 });
  } else if (id === 't_ember') {
    // 炎武：橙红夹克 + 竖立高领 + 蓬乱短发 + 半指手套
    B.put('head', SPH(), L.hair, { y: 0.20, z: 0.02, sx: 0.148, sy: 0.10, sz: 0.148 });
    // 蓬乱尖发
    B.put('head', CONE(), L.hair, { x: 0.0, y: 0.28, z: -0.02, sx: 0.055, sy: 0.16, sz: 0.05, rx: -0.25 });
    B.put('head', CONE(), L.hair, { x: 0.09, y: 0.26, z: 0.02, sx: 0.045, sy: 0.13, sz: 0.04, rz: -0.55, rx: -0.2 });
    B.put('head', CONE(), L.hair, { x: -0.09, y: 0.26, z: 0.02, sx: 0.045, sy: 0.13, sz: 0.04, rz: 0.55, rx: -0.2 });
    B.put('head', CONE(), L.hair, { x: 0.15, y: 0.20, z: 0.03, sx: 0.035, sy: 0.10, sz: 0.035, rz: -1.0 });
    B.put('head', CONE(), L.hair, { x: -0.15, y: 0.20, z: 0.03, sx: 0.035, sy: 0.10, sz: 0.035, rz: 1.0 });
    B.put('head', CONE(), 0xb8302a, { x: 0.035, y: 0.235, z: -0.09, sx: 0.032, sy: 0.10, sz: 0.03, rx: -0.7, rz: -0.2 });
    // 刘海
    B.put('head', SPH(), L.hair, { x: 0.055, y: 0.175, z: -0.115, sx: 0.06, sy: 0.055, sz: 0.045, rz: -0.3 });
    B.put('head', SPH(), L.hair, { x: -0.055, y: 0.175, z: -0.115, sx: 0.06, sy: 0.055, sz: 0.045, rz: 0.3 });
    // 高领（橙红）
    B.put('torso', CYL(), L.trim, { y: 0.415, sx: 0.115, sy: 0.075, sz: 0.10 });
    B.put('torso', CYL(), L.top, { y: 0.435, sx: 0.10, sy: 0.03, sz: 0.088 });
    // 夹克拉链 + 下摆 + 橙色肩线
    B.put('torso', SPH(), L.trim, { y: 0.20, z: -0.132, sx: 0.012, sy: 0.20, sz: 0.012, shine: true });
    B.put('torso', SPH(), L.trim, { y: 0.03, z: -0.10, sx: 0.14, sy: 0.028, sz: 0.04 });
    B.put('torso', SPH(), L.trim, { x: 0.15, y: 0.33, z: -0.05, sx: 0.035, sy: 0.06, sz: 0.045, rz: -0.5 });
    B.put('torso', SPH(), L.trim, { x: -0.15, y: 0.33, z: -0.05, sx: 0.035, sy: 0.06, sz: 0.045, rz: 0.5 });
    // 胸口火焰徽章
    B.put('torso', CONE(), L.trim, { y: 0.26, z: -0.13, sx: 0.028, sy: 0.075, sz: 0.012, rx: 0.15 });
    B.put('torso', CONE(), 0xffd93d, { y: 0.24, z: -0.138, sx: 0.018, sy: 0.045, sz: 0.01, rx: 0.15 });
  } else {
    // 波琳：蓝色潜水服 + 青蓝条纹 + 头戴泳镜 + 马尾
    B.put('head', SPH(), L.hair, { y: 0.19, z: 0.025, sx: 0.148, sy: 0.11, sz: 0.148 });
    // 泳镜（额头上，青蓝镜片 + 深色束带）
    B.put('head', CYL(), L.trim, { x: 0.052, y: 0.235, z: -0.105, sx: 0.045, sy: 0.018, sz: 0.035, rx: PI / 2 - 0.35, shine: true });
    B.put('head', CYL(), L.trim, { x: -0.052, y: 0.235, z: -0.105, sx: 0.045, sy: 0.018, sz: 0.035, rx: PI / 2 - 0.35, shine: true });
    B.put('head', TORUS(0.142, 0.016, TAU), 0x1b3f6b, { y: 0.235, rx: PI / 2 + 0.14 });
    // 后马尾（可摆动）
    const pony = B.node('pony', 'head', 0, 0.155, 0.13);
    capChain(B, 'pony', [[0, 0.02, 0], [0, 0.10, 0.10], [0.01, 0.10, 0.22], [0.015, 0.0, 0.31], [0, -0.10, 0.34]], [0.05, 0.042, 0.032, 0.022, 0.012], L.hair);
    B.put('pony', TORUS(0.042, 0.012, TAU), L.trim, { y: 0.035, z: 0.02, rx: PI / 2 + 0.5 });
    // 刘海
    B.put('head', SPH(), L.hair, { x: 0.06, y: 0.17, z: -0.115, sx: 0.06, sy: 0.06, sz: 0.045, rz: -0.3 });
    B.put('head', SPH(), L.hair, { x: -0.06, y: 0.17, z: -0.115, sx: 0.06, sy: 0.06, sz: 0.045, rz: 0.3 });
    // 潜水服：青蓝条纹 + 拉链 + 腰带 + 小气瓶
    B.put('torso', SPH(), L.trim, { y: 0.22, z: -0.115, sx: 0.012, sy: 0.22, sz: 0.012, shine: true });
    B.put('torso', SPH(), L.trim, { x: 0.16, y: 0.22, z: -0.06, sx: 0.022, sy: 0.17, sz: 0.035 });
    B.put('torso', SPH(), L.trim, { x: -0.16, y: 0.22, z: -0.06, sx: 0.022, sy: 0.17, sz: 0.035 });
    B.put('torso', CYL(), L.sole, { y: 0.045, sx: 0.168, sy: 0.045, sz: 0.125 });
    B.put('torso', CYL(), L.trim, { x: 0.145, y: 0.045, z: 0.045, sx: 0.035, sy: 0.09, sz: 0.035, shine: true });
    B.put('torso', SPH(), L.trim, { x: 0.155, y: 0.10, z: 0.045, sx: 0.04, sy: 0.04, sz: 0.04, shine: true });
    // 肩部/膝盖条纹
    B.put('root', SPH(), L.trim, { x: 0.105, y: 0.62, z: -0.05, sx: 0.06, sy: 0.016, sz: 0.02 });
    B.put('root', SPH(), L.trim, { x: -0.105, y: 0.62, z: -0.05, sx: 0.06, sy: 0.016, sz: 0.02 });
  }

  // ---------------- 待机动画 ----------------
  const anim = function (nodes, dt, t) {
    const br = Math.sin(t * 1.55);
    nodes.torso.scale.y = 1 + br * 0.010;
    nodes.torso.rotation.z = Math.sin(t * 0.62) * 0.012;
    nodes.head.rotation.x = Math.sin(t * 0.95) * 0.028;
    nodes.head.rotation.y = Math.sin(t * 0.48 + 1.2) * 0.07;
    // 持枪手保持稳定，只有一两毫米的呼吸位移
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
  };

  return finishModel(B, anim);
}

// ===========================================================================
// 10. 模板缓存与实例化
// ===========================================================================
const POKEMON_BUILDERS = {
  pikachu: buildPikachu, bulbasaur: buildBulbasaur, charmander: buildCharmander, squirtle: buildSquirtle,
  caterpie: buildCaterpie, weedle: buildWeedle, pidgey: buildPidgey, oddish: buildOddish,
  beedrill: buildBeedrill, scyther: buildScyther, gastly: buildGastly, gengar: buildGengar,
  snorlax: buildSnorlax, mewtwo: buildMewtwo, onix: buildOnix, meowth: buildMeowth,
  jigglypuff: buildJigglypuff, psyduck: buildPsyduck,
};
const TEMPLATES = new Map();

function getTemplate(id) {
  let tpl = TEMPLATES.get(id);
  if (tpl) return tpl;
  if (!T3) throw new Error('PG.models: THREE 未加载，无法构建 3D 模型');
  const isTrainer = !!TRAINER_LOOKS[id];
  const fn = isTrainer ? buildTrainer : POKEMON_BUILDERS[id];
  if (!fn) throw new Error('PG.models: 未知模型 id "' + id + '"');
  tpl = fn(id);
  tpl.group.name = (isTrainer ? 'trainer_' : 'model_') + id;
  tpl.group.userData.modelId = id;
  TEMPLATES.set(id, tpl);
  return tpl;
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

function makePokemon(id) {
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
// 11. 2D 手绘工具（统一在 0..1 单位空间绘制，天然适配任意 size）
// ===========================================================================
function mkCanvas(size) {
  const s = Math.max(16, Math.round(size || 128));
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const g = c.getContext('2d');
  g.scale(s, s);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  return { canvas: c, g: g, size: s };
}
function cCir(g, x, y, r, fill, stroke, lw) {
  g.beginPath(); g.arc(x, y, Math.abs(r), 0, TAU);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
}
function cEll(g, x, y, rx, ry, rot, fill, stroke, lw) {
  g.beginPath(); g.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot || 0, 0, TAU);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
}
function cShp(g, pts, fill, stroke, lw) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
}
function cRR(g, x, y, w, h, r, fill, stroke, lw) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
}
function cLin(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
  return gr;
}
function cRad(g, x, y, r0, r1, stops) {
  const gr = g.createRadialGradient(x, y, r0, x, y, r1);
  for (let i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
  return gr;
}
function cSpark(g, x, y, r, color) {
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
  g.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
  g.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
  g.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
  g.closePath();
  g.fillStyle = color || '#ffffff';
  g.fill();
}
// 2D 卡通眼睛：眼白 + 虹膜 + 瞳孔 + 两处高光
function cEye(g, x, y, r, white, iris, pupil) {
  cEll(g, x, y, r, r * 1.08, 0, white || '#fffdf6');
  if (iris) cEll(g, x, y + r * 0.10, r * 0.72, r * 0.74, 0, iris);
  if (pupil) cEll(g, x, y + r * 0.14, r * 0.38, r * 0.42, 0, pupil);
  cCir(g, x - r * 0.30, y - r * 0.34, r * 0.30, '#ffffff');
  cCir(g, x + r * 0.28, y + r * 0.30, r * 0.13, 'rgba(255,255,255,.8)');
}
// 2D 微笑弧
function cSmile(g, x, y, r, color, lw) {
  g.beginPath();
  g.arc(x, y, r, PI * 0.18, PI * 0.82);
  g.lineWidth = lw || 0.015;
  g.strokeStyle = color || '#5a3a2a';
  g.stroke();
}
// 图标通用底：渐变底 + 彩色圆盘 + 白环 + 高光
function iconBG(g, base, light) {
  g.fillStyle = cLin(g, 0.15, 0, 0.85, 1, [[0, light], [1, base]]);
  g.fillRect(0, 0, 1, 1);
  g.save();
  g.globalAlpha = 0.16;
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(0, 0.72); g.lineTo(1, 0.18); g.lineTo(1, 0.42); g.lineTo(0, 0.96); g.closePath(); g.fill();
  g.restore();
  g.save();
  g.shadowColor = 'rgba(50,40,20,.22)'; g.shadowBlur = 0.05; g.shadowOffsetY = 0.018;
  cCir(g, 0.5, 0.545, 0.402, '#ffffff');
  g.restore();
  cCir(g, 0.5, 0.545, 0.378, base);
  g.save();
  g.globalAlpha = 0.55;
  cCir(g, 0.5, 0.49, 0.30, cRad(g, 0.46, 0.40, 0.02, 0.36, [[0, '#ffffff'], [1, 'rgba(255,255,255,0)']]));
  g.restore();
  cCir(g, 0.5, 0.545, 0.394, null, '#ffffff', 0.028);
  g.save();
  g.globalAlpha = 0.5;
  g.strokeStyle = '#ffffff'; g.lineWidth = 0.026;
  g.beginPath(); g.arc(0.5, 0.545, 0.345, PI * 1.08, PI * 1.42); g.stroke();
  g.restore();
}

// ===========================================================================
// 12. 宝可梦 2D 图标（HUD 伙伴头像 / 敌人标记）
// ===========================================================================
const ICONS = {};

// 皮卡丘
ICONS.pikachu = function (g) {
  iconBG(g, '#ffe066', '#fff8d0');
  const Y = '#ffd93d', YD = '#e8b520', YL = '#ffe77a', OL = '#a87a10', BLK = '#3a3028', RED = '#e8453c';
  [-1, 1].forEach(function (s) {
    g.save();
    g.translate(0.5 + s * 0.155, 0.40);
    g.rotate(s * 0.36);
    g.beginPath();
    g.moveTo(-0.055, 0.03);
    g.quadraticCurveTo(-0.09, -0.13, -0.032, -0.275);
    g.quadraticCurveTo(0.022, -0.15, 0.055, 0.03);
    g.closePath();
    g.fillStyle = cLin(g, -0.05, -0.2, 0.05, 0.03, [[0, YL], [1, Y]]); g.fill();
    g.lineWidth = 0.022; g.strokeStyle = OL; g.stroke();
    g.beginPath();
    g.moveTo(-0.043, -0.135);
    g.quadraticCurveTo(-0.03, -0.245, -0.030, -0.268);
    g.quadraticCurveTo(0.004, -0.175, 0.018, -0.128);
    g.closePath();
    g.fillStyle = BLK; g.fill();
    g.restore();
  });
  cCir(g, 0.5, 0.60, 0.252, cRad(g, 0.43, 0.51, 0.03, 0.36, [[0, YL], [0.55, Y], [1, YD]]), OL, 0.024);
  cCir(g, 0.318, 0.675, 0.062, RED);
  cCir(g, 0.318, 0.675, 0.062, null, '#b02a24', 0.012);
  cCir(g, 0.682, 0.675, 0.062, RED);
  cCir(g, 0.682, 0.675, 0.062, null, '#b02a24', 0.012);
  cCir(g, 0.318, 0.662, 0.014, 'rgba(255,255,255,.65)');
  cCir(g, 0.682, 0.662, 0.014, 'rgba(255,255,255,.65)');
  cEll(g, 0.412, 0.598, 0.037, 0.047, 0, BLK);
  cEll(g, 0.588, 0.598, 0.037, 0.047, 0, BLK);
  cCir(g, 0.399, 0.582, 0.014, '#ffffff');
  cCir(g, 0.575, 0.582, 0.014, '#ffffff');
  cEll(g, 0.5, 0.638, 0.013, 0.009, 0, BLK);
  cSmile(g, 0.456, 0.662, 0.028, '#7a4a2a', 0.012);
  cSmile(g, 0.544, 0.662, 0.028, '#7a4a2a', 0.012);
  g.save(); g.globalAlpha = 0.9;
  cShp(g, [[0.80, 0.16], [0.865, 0.16], [0.82, 0.255], [0.87, 0.255], [0.79, 0.42], [0.815, 0.285], [0.765, 0.285]], '#ffffff');
  g.restore();
};

// 妙蛙种子
ICONS.bulbasaur = function (g) {
  iconBG(g, '#9fe0b8', '#eefff2');
  const GRN = '#8fd0a8', GD = '#5cae7e', GL = '#b8eccb', OL = '#3f7a5c', BULB = '#63b24d', BULBD = '#3f8a37';
  // 花苞
  cCir(g, 0.5, 0.335, 0.155, cRad(g, 0.45, 0.27, 0.02, 0.22, [[0, '#9ade76'], [1, BULB]]), BULBD, 0.02);
  cShp(g, [[0.5, 0.30], [0.435, 0.16], [0.52, 0.245]], '#7ac95a', '#3f8a37', 0.014);
  cShp(g, [[0.5, 0.30], [0.575, 0.17], [0.545, 0.28]], '#7ac95a', '#3f8a37', 0.014);
  cShp(g, [[0.5, 0.30], [0.50, 0.145], [0.545, 0.255]], '#8ed86a', '#3f8a37', 0.014);
  // 耳朵
  cShp(g, [[0.285, 0.50], [0.245, 0.34], [0.36, 0.44]], GD, OL, 0.018);
  cShp(g, [[0.715, 0.50], [0.755, 0.34], [0.64, 0.44]], GD, OL, 0.018);
  // 头
  cCir(g, 0.5, 0.615, 0.245, cRad(g, 0.44, 0.53, 0.03, 0.34, [[0, GL], [0.55, GRN], [1, '#79bd95']]), OL, 0.024);
  // 额头斑点
  cEll(g, 0.40, 0.46, 0.038, 0.026, -0.2, '#4c9a63');
  cEll(g, 0.60, 0.445, 0.03, 0.022, 0.3, '#4c9a63');
  cEll(g, 0.50, 0.425, 0.028, 0.02, 0, '#4c9a63');
  // 眼睛（红虹膜）
  cEye(g, 0.405, 0.60, 0.058, '#fffdf6', '#d05462', '#2a2230');
  cEye(g, 0.595, 0.60, 0.058, '#fffdf6', '#d05462', '#2a2230');
  // 吻部 + 嘴
  cEll(g, 0.5, 0.705, 0.075, 0.045, 0, '#a8e0bd');
  cSmile(g, 0.5, 0.705, 0.055, '#2f5a44', 0.014);
  cCir(g, 0.468, 0.676, 0.008, '#2f5a44');
  cCir(g, 0.532, 0.676, 0.008, '#2f5a44');
  // 腮红
  cEll(g, 0.30, 0.665, 0.032, 0.02, 0, 'rgba(232,69,60,.45)');
  cEll(g, 0.70, 0.665, 0.032, 0.02, 0, 'rgba(232,69,60,.45)');
};

// 小火龙
ICONS.charmander = function (g) {
  iconBG(g, '#ffb464', '#fff0d8');
  const O = '#ff8a3d', OD = '#e2642a', OL = '#a8401a', CREAM = '#ffe2b0';
  // 尾巴火焰
  g.save();
  g.translate(0.79, 0.70);
  g.beginPath();
  g.moveTo(0, 0.16);
  g.bezierCurveTo(-0.10, 0.06, -0.045, -0.06, -0.005, -0.16);
  g.bezierCurveTo(0.005, -0.05, 0.055, 0.02, 0.05, 0.09);
  g.bezierCurveTo(0.09, 0.055, 0.09, 0.12, 0.035, 0.17);
  g.closePath();
  g.fillStyle = cLin(g, 0, -0.16, 0, 0.17, [[0, '#ffd93d'], [0.6, '#ff8a2a'], [1, '#ff5a1a']]);
  g.fill();
  g.restore();
  g.save();
  g.translate(0.795, 0.71);
  g.beginPath();
  g.moveTo(0, 0.10);
  g.bezierCurveTo(-0.04, 0.03, 0.005, -0.03, 0.02, -0.09);
  g.bezierCurveTo(0.05, -0.02, 0.04, 0.06, 0.0, 0.11);
  g.closePath();
  g.fillStyle = '#fff0a0'; g.fill();
  g.restore();
  // 头部
  cCir(g, 0.48, 0.60, 0.248, cRad(g, 0.41, 0.51, 0.03, 0.35, [[0, '#ffbd82'], [0.55, O], [1, OD]]), OL, 0.024);
  cEll(g, 0.465, 0.715, 0.105, 0.062, 0, CREAM);
  // 眼睛（青蓝虹膜）
  cEye(g, 0.395, 0.585, 0.052, '#fffdf6', '#2f9ebd', '#202834');
  cEye(g, 0.575, 0.585, 0.052, '#fffdf6', '#2f9ebd', '#202834');
  // 鼻子
  cCir(g, 0.432, 0.672, 0.008, '#a8401a');
  cCir(g, 0.508, 0.672, 0.008, '#a8401a');
  // 大笑的嘴
  cSmile(g, 0.46, 0.695, 0.045, '#8a3a24', 0.014);
  cCir(g, 0.285, 0.655, 0.028, 'rgba(255,150,120,.5)');
  cCir(g, 0.675, 0.655, 0.028, 'rgba(255,150,120,.5)');
};

// 杰尼龟
ICONS.squirtle = function (g) {
  iconBG(g, '#8fd8ff', '#e8f8ff');
  const B = '#7fc7f5', BD = '#4f9fd8', OL = '#2f6f9e', SHELL = '#a96a3c', SHELLD = '#82502c', CREAM = '#ffe9b8';
  // 龟壳（头后）
  cCir(g, 0.5, 0.60, 0.245, cRad(g, 0.44, 0.48, 0.03, 0.32, [[0, '#c98a54'], [1, SHELL]]), SHELLD, 0.02);
  cCir(g, 0.5, 0.60, 0.245, null, CREAM, 0.034);
  g.save(); g.globalAlpha = 0.5; g.strokeStyle = SHELLD; g.lineWidth = 0.016;
  g.beginPath(); g.arc(0.5, 0.60, 0.17, -0.2, PI + 0.2); g.stroke();
  g.restore();
  // 头
  cCir(g, 0.5, 0.615, 0.215, cRad(g, 0.43, 0.535, 0.03, 0.30, [[0, '#bfe8ff'], [0.55, B], [1, BD]]), OL, 0.024);
  cEll(g, 0.5, 0.695, 0.078, 0.045, 0, '#a8dcff');
  // 眼睛（棕色虹膜）
  cEye(g, 0.418, 0.59, 0.054, '#fffdf6', '#9a5a42', '#241d20');
  cEye(g, 0.582, 0.59, 0.054, '#fffdf6', '#9a5a42', '#241d20');
  // 鼻孔
  cCir(g, 0.474, 0.668, 0.007, '#2f6f9e');
  cCir(g, 0.526, 0.668, 0.007, '#2f6f9e');
  // 嘴角
  cSmile(g, 0.5, 0.695, 0.05, '#2f6f9e', 0.014);
  // 小爪
  cCir(g, 0.245, 0.79, 0.055, B, OL, 0.018);
  cCir(g, 0.755, 0.79, 0.055, B, OL, 0.018);
  cCir(g, 0.245, 0.93, 0.06, CREAM, '#c9a870', 0.016);
  cCir(g, 0.755, 0.93, 0.06, CREAM, '#c9a870', 0.016);
};

// 绿毛虫
ICONS.caterpie = function (g) {
  iconBG(g, '#b8e05a', '#f0ffcf');
  const GRN = '#a8d84a', GD = '#7fb52f', Y = '#ffe14d', OL = '#4f7a1a', RED = '#e8453c';
  // 身后的身体节
  cCir(g, 0.79, 0.79, 0.115, GD, OL, 0.02);
  cCir(g, 0.70, 0.70, 0.10, GRN, OL, 0.018);
  cCir(g, 0.63, 0.64, 0.085, GD, OL, 0.016);
  cEll(g, 0.79, 0.775, 0.032, 0.05, 0, Y);
  cEll(g, 0.70, 0.69, 0.028, 0.045, 0, Y);
  // 大圆头
  cCir(g, 0.46, 0.565, 0.225, cRad(g, 0.39, 0.48, 0.03, 0.31, [[0, '#c8ec6a'], [0.55, GRN], [1, GD]]), OL, 0.024);
  // 红色触角
  g.strokeStyle = RED; g.lineWidth = 0.026;
  g.beginPath(); g.moveTo(0.46, 0.35); g.quadraticCurveTo(0.47, 0.26, 0.44, 0.20); g.stroke();
  cCir(g, 0.44, 0.19, 0.032, RED, '#a82a24', 0.012);
  // 大眼（白底黑瞳）
  cEye(g, 0.375, 0.545, 0.072, '#fffdf0', '#2a2a30', '#2a2a30');
  cEye(g, 0.545, 0.545, 0.072, '#fffdf0', '#2a2a30', '#2a2a30');
  // 嘴 + 腮
  cSmile(g, 0.46, 0.665, 0.035, '#3a5a24', 0.012);
  cEll(g, 0.315, 0.625, 0.026, 0.016, 0, 'rgba(255,150,150,.5)');
  cEll(g, 0.605, 0.625, 0.026, 0.016, 0, 'rgba(255,150,150,.5)');
};

// 独角虫
ICONS.weedle = function (g) {
  iconBG(g, '#f0dca0', '#fffbe8');
  const T = '#e8d38a', TD = '#cdb26a', OL = '#8a6a2a', RED = '#e8654f', CREAM = '#fff3cf';
  // 身体节 + 尾针
  cCir(g, 0.80, 0.78, 0.105, TD, OL, 0.018);
  cCir(g, 0.72, 0.68, 0.09, T, OL, 0.016);
  cShp(g, [[0.86, 0.72], [1.0, 0.60], [0.90, 0.66]], CREAM, OL, 0.012);
  // 头（圆 + 尖鼻）
  cCir(g, 0.46, 0.60, 0.215, cRad(g, 0.39, 0.51, 0.03, 0.30, [[0, '#f7e7b0'], [0.55, T], [1, TD]]), OL, 0.024);
  cShp(g, [[0.28, 0.60], [0.17, 0.665], [0.30, 0.70]], T, OL, 0.016);
  // 大红角
  cShp(g, [[0.50, 0.40], [0.545, 0.20], [0.60, 0.395]], RED, '#a82a24', 0.016);
  cCir(g, 0.548, 0.195, 0.026, RED, '#a82a24', 0.01);
  // 大黑眼
  cEye(g, 0.385, 0.575, 0.068, '#fffdf0', '#2a2a30', '#2a2a30');
  cEye(g, 0.545, 0.575, 0.068, '#fffdf0', '#2a2a30', '#2a2a30');
  // 嘴 + 腮红
  cEll(g, 0.44, 0.68, 0.036, 0.012, 0, '#8a5a3a');
  cEll(g, 0.30, 0.645, 0.024, 0.015, 0, 'rgba(255,140,120,.55)');
  cEll(g, 0.62, 0.645, 0.024, 0.015, 0, 'rgba(255,140,120,.55)');
};

// 波波
ICONS.pidgey = function (g) {
  iconBG(g, '#c8dcff', '#eef6ff');
  const BRN = '#c99a5b', BRD = '#a87a3f', OL = '#6a4a22', CREAM = '#ffe9b0', PINK = '#f2a89e';
  // 冠羽（三片）
  cShp(g, [[0.40, 0.42], [0.34, 0.18], [0.475, 0.385]], CREAM, OL, 0.016);
  cShp(g, [[0.50, 0.40], [0.52, 0.14], [0.585, 0.375]], CREAM, OL, 0.016);
  cShp(g, [[0.60, 0.42], [0.70, 0.22], [0.655, 0.44]], CREAM, OL, 0.016);
  // 身体
  cCir(g, 0.5, 0.625, 0.235, cRad(g, 0.42, 0.53, 0.03, 0.32, [[0, '#e2bb82'], [0.55, BRN], [1, BRD]]), OL, 0.024);
  // 奶油肚皮
  cEll(g, 0.5, 0.735, 0.115, 0.10, 0, CREAM);
  // 眼罩条纹
  cEll(g, 0.395, 0.575, 0.062, 0.026, -0.22, BRD);
  cEll(g, 0.605, 0.575, 0.062, 0.026, 0.22, BRD);
  // 眼
  cEll(g, 0.405, 0.585, 0.034, 0.042, 0, '#3a2a22');
  cEll(g, 0.595, 0.585, 0.034, 0.042, 0, '#3a2a22');
  cCir(g, 0.395, 0.571, 0.012, '#ffffff');
  cCir(g, 0.585, 0.571, 0.012, '#ffffff');
  // 粉色喙
  cShp(g, [[0.5, 0.615], [0.44, 0.665], [0.5, 0.695], [0.56, 0.665]], PINK, '#b06a5f', 0.014);
  // 脚
  g.strokeStyle = PINK; g.lineWidth = 0.022;
  g.beginPath(); g.moveTo(0.43, 0.86); g.lineTo(0.415, 0.925); g.moveTo(0.43, 0.92); g.lineTo(0.40, 0.95); g.moveTo(0.43, 0.92); g.lineTo(0.46, 0.95); g.stroke();
  g.beginPath(); g.moveTo(0.57, 0.86); g.lineTo(0.585, 0.925); g.moveTo(0.57, 0.92); g.lineTo(0.60, 0.95); g.moveTo(0.57, 0.92); g.lineTo(0.54, 0.95); g.stroke();
};

// 走路草
ICONS.oddish = function (g) {
  iconBG(g, '#8f9ede', '#e8ecff');
  const BLU = '#5c6bb0', BLD = '#46538f', LEAF = '#53a83c', LEAFD = '#3d8a2b', OL = '#2a3560';
  // 五片叶子
  const leaves = [[-0.30, 0.0, -0.9], [-0.15, -0.05, -0.45], [0, -0.06, 0], [0.15, -0.05, 0.45], [0.30, 0.0, 0.9]];
  for (let i = 0; i < leaves.length; i++) {
    const d = leaves[i];
    g.save();
    g.translate(0.5 + d[0], 0.36);
    g.rotate(d[2]);
    g.beginPath();
    g.moveTo(0, 0.05);
    g.quadraticCurveTo(-0.075, -0.10, 0, -0.24);
    g.quadraticCurveTo(0.075, -0.10, 0, 0.05);
    g.closePath();
    g.fillStyle = i % 2 === 0 ? LEAF : LEAFD;
    g.fill();
    g.lineWidth = 0.016; g.strokeStyle = '#2c6420'; g.stroke();
    g.restore();
  }
  // 脚
  cCir(g, 0.36, 0.83, 0.055, BLD, OL, 0.014);
  cCir(g, 0.64, 0.83, 0.055, BLD, OL, 0.014);
  // 身体
  cCir(g, 0.5, 0.60, 0.225, cRad(g, 0.43, 0.52, 0.03, 0.31, [[0, '#7a89c8'], [0.55, BLU], [1, BLD]]), OL, 0.024);
  // 眼睛（红虹膜）
  cEye(g, 0.415, 0.585, 0.056, '#fffdf6', '#d84a4a', '#2a1a1a');
  cEye(g, 0.585, 0.585, 0.056, '#fffdf6', '#d84a4a', '#2a1a1a');
  // 呆萌小嘴 + 眼睑
  cSmile(g, 0.5, 0.665, 0.036, '#2a2a48', 0.012);
  cEll(g, 0.415, 0.515, 0.05, 0.013, -0.1, '#46538f');
  cEll(g, 0.585, 0.515, 0.05, 0.013, 0.1, '#46538f');
};

// 大针蜂
ICONS.beedrill = function (g) {
  iconBG(g, '#ffd23d', '#fff6cf');
  const Y = '#ffd23d', YD = '#e8b020', BLK = '#2c2a2e', OL = '#5a4400', RED = '#e8453c', CREAM = '#fff6e0';
  // 薄翅
  g.save(); g.globalAlpha = 0.55;
  cEll(g, 0.27, 0.36, 0.14, 0.075, -0.55, '#e8f6ff', '#a8c8e0', 0.012);
  cEll(g, 0.73, 0.36, 0.14, 0.075, 0.55, '#e8f6ff', '#a8c8e0', 0.012);
  g.restore();
  // 触角
  g.strokeStyle = BLK; g.lineWidth = 0.018;
  g.beginPath(); g.moveTo(0.42, 0.38); g.quadraticCurveTo(0.34, 0.28, 0.30, 0.22); g.stroke();
  g.beginPath(); g.moveTo(0.58, 0.38); g.quadraticCurveTo(0.66, 0.28, 0.70, 0.22); g.stroke();
  cCir(g, 0.30, 0.21, 0.022, BLK);
  cCir(g, 0.70, 0.21, 0.022, BLK);
  // 头部黄底
  cCir(g, 0.5, 0.535, 0.20, cRad(g, 0.43, 0.46, 0.03, 0.28, [[0, '#ffe98a'], [0.55, Y], [1, YD]]), OL, 0.022);
  // 巨大红复眼
  cEll(g, 0.385, 0.525, 0.085, 0.105, -0.12, cLin(g, 0.32, 0.45, 0.43, 0.62, [[0, '#ff8a7a'], [0.5, RED], [1, '#a82a24']]), '#8a1f1a', 0.016);
  cEll(g, 0.615, 0.525, 0.085, 0.105, 0.12, cLin(g, 0.68, 0.45, 0.57, 0.62, [[0, '#ff8a7a'], [0.5, RED], [1, '#a82a24']]), '#8a1f1a', 0.016);
  cCir(g, 0.355, 0.48, 0.024, 'rgba(255,255,255,.8)');
  cCir(g, 0.585, 0.48, 0.024, 'rgba(255,255,255,.8)');
  // 口器
  cShp(g, [[0.46, 0.685], [0.50, 0.78], [0.54, 0.685]], CREAM, OL, 0.012);
  // 胸腹黄黑条纹
  cRR(g, 0.36, 0.755, 0.28, 0.15, 0.07, Y, OL, 0.016);
  g.fillStyle = BLK;
  g.fillRect(0.375, 0.805, 0.25, 0.028);
  g.fillRect(0.395, 0.855, 0.21, 0.026);
  // 白色双针
  cShp(g, [[0.20, 0.84], [0.07, 0.68], [0.17, 0.905]], CREAM, OL, 0.016);
  cShp(g, [[0.80, 0.84], [0.93, 0.68], [0.83, 0.905]], CREAM, OL, 0.016);
};



// 飞天螳螂
ICONS.scyther = function (g) {
  iconBG(g, '#a8dc5a', '#efffcf');
  const GRN = '#8ed04a', GRD = '#63a632', OL = '#3f6a14', CREAM = '#fff7dc', WING = '#e0f4ff';
  // 半透明翅膀
  g.save(); g.globalAlpha = 0.5;
  cEll(g, 0.25, 0.32, 0.15, 0.06, -0.7, WING, '#a8c8e0', 0.012);
  cEll(g, 0.75, 0.32, 0.15, 0.06, 0.7, WING, '#a8c8e0', 0.012);
  g.restore();
  // 双镰刀（背后交叉）
  const blade = function (s) {
    g.save();
    g.translate(0.5 + s * 0.30, 0.50);
    g.rotate(s * -0.45);
    g.beginPath();
    g.moveTo(s * -0.02, 0.22);
    g.quadraticCurveTo(s * 0.10, -0.02, s * 0.02, -0.26);
    g.quadraticCurveTo(s * -0.055, 0.0, s * -0.03, 0.20);
    g.closePath();
    g.fillStyle = CREAM; g.fill();
    g.lineWidth = 0.018; g.strokeStyle = '#a89050'; g.stroke();
    g.restore();
  };
  blade(-1); blade(1);
  // 头
  cCir(g, 0.5, 0.565, 0.215, cRad(g, 0.43, 0.48, 0.03, 0.30, [[0, '#b8ee78'], [0.55, GRN], [1, GRD]]), OL, 0.024);
  // 尖鼻
  cShp(g, [[0.5, 0.60], [0.40, 0.72], [0.60, 0.72]], GRD, OL, 0.016);
  // 触角
  g.strokeStyle = GRD; g.lineWidth = 0.018;
  g.beginPath(); g.moveTo(0.40, 0.40); g.quadraticCurveTo(0.30, 0.26, 0.24, 0.22); g.stroke();
  g.beginPath(); g.moveTo(0.60, 0.40); g.quadraticCurveTo(0.70, 0.26, 0.76, 0.22); g.stroke();
  // 头冠尖
  cShp(g, [[0.47, 0.37], [0.50, 0.29], [0.545, 0.375]], GRD, OL, 0.014);
  // 眼睛（细长）
  cEll(g, 0.405, 0.55, 0.038, 0.055, -0.18, '#fffdf4');
  cEll(g, 0.595, 0.55, 0.038, 0.055, 0.18, '#fffdf4');
  cEll(g, 0.412, 0.555, 0.020, 0.034, -0.18, '#2f3a28');
  cEll(g, 0.588, 0.555, 0.020, 0.034, 0.18, '#2f3a28');
  // 胸前奶油护甲
  cRR(g, 0.40, 0.78, 0.20, 0.12, 0.05, CREAM, '#c9b070', 0.014);
  cRR(g, 0.42, 0.79, 0.16, 0.10, 0.04, CREAM, null, 0);
};

// 鬼斯
ICONS.gastly = function (g) {
  iconBG(g, '#7a55b8', '#e0d4ff');
  const PUR = '#6a42a8', PURD = '#43296e', GAS = '#a77ae0', OL = '#2a1448';
  // 周围瓦斯
  cCir(g, 0.28, 0.72, 0.11, GAS, OL, 0.016);
  cCir(g, 0.755, 0.68, 0.13, GAS, OL, 0.016);
  cCir(g, 0.62, 0.86, 0.085, GAS, OL, 0.014);
  cCir(g, 0.33, 0.26, 0.075, GAS, OL, 0.012);
  // 核心
  cCir(g, 0.5, 0.55, 0.215, cRad(g, 0.42, 0.46, 0.03, 0.30, [[0, '#9a6fd8'], [0.6, PUR], [1, PURD]]), OL, 0.024);
  // 白眼
  cEll(g, 0.405, 0.515, 0.062, 0.072, -0.1, '#fffdf4');
  cEll(g, 0.595, 0.515, 0.062, 0.072, 0.1, '#fffdf4');
  cEll(g, 0.418, 0.522, 0.032, 0.042, 0, '#241a33');
  cEll(g, 0.582, 0.522, 0.032, 0.042, 0, '#241a33');
  cCir(g, 0.395, 0.495, 0.017, '#ffffff');
  cCir(g, 0.585, 0.495, 0.017, '#ffffff');
  // 咧嘴 + 两颗獠牙
  g.beginPath();
  g.moveTo(0.36, 0.615);
  g.quadraticCurveTo(0.5, 0.72, 0.64, 0.615);
  g.quadraticCurveTo(0.5, 0.665, 0.36, 0.615);
  g.closePath();
  g.fillStyle = '#2a1c3d'; g.fill();
  cShp(g, [[0.42, 0.63], [0.445, 0.695], [0.465, 0.635]], '#fffdf4');
  cShp(g, [[0.58, 0.63], [0.555, 0.695], [0.535, 0.635]], '#fffdf4');
  // 怒眉
  g.strokeStyle = PURD; g.lineWidth = 0.02;
  g.beginPath(); g.moveTo(0.345, 0.435); g.lineTo(0.435, 0.46); g.stroke();
  g.beginPath(); g.moveTo(0.655, 0.435); g.lineTo(0.565, 0.46); g.stroke();
};

// 耿鬼
ICONS.gengar = function (g) {
  iconBG(g, '#8a5cc8', '#e6d8ff');
  const PUR = '#6b4c9a', PURD = '#4a326e', PURL = '#8a6ab8', OL = '#2a1a44', RED = '#e8453c';
  // 尖耳
  cShp(g, [[0.34, 0.44], [0.18, 0.15], [0.46, 0.38]], PUR, OL, 0.02);
  cShp(g, [[0.66, 0.44], [0.82, 0.15], [0.54, 0.38]], PUR, OL, 0.02);
  // 头
  cCir(g, 0.5, 0.555, 0.225, cRad(g, 0.42, 0.47, 0.03, 0.31, [[0, PURL], [0.55, PUR], [1, PURD]]), OL, 0.024);
  // 红眼
  cEll(g, 0.40, 0.505, 0.058, 0.068, -0.12, RED, '#7a1a1a', 0.012);
  cEll(g, 0.60, 0.505, 0.058, 0.068, 0.12, RED, '#7a1a1a', 0.012);
  cEll(g, 0.408, 0.512, 0.026, 0.034, 0, '#2a0a14');
  cEll(g, 0.592, 0.512, 0.026, 0.034, 0, '#2a0a14');
  cCir(g, 0.385, 0.483, 0.014, '#ffffff');
  cCir(g, 0.585, 0.483, 0.014, '#ffffff');
  // 大咧笑：黑色嘴 + 上下牙齿
  g.beginPath();
  g.moveTo(0.33, 0.62);
  g.quadraticCurveTo(0.5, 0.80, 0.67, 0.62);
  g.quadraticCurveTo(0.5, 0.70, 0.33, 0.62);
  g.closePath();
  g.fillStyle = '#2a1c3d'; g.fill();
  g.fillStyle = '#fffdf2';
  for (let i = 0; i < 5; i++) {
    const x = 0.375 + i * 0.062;
    cShp(g, [[x, 0.628], [x + 0.026, 0.628], [x + 0.013, 0.665]], '#fffdf2');
  }
  for (let i = 0; i < 4; i++) {
    const x = 0.405 + i * 0.062;
    cShp(g, [[x, 0.705], [x + 0.024, 0.705], [x + 0.012, 0.672]], '#fffdf2');
  }
  // 腮部小刺
  cShp(g, [[0.27, 0.62], [0.20, 0.60], [0.265, 0.655]], PURD, OL, 0.01);
  cShp(g, [[0.73, 0.62], [0.80, 0.60], [0.735, 0.655]], PURD, OL, 0.01);
};

// 卡比兽
ICONS.snorlax = function (g) {
  iconBG(g, '#9fc9c0', '#eafff8');
  const TEAL = '#3f6b78', TEALD = '#2f525c', CREAM = '#f2e2b8', CREAMD = '#dcc79a', OL = '#1f3a42';
  // 耳朵
  cShp(g, [[0.235, 0.42], [0.20, 0.24], [0.34, 0.35]], TEAL, OL, 0.018);
  cShp(g, [[0.765, 0.42], [0.80, 0.24], [0.66, 0.35]], TEAL, OL, 0.018);
  // 大头
  cCir(g, 0.5, 0.605, 0.25, cRad(g, 0.42, 0.50, 0.03, 0.34, [[0, '#5d8d9c'], [0.55, TEAL], [1, TEALD]]), OL, 0.024);
  // 米色脸盘
  cEll(g, 0.5, 0.68, 0.165, 0.125, 0, cRad(g, 0.45, 0.62, 0.02, 0.18, [[0, '#fff3d2'], [1, CREAM]]), '#b09a6a', 0.014);
  // 闭眼弧线
  g.strokeStyle = '#2c3a40'; g.lineWidth = 0.022;
  g.beginPath(); g.arc(0.405, 0.635, 0.045, PI * 1.1, PI * 1.9); g.stroke();
  g.beginPath(); g.arc(0.595, 0.635, 0.045, PI * 1.1, PI * 1.9); g.stroke();
  // 小鼻子 + 小嘴
  cEll(g, 0.5, 0.69, 0.022, 0.015, 0, '#8a7650');
  cSmile(g, 0.5, 0.705, 0.038, '#8a7650', 0.014);
  // 下颚肉 + 牙齿
  cEll(g, 0.44, 0.80, 0.035, 0.032, 0, '#ddd0a8');
  cEll(g, 0.56, 0.80, 0.035, 0.032, 0, '#ddd0a8');
  cShp(g, [[0.455, 0.755], [0.47, 0.785], [0.485, 0.755]], '#fffdf2');
  cShp(g, [[0.555, 0.755], [0.54, 0.785], [0.525, 0.755]], '#fffdf2');
  // 睡意的小气泡
  g.save(); g.globalAlpha = 0.8;
  cCir(g, 0.755, 0.30, 0.032, '#ffffff', '#c8dce0', 0.01);
  cCir(g, 0.815, 0.22, 0.020, '#ffffff', '#c8dce0', 0.008);
  g.restore();
};

// 超梦
ICONS.mewtwo = function (g) {
  iconBG(g, '#d8a8e8', '#fff0ff');
  const BODY = '#d9c9ec', BODYD = '#b9a4d8', OL = '#5a4478', PUR = '#8a4fd8';
  // 头侧双冠
  const horn = function (s) {
    g.save();
    g.translate(0.5 + s * 0.115, 0.42);
    g.rotate(s * 0.55);
    g.beginPath();
    g.moveTo(0, 0.05);
    g.quadraticCurveTo(s * 0.02, -0.16, s * 0.03, -0.26);
    g.quadraticCurveTo(s * 0.09, -0.12, s * 0.045, 0.05);
    g.closePath();
    g.fillStyle = BODYD; g.fill();
    g.lineWidth = 0.016; g.strokeStyle = OL; g.stroke();
    g.restore();
  };
  horn(-1); horn(1);
  // 圆头
  cCir(g, 0.5, 0.575, 0.215, cRad(g, 0.43, 0.48, 0.03, 0.30, [[0, '#f0e6fb'], [0.6, BODY], [1, BODYD]]), OL, 0.024);
  // 额头小凸
  cEll(g, 0.5, 0.405, 0.055, 0.035, 0, BODYD, OL, 0.012);
  // 紫色斜眼
  cEll(g, 0.405, 0.55, 0.062, 0.048, -0.22, '#f4eefc', '#8a7aa0', 0.012);
  cEll(g, 0.595, 0.55, 0.062, 0.048, 0.22, '#f4eefc', '#8a7aa0', 0.012);
  cEll(g, 0.415, 0.556, 0.042, 0.036, -0.22, PUR);
  cEll(g, 0.585, 0.556, 0.042, 0.036, 0.22, PUR);
  cEll(g, 0.422, 0.558, 0.020, 0.024, 0, '#231436');
  cEll(g, 0.578, 0.558, 0.020, 0.024, 0, '#231436');
  cCir(g, 0.398, 0.538, 0.012, '#ffffff');
  cCir(g, 0.562, 0.538, 0.012, '#ffffff');
  // 嘴
  cEll(g, 0.5, 0.685, 0.028, 0.008, 0, '#8a7aa0');
  // 脖子
  cRR(g, 0.455, 0.755, 0.09, 0.10, 0.03, BODY, OL, 0.014);
};

// 大岩蛇
ICONS.onix = function (g) {
  iconBG(g, '#b8b0a0', '#f4f0e6');
  const G1 = '#9aa3ab', G2 = '#8b959d', G3 = '#aeb6bd', TAN = '#b8a889', OL = '#4a5058';
  // 岩块串
  const rocks = [
    [0.26, 0.80, 0.135, G2, -0.2],
    [0.33, 0.66, 0.115, G1, 0.3],
    [0.40, 0.535, 0.10, G3, -0.1],
    [0.47, 0.43, 0.09, G2, 0.4],
  ];
  for (let i = 0; i < rocks.length; i++) {
    const r = rocks[i];
    g.save();
    g.translate(r[0], r[1]); g.rotate(r[4]);
    cShp(g, [[-r[2], -r[2] * 0.5], [-r[2] * 0.4, -r[2]], [r[2] * 0.8, -r[2] * 0.6], [r[2], r[2] * 0.4], [r[2] * 0.2, r[2]], [-r[2] * 0.7, r[2] * 0.6]], r[3], OL, 0.016);
    g.restore();
  }
  // 大头（岩块 + 尖角）
  cShp(g, [[0.36, 0.30], [0.45, 0.19], [0.62, 0.22], [0.70, 0.36], [0.64, 0.55], [0.46, 0.57], [0.35, 0.45]], G3, OL, 0.02);
  cShp(g, [[0.46, 0.20], [0.43, 0.06], [0.55, 0.19]], G1, OL, 0.014);
  cShp(g, [[0.62, 0.24], [0.75, 0.13], [0.66, 0.30]], G1, OL, 0.014);
  // 眼睛
  cEll(g, 0.44, 0.375, 0.052, 0.042, 0, '#fffdf4', OL, 0.012);
  cEll(g, 0.585, 0.375, 0.052, 0.042, 0, '#fffdf4', OL, 0.012);
  cEll(g, 0.448, 0.378, 0.024, 0.028, 0, '#3a4048');
  cEll(g, 0.578, 0.378, 0.024, 0.028, 0, '#3a4048');
  cCir(g, 0.432, 0.365, 0.011, '#ffffff');
  cCir(g, 0.562, 0.365, 0.011, '#ffffff');
  // 怒眉 + 嘴
  g.strokeStyle = '#5a636c'; g.lineWidth = 0.024;
  g.beginPath(); g.moveTo(0.385, 0.33); g.lineTo(0.475, 0.35); g.stroke();
  g.beginPath(); g.moveTo(0.645, 0.33); g.lineTo(0.555, 0.35); g.stroke();
  g.fillStyle = '#4a4048';
  g.fillRect(0.44, 0.475, 0.15, 0.028);
};

// 喵喵
ICONS.meowth = function (g) {
  iconBG(g, '#ffe9b0', '#fffbe8');
  const CRM = '#f7e6b0', CRMD = '#dfc98c', OL = '#8a6a2a', BRN = '#8a5a2a', GOLD = '#ffc81a';
  // 耳朵
  cShp(g, [[0.29, 0.46], [0.24, 0.20], [0.44, 0.38]], CRM, OL, 0.018);
  cShp(g, [[0.71, 0.46], [0.76, 0.20], [0.56, 0.38]], CRM, OL, 0.018);
  cShp(g, [[0.30, 0.40], [0.27, 0.25], [0.39, 0.36]], BRN, null, 0);
  cShp(g, [[0.70, 0.40], [0.73, 0.25], [0.61, 0.36]], BRN, null, 0);
  // 头
  cCir(g, 0.5, 0.605, 0.235, cRad(g, 0.43, 0.51, 0.03, 0.32, [[0, '#fff6da'], [0.55, CRM], [1, CRMD]]), OL, 0.024);
  // 额头金币
  cEll(g, 0.5, 0.44, 0.075, 0.055, 0, GOLD, '#b88a00', 0.014);
  cEll(g, 0.5, 0.44, 0.048, 0.033, 0, '#ffe066', '#b88a00', 0.01);
  cEll(g, 0.5, 0.44, 0.022, 0.014, 0, '#ffc81a', null, 0);
  // 眼睛（竖椭圆）
  cEll(g, 0.40, 0.60, 0.046, 0.058, 0, '#2a2430');
  cEll(g, 0.60, 0.60, 0.046, 0.058, 0, '#2a2430');
  cCir(g, 0.388, 0.582, 0.016, '#ffffff');
  cCir(g, 0.588, 0.582, 0.016, '#ffffff');
  // 粉鼻 + 猫嘴
  cShp(g, [[0.5, 0.655], [0.47, 0.675], [0.53, 0.675]], '#f2a0a8', '#b06a70', 0.008);
  cSmile(g, 0.475, 0.685, 0.028, '#5a4432', 0.012);
  cSmile(g, 0.525, 0.685, 0.028, '#5a4432', 0.012);
  // 胡须
  g.strokeStyle = '#4a3a2a'; g.lineWidth = 0.011;
  for (let i = 0; i < 3; i++) {
    const yy = 0.66 + i * 0.026;
    g.beginPath(); g.moveTo(0.30, yy); g.lineTo(0.16, yy - 0.02 + i * 0.02); g.stroke();
    g.beginPath(); g.moveTo(0.70, yy); g.lineTo(0.84, yy - 0.02 + i * 0.02); g.stroke();
  }
};

// 胖丁
ICONS.jigglypuff = function (g) {
  iconBG(g, '#ffc0d8', '#fff0f6');
  const PINK = '#ffb7d0', PINKD = '#f29ab8', PINKL = '#ffd3e2', TEAL = '#3fb8d8', OL = '#b85c80';
  // 耳朵
  cShp(g, [[0.33, 0.45], [0.30, 0.16], [0.47, 0.36]], PINK, OL, 0.018);
  cShp(g, [[0.67, 0.45], [0.70, 0.16], [0.53, 0.36]], PINK, OL, 0.018);
  cShp(g, [[0.345, 0.40], [0.325, 0.22], [0.43, 0.36]], PINKD, null, 0);
  cShp(g, [[0.655, 0.40], [0.675, 0.22], [0.57, 0.36]], PINKD, null, 0);
  // 圆身体
  cCir(g, 0.5, 0.625, 0.245, cRad(g, 0.42, 0.53, 0.03, 0.33, [[0, '#ffe6ef'], [0.5, PINK], [1, PINKD]]), OL, 0.024);
  // 头顶卷毛
  g.beginPath();
  g.arc(0.5, 0.405, 0.055, PI * 1.05, PI * 2.1);
  g.lineWidth = 0.032; g.strokeStyle = PINKD; g.stroke();
  g.beginPath();
  g.moveTo(0.455, 0.40);
  g.quadraticCurveTo(0.47, 0.345, 0.52, 0.355);
  g.lineWidth = 0.026; g.strokeStyle = PINKD; g.stroke();
  // 大蓝眼
  cEll(g, 0.405, 0.61, 0.058, 0.068, 0, '#fffdf8', '#c88a9c', 0.012);
  cEll(g, 0.595, 0.61, 0.058, 0.068, 0, '#fffdf8', '#c88a9c', 0.012);
  cEll(g, 0.405, 0.615, 0.044, 0.054, 0, TEAL);
  cEll(g, 0.595, 0.615, 0.044, 0.054, 0, TEAL);
  cEll(g, 0.405, 0.625, 0.026, 0.034, 0, '#22303c');
  cEll(g, 0.595, 0.625, 0.026, 0.034, 0, '#22303c');
  cCir(g, 0.390, 0.592, 0.018, '#ffffff');
  cCir(g, 0.580, 0.592, 0.018, '#ffffff');
  cCir(g, 0.419, 0.640, 0.008, 'rgba(255,255,255,.85)');
  cCir(g, 0.609, 0.640, 0.008, 'rgba(255,255,255,.85)');
  // 小嘴 + 腮红
  cSmile(g, 0.5, 0.705, 0.022, '#7a3a52', 0.011);
  cEll(g, 0.32, 0.68, 0.036, 0.022, 0, 'rgba(255,120,150,.55)');
  cEll(g, 0.68, 0.68, 0.036, 0.022, 0, 'rgba(255,120,150,.55)');
};

// 可达鸭
ICONS.psyduck = function (g) {
  iconBG(g, '#ffe066', '#fffbd0');
  const Y = '#ffe066', YD = '#e8c44a', OL = '#a8861a', CREAM = '#fff4d2', DARK = '#2a2a34';
  // 抱头的手
  cCir(g, 0.275, 0.545, 0.075, CREAM, '#c9ae70', 0.016);
  cCir(g, 0.725, 0.545, 0.075, CREAM, '#c9ae70', 0.016);
  g.strokeStyle = CREAM; g.lineWidth = 0.05;
  g.beginPath(); g.moveTo(0.22, 0.72); g.quadraticCurveTo(0.26, 0.62, 0.30, 0.56); g.stroke();
  g.beginPath(); g.moveTo(0.78, 0.72); g.quadraticCurveTo(0.74, 0.62, 0.70, 0.56); g.stroke();
  // 头
  cCir(g, 0.5, 0.60, 0.215, cRad(g, 0.43, 0.50, 0.03, 0.30, [[0, '#fff3a8'], [0.55, Y], [1, YD]]), OL, 0.024);
  // 三根呆毛
  g.strokeStyle = DARK; g.lineWidth = 0.02;
  g.beginPath(); g.moveTo(0.5, 0.395); g.quadraticCurveTo(0.49, 0.32, 0.515, 0.29); g.stroke();
  g.beginPath(); g.moveTo(0.545, 0.40); g.quadraticCurveTo(0.565, 0.34, 0.60, 0.32); g.stroke();
  g.beginPath(); g.moveTo(0.455, 0.40); g.quadraticCurveTo(0.435, 0.34, 0.40, 0.32); g.stroke();
  // 奶油色鸭嘴
  cEll(g, 0.5, 0.715, 0.105, 0.045, 0, CREAM, '#c9ae70', 0.016);
  cShp(g, [[0.405, 0.705], [0.595, 0.705], [0.55, 0.765], [0.45, 0.765]], CREAM, '#c9ae70', 0.016);
  // 呆萌大眼（小黑瞳）
  cEye(g, 0.405, 0.585, 0.060, '#fffdf6', '#1f1f26', '#1f1f26');
  cEye(g, 0.595, 0.585, 0.060, '#fffdf6', '#1f1f26', '#1f1f26');
  // 腮红
  cEll(g, 0.30, 0.645, 0.03, 0.018, 0, 'rgba(255,140,110,.5)');
  cEll(g, 0.70, 0.645, 0.03, 0.018, 0, 'rgba(255,140,110,.5)');
};



// ===========================================================================
// 13. 训练家 2D 半身头像（选角界面 / 结算界面用）
// ===========================================================================
const TRAINER_ART = {
  t_bolt:  { skin: '#f2c79f', skinD: '#d8a87e', hair: '#2c2b33', top: '#ffd93d', topD: '#e8b520', sleeve: '#2c2b33', trim: '#ffffff', bg1: '#fff6c8', bg2: '#ffd93d', ring: '#f5b400', symbol: 'bolt' },
  t_leaf:  { skin: '#f3cba8', skinD: '#dbab84', hair: '#7a5230', top: '#4e9c3f', topD: '#3a7a2c', sleeve: '#6fbb4a', trim: '#fff4c8', bg1: '#eaffd8', bg2: '#7ec850', ring: '#4e9c3f', symbol: 'leaf' },
  t_ember: { skin: '#dfa77d', skinD: '#c48c62', hair: '#3a2018', top: '#e8453c', topD: '#b8302a', sleeve: '#b8302a', trim: '#ffb43d', bg1: '#ffe2c8', bg2: '#ff8a3d', ring: '#e8453c', symbol: 'flame' },
  t_tide:  { skin: '#f1c4a4', skinD: '#d6a583', hair: '#2aa8b8', top: '#2a7fd0', topD: '#1f66b0', sleeve: '#1f66b0', trim: '#6fe0ef', bg1: '#dff6ff', bg2: '#6fc3ff', ring: '#2a7fd0', symbol: 'drop' },
};

// 属性符号（画在右下角徽章里）
function drawSymbol(g, kind, x, y, r, color) {
  g.save();
  g.translate(x, y);
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = r * 0.24;
  if (kind === 'bolt') {
    g.beginPath();
    g.moveTo(r * 0.12, -r); g.lineTo(-r * 0.55, r * 0.10); g.lineTo(-r * 0.05, r * 0.10);
    g.lineTo(-r * 0.18, r); g.lineTo(r * 0.58, -r * 0.14); g.lineTo(r * 0.06, -r * 0.14);
    g.closePath(); g.fill();
  } else if (kind === 'leaf') {
    g.beginPath();
    g.moveTo(-r * 0.6, r * 0.6);
    g.quadraticCurveTo(-r * 0.9, -r * 0.7, r * 0.65, -r * 0.7);
    g.quadraticCurveTo(r * 0.6, r * 0.6, -r * 0.6, r * 0.6);
    g.closePath(); g.fill();
    g.beginPath(); g.moveTo(-r * 0.5, r * 0.55); g.lineTo(r * 0.42, -r * 0.48);
    g.strokeStyle = 'rgba(255,255,255,.65)'; g.lineWidth = r * 0.16; g.stroke();
  } else if (kind === 'flame') {
    g.beginPath();
    g.moveTo(0, -r);
    g.bezierCurveTo(r * 0.75, -r * 0.25, r * 0.55, r * 0.55, 0, r * 0.85);
    g.bezierCurveTo(-r * 0.55, r * 0.55, -r * 0.75, -r * 0.25, 0, -r);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.beginPath();
    g.moveTo(0, -r * 0.15);
    g.bezierCurveTo(r * 0.3, r * 0.15, r * 0.2, r * 0.45, 0, r * 0.6);
    g.bezierCurveTo(-r * 0.25, r * 0.4, -r * 0.3, r * 0.1, 0, -r * 0.15);
    g.closePath(); g.fill();
  } else {
    g.beginPath();
    g.moveTo(0, -r);
    g.bezierCurveTo(r * 0.7, -r * 0.1, r * 0.6, r * 0.55, 0, r * 0.95);
    g.bezierCurveTo(-r * 0.6, r * 0.55, -r * 0.7, -r * 0.1, 0, -r);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.7)';
    g.beginPath();
    g.ellipse(0, r * 0.28, r * 0.16, r * 0.24, -0.4, 0, TAU);
    g.fill();
  }
  g.restore();
}

// 训练家半身：类型色圆环底 + 半身像 + 右下角属性徽章
function drawTrainerPortrait(g, id) {
  const A = TRAINER_ART[id] || TRAINER_ART.t_bolt;
  // 背景
  g.fillStyle = cLin(g, 0.1, 0, 0.9, 1, [[0, A.bg1], [1, A.bg2]]);
  g.fillRect(0, 0, 1, 1);
  // 放射装饰线
  g.save();
  g.translate(0.5, 0.48);
  g.globalAlpha = 0.12;
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 12; i++) {
    g.rotate(TAU / 12);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0.5, -0.06); g.lineTo(0.5, 0.06); g.closePath(); g.fill();
  }
  g.restore();
  // 大圆环
  g.save();
  g.shadowColor = 'rgba(40,30,10,.22)'; g.shadowBlur = 0.06; g.shadowOffsetY = 0.022;
  cCir(g, 0.5, 0.49, 0.395, '#ffffff');
  g.restore();
  cCir(g, 0.5, 0.49, 0.372, cRad(g, 0.5, 0.34, 0.03, 0.42, [[0, '#ffffff'], [0.42, A.bg1], [1, A.ring]]));
  cCir(g, 0.5, 0.49, 0.388, null, '#ffffff', 0.03);
  // 圆环内的地面光
  g.save();
  g.globalAlpha = 0.55;
  cEll(g, 0.5, 0.78, 0.30, 0.075, 0, '#ffffff');
  g.restore();

  // ---- 半身像 ----
  const skin = A.skin, skinD = A.skinD, hair = A.hair, OL = 'rgba(50,32,20,.55)';
  // 肩膀 / 上衣
  g.beginPath();
  g.moveTo(0.20, 0.88);
  g.bezierCurveTo(0.215, 0.72, 0.32, 0.665, 0.5, 0.655);
  g.bezierCurveTo(0.68, 0.665, 0.785, 0.72, 0.80, 0.88);
  g.closePath();
  g.fillStyle = cLin(g, 0.3, 0.65, 0.7, 0.88, [[0, A.top], [1, A.topD]]);
  g.fill();
  g.lineWidth = 0.018; g.strokeStyle = OL; g.stroke();
  // 袖子
  cEll(g, 0.235, 0.815, 0.085, 0.115, 0.25, A.sleeve, OL, 0.016);
  cEll(g, 0.765, 0.815, 0.085, 0.115, -0.25, A.sleeve, OL, 0.016);
  // 领口
  g.beginPath();
  g.moveTo(0.40, 0.665); g.quadraticCurveTo(0.5, 0.735, 0.60, 0.665);
  g.quadraticCurveTo(0.5, 0.77, 0.40, 0.665);
  g.closePath();
  g.fillStyle = A.trim; g.fill();
  g.lineWidth = 0.014; g.strokeStyle = OL; g.stroke();
  // 脖子
  cRR(g, 0.445, 0.60, 0.11, 0.10, 0.03, skinD, OL, 0.014);
  // 头
  cEll(g, 0.5, 0.465, 0.155, 0.175, 0, skin, OL, 0.018);
  // 耳朵
  cEll(g, 0.352, 0.475, 0.026, 0.04, 0, skin, OL, 0.012);
  cEll(g, 0.648, 0.475, 0.026, 0.04, 0, skin, OL, 0.012);
  // 腮红
  cEll(g, 0.405, 0.535, 0.030, 0.018, 0, 'rgba(232,110,100,.35)');
  cEll(g, 0.595, 0.535, 0.030, 0.018, 0, 'rgba(232,110,100,.35)');
  // 眉毛
  g.strokeStyle = hair; g.lineWidth = 0.016;
  g.beginPath(); g.moveTo(0.408, 0.418); g.quadraticCurveTo(0.432, 0.404, 0.456, 0.414); g.stroke();
  g.beginPath(); g.moveTo(0.592, 0.418); g.quadraticCurveTo(0.568, 0.404, 0.544, 0.414); g.stroke();
  // 眼睛
  cEye(g, 0.437, 0.472, 0.033, '#ffffff', '#3a2a20', '#241c14');
  cEye(g, 0.563, 0.472, 0.033, '#ffffff', '#3a2a20', '#241c14');
  // 鼻子 + 嘴
  g.strokeStyle = skinD; g.lineWidth = 0.012;
  g.beginPath(); g.moveTo(0.5, 0.49); g.quadraticCurveTo(0.508, 0.51, 0.497, 0.518); g.stroke();
  g.strokeStyle = 'rgba(120,60,50,.85)'; g.lineWidth = 0.014;
  g.beginPath(); g.moveTo(0.468, 0.552); g.quadraticCurveTo(0.5, 0.575, 0.532, 0.552); g.stroke();

  // ---- 发型 / 头饰 ----
  if (id === 't_bolt') {
    // 黄色棒球帽
    g.beginPath();
    g.moveTo(0.335, 0.40);
    g.bezierCurveTo(0.34, 0.255, 0.44, 0.215, 0.5, 0.215);
    g.bezierCurveTo(0.56, 0.215, 0.66, 0.255, 0.665, 0.40);
    g.quadraticCurveTo(0.5, 0.345, 0.335, 0.40);
    g.closePath();
    g.fillStyle = cLin(g, 0.35, 0.22, 0.65, 0.42, [[0, '#ffe98a'], [1, A.topD]]);
    g.fill(); g.lineWidth = 0.016; g.strokeStyle = OL; g.stroke();
    // 帽檐（向前）
    g.beginPath();
    g.moveTo(0.352, 0.393);
    g.quadraticCurveTo(0.5, 0.47, 0.70, 0.375);
    g.quadraticCurveTo(0.66, 0.435, 0.5, 0.443);
    g.quadraticCurveTo(0.38, 0.44, 0.352, 0.393);
    g.closePath();
    g.fillStyle = '#3a3a44'; g.fill(); g.lineWidth = 0.012; g.strokeStyle = OL; g.stroke();
    // 帽扣 + 闪电标
    cCir(g, 0.5, 0.243, 0.018, '#fff2a8', '#b88a00', 0.008);
    drawSymbol(g, 'bolt', 0.428, 0.335, 0.032, '#2c2b33');
    // 耳边短发
    cEll(g, 0.345, 0.49, 0.028, 0.048, 0, hair);
    cEll(g, 0.655, 0.49, 0.028, 0.048, 0, hair);
  } else if (id === 't_leaf') {
    // 后脑头发
    cEll(g, 0.5, 0.445, 0.175, 0.175, 0, cLin(g, 0.35, 0.3, 0.65, 0.6, [[0, '#a8764a'], [1, hair]]));
    // 双马尾
    g.save();
    g.fillStyle = hair; g.strokeStyle = OL; g.lineWidth = 0.014;
    [-1, 1].forEach(function (s) {
      g.beginPath();
      g.moveTo(0.5 + s * 0.155, 0.40);
      g.bezierCurveTo(0.5 + s * 0.30, 0.44, 0.5 + s * 0.34, 0.60, 0.5 + s * 0.28, 0.76);
      g.bezierCurveTo(0.5 + s * 0.225, 0.66, 0.5 + s * 0.19, 0.55, 0.5 + s * 0.13, 0.48);
      g.closePath(); g.fill(); g.stroke();
      cCir(g, 0.5 + s * 0.165, 0.435, 0.032, '#ffe9b8', '#c9a860', 0.01);
    });
    g.restore();
    // 刘海
    g.beginPath();
    g.moveTo(0.335, 0.455);
    g.bezierCurveTo(0.33, 0.28, 0.43, 0.245, 0.5, 0.245);
    g.bezierCurveTo(0.57, 0.245, 0.67, 0.28, 0.665, 0.455);
    g.quadraticCurveTo(0.62, 0.395, 0.565, 0.415);
    g.quadraticCurveTo(0.53, 0.36, 0.49, 0.415);
    g.quadraticCurveTo(0.43, 0.36, 0.405, 0.425);
    g.quadraticCurveTo(0.365, 0.40, 0.335, 0.455);
    g.closePath();
    g.fillStyle = cLin(g, 0.35, 0.25, 0.65, 0.46, [[0, '#a8764a'], [1, hair]]);
    g.fill(); g.lineWidth = 0.014; g.strokeStyle = OL; g.stroke();
    // 叶形发夹
    cEll(g, 0.625, 0.335, 0.026, 0.05, 0.75, '#7ec850', '#4e9c3f', 0.01);
    // 斗篷领
    g.beginPath();
    g.moveTo(0.24, 0.86); g.quadraticCurveTo(0.35, 0.70, 0.42, 0.70);
    g.lineTo(0.58, 0.70); g.quadraticCurveTo(0.65, 0.70, 0.76, 0.86);
    g.closePath(); g.fillStyle = 'rgba(78,156,63,.92)'; g.fill();
  } else if (id === 't_ember') {
    // 刺头
    g.beginPath();
    g.moveTo(0.33, 0.46);
    g.lineTo(0.30, 0.30); g.lineTo(0.385, 0.365);
    g.lineTo(0.365, 0.24); g.lineTo(0.46, 0.335);
    g.lineTo(0.48, 0.205); g.lineTo(0.545, 0.325);
    g.lineTo(0.60, 0.225); g.lineTo(0.625, 0.36);
    g.lineTo(0.71, 0.30); g.lineTo(0.68, 0.46);
    g.quadraticCurveTo(0.5, 0.385, 0.33, 0.46);
    g.closePath();
    g.fillStyle = cLin(g, 0.35, 0.24, 0.65, 0.46, [[0, '#6a4030'], [1, hair]]);
    g.fill(); g.lineWidth = 0.014; g.strokeStyle = OL; g.stroke();
    // 刘海挑染
    g.beginPath();
    g.moveTo(0.36, 0.42); g.quadraticCurveTo(0.40, 0.34, 0.47, 0.33);
    g.lineTo(0.44, 0.38);
    g.closePath(); g.fillStyle = '#b8302a'; g.fill();
    // 夹克高领
    g.beginPath();
    g.moveTo(0.36, 0.72); g.quadraticCurveTo(0.5, 0.66, 0.64, 0.72);
    g.lineTo(0.60, 0.78); g.quadraticCurveTo(0.5, 0.74, 0.40, 0.78);
    g.closePath(); g.fillStyle = '#ffb43d'; g.fill();
    // 拉链
    g.strokeStyle = '#ffb43d'; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.5, 0.74); g.lineTo(0.5, 0.88); g.stroke();
  } else {
    // 波琳：蓝色马尾 + 泳镜
    g.beginPath();
    g.moveTo(0.34, 0.46);
    g.bezierCurveTo(0.33, 0.30, 0.42, 0.25, 0.5, 0.25);
    g.bezierCurveTo(0.58, 0.25, 0.67, 0.30, 0.66, 0.46);
    g.quadraticCurveTo(0.6, 0.40, 0.545, 0.42);
    g.quadraticCurveTo(0.5, 0.36, 0.455, 0.42);
    g.quadraticCurveTo(0.40, 0.40, 0.34, 0.46);
    g.closePath();
    g.fillStyle = cLin(g, 0.35, 0.26, 0.65, 0.46, [[0, '#63cfda'], [1, hair]]);
    g.fill(); g.lineWidth = 0.014; g.strokeStyle = OL; g.stroke();
    // 高马尾
    g.beginPath();
    g.moveTo(0.50, 0.245);
    g.bezierCurveTo(0.62, 0.20, 0.74, 0.26, 0.77, 0.38);
    g.bezierCurveTo(0.70, 0.35, 0.62, 0.32, 0.56, 0.30);
    g.closePath(); g.fillStyle = hair; g.fill(); g.lineWidth = 0.012; g.strokeStyle = OL; g.stroke();
    // 发圈
    cCir(g, 0.545, 0.275, 0.020, A.trim, '#1b6e7e', 0.008);
    // 泳镜
    cRR(g, 0.395, 0.30, 0.085, 0.05, 0.024, A.trim, '#1b6e7e', 0.012);
    cRR(g, 0.52, 0.30, 0.085, 0.05, 0.024, A.trim, '#1b6e7e', 0.012);
    g.beginPath(); g.moveTo(0.48, 0.315); g.lineTo(0.52, 0.315);
    g.lineWidth = 0.014; g.strokeStyle = '#1b6e7e'; g.stroke();
    // 潜水服拉链 + 肩线
    g.strokeStyle = A.trim; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.5, 0.74); g.lineTo(0.5, 0.88); g.stroke();
    g.beginPath(); g.moveTo(0.33, 0.79); g.quadraticCurveTo(0.40, 0.75, 0.42, 0.74); g.stroke();
    g.beginPath(); g.moveTo(0.67, 0.79); g.quadraticCurveTo(0.60, 0.75, 0.58, 0.74); g.stroke();
  }

  // ---- 右下属性徽章 ----
  cCir(g, 0.795, 0.795, 0.115, '#ffffff', null, 0);
  cCir(g, 0.795, 0.795, 0.115, null, 'rgba(255,255,255,.9)', 0.022);
  cCir(g, 0.795, 0.795, 0.096, A.ring);
  cCir(g, 0.795, 0.795, 0.096, null, '#ffffff', 0.012);
  drawSymbol(g, A.symbol, 0.795, 0.795, 0.052, '#ffffff');
  // 左上角小高光
  g.save();
  g.globalAlpha = 0.35;
  cCir(g, 0.20, 0.16, 0.10, cRad(g, 0.2, 0.16, 0.01, 0.10, [[0, '#ffffff'], [1, 'rgba(255,255,255,0)']]));
  g.restore();
}

// ===========================================================================
// 14. 对外 API
// ===========================================================================
const CACHE_2D = new Map();

function makeIconCanvas(id, size) {
  const d = DATA[id];
  if (!d) return null;
  const m = mkCanvas(size);
  const g = m.g;
  // 统一裁到圆角方块（部分 UI 直接展示方形图标）
  cRR(g, 0, 0, 1, 1, 0.18, '#ffffff', null, 0);
  g.save();
  g.beginPath();
  cRR(g, 0, 0, 1, 1, 0.18, null, null, 0);
  g.clip();
  (ICONS[id] || ICONS.pikachu)(g);
  g.restore();
  // 顶部玻璃高光
  g.save();
  g.globalAlpha = 0.10;
  g.beginPath();
  g.moveTo(0, 0.42); g.quadraticCurveTo(0.5, 0.28, 1, 0.42);
  g.lineTo(1, 0); g.lineTo(0, 0); g.closePath();
  g.fillStyle = '#ffffff'; g.fill();
  g.restore();
  return m.canvas;
}

function makePortraitCanvas(id, size) {
  const m = mkCanvas(size);
  const g = m.g;
  if (TRAINER_ART[id]) {
    cRR(g, 0, 0, 1, 1, 0.16, '#ffffff', null, 0);
    g.save();
    g.beginPath();
    cRR(g, 0, 0, 1, 1, 0.16, null, null, 0);
    g.clip();
    drawTrainerPortrait(g, id);
    g.restore();
  } else if (DATA[id]) {
    // 宝可梦也可拿 portrait（UI 兜底用）：图标 + 白环放大版
    cRR(g, 0, 0, 1, 1, 0.16, '#ffffff', null, 0);
    g.save();
    g.beginPath();
    cRR(g, 0, 0, 1, 1, 0.16, null, null, 0);
    g.clip();
    (ICONS[id] || ICONS.pikachu)(g);
    g.restore();
    cCir(g, 0.5, 0.5, 0.47, null, '#ffffff', 0.02);
  } else {
    cRR(g, 0, 0, 1, 1, 0.16, '#cfd8e0', '#9aa8b4', 0.02);
  }
  return m.canvas;
}

// 带缓存的 icon / portrait（同 id 同尺寸只绘制一次）
function icon(id, size) {
  const s = Math.max(16, Math.round(size || 96));
  const key = 'i|' + id + '|' + s;
  let c = CACHE_2D.get(key);
  if (!c) { c = makeIconCanvas(id, s); if (!c) return null; CACHE_2D.set(key, c); }
  return c;
}
function portrait(id, size) {
  const s = Math.max(32, Math.round(size || 256));
  const key = 'p|' + id + '|' + s;
  let c = CACHE_2D.get(key);
  if (!c) { c = makePortraitCanvas(id, s); CACHE_2D.set(key, c); }
  return c;
}

// 预热模板（可选，游戏启动时调用可避免首刷卡顿）；失败不影响游戏
function warmup(ids) {
  const list = ids || POKEMON_IDS.concat(TRAINER_IDS);
  for (let i = 0; i < list.length; i++) {
    try { getTemplate(list[i]); } catch (e) { /* 忽略单只失败 */ }
  }
  return true;
}

PG.models = {
  POKEMON: POKEMON_IDS.slice(),
  TRAINERS: TRAINER_IDS.slice(),
  has: function (id) { return !!DATA[id] || !!TRAINER_ART[id]; },
  info: infoOf,
  make: function (id) {
    if (!DATA[id]) throw new Error('PG.models.make: 未知宝可梦 id "' + id + '"');
    return makePokemon(id);
  },
  makeTrainer: function (id) {
    if (!TRAINER_ART[id]) throw new Error('PG.models.makeTrainer: 未知训练家 id "' + id + '"');
    return makeTrainerModel(id);
  },
  portrait: portrait,
  icon: icon,
  warmup: warmup,
  // 调试用：查看模板高度 / draw call 估算
  stats: function (id) { const t = getTemplate(id); let meshes = 0; t.group.traverse(function (o) { if (o.isMesh) meshes++; }); return { id: id, height: t.height, radius: t.radius, meshes: meshes }; },
  silhouetteColor: function (id) { const d = DATA[id]; return (d && TYPE_COLORS[d.type]) || (TRAINER_DATA[id] && TYPE_COLORS[TRAINER_DATA[id].type]) || '#ffffff'; },
};


})();
