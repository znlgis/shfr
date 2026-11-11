/* ============================================================================
 * 32-beasts.js — 山海妖物 3D 模型（14 只）
 * ----------------------------------------------------------------------------
 * 造型由 src/30-models.js 暴露的 PG.models._dsl 拼装，末尾 registerBuilders 注入。
 *   1) 全程序化几何（球 / 胶囊 / 环 / 锥 / 柱 / 盒 / 挤出片），无外部贴图；
 *   2) 脚底 y = 0、正面朝 -Z（finishModel 统一降地并量高）；
 *   3) 动画节点名只用 [a-z0-9_]；update 里做呼吸 / 摆尾 / 振翅 / 雾摆 / 鳞光；
 *   4) 高度与半径按 docs/MYTHOLOGY.md 第 3 节，形体尽量贴合。
 * ==========================================================================*/
(() => { const PG = window.PG = window.PG || {}; const M = PG.models; if (!M || !M._dsl) return; const D = M._dsl;
  const {
    Builder, SPH, SPH_HI, CONE, CYL, BOX, HEMI, TORUS, CAPSULE, ICO,
    leafGeo, boltGeo, scytheGeo, capChain, addEye, addEyes, addSmile, addOpenMouth,
    addFangs, addTeethRow, addCheeks, addClaws, addFoot, finishModel, quatY, TAU, PI,
  } = D;

  // =========================================================================
  // 公共小工具
  // =========================================================================

  // 呼吸：整体沿 Y 轻微起伏（优先用 finishModel 包好的 inner 组）
  function breathe(nodes, t, amp) {
    const n = nodes.inner || nodes.root;
    if (n) n.scale.y = 1 + Math.sin(t * 1.9) * (amp == null ? 0.012 : amp);
  }

  // 发光眼（成对）：鬼魅 / 精怪 / 混沌用
  function glowEyes(B, node, o) {
    const r = o.r == null ? 0.03 : o.r;
    const spread = o.spread == null ? 0.055 : o.spread;
    const col = o.color == null ? 0x7af0d0 : o.color;
    for (let s = -1; s <= 1; s += 2) {
      B.put(node, SPH(), col, {
        x: (o.x || 0) + s * spread, y: o.y || 0, z: o.z == null ? -0.09 : o.z,
        sx: r, sy: r * (o.sy == null ? 1.15 : o.sy), sz: r * 0.6,
        glow: col, glowInt: o.glowInt == null ? 1.9 : o.glowInt,
      });
    }
  }

  // 一排尖刺（鬃毛 / 背脊 / 冠羽）：沿 X 排开，可按 tilt 扇形张开
  function spikeFan(B, node, o) {
    const n = o.n == null ? 3 : o.n;
    const gap = o.gap == null ? 0.05 : o.gap;
    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;
      B.put(node, CONE(), o.color == null ? 0xf0e6d2 : o.color, {
        x: (o.x || 0) + k * gap, y: (o.y || 0) + k * k * (o.arc || 0), z: o.z || 0,
        sx: o.w || 0.02, sy: o.h || 0.09, sz: (o.w || 0.02) * 0.72,
        rx: (o.rx || 0) + k * (o.rxTilt || 0), ry: o.ry || 0,
        rz: (o.rz || 0) + k * (o.tilt || 0),
        shine: true,
      });
    }
  }

  // 绕 Y 轴的环带（金环纹 / 混沌赤光 / 树纹）
  function ringBand(B, node, o) {
    B.put(node, TORUS(o.R == null ? 1 : o.R, o.tube == null ? 0.05 : o.tube, TAU), o.color, {
      x: o.x || 0, y: o.y || 0, z: o.z || 0, rx: PI / 2,
      sx: o.sx == null ? 1 : o.sx, sy: o.sy == null ? 1 : o.sy, sz: o.sz == null ? 1 : o.sz,
      glow: o.glow, glowInt: o.glowInt, glass: o.glass, shine: o.shine,
    });
  }

  // =========================================================================
  // 1) 鹿蜀 — 马形白身、虎纹、赤尾、长耳（h 0.66 / r 0.32）
  // =========================================================================
  function buildLushu() {
    const B = Builder();
    const CREAM = 0xe8e2d2, CREAM_D = 0xd6ccb4, STRIPE = 0x9a6a35;
    const RED = 0xd0432e, HOOF = 0x6a4a32;

    // 四条细腿 + 小蹄
    const LEGS = [[-0.10, -0.12], [0.10, -0.12], [-0.10, 0.13], [0.10, 0.13]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.026, 0.075), CREAM_D, { x: lx, y: 0.105, z: lz });
      B.put('root', CAPSULE(0.031, 0.075), CREAM, { x: lx, y: 0.20, z: lz });
      B.put('root', SPH(), HOOF, { x: lx, y: 0.038, z: lz - 0.006, sx: 0.038, sy: 0.036, sz: 0.046 });
    }

    // 躯干：米白马身 + 深赭虎纹（绕身体一圈的环带）
    B.put('root', SPH_HI(), CREAM, { y: 0.375, sx: 0.152, sy: 0.132, sz: 0.205 });
    B.put('root', SPH(), CREAM_D, { y: 0.316, z: -0.02, sx: 0.115, sy: 0.082, sz: 0.18 });
    for (let i = 0; i < 6; i++) {
      const zc = -0.135 + i * 0.062;
      const k = 1.030 * Math.sqrt(Math.max(0.10, 1 - (zc / 0.205) * (zc / 0.205)));
      B.put('root', TORUS(1, 0.024, TAU), STRIPE, { y: 0.375, z: zc, sx: 0.152 * k, sy: 0.132 * k, sz: 1 });
    }
    // 颈 + 头
    capChain(B, 'root', [[0, 0.44, -0.08], [0, 0.478, -0.14], [0, 0.516, -0.18]], [0.075, 0.062, 0.052], CREAM);
    B.node('head', 'root', 0, 0.525, -0.19);
    B.put('head', SPH_HI(), CREAM, { y: 0.02, sx: 0.078, sy: 0.075, sz: 0.092 });
    B.put('head', SPH(), CREAM_D, { y: -0.028, z: -0.062, sx: 0.052, sy: 0.048, sz: 0.055 });
    B.put('head', SPH(), 0x4a3226, { y: -0.012, z: -0.114, sx: 0.014, sy: 0.012, sz: 0.012 });
    addEyes(B, 'head', { y: 0.035, z: -0.062, spread: 0.05, r: 0.027, style: 'full', white: 0xfffdf4, iris: 0x8a5a32, pupil: 0x241c16, wz: 0.55 });
    B.put('head', SPH(), STRIPE, { y: 0.072, z: -0.052, sx: 0.03, sy: 0.016, sz: 0.02, rx: 0.3 });
    // 长耳（动画节点）
    const earL = B.node('ear_l', 'head', -0.042, 0.058, 0.008);
    const earR = B.node('ear_r', 'head', 0.042, 0.058, 0.008);
    earL.rotation.z = 0.22; earR.rotation.z = -0.22;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ear_l' : 'ear_r';
      B.put(nm, CONE(), CREAM, { y: 0.044, sx: 0.021, sy: 0.088, sz: 0.014, rz: s * 0.10 });
      B.put(nm, CONE(), RED, { y: 0.038, z: -0.009, sx: 0.011, sy: 0.062, sz: 0.008, rz: s * 0.10 });
    }
    // 赤尾（动画节点）：三片红尾羽 + 米白尾根
    B.node('tail', 'root', 0, 0.40, 0.175);
    B.put('tail', SPH(), CREAM, { y: 0.005, sx: 0.045, sy: 0.045, sz: 0.04 });
    B.put('tail', leafGeo(0.055, 0.13, 0.02), RED, { y: 0.01, z: 0.012, rx: 0.85 });
    B.put('tail', leafGeo(0.048, 0.12, 0.018), RED, { x: 0.028, y: 0.005, z: 0.01, rx: 0.9, rz: -0.28 });
    B.put('tail', leafGeo(0.048, 0.12, 0.018), RED, { x: -0.028, y: 0.005, z: 0.01, rx: 0.9, rz: 0.28 });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.014);
      nodes.head.rotation.x = Math.sin(t * 1.55) * 0.06;
      nodes.head.rotation.z = Math.sin(t * 0.85) * 0.04;
      nodes.ear_l.rotation.z = 0.22 + Math.sin(t * 2.4) * 0.10;
      nodes.ear_r.rotation.z = -0.22 - Math.sin(t * 2.4 + 0.5) * 0.10;
      nodes.tail.rotation.y = Math.sin(t * 1.35) * 0.16;
      nodes.tail.rotation.z = Math.sin(t * 1.05 + 0.4) * 0.12;
    }, { fitH: 0.66 });
  }

  // =========================================================================
  // 2) 蜈蚣精 — 多节蜈蚣、百足、毒颚、触须（h 0.66 / r 0.30）
  // =========================================================================
  function buildWugong() {
    const B = Builder();
    const BROWN = 0x5a3a2a, OCHRE = 0xb8743a, VENOM = 0x9bd44a, DARK = 0x34231a;

    const SEG = [
      ['seg1', 0.230, -0.140, 0.080],
      ['seg2', 0.212, -0.062, 0.078],
      ['seg3', 0.198, 0.014, 0.075],
      ['seg4', 0.190, 0.090, 0.072],
      ['seg5', 0.186, 0.166, 0.068],
      ['seg6', 0.192, 0.242, 0.062],
    ];
    for (let i = 0; i < SEG.length; i++) {
      const s = SEG[i], nm = s[0], sy0 = s[1], z0 = s[2], rad = s[3];
      B.node(nm, 'root', 0, sy0, z0);
      B.put(nm, SPH(), i % 2 ? OCHRE : BROWN, { sx: 0.078 - i * 0.003, sy: rad, sz: 0.052 });
      // 背甲 + 毒绿脊点（鳞光）
      B.put(nm, SPH(), DARK, { y: rad * 0.52, sx: 0.062 - i * 0.002, sy: 0.016, sz: 0.042 });
      B.put(nm, SPH(), VENOM, { y: rad * 0.9, sx: 0.017, sy: 0.014, sz: 0.017, glow: VENOM, glowInt: 0.7 });
      // 每节三对足（step 2 只做左右各一，共六足感）
      for (let k = -1; k <= 1; k += 2) {
        const legLen = Math.max(0.05, sy0 - 0.04);
        const legCy = 0.008 - sy0 / 2;
        B.put(nm, CAPSULE(0.011, legLen), DARK, { x: k * 0.058, y: legCy, z: 0, rz: k * 0.34 });
        B.put(nm, CONE(), DARK, { x: k * 0.082, y: legCy - legLen / 2 - 0.006, z: 0.012, sx: 0.008, sy: 0.032, sz: 0.008, rx: PI, rz: k * 0.2 });
      }
    }
    // 头（抬起） + 毒颚 + 触须
    B.node('head', 'root', 0, 0.320, -0.205);
    B.put('head', SPH_HI(), OCHRE, { sx: 0.095, sy: 0.085, sz: 0.092 });
    B.put('head', SPH(), BROWN, { y: 0.040, z: 0.008, sx: 0.082, sy: 0.030, sz: 0.078 });
    glowEyes(B, 'head', { y: 0.022, z: -0.070, spread: 0.050, r: 0.020, color: VENOM, glowInt: 1.6 });
    // 毒颚（下颚动画节点，左右开合）
    B.node('jaw', 'head', 0, -0.040, -0.030);
    for (let s = -1; s <= 1; s += 2) {
      B.put('jaw', CONE(), VENOM, { x: s * 0.028, y: -0.018, z: -0.030, sx: 0.014, sy: 0.085, sz: 0.012, rx: -2.15, rz: s * 0.18, shine: true });
    }
    // 两根触须（动画节点）
    const feelL = B.node('feel_l', 'head', -0.048, 0.058, -0.012);
    const feelR = B.node('feel_r', 'head', 0.048, 0.058, -0.012);
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'feel_l' : 'feel_r';
      capChain(B, nm, [[0, 0, 0], [s * 0.030, 0.130, -0.050], [s * 0.060, 0.270, -0.100]], [0.011, 0.009, 0.006], BROWN);
      B.put(nm, SPH(), VENOM, { x: s * 0.060, y: 0.272, z: -0.100, sx: 0.014, sy: 0.014, sz: 0.014, glow: VENOM, glowInt: 1.0 });
    }
    // 尾节尖刺
    B.put('seg6', CONE(), OCHRE, { y: 0.02, z: 0.040, sx: 0.02, sy: 0.075, sz: 0.02, rx: 1.25, shine: true });

    return finishModel(B, function (nodes, dt, t) {
      for (let i = 0; i < SEG.length; i++) {
        const n = nodes[SEG[i][0]];
        n.position.y = SEG[i][1] + Math.sin(t * 4.8 - i * 0.85) * 0.010;
        n.rotation.y = Math.sin(t * 4.0 - i * 0.7) * 0.05;
      }
      nodes.head.rotation.x = -0.05 + Math.sin(t * 2.2) * 0.06;
      nodes.head.rotation.z = Math.sin(t * 1.4) * 0.05;
      nodes.feel_l.rotation.z = 0.08 + Math.sin(t * 3.1) * 0.15;
      nodes.feel_r.rotation.z = -0.08 - Math.sin(t * 3.1 + 0.6) * 0.15;
      nodes.jaw.rotation.x = -0.05 - Math.sin(t * 3.4) * 0.14;
    }, { fitH: 0.66 });
  }

  // =========================================================================
  // 3) 鸩鸟 — 毒羽鸟、金喙、赤目、长尾羽（h 0.62 / r 0.30）
  // =========================================================================
  function buildZhen() {
    const B = Builder();
    const PURPLE = 0x8a5fbf, DARK = 0x4a2f6a, PLUME = 0x6a4f8a;
    const GOLD = 0xe8b33a, RED = 0xe8453c, LEG = 0x9a7a3a;

    // 细腿 + 趾
    for (let s = -1; s <= 1; s += 2) {
      B.put('root', CAPSULE(0.013, 0.11), LEG, { x: s * 0.06, y: 0.085, z: 0.0 });
      addClaws(B, 'root', { x: s * 0.06, y: 0.020, z: -0.030, r: 0.009, len: 0.030, spread: 0.016, color: LEG });
      addClaws(B, 'root', { x: s * 0.06, y: 0.020, z: 0.028, r: 0.007, len: 0.024, spread: 0.014, color: LEG, rx: PI / 2 });
    }
    // 身体 + 胸羽
    B.put('root', SPH_HI(), PURPLE, { y: 0.275, sx: 0.132, sy: 0.150, sz: 0.140 });
    B.put('root', SPH(), PLUME, { y: 0.300, z: 0.030, sx: 0.155, sy: 0.160, sz: 0.120 });
    B.put('root', SPH(), 0xb39ae0, { y: 0.252, z: -0.092, sx: 0.082, sy: 0.105, sz: 0.055 });
    spikeFan(B, 'root', { x: 0, y: 0.345, z: 0.075, n: 3, gap: 0.055, w: 0.030, h: 0.12, rx: 0.85, tilt: 0.35, color: DARK });

    // 头（动画节点）
    B.node('head', 'root', 0, 0.442, -0.030);
    B.put('head', SPH_HI(), PURPLE, { sx: 0.112, sy: 0.098, sz: 0.104 });
    // 金喙（朝 -Z）
    B.put('head', CONE(), GOLD, { y: -0.018, z: -0.100, sx: 0.040, sy: 0.105, sz: 0.036, rx: -PI / 2, shine: true });
    B.put('head', CONE(), 0xc99a2a, { y: -0.048, z: -0.082, sx: 0.026, sy: 0.062, sz: 0.024, rx: -PI / 2 + 0.30 });
    // 赤目
    addEyes(B, 'head', { y: 0.020, z: -0.072, spread: 0.060, r: 0.026, style: 'full', white: 0xfff2ee, iris: RED, pupil: 0x2a0f14, wz: 0.55 });
    B.put('head', SPH(), DARK, { y: 0.052, z: -0.058, sx: 0.078, sy: 0.012, sz: 0.024, rz: -0.12 });
    // 毒羽冠（三片，向后上方）
    for (let i = 0; i < 3; i++) {
      B.put('head', leafGeo(0.026, 0.105 - i * 0.012, 0.012), i === 1 ? DARK : PLUME, {
        x: (i - 1) * 0.038, y: 0.072, z: 0.010, rx: -0.30 - i * 0.06, rz: (i - 1) * 0.22,
      });
    }
    // 双翼（动画节点）
    const wingL = B.node('wing_l', 'root', -0.125, 0.335, 0.020);
    const wingR = B.node('wing_r', 'root', 0.125, 0.335, 0.020);
    wingL.rotation.z = 0.45; wingR.rotation.z = -0.45;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'wing_l' : 'wing_r';
      for (let i = 0; i < 3; i++) {
        B.put(nm, leafGeo(0.058 - i * 0.010, 0.170 - i * 0.026, 0.012), i === 0 ? DARK : PLUME, {
          x: s * (0.010 + i * 0.020), y: 0.015 - i * 0.012, z: 0.010 + i * 0.012,
          rz: -s * (1.12 + i * 0.14), rx: -0.22 - i * 0.10,
        });
      }
    }
    // 长尾羽（动画节点）
    B.node('tail', 'root', 0, 0.235, 0.120);
    for (let i = 0; i < 3; i++) {
      B.put('tail', leafGeo(0.034, 0.150 - i * 0.020, 0.012), i === 0 ? DARK : PLUME, {
        x: (i - 1) * 0.026, y: 0.005, z: 0.010, rx: 1.50 - i * 0.10, rz: (i - 1) * 0.26,
      });
    }
    B.put('tail', SPH(), RED, { y: 0.040, z: 0.145, sx: 0.018, sy: 0.014, sz: 0.020, glow: RED, glowInt: 0.9 });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.011);
      nodes.head.rotation.x = Math.sin(t * 1.7) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.9 + 0.4) * 0.12;
      const flap = Math.sin(t * 9.0) * 0.20;
      nodes.wing_l.rotation.z = 0.45 + flap;
      nodes.wing_r.rotation.z = -0.45 - flap;
      nodes.wing_l.rotation.x = Math.sin(t * 9.0 + 0.4) * 0.08;
      nodes.wing_r.rotation.x = Math.sin(t * 9.0 + 0.4) * 0.08;
      nodes.tail.rotation.x = Math.sin(t * 1.3) * 0.10;
      nodes.tail.rotation.y = Math.sin(t * 1.05) * 0.14;
    }, { fitH: 0.62 });
  }

  // =========================================================================
  // 4) 木魅 — 树桩妖、苔绿树冠、树皮脸、根须手（h 0.62 / r 0.30）
  // =========================================================================
  function buildMumei() {
    const B = Builder();
    const BARK = 0x6a4a2e, BARKD = 0x4a3220, MOSS = 0x7ec850, MOSSD = 0x4e8a32;
    const EYE = 0xffd66a;

    // 树桩主干 + 顶面
    B.put('root', CYL(), BARK, { y: 0.170, sx: 0.163, sy: 0.340, sz: 0.152 });
    B.put('root', SPH(), BARKD, { y: 0.338, sx: 0.166, sy: 0.045, sz: 0.155 });
    // 树皮纵纹
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      B.put('root', BOX(), BARKD, { x: Math.cos(a) * 0.160, y: 0.165, z: Math.sin(a) * 0.149, sx: 0.014, sy: 0.29, sz: 0.014, ry: -a });
    }
    // 板根（四条）
    for (let i = 0; i < 4; i++) {
      const a = i * PI / 2 + PI / 4;
      B.put('root', CONE(), BARKD, {
        x: Math.cos(a) * 0.135, y: 0.060, z: Math.sin(a) * 0.128,
        sx: 0.045, sy: 0.150, sz: 0.045, rx: -0.45, ry: -a,
      });
    }
    // 树皮脸：眉骨 / 眼窝 / 嘴
    B.put('root', SPH(), BARK, { y: 0.285, z: -0.130, sx: 0.155, sy: 0.115, sz: 0.045 });
    glowEyes(B, 'root', { y: 0.275, z: -0.160, spread: 0.052, r: 0.022, color: EYE, glowInt: 1.5 });
    B.put('root', BOX(), BARKD, { x: 0.052, y: 0.322, z: -0.160, sx: 0.062, sy: 0.018, sz: 0.022, rz: -0.18 });
    B.put('root', BOX(), BARKD, { x: -0.052, y: 0.322, z: -0.160, sx: 0.062, sy: 0.018, sz: 0.022, rz: 0.18 });
    addOpenMouth(B, 'root', { y: 0.205, z: -0.150, w: 0.048, h: 0.032, color: 0x180f08 });
    // 苔绿树冠（动画节点）
    B.node('crown', 'root', 0, 0.345, 0);
    B.put('crown', SPH(), MOSS, { y: 0.085, sx: 0.150, sy: 0.095, sz: 0.140 });
    B.put('crown', SPH(), MOSSD, { x: 0.105, y: 0.050, z: 0.045, sx: 0.075, sy: 0.065, sz: 0.070 });
    B.put('crown', SPH(), MOSSD, { x: -0.100, y: 0.062, z: -0.030, sx: 0.065, sy: 0.058, sz: 0.062 });
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      B.put('crown', leafGeo(0.030, 0.105 + (i % 2) * 0.030, 0.012), i % 2 ? MOSS : MOSSD, {
        x: Math.sin(a) * 0.075, y: 0.135, z: Math.cos(a) * 0.045, rx: -0.35 + i * 0.06, rz: -a * 0.55,
      });
    }
    // 根须手（两条动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'arm_l' : 'arm_r';
      B.node(nm, 'root', s * 0.145, 0.235, -0.030);
      capChain(B, nm, [[0, 0, 0], [s * 0.025, -0.040, -0.095], [s * 0.050, -0.095, -0.205]], [0.038, 0.030, 0.020], BARK);
      B.put(nm, CONE(), BARKD, { x: s * 0.050, y: -0.097, z: -0.258, sx: 0.012, sy: 0.060, sz: 0.012, rx: -PI / 2 + 0.18, rz: s * 0.2 });
      B.put(nm, CONE(), BARKD, { x: s * 0.074, y: -0.095, z: -0.245, sx: 0.010, sy: 0.050, sz: 0.010, rx: -PI / 2 + 0.25, rz: s * 0.5 });
      B.put(nm, CONE(), BARKD, { x: s * 0.028, y: -0.105, z: -0.250, sx: 0.010, sy: 0.050, sz: 0.010, rx: -PI / 2 + 0.10, rz: -s * 0.15 });
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.009);
      nodes.crown.rotation.z = Math.sin(t * 1.15) * 0.055;
      nodes.crown.rotation.x = Math.sin(t * 0.9 + 0.6) * 0.040;
      nodes.arm_l.rotation.x = Math.sin(t * 1.6) * 0.10;
      nodes.arm_r.rotation.x = Math.sin(t * 1.6 + 0.9) * 0.10;
      nodes.arm_l.rotation.z = Math.sin(t * 1.2 + 0.3) * 0.06;
      nodes.arm_r.rotation.z = -Math.sin(t * 1.2 + 0.3) * 0.06;
    }, { fitH: 0.62 });
  }

  // =========================================================================
  // 5) 玄蜂 — 玄黑巨蜂、金环纹、毒针、灰蓝薄翅（h 1.15 / r 0.45）
  // =========================================================================
  function buildXuanfeng() {
    const B = Builder();
    const BLACK = 0x2b2b36, DARK = 0x1a1a22, GOLD = 0xe8b33a, WING = 0x9fb6e0;

    // 六足（三对，细长下垂点地）
    const LEGS = [[-0.075, -0.10], [0.075, -0.10], [-0.085, 0.02], [0.085, 0.02], [-0.070, 0.14], [0.070, 0.14]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      const s = lx > 0 ? 1 : -1;
      B.put('root', CAPSULE(0.020, 0.16), BLACK, { x: lx * 1.25, y: 0.560, z: lz, rz: s * 0.55 });
      B.put('root', CAPSULE(0.015, 0.40), DARK, { x: lx * 2.05, y: 0.235, z: lz - 0.012, rz: s * 0.10 });
      B.put('root', SPH(), DARK, { x: lx * 2.25, y: 0.020, z: lz - 0.030, sx: 0.026, sy: 0.018, sz: 0.040 });
    }
    // 腹部（动画节点）：玄黑 + 三道金环 + 毒针
    B.node('abdomen', 'root', 0, 0.545, 0.150);
    B.put('abdomen', SPH_HI(), BLACK, { sx: 0.150, sy: 0.168, sz: 0.215 });
    for (let i = 0; i < 3; i++) {
      const zc = -0.075 + i * 0.075;
      const k = Math.sqrt(Math.max(0.10, 1 - (zc / 0.215) * (zc / 0.215)));
      B.put('abdomen', SPH(), GOLD, { z: zc, sx: 0.150 * k + 0.004, sy: 0.168 * k + 0.004, sz: 0.016, shine: true });
    }
    B.put('abdomen', CONE(), GOLD, { y: -0.010, z: 0.235, sx: 0.030, sy: 0.150, sz: 0.030, rx: PI / 2 + 0.10, shine: true });
    // 胸（玄黑 + 金领环）
    B.put('root', SPH_HI(), BLACK, { y: 0.730, sx: 0.180, sy: 0.185, sz: 0.165 });
    ringBand(B, 'root', { y: 0.845, R: 1, tube: 0.055, sx: 0.135, sy: 0.125, color: GOLD, shine: true });
    B.put('root', SPH(), GOLD, { y: 0.700, z: -0.130, sx: 0.075, sy: 0.085, sz: 0.030, shine: true });
    // 头（动画节点）
    B.node('head', 'root', 0, 0.925, -0.055);
    B.put('head', SPH_HI(), BLACK, { sx: 0.135, sy: 0.122, sz: 0.120 });
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), GOLD, { x: s * 0.086, y: 0.018, z: -0.052, sx: 0.062, sy: 0.075, sz: 0.048, glow: GOLD, glowInt: 1.2, shine: true });
      B.put('head', CONE(), DARK, { x: s * 0.030, y: -0.075, z: -0.088, sx: 0.016, sy: 0.070, sz: 0.014, rx: -2.30, rz: s * 0.20 });
    }
    // 触角（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ant_l' : 'ant_r';
      B.node(nm, 'head', s * 0.045, 0.088, -0.012);
      capChain(B, nm, [[0, 0, 0], [s * 0.020, 0.080, -0.030], [s * 0.035, 0.150, -0.060]], [0.010, 0.008, 0.006], DARK);
      B.put(nm, SPH(), GOLD, { x: s * 0.035, y: 0.152, z: -0.060, sx: 0.010, sy: 0.010, sz: 0.010, shine: true });
    }
    // 四片灰蓝薄翅（两个动画节点，每边两片）
    const wingL = B.node('wing_l', 'root', -0.145, 0.790, 0.030);
    const wingR = B.node('wing_r', 'root', 0.145, 0.790, 0.030);
    wingL.rotation.z = 0.30; wingR.rotation.z = -0.30;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'wing_l' : 'wing_r';
      B.put(nm, leafGeo(0.130, 0.300, 0.006), WING, { x: s * 0.010, y: 0.020, z: 0.020, rz: -s * 1.12, rx: -0.30, glass: 0.78 });
      B.put(nm, leafGeo(0.100, 0.215, 0.006), WING, { x: s * 0.010, y: -0.030, z: 0.060, rz: -s * 0.92, rx: -0.22, glass: 0.66 });
      B.put(nm, leafGeo(0.018, 0.300, 0.004), GOLD, { x: s * 0.010, y: 0.020, z: 0.026, rz: -s * 1.12, rx: -0.30, glass: 0.9, shine: true });
    }

    return finishModel(B, function (nodes, dt, t) {
      const n = nodes.inner || nodes.root;
      if (n) n.position.y = (Math.sin(t * 5.0) * 0.5 + 0.5) * 0.030;
      nodes.head.rotation.x = Math.sin(t * 2.2) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 1.1) * 0.10;
      nodes.abdomen.rotation.x = Math.sin(t * 2.6) * 0.07;
      nodes.abdomen.rotation.z = Math.sin(t * 1.9 + 0.4) * 0.05;
      nodes.ant_l.rotation.z = 0.08 + Math.sin(t * 3.4) * 0.12;
      nodes.ant_r.rotation.z = -0.08 - Math.sin(t * 3.4 + 0.7) * 0.12;
      nodes.wing_l.rotation.z = 0.30 + Math.sin(t * 38) * 0.16;
      nodes.wing_r.rotation.z = -0.30 - Math.sin(t * 38) * 0.16;
      nodes.wing_l.rotation.x = Math.sin(t * 33 + 0.5) * 0.07;
      nodes.wing_r.rotation.x = Math.sin(t * 33 + 0.5) * 0.07;
    }, { fitH: 1.15 });
  }

  // =========================================================================
  // 6) 狰 — 赤豹、独角、五尾、獠牙、骨白鬃毛（h 1.35 / r 0.42）
  // =========================================================================
  function buildZheng() {
    const B = Builder();
    const RUST = 0xc2452e, RUST_D = 0x8f2f1e, BONE = 0xf0e6d2, DARK = 0x4a1a12;

    // 四条强壮兽腿 + 骨白利爪
    const LEGS = [[-0.165, -0.175], [0.165, -0.175], [-0.170, 0.190], [0.170, 0.190]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.062, 0.26), RUST, { x: lx, y: 0.500, z: lz, rz: lx > 0 ? -0.06 : 0.06 });
      B.put('root', CAPSULE(0.046, 0.26), RUST_D, { x: lx, y: 0.225, z: lz - 0.014, rz: lx > 0 ? -0.04 : 0.04 });
      B.put('root', SPH(), RUST_D, { x: lx, y: 0.052, z: lz - 0.030, sx: 0.070, sy: 0.052, sz: 0.105 });
      addClaws(B, 'root', { x: lx, y: 0.040, z: lz - 0.125, r: 0.014, len: 0.040, spread: 0.022, color: BONE });
    }
    // 躯干 + 肩臀
    B.put('root', SPH_HI(), RUST, { y: 0.720, sx: 0.235, sy: 0.225, sz: 0.275 });
    B.put('root', SPH(), RUST, { y: 0.760, z: -0.180, sx: 0.190, sy: 0.190, sz: 0.150 });
    B.put('root', SPH(), RUST, { y: 0.745, z: 0.175, sx: 0.195, sy: 0.200, sz: 0.160 });
    B.put('root', SPH(), 0xd9764f, { y: 0.660, z: -0.060, sx: 0.130, sy: 0.100, sz: 0.220 });
    // 背部深色脊纹
    for (let i = 0; i < 4; i++) {
      B.put('root', SPH(), RUST_D, { y: 0.905 - i * 0.010, z: -0.120 + i * 0.075, sx: 0.030, sy: 0.014, sz: 0.032 });
    }
    // 颈
    capChain(B, 'root', [[0, 0.850, -0.170], [0, 0.950, -0.225], [0, 1.020, -0.255]], [0.130, 0.115, 0.100], RUST);
    // 骨白鬃毛（环颈一圈的尖刺）
    for (let i = 0; i < 9; i++) {
      const a = -PI * 0.85 + (i / 8) * PI * 1.7;
      B.put('root', CONE(), BONE, {
        x: Math.sin(a) * 0.150, y: 0.965 + Math.cos(a) * 0.045, z: -0.190 + Math.cos(a) * 0.105,
        sx: 0.030, sy: 0.135, sz: 0.024, rx: Math.cos(a) * 0.9, rz: -Math.sin(a) * 0.9, shine: true,
      });
    }
    // 头（动画节点）
    B.node('head', 'root', 0, 1.080, -0.265);
    B.put('head', SPH_HI(), RUST, { sx: 0.165, sy: 0.145, sz: 0.132 });
    B.put('head', SPH(), RUST_D, { y: -0.045, z: -0.100, sx: 0.105, sy: 0.080, sz: 0.060 });
    // 獠牙 + 张口
    addOpenMouth(B, 'head', { y: -0.062, z: -0.128, w: 0.062, h: 0.045, color: DARK, tongue: 0xd04a5a });
    addFangs(B, 'head', { n: 2, gap: 0.055, y: -0.045, z: -0.140, w: 0.018, h: 0.055, color: BONE });
    addFangs(B, 'head', { n: 2, gap: 0.040, y: -0.098, z: -0.126, w: 0.012, h: 0.030, color: BONE });
    // 金瞳
    addEyes(B, 'head', { y: 0.048, z: -0.100, spread: 0.076, r: 0.040, style: 'full', white: 0xfff6d8, iris: 0xffc933, pupil: 0x2a1408, wz: 0.60 });
    B.put('head', SPH(), RUST_D, { y: 0.088, z: -0.092, sx: 0.092, sy: 0.020, sz: 0.030, rz: -0.10 });
    B.put('head', SPH(), RUST_D, { y: 0.088, z: -0.092, sx: 0.092, sy: 0.020, sz: 0.030, rz: 0.10 });
    // 独角（额前一枝）
    B.put('head', CONE(), BONE, { y: 0.140, z: -0.020, sx: 0.045, sy: 0.260, sz: 0.040, rx: -0.16, shine: true });
    B.put('head', CONE(), BONE, { y: 0.240, z: -0.055, sx: 0.026, sy: 0.130, sz: 0.024, rx: -0.30, shine: true });
    // 耳
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), RUST, { x: s * 0.125, y: 0.100, z: 0.020, sx: 0.046, sy: 0.058, sz: 0.032, rz: s * 0.30 });
      B.put('head', SPH(), DARK, { x: s * 0.140, y: 0.105, z: 0.014, sx: 0.022, sy: 0.030, sz: 0.016, rz: s * 0.30 });
    }
    // 五条尾巴（动画节点，扇形）
    for (let i = 0; i < 5; i++) {
      const k = i - 2;
      const nm = 'tail_' + (i + 1);
      const n = B.node(nm, 'root', k * 0.055, 0.820, 0.270);
      n.rotation.y = k * 0.22;
      n.rotation.z = -k * 0.06;
      capChain(B, nm, [[0, 0, 0], [0, 0.090, 0.060], [0, 0.165, 0.095]], [0.040, 0.030, 0.020], RUST);
      B.put(nm, CONE(), BONE, { y: 0.205, z: 0.105, sx: 0.025, sy: 0.075, sz: 0.020, rx: 1.15, shine: true });
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.011);
      nodes.head.rotation.x = Math.sin(t * 1.4) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 0.8) * 0.10;
      for (let i = 0; i < 5; i++) {
        const n = nodes['tail_' + (i + 1)];
        const k = i - 2;
        n.rotation.y = k * 0.22 + Math.sin(t * 1.6 + i * 0.5) * 0.10;
        n.rotation.x = Math.sin(t * 1.2 + i * 0.7) * 0.09;
        n.rotation.z = -k * 0.06 + Math.sin(t * 1.05 + i * 0.4) * 0.05;
      }
    }, { fitH: 1.35 });
  }

  // =========================================================================
  // 7) 九尾狐 — 白狐、九条飘尾、金瞳、额间朱纹（h 0.92 / r 0.34）
  // =========================================================================
  function buildJiuwei() {
    const B = Builder();
    const WHITE = 0xf4f1e8, WHITE_D = 0xd9d2c0, RED = 0xe8453c, PINK = 0xf08bb4, DARK = 0x33241e;

    // 四条细狐腿 + 爪
    const LEGS = [[-0.085, -0.105], [0.085, -0.105], [-0.090, 0.115], [0.090, 0.115]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.030, 0.150), WHITE, { x: lx, y: 0.155, z: lz });
      B.put('root', CAPSULE(0.024, 0.09), WHITE_D, { x: lx, y: 0.055, z: lz });
      B.put('root', SPH(), WHITE, { x: lx, y: 0.028, z: lz - 0.024, sx: 0.036, sy: 0.026, sz: 0.052 });
      addClaws(B, 'root', { x: lx, y: 0.024, z: lz - 0.070, r: 0.008, len: 0.022, spread: 0.013, color: 0xfff6e0 });
    }
    // 躯干
    B.put('root', SPH_HI(), WHITE, { y: 0.400, sx: 0.150, sy: 0.140, sz: 0.215 });
    B.put('root', SPH(), WHITE_D, { y: 0.350, z: -0.020, sx: 0.115, sy: 0.095, sz: 0.190 });
    B.put('root', SPH(), WHITE, { y: 0.450, z: -0.130, sx: 0.115, sy: 0.120, sz: 0.105 });
    // 颈 + 头
    capChain(B, 'root', [[0, 0.480, -0.130], [0, 0.580, -0.155], [0, 0.660, -0.165]], [0.080, 0.068, 0.058], WHITE);
    B.node('head', 'root', 0, 0.700, -0.175);
    B.put('head', SPH_HI(), WHITE, { sx: 0.110, sy: 0.095, sz: 0.105 });
    B.put('head', SPH(), WHITE, { y: -0.040, z: -0.090, sx: 0.062, sy: 0.048, sz: 0.052 });
    B.put('head', SPH(), DARK, { y: -0.032, z: -0.135, sx: 0.014, sy: 0.010, sz: 0.010 });
    addEyes(B, 'head', { y: 0.028, z: -0.076, spread: 0.055, r: 0.028, style: 'full', white: 0xfffdf6, iris: 0xffc933, pupil: 0x2a1a0a, wz: 0.55 });
    // 额间朱纹（菱花）
    B.put('head', SPH(), RED, { y: 0.078, z: -0.070, sx: 0.020, sy: 0.022, sz: 0.012, rz: 0.79 });
    B.put('head', SPH(), RED, { y: 0.078, z: -0.068, sx: 0.014, sy: 0.016, sz: 0.010, rz: -0.79 });
    // 长耳（动画节点）
    const earL = B.node('ear_l', 'head', -0.055, 0.072, 0.010);
    const earR = B.node('ear_r', 'head', 0.055, 0.072, 0.010);
    earL.rotation.z = 0.26; earR.rotation.z = -0.26;
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ear_l' : 'ear_r';
      B.put(nm, CONE(), WHITE, { y: 0.060, sx: 0.032, sy: 0.145, sz: 0.018, rz: s * 0.06 });
      B.put(nm, CONE(), PINK, { y: 0.052, z: -0.010, sx: 0.016, sy: 0.100, sz: 0.008, rz: s * 0.06 });
    }
    // 九条飘尾：三组节点（每组三片），组间左右扇开，白底朱尖
    for (let g = 0; g < 3; g++) {
      const nm = ['tail_a', 'tail_b', 'tail_c'][g];
      const n = B.node(nm, 'root', (g - 1) * 0.075, 0.445, 0.195);
      n.rotation.y = (g - 1) * 0.55;
      n.rotation.z = (g - 1) * -0.10;
      B.put(nm, SPH(), WHITE, { y: 0.014, z: 0.004, sx: 0.078, sy: 0.066, sz: 0.058 });
      for (let i = 0; i < 3; i++) {
        const k = i - 1;
        const len = 0.250 - Math.abs(k) * 0.020;
        const rx = 0.22 + Math.abs(k) * 0.34;
        const rz = k * 0.34 + (g - 1) * 0.16;
        B.put(nm, leafGeo(0.100, len, 0.020), i % 2 ? WHITE : WHITE_D, {
          x: k * 0.034, y: 0.012, z: 0.010, rx: rx, rz: rz,
        });
        const tipY = len * Math.cos(rx);
        const tipZ = len * Math.sin(rx);
        B.put(nm, leafGeo(0.070, len * 0.46, 0.016), RED, {
          x: k * 0.034 + Math.sin(rz) * 0.012, y: 0.012 + tipY * 0.56, z: 0.010 + tipZ * 0.56,
          rx: rx, rz: rz,
        });
        B.put(nm, SPH(), RED, { x: k * 0.034 + Math.sin(rz) * 0.040, y: 0.012 + tipY * 0.94, z: 0.010 + tipZ * 0.94, sx: 0.022, sy: 0.022, sz: 0.018 });
      }
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.011);
      nodes.head.rotation.x = Math.sin(t * 1.5) * 0.05;
      nodes.head.rotation.z = Math.sin(t * 0.9) * 0.04;
      nodes.ear_l.rotation.z = 0.26 + Math.sin(t * 2.2) * 0.09;
      nodes.ear_r.rotation.z = -0.26 - Math.sin(t * 2.2 + 0.6) * 0.09;
      const tails = ['tail_a', 'tail_b', 'tail_c'];
      for (let g = 0; g < 3; g++) {
        const n = nodes[tails[g]];
        n.rotation.y = (g - 1) * 0.42 + Math.sin(t * 1.25 + g * 0.9) * 0.15;
        n.rotation.z = Math.sin(t * 1.05 + g * 1.3) * 0.10;
      }
    }, { fitH: 0.92 });
  }

  // =========================================================================
  // 8) 鲛人 — 人鱼、长发、鳞尾、珠光、张口吟唱（h 0.60 / r 0.28）
  // =========================================================================
  function buildJiaoren() {
    const B = Builder();
    const PALE = 0xcfe8e2, SCALE = 0x4fb9c9, SCALE_D = 0x2f8a9a, PEARL = 0xfffdf5, HAIR = 0x2f6a7a;

    // 鱼尾（人鱼下摆）：锥形鳞尾 + 尾鳍（动画节点）
    capChain(B, 'root', [[0, 0.330, 0.000], [0, 0.240, 0.020], [0, 0.150, 0.060], [0, 0.085, 0.105]], [0.092, 0.080, 0.062, 0.042], SCALE);
    B.node('tail_fin', 'root', 0, 0.085, 0.100);
    B.put('tail_fin', leafGeo(0.125, 0.160, 0.018), SCALE, { y: 0.005, z: 0.010, rx: 1.72 });
    B.put('tail_fin', leafGeo(0.078, 0.120, 0.014), SCALE_D, { y: 0.000, z: 0.016, rx: 1.86 });
    // 腰际鳞带
    ringBand(B, 'root', { y: 0.315, R: 1, tube: 0.022, sx: 0.096, sy: 0.082, color: SCALE_D });
    // 鳞片点缀（前排 + 侧排）
    const TILES = [
      [0.000, 0.298, -0.086], [0.046, 0.286, -0.078], [-0.046, 0.286, -0.078],
      [0.000, 0.224, -0.062], [0.040, 0.214, -0.054], [-0.040, 0.214, -0.054],
      [0.000, 0.164, -0.022], [0.030, 0.155, -0.016], [-0.030, 0.155, -0.016],
    ];
    for (let i = 0; i < TILES.length; i++) {
      const p = TILES[i];
      B.put('root', SPH(), i % 2 ? SCALE_D : SCALE, { x: p[0], y: p[1], z: p[2], sx: 0.017, sy: 0.013, sz: 0.008, shine: true });
    }
    // 上身 + 腰饰
    B.put('root', SPH(), PALE, { y: 0.360, sx: 0.093, sy: 0.115, sz: 0.078 });
    B.put('root', SPH(), SCALE_D, { y: 0.300, z: -0.005, sx: 0.088, sy: 0.030, sz: 0.076 });
    // 双臂 + 合掌吟唱
    for (let s = -1; s <= 1; s += 2) {
      B.put('root', CAPSULE(0.022, 0.075), PALE, { x: s * 0.090, y: 0.395, z: -0.020, rx: -0.55, rz: s * 0.30 });
      B.put('root', CAPSULE(0.019, 0.070), PALE, { x: s * 0.062, y: 0.345, z: -0.075, rx: -1.15, rz: s * 0.55 });
      B.put('root', SPH(), PALE, { x: s * 0.038, y: 0.320, z: -0.108, sx: 0.026, sy: 0.026, sz: 0.024 });
    }
    // 珍珠项圈
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      B.put('root', SPH(), PEARL, { x: Math.sin(a) * 0.075, y: 0.300 - Math.cos(a) * 0.010, z: -0.045 - Math.cos(a) * 0.030, sx: 0.013, sy: 0.013, sz: 0.011, shine: true });
    }
    // 头（动画节点）
    B.node('head', 'root', 0, 0.495, -0.010);
    B.put('head', SPH_HI(), PALE, { sx: 0.098, sy: 0.100, sz: 0.092 });
    // 长发（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'hair_l' : 'hair_r';
      B.node(nm, 'head', s * 0.062, 0.020, 0.030);
      capChain(B, nm, [[0, 0, 0], [s * 0.025, -0.085, 0.045], [s * 0.045, -0.180, 0.060]], [0.038, 0.030, 0.020], HAIR);
      B.put(nm, leafGeo(0.020, 0.070, 0.010), HAIR, { x: s * 0.048, y: -0.190, z: 0.062, rx: 0.9, rz: s * 0.2 });
    }
    B.put('head', HEMI(), HAIR, { y: 0.022, z: 0.012, sx: 0.090, sy: 0.070, sz: 0.086 });
    B.put('head', SPH(), HAIR, { y: 0.055, z: 0.055, sx: 0.070, sy: 0.055, sz: 0.050 });
    // 人面：眼睛 / 张口吟唱 / 腮红
    addEyes(B, 'head', { y: 0.012, z: -0.070, spread: 0.048, r: 0.028, style: 'full', white: 0xfffdf8, iris: 0x2f6fae, pupil: 0x1d2430, wz: 0.55 });
    addOpenMouth(B, 'head', { y: -0.046, z: -0.082, w: 0.032, h: 0.030, color: 0x8a3a4a, tongue: 0xe8909a });
    addCheeks(B, 'head', { y: -0.020, z: -0.066, spread: 0.070, r: 0.020, color: 0xf0a0a8 });
    // 额心珠饰
    B.put('head', SPH(), PEARL, { y: 0.062, z: -0.058, sx: 0.014, sy: 0.016, sz: 0.010, shine: true });
    // 颈
    B.put('root', CAPSULE(0.032, 0.055), PALE, { y: 0.455, sx: 1, sy: 1, sz: 1 });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.010);
      nodes.head.rotation.x = Math.sin(t * 1.3) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 0.9) * 0.12;
      nodes.hair_l.rotation.z = 0.10 + Math.sin(t * 1.5) * 0.10;
      nodes.hair_r.rotation.z = -0.10 - Math.sin(t * 1.5 + 0.5) * 0.10;
      nodes.hair_l.rotation.x = Math.sin(t * 1.15 + 0.3) * 0.07;
      nodes.hair_r.rotation.x = Math.sin(t * 1.15 + 0.8) * 0.07;
      nodes.tail_fin.rotation.y = Math.sin(t * 1.7) * 0.20;
      nodes.tail_fin.rotation.z = Math.sin(t * 1.1) * 0.10;
    }, { fitH: 0.60 });
  }

  // =========================================================================
  // 9) 魑魅 — 无足飘浮精魅、雾状下摆、青光眼、长耳（h 0.85 / r 0.40）
  // =========================================================================
  function buildChimei() {
    const B = Builder();
    const MIST = 0x8a6ac8, MIST_L = 0xb39ae0, DEEP = 0x4c3580, CYAN = 0x7af0d0, DARK = 0x1e1430;

    // 雾状下摆（动画节点）：无足，数团紫雾层层收拢
    B.node('skirt', 'root', 0, 0.440, 0);
    const PUFFS = [
      [0, 0.030, 0, 0.215, 0.120, 0.180, 0.72],
      [0.165, -0.045, 0.030, 0.165, 0.110, 0.150, 0.68],
      [-0.160, -0.040, -0.030, 0.165, 0.110, 0.150, 0.68],
      [0.205, -0.140, 0.060, 0.140, 0.100, 0.130, 0.62],
      [-0.200, -0.130, -0.060, 0.140, 0.100, 0.130, 0.62],
      [0.075, -0.230, 0.050, 0.130, 0.100, 0.120, 0.58],
      [-0.080, -0.225, -0.050, 0.130, 0.100, 0.120, 0.58],
      [0.015, -0.320, 0.020, 0.115, 0.095, 0.105, 0.54],
      [-0.010, -0.355, 0.045, 0.095, 0.085, 0.090, 0.50],
    ];
    for (let i = 0; i < PUFFS.length; i++) {
      const p = PUFFS[i];
      B.put('skirt', SPH(), i % 2 ? MIST : MIST_L, {
        x: p[0], y: p[1], z: p[2], sx: p[3], sy: p[4], sz: p[5], glass: p[6],
      });
    }
    // 雾丝（下摆拖尾，让"飘浮"更明显）
    for (let i = 0; i < 5; i++) {
      const a = i * TAU / 5 + 0.4;
      B.put('skirt', leafGeo(0.030, 0.120, 0.010), i % 2 ? DEEP : MIST, {
        x: Math.cos(a) * 0.085, y: -0.300, z: Math.sin(a) * 0.080, rx: PI, rz: Math.cos(a) * 0.30, glass: 0.42,
      });
    }
    // 上身 + 头
    B.put('root', SPH_HI(), MIST, { y: 0.545, sx: 0.120, sy: 0.140, sz: 0.105, glass: 0.86 });
    B.put('root', SPH(), MIST_L, { y: 0.575, z: -0.050, sx: 0.080, sy: 0.090, sz: 0.056, glass: 0.84 });
    B.put('root', SPH(), MIST, { y: 0.628, sx: 0.064, sy: 0.052, sz: 0.058, glass: 0.9 });
    B.node('head', 'root', 0, 0.700, -0.010);
    B.put('head', SPH_HI(), MIST_L, { sx: 0.115, sy: 0.108, sz: 0.102, glass: 0.88 });
    // 长耳（动画节点，尖长后掠）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'ear_l' : 'ear_r';
      B.node(nm, 'head', s * 0.082, 0.050, 0.010);
      B.put(nm, CONE(), MIST, { y: 0.072, sx: 0.026, sy: 0.170, sz: 0.015, rz: s * -0.62, shine: true });
      B.put(nm, CONE(), CYAN, { y: 0.062, z: -0.008, sx: 0.012, sy: 0.100, sz: 0.008, rz: s * -0.62, glow: CYAN, glowInt: 1.1 });
    }
    // 青光眼 + 怪笑
    glowEyes(B, 'head', { y: 0.020, z: -0.082, spread: 0.050, r: 0.026, color: CYAN, glowInt: 2.1, sy: 1.35 });
    addOpenMouth(B, 'head', { y: -0.045, z: -0.086, w: 0.040, h: 0.035, color: DARK });
    addTeethRow(B, 'head', { n: 4, w: 0.012, gap: 0.016, y: -0.032, z: -0.100, h: 0.016, color: 0xe8f8f4 });
    // 雾状手臂
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'arm_l' : 'arm_r';
      B.node(nm, 'root', s * 0.155, 0.580, -0.020);
      capChain(B, nm, [[0, 0, 0], [s * 0.130, -0.060, -0.070], [s * 0.245, -0.150, -0.110]], [0.042, 0.034, 0.022], MIST, { glass: 0.7 });
    }

    return finishModel(B, function (nodes, dt, t) {
      const n = nodes.inner || nodes.root;
      if (n) n.position.y = (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.035;
      nodes.head.rotation.x = Math.sin(t * 1.2) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.7 + 0.5) * 0.14;
      nodes.ear_l.rotation.z = 0.20 + Math.sin(t * 1.8) * 0.10;
      nodes.ear_r.rotation.z = -0.20 - Math.sin(t * 1.8 + 0.5) * 0.10;
      nodes.skirt.rotation.y = Math.sin(t * 0.8) * 0.14;
      nodes.skirt.rotation.z = Math.sin(t * 1.1 + 0.4) * 0.07;
      nodes.arm_l.rotation.x = Math.sin(t * 1.4) * 0.12;
      nodes.arm_r.rotation.x = Math.sin(t * 1.4 + 1.1) * 0.12;
    }, { fitH: 0.85 });
  }

  // =========================================================================
  // 10) 魍魉 — 墨影魍魉、双角、烟雾下摆、利爪（h 1.45 / r 0.50）
  // =========================================================================
  function buildWangliang() {
    const B = Builder();
    const SHADE = 0x3a2a4a, DEEP = 0x241a33, MIST = 0x5a4470, RED = 0xe8453c, CLAW = 0xe8e0d0, BONE = 0xe8dcc0;

    // 烟雾下摆（动画节点）：无腿，墨紫烟团堆叠
    B.node('skirt', 'root', 0, 0.640, 0);
    const PUFFS = [
      [0, 0.020, 0.020, 0.300, 0.190, 0.300],
      [0.300, -0.100, 0.040, 0.200, 0.160, 0.180],
      [-0.290, -0.090, -0.050, 0.200, 0.160, 0.180],
      [0.160, -0.260, 0.100, 0.170, 0.140, 0.160],
      [-0.170, -0.270, -0.080, 0.170, 0.140, 0.160],
      [0.030, -0.420, 0.040, 0.140, 0.120, 0.130],
      [-0.040, -0.520, 0.050, 0.120, 0.110, 0.110],
    ];
    for (let i = 0; i < PUFFS.length; i++) {
      const p = PUFFS[i];
      B.put('skirt', SPH(), i % 2 ? SHADE : MIST, {
        x: p[0], y: p[1], z: p[2], sx: p[3], sy: p[4], sz: p[5], glass: 0.78,
      });
    }
    for (let i = 0; i < 5; i++) {
      const a = i * TAU / 5 + 0.3;
      B.put('skirt', leafGeo(0.040, 0.120, 0.014), i % 2 ? DEEP : SHADE, {
        x: Math.cos(a) * 0.190, y: -0.520, z: Math.sin(a) * 0.175, rx: PI, rz: Math.cos(a) * 0.30, glass: 0.62,
      });
    }
    // 躯干
    B.put('root', SPH_HI(), SHADE, { y: 0.920, sx: 0.205, sy: 0.235, sz: 0.175 });
    B.put('root', SPH(), DEEP, { y: 0.960, z: -0.100, sx: 0.150, sy: 0.160, sz: 0.100 });
    // 肩甲
    for (let s = -1; s <= 1; s += 2) {
      B.put('root', SPH(), DEEP, { x: s * 0.195, y: 1.060, z: -0.010, sx: 0.095, sy: 0.090, sz: 0.105 });
      B.put('root', CONE(), SHADE, { x: s * 0.245, y: 1.105, z: 0.000, sx: 0.040, sy: 0.120, sz: 0.035, rz: -s * 0.85 });
    }
    // 双臂 + 利爪（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'arm_l' : 'arm_r';
      B.node(nm, 'root', s * 0.215, 1.030, -0.020);
      capChain(B, nm, [[0, 0, 0], [s * 0.085, -0.150, -0.080], [s * 0.075, -0.320, -0.170]], [0.060, 0.050, 0.038], SHADE);
      B.put(nm, SPH(), DEEP, { x: s * 0.075, y: -0.335, z: -0.185, sx: 0.045, sy: 0.042, sz: 0.040 });
      for (let k = 0; k < 3; k++) {
        B.put(nm, CONE(), CLAW, {
          x: s * 0.075 + (k - 1) * 0.022, y: -0.360, z: -0.225,
          sx: 0.012, sy: 0.075, sz: 0.010, rx: -1.90, rz: (k - 1) * 0.18, shine: true,
        });
      }
    }
    // 头（动画节点）
    B.node('head', 'root', 0, 1.175, -0.020);
    B.put('head', SPH_HI(), SHADE, { sx: 0.135, sy: 0.128, sz: 0.122 });
    B.put('head', SPH(), DEEP, { y: -0.030, z: -0.080, sx: 0.095, sy: 0.080, sz: 0.060 });
    // 赤目 + 咧嘴獠牙
    glowEyes(B, 'head', { y: 0.028, z: -0.098, spread: 0.052, r: 0.030, color: RED, glowInt: 2.2, sy: 1.05 });
    B.put('head', SPH(), 0x140b18, { y: -0.055, z: -0.092, sx: 0.085, sy: 0.042, sz: 0.030 });
    addTeethRow(B, 'head', { n: 5, w: 0.016, gap: 0.022, y: -0.052, z: -0.112, h: 0.022, color: BONE });
    // 双角（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'horn_l' : 'horn_r';
      B.node(nm, 'head', s * 0.082, 0.080, 0.000);
      capChain(B, nm, [[0, 0, 0], [s * 0.050, 0.095, 0.020], [s * 0.020, 0.190, 0.055]], [0.040, 0.030, 0.018], BONE);
      B.put(nm, SPH(), RED, { x: s * 0.020, y: 0.196, z: 0.058, sx: 0.012, sy: 0.014, sz: 0.012, glow: RED, glowInt: 1.4 });
    }
    // 颈
    B.put('root', CAPSULE(0.070, 0.060), SHADE, { y: 1.090, z: -0.010 });

    return finishModel(B, function (nodes, dt, t) {
      const n = nodes.inner || nodes.root;
      if (n) n.position.y = (Math.sin(t * 1.35) * 0.5 + 0.5) * 0.040;
      nodes.head.rotation.x = Math.sin(t * 1.1) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.65 + 0.4) * 0.12;
      nodes.skirt.rotation.y = Math.sin(t * 0.7) * 0.10;
      nodes.arm_l.rotation.z = 0.06 + Math.sin(t * 1.5) * 0.08;
      nodes.arm_r.rotation.z = -0.06 - Math.sin(t * 1.5 + 0.7) * 0.08;
      nodes.arm_l.rotation.x = Math.sin(t * 1.2 + 0.3) * 0.08;
      nodes.arm_r.rotation.x = Math.sin(t * 1.2 + 1.0) * 0.08;
      nodes.horn_l.rotation.z = 0.06 + Math.sin(t * 1.8) * 0.05;
      nodes.horn_r.rotation.z = -0.06 - Math.sin(t * 1.8 + 0.5) * 0.05;
    }, { fitH: 1.45 });
  }

  // =========================================================================
  // 11) 赤鱬 — 鱼身人面、大眼、金鳍、吐水泡（h 0.86 / r 0.34）
  // =========================================================================
  function buildChiru() {
    const B = Builder();
    const RED = 0xe8563c, RED_D = 0xc2452e, GOLD = 0xffd93d, SKIN = 0xf2d2b8, PEARL = 0xd8f4ff;

    // 立姿鱼身
    B.put('root', SPH_HI(), RED, { y: 0.390, sx: 0.170, sy: 0.260, sz: 0.145 });
    B.put('root', SPH(), RED_D, { y: 0.335, z: 0.020, sx: 0.140, sy: 0.210, sz: 0.112 });
    B.put('root', SPH(), 0xf0a080, { y: 0.360, z: -0.115, sx: 0.105, sy: 0.160, sz: 0.045 });
    B.put('root', CAPSULE(0.058, 0.050), SKIN, { y: 0.545, z: -0.010 });
    // 鱼身金鳞点缀
    for (let i = 0; i < 4; i++) {
      B.put('root', SPH(), GOLD, { x: (i % 2 ? 1 : -1) * 0.140, y: 0.300 + i * 0.055, z: -0.020 + i * 0.010, sx: 0.022, sy: 0.016, sz: 0.028, shine: true });
    }
    // 背鳍（金）+ 尾鳍（动画节点）
    B.put('root', leafGeo(0.050, 0.180, 0.012), GOLD, { y: 0.600, z: 0.070, rx: 0.40, shine: true });
    B.node('tail_fin', 'root', 0, 0.155, 0.120);
    B.put('tail_fin', leafGeo(0.095, 0.215, 0.014), GOLD, { y: 0.010, z: 0.005, rx: 1.95, shine: true });
    B.put('tail_fin', leafGeo(0.060, 0.150, 0.012), 0xf0b030, { x: 0.040, y: 0.005, z: 0.005, rx: 2.05, rz: -0.30 });
    B.put('tail_fin', leafGeo(0.060, 0.150, 0.012), 0xf0b030, { x: -0.040, y: 0.005, z: 0.005, rx: 2.05, rz: 0.30 });
    // 侧鳍（动画节点）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'fin_l' : 'fin_r';
      B.node(nm, 'root', s * 0.165, 0.420, -0.020);
      B.put(nm, leafGeo(0.070, 0.165, 0.012), GOLD, { x: s * 0.010, y: 0.010, z: 0.010, rz: -s * 2.05, rx: 0.20, shine: true });
    }
    // 人面头（动画节点）
    B.node('head', 'root', 0, 0.655, -0.020);
    B.put('head', SPH_HI(), SKIN, { sx: 0.118, sy: 0.110, sz: 0.104 });
    B.put('head', SPH(), SKIN, { y: -0.034, z: -0.080, sx: 0.082, sy: 0.070, sz: 0.056 });
    // 大眼 + 金瞳
    addEyes(B, 'head', { y: 0.016, z: -0.078, spread: 0.068, r: 0.045, style: 'full', white: 0xfffdf8, iris: 0xffc933, pupil: 0x2a1a0a, wz: 0.60 });
    B.put('head', SPH(), RED_D, { y: 0.080, z: -0.068, sx: 0.088, sy: 0.013, sz: 0.026, rz: -0.06 });
    // 吐水泡的嘴
    addOpenMouth(B, 'head', { y: -0.050, z: -0.088, w: 0.034, h: 0.032, color: 0x8a3a3a, tongue: 0xf09090 });
    addCheeks(B, 'head', { y: -0.022, z: -0.070, spread: 0.070, r: 0.018, color: 0xf5a090 });
    // 头顶金鳍冠（撑起高度）
    B.put('head', leafGeo(0.045, 0.150, 0.012), GOLD, { y: 0.080, z: 0.015, rx: -0.18, shine: true });
    B.put('head', leafGeo(0.030, 0.105, 0.010), 0xf0b030, { x: 0.045, y: 0.075, z: 0.020, rx: -0.25, rz: -0.42 });
    B.put('head', leafGeo(0.030, 0.105, 0.010), 0xf0b030, { x: -0.045, y: 0.075, z: 0.020, rx: -0.25, rz: 0.42 });
    // 水泡（动画节点）
    B.node('bubbles', 'root', 0, 0.600, -0.145);
    const BUB = [[0.000, 0.020, -0.020, 0.026], [0.030, 0.120, -0.045, 0.019], [-0.025, 0.205, -0.060, 0.014], [0.020, 0.280, -0.075, 0.010]];
    for (let i = 0; i < BUB.length; i++) {
      const b = BUB[i];
      B.put('bubbles', SPH(), PEARL, { x: b[0], y: b[1], z: b[2], sx: b[3], sy: b[3], sz: b[3], glow: 0xbfe8ff, glowInt: 0.9, glass: 0.5 });
    }

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.010);
      nodes.head.rotation.x = Math.sin(t * 1.35) * 0.05;
      nodes.head.rotation.y = Math.sin(t * 0.85 + 0.3) * 0.10;
      nodes.fin_l.rotation.z = 0.10 + Math.sin(t * 2.4) * 0.16;
      nodes.fin_r.rotation.z = -0.10 - Math.sin(t * 2.4 + 0.5) * 0.16;
      nodes.tail_fin.rotation.y = Math.sin(t * 1.9) * 0.22;
      nodes.bubbles.position.y = 0.600 + Math.sin(t * 1.2) * 0.012;
      nodes.bubbles.rotation.y = t * 0.6;
    }, { fitH: 0.86 });
  }

  // =========================================================================
  // 12) 饕餮 — 青铜巨兽、巨口獠牙、羊角、金纹、腹大（h 2.20 / r 0.82）
  // =========================================================================
  function buildTaotie() {
    const B = Builder();
    const BRONZE = 0x6b8a5a, BRONZE_D = 0x4e6a42, GOLD = 0xe8b33a, BONE = 0xfff6e0;
    const DARK = 0x2a3624, MOUTH = 0x3a1212;

    // 四条粗壮兽腿 + 巨爪
    const LEGS = [[-0.360, -0.300], [0.360, -0.300], [-0.370, 0.330], [0.370, 0.330]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.130, 0.300), BRONZE, { x: lx, y: 0.430, z: lz });
      B.put('root', CAPSULE(0.105, 0.180), BRONZE_D, { x: lx, y: 0.170, z: lz - 0.012 });
      B.put('root', SPH(), BRONZE_D, { x: lx, y: 0.070, z: lz - 0.080, sx: 0.170, sy: 0.100, sz: 0.240 });
      addClaws(B, 'root', { x: lx, y: 0.055, z: lz - 0.270, r: 0.022, len: 0.065, spread: 0.036, color: BONE });
    }
    // 巨腹（动画节点，呼吸更明显）
    B.node('belly', 'root', 0, 0.960, 0);
    B.put('belly', SPH_HI(), BRONZE, { sx: 0.575, sy: 0.500, sz: 0.590 });
    B.put('belly', SPH(), 0x9cb884, { y: -0.030, z: -0.420, sx: 0.330, sy: 0.280, sz: 0.190 });
    B.put('belly', SPH(), 0xb9cf9a, { y: 0.075, z: -0.455, sx: 0.220, sy: 0.140, sz: 0.130 });
    // 腹部金纹（贴在腹甲表面的云雷纹：金环弧 + 金点）
    for (let i = 0; i < 2; i++) {
      const sx = i ? -1 : 1;
      B.put('belly', TORUS(0.105, 0.016, PI * 1.40), GOLD, { x: sx * 0.140, y: -0.020, z: -0.632, rz: i ? -0.8 : 0.8, shine: true });
      B.put('belly', TORUS(0.055, 0.013, PI * 1.50), GOLD, { x: sx * 0.225, y: -0.130, z: -0.598, rz: i ? 2.0 : -2.0, shine: true });
    }
    for (let i = 0; i < 5; i++) {
      B.put('belly', SPH(), GOLD, { x: Math.sin(i * 1.5) * 0.150, y: -0.155 + i * 0.030, z: -0.600, sx: 0.020, sy: 0.020, sz: 0.012, shine: true });
    }
    // 胸前金饰（青铜兽面的额饰）
    B.put('root', SPH(), GOLD, { y: 1.345, z: -0.392, sx: 0.072, sy: 0.036, sz: 0.016, rx: 0.24, shine: true });
    B.put('root', TORUS(0.052, 0.012, PI * 1.1), GOLD, { x: 0.155, y: 1.300, z: -0.368, rz: 0.5, shine: true });
    B.put('root', TORUS(0.052, 0.012, PI * 1.1), GOLD, { x: -0.155, y: 1.300, z: -0.368, rz: -0.5, shine: true });
    // 背脊金刺（沿脊梁一排）
    for (let i = 0; i < 6; i++) {
      B.put('root', CONE(), GOLD, { y: 1.390 - i * 0.012, z: -0.230 + i * 0.130, sx: 0.045, sy: 0.150 - i * 0.012, sz: 0.036, rx: 0.30, shine: true });
    }
    // 肩胸
    B.put('root', SPH_HI(), BRONZE, { y: 1.300, z: -0.110, sx: 0.520, sy: 0.380, sz: 0.430 });
    B.put('root', SPH(), BRONZE_D, { y: 1.330, z: -0.250, sx: 0.400, sy: 0.280, sz: 0.240 });
    // 尾（动画节点）：短壮 + 金铃
    B.node('tail', 'root', 0, 1.020, 0.540);
    capChain(B, 'tail', [[0, 0, 0], [0, 0.075, 0.100], [0, 0.160, 0.170]], [0.095, 0.075, 0.050], BRONZE);
    B.put('tail', SPH(), GOLD, { y: 0.205, z: 0.195, sx: 0.070, sy: 0.070, sz: 0.070, shine: true });
    // 头（动画节点）
    B.node('head', 'root', 0, 1.620, -0.300);
    B.put('head', SPH_HI(), BRONZE, { sx: 0.420, sy: 0.340, sz: 0.380 });
    B.put('head', SPH(), BRONZE_D, { y: 0.120, z: -0.150, sx: 0.340, sy: 0.180, sz: 0.260 });
    // 巨口：口腔 + 上齿 + 下颚
    B.put('head', SPH(), MOUTH, { y: -0.095, z: -0.270, sx: 0.260, sy: 0.160, sz: 0.160 });
    B.put('head', SPH(), 0x8a2a2a, { y: -0.150, z: -0.300, sx: 0.170, sy: 0.070, sz: 0.090 });
    B.put('head', SPH(), BRONZE, { y: 0.020, z: -0.300, sx: 0.320, sy: 0.110, sz: 0.150 });
    // 上排獠牙（朝下）
    for (let i = 0; i < 6; i++) {
      const x = (i - 2.5) * 0.078;
      B.put('head', CONE(), BONE, { x: x, y: -0.050, z: -0.352, sx: 0.024, sy: 0.090, sz: 0.020, rx: PI, shine: true });
    }
    B.put('head', CONE(), BONE, { x: 0.245, y: -0.030, z: -0.330, sx: 0.030, sy: 0.130, sz: 0.026, rx: PI, shine: true });
    B.put('head', CONE(), BONE, { x: -0.245, y: -0.030, z: -0.330, sx: 0.030, sy: 0.130, sz: 0.026, rx: PI, shine: true });
    // 下颚（动画节点：开合）
    B.node('jaw', 'head', 0, -0.150, -0.170);
    B.put('jaw', SPH(), BRONZE_D, { y: -0.020, z: -0.040, sx: 0.300, sy: 0.110, sz: 0.250 });
    B.put('jaw', SPH(), 0x9cb884, { y: 0.020, z: -0.190, sx: 0.220, sy: 0.060, sz: 0.130 });
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 0.078;
      B.put('jaw', CONE(), BONE, { x: x, y: 0.070, z: -0.230, sx: 0.022, sy: 0.080, sz: 0.018, shine: true });
    }
    // 金瞳 + 眉骨
    B.put('head', SPH(), GOLD, { x: 0.185, y: 0.190, z: -0.300, sx: 0.075, sy: 0.060, sz: 0.050, glow: GOLD, glowInt: 1.7, shine: true });
    B.put('head', SPH(), GOLD, { x: -0.185, y: 0.190, z: -0.300, sx: 0.075, sy: 0.060, sz: 0.050, glow: GOLD, glowInt: 1.7, shine: true });
    B.put('head', SPH(), BRONZE_D, { x: 0.185, y: 0.245, z: -0.290, sx: 0.120, sy: 0.040, sz: 0.090, rz: -0.18 });
    B.put('head', SPH(), BRONZE_D, { x: -0.185, y: 0.245, z: -0.290, sx: 0.120, sy: 0.040, sz: 0.090, rz: 0.18 });
    // 羊角（动画节点，向两侧卷起）
    for (let s = -1; s <= 1; s += 2) {
      const nm = s < 0 ? 'horn_l' : 'horn_r';
      B.node(nm, 'head', s * 0.300, 0.235, 0.010);
      capChain(B, nm, [[0, 0, 0], [s * 0.060, 0.140, -0.020], [s * 0.030, 0.260, 0.040], [-s * 0.050, 0.330, 0.110]], [0.085, 0.075, 0.055, 0.034], 0xd9b86a);
      B.put(nm, TORUS(0.050, 0.016, TAU), GOLD, { x: s * 0.045, y: 0.150, z: -0.012, rz: -s * 1.2, shine: true });
    }
    // 耳 + 颊部金环
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), BRONZE_D, { x: s * 0.370, y: 0.060, z: 0.050, sx: 0.070, sy: 0.100, sz: 0.050, rz: s * 0.4 });
    }
    B.put('head', TORUS(0.095, 0.024, PI * 1.30), GOLD, { x: 0.300, y: 0.020, z: -0.270, rz: 0.7, shine: true });
    B.put('head', TORUS(0.095, 0.024, PI * 1.30), GOLD, { x: -0.300, y: 0.020, z: -0.270, rz: -0.7, shine: true });

    return finishModel(B, function (nodes, dt, t) {
      breathe(nodes, t, 0.008);
      nodes.belly.scale.set(1 + Math.sin(t * 1.7 + 0.4) * 0.012, 1 + Math.sin(t * 1.7) * 0.016, 1 + Math.sin(t * 1.7 + 0.2) * 0.010);
      nodes.head.rotation.x = Math.sin(t * 1.2) * 0.035;
      nodes.head.rotation.y = Math.sin(t * 0.75) * 0.06;
      nodes.jaw.rotation.x = -0.12 - Math.max(0, Math.sin(t * 2.1)) * 0.16;
      nodes.tail.rotation.z = Math.sin(t * 1.6) * 0.14;
      nodes.tail.rotation.x = Math.sin(t * 1.2 + 0.5) * 0.08;
      nodes.horn_l.rotation.z = 0.03 + Math.sin(t * 1.4) * 0.015;
      nodes.horn_r.rotation.z = -0.03 - Math.sin(t * 1.4 + 0.4) * 0.015;
    }, { fitH: 2.20 });
  }

  // =========================================================================
  // 13) 巴蛇 — 巨蛇、金瞳、盘绕、鳞纹（h 1.75 / r 0.55）
  // =========================================================================
  function buildBashe() {
    const B = Builder();
    const GREEN = 0x3f6a4a, GREEN_D = 0x2a4a34, BELLY = 0xc9b46a, GOLD = 0xffd93d, RED = 0xd84a5a;

    // 盘绕的蛇身基座：两圈粗蛇体（环弧平滑盘起），上接竖立主躯干
    B.put('root', TORUS(0.285, 0.140, PI * 1.60), GREEN, { y: 0.145, rx: PI / 2 - 0.22, ry: -0.30 });
    B.put('root', TORUS(0.222, 0.118, PI * 1.45), GREEN_D, { y: 0.290, z: 0.030, rx: PI / 2 - 0.08, ry: 1.10 });
    B.put('root', SPH(), GREEN, { x: 0.300, y: 0.165, z: 0.160, sx: 0.118, sy: 0.140, sz: 0.128 });
    // 尾尖从盘绕末端翘出
    B.put('root', CONE(), GREEN_D, { x: 0.320, y: 0.180, z: 0.290, sx: 0.058, sy: 0.230, sz: 0.052, rx: 1.30, ry: -0.55, shine: true });
    // 盘圈外侧腹鳞
    for (let i = 0; i < 10; i++) {
      const a = -0.25 + (i / 9) * PI * 1.20;
      B.put('root', SPH(), BELLY, { x: Math.cos(a) * 0.290, y: 0.068, z: Math.sin(a) * 0.290, sx: 0.050, sy: 0.018, sz: 0.058, ry: -a });
    }
    // 尾尖（动画节点）
    B.node('tail', 'root', 0, 0.150, 0.360);
    capChain(B, 'tail', [[0, 0, 0], [0.060, 0.045, 0.070], [0.110, 0.100, 0.110]], [0.060, 0.040, 0.022], GREEN_D);
    B.put('tail', CONE(), GREEN_D, { x: 0.130, y: 0.115, z: 0.130, sx: 0.030, sy: 0.080, sz: 0.026, rx: 1.0, shine: true });
    // 主躯干（动画节点：S 形起伏）
    B.node('trunk', 'root', 0, 0.300, 0.030);
    const PTS = [
      [0, 0.00, 0], [0.120, 0.200, 0.030], [0.030, 0.420, -0.020],
      [0.100, 0.640, -0.060], [0.000, 0.860, -0.100], [-0.050, 1.060, -0.140], [0.000, 1.180, -0.160],
    ];
    const RADS = [0.200, 0.190, 0.180, 0.170, 0.160, 0.150, 0.140];
    capChain(B, 'trunk', PTS, RADS, GREEN);
    // 腹鳞（正面 + 背脊鳞纹）
    for (let i = 1; i < PTS.length; i++) {
      const p = PTS[i];
      B.put('trunk', SPH(), BELLY, { x: p[0] * 0.92, y: p[1], z: p[2] - RADS[i] * 0.72, sx: RADS[i] * 0.62, sy: 0.045, sz: RADS[i] * 0.42 });
      B.put('trunk', ICO(1, 0), i % 2 ? GREEN_D : 0x5a8a5a, { x: p[0], y: p[1] + RADS[i] * 0.72, z: p[2], sx: 0.055, sy: 0.040, sz: 0.062, ry: PI / 4 });
    }
    // 颈侧金鳍（云纹）
    for (let i = 0; i < 3; i++) {
      B.put('trunk', leafGeo(0.026, 0.080, 0.010), GOLD, { x: 0.030 - i * 0.020, y: 1.000 + i * 0.030, z: -0.150 - i * 0.010, rx: -0.30, rz: -0.65, shine: true });
    }
    // 头（动画节点）
    B.node('head', 'trunk', 0, 1.280, -0.170);
    B.put('head', SPH_HI(), GREEN, { sx: 0.200, sy: 0.160, sz: 0.240 });
    B.put('head', SPH(), GREEN_D, { y: 0.020, z: 0.060, sx: 0.165, sy: 0.130, sz: 0.180 });
    B.put('head', SPH(), GREEN, { y: -0.020, z: -0.200, sx: 0.130, sy: 0.090, sz: 0.100 });
    // 金瞳（竖瞳）
    for (let s = -1; s <= 1; s += 2) {
      B.put('head', SPH(), GOLD, { x: s * 0.105, y: 0.055, z: -0.150, sx: 0.050, sy: 0.055, sz: 0.032, glow: GOLD, glowInt: 1.4, shine: true });
      B.put('head', SPH(), 0x2a2008, { x: s * 0.105, y: 0.055, z: -0.176, sx: 0.013, sy: 0.044, sz: 0.010, shine: true });
      B.put('head', SPH(), GREEN_D, { x: s * 0.105, y: 0.110, z: -0.140, sx: 0.075, sy: 0.026, sz: 0.050 });
    }
    // 张口 + 獠牙 + 分叉舌
    addOpenMouth(B, 'head', { y: -0.070, z: -0.235, w: 0.095, h: 0.045, color: 0x3a1418 });
    addFangs(B, 'head', { n: 2, gap: 0.075, y: -0.055, z: -0.245, w: 0.020, h: 0.060, color: 0xfffdf0 });
    B.put('head', CAPSULE(0.012, 0.100), RED, { y: -0.080, z: -0.285, rx: -PI / 2 });
    B.put('head', CAPSULE(0.009, 0.070), RED, { x: 0.030, y: -0.080, z: -0.345, rx: -PI / 2, rz: -0.35 });
    B.put('head', CAPSULE(0.009, 0.070), RED, { x: -0.030, y: -0.080, z: -0.345, rx: -PI / 2, rz: 0.35 });
    // 头冠红鳞 + 鼻角
    B.put('head', SPH(), RED, { y: 0.140, z: -0.050, sx: 0.075, sy: 0.040, sz: 0.090 });
    B.put('head', CONE(), GOLD, { y: 0.150, z: -0.200, sx: 0.018, sy: 0.085, sz: 0.016, rx: -1.10, shine: true });

    return finishModel(B, function (nodes, dt, t) {
      nodes.trunk.rotation.x = Math.sin(t * 1.15) * 0.045;
      nodes.trunk.rotation.z = Math.sin(t * 0.85) * 0.055;
      nodes.head.rotation.x = Math.sin(t * 1.35 + 0.4) * 0.06;
      nodes.head.rotation.y = Math.sin(t * 0.95) * 0.16;
      nodes.head.rotation.z = Math.sin(t * 1.6) * 0.04;
      nodes.tail.rotation.y = Math.sin(t * 2.1) * 0.22;
      nodes.tail.rotation.x = Math.sin(t * 1.5 + 0.6) * 0.10;
      breathe(nodes, t, 0.006);
    }, { fitH: 1.75 });
  }

  // =========================================================================
  // 14) 混沌 — 无面黄囊、六足四翼、赤光流转、浑敦无目（h 1.90 / r 0.42）
  // =========================================================================
  function buildHundun() {
    const B = Builder();
    const SAC = 0xe8c86a, SAC_D = 0xc9a84a, SAC_L = 0xf4dfa0, RED = 0xe8453c, WING = 0xf0e0b0;

    // 无面黄囊（主体，动画节点做缓慢鼓动）
    B.node('sac', 'root', 0, 0.000, 0);
    B.put('sac', SPH_HI(), SAC, { y: 1.060, sx: 0.420, sy: 0.750, sz: 0.380 });
    B.put('sac', SPH(), SAC_D, { y: 1.020, z: 0.060, sx: 0.390, sy: 0.700, sz: 0.330 });
    B.put('sac', SPH(), SAC_L, { y: 1.180, z: -0.120, sx: 0.290, sy: 0.480, sz: 0.240 });
    // 赤光流转（环带 + 光点）
    ringBand(B, 'sac', { y: 0.730, R: 1, tube: 0.026, sx: 0.378, sy: 0.342, color: RED, glow: RED, glowInt: 1.6 });
    ringBand(B, 'sac', { y: 1.060, R: 1, tube: 0.028, sx: 0.420, sy: 0.380, color: RED, glow: RED, glowInt: 1.9 });
    ringBand(B, 'sac', { y: 1.380, R: 1, tube: 0.026, sx: 0.381, sy: 0.345, color: RED, glow: RED, glowInt: 1.6 });
    const MOTES = [
      [0.300, 0.860, -0.250], [-0.290, 1.000, -0.230], [0.240, 1.240, -0.280],
      [-0.210, 1.330, -0.240], [0.330, 1.120, 0.120], [-0.330, 0.920, 0.140],
    ];
    for (let i = 0; i < MOTES.length; i++) {
      const m = MOTES[i];
      B.put('sac', SPH(), RED, { x: m[0], y: m[1], z: m[2], sx: 0.028, sy: 0.028, sz: 0.028, glow: RED, glowInt: 2.0 });
    }
    // 六足（三对，短壮）
    const LEGS = [[-0.260, -0.190], [0.260, -0.190], [-0.300, 0.030], [0.300, 0.030], [-0.280, 0.240], [0.280, 0.240]];
    for (let i = 0; i < LEGS.length; i++) {
      const lx = LEGS[i][0], lz = LEGS[i][1];
      B.put('root', CAPSULE(0.052, 0.260), SAC_D, { x: lx, y: 0.245, z: lz, rz: lx > 0 ? -0.18 : 0.18 });
      B.put('root', SPH(), SAC_D, { x: lx * 1.30, y: 0.055, z: lz - 0.030, sx: 0.075, sy: 0.055, sz: 0.100 });
      addClaws(B, 'root', { x: lx * 1.30, y: 0.050, z: lz - 0.120, r: 0.012, len: 0.034, spread: 0.020, color: 0xfff2c0 });
    }
    // 四翼（四个动画节点，两对）：叶状宽翼，向后上方展开
    // 四翼：两对宽叶翼从背侧向上、向外张开，叶面朝前（正面清晰可见）
    const WINGS = [
      ['wing_a_l', -1, -0.255, 1.420, 0.100, 0.340, 0.55, 0.55],
      ['wing_a_r', 1, 0.255, 1.420, 0.100, 0.340, 0.55, 0.55],
      ['wing_b_l', -1, -0.220, 1.170, 0.165, 0.300, 0.80, 0.45],
      ['wing_b_r', 1, 0.220, 1.170, 0.165, 0.300, 0.80, 0.45],
    ];
    for (let i = 0; i < WINGS.length; i++) {
      const w = WINGS[i];
      const nm = w[0], s = w[1], len = w[5], rz = w[6], rx = w[7];
      B.node(nm, 'root', w[2], w[3], w[4]);
      // 主翼膜
      B.put(nm, leafGeo(0.150, len, 0.014), WING, { x: s * 0.010, y: 0.000, z: 0.000, rx: rx, rz: -s * rz, glass: 0.82 });
      // 内层淡金翼膜
      B.put(nm, leafGeo(0.085, len * 0.68, 0.010), SAC_L, { x: s * 0.020, y: 0.000, z: 0.010, rx: rx - 0.06, rz: -s * (rz + 0.14), glass: 0.66 });
      // 赤色翼缘 + 翼尖赤光
      B.put(nm, leafGeo(0.026, len * 0.95, 0.006), RED, { x: s * 0.008, y: 0.000, z: 0.014, rx: rx, rz: -s * rz, glow: RED, glowInt: 1.3 });
      const tipY = len * Math.cos(rx) * Math.cos(rz);
      const tipX = len * Math.sin(rz) * Math.cos(rx);
      B.put(nm, SPH(), RED, { x: s * (0.010 + tipX * 0.93), y: tipY * 0.93, z: 0.016 + len * Math.sin(rx) * 0.93, sx: 0.022, sy: 0.020, sz: 0.016, glow: RED, glowInt: 1.6 });
    }
    // 正面赤光漩涡（无面之脸的位置只有流转的红光）
    const SWIRL = [[-0.120, 1.240], [-0.030, 1.285], [0.075, 1.250], [0.135, 1.165], [0.095, 1.080], [0.000, 1.055], [-0.105, 1.090]];
    for (let i = 0; i < SWIRL.length; i++) {
      B.put('sac', SPH(), RED, { x: SWIRL[i][0], y: SWIRL[i][1], z: -0.355, sx: 0.032, sy: 0.026, sz: 0.018, glow: RED, glowInt: 2.1 });
    }
    // 顶部混沌之光（撑起 1.9 的高度）
    B.put('root', SPH(), RED, { y: 1.862, sx: 0.050, sy: 0.046, sz: 0.050, glow: RED, glowInt: 2.4 });
    B.put('root', TORUS(0.080, 0.014, TAU), RED, { y: 1.830, rx: PI / 2, glow: RED, glowInt: 1.7 });

    return finishModel(B, function (nodes, dt, t) {
      nodes.sac.scale.set(1 + Math.sin(t * 1.35) * 0.010, 1 + Math.sin(t * 1.35 + 0.3) * 0.014, 1 + Math.sin(t * 1.35 + 0.6) * 0.010);
      const flap = Math.sin(t * 5.6);
      const flap2 = Math.sin(t * 5.6 + 0.9);
      nodes.wing_a_l.rotation.z = 0.10 + flap * 0.20;
      nodes.wing_a_r.rotation.z = -0.10 - flap * 0.20;
      nodes.wing_b_l.rotation.z = 0.08 + flap2 * 0.16;
      nodes.wing_b_r.rotation.z = -0.08 - flap2 * 0.16;
      nodes.wing_a_l.rotation.x = Math.sin(t * 5.6 + 0.4) * 0.08;
      nodes.wing_a_r.rotation.x = Math.sin(t * 5.6 + 0.4) * 0.08;
      nodes.wing_b_l.rotation.x = Math.sin(t * 5.6 + 1.3) * 0.07;
      nodes.wing_b_r.rotation.x = Math.sin(t * 5.6 + 1.3) * 0.07;
    }, { fitH: 1.90 });
  }

  // =========================================================================
  // 注册 14 只妖物
  // =========================================================================
  const BUILDERS = {
    lushu: buildLushu, wugong: buildWugong, zhen: buildZhen, mumei: buildMumei,
    xuanfeng: buildXuanfeng, zheng: buildZheng, jiuwei: buildJiuwei, jiaoren: buildJiaoren,
    chimei: buildChimei, wangliang: buildWangliang, chiru: buildChiru, taotie: buildTaotie,
    bashe: buildBashe, hundun: buildHundun,
  };
  if (typeof M.registerBuilders === 'function') {
    M.registerBuilders(BUILDERS);
  } else if (window.console && console.warn) {
    console.warn('[PG.models] registerBuilders 缺失：14 只妖物未能注册');
  }
})();
