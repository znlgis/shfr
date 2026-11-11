/* ============================================================
 * 20-world.js — 宝可梦森林场景（PG.world）
 * ------------------------------------------------------------
 * 白天阳光斜射的森林空地：
 *   · 起伏草丘地形（正弦叠加，groundY 与网格严格一致）
 *   · 环形卡通森林：多球树冠、深浅两档绿 + 顶部黄绿受光
 *   · 成片白 / 粉小花、红白斑点蘑菇圈、圆润岩石
 *   · 清澈水塘：半透明水面 shader + 波纹 + 睡莲 + 岸石 + 木栈桥
 *   · 木制鸟居 + 石灯笼神龛（发光宝珠）、石阶参道
 *   · 丁达尔光柱、萤火虫、蒲公英、薄雾与渐变天空
 * 全部程序化生成（CanvasTexture + 基础几何），不依赖外部资源。
 * 性能：树 / 草 / 花 / 蘑菇 / 石块 / 睡莲全部 InstancedMesh，
 *       风场在顶点着色器里算（GPU 风），update 只更新少量 uniform。
 * ============================================================ */
(() => {
  'use strict';
  const PG = (window.PG = window.PG || {});
  const TAU = Math.PI * 2;

  // THREE 在 build() 时注入，保证本文件不依赖脚本加载顺序
  let T = null;

  // ---------------- 数学小工具（不依赖 PG.util，保证独立可测） ----------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const fract = (v) => v - Math.floor(v);

  /** 确定性伪随机（布局固定，截图与联调可复现） */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 2D 值噪声（地形色斑 / 花丛分布用） */
  function hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  }
  function valueNoise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(
      lerp(hash2(xi, yi), hash2(xi + 1, yi), u),
      lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u),
      v
    );
  }

  // ---------------- 场地布局（全部子模块共享） ----------------
  const LAYOUT = {
    radius: 62, // 玩家活动半径
    pond: { x: -27, z: -19, r: 8.8 }, // 水塘
    shrine: { x: 0, z: -36 }, // 神龛
    ring: { x: 18.5, z: -21 }, // 蘑菇圈
    rocks: { x: 34, z: -31 }, // 岩石群（右）
    rocks2: { x: -40, z: -34 }, // 岩石群（左）
    sunDir: [0.56, 0.6, -0.57], // 阳光方向（指向太阳）
    fogColor: 0xd8eee4,
    skyTop: 0x2f8fe0,
  };

  // ---------------- 全局风场 uniform（树冠 / 草共用） ----------------
  const windUniform = { value: 0 };

  /** 给材质注入顶点风场：按实例世界位置取相位，按顶点高度加权 */
  function withWind(mat, amp, height) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWind = windUniform;
      shader.vertexShader =
        'uniform float uWind;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#ifdef USE_INSTANCING',
            '  vec3 wInst = instanceMatrix[3].xyz;',
            '#else',
            '  vec3 wInst = vec3(0.0);',
            '#endif',
            '  float wPh = wInst.x * 0.63 + wInst.z * 0.87;',
            '  float wSway = sin(uWind * 1.15 + wPh) * 0.6',
            '              + sin(uWind * 2.35 + wPh * 1.7) * 0.26',
            '              + sin(uWind * 0.47 + wPh * 0.6) * 0.34;',
            '  float wT = clamp(position.y / ' + height.toFixed(3) + ', 0.0, 1.4);',
            '  float wAmt = wSway * wT * wT * ' + amp.toFixed(3) + ';',
            '  transformed.x += wAmt;',
            '  transformed.z += wAmt * 0.55;',
          ].join('\n')
        );
    };
    // 让不同参数的风场材质使用各自的着色器程序
    mat.customProgramCacheKey = () => 'pg-wind-' + amp.toFixed(3) + '-' + height.toFixed(3);
    mat.needsUpdate = true;
    return mat;
  }

  // ============================================================
  // 1. Canvas 程序化贴图
  // ============================================================
  function makeTexture(w, h, draw, opts) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c2 = cv.getContext('2d');
    draw(c2, w, h);
    const tex = new T.CanvasTexture(cv);
    if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
    if (opts && opts.repeat) {
      tex.wrapS = tex.wrapT = T.RepeatWrapping;
      tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    }
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /** 天空竖直渐变（球体内壁） */
  function makeSkyTexture() {
    return makeTexture(16, 512, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, '#2f8fe0'); // 天顶深蓝
      g.addColorStop(0.22, '#4fa7ee');
      g.addColorStop(0.4, '#8fd0f6');
      g.addColorStop(0.47, '#cdeeff');
      g.addColorStop(0.5, '#eef9ea'); // 地平线：暖白偏绿
      g.addColorStop(0.56, '#dcefd6');
      g.addColorStop(1.0, '#b9d9b4'); // 下半球（一般被地形遮住）
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  /** 草地细节贴图（与顶点色相乘，只做细微纹理） */
  function makeGrassTexture() {
    return makeTexture(
      256,
      256,
      (c, w, h) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, w, h);
        const rnd = mulberry32(20241111);
        // 大块明暗
        for (let i = 0; i < 64; i++) {
          c.globalAlpha = 0.05 + rnd() * 0.06;
          c.fillStyle = rnd() < 0.5 ? '#cfe6b8' : '#f2ffe0';
          const r = 10 + rnd() * 46;
          c.beginPath();
          c.ellipse(rnd() * w, rnd() * h, r, r * (0.45 + rnd() * 0.5), rnd() * 3, 0, TAU);
          c.fill();
        }
        // 细草叶
        for (let i = 0; i < 1000; i++) {
          c.globalAlpha = 0.08 + rnd() * 0.12;
          c.strokeStyle = rnd() < 0.5 ? '#b9d894' : '#eaffd0';
          c.lineWidth = 0.8 + rnd() * 1.3;
          const x = rnd() * w, y = rnd() * h;
          const len = 3 + rnd() * 8;
          const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.0;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
          c.stroke();
        }
        c.globalAlpha = 1;
      },
      { repeat: [34, 34] }
    );
  }

  /** 柔和光斑（萤火虫 / 光晕 / 阳光通用） */
  function makeGlowTexture(stops) {
    return makeTexture(64, 64, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      for (const s of stops) g.addColorStop(s[0], s[1]);
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  /** 蒲公英种子（白色绒球 + 细茎） */
  function makeSeedTexture() {
    return makeTexture(64, 64, (c, w, h) => {
      const cx = w / 2, cy = h * 0.42;
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = 1.1;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        const len = 17 + (i % 3) * 3;
        c.beginPath();
        c.moveTo(cx, cy);
        c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        c.stroke();
        // 绒毛小点
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.beginPath();
        c.arc(cx + Math.cos(a) * len, cy + Math.sin(a) * len, 1.4, 0, TAU);
        c.fill();
      }
      // 中心亮核
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, 12);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,255,230,0.55)');
      g.addColorStop(1, 'rgba(255,255,230,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, 12, 0, TAU);
      c.fill();
      // 细茎
      c.strokeStyle = 'rgba(230,255,220,0.5)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(cx, cy + 8);
      c.quadraticCurveTo(cx + 3, cy + 20, cx + 1, h - 6);
      c.stroke();
    });
  }

  /** 阳光圆盘 */
  function makeSunTexture() {
    return makeTexture(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0.0, 'rgba(255,255,246,1)');
      g.addColorStop(0.18, 'rgba(255,250,214,1)');
      g.addColorStop(0.4, 'rgba(255,236,168,0.5)');
      g.addColorStop(0.72, 'rgba(255,224,150,0.14)');
      g.addColorStop(1.0, 'rgba(255,220,140,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
  }

  /** 鸟居中央牌匾「森」 */
  function makePlaqueTexture() {
    return makeTexture(128, 160, (c, w, h) => {
      c.fillStyle = '#f6ecd2';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#c8432a';
      c.lineWidth = 10;
      c.strokeRect(5, 5, w - 10, h - 10);
      c.fillStyle = '#24313f';
      c.font = '900 96px "PingFang SC","Microsoft YaHei","YouYuan",sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('森', w / 2, h / 2 + 6);
    });
  }

  // ============================================================
  // 2. 几何工具：合并 / 顶点着色 / 基础体
  // ============================================================

  /**
   * 合并 BufferGeometry（position/normal/uv[/color][/extra]），返回单个几何体。
   * three 的 addons 不可用，所以这里自己实现（只处理非交错、带 index 的常规几何）。
   */
  function mergeGeoms(list, extraNames) {
    list = list.filter((g) => g && g.attributes && g.attributes.position);
    if (!list.length) return new T.BufferGeometry();
    const useColor = list.every((g) => g.attributes.color);
    const names = ['position', 'normal', 'uv'].concat(extraNames || [], useColor ? ['color'] : []);
    const itemSizes = {};
    for (const n of names) itemSizes[n] = list[0].attributes[n] ? list[0].attributes[n].itemSize : 3;

    let vCount = 0, iCount = 0;
    for (const g of list) {
      const n = g.attributes.position.count;
      vCount += n;
      iCount += g.index ? g.index.count : n;
    }
    const arrays = {};
    for (const n of names) arrays[n] = new Float32Array(vCount * itemSizes[n]);
    const IdxArr = vCount > 65535 ? Uint32Array : Uint16Array;
    const idx = new IdxArr(iCount);

    let vo = 0, io = 0;
    for (const g of list) {
      const count = g.attributes.position.count;
      for (const n of names) {
        const attr = g.attributes[n];
        if (!attr) continue;
        const is = itemSizes[n];
        const src = attr.array;
        const dst = arrays[n];
        for (let v = 0; v < count; v++) {
          for (let k = 0; k < is; k++) dst[(vo + v) * is + k] = src[v * is + k];
        }
      }
      if (g.index) {
        const gi = g.index;
        for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
        io += gi.count;
      } else {
        for (let i = 0; i < count; i++) idx[io + i] = vo + i;
        io += count;
      }
      vo += count;
    }

    const out = new T.BufferGeometry();
    for (const n of names) {
      if (n === 'color' && !useColor) continue;
      out.setAttribute(n, new T.BufferAttribute(arrays[n], itemSizes[n]));
    }
    out.setIndex(new T.BufferAttribute(idx, 1));
    return out;
  }

  /** 按顶点写入颜色（fn 收到临时 Color 与局部坐标） */
  function paintVerts(geo, fn) {
    const p = geo.attributes.position;
    const arr = new Float32Array(p.count * 3);
    const c = new T.Color();
    for (let i = 0; i < p.count; i++) {
      c.setRGB(1, 1, 1);
      fn(c, p.getX(i), p.getY(i), p.getZ(i), i);
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(arr, 3));
    return geo;
  }

  /** 生成几何并可选地旋转/平移（参数顺序：几何 → 旋转 → 平移） */
  function part(geo, x, y, z, rx, ry, rz) {
    if (rx) geo.rotateX(rx);
    if (ry) geo.rotateY(ry);
    if (rz) geo.rotateZ(rz);
    geo.translate(x || 0, y || 0, z || 0);
    return geo;
  }

  function boxGeo(w, h, d) {
    return new T.BoxGeometry(w, h, d);
  }
  function cylGeo(rt, rb, h, seg, open) {
    return new T.CylinderGeometry(rt, rb, h, seg || 8, 1, !!open);
  }
  function sphereGeo(r, ws, hs) {
    return new T.SphereGeometry(r, ws || 10, hs || 7);
  }

  // ============================================================
  // 3. 地形高度场（groundY 与网格顶点共用同一个函数）
  // ============================================================
  function makeHeightField() {
    const P = LAYOUT.pond;

    function baseHeight(x, z) {
      const d = Math.hypot(x, z);
      let h =
        0.3 * Math.sin(x * 0.083 + 0.6) * Math.cos(z * 0.071 - 0.4) +
        0.17 * Math.sin((x + z) * 0.132 + 1.9) +
        0.09 * Math.cos(x * 0.22 - z * 0.19 + 0.8);
      // 中央战斗空地更平整，外圈渐渐起伏
      h *= 0.42 + 0.58 * smoothstep(14, 38, d);
      // 外圈抬高成盆地边缘，遮住地平线
      h += smoothstep(44, 82, d) * 4.6;
      return h;
    }

    const pondBase = baseHeight(P.x, P.z);
    const pondWaterY = pondBase - 0.24;

    function groundY(x, z) {
      let h = baseHeight(x, z);
      const pd = Math.hypot(x - P.x, z - P.z);
      const flat = smoothstep(P.r * 1.22, P.r * 0.7, pd);
      if (flat > 0.001) {
        const bowl = smoothstep(P.r * 1.02, P.r * 0.72, pd);
        h = lerp(h, pondBase - 0.9 * bowl, flat);
      }
      return h;
    }

    return { groundY, baseHeight, pondBase, pondWaterY };
  }

  // ============================================================
  // 4. 天空 / 云 / 太阳
  // ============================================================
  function buildSky(ctx) {
    const g = ctx.group;
    const skyR = ctx.opts.skyRadius || 260;

    // 渐变天穹（球体内壁）
    const sky = new T.Mesh(
      new T.SphereGeometry(skyR, 32, 20),
      new T.MeshBasicMaterial({
        map: ctx.tex.sky,
        side: T.BackSide,
        fog: false,
        depthWrite: false,
      })
    );
    sky.name = 'skyDome';
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    g.add(sky);

    // 太阳：两层叠加 sprite（亮核 + 大光晕）
    const sunPos = ctx.sunDir.clone().multiplyScalar(skyR * 0.92);
    const mkSprite = (scale, opacity, tex) => {
      const sp = new T.Sprite(
        new T.SpriteMaterial({
          map: tex,
          color: 0xffffff,
          transparent: true,
          opacity,
          blending: T.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      );
      sp.position.copy(sunPos);
      sp.scale.set(scale, scale, 1);
      sp.renderOrder = -90;
      return sp;
    };
    const sunHalo = mkSprite(skyR * 0.2, 0.1, ctx.tex.sun);
    sunHalo.material.color.setHex(0xffe9b0);
    const sunCore = mkSprite(skyR * 0.032, 0.42, ctx.tex.sun);
    sunCore.material.color.setHex(0xfff4cc);
    g.add(sunHalo);
    g.add(sunCore);

    // 卡通云：若干压扁球合并成一个几何体（1 个 draw call）
    const cloudParts = [];
    const cloudRnd = mulberry32(777);
    const cloudClusters = 7;
    for (let i = 0; i < cloudClusters; i++) {
      const a = (i / cloudClusters) * TAU + cloudRnd() * 0.7;
      const dist = 120 + cloudRnd() * 70;
      const cx = Math.cos(a) * dist;
      const cz = Math.sin(a) * dist;
      const cy = 52 + cloudRnd() * 46;
      const blobs = 4 + ((cloudRnd() * 3) | 0);
      const baseS = 9 + cloudRnd() * 9;
      for (let b = 0; b < blobs; b++) {
        const r = baseS * (0.55 + cloudRnd() * 0.6);
        const gg = new T.SphereGeometry(r, 10, 7);
        gg.scale(1.25, 0.62, 1);
        gg.translate(
          cx + (cloudRnd() - 0.5) * baseS * 2.6,
          cy + (cloudRnd() - 0.5) * baseS * 0.5,
          cz + (cloudRnd() - 0.5) * baseS * 1.4
        );
        cloudParts.push(gg);
      }
    }
    const cloudGeo = mergeGeoms(cloudParts);
    paintVerts(cloudGeo, (c, x, y) => {
      // 云底偏淡蓝，云顶纯白
      const t = smoothstep(40, 96, y);
      c.setHex(0xffffff).lerp(new T.Color(0xd4e9fb), 1 - t);
    });
    const clouds = new T.Mesh(
      cloudGeo,
      new T.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.94 })
    );
    clouds.name = 'clouds';
    clouds.frustumCulled = false;
    g.add(clouds);
    ctx.dyn.clouds = clouds;

    ctx.dyn.updaters.push((dt) => {
      clouds.rotation.y += dt * 0.0022; // 云朵极缓慢漂移
    });
  }

  // ============================================================
  // 5. 备用光照（Lead 若已布光可传 opts.skipLights 或已有 DirectionalLight）
  // ============================================================
  function buildLights(ctx) {
    const scene = ctx.scene;
    const o = ctx.opts;
    if (o.skipLights) return;

    // 场景里已经有方向光（Lead 布置过）就不重复加
    let hasDir = false;
    scene.traverse((n) => {
      if (n.isDirectionalLight) hasDir = true;
    });
    if (hasDir) return;

    const sun = new T.DirectionalLight(0xfff2cc, 2.35);
    sun.name = 'pgSun';
    sun.position.copy(ctx.sunDir).multiplyScalar(80);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -74;
    sc.right = 74;
    sc.top = 74;
    sc.bottom = -74;
    sc.near = 1;
    sc.far = 230;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.045;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);
    ctx.sunLight = sun;
  }

  // ============================================================
  // 6. 地形
  // ============================================================
  function buildTerrain(ctx) {
    const SIZE = 240;
    const SEG = 192;
    const geo = new T.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);

    const pa = geo.attributes.position;
    const colors = new Float32Array(pa.count * 3);
    const c = new T.Color();
    const tmp = new T.Color();
    const cDark = new T.Color(0x5aa63f);
    const cMid = new T.Color(0x74c452);
    const cLight = new T.Color(0x9adc63);
    const cSun = new T.Color(0xc8ef8b);
    const cSand = new T.Color(0xe8d9a0);
    const cWet = new T.Color(0xcbd49c);
    const cOuter = new T.Color(0x4f8a3c);
    const P = LAYOUT.pond;
    const waterY = ctx.ground.pondWaterY;

    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i);
      const z = pa.getZ(i);
      const y = ctx.ground.groundY(x, z);
      pa.setY(i, y);

      const d = Math.hypot(x, z);
      const n1 = valueNoise2(x * 0.13, z * 0.13);
      const n2 = valueNoise2(x * 0.45 + 7.3, z * 0.45 - 3.1);
      c.copy(cDark).lerp(cMid, smoothstep(0.22, 0.78, n1));
      c.lerp(cLight, smoothstep(0.42, 0.95, n2) * 0.5);
      // 大块阳光斑
      const sunPatch = smoothstep(0.56, 0.96, valueNoise2(x * 0.045 + 11.3, z * 0.045 - 4.7));
      c.lerp(cSun, sunPatch * 0.34);
      // 外圈林地略暗（雾会再压一层）
      c.lerp(cOuter, smoothstep(48, 78, d) * 0.5);
      // 池塘沙岸 + 水下浅沙
      const pd = Math.hypot(x - P.x, z - P.z);
      const bank = smoothstep(P.r * 1.32, P.r * 0.96, pd);
      if (bank > 0.01) {
        c.lerp(cSand, bank * 0.9);
        const under = smoothstep(waterY + 0.12, waterY - 0.1, y);
        c.lerp(cWet, under * 0.7);
      }
      // 细微明暗噪点
      const shade = 0.93 + hash2(x * 3.1, z * 3.7) * 0.13;
      tmp.copy(c).multiplyScalar(shade);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new T.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new T.MeshStandardMaterial({
      map: ctx.tex.grass,
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
    });
    const ground = new T.Mesh(geo, mat);
    ground.name = 'terrain';
    ground.receiveShadow = true;
    ctx.group.add(ground);
    ctx.groundMesh = ground;
  }

    // ============================================================
  // 7. 树木：粗壮树干（2 变体）+ 多球树冠（3 变体）· InstancedMesh
  // ============================================================
  function makeTrunkGeo(variant, lod) {
    const short = variant === 1;
    const H = short ? 6.9 : 7.8;
    const profile = [
      [0.02, 0.0],
      [1.02 * (short ? 1.12 : 1.0), 0.0],
      [1.32 * (short ? 1.12 : 1.0), 0.3],
      [1.04, 0.8],
      [0.76, 1.7],
      [0.66, 2.9],
      [0.6, 4.2],
      [0.54, 5.5],
      [0.47, 6.6],
      [0.3, H - 0.4],
      [0.03, H],
    ];
    const parts = [new T.LatheGeometry(profile.map((p) => new T.Vector2(p[0], p[1])), lod ? 7 : 9)];

    // 根部板根（粗壮卡通树的关键剪影）
    const rootCount = 4;
    for (let i = 0; i < rootCount; i++) {
      const a = (i / rootCount) * TAU + (short ? 0.4 : 0.15);
      const g = cylGeo(0.09, 0.52, lod ? 2.1 : 2.5, lod ? 5 : 6, true);
      g.rotateZ(-0.92);
      g.rotateY(-a);
      g.translate(Math.cos(a) * 0.92, 0.5, Math.sin(a) * 0.92);
      parts.push(g);
    }
    // 两根伸进树冠的树枝
    for (let i = 0; i < 2; i++) {
      const a = 0.9 + i * 2.6;
      const g = cylGeo(0.09, 0.23, 2.7, 6, false);
      g.rotateZ(-0.95);
      g.rotateY(-a);
      g.translate(Math.cos(a) * 0.75, 5.5 + i * 0.6, Math.sin(a) * 0.75);
      parts.push(g);
    }

    const geo = mergeGeoms(parts);
    geo.computeVertexNormals();
    const cBase = new T.Color(0x5a3d27);
    const cMid = new T.Color(0x8b5f3c);
    const cTop = new T.Color(0x764f33);
    const cMoss = new T.Color(0x62803c);
    paintVerts(geo, (c, x, y, z) => {
      const t = clamp(y / H, 0, 1);
      c.copy(cBase).lerp(cMid, smoothstep(0.0, 0.3, t));
      c.lerp(cTop, smoothstep(0.4, 1.0, t) * 0.7);
      // 根部长一点青苔
      c.lerp(cMoss, smoothstep(0.9, 0.05, y) * 0.45);
    });
    return geo;
  }

  const CANOPY_VARIANTS = [
    // 0：圆润蓬松
    [
      [0, 7.3, 0, 2.95],
      [-2.45, 6.7, 0.5, 2.25],
      [2.5, 6.85, -0.35, 2.3],
      [0.35, 6.55, 2.4, 2.15],
      [-0.5, 6.9, -2.35, 2.2],
      [1.0, 9.0, 0.25, 2.05],
      [-1.15, 8.4, -0.7, 1.75],
    ],
    // 1：高挑
    [
      [0, 7.6, 0, 2.75],
      [-2.1, 7.0, 0.4, 1.95],
      [2.15, 7.2, -0.3, 2.0],
      [0.2, 6.7, 2.1, 1.85],
      [-0.3, 7.3, -2.05, 1.9],
      [0.5, 9.9, 0.1, 1.9],
      [-0.7, 9.0, -0.5, 1.55],
    ],
    // 2：宽伞状
    [
      [0, 7.0, 0, 2.85],
      [-3.0, 6.5, 0.2, 2.05],
      [3.05, 6.6, -0.2, 2.1],
      [0.3, 6.3, 2.7, 1.9],
      [-0.2, 6.4, -2.65, 1.85],
      [1.6, 8.6, 1.3, 1.7],
      [-1.7, 8.5, -1.1, 1.65],
    ],
  ];

  function makeCanopyGeo(variant, lod) {
    const blobs = CANOPY_VARIANTS[variant] || CANOPY_VARIANTS[0];
    const ws = lod ? 8 : 11, hs = lod ? 6 : 8;
    const parts = blobs.map((b) => {
      const g = new T.SphereGeometry(b[3], ws, hs);
      g.translate(b[0], b[1], b[2]);
      return g;
    });
    const geo = mergeGeoms(parts);
    geo.computeVertexNormals();
    // 深浅两档绿 + 顶部亮黄绿受光（烘焙进顶点色）
    const cDark = new T.Color(0x2e7a33);
    const cMid = new T.Color(0x4e9c3f);
    const cLight = new T.Color(0x8bd154);
    const cTop = new T.Color(0xc9ee7d);
    paintVerts(geo, (c, x, y) => {
      const t = clamp((y - 4.0) / 7.2, 0, 1);
      c.copy(cDark).lerp(cMid, smoothstep(0.0, 0.45, t));
      c.lerp(cLight, smoothstep(0.38, 0.8, t));
      c.lerp(cTop, smoothstep(0.76, 1.0, t));
    });
    return geo;
  }

  function buildTrees(ctx) {
    const rnd = ctx.rnd;
    const P = LAYOUT.pond, S = LAYOUT.shrine, R = LAYOUT.ring, RK = LAYOUT.rocks, RK2 = LAYOUT.rocks2;
    const trees = [];

    const shrineAng = Math.atan2(S.z, S.x);
    const angGap = (a, b) => {
      let d = a - b;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      return Math.abs(d);
    };
    const farFromTrees = (x, z, gap) => {
      for (const t of trees) if (Math.hypot(x - t.x, z - t.z) < gap) return false;
      return true;
    };
    const clearOfSpawns = (x, z, gap) => {
      for (const sp of ctx.spawnPoints) if (Math.hypot(x - sp.x, z - sp.z) < gap) return false;
      return true;
    };
    const clearOfLandmarks = (x, z) => {
      if (Math.hypot(x - P.x, z - P.z) < P.r + 4.6) return false;
      if (Math.hypot(x - S.x, z - S.z) < 10.5) return false;
      if (Math.hypot(x - R.x, z - R.z) < 8.5) return false;
      if (Math.hypot(x - RK.x, z - RK.z) < 9.5) return false;
      if (Math.hypot(x - RK2.x, z - RK2.z) < 9.5) return false;
      return true;
    };

    function addTree(x, z, s, outer, force) {
      if (!force) {
        if (!clearOfSpawns(x, z, 6.4)) return false;
        if (!farFromTrees(x, z, (s + 1) * 3.0)) return false;
        if (!outer && !clearOfLandmarks(x, z)) return false;
      }
      trees.push({
        x,
        z,
        s,
        v: (rnd() * 3) | 0,
        tv: (rnd() * 2) | 0,
        rot: rnd() * TAU,
        outer: !!outer,
        tint: 0.9 + rnd() * 0.18,
        warm: rnd() * 0.1,
      });
      return true;
    }

    // 手工摆位：构图锚点（相机默认 (0,1.7,20) 朝 -Z 时形成天然画框）
    const anchors = [
      [0, -50, 1.8], // 神龛背后的巨树
      [-24, 11, 1.16],
      [24, 8, 1.12],
      [-33, -9, 1.06],
      [34, -13, 1.04],
      [-20, 30, 1.0],
      [21, 29, 0.96],
      [-20, -31, 1.0],
      [22, -32, 1.02],
      [-44, 26, 1.26],
      [46, 20, 1.22],
      [-15, 43, 1.1],
      [17, 45, 1.06],
    ];
    for (const a of anchors) addTree(a[0], a[1], a[2], a[0] * a[0] + a[1] * a[1] > 62 * 62, true);

    // 中层森林环：30~57 半径随机填充
    for (let i = 0; i < 1200 && trees.length < 78; i++) {
      const a = rnd() * TAU;
      const rr = 29 + rnd() * 27.5;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      // 神龛视线走廊留空
      if (rr < 48 && angGap(a, shrineAng) < 0.2) continue;
      addTree(x, z, 0.82 + rnd() * 0.44, false, false);
    }

    // 外围森林墙 A（62~74）：把场地围起来
    for (let i = 0; i < 68; i++) {
      const a = (i / 68) * TAU + (rnd() - 0.5) * 0.055;
      const rr = 63 + rnd() * 10;
      addTree(Math.cos(a) * rr, Math.sin(a) * rr, 1.05 + rnd() * 0.5, true, true);
    }
    // 外围森林墙 B（78~96）：远景剪影
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * TAU + (rnd() - 0.5) * 0.08;
      const rr = 78 + rnd() * 17;
      addTree(Math.cos(a) * rr, Math.sin(a) * rr, 1.45 + rnd() * 0.7, true, true);
    }

    // ---- 生成 InstancedMesh（近景高模 / 远景低模 LOD）----
    const trunkGeos = [makeTrunkGeo(0, false), makeTrunkGeo(1, false)];
    const trunkGeosFar = [makeTrunkGeo(0, true), makeTrunkGeo(1, true)];
    const canopyGeos = [makeCanopyGeo(0, false), makeCanopyGeo(1, false), makeCanopyGeo(2, false)];
    const canopyGeosFar = [makeCanopyGeo(0, true), makeCanopyGeo(1, true), makeCanopyGeo(2, true)];
    const dummy = new T.Object3D();
    const col = new T.Color();

    const groups = []; // { outer, v, list }
    for (const outer of [false, true]) {
      for (let v = 0; v < 3; v++) {
        const list = trees.filter((t) => t.outer === outer && t.v === v);
        if (list.length) groups.push({ outer, v, list });
      }
    }

    // 树干按变体分组合并
    for (const outer of [false, true]) {
      for (let tv = 0; tv < 2; tv++) {
        const list = trees.filter((t) => t.outer === outer && t.tv === tv);
        if (!list.length) continue;
        const mesh = new T.InstancedMesh(outer ? trunkGeosFar[tv] : trunkGeos[tv], ctx.mats.trunk, list.length);
        mesh.name = 'trees-trunk-' + (outer ? 'far' : 'near') + tv;
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          const gy = ctx.ground.groundY(t.x, t.z);
          dummy.position.set(t.x, gy - 0.28, t.z);
          dummy.rotation.set(0, t.rot, 0);
          dummy.scale.setScalar(t.s);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          const k = 0.9 + (t.tint - 0.9) * 2;
          col.setRGB(k, k, k * 0.97);
          mesh.setColorAt(i, col);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = !outer;
        mesh.receiveShadow = false;
        mesh.frustumCulled = true;
        ctx.group.add(mesh);
      }
    }

    for (const grp of groups) {
      const mesh = new T.InstancedMesh(grp.outer ? canopyGeosFar[grp.v] : canopyGeos[grp.v], ctx.mats.canopy, grp.list.length);
      mesh.name = 'trees-canopy-' + (grp.outer ? 'far' : 'near') + grp.v;
      for (let i = 0; i < grp.list.length; i++) {
        const t = grp.list[i];
        const gy = ctx.ground.groundY(t.x, t.z);
        dummy.position.set(t.x, gy - 0.28, t.z);
        dummy.rotation.set(0, t.rot, 0);
        dummy.scale.setScalar(t.s);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // 每棵树轻微色差：偏黄 / 偏青，做出层次
        const k = t.tint;
        col.setRGB(k * (1 + t.warm * 0.35), k, k * (0.95 - t.warm * 0.15));
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = !grp.outer;
      mesh.receiveShadow = false;
      ctx.group.add(mesh);
    }

    // 树干圆柱碰撞体（只统计玩家能到达的范围）
    for (const t of trees) {
      if (t.outer) continue;
      ctx.colliders.push({ x: t.x, z: t.z, r: 1.08 * t.s });
    }
    ctx.trees = trees;
  }

  // ============================================================
  // 8. 草簇（InstancedMesh + GPU 风场）
  //    形态：一小丛向外披散、带弯度的宽叶；顶点色由根深绿→尖亮黄绿，
  //    材质用不透明双面标准材质 + 轻微自发光，避免草叶背面发黑。
  // ============================================================
  function makeGrassGeo() {
    const rnd = mulberry32(9911);
    const pos = [], nor = [], uv = [], col = [], idx = [];
    const cBase = new T.Color(0x3d7a22);
    const cMid = new T.Color(0x5fa232);
    const cTip = new T.Color(0x9ad254);
    const bladeCount = 8;
    let vOff = 0;
    const tmpC = new T.Color();
    for (let b = 0; b < bladeCount; b++) {
      const ang = (b / bladeCount) * TAU + rnd() * 0.9;
      const h = 0.15 + rnd() * 0.17;
      const bend = 0.05 + rnd() * 0.09; // 向外披散
      const w = 0.024 + rnd() * 0.012;
      const dx = Math.cos(ang), dz = Math.sin(ang);
      const ox = dx * 0.035, oz = dz * 0.035; // 从丛心略微偏出
      const rows = [
        [0.0, w, 0.0],
        [h * 0.52, w * 0.82, bend * 0.42],
        [h, w * 0.16, bend],
      ];
      const start = vOff;
      const tx = -dz, tz = dx;
      for (let r = 0; r < rows.length; r++) {
        const y = rows[r][0], half = rows[r][1], off = rows[r][2];
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          pos.push(ox + dx * off + tx * half * sgn, y, oz + dz * off + tz * half * sgn);
          nor.push(0, 1, 0);
          uv.push((sgn + 1) * 0.5, r / 2);
          tmpC.copy(cBase).lerp(cMid, r / 2);
          if (r === 2) tmpC.lerp(cTip, 0.75);
          col.push(tmpC.r, tmpC.g, tmpC.b);
        }
      }
      const rowBase = (r) => start + r * 2;
      idx.push(rowBase(0), rowBase(1), rowBase(3));
      idx.push(rowBase(0), rowBase(3), rowBase(2));
      idx.push(rowBase(2), rowBase(3), rowBase(5));
      idx.push(rowBase(2), rowBase(5), rowBase(4));
      vOff = start + rows.length * 2;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new T.BufferAttribute(new Float32Array(nor), 3));
    geo.setAttribute('uv', new T.BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('color', new T.BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  function buildGrass(ctx) {
    const rnd = ctx.rnd;
    const COUNT = 5200;
    const geo = makeGrassGeo();
    const mesh = new T.InstancedMesh(geo, ctx.mats.grass, COUNT);
    mesh.name = 'grass';
    const dummy = new T.Object3D();
    const col = new T.Color();
    const P = LAYOUT.pond;
    const list = [];
    let guard = 0;
    while (list.length < COUNT && guard++ < COUNT * 10) {
      // 面积均匀 + 近处更密
      const near = rnd() < 0.6;
      const rr = near
        ? Math.sqrt(6 + rnd() * (34 * 34 - 6))
        : Math.sqrt(34 * 34 + rnd() * (61 * 61 - 34 * 34));
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const pd = Math.hypot(x - P.x, z - P.z);
      if (pd < P.r * 1.1) continue; // 水里不长草
      if (rr > 42 && rnd() < 0.45) continue;
      // 用噪声把草聚成一片片，避免均匀铺满
      if (valueNoise2(x * 0.11 + 3.7, z * 0.11 - 1.3) < 0.34) continue;
      list.push({ x, z, s: 0.5 + rnd() * 0.55, rot: rnd() * TAU, tint: rnd() });
    }
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      dummy.position.set(g.x, ctx.ground.groundY(g.x, g.z) - 0.01, g.z);
      dummy.rotation.set(0, g.rot, 0);
      dummy.scale.set(g.s * (0.95 + g.tint * 0.35), g.s * (0.8 + g.tint * 0.5), g.s * (0.95 + g.tint * 0.35));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const k = 0.76 + g.tint * 0.22;
      col.setRGB(k * (0.88 + g.tint * 0.14), k, k * 0.66);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    ctx.group.add(mesh);
    ctx.stats.grass = list.length;
  }

  // ============================================================
  // 9. 小花（白 / 粉，成片散布）
  //    花冠做成微微上翘的“杯状”立体花瓣，从低机位也能看清；
  //    花瓣 / 花心 / 花茎 = 3 个 InstancedMesh（3 个 draw call）。
  // ============================================================
  function makeFlowerGeos() {
    const petals = [];
    const petalCount = 5;
    const cupTilt = 0.95; // 花瓣向上翘的角度（弧度）
    for (let i = 0; i < petalCount; i++) {
      const phi = (i / petalCount) * TAU;
      const g = new T.CircleGeometry(0.13, 8);
      g.scale(1, 1.55, 1); // 拉长成椭圆花瓣
      g.translate(0, 0.15, 0); // 从花心向外
      g.rotateX(cupTilt); // 翘起
      g.rotateY(phi); // 绕中心散开
      petals.push(g);
    }
    const petalGeo = mergeGeoms(petals);
    petalGeo.computeVertexNormals();
    const centerGeo = new T.SphereGeometry(0.056, 9, 7);
    centerGeo.scale(1, 0.7, 1);
    centerGeo.translate(0, 0.085, 0);
    const stemGeo = new T.CylinderGeometry(0.012, 0.019, 0.2, 5, 1, false);
    stemGeo.translate(0, -0.1, 0);
    return { petalGeo, centerGeo, stemGeo };
  }

  function buildFlowers(ctx) {
    const rnd = ctx.rnd;
    const P = LAYOUT.pond, S = LAYOUT.shrine, R = LAYOUT.ring;
    const clusters = [];
    // 先在空地正面放几片花丛（保证默认机位能看到成片小花）
    const featured = [
      { x: -5.5, z: 11.5, r: 2.6 },
      { x: 6.5, z: 10.5, r: 2.4 },
      { x: -12.5, z: 5.5, r: 2.8 },
      { x: 11.5, z: 3.5, r: 2.5 },
      { x: 1.5, z: 4.5, r: 3.0 },
      { x: -3.5, z: -3.5, r: 2.6 },
      { x: 8.5, z: -6.5, r: 2.6 },
      { x: -9.5, z: -11.5, r: 2.8 },
    ];
    for (const f of featured) clusters.push(f);
    let guard = 0;
    while (clusters.length < 44 && guard++ < 900) {
      const rr = 7 + Math.sqrt(rnd()) * 49;
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.hypot(x - P.x, z - P.z) < P.r * 1.3) continue;
      if (Math.hypot(x - S.x, z - S.z) < 5) continue;
      if (Math.hypot(x - R.x, z - R.z) < 3.5) continue;
      let tooClose = false;
      for (const c of clusters) if (Math.hypot(x - c.x, z - c.z) < 4.5) { tooClose = true; break; }
      if (tooClose) continue;
      clusters.push({ x, z, r: 1.6 + rnd() * 1.6 });
    }
    const flowers = [];
    for (const c of clusters) {
      const rad = c.r || 2.2;
      const n = 9 + ((rnd() * 9) | 0);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU;
        const rr = Math.sqrt(rnd()) * rad;
        flowers.push({
          x: c.x + Math.cos(a) * rr,
          z: c.z + Math.sin(a) * rr,
          s: 0.78 + rnd() * 0.5,
          yaw: rnd() * TAU,
          tiltX: (rnd() - 0.5) * 0.24,
          tiltZ: (rnd() - 0.5) * 0.24,
          kind: rnd(),
        });
      }
    }
    const { petalGeo, centerGeo, stemGeo } = makeFlowerGeos();
    const petalMesh = new T.InstancedMesh(petalGeo, ctx.mats.petal, flowers.length);
    const centerMesh = new T.InstancedMesh(centerGeo, ctx.mats.flowerCenter, flowers.length);
    const stemMesh = new T.InstancedMesh(stemGeo, ctx.mats.flowerStem, flowers.length);
    petalMesh.name = 'flowers';
    centerMesh.name = 'flower-centers';
    stemMesh.name = 'flower-stems';
    const dummy = new T.Object3D();
    const col = new T.Color();
    const cWhite = new T.Color(0xffffff);
    const cPink = new T.Color(0xff8fc0);
    const cRose = new T.Color(0xffb8d6);
    const cCream = new T.Color(0xfff0a8);
    const cLilac = new T.Color(0xdcc0ff);
    const euler = new T.Euler();
    for (let i = 0; i < flowers.length; i++) {
      const f = flowers[i];
      dummy.position.set(f.x, ctx.ground.groundY(f.x, f.z) + 0.16 + f.s * 0.02, f.z);
      euler.set(f.tiltX, f.yaw, f.tiltZ, 'YXZ');
      dummy.quaternion.setFromEuler(euler);
      dummy.scale.setScalar(f.s);
      dummy.updateMatrix();
      petalMesh.setMatrixAt(i, dummy.matrix);
      centerMesh.setMatrixAt(i, dummy.matrix);
      stemMesh.setMatrixAt(i, dummy.matrix);
      if (f.kind < 0.38) col.copy(cWhite);
      else if (f.kind < 0.66) col.copy(cPink);
      else if (f.kind < 0.82) col.copy(cRose);
      else if (f.kind < 0.92) col.copy(cCream);
      else col.copy(cLilac);
      petalMesh.setColorAt(i, col);
    }
    petalMesh.instanceMatrix.needsUpdate = true;
    centerMesh.instanceMatrix.needsUpdate = true;
    stemMesh.instanceMatrix.needsUpdate = true;
    if (petalMesh.instanceColor) petalMesh.instanceColor.needsUpdate = true;
    petalMesh.castShadow = false;
    centerMesh.castShadow = false;
    stemMesh.castShadow = false;
    petalMesh.frustumCulled = false;
    centerMesh.frustumCulled = false;
    stemMesh.frustumCulled = false;
    ctx.group.add(stemMesh);
    ctx.group.add(petalMesh);
    ctx.group.add(centerMesh);
    ctx.stats.flowers = flowers.length;
  }

  // ============================================================
  // 10. 红白斑点蘑菇（帽 + 斑点烘焙进同一几何体）+ 蘑菇圈
  // ============================================================
  function makeMushroomGeos() {
    const rnd = mulberry32(4242);
    const capParts = [];
    const cap = new T.SphereGeometry(0.27, 12, 7, 0, TAU, 0, Math.PI * 0.53);
    cap.scale(1, 0.82, 1);
    const cRim = new T.Color(0xc9342c);
    const cTop = new T.Color(0xff7052);
    paintVerts(cap, (c, x, y) => {
      const t = clamp(y / 0.21, 0, 1);
      c.copy(cRim).lerp(cTop, t * 0.75);
    });
    capParts.push(cap);
    // 帽子上的白斑点
    for (let i = 0; i < 5; i++) {
      const theta = 0.28 + rnd() * 0.72;
      const phi = rnd() * TAU;
      const surf = new T.Vector3(
        Math.sin(theta) * Math.cos(phi) * 0.27,
        Math.cos(theta) * 0.82 * 0.27,
        Math.sin(theta) * Math.sin(phi) * 0.27
      );
      const spot = new T.SphereGeometry(0.052, 7, 5);
      spot.scale(1, 0.62, 1);
      spot.translate(surf.x, surf.y + 0.012, surf.z);
      paintVerts(spot, (c) => c.setHex(0xfff4e2));
      capParts.push(spot);
    }
    const capGeo = mergeGeoms(capParts);
    capGeo.computeVertexNormals();
    capGeo.translate(0, 0.3, 0); // 抬到菌柄顶端

    const stemGeo = cylGeo(0.062, 0.098, 0.31, 8, false);
    stemGeo.translate(0, 0.155, 0);
    paintVerts(stemGeo, (c, x, y) => {
      c.setHex(0xe6d2a8).lerp(new T.Color(0xfff6df), clamp(y / 0.3, 0, 1));
    });
    return { capGeo, stemGeo };
  }

  function buildMushrooms(ctx) {
    const rnd = ctx.rnd;
    const { capGeo, stemGeo } = makeMushroomGeos();
    const P = LAYOUT.pond, S = LAYOUT.shrine, R = LAYOUT.ring;
    const list = [];
    // 蘑菇圈（妖精环）：15 朵，大一些
    for (let i = 0; i < 15; i++) {
      const a = (i / 15) * TAU + (rnd() - 0.5) * 0.22;
      const rr = 3.5 + rnd() * 2.1;
      list.push({
        x: R.x + Math.cos(a) * rr,
        z: R.z + Math.sin(a) * rr,
        s: 1.15 + rnd() * 0.9,
        rot: rnd() * TAU,
        tilt: (rnd() - 0.5) * 0.18,
      });
    }
    // 零散蘑菇
    let guard = 0;
    while (list.length < 46 && guard++ < 400) {
      const rr = 9 + Math.sqrt(rnd()) * 49;
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.hypot(x - P.x, z - P.z) < P.r * 1.2) continue;
      if (Math.hypot(x - S.x, z - S.z) < 4) continue;
      if (Math.hypot(x - R.x, z - R.z) < 6) continue;
      list.push({ x, z, s: 0.75 + rnd() * 0.7, rot: rnd() * TAU, tilt: (rnd() - 0.5) * 0.24 });
    }

    const capMesh = new T.InstancedMesh(capGeo, ctx.mats.mushroom, list.length);
    const stemMesh = new T.InstancedMesh(stemGeo, ctx.mats.mushroomStem, list.length);
    capMesh.name = 'mushroom-caps';
    stemMesh.name = 'mushroom-stems';
    const dummy = new T.Object3D();
    const col = new T.Color();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      dummy.position.set(m.x, ctx.ground.groundY(m.x, m.z) - 0.025, m.z);
      dummy.rotation.set(m.tilt, m.rot, m.tilt * 0.6);
      dummy.scale.setScalar(m.s);
      dummy.updateMatrix();
      capMesh.setMatrixAt(i, dummy.matrix);
      stemMesh.setMatrixAt(i, dummy.matrix);
      const k = 0.92 + rnd() * 0.14;
      col.setRGB(k, k * (0.98 + rnd() * 0.04), k * 0.96);
      capMesh.setColorAt(i, col);
      stemMesh.setColorAt(i, col);
    }
    capMesh.instanceMatrix.needsUpdate = true;
    stemMesh.instanceMatrix.needsUpdate = true;
    if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    if (stemMesh.instanceColor) stemMesh.instanceColor.needsUpdate = true;
    capMesh.castShadow = false;
    stemMesh.castShadow = false;
    ctx.group.add(capMesh);
    ctx.group.add(stemMesh);
    ctx.stats.mushrooms = list.length;
  }

  // ============================================================
  // 11. 岩石（低多面体，圆润）+ 池塘岸石
  // ============================================================
  function makeRockGeo(seed, detail, squash) {
    const geo = new T.IcosahedronGeometry(1, detail);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // 用坐标哈希扰动，保证共享顶点被同样地移动、不裂开
      const f = 0.8 + 0.42 * hash2(x * 5.7 + seed, z * 4.3 + y * 2.9 + seed * 0.7);
      p.setXYZ(i, x * f, y * f, z * f);
    }
    geo.scale(1, squash || 0.7, 1);
    geo.computeVertexNormals();
    const cGray = new T.Color(0x8f9aa0);
    const cLight = new T.Color(0xb9c4b8);
    const cMoss = new T.Color(0x6f9a4e);
    paintVerts(geo, (c, x, y, z) => {
      c.copy(cGray).lerp(cLight, smoothstep(-0.5, 0.7, y) * 0.8);
      c.lerp(cMoss, smoothstep(0.35, 0.95, y) * 0.62);
    });
    geo.translate(0, 0.52, 0);
    return geo;
  }

  function buildRocks(ctx) {
    const rnd = ctx.rnd;
    const P = LAYOUT.pond;
    const bigGeo = makeRockGeo(3.1, 1, 0.72);
    const smallGeo = makeRockGeo(8.4, 0, 0.55);
    const bigs = [];
    const smalls = [];
    // 大石群（两个，形成地标）
    const clusters = [
      { x: LAYOUT.rocks.x, z: LAYOUT.rocks.z, n: 4 },
      { x: LAYOUT.rocks2.x, z: LAYOUT.rocks2.z, n: 3 },
    ];
    for (const c of clusters) {
      for (let i = 0; i < c.n; i++) {
        const a = (i / c.n) * TAU + rnd() * 0.8;
        const rr = i === 0 ? 0 : 1.6 + rnd() * 1.9;
        const s = i === 0 ? 1.9 + rnd() * 0.7 : 1.05 + rnd() * 0.8;
        bigs.push({
          x: c.x + Math.cos(a) * rr,
          z: c.z + Math.sin(a) * rr,
          s,
          rot: rnd() * TAU,
        });
        if (s > 1.15) ctx.colliders.push({ x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr, r: 0.92 * s });
      }
    }
    // 零散小石块
    for (let i = 0; i < 30; i++) {
      const rr = 12 + Math.sqrt(rnd()) * 47;
      const a = rnd() * TAU;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.hypot(x - P.x, z - P.z) < P.r * 1.15) continue;
      smalls.push({ x, z, s: 0.3 + rnd() * 0.5, rot: rnd() * TAU });
    }
    // 池塘岸石（围一圈）
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * TAU + (rnd() - 0.5) * 0.2;
      const rr = P.r + 0.55 + rnd() * 1.5;
      smalls.push({
        x: P.x + Math.cos(a) * rr,
        z: P.z + Math.sin(a) * rr,
        s: 0.42 + rnd() * 0.42,
        rot: rnd() * TAU,
      });
    }

    const dummy = new T.Object3D();
    const col = new T.Color();
    const mk = (geo, mat, list, name, cast) => {
      const mesh = new T.InstancedMesh(geo, mat, list.length);
      mesh.name = name;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        dummy.position.set(r.x, ctx.ground.groundY(r.x, r.z) - 0.04, r.z);
        dummy.rotation.set(0, r.rot, 0);
        dummy.scale.set(r.s * (0.85 + rnd() * 0.3), r.s, r.s * (0.85 + rnd() * 0.3));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const k = 0.9 + rnd() * 0.16;
        col.setRGB(k, k, k);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      ctx.group.add(mesh);
      return mesh;
    };
    mk(bigGeo, ctx.mats.rock, bigs, 'rocks-big', true);
    mk(smallGeo, ctx.mats.rock, smalls, 'rocks-small', false);
    ctx.stats.rocks = bigs.length + smalls.length;
  }

    // ============================================================
  // 12. 水塘：半透明水面 shader + 波纹 + 睡莲 + 木栈桥
  // ============================================================
  const WATER_VERT = [
    'varying vec3 vWorld;',
    'void main() {',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWorld = wp.xyz;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}',
  ].join('\n');

  const WATER_FRAG = [
    'uniform float uTime;',
    'uniform vec2 uCenter;',
    'uniform float uRadius;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uDeep;',
    'uniform vec3 uShallow;',
    'uniform vec3 uSky;',
    'uniform vec3 uFoam;',
    'uniform vec3 uSun;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vec2 p = vWorld.xz;',
    '  float d = clamp(length(p - uCenter) / uRadius, 0.0, 1.2);',
    // 三组行波叠加出柔和波纹
    '  float w = sin(p.x * 1.9 + uTime * 1.15) * 0.5',
    '          + sin(p.y * 2.4 - uTime * 0.95) * 0.5',
    '          + sin((p.x + p.y) * 3.6 + uTime * 1.75) * 0.32',
    '          + sin((p.x - p.y) * 5.9 - uTime * 2.1) * 0.16;',
    '  float ripple = w * 0.42 + 0.5;',
    '  vec3 col = mix(uDeep, uShallow, clamp(d * 0.85 + ripple * 0.22, 0.0, 1.0));',
    // 波峰亮边
    '  float crest = smoothstep(0.66, 0.96, ripple);',
    '  col += uSun * crest * 0.3;',
    // 阳光碎金
    '  vec2 gp = p * 1.35;',
    '  float sp = pow(max(0.0, sin(gp.x * 6.3 + uTime * 2.4) * sin(gp.y * 5.7 - uTime * 1.8)), 14.0);',
    '  col += uSun * sp * 1.4;',
    // 视角菲涅尔：平视时映出天空
    '  vec3 viewDir = normalize(uCamPos - vWorld);',
    '  float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 2.2);',
    '  col = mix(col, uSky, fres * 0.5);',
    // 岸边泡沫
    '  float foam = smoothstep(0.87, 1.0, d);',
    '  col = mix(col, uFoam, foam * 0.55);',
    '  float alpha = 0.82 * (1.0 - smoothstep(0.9, 1.02, d));',
    '  gl_FragColor = vec4(col, alpha);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');

  function buildPond(ctx) {
    const P = LAYOUT.pond;
    const waterY = ctx.ground.pondWaterY;
    const waterR = P.r * 0.96; // 水面略大，边缘埋进岸里，看起来水满到岸边
    const rnd = ctx.rnd;

    // ---- 水面 ----
    const uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new T.Vector2(P.x, P.z) },
      uRadius: { value: waterR },
      uCamPos: { value: new T.Vector3(0, 2, 20) },
      uDeep: { value: new T.Color(0x2f9fc4) },
      uShallow: { value: new T.Color(0x8ae8d2) },
      uSky: { value: new T.Color(0xd8f3ff) },
      uFoam: { value: new T.Color(0xf6fffa) },
      uSun: { value: new T.Color(0xfff6cc) },
    };
    const waterGeo = new T.CircleGeometry(waterR, 64);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new T.ShaderMaterial({
      uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
    });
    const water = new T.Mesh(waterGeo, waterMat);
    water.name = 'pond-water';
    water.position.set(P.x, waterY, P.z);
    water.renderOrder = 2;
    ctx.group.add(water);
    ctx.waterUniform = uniforms;

    // ---- 睡莲 ----
    const padGeo = new T.CircleGeometry(0.55, 13);
    // 切一个缺口更像睡莲叶
    const padPos = padGeo.attributes.position;
    for (let i = 0; i < padPos.count; i++) {
      const x = padPos.getX(i), y = padPos.getY(i);
      const a = Math.atan2(y, x);
      if (a > 0.25 && a < 0.55) padGeo.attributes.position.setXYZ(i, x * 0.55, y * 0.55, 0);
    }
    padGeo.rotateX(-Math.PI / 2);
    const padCount = 10;
    const padMesh = new T.InstancedMesh(padGeo, ctx.mats.lily, padCount);
    padMesh.name = 'lily-pads';
    const dummy = new T.Object3D();
    const col = new T.Color();
    const pads = [];
    for (let i = 0; i < padCount; i++) {
      const a = rnd() * TAU;
      const rr = 1.2 + rnd() * (waterR * 0.72);
      pads.push({
        x: P.x + Math.cos(a) * rr,
        z: P.z + Math.sin(a) * rr,
        phase: rnd() * TAU,
        s: 0.7 + rnd() * 0.85,
        rot: rnd() * TAU,
      });
    }
    for (let i = 0; i < padCount; i++) {
      const p = pads[i];
      dummy.position.set(p.x, waterY + 0.045, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      padMesh.setMatrixAt(i, dummy.matrix);
      const k = 0.85 + rnd() * 0.3;
      col.setRGB(0.32 * k, 0.55 * k, 0.2 * k);
      padMesh.setColorAt(i, col);
    }
    padMesh.instanceMatrix.needsUpdate = true;
    if (padMesh.instanceColor) padMesh.instanceColor.needsUpdate = true;
    padMesh.castShadow = false;
    ctx.group.add(padMesh);

    // ---- 水面涟漪圈 ----
    const ringGeo = new T.RingGeometry(0.86, 1.0, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const ripples = [];
    for (let i = 0; i < 6; i++) {
      const mat = new T.MeshBasicMaterial({
        color: 0xe6fbff,
        transparent: true,
        opacity: 0,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide,
        fog: false,
      });
      const mesh = new T.Mesh(ringGeo, mat);
      const a = rnd() * TAU;
      const rr = 1.0 + rnd() * (waterR * 0.55);
      mesh.position.set(P.x + Math.cos(a) * rr, waterY + 0.035, P.z + Math.sin(a) * rr);
      mesh.renderOrder = 3;
      ctx.group.add(mesh);
      ripples.push({ mesh, mat, phase: i / 6 + rnd() * 0.1 });
    }

    // ---- 木栈桥 ----
    const d = new T.Vector2(0 - P.x, 0 - P.z).normalize(); // 从塘心指向空地中心
    const shore = P.r + 0.4;
    const px = P.x + d.x * (shore - 1.7);
    const pz = P.z + d.y * (shore - 1.7);
    const pierParts = [];
    for (let i = 0; i < 5; i++) {
      const plank = boxGeo(0.56, 0.09, 3.3);
      plank.translate((i - 2) * 0.62, 0, 0);
      pierParts.push(plank);
    }
    for (const sx of [-1.35, 1.35]) {
      for (const sz of [-1.5, 1.5]) {
        const post = cylGeo(0.085, 0.1, 1.5, 7, false);
        post.translate(sx * 1.05, -0.55, sz);
        pierParts.push(post);
      }
    }
    const pier = new T.Mesh(mergeGeoms(pierParts), ctx.mats.woodLight);
    pier.name = 'pier';
    pier.position.set(px, waterY + 0.22, pz);
    pier.rotation.y = Math.atan2(-d.x, -d.y); // 桥头朝塘心
    pier.castShadow = true;
    pier.receiveShadow = true;
    ctx.group.add(pier);

    // ---- 每帧动画 ----
    const padDummy = new T.Object3D();
    ctx.dyn.updaters.push((dt, time) => {
      uniforms.uTime.value = time;
      // 睡莲随波起伏
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        padDummy.position.set(p.x, waterY + 0.045 + Math.sin(time * 0.8 + p.phase) * 0.03, p.z);
        padDummy.rotation.set(0, p.rot + Math.sin(time * 0.25 + p.phase) * 0.18, 0);
        padDummy.scale.setScalar(p.s);
        padDummy.updateMatrix();
        padMesh.setMatrixAt(i, padDummy.matrix);
      }
      padMesh.instanceMatrix.needsUpdate = true;
      // 涟漪扩散
      for (const r of ripples) {
        const t = fract(time * 0.19 + r.phase);
        const s = 0.45 + t * 3.1;
        r.mesh.scale.set(s, 1, s);
        r.mat.opacity = Math.pow(1 - t, 2.2) * 0.5;
      }
    });
  }

  // ============================================================
  // 13. 神龛：木制鸟居 + 石灯笼 + 发光宝珠 + 参道石
  // ============================================================
  function buildShrine(ctx) {
    const S = LAYOUT.shrine;
    const gy = ctx.ground.groundY(S.x, S.z);
    const root = new T.Group();
    root.name = 'shrine';
    root.position.set(S.x, gy, S.z);
    ctx.group.add(root);

    const woodRed = [];
    const woodDark = [];
    const stone = [];
    const paper = [];
    const lampGlow = [];

    // ---- 鸟居立柱 ----
    const pillarH = 5.4;
    for (const side of [-1, 1]) {
      const p = cylGeo(0.3, 0.38, pillarH, 10, false);
      p.rotateZ(-side * 0.022); // 顶端略向中心收
      p.translate(side * 2.5, pillarH / 2 + 0.1, 0);
      woodRed.push(p);
      const baseStone = cylGeo(0.5, 0.58, 0.38, 10, false);
      baseStone.translate(side * 2.5, 0.19, 0);
      stone.push(baseStone);
      const collar = boxGeo(0.82, 0.22, 0.82);
      collar.translate(side * 2.5, 0.46, 0);
      woodDark.push(collar);
    }
    // 笠木（顶梁）+ 两端上翘
    const topY = 5.44;
    const kasagi = boxGeo(7.6, 0.46, 0.78);
    kasagi.translate(0, topY, 0);
    woodRed.push(kasagi);
    for (const side of [-1, 1]) {
      const e = boxGeo(1.5, 0.5, 0.82);
      e.rotateZ(side * 0.16);
      e.translate(side * 4.18, topY + 0.14, 0);
      woodRed.push(e);
    }
    const shimaki = boxGeo(6.6, 0.34, 0.62);
    shimaki.translate(0, topY - 0.52, 0);
    woodRed.push(shimaki);
    const nuki = boxGeo(5.6, 0.3, 0.46);
    nuki.translate(0, 4.06, 0);
    woodRed.push(nuki);
    const midPost = boxGeo(0.26, 1.02, 0.26);
    midPost.translate(0, 3.52, 0);
    woodRed.push(midPost);
    // 牌匾木框
    const frame = boxGeo(1.16, 1.4, 0.16);
    frame.translate(0, 4.72, 0.2);
    woodDark.push(frame);
    // 御币（白纸垂）
    for (const side of [-1, 1]) {
      const sh = boxGeo(0.3, 0.8, 0.02);
      sh.rotateZ(side * 0.09);
      sh.translate(side * 1.72, 4.32, 0.34);
      paper.push(sh);
    }

    // ---- 石灯笼 ×2 ----
    for (const side of [-1, 1]) {
      const lx = side * 5.7;
      const lz = 1.5;
      const b = cylGeo(0.4, 0.48, 0.3, 10, false);
      b.translate(lx, 0.15, lz);
      stone.push(b);
      const shaft = cylGeo(0.15, 0.19, 1.02, 8, false);
      shaft.translate(lx, 0.81, lz);
      stone.push(shaft);
      const mid = cylGeo(0.32, 0.32, 0.1, 8, false);
      mid.translate(lx, 1.36, lz);
      stone.push(mid);
      const box = boxGeo(0.44, 0.46, 0.44);
      box.translate(lx, 1.64, lz);
      lampGlow.push(box);
      const roof = new T.ConeGeometry(0.62, 0.34, 4, 1);
      roof.rotateY(Math.PI / 4);
      roof.translate(lx, 2.0, lz);
      stone.push(roof);
      const top = sphereGeo(0.09, 8, 6);
      top.translate(lx, 2.24, lz);
      stone.push(top);
    }

    // ---- 供石 / 参道石阶 ----
    const offering = boxGeo(1.9, 0.32, 0.95);
    offering.translate(0, 0.16, 2.6);
    stone.push(offering);
    for (let i = 0; i < 3; i++) {
      const st = boxGeo(4.2 - i * 0.45, 0.16, 0.72);
      st.translate(0, 0.08 - i * 0.005, 3.55 + i * 0.82);
      stone.push(st);
    }

    const shadowOn = true;
    const addMerged = (parts, mat, name) => {
      if (!parts.length) return null;
      const mesh = new T.Mesh(mergeGeoms(parts), mat);
      mesh.name = name;
      mesh.castShadow = shadowOn;
      mesh.receiveShadow = true;
      root.add(mesh);
      return mesh;
    };
    addMerged(woodRed, ctx.mats.woodRed, 'shrine-wood-red');
    addMerged(woodDark, ctx.mats.woodDark, 'shrine-wood-dark');
    addMerged(stone, ctx.mats.shrineStone, 'shrine-stone');
    addMerged(paper, ctx.mats.paper, 'shrine-paper');
    const lampMesh = addMerged(lampGlow, ctx.mats.lanternGlow, 'shrine-lantern-glow');
    if (lampMesh) lampMesh.castShadow = false;

    // ---- 牌匾 ----
    const plaque = new T.Mesh(
      new T.PlaneGeometry(0.94, 1.16),
      new T.MeshStandardMaterial({ map: ctx.tex.plaque, roughness: 0.85, side: T.DoubleSide })
    );
    plaque.position.set(0, 4.72, 0.3);
    root.add(plaque);

    // ---- 发光宝珠 + 光晕 ----
    const orbGroup = new T.Group();
    orbGroup.position.set(0, 3.3, 0);
    root.add(orbGroup);
    const orb = new T.Mesh(sphereGeo(0.42, 16, 12), ctx.mats.orb);
    orb.castShadow = false;
    orbGroup.add(orb);
    const haloMat = (opacity, tint) =>
      new T.SpriteMaterial({
        map: ctx.tex.glowWhite,
        color: tint,
        transparent: true,
        opacity,
        blending: T.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
    const haloBig = new T.Sprite(haloMat(0.2, 0xb9ffe8));
    haloBig.scale.set(4.6, 4.6, 1);
    orbGroup.add(haloBig);
    const haloSmall = new T.Sprite(haloMat(0.6, 0xdcfff4));
    haloSmall.scale.set(1.9, 1.9, 1);
    orbGroup.add(haloSmall);

    // 灯笼光晕
    const lanternHalos = [];
    for (const side of [-1, 1]) {
      const sp = new T.Sprite(haloMat(0.5, 0xffd98a));
      sp.scale.set(1.7, 1.7, 1);
      sp.position.set(side * 5.7, gy * 0 + 1.64, 1.5);
      root.add(sp);
      lanternHalos.push(sp);
    }

    // ---- 参道石板（从空地方向一路铺到神龛）----
    const slabGeo = cylGeo(1, 1, 0.16, 9, false);
    slabGeo.translate(0, -0.02, 0);
    paintVerts(slabGeo, (c, x, y) => {
      c.setHex(0x9aa596).lerp(new T.Color(0xc3ccb9), smoothstep(-0.5, 0.5, y));
    });
    const slabCount = 12;
    const slabs = new T.InstancedMesh(slabGeo, ctx.mats.slab, slabCount);
    slabs.name = 'shrine-path';
    const dummy = new T.Object3D();
    const slabCol = new T.Color();
    for (let i = 0; i < slabCount; i++) {
      const z = -28.5 + i * 1.85;
      const x = Math.sin(i * 0.9) * 0.55;
      dummy.position.set(S.x + x, ctx.ground.groundY(S.x + x, z) + 0.04, z);
      dummy.rotation.set(0, (i * 1.37) % TAU, 0);
      dummy.scale.set(0.72 + (i % 3) * 0.12, 1, 0.72 + (i % 2) * 0.14);
      dummy.updateMatrix();
      slabs.setMatrixAt(i, dummy.matrix);
      const k = 0.9 + (i % 4) * 0.04;
      slabCol.setRGB(k, k, k * 0.97);
      slabs.setColorAt(i, slabCol);
    }
    slabs.instanceMatrix.needsUpdate = true;
    if (slabs.instanceColor) slabs.instanceColor.needsUpdate = true;
    slabs.receiveShadow = true;
    ctx.group.add(slabs);

    // ---- 神龛碰撞体（柱子 / 灯笼 / 供石）----
    ctx.colliders.push({ x: S.x - 2.5, z: S.z, r: 0.62 });
    ctx.colliders.push({ x: S.x + 2.5, z: S.z, r: 0.62 });
    ctx.colliders.push({ x: S.x - 5.7, z: S.z + 1.5, r: 0.55 });
    ctx.colliders.push({ x: S.x + 5.7, z: S.z + 1.5, r: 0.55 });
    ctx.colliders.push({ x: S.x, z: S.z + 2.6, r: 0.95 });

    ctx.dyn.shrine = {
      orbGroup,
      orb,
      haloBig,
      haloSmall,
      lanternHalos,
      lanternMat: ctx.mats.lanternGlow,
    };
    ctx.dyn.updaters.push((dt, time) => {
      const bob = Math.sin(time * 1.25) * 0.14;
      orbGroup.position.y = 3.3 + bob;
      orb.rotation.y = time * 0.7;
      const pulse = 1 + Math.sin(time * 1.6) * 0.08;
      haloSmall.scale.set(1.9 * pulse, 1.9 * pulse, 1);
      const hb = 4.6 * (1 + Math.sin(time * 0.9 + 1.2) * 0.06);
      haloBig.scale.set(hb, hb, 1);
      for (const sp of lanternHalos) sp.material.opacity = 0.42 + Math.sin(time * 3.1) * 0.1;
      ctx.mats.lanternGlow.emissiveIntensity = 1.9 + Math.sin(time * 3.1) * 0.22 + Math.sin(time * 7.7) * 0.1;
    });
  }

  // ============================================================
  // 14. 丁达尔光柱（合并几何 + 顶点 alpha 的加法混合）
  // ============================================================
  function buildGodRays(ctx) {
    const rnd = ctx.rnd;
    const spots = [
      [-7, -6], [8, -12], [-14, -16], [13, -19], [-3, -26],
      [18, -9], [-18, -24], [4, -30], [10, -31],
    ];
    const warm = new T.Color(0xffe4a2);
    const up = new T.Vector3(0, 1, 0);
    const parts = [];
    for (const s of spots) {
      const x = s[0] + (rnd() - 0.5) * 2.4;
      const z = s[1] + (rnd() - 0.5) * 2.4;
      const h = 12 + rnd() * 4.5;
      const rb = 0.9 + rnd() * 1.05;
      const rt = 0.24 + rnd() * 0.3;
      const g = new T.CylinderGeometry(rt, rb, h, 10, 5, true);
      const p = g.attributes.position;
      const colArr = new Float32Array(p.count * 4);
      const tint = 0.34 + rnd() * 0.24;
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) + h / 2) / h; // 0 = 地面，1 = 树冠
        let a = smoothstep(0.02, 0.3, t) * (1 - smoothstep(0.8, 1.0, t));
        a *= 0.55 + 0.45 * Math.sin(Math.atan2(p.getX(i), p.getZ(i)) * 3.0 + s[0]);
        a *= tint;
        colArr[i * 4] = warm.r;
        colArr[i * 4 + 1] = warm.g;
        colArr[i * 4 + 2] = warm.b;
        colArr[i * 4 + 3] = clamp(a, 0, 1);
      }
      g.setAttribute('color', new T.BufferAttribute(colArr, 4));
      // 光柱轴向 = 阳光方向
      g.applyQuaternion(new T.Quaternion().setFromUnitVectors(up, ctx.sunDir));
      const by = ctx.ground.groundY(x, z);
      const dir = ctx.sunDir;
      g.translate(x + dir.x * h * 0.5, by + dir.y * h * 0.5, z + dir.z * h * 0.5);
      parts.push(g);
    }
    const geo = mergeGeoms(parts);
    const mat = new T.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.2,
      blending: T.AdditiveBlending,
      depthWrite: false,
      side: T.DoubleSide,
      fog: false,
    });
    const mesh = new T.Mesh(geo, mat);
    mesh.name = 'godrays';
    mesh.renderOrder = 6;
    mesh.frustumCulled = false;
    ctx.group.add(mesh);
    ctx.dyn.updaters.push((dt, time) => {
      mat.opacity = 0.24 + Math.sin(time * 0.9) * 0.04 + Math.sin(time * 2.7 + 1.1) * 0.025;
    });
  }

  // ============================================================
  // 15. 粒子：萤火虫 / 浮尘 / 蒲公英种子（GPU 动画 Points）
  // ============================================================
  const POINT_VERT = [
    'attribute float aSize;',
    'attribute float aPhase;',
    'attribute vec3 aParam;',
    'uniform float uTime;',
    'uniform float uPixelScale;',
    'uniform float uFlicker;',
    'varying float vAlpha;',
    'varying float vDist;',
    'void main() {',
    '  vec3 p = position;',
    '  float ph = aPhase * 6.2831853;',
    '  float sp = aParam.x;',
    '  p.x += sin(uTime * sp + ph) * aParam.y;',
    '  p.z += cos(uTime * sp * 0.83 + ph * 1.7) * aParam.y;',
    '  p.y += sin(uTime * sp * 1.27 + ph * 2.3) * aParam.y * 0.6 + aParam.z * sin(uTime * 0.23 + ph);',
    '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  float dist = max(0.2, -mv.z);',
    '  gl_PointSize = aSize * uPixelScale / dist;',
    '  float flick = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * 2.1 + ph * 4.0), 2.0);',
    '  vAlpha = mix(1.0, flick, uFlicker);',
    '  vDist = dist;',
    '}',
  ].join('\n');

  const POINT_FRAG = [
    'uniform sampler2D uMap;',
    'uniform vec3 uColor;',
    'uniform float uOpacity;',
    'varying float vAlpha;',
    'varying float vDist;',
    'void main() {',
    '  vec4 tex = texture2D(uMap, gl_PointCoord);',
    '  float fade = 1.0 - smoothstep(70.0, 110.0, vDist);',
    '  float a = tex.a * vAlpha * uOpacity * fade;',
    '  if (a < 0.004) discard;',
    '  gl_FragColor = vec4(uColor, a);',
    '  #include <tonemapping_fragment>',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');

  function buildParticles(ctx) {
    const rnd = ctx.rnd;
    const P_TIME = { value: 0 };
    const P_PIXEL = { value: 700 };

    function makeSystem(cfg) {
      const n = cfg.count;
      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n);
      const phase = new Float32Array(n);
      const param = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        let x, z, y;
        if (cfg.volume === 'air') {
          const a = rnd() * TAU;
          const rr = Math.sqrt(rnd()) * cfg.radius;
          x = Math.cos(a) * rr;
          z = Math.sin(a) * rr;
          y = ctx.ground.groundY(x, z) + cfg.yMin + rnd() * (cfg.yMax - cfg.yMin);
        } else {
          const a = rnd() * TAU;
          const rr = Math.sqrt(rnd()) * cfg.radius;
          x = Math.cos(a) * rr;
          z = Math.sin(a) * rr;
          y = ctx.ground.groundY(x, z) + cfg.yMin + rnd() * (cfg.yMax - cfg.yMin);
        }
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        size[i] = cfg.size[0] + rnd() * (cfg.size[1] - cfg.size[0]);
        phase[i] = rnd();
        param[i * 3] = 0.22 + rnd() * cfg.speed;
        param[i * 3 + 1] = cfg.range * (0.35 + rnd() * 0.85);
        param[i * 3 + 2] = cfg.rise * (0.3 + rnd() * 0.8);
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
      geo.setAttribute('aPhase', new T.BufferAttribute(phase, 1));
      geo.setAttribute('aParam', new T.BufferAttribute(param, 3));
      const mat = new T.ShaderMaterial({
        uniforms: {
          uTime: P_TIME,
          uPixelScale: P_PIXEL,
          uFlicker: { value: cfg.flicker },
          uMap: { value: cfg.tex },
          uColor: { value: new T.Color(cfg.color) },
          uOpacity: { value: cfg.opacity },
        },
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        depthTest: true,
      });
      const points = new T.Points(geo, mat);
      points.name = cfg.name;
      points.frustumCulled = false;
      points.renderOrder = 7;
      ctx.group.add(points);
      return points;
    }

    // 萤火虫：暖黄色、闪烁、在空地间缓缓漂浮
    makeSystem({
      name: 'fireflies',
      count: 90,
      volume: 'air',
      radius: 46,
      yMin: 0.8,
      yMax: 3.6,
      size: [0.16, 0.34],
      speed: 0.5,
      range: 1.1,
      rise: 0.35,
      flicker: 1.0,
      color: 0xffe07a,
      opacity: 0.95,
      tex: ctx.tex.glowWarm,
    });
    // 浮尘：细小的金色光点，营造丁达尔体积感
    makeSystem({
      name: 'motes',
      count: 150,
      volume: 'air',
      radius: 50,
      yMin: 0.6,
      yMax: 7.5,
      size: [0.05, 0.13],
      speed: 0.35,
      range: 0.8,
      rise: 0.5,
      flicker: 0.35,
      color: 0xfff2cf,
      opacity: 0.6,
      tex: ctx.tex.glowWarm,
    });
    // 蒲公英种子：白色绒球，缓缓上升飘荡
    makeSystem({
      name: 'seeds',
      count: 30,
      volume: 'air',
      radius: 38,
      yMin: 2.0,
      yMax: 9.0,
      size: [0.16, 0.3],
      speed: 0.18,
      range: 1.6,
      rise: 0.9,
      flicker: 0.12,
      color: 0xffffff,
      opacity: 0.8,
      tex: ctx.tex.seed,
    });

    ctx.dyn.particleTime = P_TIME;
    ctx.dyn.particlePixel = P_PIXEL;
  }

  // ============================================================
  // 16. 敌人的刷新点（均匀分布在半径 50~58 的环上，尽量落在空地）
  // ============================================================
  function makeSpawnPoints(ctx) {
    const rnd = ctx.rnd;
    const pts = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + 0.31 + (rnd() - 0.5) * 0.07;
      const r = 51.5 + rnd() * 6;
      pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    return pts;
  }

  // ============================================================
  // 17. 组装世界
  // ============================================================
  let _built = null;
  let elapsed = 0;

  function disposeObject(root) {
    if (!root) return;
    root.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        for (const k in m) {
          const v = m[k];
          if (v && v.isTexture) v.dispose();
        }
        if (m.dispose) m.dispose();
      }
    });
  }

  function buildWorld(scene, THREE, opts) {
    if (!scene) throw new Error('PG.world.build: 缺少 scene');
    T = THREE || window.THREE;
    if (!T) throw new Error('PG.world.build: 缺少 THREE');
    opts = opts || {};

    // 释放上一次构建（重开/热重载时避免泄漏）
    if (_built) {
      if (_built.group && _built.group.parent) _built.group.parent.remove(_built.group);
      disposeObject(_built.group);
      for (const l of _built.lights || []) {
        if (l.parent) l.parent.remove(l);
        if (l.target && l.target.parent) l.target.parent.remove(l.target);
        if (l.dispose) l.dispose();
      }
      _built = null;
    }

    const group = new T.Group();
    group.name = 'world';
    scene.add(group);

    // 场景环境
    if (!opts.skipFog) scene.fog = new T.Fog(LAYOUT.fogColor, 42, 150);
    if (scene.background == null) scene.background = new T.Color(LAYOUT.fogColor);

    const sunDir = new T.Vector3(LAYOUT.sunDir[0], LAYOUT.sunDir[1], LAYOUT.sunDir[2]).normalize();
    const rnd = mulberry32(opts.seed == null ? 20241111 : opts.seed);

    // 贴图（Canvas 程序生成）
    const tex = {
      sky: makeSkyTexture(),
      grass: makeGrassTexture(),
      glowWarm: makeGlowTexture([
        [0, 'rgba(255,255,240,1)'],
        [0.28, 'rgba(255,232,150,0.72)'],
        [0.62, 'rgba(255,214,110,0.22)'],
        [1, 'rgba(255,200,90,0)'],
      ]),
      glowWhite: makeGlowTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.3, 'rgba(230,255,248,0.66)'],
        [0.65, 'rgba(200,255,240,0.2)'],
        [1, 'rgba(200,255,240,0)'],
      ]),
      seed: makeSeedTexture(),
      sun: makeSunTexture(),
      plaque: makePlaqueTexture(),
    };

    // 材质（标准卡通材质，明亮、无金属感）
    const mats = {
      trunk: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
      canopy: withWind(
        new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }),
        0.22,
        9.6
      ),
      grass: withWind(
        // 草用不受光的顶点色材质：完全避免草叶背面发黑，明亮卡通
        new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide, fog: true }),
        0.13,
        0.75
      ),
      // 花瓣很小，用不受光材质保证任何角度都明亮可爱
      petal: new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide, fog: true }),
      flowerStem: new T.MeshBasicMaterial({ color: 0x4f8f35, fog: true }),
      flowerCenter: new T.MeshStandardMaterial({
        color: 0xffd23f,
        roughness: 0.7,
        metalness: 0,
        emissive: 0x4a2f00,
        emissiveIntensity: 0.55,
      }),
      mushroom: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }),
      mushroomStem: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
      rock: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true }),
      lily: new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0 }),
      woodRed: new T.MeshStandardMaterial({ color: 0xd8503a, roughness: 0.72, metalness: 0 }),
      woodDark: new T.MeshStandardMaterial({ color: 0x6d4a33, roughness: 0.85, metalness: 0 }),
      woodLight: new T.MeshStandardMaterial({ color: 0xb98a55, roughness: 0.85, metalness: 0 }),
      shrineStone: new T.MeshStandardMaterial({ color: 0xa9b3a5, roughness: 0.95, metalness: 0 }),
      slab: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
      paper: new T.MeshStandardMaterial({
        color: 0xfffdf2,
        roughness: 0.6,
        metalness: 0,
        side: T.DoubleSide,
        emissive: 0x222018,
        emissiveIntensity: 0.3,
      }),
      lanternGlow: new T.MeshStandardMaterial({
        color: 0xffd07a,
        emissive: 0xffb64a,
        emissiveIntensity: 2.0,
        roughness: 0.4,
        metalness: 0,
      }),
      orb: new T.MeshStandardMaterial({
        color: 0x9bffdc,
        emissive: 0x5dffc8,
        emissiveIntensity: 2.4,
        roughness: 0.25,
        metalness: 0,
      }),
    };

    const ctx = {
      T,
      scene,
      opts,
      group,
      rnd,
      tex,
      mats,
      sunDir,
      ground: null,
      dyn: { updaters: [] },
      colliders: [],
      landmarks: [],
      spawnPoints: [],
      trees: [],
      sunLight: null,
      stats: { trees: 0, grass: 1500, flowers: 0, mushrooms: 0, rocks: 0 },
    };
    ctx.ground = makeHeightField();

    // ---- 构建顺序：先算刷新点，树木摆放时避开 ----
    ctx.spawnPoints = makeSpawnPoints(ctx);

    buildSky(ctx);
    buildLights(ctx);
    buildTerrain(ctx);
    buildTrees(ctx);
    buildGrass(ctx);
    buildFlowers(ctx);
    buildMushrooms(ctx);
    buildRocks(ctx);
    buildPond(ctx);
    buildShrine(ctx);
    buildGodRays(ctx);
    buildParticles(ctx);

    ctx.landmarks = [
      { x: LAYOUT.shrine.x, z: LAYOUT.shrine.z, type: 'shrine' },
      { x: LAYOUT.pond.x, z: LAYOUT.pond.z, type: 'pond' },
      { x: LAYOUT.ring.x, z: LAYOUT.ring.z, type: 'ring' },
      { x: LAYOUT.rocks.x, z: LAYOUT.rocks.z, type: 'rock' },
      { x: LAYOUT.rocks2.x, z: LAYOUT.rocks2.z, type: 'rock' },
    ];
    ctx.stats.trees = ctx.trees.length;
    ctx.stats.colliders = ctx.colliders.length;
    ctx.stats.trunkColliders = ctx.trees.filter((t) => !t.outer).length;
    ctx.treesInfo = ctx.trees.map((t) => ({ x: t.x, z: t.z, s: t.s, outer: !!t.outer }));
    ctx.stats.spawnPoints = ctx.spawnPoints.length;

    // ---- 每帧更新 ----
    let updaters = ctx.dyn.updaters;
    const pixelScaleTarget = ctx.dyn.particlePixel;

    function update(dt, t, camera) {
      dt = Math.min(dt == null ? 0.016 : dt, 0.1);
      let time;
      if (t == null) {
        elapsed += dt;
        time = elapsed;
      } else {
        time = t;
        elapsed = t;
      }
      // 风（树冠 / 草的顶点着色器共用这个 uniform）
      windUniform.value = time;
      if (ctx.waterUniform) {
        ctx.waterUniform.uTime.value = time;
        if (camera && camera.position) ctx.waterUniform.uCamPos.value.copy(camera.position);
      }
      // 粒子点尺寸随相机 fov 缩放（Points 走世界单位直径）
      if (camera && camera.fov && pixelScaleTarget) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const hPx = (window.innerHeight || 800) * dpr;
        pixelScaleTarget.value = hPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
      }
      if (ctx.dyn.particleTime) ctx.dyn.particleTime.value = time;
      for (let i = 0; i < updaters.length; i++) updaters[i](dt, time, camera);
    }

    function reset() {
      elapsed = 0;
      windUniform.value = 0;
      if (ctx.waterUniform) ctx.waterUniform.uTime.value = 0;
      if (ctx.dyn.particleTime) ctx.dyn.particleTime.value = 0;
      const sh = ctx.dyn.shrine;
      if (sh) {
        sh.orbGroup.position.y = 3.3;
        sh.orb.rotation.y = 0;
      }
    }

    const world = {
      group,
      radius: LAYOUT.radius,
      colliders: ctx.colliders,
      spawnPoints: ctx.spawnPoints,
      landmarks: ctx.landmarks,
      sunDir: sunDir.clone(),
      groundY: (x, z) => ctx.ground.groundY(x, z),
      update,
      reset,
      // —— 扩展字段（主循环 / UI 可选用）——
      ambient: {
        sky: new T.Color(0xdaf1ff),
        ground: new T.Color(0x6faa52),
        sun: new T.Color(0xfff2cc),
        sunIntensity: 2.35,
        skyTop: new T.Color(LAYOUT.skyTop),
        fog: new T.Color(LAYOUT.fogColor),
        sunDir: sunDir.clone(),
      },
      fog: scene.fog,
      layout: LAYOUT,
      stats: ctx.stats,
      sunLight: ctx.sunLight,
      lights: ctx.sunLight ? [ctx.sunLight] : [],
      pondWaterY: ctx.ground.pondWaterY,
      waterUniform: ctx.waterUniform,
      // 供 QA / 调试：树木与地标数据
      trees: ctx.treesInfo,
      colliderCount: ctx.colliders.length,
      // 调试用
      _meshes: {},
    };

    _built = { group, lights: ctx.sunLight ? [ctx.sunLight] : [], world };
    PG.world._last = world;
    return world;
  }

  // ============================================================
  // 18. 导出
  // ============================================================
  PG.world = { build: buildWorld };
})();