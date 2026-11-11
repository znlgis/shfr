/* 40-util.js — 通用工具（Lead） */
(() => {
  const PG = (window.PG = window.PG || {});
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
  const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const chance = (p) => Math.random() < p;
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());

  function dirXZ(fromX, fromZ, toX, toZ) {
    const dx = toX - fromX, dz = toZ - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l, len: Math.hypot(dx, dz) };
  }

  function disposeTree(obj) {
    if (!obj) return;
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const k in m) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        }
      }
    });
  }

  // 简易对象池
  class Pool {
    constructor(factory, reset, size = 0) {
      this.factory = factory; this.reset = reset; this.free = [];
      for (let i = 0; i < size; i++) this.free.push(factory());
    }
    get() { return this.free.length ? this.free.pop() : this.factory(); }
    put(o) { this.reset && this.reset(o); this.free.push(o); }
  }

  // 屏幕坐标投影：世界点 -> 屏幕像素（返回 null 表示在相机背后）
  function project(v3, camera, w, h) {
    const p = v3.clone().project(camera);
    if (p.z > 1) return null;
    return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, z: p.z };
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // 线性同余随机（固定种子，让场景可重复生成）
  function seeded(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  PG.util = { TAU, clamp, lerp, damp, smoothstep, rand, randInt, pick, chance, now, dirXZ, disposeTree, Pool, project, fmtTime, seeded };
  PG.errors = PG.errors || [];
  window.addEventListener('error', (e) => { PG.errors.push(String(e.message)); });
})();
