/* ============================================================================
 * 35-art.js — PG.models.art
 * 山海 · 森之突袭 2D 美术：18 只异兽圆形图标 + 4 位行者半身头像
 * ----------------------------------------------------------------------------
 * 1) 全部在 0..1 单位空间用 Canvas2D 手绘，g.scale(size,size) 后天然适配任意像素尺寸。
 * 2) 纯几何拼装：圆 / 椭圆 / 多边形 / 圆角矩形 / 渐变 / 描边；无外部贴图，离线可用。
 * 3) 配色与造型严格按 docs/MYTHOLOGY.md 第 2、3 节（主色 / 特征 / 属性徽章）。
 * 4) 对外只挂 PG.models.art = { icon(id,size), portrait(id,size), has(id) }：
 *    - icon 最小 16px、portrait 最小 32px，尺寸取整；同 id 同尺寸命中缓存。
 *    - 未知 id 返回 null，绝不抛错（PG.models 未加载时也安全）。
 * 5) 不引用 30-models 内部变量；需要资料时走 PG.models.info(id)。
 * ==========================================================================*/
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var PI = Math.PI;
  var PG = (window.PG = window.PG || {});

  // =========================================================================
  // 1. 画布与手绘工具（0..1 单位空间）
  // =========================================================================
  function mkCanvas(size) {
    var s = Math.max(16, Math.round(size || 128));
    var c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    var g = c.getContext('2d');
    if (g) {
      g.scale(s, s);
      g.lineJoin = 'round';
      g.lineCap = 'round';
    }
    return { canvas: c, g: g, size: s };
  }

  function cCir(g, x, y, r, fill, stroke, lw) {
    g.beginPath();
    g.arc(x, y, Math.abs(r), 0, TAU);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cEll(g, x, y, rx, ry, rot, fill, stroke, lw) {
    g.beginPath();
    g.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot || 0, 0, TAU);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cShp(g, pts, fill, stroke, lw) {
    if (!pts || !pts.length) return;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.02 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  function cRR(g, x, y, w, h, r, fill, stroke, lw) {
    var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
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
    var gr = g.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    return gr;
  }

  function cRad(g, x, y, r0, r1, stops) {
    var gr = g.createRadialGradient(x, y, Math.max(0, r0), x, y, Math.max(0.001, r1));
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    return gr;
  }

  // 四角星闪光
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

  // 卡通眼睛：眼白 + 虹膜 + 瞳孔 + 两处高光
  function cEye(g, x, y, r, white, iris, pupil) {
    cEll(g, x, y, r, r * 1.06, 0, white || '#fffdf6');
    if (iris) cEll(g, x, y + r * 0.10, r * 0.70, r * 0.72, 0, iris);
    if (pupil) cEll(g, x, y + r * 0.13, r * 0.36, r * 0.40, 0, pupil);
    cCir(g, x - r * 0.30, y - r * 0.34, r * 0.28, '#ffffff');
    cCir(g, x + r * 0.26, y + r * 0.30, r * 0.12, 'rgba(255,255,255,.85)');
  }

  function cSmile(g, x, y, r, color, lw) {
    g.beginPath();
    g.arc(x, y, r, PI * 0.18, PI * 0.82);
    g.lineWidth = lw || 0.015;
    g.strokeStyle = color || '#5a3a2a';
    g.stroke();
  }

  // 柔和光晕（径向渐变）
  function cGlow(g, x, y, r, color, alpha) {
    g.save();
    g.globalAlpha = alpha == null ? 0.45 : alpha;
    var gr = g.createRadialGradient(x, y, 0, x, y, Math.max(0.001, r));
    gr.addColorStop(0, color);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.restore();
  }

  // 地面软阴影
  function cShadow(g, y, rx, ry, alpha) {
    cEll(g, 0.5, y, rx, ry, 0, 'rgba(24,18,10,' + (alpha == null ? 0.18 : alpha) + ')');
  }

  // 雷纹闪电（也用于属性徽章的 bolt）
  function cBolt(g, x, y, s, fill, stroke) {
    var pts = [
      [x + s * 0.10, y - s * 0.55], [x - s * 0.44, y + s * 0.06],
      [x - s * 0.02, y + s * 0.06], [x - s * 0.12, y + s * 0.55],
      [x + s * 0.44, y - s * 0.10], [x + s * 0.04, y - s * 0.10]
    ];
    cShp(g, pts, fill || '#ffd93d', stroke, s * 0.18);
  }

  // 火焰：底部中心 (x,y)，h 向上
  function cFlame(g, x, y, w, h, fill, inner) {
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x - w * 0.62, y - h * 0.24, x - w * 0.48, y - h * 0.74, x - w * 0.04, y - h);
    g.bezierCurveTo(x + w * 0.20, y - h * 0.62, x + w * 0.56, y - h * 0.38, x + w * 0.12, y);
    g.closePath();
    g.fillStyle = fill || '#ff8a3d';
    g.fill();
    if (inner) {
      g.beginPath();
      g.moveTo(x, y - h * 0.06);
      g.bezierCurveTo(x - w * 0.26, y - h * 0.26, x - w * 0.20, y - h * 0.52, x - w * 0.01, y - h * 0.68);
      g.bezierCurveTo(x + w * 0.10, y - h * 0.46, x + w * 0.24, y - h * 0.28, x + w * 0.05, y - h * 0.04);
      g.closePath();
      g.fillStyle = inner;
      g.fill();
    }
  }

  // 锥形肢体 / 直尾 / 角（两端圆头）
  function cTaper(g, x0, y0, x1, y1, w0, w1, fill, stroke, lw) {
    cCurveTaper(g, x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1, w0, w1, fill, stroke, lw);
  }

  // 带弧度的锥形：起点 (x0,y0) -> 控制点 (cx,cy) -> 终点 (x1,y1)
  function cCurveTaper(g, x0, y0, cx, cy, x1, y1, w0, w1, fill, stroke, lw) {
    var a0 = Math.atan2(cy - y0, cx - x0);
    var a1 = Math.atan2(y1 - cy, x1 - cx);
    var n0x = -Math.sin(a0), n0y = Math.cos(a0);
    var n1x = -Math.sin(a1), n1y = Math.cos(a1);
    var mx = (x0 + cx) / 2, my = (y0 + cy) / 2;
    g.beginPath();
    g.moveTo(x0 + n0x * w0, y0 + n0y * w0);
    g.quadraticCurveTo(mx + n1x * w0, my + n1y * w0, x1 + n1x * w1, y1 + n1y * w1);
    g.arc(x1, y1, Math.abs(w1), a1 + PI / 2, a1 - PI / 2, true);
    g.quadraticCurveTo(mx - n1x * w0 * 0.85, my - n1y * w0 * 0.85, x0 - n0x * w0, y0 - n0y * w0);
    g.arc(x0, y0, Math.abs(w0), a0 - PI / 2, a0 + PI / 2, true);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = lw == null ? 0.014 : lw; g.strokeStyle = stroke; g.stroke(); }
  }

  // 螺旋（云纹 / 灵芝尾 / 赤光流转）
  function cSwirl(g, x, y, r, turns, color, lw, dir) {
    var steps = 42;
    g.beginPath();
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var ang = (dir === -1 ? -1 : 1) * t * turns * TAU;
      var rr = r * (1 - t * 0.88);
      var px = x + Math.cos(ang) * rr;
      var py = y + Math.sin(ang) * rr;
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.lineWidth = lw || 0.014;
    g.strokeStyle = color;
    g.stroke();
  }

  // 一排鳞片（U 形弧）
  function cScaleRow(g, cx, cy, n, r, color, lw, rot) {
    var step = r * 1.55;
    g.save();
    if (rot) { g.translate(cx, cy); g.rotate(rot); g.translate(-cx, -cy); }
    g.lineWidth = lw || 0.012;
    g.strokeStyle = color;
    for (var i = 0; i < n; i++) {
      var x = cx + (i - (n - 1) / 2) * step;
      g.beginPath();
      g.arc(x, cy, r, PI * 0.16, PI * 0.84);
      g.stroke();
    }
    g.restore();
  }

  // 六边形（龟甲纹 / 鳞甲）
  function cHex(g, cx, cy, r, rot, fill, stroke, lw) {
    var pts = [];
    for (var i = 0; i < 6; i++) {
      var a = (rot || 0) + i * PI / 3;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    cShp(g, pts, fill, stroke, lw);
  }

  // 云纹 / 灵芝（三瓣云头 + 卷尾）
  function cCloud(g, x, y, s, fill, stroke, lw) {
    cCir(g, x - s * 0.55, y, s * 0.42, fill);
    cCir(g, x, y - s * 0.20, s * 0.52, fill);
    cCir(g, x + s * 0.55, y, s * 0.40, fill);
    cRR(g, x - s * 0.60, y, s * 1.2, s * 0.45, s * 0.22, fill);
    if (stroke) {
      g.lineWidth = lw || 0.014;
      g.strokeStyle = stroke;
      g.beginPath(); g.arc(x, y - s * 0.20, s * 0.52, PI * 1.05, PI * 1.95); g.stroke();
      g.beginPath(); g.arc(x - s * 0.55, y, s * 0.42, PI * 0.85, PI * 1.6); g.stroke();
      g.beginPath(); g.arc(x + s * 0.55, y, s * 0.40, PI * 1.4, PI * 2.15); g.stroke();
    }
  }

  // 爪：从 (x,y) 朝 angle 方向伸出三趾
  function cClaw(g, x, y, r, angle, color) {
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.fillStyle = color;
    for (var i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(i * r * 0.34, r * 0.30);
      g.quadraticCurveTo(i * r * 0.60 + r * 0.12, -r * 0.52, i * r * 0.40 + r * 0.30, -r * 1.05);
      g.quadraticCurveTo(i * r * 0.30 + r * 0.02, -r * 0.45, i * r * 0.18, r * 0.28);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  // 发光眼（鬼魅 / 妖兽）
  function cSpiritEye(g, x, y, r, color) {
    cGlow(g, x, y, r * 2.8, color, 0.5);
    cEll(g, x, y, r, r * 0.80, 0, color);
    cEll(g, x, y - r * 0.08, r * 0.52, r * 0.42, 0, '#ffffff');
  }

  // 图标底：渐变背景 + 白色圆盘 + 光晕 + 高光弧
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

  // =========================================================================
  // 2. 十八只异兽圆形图标（id 与顺序见 docs/MYTHOLOGY.md 第 3 节）
  // =========================================================================
  const ICONS = {};

  // 夔牛：苍青单足雷牛，紫电缠身、金色雷纹（无角）
  ICONS.kui = function (g) {
    iconBG(g, '#4a5c80', '#dbe8fb');
    var OL = 'rgba(24,28,50,.62)';
    var BODY = '#6b7fa8', BODYD = '#41527a', LIGHT = '#c3d4ea';
    var PUR = '#b06bff', PURL = '#e0c8ff', GOLD = '#ffd93d';
    // 背后紫电
    g.save();
    g.globalAlpha = 0.95;
    cBolt(g, 0.205, 0.415, 0.185, PUR);
    cBolt(g, 0.83, 0.345, 0.140, PURL);
    g.restore();
    cSpark(g, 0.29, 0.235, 0.030, PURL);
    cSpark(g, 0.76, 0.205, 0.022, PURL);
    cShadow(g, 0.845, 0.195, 0.036, 0.20);
    // 紫电绒尾
    cCurveTaper(g, 0.735, 0.70, 0.855, 0.66, 0.855, 0.545, 0.040, 0.016, BODY, OL, 0.014);
    cCir(g, 0.855, 0.525, 0.045, PUR, '#7a3fbf', 0.012);
    cSpark(g, 0.855, 0.525, 0.055, PURL);
    // 身体（蹲坐）
    cEll(g, 0.5, 0.705, 0.265, 0.16, 0, cRad(g, 0.5, 0.68, 0.02, 0.31, [[0, '#8296bc'], [1, BODYD]]), OL, 0.02);
    cEll(g, 0.5, 0.745, 0.105, 0.075, 0, 'rgba(195,212,234,.55)');
    // 单足 + 金足镯
    cRR(g, 0.438, 0.795, 0.124, 0.085, 0.042, cLin(g, 0.44, 0.79, 0.56, 0.88, [[0, '#7f93b8'], [1, BODYD]]), OL, 0.016);
    g.strokeStyle = '#2f3c5c'; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.5, 0.802); g.lineTo(0.5, 0.872); g.stroke();
    cRR(g, 0.44, 0.792, 0.12, 0.024, 0.012, GOLD, '#b58a00', 0.010);
    // 耳朵
    cEll(g, 0.298, 0.446, 0.082, 0.052, -0.34, BODY, OL, 0.016);
    cEll(g, 0.702, 0.446, 0.082, 0.052, 0.34, BODY, OL, 0.016);
    cEll(g, 0.302, 0.450, 0.044, 0.025, -0.34, '#a07fd0');
    cEll(g, 0.698, 0.450, 0.044, 0.025, 0.34, '#a07fd0');
    // 头顶鬃毛（无角，三簇）
    cShp(g, [[0.435, 0.305], [0.468, 0.245], [0.492, 0.305]], BODYD, OL, 0.012);
    cShp(g, [[0.478, 0.298], [0.512, 0.232], [0.535, 0.300]], PUR, '#7a3fbf', 0.012);
    cShp(g, [[0.520, 0.305], [0.552, 0.252], [0.570, 0.310]], BODYD, OL, 0.012);
    // 头
    cCir(g, 0.5, 0.475, 0.205, cRad(g, 0.43, 0.40, 0.03, 0.30, [[0, '#9cb0d2'], [0.55, BODY], [1, BODYD]]), OL, 0.022);
    // 额头金色雷纹
    g.strokeStyle = GOLD; g.lineWidth = 0.014;
    g.beginPath();
    g.moveTo(0.468, 0.372); g.lineTo(0.532, 0.372); g.lineTo(0.492, 0.402); g.lineTo(0.548, 0.402);
    g.stroke();
    // 口鼻 + 下巴鬃毛
    cEll(g, 0.5, 0.588, 0.152, 0.098, 0, cLin(g, 0.40, 0.53, 0.60, 0.67, [[0, LIGHT], [1, '#a9bcd8']]), OL, 0.016);
    cEll(g, 0.448, 0.575, 0.022, 0.016, 0.22, '#3c4a6a');
    cEll(g, 0.552, 0.575, 0.022, 0.016, -0.22, '#3c4a6a');
    cSmile(g, 0.5, 0.614, 0.048, '#3c4a6a', 0.014);
    cShp(g, [[0.448, 0.672], [0.5, 0.715], [0.552, 0.672]], BODYD, OL, 0.010);
    // 眼睛
    cEye(g, 0.408, 0.462, 0.056, '#fffdf6', PUR, '#2a1838');
    cEye(g, 0.592, 0.462, 0.056, '#fffdf6', PUR, '#2a1838');
    // 怒眉
    g.strokeStyle = '#2a3350'; g.lineWidth = 0.019;
    g.beginPath(); g.moveTo(0.348, 0.398); g.quadraticCurveTo(0.386, 0.382, 0.424, 0.404); g.stroke();
    g.beginPath(); g.moveTo(0.652, 0.398); g.quadraticCurveTo(0.614, 0.382, 0.576, 0.404); g.stroke();
    // 紫电缠绕
    g.save();
    g.strokeStyle = PURL; g.lineWidth = 0.011; g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(0.238, 0.645); g.lineTo(0.282, 0.618); g.lineTo(0.252, 0.583); g.lineTo(0.296, 0.556);
    g.stroke();
    g.beginPath();
    g.moveTo(0.762, 0.66); g.lineTo(0.718, 0.632); g.lineTo(0.748, 0.598); g.lineTo(0.704, 0.572);
    g.stroke();
    g.restore();
    // 腮红
    cEll(g, 0.335, 0.545, 0.030, 0.018, 0, 'rgba(240,130,150,.30)');
    cEll(g, 0.665, 0.545, 0.030, 0.018, 0, 'rgba(240,130,150,.30)');
  };

  // 麒麟：青玉鳞身、鹿角金鬃、灵芝尾
  ICONS.qilin = function (g) {
    iconBG(g, '#2f8a74', '#d8fff0');
    var OL = 'rgba(16,58,46,.60)';
    var JADE = '#4fb99f', JADED = '#2f7a66', JADEL = '#b8ecdc', GOLD = '#e8b33a', GOLDD = '#b8841a';
    // 金鬃（头后）
    cCurveTaper(g, 0.47, 0.62, 0.30, 0.56, 0.275, 0.40, 0.045, 0.010, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.50, 0.64, 0.32, 0.70, 0.29, 0.78, 0.045, 0.010, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.53, 0.62, 0.70, 0.56, 0.725, 0.40, 0.045, 0.010, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.52, 0.64, 0.69, 0.70, 0.71, 0.78, 0.042, 0.010, GOLD, GOLDD, 0.010);
    // 鹿角（金色分叉）
    cCurveTaper(g, 0.395, 0.335, 0.335, 0.235, 0.325, 0.145, 0.026, 0.009, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.365, 0.255, 0.310, 0.225, 0.285, 0.185, 0.017, 0.006, GOLD, GOLDD, 0.009);
    cCurveTaper(g, 0.345, 0.215, 0.390, 0.180, 0.412, 0.152, 0.014, 0.006, GOLD, GOLDD, 0.009);
    cCurveTaper(g, 0.605, 0.335, 0.665, 0.235, 0.675, 0.145, 0.026, 0.009, GOLD, GOLDD, 0.010);
    cCurveTaper(g, 0.635, 0.255, 0.690, 0.225, 0.715, 0.185, 0.017, 0.006, GOLD, GOLDD, 0.009);
    cCurveTaper(g, 0.655, 0.215, 0.610, 0.180, 0.588, 0.152, 0.014, 0.006, GOLD, GOLDD, 0.009);
    // 耳
    cEll(g, 0.352, 0.402, 0.062, 0.034, -0.50, JADE, OL, 0.012);
    cEll(g, 0.648, 0.402, 0.062, 0.034, 0.50, JADE, OL, 0.012);
    // 四足 + 金蹄
    var legs = [0.335, 0.435, 0.565, 0.665];
    for (var i = 0; i < legs.length; i++) {
      cRR(g, legs[i] - 0.032, 0.79, 0.064, 0.10, 0.028, JADED, OL, 0.012);
      cRR(g, legs[i] - 0.036, 0.862, 0.072, 0.032, 0.014, GOLD, GOLDD, 0.010);
    }
    // 身体 + 鳞纹
    cEll(g, 0.5, 0.705, 0.275, 0.165, 0, cRad(g, 0.47, 0.66, 0.03, 0.32, [[0, '#8fe0c8'], [0.55, JADE], [1, JADED]]), OL, 0.02);
    cScaleRow(g, 0.50, 0.705, 4, 0.030, 'rgba(31,90,74,.55)', 0.010);
    cScaleRow(g, 0.50, 0.755, 3, 0.028, 'rgba(31,90,74,.45)', 0.010);
    cScaleRow(g, 0.43, 0.660, 3, 0.026, 'rgba(184,236,220,.55)', 0.009);
    // 灵芝尾
    g.save();
    g.translate(0.765, 0.705);
    cSwirl(g, 0, 0, 0.045, 1.15, GOLDD, 0.012);
    cCloud(g, 0.012, -0.045, 0.052, GOLD, GOLDD, 0.010);
    g.restore();
    // 头
    cCir(g, 0.5, 0.475, 0.205, cRad(g, 0.43, 0.40, 0.03, 0.30, [[0, JADEL], [0.55, JADE], [1, JADED]]), OL, 0.022);
    // 额前金鬃
    cShp(g, [[0.448, 0.312], [0.478, 0.262], [0.5, 0.318], [0.522, 0.262], [0.552, 0.312]], GOLD, GOLDD, 0.010);
    // 额头玉珠
    cCir(g, 0.5, 0.372, 0.030, GOLD, GOLDD, 0.010);
    cCir(g, 0.5, 0.372, 0.014, '#fff6d8');
    // 颊侧鳞片
    cScaleRow(g, 0.372, 0.512, 2, 0.020, 'rgba(20,70,58,.55)', 0.008);
    cScaleRow(g, 0.628, 0.512, 2, 0.020, 'rgba(20,70,58,.55)', 0.008);
    // 口鼻
    cEll(g, 0.5, 0.582, 0.128, 0.090, 0, '#e8fff6', OL, 0.015);
    cEll(g, 0.458, 0.570, 0.017, 0.012, 0.18, '#2f6a5c');
    cEll(g, 0.542, 0.570, 0.017, 0.012, -0.18, '#2f6a5c');
    cSmile(g, 0.5, 0.604, 0.044, '#2f6a5c', 0.013);
    // 眼（金色虹膜）
    cEye(g, 0.408, 0.462, 0.056, '#fffdf6', GOLD, '#4a3410');
    cEye(g, 0.592, 0.462, 0.056, '#fffdf6', GOLD, '#4a3410');
    // 眉
    g.strokeStyle = '#2f6a5c'; g.lineWidth = 0.015;
    g.beginPath(); g.moveTo(0.352, 0.406); g.quadraticCurveTo(0.386, 0.392, 0.420, 0.408); g.stroke();
    g.beginPath(); g.moveTo(0.648, 0.406); g.quadraticCurveTo(0.614, 0.392, 0.580, 0.408); g.stroke();
    // 金点
    cCir(g, 0.352, 0.552, 0.010, GOLD);
    cCir(g, 0.648, 0.552, 0.010, GOLD);
  };

  // 毕方：独足火鸟，赤羽金喙，翅尖燃焰
  ICONS.bifang = function (g) {
    iconBG(g, '#e8b33a', '#fff6cf');
    var OL = 'rgba(110,40,16,.58)';
    var RED = '#e8453c', REDD = '#b02a20', REDL = '#ff8a6a', GOLD = '#ffd93d', GOLDD = '#c99a10', CREAM = '#ffe6c2';
    cGlow(g, 0.5, 0.60, 0.40, '#ff8a3d', 0.30);
    // 单足 + 爪
    cTaper(g, 0.5, 0.705, 0.5, 0.845, 0.026, 0.015, GOLD, GOLDD, 0.010);
    g.strokeStyle = GOLDD; g.lineWidth = 0.014;
    g.beginPath(); g.moveTo(0.5, 0.845); g.lineTo(0.455, 0.878); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.845); g.lineTo(0.5, 0.885); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.845); g.lineTo(0.545, 0.878); g.stroke();
    // 尾羽
    cCurveTaper(g, 0.575, 0.645, 0.78, 0.62, 0.875, 0.435, 0.048, 0.012, RED, REDD, 0.012);
    cCurveTaper(g, 0.575, 0.685, 0.80, 0.735, 0.895, 0.655, 0.042, 0.012, REDD, '#7a1a14', 0.012);
    cCurveTaper(g, 0.60, 0.67, 0.775, 0.70, 0.83, 0.56, 0.030, 0.010, GOLD, GOLDD, 0.010);
    // 双翅（三片羽）+ 翅尖燃焰
    var wings = [
      [[0.44, 0.585], [0.235, 0.525], [0.155, 0.395], [0.30, 0.44], [0.245, 0.305], [0.395, 0.435], [0.44, 0.35], [0.485, 0.525]],
      [[0.56, 0.585], [0.765, 0.525], [0.845, 0.395], [0.70, 0.44], [0.755, 0.305], [0.605, 0.435], [0.56, 0.35], [0.515, 0.525]]
    ];
    for (var w = 0; w < 2; w++) {
      cShp(g, wings[w], cLin(g, 0.5, 0.35, 0.5, 0.60, [[0, REDL], [0.5, RED], [1, REDD]]), OL, 0.014);
      g.save();
      g.globalAlpha = 0.6;
      g.strokeStyle = '#7a1a14'; g.lineWidth = 0.009;
      g.beginPath(); g.moveTo(w === 0 ? 0.42 : 0.58, 0.56); g.lineTo(w === 0 ? 0.23 : 0.77, 0.43); g.stroke();
      g.beginPath(); g.moveTo(w === 0 ? 0.42 : 0.58, 0.55); g.lineTo(w === 0 ? 0.30 : 0.70, 0.32); g.stroke();
      g.restore();
      cFlame(g, w === 0 ? 0.215 : 0.785, 0.395, 0.095, 0.165, GOLD, '#ff8a3d');
      cFlame(g, w === 0 ? 0.17 : 0.83, 0.315, 0.055, 0.105, '#fff0a0', GOLD);
    }
    // 身体 + 奶油胸羽
    cEll(g, 0.5, 0.615, 0.155, 0.185, 0, cRad(g, 0.46, 0.55, 0.02, 0.24, [[0, '#ff9a7a'], [0.55, RED], [1, REDD]]), OL, 0.02);
    cEll(g, 0.5, 0.675, 0.082, 0.115, 0, CREAM);
    cEll(g, 0.5, 0.675, 0.082, 0.115, 0, null, 'rgba(200,120,70,.35)', 0.008);
    // 颈 + 头
    cCurveTaper(g, 0.5, 0.53, 0.48, 0.455, 0.462, 0.405, 0.072, 0.055, RED, REDD, 0.014);
    cCir(g, 0.462, 0.352, 0.108, cRad(g, 0.42, 0.30, 0.02, 0.16, [[0, '#ff9a7a'], [0.6, RED], [1, REDD]]), OL, 0.018);
    // 冠羽（燃焰翎）
    cFlame(g, 0.44, 0.26, 0.075, 0.135, RED, null);
    cFlame(g, 0.49, 0.255, 0.065, 0.15, REDL, null);
    cFlame(g, 0.53, 0.275, 0.055, 0.115, GOLD, null);
    // 金喙
    cShp(g, [[0.375, 0.338], [0.225, 0.362], [0.372, 0.398]], cLin(g, 0.24, 0.33, 0.38, 0.40, [[0, GOLD], [1, GOLDD]]), '#9a7408', 0.012);
    g.strokeStyle = '#9a7408'; g.lineWidth = 0.009;
    g.beginPath(); g.moveTo(0.235, 0.362); g.lineTo(0.372, 0.380); g.stroke();
    // 眼
    cEye(g, 0.437, 0.330, 0.034, '#fffdf6', '#3a2410', '#1c1208');
    cEll(g, 0.525, 0.335, 0.026, 0.016, 0.5, REDL);
    // 火粒
    cSpark(g, 0.30, 0.205, 0.022, GOLD);
    cSpark(g, 0.72, 0.235, 0.018, GOLD);
    cCir(g, 0.26, 0.26, 0.012, '#ff8a3d');
    cCir(g, 0.75, 0.30, 0.010, '#ff8a3d');
  };

  // 玄武：墨绿龟甲金纹，青色蛇颈缠绕
  ICONS.xuanwu = function (g) {
    iconBG(g, '#2f4a3a', '#c8f0dc');
    var OL = 'rgba(8,24,16,.66)';
    var SHELL = '#4f7a5f', SHELLD = '#24402f', SHELLL = '#8fbf9c', GOLD = '#e8b33a', GOLDD = '#a87a1a';
    var SNAKE = '#4fb9c9', SNL = '#a8eef5';
    // 龟足
    cRR(g, 0.245, 0.795, 0.10, 0.075, 0.035, SHELLD, OL, 0.014);
    cRR(g, 0.655, 0.795, 0.10, 0.075, 0.035, SHELLD, OL, 0.014);
    cClaw(g, 0.275, 0.868, 0.022, 0.2, GOLD);
    cClaw(g, 0.725, 0.868, 0.022, -0.2, GOLD);
    // 龟甲
    cEll(g, 0.5, 0.585, 0.255, 0.225, 0, cRad(g, 0.44, 0.49, 0.03, 0.34, [[0, SHELLL], [0.55, SHELL], [1, SHELLD]]), OL, 0.022);
    cEll(g, 0.5, 0.585, 0.255, 0.225, 0, null, GOLD, 0.026);
    cEll(g, 0.5, 0.585, 0.198, 0.172, 0, null, GOLDD, 0.012);
    // 甲纹
    cHex(g, 0.5, 0.585, 0.088, PI / 6, 'rgba(36,64,47,.55)', GOLD, 0.012);
    cHex(g, 0.5, 0.585, 0.040, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.335, 0.505, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.665, 0.505, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.335, 0.675, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.665, 0.675, 0.050, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.5, 0.455, 0.048, PI / 6, null, GOLD, 0.010);
    cHex(g, 0.5, 0.722, 0.048, PI / 6, null, GOLD, 0.010);
    var dots = [[0.27, 0.50], [0.24, 0.585], [0.27, 0.67], [0.73, 0.50], [0.76, 0.585], [0.73, 0.67]];
    for (var i = 0; i < dots.length; i++) cCir(g, dots[i][0], dots[i][1], 0.012, GOLD, GOLDD, 0.006);
    // 龟颈 + 头
    cCurveTaper(g, 0.30, 0.62, 0.245, 0.60, 0.215, 0.575, 0.055, 0.048, SHELL, OL, 0.014);
    cCir(g, 0.215, 0.565, 0.092, cRad(g, 0.19, 0.53, 0.02, 0.14, [[0, SHELLL], [0.6, SHELL], [1, SHELLD]]), OL, 0.018);
    cEye(g, 0.248, 0.548, 0.032, '#fffdf6', GOLD, '#3a2a08');
    cSmile(g, 0.205, 0.598, 0.028, '#1e3828', 0.011);
    cEll(g, 0.185, 0.585, 0.016, 0.010, 0, 'rgba(240,130,150,.28)');
    // 蛇：绕甲
    cCurveTaper(g, 0.79, 0.80, 0.865, 0.62, 0.735, 0.40, 0.042, 0.034, SNAKE, '#1f6a78', 0.012);
    cCurveTaper(g, 0.735, 0.40, 0.70, 0.315, 0.62, 0.285, 0.034, 0.030, SNAKE, '#1f6a78', 0.012);
    cCir(g, 0.80, 0.665, 0.012, GOLD);
    cCir(g, 0.762, 0.50, 0.012, GOLD);
    cCir(g, 0.66, 0.335, 0.011, GOLD);
    // 蛇头
    cEll(g, 0.615, 0.278, 0.075, 0.055, -0.30, cRad(g, 0.60, 0.26, 0.01, 0.10, [[0, SNL], [1, SNAKE]]), '#1f6a78', 0.014);
    cEye(g, 0.588, 0.268, 0.024, '#fffdf6', '#e8453c', '#2a0a0a');
    // 蛇信
    g.strokeStyle = '#e8453c'; g.lineWidth = 0.010;
    g.beginPath(); g.moveTo(0.548, 0.292); g.lineTo(0.50, 0.302); g.stroke();
    g.beginPath(); g.moveTo(0.50, 0.302); g.lineTo(0.478, 0.288); g.stroke();
    g.beginPath(); g.moveTo(0.50, 0.302); g.lineTo(0.482, 0.318); g.stroke();
    // 蛇鳞点
    cCir(g, 0.735, 0.44, 0.008, SNL);
    cCir(g, 0.775, 0.56, 0.008, SNL);
    cCir(g, 0.80, 0.70, 0.008, SNL);
    cSpark(g, 0.84, 0.30, 0.022, SNL);
  };

  // 鹿蜀：白马形、虎纹、赤尾、长耳
  ICONS.lushu = function (g) {
    iconBG(g, '#b8894a', '#f7e6c8');
    var OL = 'rgba(60,42,20,.60)';
    var W = '#f4efe2', WD = '#d9d0bc', TG = '#b8894a', TGD = '#8a6234', RED = '#d0432e', REDD = '#a82a1e', GOLD = '#e8b33a';
    // 赤尾（三缕蓬松尾毛）
    cCurveTaper(g, 0.705, 0.74, 0.845, 0.710, 0.815, 0.385, 0.050, 0.030, cLin(g, 0.71, 0.74, 0.82, 0.38, [[0, RED], [1, REDD]]), '#7a1a14', 0.012);
    cCurveTaper(g, 0.695, 0.755, 0.815, 0.665, 0.865, 0.445, 0.046, 0.020, RED, '#7a1a14', 0.011);
    cCurveTaper(g, 0.690, 0.775, 0.835, 0.775, 0.875, 0.585, 0.042, 0.018, REDD, '#6a140f', 0.011);
    cEll(g, 0.815, 0.395, 0.048, 0.062, -0.25, RED, '#7a1a14', 0.010);
    cEll(g, 0.862, 0.452, 0.040, 0.056, 0.20, REDD, '#6a140f', 0.010);
    cEll(g, 0.868, 0.596, 0.036, 0.050, 0.35, REDD, '#6a140f', 0.010);
    // 身体
    cEll(g, 0.575, 0.735, 0.185, 0.135, 0, cLin(g, 0.5, 0.66, 0.65, 0.84, [[0, W], [1, WD]]), OL, 0.018);
    // 前腿 + 蹄
    cTaper(g, 0.455, 0.795, 0.445, 0.875, 0.030, 0.022, W, OL, 0.012);
    cTaper(g, 0.615, 0.795, 0.625, 0.875, 0.030, 0.022, W, OL, 0.012);
    cRR(g, 0.425, 0.868, 0.040, 0.026, 0.010, TGD, OL, 0.009);
    cRR(g, 0.605, 0.868, 0.040, 0.026, 0.010, TGD, OL, 0.009);
    // 长耳
    cCurveTaper(g, 0.375, 0.345, 0.315, 0.235, 0.305, 0.155, 0.042, 0.014, W, OL, 0.013);
    cCurveTaper(g, 0.535, 0.325, 0.595, 0.215, 0.612, 0.140, 0.042, 0.014, W, OL, 0.013);
    cCurveTaper(g, 0.372, 0.340, 0.325, 0.255, 0.318, 0.195, 0.020, 0.007, TG, null, 0);
    cCurveTaper(g, 0.532, 0.320, 0.585, 0.235, 0.598, 0.180, 0.020, 0.007, TG, null, 0);
    // 颈后鬃毛
    cShp(g, [[0.63, 0.50], [0.70, 0.46], [0.68, 0.545], [0.745, 0.56], [0.665, 0.60], [0.70, 0.655], [0.615, 0.63], [0.625, 0.70], [0.575, 0.64]], TG, TGD, 0.012);
    // 头
    cEll(g, 0.455, 0.475, 0.168, 0.188, -0.10, cRad(g, 0.40, 0.40, 0.03, 0.26, [[0, '#fdfaf1'], [0.6, W], [1, WD]]), OL, 0.022);
    // 虎纹
    g.save();
    g.strokeStyle = TG; g.lineWidth = 0.018; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0.315, 0.512); g.quadraticCurveTo(0.345, 0.505, 0.362, 0.520); g.stroke();
    g.beginPath(); g.moveTo(0.308, 0.552); g.quadraticCurveTo(0.338, 0.548, 0.354, 0.562); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.475); g.quadraticCurveTo(0.575, 0.49, 0.572, 0.515); g.stroke();
    g.beginPath(); g.moveTo(0.625, 0.51); g.quadraticCurveTo(0.60, 0.525, 0.598, 0.552); g.stroke();
    g.lineWidth = 0.016;
    g.beginPath(); g.moveTo(0.47, 0.755); g.quadraticCurveTo(0.50, 0.74, 0.53, 0.752); g.stroke();
    g.beginPath(); g.moveTo(0.45, 0.795); g.quadraticCurveTo(0.48, 0.782, 0.51, 0.792); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.78); g.quadraticCurveTo(0.63, 0.768, 0.66, 0.776); g.stroke();
    g.restore();
    // 口鼻
    cEll(g, 0.415, 0.602, 0.118, 0.088, -0.12, '#fbf7ec', OL, 0.015);
    cEll(g, 0.372, 0.582, 0.016, 0.012, 0.18, '#5a3a22');
    cEll(g, 0.452, 0.578, 0.016, 0.012, -0.18, '#5a3a22');
    cSmile(g, 0.405, 0.618, 0.040, '#5a3a22', 0.012);
    // 眼
    cEye(g, 0.392, 0.470, 0.050, '#fffdf6', '#5a3a1a', '#241408');
    cEye(g, 0.532, 0.458, 0.050, '#fffdf6', '#5a3a1a', '#241408');
    // 额间金饰
    cCir(g, 0.455, 0.345, 0.026, GOLD, '#a87a10', 0.008);
    cCir(g, 0.455, 0.345, 0.011, '#fff6d8');
    // 腮红
    cEll(g, 0.345, 0.565, 0.028, 0.016, 0, 'rgba(232,120,110,.28)');
    cEll(g, 0.505, 0.555, 0.024, 0.014, 0, 'rgba(232,120,110,.24)');
  };

  // 蜈蚣精：多节百足、毒颚、触须
  ICONS.wugong = function (g) {
    iconBG(g, '#6b4a34', '#e8c8a0');
    var OL = 'rgba(28,14,6,.66)';
    var B = '#5a3a2a', BL = '#8a5a3a', OCH = '#b8743a', TOX = '#9bd44a', TOXD = '#5f8f22';
    var segs = [
      [0.225, 0.700, 0.052], [0.255, 0.625, 0.062], [0.315, 0.565, 0.072],
      [0.395, 0.525, 0.080], [0.475, 0.515, 0.086], [0.545, 0.535, 0.092]
    ];
    // 百足
    g.strokeStyle = BL; g.lineWidth = 0.014;
    for (var i = 0; i < segs.length; i++) {
      var sx = segs[i][0], sy = segs[i][1], sr = segs[i][2];
      for (var k = 0; k < 2; k++) {
        var side = k === 0 ? -1 : 1;
        g.beginPath();
        g.moveTo(sx + side * sr * 0.5, sy + sr * 0.4);
        g.quadraticCurveTo(sx + side * (sr + 0.055), sy + sr * 0.55 + 0.015, sx + side * (sr + 0.05), sy + sr * 0.55 + 0.075);
        g.stroke();
        cCir(g, sx + side * (sr + 0.05), sy + sr * 0.55 + 0.075, 0.011, TOX);
      }
    }
    // 体节
    for (var j = segs.length - 1; j >= 0; j--) {
      var x = segs[j][0], y = segs[j][1], r = segs[j][2];
      cCir(g, x, y, r, cRad(g, x - r * 0.35, y - r * 0.4, 0.01, r * 1.4, [[0, '#d99a5e'], [0.6, OCH], [1, B]]), OL, 0.014);
      cCir(g, x, y, r * 0.58, null, 'rgba(90,58,42,.65)', 0.010);
      cCir(g, x - r * 0.22, y - r * 0.28, r * 0.22, TOX);
      cCir(g, x - r * 0.22, y - r * 0.28, r * 0.10, TOXD);
    }
    // 尾刺
    cShp(g, [[0.195, 0.705], [0.135, 0.745], [0.20, 0.762]], TOXD, '#3a5a14', 0.010);
    // 头
    cCir(g, 0.615, 0.585, 0.150, cRad(g, 0.57, 0.52, 0.02, 0.20, [[0, '#a8744a'], [0.6, B], [1, '#3a2416']]), OL, 0.02);
    cCir(g, 0.615, 0.585, 0.150, null, 'rgba(155,212,74,.30)', 0.016);
    // 触须
    g.strokeStyle = TOXD; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.575, 0.455); g.quadraticCurveTo(0.535, 0.395, 0.555, 0.335); g.stroke();
    g.beginPath(); g.moveTo(0.655, 0.455); g.quadraticCurveTo(0.705, 0.40, 0.685, 0.335); g.stroke();
    cCir(g, 0.555, 0.328, 0.016, TOX, TOXD, 0.007);
    cCir(g, 0.685, 0.328, 0.016, TOX, TOXD, 0.007);
    // 毒颚
    cCurveTaper(g, 0.555, 0.695, 0.47, 0.745, 0.445, 0.700, 0.020, 0.006, TOXD, '#3a5a14', 0.009);
    cCurveTaper(g, 0.675, 0.695, 0.755, 0.745, 0.775, 0.700, 0.020, 0.006, TOXD, '#3a5a14', 0.009);
    cCir(g, 0.442, 0.708, 0.012, TOX);
    cCir(g, 0.778, 0.708, 0.012, TOX);
    // 复眼
    cEye(g, 0.568, 0.565, 0.046, '#f4ffd8', TOX, '#1f2a0a');
    cEye(g, 0.662, 0.565, 0.046, '#f4ffd8', TOX, '#1f2a0a');
    cCir(g, 0.605, 0.505, 0.014, TOX);
    cCir(g, 0.628, 0.500, 0.010, TOX);
    cCir(g, 0.583, 0.500, 0.010, TOX);
    // 口器
    cEll(g, 0.615, 0.635, 0.045, 0.024, 0, '#2a1a10', 'rgba(155,212,74,.5)', 0.010);
    cCir(g, 0.51, 0.735, 0.014, TOX);
    cCir(g, 0.72, 0.735, 0.012, TOX);
    cEll(g, 0.515, 0.640, 0.020, 0.012, 0, 'rgba(155,212,74,.35)');
    cEll(g, 0.715, 0.640, 0.020, 0.012, 0, 'rgba(155,212,74,.35)');
  };

  // 鸩鸟：毒紫毒羽、金喙、赤目、长尾羽
  ICONS.zhen = function (g) {
    iconBG(g, '#4a2f6a', '#d8c4f2');
    var OL = 'rgba(20,8,36,.66)';
    var PUR = '#8a5fbf', PURL = '#c8a8ee', PURD = '#4a2f6a', GOLD = '#ffd93d', GOLDD = '#c99a10', RED = '#e8453c', TOX = '#9bd44a';
    // 长尾羽
    cCurveTaper(g, 0.575, 0.665, 0.78, 0.70, 0.86, 0.565, 0.048, 0.014, PUR, PURD, 0.012);
    cCurveTaper(g, 0.59, 0.685, 0.81, 0.775, 0.865, 0.73, 0.042, 0.012, PURD, '#2a1640', 0.012);
    cCurveTaper(g, 0.60, 0.655, 0.80, 0.62, 0.86, 0.455, 0.036, 0.012, PURL, PURD, 0.010);
    // 毒雾
    cCir(g, 0.79, 0.34, 0.030, 'rgba(155,212,74,.22)');
    cCir(g, 0.835, 0.39, 0.020, 'rgba(200,168,238,.30)');
    cCir(g, 0.74, 0.28, 0.016, 'rgba(200,168,238,.35)');
    // 薄翅
    g.save();
    g.globalAlpha = 0.55;
    cEll(g, 0.345, 0.545, 0.135, 0.075, -0.55, '#e8dcff', '#b8a0d8', 0.012);
    g.restore();
    // 身体 + 腹羽
    cEll(g, 0.5, 0.62, 0.155, 0.175, 0, cRad(g, 0.46, 0.56, 0.02, 0.23, [[0, '#b48ae0'], [0.55, PUR], [1, PURD]]), OL, 0.02);
    cEll(g, 0.5, 0.68, 0.085, 0.105, 0, PURL);
    // 折叠翅
    cShp(g, [[0.56, 0.60], [0.72, 0.62], [0.76, 0.72], [0.64, 0.70]], PURD, '#2a1640', 0.012);
    g.strokeStyle = 'rgba(200,168,238,.6)'; g.lineWidth = 0.009;
    g.beginPath(); g.moveTo(0.60, 0.615); g.lineTo(0.70, 0.655); g.stroke();
    g.beginPath(); g.moveTo(0.59, 0.635); g.lineTo(0.685, 0.685); g.stroke();
    // 颈 + 头
    cCurveTaper(g, 0.49, 0.50, 0.465, 0.45, 0.455, 0.405, 0.062, 0.052, PUR, PURD, 0.014);
    cCir(g, 0.455, 0.355, 0.115, cRad(g, 0.42, 0.30, 0.02, 0.17, [[0, '#c8a8ee'], [0.55, PUR], [1, PURD]]), OL, 0.018);
    // 冠羽
    cCurveTaper(g, 0.44, 0.27, 0.435, 0.205, 0.47, 0.17, 0.024, 0.007, PURD, '#2a1640', 0.009);
    cCurveTaper(g, 0.475, 0.26, 0.50, 0.195, 0.545, 0.175, 0.022, 0.007, PUR, PURD, 0.009);
    cCurveTaper(g, 0.505, 0.275, 0.555, 0.225, 0.60, 0.215, 0.018, 0.006, PURL, PURD, 0.009);
    // 金喙
    cShp(g, [[0.372, 0.342], [0.235, 0.368], [0.372, 0.402]], cLin(g, 0.25, 0.34, 0.38, 0.40, [[0, GOLD], [1, GOLDD]]), '#9a7408', 0.011);
    g.strokeStyle = '#9a7408'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.245, 0.368); g.lineTo(0.372, 0.385); g.stroke();
    // 赤目
    cGlow(g, 0.43, 0.335, 0.075, RED, 0.35);
    cEye(g, 0.43, 0.335, 0.034, '#fffdf6', RED, '#3a0a08');
    cCir(g, 0.535, 0.345, 0.013, RED);
    cCir(g, 0.56, 0.315, 0.009, RED);
    // 爪
    cTaper(g, 0.47, 0.785, 0.455, 0.855, 0.018, 0.012, GOLD, GOLDD, 0.008);
    cTaper(g, 0.53, 0.785, 0.545, 0.855, 0.018, 0.012, GOLD, GOLDD, 0.008);
    cClaw(g, 0.455, 0.862, 0.018, 0.2, GOLDD);
    cClaw(g, 0.545, 0.862, 0.018, -0.2, GOLDD);
    // 毒点
    cCir(g, 0.335, 0.29, 0.012, TOX);
    cCir(g, 0.70, 0.245, 0.010, TOX);
  };

  // 木魅：树桩妖，苔绿树冠、树皮脸、根须手
  ICONS.mumei = function (g) {
    iconBG(g, '#c9a86a', '#f7ecd2');
    var OL = 'rgba(40,26,12,.62)';
    var BARK = '#6a4a2e', BARKD = '#4a321e', BARKL = '#9a7048';
    var MOSS = '#7ec850', MOSSD = '#4e9c3f', MOSSY = '#c8f080';
    // 根须手
    cCurveTaper(g, 0.335, 0.74, 0.245, 0.775, 0.195, 0.695, 0.030, 0.016, BARK, BARKD, 0.011);
    cCurveTaper(g, 0.665, 0.74, 0.755, 0.775, 0.805, 0.695, 0.030, 0.016, BARK, BARKD, 0.011);
    cTaper(g, 0.20, 0.70, 0.165, 0.655, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.195, 0.70, 0.19, 0.64, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.20, 0.705, 0.235, 0.65, 0.010, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.80, 0.70, 0.835, 0.655, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.805, 0.70, 0.81, 0.64, 0.011, 0.004, BARK, BARKD, 0.006);
    cTaper(g, 0.80, 0.705, 0.765, 0.65, 0.010, 0.004, BARK, BARKD, 0.006);
    // 树桩身体
    cRR(g, 0.335, 0.44, 0.33, 0.40, 0.16, cLin(g, 0.34, 0.44, 0.67, 0.84, [[0, BARKL], [0.5, BARK], [1, BARKD]]), OL, 0.02);
    // 树皮纹理
    g.strokeStyle = BARKD; g.lineWidth = 0.010;
    for (var i = 0; i < 6; i++) {
      var x = 0.375 + i * 0.045;
      g.beginPath();
      g.moveTo(x, 0.48 + (i % 2) * 0.03);
      g.quadraticCurveTo(x + 0.012, 0.62, x - 0.006, 0.80);
      g.stroke();
    }
    g.strokeStyle = 'rgba(154,112,72,.55)'; g.lineWidth = 0.012;
    g.beginPath(); g.arc(0.5, 0.50, 0.13, PI * 1.15, PI * 1.85); g.stroke();
    // 苔绿树冠
    cCir(g, 0.365, 0.415, 0.105, MOSS, MOSSD, 0.014);
    cCir(g, 0.5, 0.375, 0.135, cRad(g, 0.47, 0.33, 0.01, 0.16, [[0, MOSSY], [0.6, MOSS], [1, MOSSD]]), MOSSD, 0.014);
    cCir(g, 0.635, 0.415, 0.105, MOSS, MOSSD, 0.014);
    cCir(g, 0.43, 0.335, 0.070, MOSSY, MOSSD, 0.010);
    cCir(g, 0.575, 0.325, 0.062, MOSSY, MOSSD, 0.010);
    cCir(g, 0.45, 0.315, 0.016, '#eaffc0');
    cCir(g, 0.60, 0.31, 0.012, '#eaffc0');
    cEll(g, 0.72, 0.36, 0.030, 0.016, 0.8, MOSS, MOSSD, 0.009);
    cEll(g, 0.285, 0.345, 0.028, 0.015, -0.7, MOSS, MOSSD, 0.009);
    // 树皮脸：眼窝 + 发光眼
    cEll(g, 0.44, 0.575, 0.062, 0.072, 0, '#2a1a0e', BARKD, 0.012);
    cEll(g, 0.56, 0.575, 0.062, 0.072, 0, '#2a1a0e', BARKD, 0.012);
    cEll(g, 0.44, 0.578, 0.034, 0.040, 0, MOSSY);
    cEll(g, 0.56, 0.578, 0.034, 0.040, 0, MOSSY);
    cCir(g, 0.44, 0.575, 0.014, '#2a4a10');
    cCir(g, 0.56, 0.575, 0.014, '#2a4a10');
    cCir(g, 0.43, 0.565, 0.008, '#ffffff');
    cCir(g, 0.55, 0.565, 0.008, '#ffffff');
    // 苔眉
    cEll(g, 0.44, 0.515, 0.055, 0.018, -0.08, MOSS, MOSSD, 0.008);
    cEll(g, 0.56, 0.515, 0.055, 0.018, 0.08, MOSS, MOSSD, 0.008);
    // 树洞嘴
    cEll(g, 0.5, 0.685, 0.055, 0.035, 0, '#241408', BARKD, 0.010);
    cEll(g, 0.5, 0.692, 0.030, 0.014, 0, MOSSY);
    // 年轮
    cCir(g, 0.5, 0.79, 0.085, null, 'rgba(74,50,30,.55)', 0.012);
    cCir(g, 0.5, 0.79, 0.045, null, 'rgba(74,50,30,.45)', 0.010);
    // 小蘑菇
    cEll(g, 0.72, 0.80, 0.022, 0.016, 0, '#e8d0a8', '#8a6234', 0.007);
    cCir(g, 0.72, 0.782, 0.026, '#d0432e', '#8a2018', 0.008);
    cCir(g, 0.715, 0.776, 0.006, '#ffe0d0');
    // 苔斑
    cCir(g, 0.36, 0.79, 0.012, MOSS);
    cCir(g, 0.64, 0.815, 0.010, MOSS);
  };

  // 玄蜂：玄黑巨蜂、金环纹、毒针、灰蓝薄翅
  ICONS.xuanfeng = function (g) {
    iconBG(g, '#e8b33a', '#fff6cf');
    var OL = 'rgba(30,24,10,.66)';
    var BLK = '#2b2b36', BLKL = '#4a4a5c', GOLD = '#e8b33a', GOLDD = '#a87a1a', WING = '#9fb8d8', TOX = '#b57ad8';
    // 四片薄翅
    g.save();
    g.globalAlpha = 0.58;
    cEll(g, 0.30, 0.40, 0.155, 0.078, -0.55, WING, '#6a86a8', 0.014);
    cEll(g, 0.70, 0.40, 0.155, 0.078, 0.55, WING, '#6a86a8', 0.014);
    cEll(g, 0.33, 0.625, 0.135, 0.066, -0.22, WING, '#6a86a8', 0.012);
    cEll(g, 0.67, 0.625, 0.135, 0.066, 0.22, WING, '#6a86a8', 0.012);
    g.restore();
    g.save();
    g.globalAlpha = 0.38; g.strokeStyle = '#4a6384'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.37, 0.44); g.lineTo(0.22, 0.335); g.stroke();
    g.beginPath(); g.moveTo(0.63, 0.44); g.lineTo(0.78, 0.335); g.stroke();
    g.beginPath(); g.moveTo(0.37, 0.63); g.lineTo(0.235, 0.60); g.stroke();
    g.beginPath(); g.moveTo(0.63, 0.63); g.lineTo(0.765, 0.60); g.stroke();
    g.restore();
    // 六足（玄黑 + 金节）
    var legs = [[0.43, 0.66, -1], [0.57, 0.66, 1], [0.44, 0.735, -1], [0.56, 0.735, 1], [0.455, 0.80, -1], [0.545, 0.80, 1]];
    for (var li = 0; li < legs.length; li++) {
      var lx = legs[li][0], ly = legs[li][1], sd = legs[li][2];
      g.strokeStyle = BLK; g.lineWidth = 0.016;
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(lx + sd * 0.055, ly + 0.035);
      g.lineTo(lx + sd * 0.075, ly + 0.085);
      g.stroke();
      cCir(g, lx + sd * 0.055, ly + 0.035, 0.012, GOLD, GOLDD, 0.005);
    }
    // 毒针
    cShp(g, [[0.468, 0.855], [0.5, 0.928], [0.532, 0.855]], TOX, '#6a3a8f', 0.010);
    cShp(g, [[0.478, 0.852], [0.5, 0.888], [0.522, 0.852]], '#e0c0f8', null, 0);
    // 腹部 + 金环纹
    cEll(g, 0.5, 0.735, 0.172, 0.135, 0, cRad(g, 0.44, 0.68, 0.02, 0.24, [[0, BLKL], [0.55, BLK], [1, '#17171f']]), OL, 0.018);
    cEll(g, 0.5, 0.700, 0.150, 0.019, 0, GOLD, GOLDD, 0.006);
    cEll(g, 0.5, 0.742, 0.163, 0.019, 0, GOLD, GOLDD, 0.006);
    cEll(g, 0.5, 0.784, 0.142, 0.018, 0, GOLD, GOLDD, 0.006);
    // 胸节 + 金纹
    cEll(g, 0.5, 0.615, 0.132, 0.078, 0, cLin(g, 0.5, 0.55, 0.5, 0.69, [[0, BLKL], [1, BLK]]), OL, 0.014);
    cShp(g, [[0.5, 0.565], [0.552, 0.615], [0.5, 0.668], [0.448, 0.615]], null, GOLD, 0.010);
    cCir(g, 0.5, 0.615, 0.016, GOLD);
    // 触角
    g.strokeStyle = BLK; g.lineWidth = 0.014;
    g.beginPath(); g.moveTo(0.44, 0.305); g.quadraticCurveTo(0.375, 0.235, 0.40, 0.185); g.stroke();
    g.beginPath(); g.moveTo(0.56, 0.305); g.quadraticCurveTo(0.625, 0.235, 0.60, 0.185); g.stroke();
    cCir(g, 0.40, 0.178, 0.018, GOLD, GOLDD, 0.006);
    cCir(g, 0.60, 0.178, 0.018, GOLD, GOLDD, 0.006);
    // 头
    cCir(g, 0.5, 0.415, 0.155, cRad(g, 0.44, 0.35, 0.02, 0.21, [[0, BLKL], [0.6, BLK], [1, '#17171f']]), OL, 0.02);
    // 金环纹（头）
    g.strokeStyle = GOLD; g.lineWidth = 0.012;
    g.beginPath(); g.arc(0.5, 0.415, 0.148, PI * 1.10, PI * 1.90); g.stroke();
    // 复眼（金）
    cEll(g, 0.425, 0.400, 0.058, 0.072, -0.20, cLin(g, 0.39, 0.34, 0.47, 0.47, [[0, '#ffe9a0'], [0.55, GOLD], [1, GOLDD]]), '#7a5a08', 0.012);
    cEll(g, 0.575, 0.400, 0.058, 0.072, 0.20, cLin(g, 0.61, 0.34, 0.53, 0.47, [[0, '#ffe9a0'], [0.55, GOLD], [1, GOLDD]]), '#7a5a08', 0.012);
    cCir(g, 0.415, 0.392, 0.020, '#2a2010');
    cCir(g, 0.585, 0.392, 0.020, '#2a2010');
    cCir(g, 0.408, 0.382, 0.008, '#ffffff');
    cCir(g, 0.578, 0.382, 0.008, '#ffffff');
    // 金颚
    cShp(g, [[0.452, 0.478], [0.5, 0.508], [0.548, 0.478]], GOLD, GOLDD, 0.008);
    cSmile(g, 0.5, 0.495, 0.030, '#1a1a20', 0.010);
    // 毒紫光点
    cCir(g, 0.34, 0.72, 0.011, TOX);
    cCir(g, 0.66, 0.72, 0.010, TOX);
  };

  // 狰：赤豹、独角、五尾、獠牙、骨白鬃毛
  ICONS.zheng = function (g) {
    iconBG(g, '#a8643a', '#f2d8b8');
    var OL = 'rgba(52,18,8,.64)';
    var RUST = '#c2452e', RUSTD = '#8a2c1c', BONE = '#f0e6d2', BONED = '#cbbd9f', GOLD = '#e8b33a', DARK = '#3a140c';
    // 五尾
    var tails = [
      [0.86, 0.73, 0.045], [0.885, 0.60, 0.042], [0.86, 0.465, 0.040], [0.80, 0.365, 0.036], [0.70, 0.315, 0.032]
    ];
    for (var ti = 0; ti < tails.length; ti++) {
      var ex = tails[ti][0], ey = tails[ti][1], ew = tails[ti][2];
      cCurveTaper(g, 0.60, 0.715, 0.76, 0.70, ex, ey, 0.042, ew, cLin(g, 0.60, 0.72, ex, ey, [[0, RUST], [0.7, RUSTD], [1, '#5a1a10']]), '#4a120a', 0.010);
      cCir(g, ex, ey, ew * 0.9, BONE, BONED, 0.006);
    }
    // 身体
    cEll(g, 0.5, 0.715, 0.265, 0.145, 0, cLin(g, 0.5, 0.64, 0.5, 0.86, [[0, RUST], [1, RUSTD]]), OL, 0.018);
    // 鬃毛（骨白尖刺）
    for (var mi = 0; mi < 9; mi++) {
      var ma = PI * 1.12 + mi * (PI * 0.76 / 8);
      var bx = 0.47 + Math.cos(ma) * 0.185;
      var by = 0.50 + Math.sin(ma) * 0.185;
      var tipx = 0.47 + Math.cos(ma) * 0.285;
      var tipy = 0.50 + Math.sin(ma) * 0.285;
      var nx = -Math.sin(ma) * 0.030, ny = Math.cos(ma) * 0.030;
      cShp(g, [[bx + nx, by + ny], [tipx, tipy], [bx - nx, by - ny]], mi % 2 ? BONE : BONED, '#9a8a6a', 0.008);
    }
    // 独脚 + 骨环
    cCurveTaper(g, 0.47, 0.345, 0.40, 0.245, 0.365, 0.155, 0.032, 0.010, BONE, BONED, 0.012);
    g.strokeStyle = 'rgba(160,140,110,.8)'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.452, 0.302); g.lineTo(0.392, 0.278); g.stroke();
    g.beginPath(); g.moveTo(0.43, 0.262); g.lineTo(0.378, 0.238); g.stroke();
    cCir(g, 0.47, 0.345, 0.035, GOLD, '#a87a10', 0.009);
    // 耳
    cShp(g, [[0.325, 0.42], [0.285, 0.285], [0.395, 0.365]], RUST, OL, 0.012);
    cShp(g, [[0.675, 0.42], [0.715, 0.285], [0.605, 0.365]], RUST, OL, 0.012);
    cShp(g, [[0.335, 0.408], [0.312, 0.325], [0.383, 0.373]], BONED, null, 0);
    cShp(g, [[0.665, 0.408], [0.688, 0.325], [0.617, 0.373]], BONED, null, 0);
    // 头
    cCir(g, 0.47, 0.495, 0.205, cRad(g, 0.40, 0.42, 0.03, 0.30, [[0, '#e0705a'], [0.55, RUST], [1, RUSTD]]), OL, 0.022);
    // 面颊骨白
    cEll(g, 0.415, 0.565, 0.075, 0.060, -0.10, BONE, BONED, 0.012);
    cEll(g, 0.535, 0.565, 0.075, 0.060, 0.10, BONE, BONED, 0.012);
    // 豹斑
    var spots = [[0.33, 0.44, 0.018], [0.60, 0.43, 0.016], [0.325, 0.60, 0.014], [0.61, 0.585, 0.015], [0.42, 0.72, 0.016], [0.56, 0.735, 0.014]];
    for (var si = 0; si < spots.length; si++) {
      cCir(g, spots[si][0], spots[si][1], spots[si][2], null, 'rgba(74,18,10,.7)', 0.008);
      cCir(g, spots[si][0], spots[si][1], spots[si][2] * 0.45, 'rgba(74,18,10,.45)');
    }
    // 鼻 + 大口獠牙
    cShp(g, [[0.47, 0.535], [0.445, 0.578], [0.495, 0.578]], RUSTD, null, 0);
    cShp(g, [[0.375, 0.618], [0.5, 0.672], [0.625, 0.618], [0.6, 0.60], [0.5, 0.632], [0.40, 0.60]], DARK, '#2a0a06', 0.010);
    // 上獠牙
    cShp(g, [[0.398, 0.622], [0.418, 0.672], [0.438, 0.622]], BONE, BONED, 0.008);
    cShp(g, [[0.562, 0.622], [0.582, 0.672], [0.602, 0.622]], BONE, BONED, 0.008);
    // 下獠牙
    cShp(g, [[0.435, 0.655], [0.455, 0.708], [0.475, 0.655]], BONE, BONED, 0.007);
    cShp(g, [[0.525, 0.655], [0.545, 0.708], [0.565, 0.655]], BONE, BONED, 0.007);
    // 眼（金瞳 + 竖瞳）
    cEye(g, 0.398, 0.492, 0.050, '#fffdf6', GOLD, '#2a1a06');
    cEye(g, 0.542, 0.492, 0.050, '#fffdf6', GOLD, '#2a1a06');
    g.fillStyle = '#1a0e04';
    cEll(g, 0.398, 0.498, 0.010, 0.026, 0, '#1a0e04');
    cEll(g, 0.542, 0.498, 0.010, 0.026, 0, '#1a0e04');
    // 怒眉
    g.strokeStyle = '#4a120a'; g.lineWidth = 0.020;
    g.beginPath(); g.moveTo(0.335, 0.435); g.quadraticCurveTo(0.375, 0.418, 0.415, 0.440); g.stroke();
    g.beginPath(); g.moveTo(0.605, 0.435); g.quadraticCurveTo(0.565, 0.418, 0.525, 0.440); g.stroke();
    // 爪
    cClaw(g, 0.285, 0.79, 0.026, 1.9, BONE);
    cClaw(g, 0.715, 0.79, 0.026, -1.9, BONE);
  };

  // 九尾狐：白狐、九条飘尾、金瞳、额间朱纹
  ICONS.jiuwei = function (g) {
    iconBG(g, '#d8a24a', '#fff3cc');
    var OL = 'rgba(120,86,30,.55)';
    var WHITE = '#f4f1e8', WHITED = '#ded6c2', RED = '#e8453c', REDD = '#b32a22', GOLD = '#e8b33a', GOLDD = '#a87a10';
    // 九条尾（自左向右扇形，蓬松白尾 + 赤尾尖）
    for (var i = 0; i < 9; i++) {
      var ang = PI * 0.985 - i * (PI * 0.97 / 8);
      var bx = 0.5, by = 0.695;
      var rad = 0.325 + Math.sin(ang) * 0.062;
      var mx = bx + Math.cos(ang + 0.13) * 0.185;
      var my = by + Math.sin(ang + 0.13) * 0.185;
      var ex = bx + Math.cos(ang) * rad;
      var ey = by + Math.sin(ang) * rad;
      var w0 = 0.058, w1 = 0.034;
      cCurveTaper(g, bx, by, mx, my, ex, ey, w0, w1,
        cLin(g, bx, by, ex, ey, [[0, '#ffffff'], [0.52, WHITE], [0.80, '#ffe2cf'], [1, RED]]),
        'rgba(150,120,70,.45)', 0.007);
      cCir(g, ex, ey, w1 * 0.80, RED, REDD, 0.005);
    }
    // 身体 + 前爪
    cEll(g, 0.5, 0.775, 0.135, 0.095, 0, cLin(g, 0.5, 0.72, 0.5, 0.86, [[0, WHITE], [1, WHITED]]), OL, 0.014);
    cCir(g, 0.415, 0.845, 0.045, WHITE, OL, 0.012);
    cCir(g, 0.585, 0.845, 0.045, WHITE, OL, 0.012);
    // 耳（尖耳 + 赤内耳）
    cShp(g, [[0.345, 0.44], [0.315, 0.285], [0.44, 0.375]], WHITE, OL, 0.014);
    cShp(g, [[0.655, 0.44], [0.685, 0.285], [0.56, 0.375]], WHITE, OL, 0.014);
    cShp(g, [[0.36, 0.428], [0.342, 0.325], [0.42, 0.385]], RED, null, 0);
    cShp(g, [[0.64, 0.428], [0.658, 0.325], [0.58, 0.385]], RED, null, 0);
    // 头
    cCir(g, 0.5, 0.515, 0.168, cRad(g, 0.44, 0.45, 0.02, 0.25, [[0, '#ffffff'], [0.6, WHITE], [1, WHITED]]), OL, 0.02);
    // 额间朱纹（三瓣花钿）
    cCir(g, 0.5, 0.398, 0.022, RED, REDD, 0.006);
    cCir(g, 0.462, 0.418, 0.014, RED, REDD, 0.005);
    cCir(g, 0.538, 0.418, 0.014, RED, REDD, 0.005);
    // 口鼻
    cEll(g, 0.5, 0.60, 0.098, 0.072, 0, '#fffdf6', OL, 0.012);
    cCir(g, 0.5, 0.565, 0.020, '#3a2a1a');
    cCir(g, 0.5, 0.565, 0.008, '#ffffff');
    cSmile(g, 0.5, 0.612, 0.038, '#5a4030', 0.012);
    cShp(g, [[0.478, 0.626], [0.492, 0.652], [0.506, 0.626]], '#ffffff', '#c8b090', 0.005);
    // 金瞳（竖瞳）
    cEye(g, 0.435, 0.512, 0.048, '#fffdf6', GOLD, '#4a3408');
    cEye(g, 0.565, 0.512, 0.048, '#fffdf6', GOLD, '#4a3408');
    cEll(g, 0.435, 0.518, 0.009, 0.024, 0, '#2a1a04');
    cEll(g, 0.565, 0.518, 0.009, 0.024, 0, '#2a1a04');
    // 眼线
    g.strokeStyle = RED; g.lineWidth = 0.010;
    g.beginPath(); g.moveTo(0.388, 0.488); g.quadraticCurveTo(0.42, 0.478, 0.452, 0.492); g.stroke();
    g.beginPath(); g.moveTo(0.612, 0.488); g.quadraticCurveTo(0.58, 0.478, 0.548, 0.492); g.stroke();
    // 胡须
    g.strokeStyle = 'rgba(120,90,60,.55)'; g.lineWidth = 0.008;
    g.beginPath(); g.moveTo(0.40, 0.60); g.lineTo(0.335, 0.592); g.stroke();
    g.beginPath(); g.moveTo(0.40, 0.62); g.lineTo(0.335, 0.628); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.60); g.lineTo(0.665, 0.592); g.stroke();
    g.beginPath(); g.moveTo(0.60, 0.62); g.lineTo(0.665, 0.628); g.stroke();
    // 赤金点缀
    cSpark(g, 0.80, 0.30, 0.022, '#fff2c0');
    cSpark(g, 0.22, 0.36, 0.018, '#fff2c0');
    cEll(g, 0.365, 0.565, 0.020, 0.012, 0, 'rgba(232,110,100,.30)');
    cEll(g, 0.635, 0.565, 0.020, 0.012, 0, 'rgba(232,110,100,.30)');
  };

  // 鲛人：人鱼、长发、鳞尾、珠光、张口吟唱
  ICONS.jiaoren = function (g) {
    iconBG(g, '#1f6f7f', '#c8fff8');
    var OL = 'rgba(8,40,44,.58)';
    var SKIN = '#e8f4ee', SKIND = '#c4dcd4', SCALE = '#4fb9c9', SCALED = '#2f8a99', PEARL = '#fff6e0', GOLD = '#e8b33a', HAIR = '#2f7a8a';
    // 长发（身后）
    cCurveTaper(g, 0.40, 0.44, 0.27, 0.52, 0.245, 0.70, 0.075, 0.035, HAIR, '#1a525e', 0.012);
    cCurveTaper(g, 0.60, 0.44, 0.73, 0.52, 0.755, 0.70, 0.075, 0.035, HAIR, '#1a525e', 0.012);
    cCurveTaper(g, 0.44, 0.40, 0.35, 0.66, 0.36, 0.80, 0.055, 0.024, '#3f95a6', '#1a525e', 0.010);
    cCurveTaper(g, 0.56, 0.40, 0.65, 0.66, 0.64, 0.80, 0.055, 0.024, '#3f95a6', '#1a525e', 0.010);
    // 鳞尾（右下方缠绕）
    cCurveTaper(g, 0.50, 0.80, 0.72, 0.90, 0.865, 0.76, 0.075, 0.045, cLin(g, 0.5, 0.82, 0.86, 0.76, [[0, SCALE], [1, SCALED]]), '#1f6a78', 0.014);
    // 尾鳍
    cShp(g, [[0.855, 0.735], [0.905, 0.665], [0.875, 0.745], [0.915, 0.795], [0.855, 0.775]], 'rgba(168,238,245,.8)', '#2f8a99', 0.010);
    // 鳞纹
    cScaleRow(g, 0.62, 0.84, 3, 0.018, 'rgba(255,255,255,.55)', 0.008);
    cScaleRow(g, 0.74, 0.81, 2, 0.016, 'rgba(255,255,255,.5)', 0.008);
    // 身体
    cEll(g, 0.5, 0.71, 0.145, 0.125, 0, cLin(g, 0.5, 0.64, 0.5, 0.84, [[0, SKIN], [1, SKIND]]), OL, 0.014);
    // 肩
    cEll(g, 0.365, 0.665, 0.075, 0.055, -0.25, SKIN, OL, 0.012);
    cEll(g, 0.635, 0.665, 0.075, 0.055, 0.25, SKIN, OL, 0.012);
    // 贝壳胸饰
    cShp(g, [[0.44, 0.655], [0.5, 0.70], [0.56, 0.655], [0.53, 0.72], [0.5, 0.735], [0.47, 0.72]], PEARL, GOLD, 0.010);
    g.strokeStyle = 'rgba(200,160,80,.55)'; g.lineWidth = 0.007;
    g.beginPath(); g.moveTo(0.5, 0.70); g.lineTo(0.47, 0.665); g.stroke();
    g.beginPath(); g.moveTo(0.5, 0.70); g.lineTo(0.53, 0.665); g.stroke();
    // 头 + 长发
    cCir(g, 0.5, 0.465, 0.170, cRad(g, 0.44, 0.40, 0.02, 0.25, [[0, '#ffffff'], [0.6, SKIN], [1, SKIND]]), OL, 0.018);
    // 刘海
    cShp(g, [[0.335, 0.47], [0.345, 0.365], [0.40, 0.315], [0.47, 0.298], [0.545, 0.31], [0.62, 0.355], [0.665, 0.47], [0.61, 0.42], [0.55, 0.398], [0.50, 0.43], [0.45, 0.398], [0.39, 0.42]], cLin(g, 0.4, 0.30, 0.6, 0.47, [[0, '#4aa3b4'], [1, HAIR]]), '#1a525e', 0.012);
    // 侧发丝
    cCurveTaper(g, 0.345, 0.44, 0.29, 0.50, 0.275, 0.575, 0.032, 0.014, HAIR, '#1a525e', 0.008);
    cCurveTaper(g, 0.655, 0.44, 0.71, 0.50, 0.725, 0.575, 0.032, 0.014, HAIR, '#1a525e', 0.008);
    // 珍珠额饰
    cCir(g, 0.5, 0.352, 0.028, PEARL, GOLD, 0.008);
    cCir(g, 0.5, 0.352, 0.011, '#ffffff');
    cCir(g, 0.435, 0.375, 0.014, PEARL, GOLD, 0.006);
    cCir(g, 0.565, 0.375, 0.014, PEARL, GOLD, 0.006);
    // 眼
    cEye(g, 0.437, 0.472, 0.044, '#ffffff', SCALED, '#123a40');
    cEye(g, 0.563, 0.472, 0.044, '#ffffff', SCALED, '#123a40');
    // 吟唱的口
    cEll(g, 0.5, 0.585, 0.030, 0.038, 0, '#3a2430', '#7a4a52', 0.008);
    cEll(g, 0.5, 0.60, 0.017, 0.013, 0, '#e8909a');
    // 腮红
    cEll(g, 0.395, 0.545, 0.024, 0.014, 0, 'rgba(240,130,140,.32)');
    cEll(g, 0.605, 0.545, 0.024, 0.014, 0, 'rgba(240,130,140,.32)');
    // 水泡 + 珠光
    cCir(g, 0.245, 0.43, 0.030, null, 'rgba(220,255,250,.85)', 0.010);
    cCir(g, 0.205, 0.36, 0.020, null, 'rgba(220,255,250,.75)', 0.009);
    cCir(g, 0.30, 0.335, 0.014, null, 'rgba(220,255,250,.7)', 0.008);
    cCir(g, 0.245, 0.425, 0.008, 'rgba(255,255,255,.9)');
    cSpark(g, 0.75, 0.30, 0.022, '#e0fffa');
  };

  // 魑魅：无足飘浮精魅，雾状下摆、青光眼、长耳
  ICONS.chimei = function (g) {
    iconBG(g, '#6a4aa8', '#e8d8ff');
    var OL = 'rgba(30,14,56,.55)';
    var MIST = '#8a6ac8', MISTL = '#b8a0e8', MISTD = '#5a3f96', GLOW = '#7af0d0', GOLD = '#e8b33a';
    // 雾状下摆
    g.save();
    g.globalAlpha = 0.85;
    cCurveTaper(g, 0.40, 0.66, 0.30, 0.78, 0.255, 0.86, 0.10, 0.030, cLin(g, 0.4, 0.66, 0.25, 0.87, [[0, MIST], [1, 'rgba(138,106,200,0)']]), null, 0);
    cCurveTaper(g, 0.60, 0.66, 0.70, 0.78, 0.745, 0.86, 0.10, 0.030, cLin(g, 0.6, 0.66, 0.75, 0.87, [[0, MIST], [1, 'rgba(138,106,200,0)']]), null, 0);
    cCurveTaper(g, 0.5, 0.70, 0.56, 0.82, 0.52, 0.885, 0.12, 0.030, cLin(g, 0.5, 0.70, 0.5, 0.89, [[0, MISTL], [1, 'rgba(184,160,232,0)']]), null, 0);
    g.restore();
    // 身体（飘浮，无足）
    cShp(g, [[0.345, 0.46], [0.355, 0.585], [0.44, 0.655], [0.5, 0.675], [0.56, 0.655], [0.645, 0.585], [0.655, 0.46]], cLin(g, 0.5, 0.45, 0.5, 0.68, [[0, MIST], [1, MISTD]]), OL, 0.016);
    // 长耳
    cCurveTaper(g, 0.40, 0.35, 0.33, 0.27, 0.30, 0.175, 0.040, 0.010, MIST, MISTD, 0.011);
    cCurveTaper(g, 0.60, 0.35, 0.67, 0.27, 0.70, 0.175, 0.040, 0.010, MIST, MISTD, 0.011);
    cCir(g, 0.295, 0.168, 0.020, GLOW);
    cCir(g, 0.705, 0.168, 0.020, GLOW);
    // 头
    cCir(g, 0.5, 0.445, 0.175, cRad(g, 0.44, 0.38, 0.02, 0.26, [[0, MISTL], [0.55, MIST], [1, MISTD]]), OL, 0.018);
    // 云纹额饰
    cShp(g, [[0.45, 0.365], [0.47, 0.335], [0.5, 0.352], [0.53, 0.335], [0.55, 0.365]], GOLD, '#a87a10', 0.008);
    // 青光眼
    cSpiritEye(g, 0.428, 0.445, 0.042, GLOW);
    cSpiritEye(g, 0.572, 0.445, 0.042, GLOW);
    // 小嘴
    cEll(g, 0.5, 0.545, 0.026, 0.032, 0, '#2a1a44', 'rgba(122,240,208,.5)', 0.008);
    // 腮红
    cEll(g, 0.375, 0.51, 0.028, 0.016, 0, 'rgba(200,150,255,.35)');
    cEll(g, 0.625, 0.51, 0.028, 0.016, 0, 'rgba(200,150,255,.35)');
    // 飘浮雾旋
    cSwirl(g, 0.235, 0.52, 0.055, 1.2, 'rgba(122,240,208,.55)', 0.012);
    cSwirl(g, 0.775, 0.60, 0.048, 1.2, 'rgba(200,168,238,.65)', 0.012, -1);
    cSpark(g, 0.74, 0.30, 0.018, GLOW);
    cSpark(g, 0.27, 0.31, 0.016, GLOW);
  };

  // 魍魉：墨影魍魉、双角、赤目、烟雾下摆、利爪
  ICONS.wangliang = function (g) {
    iconBG(g, '#5a3f7a', '#c8b0e8');
    var OL = 'rgba(16,6,28,.66)';
    var SHADOW = '#3a2a4a', SHADOWD = '#241a33', SHADOWL = '#6a4a8a', RED = '#e8453c', PUR = '#8a6ac8';
    // 烟雾下摆（身后）
    g.save();
    g.globalAlpha = 0.9;
    cCurveTaper(g, 0.30, 0.70, 0.20, 0.80, 0.16, 0.875, 0.09, 0.025, cLin(g, 0.3, 0.7, 0.16, 0.88, [[0, SHADOW], [1, 'rgba(58,42,74,0)']]), null, 0);
    cCurveTaper(g, 0.70, 0.70, 0.80, 0.80, 0.84, 0.875, 0.09, 0.025, cLin(g, 0.7, 0.7, 0.84, 0.88, [[0, SHADOW], [1, 'rgba(58,42,74,0)']]), null, 0);
    cCurveTaper(g, 0.5, 0.72, 0.52, 0.82, 0.50, 0.905, 0.10, 0.022, cLin(g, 0.5, 0.72, 0.5, 0.90, [[0, SHADOWL], [1, 'rgba(106,74,138,0)']]), null, 0);
    g.restore();
    // 双角
    cCurveTaper(g, 0.405, 0.335, 0.325, 0.245, 0.275, 0.155, 0.036, 0.008, SHADOWD, '#120a1c', 0.010);
    cCurveTaper(g, 0.595, 0.335, 0.675, 0.245, 0.725, 0.155, 0.036, 0.008, SHADOWD, '#120a1c', 0.010);
    cCir(g, 0.272, 0.148, 0.020, PUR, '#4a2f6a', 0.007);
    cCir(g, 0.728, 0.148, 0.020, PUR, '#4a2f6a', 0.007);
    // 影身
    cShp(g, [[0.5, 0.275], [0.62, 0.305], [0.69, 0.42], [0.745, 0.62], [0.71, 0.76], [0.60, 0.80], [0.5, 0.785], [0.40, 0.80], [0.29, 0.76], [0.255, 0.62], [0.31, 0.42], [0.38, 0.305]], cLin(g, 0.5, 0.30, 0.5, 0.78, [[0, SHADOWL], [0.45, SHADOW], [1, SHADOWD]]), OL, 0.018);
    // 肩部高光
    g.strokeStyle = 'rgba(138,106,200,.35)'; g.lineWidth = 0.012;
    g.beginPath(); g.arc(0.5, 0.50, 0.20, PI * 1.08, PI * 1.45); g.stroke();
    // 面孔（红目 + 利齿笑）
    cGlow(g, 0.428, 0.445, 0.09, RED, 0.42);
    cGlow(g, 0.572, 0.445, 0.09, RED, 0.42);
    cEll(g, 0.428, 0.445, 0.052, 0.030, -0.22, RED);
    cEll(g, 0.572, 0.445, 0.052, 0.030, 0.22, RED);
    cEll(g, 0.428, 0.445, 0.024, 0.014, -0.22, '#ffe6c0');
    cEll(g, 0.572, 0.445, 0.024, 0.014, 0.22, '#ffe6c0');
    cCir(g, 0.428, 0.443, 0.009, '#2a0a08');
    cCir(g, 0.572, 0.443, 0.009, '#2a0a08');
    // 咧嘴 + 獠牙
    cShp(g, [[0.385, 0.535], [0.5, 0.60], [0.615, 0.535], [0.575, 0.575], [0.5, 0.615], [0.425, 0.575]], '#241a33', '#120a1c', 0.010);
    var fangs = [0.415, 0.455, 0.5, 0.545, 0.585];
    for (var fi = 0; fi < fangs.length; fi++) {
      cShp(g, [[fangs[fi] - 0.014, 0.552], [fangs[fi], 0.578 + (fi % 2) * 0.008], [fangs[fi] + 0.014, 0.552]], '#e8e0f0', '#8a7aa0', 0.005);
    }
    // 利爪
    cClaw(g, 0.255, 0.66, 0.030, 1.75, RED);
    cClaw(g, 0.745, 0.66, 0.030, -1.75, RED);
    // 影子高光
    cEll(g, 0.5, 0.70, 0.11, 0.05, 0, 'rgba(138,106,200,.20)');
    // 雾旋
    cSwirl(g, 0.235, 0.33, 0.045, 1.1, 'rgba(200,168,238,.45)', 0.010);
    cSwirl(g, 0.775, 0.39, 0.040, 1.1, 'rgba(200,168,238,.40)', 0.010, -1);
  };

  // 赤鱬：鱼身人面、大眼、金鳍、吐水泡
  ICONS.chiru = function (g) {
    iconBG(g, '#e8b33a', '#fff2c8');
    var OL = 'rgba(110,34,12,.60)';
    var RED = '#e8563c', REDL = '#ff8a6a', REDD = '#b02a1a', GOLD = '#ffd93d', GOLDD = '#c99a10', SKIN = '#ffe0c8', SKIND = '#d8a880', HAIR = '#3a5468';
    // 金鳍（尾 + 背）
    cShp(g, [[0.80, 0.62], [0.915, 0.53], [0.885, 0.65], [0.92, 0.76], [0.80, 0.72]], cLin(g, 0.82, 0.55, 0.92, 0.75, [[0, GOLD], [1, GOLDD]]), '#a87a10', 0.012);
    cShp(g, [[0.46, 0.40], [0.52, 0.285], [0.585, 0.395], [0.55, 0.44], [0.50, 0.435]], GOLD, GOLDD, 0.012);
    cShp(g, [[0.34, 0.70], [0.265, 0.795], [0.385, 0.785], [0.425, 0.735]], GOLD, GOLDD, 0.010);
    // 鳍条
    g.strokeStyle = 'rgba(168,122,16,.7)'; g.lineWidth = 0.007;
    g.beginPath(); g.moveTo(0.84, 0.64); g.lineTo(0.90, 0.58); g.stroke();
    g.beginPath(); g.moveTo(0.85, 0.66); g.lineTo(0.895, 0.70); g.stroke();
    g.beginPath(); g.moveTo(0.49, 0.41); g.lineTo(0.52, 0.32); g.stroke();
    g.beginPath(); g.moveTo(0.54, 0.42); g.lineTo(0.56, 0.36); g.stroke();
    // 鱼身
    cEll(g, 0.55, 0.62, 0.245, 0.185, -0.06, cRad(g, 0.45, 0.55, 0.02, 0.30, [[0, REDL], [0.55, RED], [1, REDD]]), OL, 0.020);
    // 鳞纹
    cScaleRow(g, 0.60, 0.62, 4, 0.026, 'rgba(176,42,26,.55)', 0.009);
    cScaleRow(g, 0.66, 0.67, 3, 0.024, 'rgba(176,42,26,.45)', 0.009);
    cScaleRow(g, 0.63, 0.57, 3, 0.022, 'rgba(255,200,170,.55)', 0.008);
    // 人面
    cEll(g, 0.335, 0.565, 0.135, 0.145, -0.06, cRad(g, 0.29, 0.50, 0.02, 0.19, [[0, '#fff2e4'], [0.6, SKIN], [1, SKIND]]), OL, 0.016);
    // 头发（人面头顶）
    cShp(g, [[0.235, 0.50], [0.255, 0.425], [0.315, 0.385], [0.375, 0.40], [0.42, 0.445], [0.44, 0.52], [0.41, 0.475], [0.36, 0.455], [0.31, 0.475], [0.27, 0.455]], cLin(g, 0.28, 0.39, 0.42, 0.52, [[0, '#5a7a90'], [1, HAIR]]), '#22384a', 0.011);
    // 耳
    cEll(g, 0.213, 0.575, 0.026, 0.040, 0, SKIN, OL, 0.010);
    cEll(g, 0.455, 0.575, 0.026, 0.040, 0, SKIN, OL, 0.010);
    // 眼（大眼）
    cEye(g, 0.285, 0.552, 0.048, '#ffffff', '#3a6a8a', '#1a2a38');
    cEye(g, 0.373, 0.548, 0.048, '#ffffff', '#3a6a8a', '#1a2a38');
    // 眉
    g.strokeStyle = HAIR; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.248, 0.502); g.quadraticCurveTo(0.282, 0.488, 0.315, 0.502); g.stroke();
    g.beginPath(); g.moveTo(0.345, 0.498); g.quadraticCurveTo(0.378, 0.486, 0.408, 0.500); g.stroke();
    // 鼻 + 嘴
    g.strokeStyle = SKIND; g.lineWidth = 0.010;
    g.beginPath(); g.moveTo(0.33, 0.578); g.quadraticCurveTo(0.34, 0.595, 0.328, 0.602); g.stroke();
    cShp(g, [[0.298, 0.622], [0.355, 0.622], [0.352, 0.638], [0.328, 0.648], [0.304, 0.638]], '#c25a48', '#8a3222', 0.009);
    // 腮红
    cEll(g, 0.248, 0.602, 0.024, 0.014, 0, 'rgba(232,110,100,.32)');
    cEll(g, 0.415, 0.598, 0.022, 0.012, 0, 'rgba(232,110,100,.30)');
    // 水泡
    cCir(g, 0.185, 0.40, 0.026, null, 'rgba(255,255,255,.9)', 0.010);
    cCir(g, 0.145, 0.335, 0.018, null, 'rgba(255,255,255,.8)', 0.009);
    cCir(g, 0.225, 0.31, 0.013, null, 'rgba(255,255,255,.75)', 0.008);
    cCir(g, 0.185, 0.395, 0.007, 'rgba(255,255,255,.95)');
    // 高光点
    cSpark(g, 0.80, 0.42, 0.020, '#fff6c8');
  };

  // 饕餮：青铜巨兽、巨口獠牙、羊角、金纹、腹大
  ICONS.taotie = function (g) {
    iconBG(g, '#48603c', '#c8d8b0');
    var OL = 'rgba(20,32,16,.66)';
    var BRZ = '#6b8a5a', BRZD = '#3c5434', BRZL = '#9ab884', GOLD = '#e8b33a', GOLDD = '#a87a1a', BONE = '#f0e6d2';
    // 大腹
    cEll(g, 0.5, 0.735, 0.30, 0.175, 0, cRad(g, 0.46, 0.68, 0.02, 0.34, [[0, BRZL], [0.55, BRZ], [1, BRZD]]), OL, 0.020);
    // 腹上金纹
    cEll(g, 0.5, 0.775, 0.245, 0.115, 0, null, GOLDD, 0.010);
    cSwirl(g, 0.36, 0.78, 0.045, 1.2, GOLD, 0.011);
    cSwirl(g, 0.64, 0.78, 0.045, 1.2, GOLD, 0.011, -1);
    cCir(g, 0.5, 0.70, 0.026, GOLD, GOLDD, 0.008);
    // 羊角（金铜粗角 + 内卷纹）
    cCurveTaper(g, 0.345, 0.395, 0.255, 0.335, 0.205, 0.478, 0.052, 0.040, cLin(g, 0.33, 0.36, 0.22, 0.48, [[0, '#e8c878'], [1, '#a8823a']]), '#4a3410', 0.013);
    cCurveTaper(g, 0.655, 0.395, 0.745, 0.335, 0.795, 0.478, 0.052, 0.040, cLin(g, 0.67, 0.36, 0.78, 0.48, [[0, '#e8c878'], [1, '#a8823a']]), '#4a3410', 0.013);
    cCir(g, 0.218, 0.478, 0.034, '#8a6a2a', '#4a3410', 0.010);
    cCir(g, 0.218, 0.478, 0.017, '#e8c878');
    cCir(g, 0.782, 0.478, 0.034, '#8a6a2a', '#4a3410', 0.010);
    cCir(g, 0.782, 0.478, 0.017, '#e8c878');
    // 耳
    cShp(g, [[0.30, 0.42], [0.245, 0.49], [0.335, 0.485]], BRZ, OL, 0.011);
    cShp(g, [[0.70, 0.42], [0.755, 0.49], [0.665, 0.485]], BRZ, OL, 0.011);
    // 头（青铜面）
    cCir(g, 0.5, 0.475, 0.215, cRad(g, 0.44, 0.40, 0.02, 0.31, [[0, BRZL], [0.55, BRZ], [1, BRZD]]), OL, 0.022);
    // 额上金云纹
    cSwirl(g, 0.5, 0.395, 0.052, 1.1, GOLD, 0.012);
    cCir(g, 0.5, 0.352, 0.022, GOLD, GOLDD, 0.007);
    // 金眉
    g.strokeStyle = GOLD; g.lineWidth = 0.020;
    g.beginPath(); g.moveTo(0.325, 0.425); g.quadraticCurveTo(0.375, 0.398, 0.43, 0.425); g.stroke();
    g.beginPath(); g.moveTo(0.675, 0.425); g.quadraticCurveTo(0.625, 0.398, 0.57, 0.425); g.stroke();
    // 眼（金环 + 暗瞳）
    cCir(g, 0.395, 0.465, 0.058, GOLD, GOLDD, 0.010);
    cCir(g, 0.605, 0.465, 0.058, GOLD, GOLDD, 0.010);
    cCir(g, 0.395, 0.465, 0.036, '#2a3a24');
    cCir(g, 0.605, 0.465, 0.036, '#2a3a24');
    cCir(g, 0.395, 0.465, 0.017, BONE);
    cCir(g, 0.605, 0.465, 0.017, BONE);
    cCir(g, 0.386, 0.453, 0.010, '#ffffff');
    cCir(g, 0.596, 0.453, 0.010, '#ffffff');
    // 巨口
    cShp(g, [[0.30, 0.545], [0.5, 0.585], [0.70, 0.545], [0.66, 0.64], [0.5, 0.665], [0.34, 0.64]], '#3a1410', '#1a0a08', 0.012);
    // 上排牙
    var tx = [0.33, 0.375, 0.42, 0.465, 0.51, 0.555, 0.60, 0.645];
    for (var ti2 = 0; ti2 < tx.length; ti2++) {
      cShp(g, [[tx[ti2] - 0.017, 0.558], [tx[ti2], 0.60], [tx[ti2] + 0.017, 0.558]], BONE, '#b8a888', 0.005);
    }
    // 下排獠牙
    var bx = [0.36, 0.44, 0.52, 0.60]; // 下獠牙
    for (var bi = 0; bi < 4; bi++) {
      cShp(g, [[bx[bi] - 0.020, 0.645], [bx[bi], 0.70], [bx[bi] + 0.020, 0.645]], BONE, '#b8a888', 0.006);
    }
    // 舌尖
    cEll(g, 0.5, 0.625, 0.085, 0.026, 0, '#c2452e', '#8a2018', 0.008);
    // 腹下小爪
    cClaw(g, 0.265, 0.865, 0.024, 2.0, GOLD);
    cClaw(g, 0.735, 0.865, 0.024, -2.0, GOLD);
    // 青铜锈斑
    cCir(g, 0.355, 0.33, 0.012, 'rgba(232,179,58,.35)');
    cCir(g, 0.655, 0.72, 0.014, 'rgba(232,179,58,.30)');
  };

  // 巴蛇：巨蛇、金瞳、盘绕、鳞纹、黄腹
  ICONS.bashe = function (g) {
    iconBG(g, '#7a9a4a', '#f0f8d8');
    var OL = 'rgba(16,34,18,.64)';
    var SNAKE = '#3f6a4a', SNAKED = '#2a4a33', SNAKEL = '#6f9a70', BELLY = '#c9b46a', GOLD = '#e8b33a', GOLDD = '#a87a1a';
    // 盘绕的身体（身后）
    cEll(g, 0.5, 0.775, 0.275, 0.115, -0.06, cLin(g, 0.5, 0.68, 0.5, 0.87, [[0, SNAKEL], [0.5, SNAKE], [1, SNAKED]]), OL, 0.016);
    // 盘纹
    cEll(g, 0.5, 0.775, 0.20, 0.075, -0.06, null, 'rgba(111,154,112,.65)', 0.010);
    cEll(g, 0.5, 0.775, 0.115, 0.042, -0.06, null, 'rgba(111,154,112,.55)', 0.009);
    // 腹黄
    cCurveTaper(g, 0.70, 0.80, 0.86, 0.72, 0.88, 0.60, 0.040, 0.022, BELLY, '#9a8540', 0.010);
    // 身体（从头部向右下）
    cCurveTaper(g, 0.55, 0.60, 0.78, 0.70, 0.70, 0.86, 0.085, 0.045, cLin(g, 0.55, 0.60, 0.72, 0.86, [[0, SNAKEL], [0.5, SNAKE], [1, SNAKED]]), OL, 0.014);
    // 身体鳞纹
    cScaleRow(g, 0.665, 0.70, 3, 0.024, 'rgba(201,180,106,.55)', 0.008, 0.5);
    cScaleRow(g, 0.655, 0.76, 3, 0.022, 'rgba(111,154,112,.65)', 0.008, 0.3);
    // 尾尖
    cCurveTaper(g, 0.58, 0.855, 0.45, 0.90, 0.33, 0.865, 0.038, 0.010, SNAKED, '#16281a', 0.010);
    // 蛇头
    cEll(g, 0.395, 0.475, 0.185, 0.145, -0.26, cRad(g, 0.35, 0.42, 0.02, 0.25, [[0, SNAKEL], [0.55, SNAKE], [1, SNAKED]]), OL, 0.020);
    // 头顶鳞纹
    cScaleRow(g, 0.40, 0.43, 3, 0.026, 'rgba(232,179,58,.45)', 0.009, -0.26);
    // 眉骨
    cShp(g, [[0.28, 0.435], [0.375, 0.405], [0.40, 0.44]], SNAKED, '#16281a', 0.010);
    // 眼（金瞳竖瞳）
    cEye(g, 0.35, 0.462, 0.046, '#f4ffe0', GOLD, '#3a2a06');
    cEye(g, 0.468, 0.442, 0.040, '#f4ffe0', GOLD, '#3a2a06');
    cEll(g, 0.35, 0.468, 0.008, 0.022, -0.2, '#1a1404');
    cEll(g, 0.468, 0.448, 0.007, 0.019, -0.2, '#1a1404');
    // 鼻
    cCir(g, 0.305, 0.505, 0.012, SNAKED);
    // 口（张开）+ 獠牙 + 蛇信
    cShp(g, [[0.245, 0.535], [0.36, 0.565], [0.445, 0.545], [0.435, 0.60], [0.345, 0.625], [0.255, 0.585]], '#3a1418', '#1a0a0a', 0.010);
    cShp(g, [[0.31, 0.558], [0.325, 0.60], [0.34, 0.558]], '#f0e6d2', '#b8a888', 0.006);
    cShp(g, [[0.38, 0.55], [0.395, 0.59], [0.41, 0.548]], '#f0e6d2', '#b8a888', 0.005);
    // 蛇信
    g.strokeStyle = '#e8453c'; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.26, 0.585); g.quadraticCurveTo(0.20, 0.60, 0.175, 0.575); g.stroke();
    g.beginPath(); g.moveTo(0.185, 0.588); g.lineTo(0.155, 0.568); g.stroke();
    g.beginPath(); g.moveTo(0.185, 0.588); g.lineTo(0.152, 0.606); g.stroke();
    // 黄腹（颈下）
    cCurveTaper(g, 0.31, 0.60, 0.24, 0.65, 0.20, 0.71, 0.030, 0.014, BELLY, '#9a8540', 0.008);
    // 金点
    cCir(g, 0.60, 0.62, 0.010, GOLD);
    cCir(g, 0.64, 0.68, 0.008, GOLD);
    cSpark(g, 0.80, 0.36, 0.018, '#fff6c8');
  };

  // 混沌：无面黄囊、六足四翼、赤光流转、浑敦无目
  ICONS.hundun = function (g) {
    iconBG(g, '#b8402a', '#ffb080');
    var OL = 'rgba(90,30,10,.62)';
    var SACK = '#e8c86a', SACKL = '#fff0b0', SACKD = '#b89040', RED = '#e8453c', REDD = '#a8201a', FEET = '#8a6a3a';
    // 赤光流转
    cGlow(g, 0.5, 0.60, 0.42, RED, 0.30);
    // 四翼（两对，金羽 + 赤光缘）
    var wings4 = [
      [[0.35, 0.445], [0.19, 0.335], [0.145, 0.395], [0.235, 0.435], [0.155, 0.465], [0.35, 0.505]],
      [[0.65, 0.445], [0.81, 0.335], [0.855, 0.395], [0.765, 0.435], [0.845, 0.465], [0.65, 0.505]],
      [[0.355, 0.60], [0.20, 0.585], [0.15, 0.645], [0.245, 0.655], [0.17, 0.705], [0.35, 0.675]],
      [[0.645, 0.60], [0.80, 0.585], [0.85, 0.645], [0.755, 0.655], [0.83, 0.705], [0.65, 0.675]]
    ];
    for (var w4 = 0; w4 < wings4.length; w4++) {
      cShp(g, wings4[w4], cLin(g, 0.5, 0.40, 0.5, 0.68, [[0, '#ffe9a8'], [0.6, SACK], [1, '#d8a850']]), '#8a5a1a', 0.011);
      g.save();
      g.globalAlpha = 0.7;
      g.strokeStyle = RED; g.lineWidth = 0.008;
      g.beginPath();
      g.moveTo(wings4[w4][1][0], wings4[w4][1][1]);
      g.lineTo(wings4[w4][3][0], wings4[w4][3][1]);
      g.stroke();
      g.restore();
    }
    // 六足
    var feet = [0.335, 0.40, 0.465, 0.535, 0.60, 0.665];
    for (var fi2 = 0; fi2 < feet.length; fi2++) {
      var fx = feet[fi2];
      cRR(g, fx - 0.022, 0.795, 0.044, 0.070, 0.018, FEET, '#5a4420', 0.008);
      cCir(g, fx, 0.862, 0.020, FEET, '#5a4420', 0.007);
      cCir(g, fx - 0.008, 0.866, 0.006, '#c8a860');
    }
    // 黄囊身体（无面）
    cShp(g, [[0.5, 0.295], [0.615, 0.325], [0.705, 0.42], [0.735, 0.56], [0.70, 0.70], [0.62, 0.80], [0.5, 0.835], [0.38, 0.80], [0.30, 0.70], [0.265, 0.56], [0.295, 0.42], [0.385, 0.325]], cRad(g, 0.44, 0.48, 0.02, 0.42, [[0, SACKL], [0.55, SACK], [1, SACKD]]), OL, 0.020);
    // 囊口（束口 + 赤绳）
    cEll(g, 0.5, 0.30, 0.058, 0.032, 0, SACKD, '#8a6a20', 0.010);
    cCurveTaper(g, 0.44, 0.30, 0.40, 0.275, 0.37, 0.30, 0.014, 0.014, RED, REDD, 0.007);
    cCurveTaper(g, 0.56, 0.30, 0.60, 0.275, 0.63, 0.30, 0.014, 0.014, RED, REDD, 0.007);
    // 赤光流转（身体上的旋纹）
    cGlow(g, 0.5, 0.585, 0.17, RED, 0.45);
    cSwirl(g, 0.5, 0.585, 0.125, 1.35, RED, 0.017);
    cSwirl(g, 0.5, 0.585, 0.070, 1.0, '#ff9a6a', 0.013, -1);
    cCir(g, 0.5, 0.585, 0.020, '#ffe6a0');
    // 赤光流点
    cCir(g, 0.385, 0.42, 0.014, RED);
    cCir(g, 0.615, 0.43, 0.012, RED);
    cCir(g, 0.60, 0.735, 0.014, RED);
    cCir(g, 0.395, 0.72, 0.011, RED);
    // 金云纹
    cSwirl(g, 0.36, 0.68, 0.042, 1.0, '#c89a30', 0.010);
    cSwirl(g, 0.64, 0.66, 0.038, 1.0, '#c89a30', 0.010, -1);
    // 光晕点
    cSpark(g, 0.755, 0.325, 0.020, '#ffe6a0');
    cSpark(g, 0.24, 0.335, 0.016, '#ffe6a0');
    cSpark(g, 0.705, 0.72, 0.013, '#ffb080');
  };


  // =========================================================================
  // 3. 行者半身头像（选角界面 / 结算界面用）
  //    服饰按 docs/MYTHOLOGY.md 第 2 节；右下角属性徽章按第 4 节
  // =========================================================================
  const TRAINER_ART = {
    t_bolt: {
      bg1: '#fff6cc', bg2: '#ffd93d', ring: '#e8b33a', symbol: 'bolt', eye: '#4a3a1a',
      skin: '#f2c79f', skinD: '#d8a87e', hair: '#2c2b33', hairD: '#1b1a20',
      top: '#2f4a7a', topD: '#22385c', sleeve: '#3a5a8e', trim: '#e8b33a', inner: '#fff6e0',
    },
    t_leaf: {
      bg1: '#eafbe0', bg2: '#8ed36a', ring: '#4e9c3f', symbol: 'leaf', eye: '#3a5a24',
      skin: '#f3cba8', skinD: '#dbab84', hair: '#6a4a2a', hairD: '#4a3218',
      top: '#3f8a63', topD: '#2c6849', sleeve: '#57a878', trim: '#fff4c8', inner: '#fff4c8',
    },
    t_ember: {
      bg1: '#ffe6cc', bg2: '#ff8a3d', ring: '#d0432e', symbol: 'flame', eye: '#8a3a12',
      skin: '#dfa77d', skinD: '#c48c62', hair: '#c2451a', hairD: '#8a2c10',
      top: '#b8302a', topD: '#8a2018', sleeve: '#b8302a', trim: '#e8b33a', inner: '#ffb43d',
    },
    t_tide: {
      bg1: '#e0f4ff', bg2: '#5ab8f0', ring: '#2f6fae', symbol: 'drop', eye: '#1f5a7a',
      skin: '#f1c4a4', skinD: '#d6a583', hair: '#3f6aae', hairD: '#2a4a80',
      top: '#1f3a5a', topD: '#152a44', sleeve: '#26456a', trim: '#a8e0ff', inner: '#e0f4ff',
    }
  };

  // 属性符号：lei 雷纹 bolt / mu 叶 leaf / huo 火 flame / shui 水 drop（其余属性复用 drop）
  function drawSymbol(g, kind, x, y, r, color) {
    g.save();
    g.translate(x, y);
    g.fillStyle = color || '#ffffff';
    g.strokeStyle = color || '#ffffff';
    if (kind === 'bolt') {
      g.beginPath();
      g.moveTo(r * 0.12, -r); g.lineTo(-r * 0.55, r * 0.10); g.lineTo(-r * 0.05, r * 0.10);
      g.lineTo(-r * 0.18, r); g.lineTo(r * 0.58, -r * 0.14); g.lineTo(r * 0.06, -r * 0.14);
      g.closePath(); g.fill();
    } else if (kind === 'leaf') {
      g.beginPath();
      g.moveTo(-r * 0.62, r * 0.58);
      g.quadraticCurveTo(-r * 0.92, -r * 0.70, r * 0.66, -r * 0.70);
      g.quadraticCurveTo(r * 0.62, r * 0.58, -r * 0.62, r * 0.58);
      g.closePath(); g.fill();
      g.beginPath(); g.moveTo(-r * 0.50, r * 0.52); g.lineTo(r * 0.42, -r * 0.48);
      g.strokeStyle = 'rgba(255,255,255,.62)'; g.lineWidth = r * 0.16; g.stroke();
    } else if (kind === 'flame') {
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.78, -r * 0.24, r * 0.56, r * 0.58, 0, r * 0.88);
      g.bezierCurveTo(-r * 0.56, r * 0.58, -r * 0.78, -r * 0.24, 0, -r);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.72)';
      g.beginPath();
      g.moveTo(0, -r * 0.12);
      g.bezierCurveTo(r * 0.32, r * 0.16, r * 0.22, r * 0.46, 0, r * 0.62);
      g.bezierCurveTo(-r * 0.26, r * 0.42, -r * 0.32, r * 0.10, 0, -r * 0.12);
      g.closePath(); g.fill();
    } else {
      g.beginPath();
      g.moveTo(0, -r);
      g.bezierCurveTo(r * 0.72, -r * 0.10, r * 0.62, r * 0.56, 0, r * 0.96);
      g.bezierCurveTo(-r * 0.62, r * 0.56, -r * 0.72, -r * 0.10, 0, -r);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.68)';
      g.beginPath();
      g.ellipse(0, r * 0.28, r * 0.17, r * 0.25, -0.4, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  // 行者半身像：类型色圆环底 + 半身像 + 右下属性徽章
  function drawTrainerPortrait(g, id) {
    var A = TRAINER_ART[id] || TRAINER_ART.t_bolt;
    var OL = 'rgba(46,30,18,.55)';
    // 背景
    g.fillStyle = cLin(g, 0.1, 0, 0.9, 1, [[0, A.bg1], [1, A.bg2]]);
    g.fillRect(0, 0, 1, 1);
    // 放射光
    g.save();
    g.translate(0.5, 0.48);
    g.globalAlpha = 0.13;
    g.fillStyle = '#ffffff';
    for (var i = 0; i < 12; i++) {
      g.rotate(TAU / 12);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0.5, -0.05); g.lineTo(0.5, 0.05); g.closePath(); g.fill();
    }
    g.restore();
    // 背景云纹
    g.save(); g.globalAlpha = 0.20;
    cCloud(g, 0.155, 0.635, 0.055, '#ffffff', null, 0);
    cCloud(g, 0.845, 0.315, 0.045, '#ffffff', null, 0);
    g.restore();
    // 大圆环
    g.save();
    g.shadowColor = 'rgba(40,30,10,.22)'; g.shadowBlur = 0.06; g.shadowOffsetY = 0.022;
    cCir(g, 0.5, 0.49, 0.395, '#ffffff');
    g.restore();
    cCir(g, 0.5, 0.49, 0.372, cRad(g, 0.5, 0.34, 0.03, 0.42, [[0, '#ffffff'], [0.42, A.bg1], [1, A.ring]]));
    cCir(g, 0.5, 0.49, 0.388, null, '#ffffff', 0.03);
    // 地面光
    g.save(); g.globalAlpha = 0.5;
    cEll(g, 0.5, 0.78, 0.30, 0.075, 0, '#ffffff');
    g.restore();

    // ---- 身后物件 / 披风 / 鹿角 ----
    if (id === 't_bolt') {
      // 背后小雷鼓
      cCir(g, 0.155, 0.675, 0.088, '#8a5a2a', '#5a3a18', 0.014);
      cCir(g, 0.155, 0.675, 0.088, null, '#e8b33a', 0.012);
      cCir(g, 0.155, 0.675, 0.060, '#c8402e', '#8a2018', 0.010);
      cCir(g, 0.155, 0.675, 0.060, null, '#e8b33a', 0.008);
      g.strokeStyle = '#e8b33a'; g.lineWidth = 0.008;
      g.beginPath(); g.moveTo(0.115, 0.63); g.lineTo(0.195, 0.72); g.stroke();
      g.beginPath(); g.moveTo(0.195, 0.63); g.lineTo(0.115, 0.72); g.stroke();
      cCir(g, 0.155, 0.675, 0.020, '#e8b33a', '#a87a1a', 0.006);
    } else if (id === 't_leaf') {
      // 鹿角木冠（身后分叉）
      cCurveTaper(g, 0.425, 0.32, 0.365, 0.22, 0.335, 0.145, 0.024, 0.008, '#8a6438', '#4a3218', 0.010);
      cCurveTaper(g, 0.395, 0.245, 0.345, 0.215, 0.315, 0.185, 0.015, 0.006, '#8a6438', '#4a3218', 0.008);
      cCurveTaper(g, 0.575, 0.32, 0.635, 0.22, 0.665, 0.145, 0.024, 0.008, '#8a6438', '#4a3218', 0.010);
      cCurveTaper(g, 0.605, 0.245, 0.655, 0.215, 0.685, 0.185, 0.015, 0.006, '#8a6438', '#4a3218', 0.008);
    } else if (id === 't_ember') {
      // 火焰纹披风
      cShp(g, [[0.10, 0.885], [0.13, 0.72], [0.23, 0.65], [0.36, 0.67], [0.30, 0.75], [0.26, 0.885]], cLin(g, 0.2, 0.66, 0.15, 0.885, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      cShp(g, [[0.90, 0.885], [0.87, 0.72], [0.77, 0.65], [0.64, 0.67], [0.70, 0.75], [0.74, 0.885]], cLin(g, 0.8, 0.66, 0.85, 0.885, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      cFlame(g, 0.20, 0.862, 0.075, 0.16, '#ff8a3d', '#ffd93d');
      cFlame(g, 0.80, 0.862, 0.075, 0.16, '#ff8a3d', '#ffd93d');
      cFlame(g, 0.145, 0.80, 0.05, 0.10, '#ffb43d', null);
      cFlame(g, 0.855, 0.80, 0.05, 0.10, '#ffb43d', null);
    }

    // ---- 躯干 ----
    g.beginPath();
    g.moveTo(0.20, 0.885);
    g.bezierCurveTo(0.215, 0.725, 0.32, 0.665, 0.5, 0.655);
    g.bezierCurveTo(0.68, 0.665, 0.785, 0.725, 0.80, 0.885);
    g.closePath();
    g.fillStyle = cLin(g, 0.3, 0.65, 0.7, 0.885, [[0, A.top], [1, A.topD]]);
    g.fill();
    g.lineWidth = 0.018; g.strokeStyle = OL; g.stroke();
    // 袖子
    cEll(g, 0.228, 0.82, 0.088, 0.115, 0.24, A.sleeve, OL, 0.016);
    cEll(g, 0.772, 0.82, 0.088, 0.115, -0.24, A.sleeve, OL, 0.016);
    // 交领内衬
    g.beginPath();
    g.moveTo(0.375, 0.665);
    g.quadraticCurveTo(0.44, 0.745, 0.5, 0.795);
    g.quadraticCurveTo(0.56, 0.745, 0.625, 0.665);
    g.quadraticCurveTo(0.5, 0.705, 0.375, 0.665);
    g.closePath();
    g.fillStyle = A.inner; g.fill();
    g.lineWidth = 0.012; g.strokeStyle = OL; g.stroke();
    // 领缘
    g.strokeStyle = A.trim; g.lineWidth = 0.014;
    g.beginPath(); g.moveTo(0.375, 0.667); g.quadraticCurveTo(0.44, 0.747, 0.5, 0.797); g.stroke();
    g.beginPath(); g.moveTo(0.625, 0.667); g.quadraticCurveTo(0.56, 0.747, 0.5, 0.797); g.stroke();

    // ---- 胸饰 / 护具 ----
    if (id === 't_bolt') {
      // 鎏金云肩
      cCloud(g, 0.245, 0.735, 0.068, '#e8b33a', '#a87a1a', 0.010);
      cCloud(g, 0.755, 0.735, 0.068, '#e8b33a', '#a87a1a', 0.010);
      cCir(g, 0.212, 0.753, 0.011, '#fff0b0');
      cCir(g, 0.278, 0.753, 0.011, '#fff0b0');
      cCir(g, 0.722, 0.753, 0.011, '#fff0b0');
      cCir(g, 0.788, 0.753, 0.011, '#fff0b0');
      // 赤绳结
      cCir(g, 0.5, 0.805, 0.022, '#d0432e', '#8a2018', 0.008);
      cEll(g, 0.468, 0.792, 0.026, 0.016, -0.5, null, '#d0432e', 0.010);
      cEll(g, 0.532, 0.792, 0.026, 0.016, 0.5, null, '#d0432e', 0.010);
      cTaper(g, 0.5, 0.822, 0.492, 0.875, 0.007, 0.004, '#d0432e', null, 0);
      cTaper(g, 0.5, 0.822, 0.512, 0.872, 0.007, 0.004, '#d0432e', null, 0);
      // 束袖金箍
      cRR(g, 0.182, 0.782, 0.088, 0.026, 0.012, '#e8b33a', '#a87a1a', 0.008);
      cRR(g, 0.730, 0.782, 0.088, 0.026, 0.012, '#e8b33a', '#a87a1a', 0.008);
    } else if (id === 't_leaf') {
      // 羽形披肩
      var fe = [[0.225, 0.705, -0.62, 0], [0.265, 0.745, -0.30, 1], [0.20, 0.765, -0.85, 2], [0.775, 0.705, 0.62, 0], [0.735, 0.745, 0.30, 1], [0.80, 0.765, 0.85, 2]];
      for (var fi = 0; fi < fe.length; fi++) {
        g.save();
        g.translate(fe[fi][0], fe[fi][1]);
        g.rotate(fe[fi][2]);
        cShp(g, [[0, -0.055], [0.062, 0.010], [0.026, 0.096], [-0.040, 0.086], [-0.058, 0.026]], fi % 2 ? '#dff6e6' : '#7ec89a', '#2c6849', 0.010);
        g.restore();
      }
      // 木纹护腕
      cRR(g, 0.166, 0.845, 0.10, 0.052, 0.020, '#8a6438', '#4a3218', 0.010);
      cRR(g, 0.734, 0.845, 0.10, 0.052, 0.020, '#8a6438', '#4a3218', 0.010);
      g.strokeStyle = 'rgba(74,50,24,.65)'; g.lineWidth = 0.007;
      g.beginPath(); g.moveTo(0.18, 0.856); g.lineTo(0.25, 0.856); g.stroke();
      g.beginPath(); g.moveTo(0.18, 0.872); g.lineTo(0.25, 0.872); g.stroke();
      g.beginPath(); g.moveTo(0.75, 0.856); g.lineTo(0.82, 0.856); g.stroke();
      g.beginPath(); g.moveTo(0.75, 0.872); g.lineTo(0.82, 0.872); g.stroke();
      // 藤蔓腰带
      g.strokeStyle = '#4e9c3f'; g.lineWidth = 0.016;
      g.beginPath(); g.moveTo(0.36, 0.868); g.quadraticCurveTo(0.5, 0.892, 0.64, 0.868); g.stroke();
      g.strokeStyle = '#2c6849'; g.lineWidth = 0.008;
      g.beginPath(); g.moveTo(0.38, 0.878); g.quadraticCurveTo(0.5, 0.900, 0.62, 0.878); g.stroke();
      cEll(g, 0.44, 0.884, 0.020, 0.011, -0.5, '#8ed36a', '#3f7a2c', 0.006);
      cEll(g, 0.56, 0.884, 0.020, 0.011, 0.5, '#8ed36a', '#3f7a2c', 0.006);
    } else if (id === 't_ember') {
      // 赤红甲胄
      cRR(g, 0.405, 0.695, 0.19, 0.185, 0.036, cLin(g, 0.4, 0.69, 0.6, 0.88, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.012);
      cRR(g, 0.405, 0.695, 0.19, 0.185, 0.036, null, '#e8b33a', 0.012);
      // 胸甲火纹
      cFlame(g, 0.5, 0.80, 0.075, 0.095, '#e8b33a', '#ffd93d');
      cCir(g, 0.43, 0.72, 0.010, '#e8b33a');
      cCir(g, 0.57, 0.72, 0.010, '#e8b33a');
      cCir(g, 0.43, 0.862, 0.010, '#e8b33a');
      cCir(g, 0.57, 0.862, 0.010, '#e8b33a');
      // 肩甲
      cEll(g, 0.252, 0.722, 0.098, 0.066, 0.22, cLin(g, 0.2, 0.68, 0.3, 0.78, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      cEll(g, 0.748, 0.722, 0.098, 0.066, -0.22, cLin(g, 0.8, 0.68, 0.7, 0.78, [[0, '#d0432e'], [1, '#8a2018']]), '#5a120c', 0.014);
      g.strokeStyle = '#e8b33a'; g.lineWidth = 0.010;
      g.beginPath(); g.arc(0.252, 0.722, 0.072, PI * 1.1, PI * 1.9); g.stroke();
      g.beginPath(); g.arc(0.748, 0.722, 0.072, PI * 1.1, PI * 1.9); g.stroke();
      // 金环臂钏
      cRR(g, 0.170, 0.800, 0.098, 0.028, 0.013, '#e8b33a', '#a87a1a', 0.008);
      cRR(g, 0.732, 0.800, 0.098, 0.028, 0.013, '#e8b33a', '#a87a1a', 0.008);
    } else {
      // 龟甲护心
      cHex(g, 0.5, 0.775, 0.092, PI / 6, '#2f4a3a', '#e8b33a', 0.014);
      cHex(g, 0.5, 0.775, 0.052, PI / 6, null, '#c9a850', 0.010);
      cCir(g, 0.5, 0.775, 0.016, '#7af0d0', '#2f8a78', 0.008);
      cCir(g, 0.44, 0.735, 0.009, '#e8b33a');
      cCir(g, 0.56, 0.735, 0.009, '#e8b33a');
      cCir(g, 0.44, 0.818, 0.009, '#e8b33a');
      cCir(g, 0.56, 0.818, 0.009, '#e8b33a');
      // 浪纹
      g.strokeStyle = 'rgba(168,224,255,.75)'; g.lineWidth = 0.010;
      for (var wi = 0; wi < 3; wi++) {
        g.beginPath();
        g.arc(0.32 + wi * 0.10, 0.86, 0.030, PI * 1.05, PI * 1.95);
        g.stroke();
        g.beginPath();
        g.arc(0.52 + wi * 0.075, 0.875, 0.026, PI * 1.05, PI * 1.95);
        g.stroke();
      }
      // 玉饰
      cCir(g, 0.5, 0.855, 0.016, '#7af0d0', '#2f8a78', 0.007);
      cTaper(g, 0.5, 0.775, 0.5, 0.84, 0.006, 0.004, '#a8e0ff', null, 0);
    }

    // ---- 头发（后层） ----
    if (id === 't_bolt') {
      cEll(g, 0.5, 0.452, 0.172, 0.178, 0, A.hair);
      cEll(g, 0.5, 0.618, 0.128, 0.058, 0, A.hair);
    } else if (id === 't_leaf') {
      cEll(g, 0.5, 0.452, 0.182, 0.182, 0, A.hair);
      cCurveTaper(g, 0.362, 0.52, 0.295, 0.64, 0.295, 0.82, 0.055, 0.028, A.hair, A.hairD, 0.010);
      cCurveTaper(g, 0.638, 0.52, 0.705, 0.64, 0.705, 0.82, 0.055, 0.028, A.hair, A.hairD, 0.010);
    } else if (id === 't_ember') {
      cShp(g, [[0.33, 0.46], [0.30, 0.30], [0.385, 0.365], [0.365, 0.24], [0.46, 0.335], [0.48, 0.205], [0.545, 0.325], [0.60, 0.225], [0.625, 0.36], [0.71, 0.30], [0.68, 0.46], [0.5, 0.40]], cLin(g, 0.35, 0.24, 0.65, 0.46, [[0, '#e86a3a'], [1, A.hair]]), A.hairD, 0.012);
    } else {
      cEll(g, 0.5, 0.452, 0.175, 0.178, 0, A.hair);
      cCurveTaper(g, 0.372, 0.53, 0.305, 0.66, 0.312, 0.84, 0.052, 0.026, A.hairD, null, 0);
      cCurveTaper(g, 0.628, 0.53, 0.695, 0.66, 0.688, 0.84, 0.052, 0.026, A.hairD, null, 0);
    }

    // ---- 脖子 / 头 ----
    cRR(g, 0.442, 0.60, 0.116, 0.10, 0.03, A.skinD, OL, 0.014);
    cEll(g, 0.5, 0.465, 0.155, 0.175, 0, A.skin, OL, 0.018);
    // 耳
    cEll(g, 0.352, 0.478, 0.026, 0.041, 0, A.skin, OL, 0.012);
    cEll(g, 0.648, 0.478, 0.026, 0.041, 0, A.skin, OL, 0.012);
    // 腮红
    cEll(g, 0.405, 0.535, 0.030, 0.018, 0, 'rgba(232,110,100,.32)');
    cEll(g, 0.595, 0.535, 0.030, 0.018, 0, 'rgba(232,110,100,.32)');
    // 眉
    g.strokeStyle = id === 't_bolt' ? A.hair : A.hairD; g.lineWidth = 0.016;
    if (id === 't_ember') {
      g.beginPath(); g.moveTo(0.402, 0.428); g.quadraticCurveTo(0.428, 0.410, 0.458, 0.422); g.stroke();
      g.beginPath(); g.moveTo(0.598, 0.428); g.quadraticCurveTo(0.572, 0.410, 0.542, 0.422); g.stroke();
    } else {
      g.beginPath(); g.moveTo(0.408, 0.420); g.quadraticCurveTo(0.432, 0.408, 0.456, 0.418); g.stroke();
      g.beginPath(); g.moveTo(0.592, 0.420); g.quadraticCurveTo(0.568, 0.408, 0.544, 0.418); g.stroke();
    }
    // 眼
    cEye(g, 0.437, 0.472, 0.033, '#ffffff', A.eye, '#241c14');
    cEye(g, 0.563, 0.472, 0.033, '#ffffff', A.eye, '#241c14');
    // 鼻
    g.strokeStyle = A.skinD; g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(0.5, 0.49); g.quadraticCurveTo(0.508, 0.51, 0.497, 0.518); g.stroke();
    // 嘴
    g.strokeStyle = 'rgba(120,60,50,.85)'; g.lineWidth = 0.014;
    if (id === 't_ember') {
      g.beginPath(); g.moveTo(0.472, 0.552); g.quadraticCurveTo(0.5, 0.568, 0.528, 0.550); g.stroke();
    } else {
      g.beginPath(); g.moveTo(0.468, 0.552); g.quadraticCurveTo(0.5, 0.575, 0.532, 0.552); g.stroke();
    }

    // ---- 发型 / 头饰（前层） ----
    if (id === 't_bolt') {
      // 短发顶
      cEll(g, 0.5, 0.372, 0.162, 0.072, 0, A.hair);
      // 雷纹头巾
      cRR(g, 0.332, 0.382, 0.336, 0.062, 0.024, A.top, '#1a2c4a', 0.012);
      g.strokeStyle = '#ffd93d'; g.lineWidth = 0.008;
      g.beginPath(); g.moveTo(0.348, 0.394); g.lineTo(0.652, 0.394); g.stroke();
      g.beginPath(); g.moveTo(0.348, 0.432); g.lineTo(0.652, 0.432); g.stroke();
      g.strokeStyle = '#ffd93d'; g.lineWidth = 0.013;
      g.beginPath();
      g.moveTo(0.40, 0.424); g.lineTo(0.445, 0.424); g.lineTo(0.43, 0.404); g.lineTo(0.475, 0.404);
      g.stroke();
      g.beginPath();
      g.moveTo(0.525, 0.424); g.lineTo(0.57, 0.424); g.lineTo(0.555, 0.404); g.lineTo(0.60, 0.404);
      g.stroke();
      // 巾结 + 飘带
      cCir(g, 0.662, 0.412, 0.026, '#ffd93d', '#b58a00', 0.008);
      cShp(g, [[0.672, 0.404], [0.775, 0.372], [0.812, 0.412], [0.70, 0.428]], A.top, '#1a2c4a', 0.010);
      cShp(g, [[0.67, 0.424], [0.762, 0.452], [0.786, 0.50], [0.678, 0.452]], A.topD, '#1a2c4a', 0.009);
      // 鬓发
      cEll(g, 0.345, 0.50, 0.026, 0.048, 0, A.hair);
      cEll(g, 0.655, 0.50, 0.026, 0.048, 0, A.hair);
    } else if (id === 't_leaf') {
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
      g.fillStyle = cLin(g, 0.35, 0.25, 0.65, 0.46, [[0, '#8a6438'], [1, A.hair]]);
      g.fill(); g.lineWidth = 0.014; g.strokeStyle = OL; g.stroke();
      // 木冠 + 叶饰
      cRR(g, 0.355, 0.368, 0.29, 0.050, 0.020, '#7a5a34', '#4a3218', 0.010);
      cEll(g, 0.40, 0.368, 0.030, 0.018, -0.4, '#7ec850', '#3f7a2c', 0.008);
      cEll(g, 0.5, 0.361, 0.032, 0.020, 0, '#7ec850', '#3f7a2c', 0.008);
      cEll(g, 0.60, 0.368, 0.030, 0.018, 0.4, '#7ec850', '#3f7a2c', 0.008);
      cEll(g, 0.632, 0.332, 0.023, 0.042, 0.7, '#8ed36a', '#3f7a2c', 0.008);
      // 耳侧长发
      cCurveTaper(g, 0.362, 0.46, 0.322, 0.56, 0.338, 0.70, 0.036, 0.018, A.hair, A.hairD, 0.008);
      cCurveTaper(g, 0.638, 0.46, 0.678, 0.56, 0.662, 0.70, 0.036, 0.018, A.hair, A.hairD, 0.008);
    } else if (id === 't_ember') {
      // 头顶刺发 + 束冠
      cShp(g, [[0.40, 0.345], [0.435, 0.255], [0.475, 0.33], [0.52, 0.245], [0.555, 0.335], [0.60, 0.29], [0.585, 0.375], [0.5, 0.395], [0.415, 0.375]], cLin(g, 0.4, 0.26, 0.6, 0.4, [[0, '#e86a3a'], [1, A.hair]]), A.hairD, 0.012);
      // 金色发冠
      cRR(g, 0.432, 0.316, 0.136, 0.036, 0.016, '#e8b33a', '#a87a10', 0.010);
      cCir(g, 0.5, 0.292, 0.032, A.hair, A.hairD, 0.008);
      cCir(g, 0.5, 0.292, 0.012, '#ffd93d');
      // 鬓角
      cEll(g, 0.352, 0.505, 0.026, 0.050, 0, A.hair);
      cEll(g, 0.648, 0.505, 0.026, 0.050, 0, A.hair);
    } else {
      // 发髻 + 玉簪
      cCir(g, 0.5, 0.299, 0.048, A.hair, A.hairD, 0.012);
      cCir(g, 0.5, 0.299, 0.030, A.hairD, null, 0);
      cTaper(g, 0.415, 0.297, 0.585, 0.297, 0.008, 0.008, '#a8e0ff', '#5a8aa8', 0.005);
      cCir(g, 0.585, 0.297, 0.018, '#7af0d0', '#2f8a78', 0.008);
      cCir(g, 0.585, 0.297, 0.007, '#ffffff');
      // 刘海
      cShp(g, [[0.34, 0.47], [0.352, 0.365], [0.41, 0.305], [0.5, 0.288], [0.59, 0.305], [0.648, 0.365], [0.66, 0.47], [0.62, 0.415], [0.565, 0.395], [0.53, 0.43], [0.47, 0.43], [0.435, 0.395], [0.38, 0.415]], cLin(g, 0.4, 0.30, 0.6, 0.47, [[0, '#4f7ac8'], [1, A.hair]]), '#1f3a66', 0.012);
      // 耳侧发
      cCurveTaper(g, 0.36, 0.48, 0.33, 0.60, 0.335, 0.72, 0.030, 0.016, A.hair, A.hairD, 0.008);
      cCurveTaper(g, 0.64, 0.48, 0.67, 0.60, 0.665, 0.72, 0.030, 0.016, A.hair, A.hairD, 0.008);
    }

    // ---- 右下属性徽章 ----
    cCir(g, 0.795, 0.795, 0.115, '#ffffff');
    cCir(g, 0.795, 0.795, 0.115, null, 'rgba(255,255,255,.9)', 0.022);
    cCir(g, 0.795, 0.795, 0.096, A.ring);
    cCir(g, 0.795, 0.795, 0.096, null, '#ffffff', 0.012);
    drawSymbol(g, A.symbol, 0.795, 0.795, 0.052, '#ffffff');
    // 左上柔光
    g.save();
    g.globalAlpha = 0.32;
    cCir(g, 0.20, 0.16, 0.10, cRad(g, 0.2, 0.16, 0.01, 0.10, [[0, '#ffffff'], [1, 'rgba(255,255,255,0)']]));
    g.restore();
  }

  // =========================================================================
  // 4. 对外接口：缓存 canvas + 挂载 PG.models.art
  // =========================================================================
  var CACHE = new Map();

  function cacheGet(key) {
    var c = CACHE.get(key);
    return c || null;
  }

  function icon(id, size) {
    try {
      if (!ICONS[id]) return null;
      var s = Math.max(16, Math.round(size || 96));
      var key = 'i|' + id + '|' + s;
      var c = cacheGet(key);
      if (c) return c;
      var m = mkCanvas(s);
      if (!m.g) return null;
      var g = m.g;
      cRR(g, 0, 0, 1, 1, 0.18, '#ffffff', null, 0);
      g.save();
      g.beginPath();
      cRR(g, 0, 0, 1, 1, 0.18, null, null, 0);
      g.clip();
      ICONS[id](g);
      g.restore();
      g.save();
      g.globalAlpha = 0.10;
      g.beginPath();
      g.moveTo(0, 0.42); g.quadraticCurveTo(0.5, 0.28, 1, 0.42);
      g.lineTo(1, 0); g.lineTo(0, 0); g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.restore();
      CACHE.set(key, m.canvas);
      return m.canvas;
    } catch (e) {
      if (window.console && console.warn) console.warn('PG.models.art.icon 绘制失败(' + id + ')：', e);
      return null;
    }
  }

  function portrait(id, size) {
    try {
      var s = Math.max(32, Math.round(size || 256));
      var isTrainer = !!TRAINER_ART[id];
      if (!isTrainer && !ICONS[id]) return null;
      var key = 'p|' + id + '|' + s;
      var c = cacheGet(key);
      if (c) return c;
      var m = mkCanvas(s);
      if (!m.g) return null;
      var g = m.g;
      cRR(g, 0, 0, 1, 1, 0.16, '#ffffff', null, 0);
      g.save();
      g.beginPath();
      cRR(g, 0, 0, 1, 1, 0.16, null, null, 0);
      g.clip();
      if (isTrainer) {
        drawTrainerPortrait(g, id);
      } else {
        // 异兽也可拿 portrait（UI 兜底）：图标放大 + 白环
        ICONS[id](g);
        cCir(g, 0.5, 0.5, 0.475, null, 'rgba(255,255,255,.92)', 0.02);
      }
      g.restore();
      CACHE.set(key, m.canvas);
      return m.canvas;
    } catch (e) {
      if (window.console && console.warn) console.warn('PG.models.art.portrait 绘制失败(' + id + ')：', e);
      return null;
    }
  }

  function has(id) {
    return !!(ICONS[id] || TRAINER_ART[id]);
  }

  var api = { icon: icon, portrait: portrait, has: has };

  // 构建顺序保证 30-models 先加载；若缺席也不报错，仍可用 PG.art 自测
  try {
    if (PG.models && typeof PG.models === 'object') PG.models.art = api;
  } catch (e) { /* 忽略：models 未就绪时仅提供 PG.art */ }
  try { PG.art = api; } catch (e) { /* 忽略 */ }
})();
