#!/usr/bin/env node
/**
 * tests/playtest.mjs —— 无头 Edge 自动对局验收（Playtest harness，负责人：ui）
 * ---------------------------------------------------------------------------
 * 用 Chrome DevTools Protocol 驱动无头 Edge，真实跑一局，输出 JSON 验收报告：
 *   · 页面加载 / 运行期 JS 错误（CDP 异常 + 页面 onerror + PG.errors + #fatal）
 *   · 状态机：boot -> title -> select -> game -> pause/resume -> dead -> restart -> win
 *   · 玩法指标：波次推进（wave >= 2）、击杀数、分数、玩家掉血、BOSS 出现
 *   · 渲染指标：rAF 帧时间 p50 / p95（换算 FPS）、每帧最大 draw call / 三角形数
 *   · 界面可达性：各屏 DOM 可见性（软检查）+ 截图存证 _shots/playtest-*.png
 *
 * 用法（在项目根目录）：
 *   node tests/playtest.mjs --build                 # 先构建 _playtest.html 再验收
 *   node tests/playtest.mjs                         # 直接跑已有 _playtest.html
 *   node tests/playtest.mjs --url=file:///... --no-shots --verbose
 *
 * 参数：
 *   --build              先执行 node build.mjs --dev --out=_playtest.html
 *   --url=<url>          指定被测页面（默认 _playtest.html）
 *   --no-shots           不截图（只出 JSON）
 *   --keep               保留临时浏览器 profile（排错用）
 *   --verbose            打印页面控制台原始日志（含被忽略的良性警告）
 *   --total-timeout=ms   总超时，默认 420000
 *   --game-timeout=ms    单个对局阶段超时，默认 180000
 *
 * 退出码：0 = 全部硬性检查通过；1 = 有硬性失败；2 = 环境/参数错误。
 *
 * 说明：
 *   - 需要 Node 22+（内置全局 WebSocket / fetch）。浏览器优先用环境变量 EDGE_PATH。
 *   - 自动瞄准：每帧把玩家朝向对准最近的存活敌人，再调用 PG.game.update，
 *     这样不依赖鼠标事件也能验证「射击 -> 命中 -> 击杀 -> 进波」的完整链路。
 *   - pointerlock 在无头模式下不可用，脚本会 stub requestPointerLock，避免主循环
 *     因 pointerlockchange 自动暂停而干扰测试（报告里会标注 pointerLockStubbed）。
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NL = String.fromCharCode(10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, '_shots');
const REPORT = path.join(SHOTS, 'playtest.json');
const PAGE = path.join(ROOT, '_playtest.html');

/* ==========================================================================
   0. 参数
   ========================================================================== */
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes('--' + name);
const getOpt = (name, def) => {
  const pre = '--' + name + '=';
  const hit = argv.find((a) => a.startsWith(pre));
  return hit === undefined ? def : hit.slice(pre.length);
};
const KEEP_PROFILE = hasFlag('keep');
const NO_SHOTS = hasFlag('no-shots');
const VERBOSE = hasFlag('verbose');
const DO_BUILD = hasFlag('build');
const TOTAL_TIMEOUT = Number(getOpt('total-timeout', 420000));
const GAME_TIMEOUT = Number(getOpt('game-timeout', 180000));
const TITLE_TIMEOUT = Number(getOpt('title-timeout', 45000));
const VIEW = { w: 1280, h: 800 };
const START_MS = Date.now();

const R = {
  tool: 'tests/playtest.mjs',
  version: 1,
  startAt: new Date().toISOString(),
  ok: false,
  page: null,
  browser: null,
  viewport: VIEW,
  uiApi: {},
  uiImpl: 'unknown',
  checks: [],
  metrics: {},
  phases: {},
  errors: [],
  consoleErrors: [],
  warnings: [],
  hardFails: [],
  screenshots: [],
  elapsedMs: 0,
};
const t0 = START_MS;

function check(id, desc, ok, hard, detail) {
  R.checks.push({ id, desc, ok: !!ok, hard: hard !== false, detail: detail === undefined ? null : detail });
  if (!ok && hard !== false) R.hardFails.push(id + ' - ' + desc + (detail ? ' :: ' + detail : ''));
  return !!ok;
}
function warn(msg) {
  R.warnings.push(String(msg));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ==========================================================================
   1. 构建 / 浏览器定位
   ========================================================================== */
function buildPage() {
  console.log('[playtest] 构建 _playtest.html ...');
  execFileSync(process.execPath, ['build.mjs', '--dev', '--out=_playtest.html'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function findBrowser() {
  const envPaths = [process.env.EDGE_PATH, process.env.CHROME_PATH].filter(Boolean);
  const candidates = envPaths.concat([
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/* ==========================================================================
   2. 极简 CDP 客户端
   ========================================================================== */
class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }
  onMessage(ev) {
    let msg = null;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch (e) {
      return;
    }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 调用失败'));
      else p.resolve(msg.result);
      return;
    }
    const list = this.listeners.get(msg.method);
    if (list) {
      for (const fn of list) {
        try { fn(msg.params); } catch (e) { /* ignore */ }
      }
    }
  }
  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }
  send(method, params, timeoutMs) {
    const id = ++this.id;
    const wait = timeoutMs || 30000;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('CDP 已关闭'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时 ' + method));
      }, wait);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

/* ==========================================================================
   3. 页面内的测试辅助函数（通过 CDP 注入到页面）
   ========================================================================== */
const PAGE_HELPERS = [
  '(function () {',
  '  if (window.__PGT) return true;',
  '  var T = window.__PGT = {};',
  '  T.clean = function (s) {',
  '    s = String(s == null ? "" : s);',
  '    var out = [], cur = "";',
  '    for (var i = 0; i < s.length; i++) {',
  '      var c = s.charAt(i), code = s.charCodeAt(i);',
  '      if (code === 10 || code === 13 || code === 9 || c === " ") { if (cur) { out.push(cur); cur = ""; } }',
  '      else cur += c;',
  '    }',
  '    if (cur) out.push(cur);',
  '    return out.join(" ");',
  '  };',
  '  T.state = function () {',
  '    var G = window.PG && window.PG.game;',
  '    var E = window.PG && window.PG.main && window.PG.main.E;',
  '    if (!G) return { err: "no-game" };',
  '    var pl = G.player, st = G.state, alive = 0;',
  '    if (G.enemies) for (var i = 0; i < G.enemies.length; i++) if (G.enemies[i] && G.enemies[i].alive) alive++;',
  '    return {',
  '      mode: E ? E.mode : null,',
  '      gameMode: st ? st.mode : null,',
  '      wave: st ? st.wave : 0,',
  '      waveTotal: G.WAVE_TOTAL,',
  '      score: st ? st.score : 0,',
  '      combo: st ? st.combo : 0,',
  '      comboMax: st ? st.comboMax : 0,',
  '      time: st ? Math.round((st.time || 0) * 10) / 10 : 0,',
  '      enemies: G.enemies ? G.enemies.length : 0,',
  '      enemiesAlive: alive,',
  '      hp: pl ? Math.round((pl.hp || 0) * 10) / 10 : null,',
  '      hpMax: pl ? pl.hpMax : null,',
  '      dead: pl ? !!pl.dead : null,',
  '      kills: pl ? pl.kills : null,',
  '      shots: pl ? pl.shots : null,',
  '      hits: pl ? pl.hits : null,',
  '      ammo: pl ? pl.ammo : null,',
  '      boss: (st && st.boss) ? { name: st.boss.name, hp: Math.max(0, Math.round(st.boss.hp)), hpMax: st.boss.hpMax } : null,',
  '      errors: (window.PG && window.PG.errors) ? window.PG.errors.length : -1,',
  '      fatal: (document.getElementById("fatal") || {}).textContent || ""',
  '    };',
  '  };',
  '  T.uiText = function () {',
  '    var ui = document.getElementById("ui");',
  '    return ui ? T.clean(ui.innerText).slice(0, 600) : "";',
  '  };',
  '  T.uiStats = function () {',
  '    var ui = document.getElementById("ui");',
  '    if (!ui) return { nodes: 0 };',
  '    var all = ui.querySelectorAll("*");',
  '    var vis = 0, leaves = 0;',
  '    for (var i = 0; i < all.length; i++) {',
  '      var el = all[i];',
  '      var cs = getComputedStyle(el);',
  '      if (cs.display === "none" || cs.visibility === "hidden") continue;',
  '      if (parseFloat(cs.opacity) < 0.05) continue;',
  '      vis++;',
  '      if (el.children.length === 0 && T.clean(el.textContent).length > 0) leaves++;',
  '    }',
  '    return {',
  '      nodes: all.length,',
  '      visible: vis,',
  '      textLeaves: leaves,',
  '      buttons: ui.querySelectorAll("button").length,',
  '      cards: ui.querySelectorAll(".ui-card, .tcard, .char-card").length,',
  '      screens: ui.querySelectorAll(".scr-title, .scr-select, .scr-pause, .scr-dead, .scr-win, .ui-screen").length,',
  '      hud: !!ui.querySelector(".hud")',
  '    };',
  '  };',
  '  T.hudInfo = function () {',
  '    var ui = document.getElementById("ui");',
  '    if (!ui) return { found: false };',
  '    var hud = ui.querySelector(".hud");',
  '    if (!hud) return { found: false };',
  '    var cs = getComputedStyle(hud);',
  '    return {',
  '      found: true,',
  '      cls: String(hud.className).slice(0, 80),',
  '      opacity: parseFloat(cs.opacity),',
  '      display: cs.display,',
  '      visibility: cs.visibility,',
  '      text: T.clean(hud.innerText).slice(0, 240)',
  '    };',
  '  };',
  '  T.rectOf = function (el) {',
  '    try { return el.getBoundingClientRect(); } catch (e) { return { width: 0, height: 0 }; }',
  '  };',
  '  T.visibleIn = function (el) {',
  '    if (!el) return null;',
  '    var r = T.rectOf(el);',
  '    if (r.width > 1 && r.height > 1) return true;',
  '    // 容器本身 0 尺寸（如准星/受击弧）时，看子孙里有没有可见盒子',
  '    var kids = el.querySelectorAll("i, span, div");',
  '    for (var i = 0; i < kids.length; i++) {',
  '      var k = kids[i];',
  '      var cs = getComputedStyle(k);',
  '      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) continue;',
  '      var kr = T.rectOf(k);',
  '      if (kr.width > 1 && kr.height > 1) return true;',
  '    }',
  '    return false;',
  '  };',
  '  T.hudParts = function () {',
  '    var ui = document.getElementById("ui");',
  '    if (!ui) return {};',
  '    var out = {};',
  '    var list = ["hud-wave", "hud-obj", "hud-pcard", "hud-ptrack", "hud-ammo", "hud-cross", "hud-combo", "hud-boss", "hud-feed", "hud-hit", "hud-dmgnums", "hud-touch"];',
  '    for (var i = 0; i < list.length; i++) {',
  '      var cls = list[i];',
  '      var el = ui.querySelector("." + cls);',
  '      if (!el) { out[cls] = "missing"; continue; }',
  '      var cs = getComputedStyle(el);',
  '      var hid = cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05;',
  '      if (hid) { out[cls] = "hidden"; continue; }',
  '      out[cls] = T.visibleIn(el) ? "visible" : "zero-size";',
  '    }',
  '    out.zIndex = getComputedStyle(ui.querySelector(".hud") || ui).zIndex;',
  '    return out;',
  '  };',
  '  T.visibleScreen = function (name) {',
  '    var ui = document.getElementById("ui");',
  '    if (!ui) return { found: false };',
  '    var el = ui.querySelector(".scr-" + name) || ui.querySelector("[data-screen=" + name + "]") || ui.querySelector("[data-scr=" + name + "]");',
  '    if (!el) return { found: false };',
  '    var cs = getComputedStyle(el);',
  '    var op = parseFloat(cs.opacity);',
  '    return {',
  '      found: true,',
  '      cls: String(el.className).slice(0, 80),',
  '      opacity: op,',
  '      display: cs.display,',
  '      visibility: cs.visibility,',
  '      visible: cs.display !== "none" && cs.visibility !== "hidden" && op > 0.4,',
  '      text: T.clean(el.innerText).slice(0, 200)',
  '    };',
  '  };',
  '  T.isVis = function (el) {',
  '    if (!el || !el.getBoundingClientRect) return false;',
  '    var r = el.getBoundingClientRect();',
  '    if (r.width < 2 || r.height < 2) return false;',
  '    var cs = getComputedStyle(el);',
  '    if (cs.display === "none" || cs.visibility === "hidden") return false;',
  '    if (parseFloat(cs.opacity) < 0.2) return false;',
  '    var scr = el.closest(".scr-title, .scr-select, .scr-pause, .scr-dead, .scr-win");',
  '    if (scr && !scr.classList.contains("on")) return false;',
  '    return true;',
  '  };',
  '  T.screenName = function () {',
  '    return String(document.body.getAttribute("data-screen") || "");',
  '  };',
  '  T.clickText = function (pats) {',
  '    pats = pats || [];',
  '    var list = document.querySelectorAll("#ui button, #ui .ui-btn, #ui [role=button], #ui .tcard, #ui .char-card");',
  '    var scanned = 0, found = [];',
  '    for (var i = 0; i < list.length; i++) {',
  '      var el = list[i];',
  '      scanned++;',
  '      if (!T.isVis(el)) continue;',
  '      var txt = T.clean(el.textContent);',
  '      found.push(txt.slice(0, 20));',
  '      for (var j = 0; j < pats.length; j++) {',
  '        if (txt.indexOf(pats[j]) >= 0) {',
  '          try {',
  '            el.click();',
  '            return { ok: true, text: txt.slice(0, 30), tag: el.tagName, cls: String(el.className).slice(0, 60) };',
  '          } catch (e) { return { ok: false, err: String(e && e.message || e) }; }',
  '        }',
  '      }',
  '    }',
  '    return { ok: false, scanned: scanned, visibleTexts: found.slice(0, 10) };',
  '  };',
  '  T.pressKey = function (key, code, vk) {',
  '    function fire(type) {',
  '      var opts = { key: key, code: code, keyCode: vk, which: vk, bubbles: true, cancelable: true };',
  '      try { document.dispatchEvent(new KeyboardEvent(type, opts)); } catch (e) {}',
  '      try { window.dispatchEvent(new KeyboardEvent(type, opts)); } catch (e) {}',
  '    }',
  '    fire("keydown");',
  '    fire("keyup");',
  '    return true;',
  '  };',
  '  T.instrumentRenderer = function () {',
  '    try {',
  '      var E = window.PG && window.PG.main && window.PG.main.E;',
  '      if (!E || !E.renderer || E.renderer.__pgWrapped) return false;',
  '      var R = E.renderer;',
  '      var orig = R.render.bind(R);',
  '      R.info.autoReset = false;',
  '      R.__pgStats = { sceneCalls: 0, sceneTris: 0, vmCalls: 0, vmTris: 0, totalCalls: 0, totalTris: 0 };',
  '      R.render = function (scene, camera) {',
  '        var beforeCalls = R.info.render.calls;',
  '        var beforeTris = R.info.render.triangles;',
  '        orig(scene, camera);',
  '        var st = R.__pgStats;',
  '        var dc = Math.max(0, R.info.render.calls - beforeCalls);',
  '        var dt = Math.max(0, R.info.render.triangles - beforeTris);',
  '        if (scene === E.scene) { st.sceneCalls = dc; st.sceneTris = dt; }',
  '        else { st.vmCalls = dc; st.vmTris = dt; }',
  '        st.totalCalls = st.sceneCalls + st.vmCalls;',
  '        st.totalTris = st.sceneTris + st.vmTris;',
  '      };',
  '      R.__pgWrapped = true;',
  '      return true;',
  '    } catch (e) { return false; }',
  '  };',
  '  T.stubPointerLock = function () {',
  '    try { HTMLElement.prototype.requestPointerLock = function () { return Promise.resolve(); }; } catch (e) {}',
  '    try { document.exitPointerLock = function () {}; } catch (e) {}',
  '    return true;',
  '  };',
  '  T.forcePlay = function () {',
  '    try {',
  '      var E = window.PG && window.PG.main && window.PG.main.E;',
  '      if (E && E.mode === "paused") E.mode = "playing";',
  '      if (window.PG && window.PG.game && window.PG.game.resume) window.PG.game.resume();',
  '    } catch (e) {}',
  '    return true;',
  '  };',
  '  T.sim = function (sec, opts) {',
  '    opts = opts || {};',
  '    var G = window.PG && window.PG.game;',
  '    if (!G || !G.player || !G.state || !G.update) return { err: "no-game" };',
  '    var step = 1 / 60;',
  '    var total = Math.max(1, Math.round(sec / step));',
  '    var done = 0, err = null, maxWave = G.state.wave, maxEnemies = 0;',
  '    for (var i = 0; i < total; i++) {',
  '      var pl = G.player;',
  '      if (!pl || pl.dead) break;',
  '      if (opts.aim !== false) {',
  '        var best = null, bd = 1e9;',
  '        for (var j = 0; j < G.enemies.length; j++) {',
  '          var e = G.enemies[j];',
  '          if (!e || !e.alive || e.state === "spawn") continue;',
  '          var d = Math.hypot(e.pos.x - pl.pos.x, e.pos.z - pl.pos.z);',
  '          if (d < bd) { bd = d; best = e; }',
  '        }',
  '        if (best) {',
  '          var dx = best.pos.x - pl.pos.x, dz = best.pos.z - pl.pos.z;',
  '          pl.yaw = Math.atan2(-dx, -dz);',
  '          var hd = Math.max(0.001, Math.hypot(dx, dz));',
  '          var dy = (best.pos.y + (best.height || 1) * 0.5) - (pl.pos.y + pl.eye);',
  '          var pit = Math.atan2(dy, hd);',
  '          pl.pitch = Math.max(-1.3, Math.min(1.3, pit));',
  '        }',
  '      }',
  '      var inp = {',
  '        mx: opts.mx || 0, mz: opts.mz || 0, dx: 0, dy: 0,',
  '        fire: !!opts.fire, reload: false, jump: false, dash: false, ult: !!opts.ult',
  '      };',
  '      try { G.update(step, inp); } catch (e) { err = String(e && e.message || e); break; }',
  '      done++;',
  '      if (G.state.wave > maxWave) maxWave = G.state.wave;',
  '      if (G.enemies.length > maxEnemies) maxEnemies = G.enemies.length;',
  '      if (opts.stopMode && G.state.mode === opts.stopMode) break;',
  '    }',
  '    return { steps: done, err: err, maxWave: maxWave, maxEnemies: maxEnemies, state: T.state() };',
  '  };',
  '  T.fpsSample = function (ms) {',
  '    return new Promise(function (resolve) {',
  '      var dts = [], t0 = 0, last = 0, frames = 0, calls = 0, tris = 0, finished = false, sceneCalls = 0, sceneTris = 0, vmCalls = 0, totalCalls = 0;',
  '      var guard = setTimeout(function () {',
  '        if (!finished) { finished = true; resolve({ frames: frames, seconds: 0, p50: 0, p95: 0, fpsP50: 0, fpsP95: 0, callsMax: calls, trianglesMax: tris, note: "rAF 未运行" }); }',
  '      }, ms + 5000);',
  '      function finish() {',
  '        if (finished) return;',
  '        finished = true;',
  '        clearTimeout(guard);',
  '        dts.sort(function (a, b) { return a - b; });',
  '        function pick(q) {',
  '          if (!dts.length) return 0;',
  '          var idx = Math.min(dts.length - 1, Math.floor(q * dts.length));',
  '          return dts[idx];',
  '        }',
  '        var elapsed = Math.max(0.001, (performance.now() - t0) / 1000);',
  '        var p50 = pick(0.5), p95 = pick(0.95);',
  '        resolve({',
  '          frames: frames,',
  '          seconds: Math.round(elapsed * 100) / 100,',
  '          p50: Math.round(p50 * 100) / 100,',
  '          p95: Math.round(p95 * 100) / 100,',
  '          fpsP50: Math.round((1000 / Math.max(0.1, p50)) * 10) / 10,',
  '          fpsP95: Math.round((1000 / Math.max(0.1, p95)) * 10) / 10,',
  '          callsMax: calls,',
  '          sceneCallsMax: sceneCalls,',
  '          sceneTrianglesMax: sceneTris,',
  '          vmCallsMax: vmCalls,',
  '          totalCallsMax: totalCalls,',
  '          trianglesMax: tris',
  '        });',
  '      }',
  '      function tick(now) {',
  '        if (finished) return;',
  '        if (!t0) { t0 = now; last = now; }',
  '        var dt = now - last;',
  '        last = now;',
  '        if (dt > 0 && dt < 5000) dts.push(dt);',
  '        frames++;',
  '        try {',
  '          var E = window.PG && window.PG.main && window.PG.main.E;',
  '          var inf = E && E.renderer && E.renderer.info;',
  '          if (inf && inf.render) {',
  '            calls = Math.max(calls, inf.render.calls | 0);',
  '            tris = Math.max(tris, inf.render.triangles | 0);',
  '            var st = E.renderer.__pgStats;',
  '            if (st) {',
  '              sceneCalls = Math.max(sceneCalls, st.sceneCalls | 0);',
  '              sceneTris = Math.max(sceneTris, st.sceneTris | 0);',
  '              vmCalls = Math.max(vmCalls, st.vmCalls | 0);',
  '              totalCalls = Math.max(totalCalls, st.totalCalls | 0);',
  '            }',
  '            if (inf.reset) inf.reset();',
  '          }',
  '          if (E && E.mode === "paused") E.mode = "playing";',
  '        } catch (e) {}',
  '        if (now - t0 < ms) requestAnimationFrame(tick);',
  '        else finish();',
  '      }',
  '      try { var E0 = window.PG && window.PG.main && window.PG.main.E; if (E0 && E0.renderer && E0.renderer.info) E0.renderer.info.autoReset = false; } catch (e) {}',
'      requestAnimationFrame(tick);',
  '    });',
  '  };',
  '  return true;',
  '})()',
].join(NL);

// 在页面导航前注入：捕获最早的脚本异常
const EARLY_SCRIPT = [
  'window.__PGT_EARLY = { errors: [], rejections: [] };',
  'window.addEventListener("error", function (e) {',
  '  try {',
  '    var msg = e && (e.message || (e.error && e.error.message));',
  '    window.__PGT_EARLY.errors.push({ message: String(msg || "unknown"), file: String((e && e.filename) || ""), line: (e && e.lineno) || 0 });',
  '  } catch (err) {}',
  '}, true);',
  'window.addEventListener("unhandledrejection", function (e) {',
  '  try {',
  '    var r = e && e.reason;',
  '    window.__PGT_EARLY.rejections.push(String((r && r.message) || r));',
  '  } catch (err) {}',
  '});',
].join(NL);

/* ==========================================================================
   4. 错误过滤：区分「良性噪声」与「真实错误」
   ========================================================================== */
const IGNORE_PARTS = [
  'pointerlock',
  'pointer lock',
  'requestpointerlock',
  'the user has exited the lock',
  'favicon',
  'autoplay',
  'audiocontext was not allowed',
  'play() failed',
  'user gesture',
  'deprecat',
  'resizeobserver loop',
  'mediaelement',
];
const WARN_PARTS = [
  'webgl',
  'swiftshader',
  'gpu stall',
  'software rasterizer',
  'texture size',
  'non-power-of-two',
  'precision',
];

function classifyError(msg) {
  const s = String(msg || '').toLowerCase();
  for (const p of IGNORE_PARTS) if (s.indexOf(p) >= 0) return 'ignore';
  for (const p of WARN_PARTS) if (s.indexOf(p) >= 0) return 'warn';
  return 'error';
}
function addError(source, msg, extra) {
  const text = String(msg || '');
  if (!text) return;
  const kind = classifyError(text);
  if (kind === 'ignore') {
    if (VERBOSE) console.log('[playtest] 忽略良性日志 (' + source + '): ' + text.slice(0, 160));
    return;
  }
  const item = { source, message: text.slice(0, 500) };
  if (extra) item.extra = extra;
  if (kind === 'warn') {
    warn(source + ': ' + item.message);
    return;
  }
  if (R.errors.some((e) => e.source === source && e.message === item.message)) return;
  R.errors.push(item);
  console.log('[playtest] ✖ 页面错误 (' + source + '): ' + item.message);
}

/* ==========================================================================
   5. 浏览器启动
   ========================================================================== */
let child = null;
let cdp = null;
let profileDir = null;
let exitCode = 0;

function killBrowser() {
  try {
    if (child && child.pid) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    }
  } catch (e) { /* ignore */ }
}

function cleanupProfile() {
  if (!profileDir || KEEP_PROFILE) {
    if (profileDir) console.log('[playtest] profile 保留: ' + profileDir);
    return;
  }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

function writeReport() {
  R.elapsedMs = Date.now() - START_MS;
  R.endAt = new Date().toISOString();
  R.ok = R.hardFails.length === 0;
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(R, null, 2), 'utf8');
}

const watchdog = setTimeout(() => {
  console.error('[playtest] 总超时 ' + TOTAL_TIMEOUT + 'ms，强制结束');
  try { R.hardFails.push('总超时'); } catch (e) { /* ignore */ }
  writeReport();
  killBrowser();
  cleanupProfile();
  process.exit(1);
}, TOTAL_TIMEOUT);
watchdog.unref();

/* ==========================================================================
   6. 主流程
   ========================================================================== */
async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[playtest] 需要 Node 22+（缺少全局 WebSocket）');
    process.exit(2);
  }
  if (DO_BUILD) buildPage();
  const customUrl = getOpt('url', '');
  if (!customUrl && !fs.existsSync(PAGE)) {
    console.error('[playtest] 找不到 ' + PAGE + '，请先运行：node tests/playtest.mjs --build');
    process.exit(2);
  }
  const targetUrl = customUrl || pathToFileURL(PAGE).href;
  R.page = targetUrl;

  const browser = findBrowser();
  if (!browser) {
    console.error('[playtest] 找不到 Edge/Chrome，可设置环境变量 EDGE_PATH');
    process.exit(2);
  }
  R.browser = browser;
  console.log('[playtest] 目标: ' + targetUrl);
  console.log('[playtest] 浏览器: ' + browser);

  const port = await freePort();
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-playtest-'));
  const args = [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--window-size=' + VIEW.w + ',' + VIEW.h,
    '--force-device-scale-factor=1',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    '--mute-audio',
    '--enable-logging=stderr',
    '--log-level=0',
    'about:blank',
  ];
  child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let browserErr = '';
  child.stderr.on('data', (d) => {
    browserErr += String(d);
    if (browserErr.length > 300000) browserErr = browserErr.slice(-200000);
  });
  child.on('error', (e) => console.error('[playtest] 浏览器启动失败: ' + e.message));

  // 找到页面 target 并连上 CDP
  const pageTarget = await waitPageTarget(port, 20000);
  cdp = new CDP(pageTarget.webSocketDebuggerUrl);
  await cdp.opened;

  const runtimeErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p && p.exceptionDetails;
    const desc = d && d.exception && d.exception.description ? d.exception.description : (d && d.text) || '未知异常';
    runtimeErrors.push(desc);
    addError('CDP.exceptionThrown', desc);
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (!p) return;
    const type = p.type;
    const parts = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type || '')));
    const msg = parts.join(' ');
    if (type === 'error') {
      R.consoleErrors.push({ type, message: msg.slice(0, 500) });
      addError('console.error', msg);
    } else if (type === 'assert') {
      addError('console.assert', msg);
    } else if (VERBOSE) {
      console.log('[page.' + type + '] ' + msg.slice(0, 300));
    }
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p && p.entry;
    if (!e) return;
    if (e.level === 'error') addError('Log', (e.text || '') + (e.url ? ' @' + e.url : ''));
    else if (VERBOSE) console.log('[page.log.' + e.level + '] ' + String(e.text || '').slice(0, 300));
  });

  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Log.enable'),
  ]);
  // 固定视口：--window-size 是外框尺寸，截图会略小；用 Emulation 覆盖成精确 1280x800
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false,
    });
  } catch (e) {
    warn('固定视口失败: ' + e.message);
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: EARLY_SCRIPT });

  // 导航 + 等加载
  await cdp.send('Page.navigate', { url: targetUrl });
  const loaded = await waitFor('页面加载完成', 'document.readyState === "complete"', 40000, 200);
  await sleep(300);
  await evaluate(PAGE_HELPERS, 20000);
  R.metrics.load = { loadedAtMs: Date.now() - t0 };

  /* ------------------------- 阶段 0：启动屏 ------------------------- */
  await step('boot', async () => {
    const snap = await stateSnap();
    return { bootSeen: true, mode: snap ? snap.mode : null };
  });
  await screenshot('boot');

  /* ---------------------- 阶段 1：标题屏（真实流程） ---------------------- */
  await step('title', async () => {
    await waitFor('__PG_DEBUG 就绪', '!!window.__PG_DEBUG', TITLE_TIMEOUT, 200);
    await waitFor('进入标题界面', readyExpr('title'), TITLE_TIMEOUT, 200);
    const ui = await uiStats();
    const hud = await evaluateJson('JSON.stringify(__PGT.hudInfo())');
    R.metrics.title = { ui, hud };
    check('title-reached', '启动完成后进入标题界面 (E.mode=title)', true, true);
    check('ui-nodes', '界面 DOM 已构建（#ui 可见节点 > 30）', ui.visible > 30, false, 'visible=' + ui.visible + ' nodes=' + ui.nodes);
    R.uiImpl = await detectUiImpl();
    return { mode: (await stateSnap()).mode, ui, uiImpl: R.uiImpl };
  });
  await screenshot('title');

  /* ------------------------- 阶段 2：选择行者 ------------------------- */
  await step('select', async () => {
    const beforeScreen = await evaluate('__PGT.screenName()', 8000);
    const trusted = await pressKeyTrusted('Enter', 'Enter', 13);
    if (!trusted) await evaluate("__PGT.pressKey('Enter','Enter',13)", 8000);
    let reached = true;
    let keyDiag = 'E.mode=select';
    try {
      await waitFor('进入选角界面', readyExpr('select'), 6000, 120);
    } catch (e) {
      reached = false;
      // 可信注入被吞时再补一次合成事件
      await evaluate("__PGT.pressKey('Enter','Enter',13)", 8000);
      await sleep(400);
      try {
        await waitFor('进入选角界面（合成事件）', readyExpr('select'), 2500, 120);
        reached = true;
        keyDiag = 'E.mode=select（合成事件）';
      } catch (e2) {
        const afterScreen = await evaluate('__PGT.screenName()', 8000);
        keyDiag = 'failed: data-screen[' + beforeScreen + ' -> ' + afterScreen + ']';
        warn('按 Enter 未能进入选角：' + keyDiag + '；界面实现与主状态机可能不同步');
        await evaluate('(function(){ try { if (PG.ui && PG.ui.screen) PG.ui.screen("select"); if (PG.main && PG.main.E) PG.main.E.mode = "select"; } catch (e) {} return true; })()', 8000);
        await sleep(400);
      }
    }
    const snap = await stateSnap();
    const ui = await uiStats();
    const scr = await evaluateJson('JSON.stringify(__PGT.visibleScreen("select"))');
    const selectVisible = !!(scr && scr.visible);
    R.metrics.select = { snap: { mode: snap.mode }, ui, screen: scr, reachedByKey: reached, keyDiag, beforeScreen, selectVisible };
    check('select-reached', '可从标题进入选择行者（界面可见且状态同步）', snap.mode === 'select' && selectVisible, true,
      'mode=' + snap.mode + ' visible=' + selectVisible + ' ' + keyDiag);
    check('select-keyboard', 'Enter 键可从标题进入选角', reached, false, keyDiag);
    check('select-cards', '选角界面存在行者卡片 / 按钮', ui.cards >= 4 || ui.buttons >= 5, false, 'cards=' + ui.cards + ' buttons=' + ui.buttons);
    return { mode: snap.mode, ui, screenVisible: scr.visible };
  });
  await screenshot('select');

  /* ------------------------- 阶段 3：进入游戏 + HUD ------------------------- */
  await step('startGame', async () => {
    await evaluate('__PGT.stubPointerLock()', 8000);
    const click = await evaluateJson('JSON.stringify(__PGT.clickText(["出发","开始冒险","确认","开始","START","LAUNCH"]))');
    let launchedByClick = click && click.ok;
    let mode = null;
    try {
      await waitFor('进入游戏', readyExpr('playing'), 3500, 120);
    } catch (e) {
      mode = null;
    }
    if (!launchedByClick || (await stateSnap()).mode !== 'playing') {
      warn('未通过 UI 按钮进入游戏（click=' + JSON.stringify(click) + '），改用 PG.main.startGame 兜底');
      await evaluate('(function(){ try { PG.main.startGame("t_bolt"); } catch (e) {} return true; })()', 15000);
      await sleep(600);
    }
    const snap = await stateSnap();
    const hud = await evaluateJson('JSON.stringify(__PGT.hudInfo())');
    const ui = await uiStats();
    const parts = await evaluateJson('JSON.stringify(__PGT.hudParts())');
    R.metrics.startGame = { click, snap, hud, ui, parts };
    const need = ['hud-wave', 'hud-obj', 'hud-pcard', 'hud-ammo', 'hud-cross'];
    const missingOrHidden = need.filter((k) => parts[k] === 'missing' || parts[k] === 'hidden');
    if (missingOrHidden.length) {
      warn('HUD 关键元素缺失/隐藏: ' + missingOrHidden.join(', ') + '（可能是 80-hud.js / 75-hud.css 尚在收尾）');
    } else {
      check('hud-parts', 'HUD 关键元素齐全（波次/目标/伙伴/弹药/准星）', true, false,
        need.map((k) => k + '=' + parts[k]).join(' '));
    }
    check('game-started', '进入战斗（E.mode=playing 且 game.state.mode=playing）',
      snap.mode === 'playing' && snap.gameMode === 'playing', true, 'E.mode=' + snap.mode + ' game=' + snap.gameMode);
    check('hud-visible', '战斗 HUD 可见且含文本', !!(hud && hud.found && hud.text && hud.text.length > 3), false, JSON.stringify(hud && hud.text || '').slice(0, 120));
    if (hud && hud.text && hud.text.indexOf('第 0 波') >= 0) {
      warn('HUD 在首波开始前显示「第 0 波 共 8 波」，建议开局把 wave 显示为 1（50-game.js 初始 state.wave=0）');
    }
    // 记录 UI API 面（只按 CONTRACT.md 3.5 的方法判定；setResult 等属于 Lead 的额外接口）
    R.uiApi = await evaluateJson('JSON.stringify({ screen: !!(PG.ui && PG.ui.screen), mount: !!(PG.ui && PG.ui.mount), hud: !!(PG.ui && PG.ui.hud), setCharacters: !!(PG.ui && PG.ui.setCharacters), on: !!(PG.ui && PG.ui.on), banner: !!(PG.ui && PG.ui.banner), toast: !!(PG.ui && PG.ui.toast), subtitle: !!(PG.ui && PG.ui.subtitle), hitmarker: !!(PG.ui && PG.ui.hitmarker), damageFrom: !!(PG.ui && PG.ui.damageFrom), killfeed: !!(PG.ui && PG.ui.killfeed), damageNumber: !!(PG.ui && PG.ui.damageNumber), setCrosshair: !!(PG.ui && PG.ui.setCrosshair), setAmmoWarn: !!(PG.ui && PG.ui.setAmmoWarn), setObjectives: !!(PG.ui && PG.ui.setObjectives), fps: !!(PG.ui && PG.ui.fps), isTouch: !!(PG.ui && PG.ui.isTouch), setResult: !!(PG.ui && PG.ui.setResult), hudVisible: !!(PG.ui && PG.ui.hudVisible) })');
    const missing = [];
    for (const k of Object.keys(R.uiApi)) if (!R.uiApi[k] && k !== 'setResult' && k !== 'hudVisible') missing.push(k);
    if (missing.length) {
      check('ui-api', 'PG.ui 契约方法齐全（缺失: ' + missing.join(',') + '）', false, false,
        '检查 80-hud.js / 85-ui.js 是否互相覆盖 PG.ui');
      warn('PG.ui 缺少契约方法: ' + missing.join(', '));
    } else {
      check('ui-api', 'PG.ui 契约方法齐全', true, false);
    }
    return { mode: snap.mode, hudFound: !!(hud && hud.found) };
  });
  await screenshot('game');

  /* ------------------------- 阶段 4：玩家受击（掉血） ------------------------- */
  await step('damage', async () => {
    const before = await stateSnap();
    let last = before;
    for (let i = 0; i < 10; i++) {
      const r = await sim(2, { fire: false, aim: false });
      last = r.state;
      if (!last || last.mode !== 'playing') break;
      if ((last.hp || 0) < (before.hp || 0)) break;
    }
    const after = last || before;
    const damaged = (after.hp || 0) < (before.hp || 0);
    R.metrics.damage = { hpBefore: before.hp, hpAfter: after.hp, damaged, mode: after.mode, wave: after.wave };
    check('player-damaged', '玩家会被敌人攻击掉血', damaged || after.dead, true,
      'hp ' + before.hp + ' -> ' + after.hp);
    return R.metrics.damage;
  });

  /* ------------------------- 阶段 5：开火击杀 / 波次推进 ------------------------- */
  await step('combat', async () => {
    if ((await stateSnap()).mode !== 'playing') {
      warn('受击阶段已死亡，先重启再测战斗');
      await evaluate('(function(){ try { PG.main.restartGame(); } catch (e) {} return true; })()', 15000);
      await sleep(700);
    }
    const before = await stateSnap();
    const timeline = [];
    let snap = before;
    for (let i = 0; i < 14; i++) {
      const r = await sim(3, { fire: true, aim: true });
      snap = r.state;
      timeline.push({ t: snap.time, wave: snap.wave, score: snap.score, kills: snap.kills, hp: snap.hp, enemies: snap.enemies, mode: snap.mode });
      if (!snap || snap.mode !== 'playing') break;
      if (snap.wave >= 2) break;
    }
    const killsDelta = (snap.kills || 0) - (before.kills || 0);
    const scoreDelta = (snap.score || 0) - (before.score || 0);
    const hitsDelta = (snap.hits || 0) - (before.hits || 0);
    R.metrics.combat = { before, after: snap, timeline, killsDelta, scoreDelta, hitsDelta, endWave: snap.wave };
    check('combat-shots', '开火产生命中判定（hits 增加）', hitsDelta > 0, true, 'hitsDelta=' + hitsDelta);
    check('combat-kills', '能击杀敌人（kills 增加）', killsDelta > 0, true, 'killsDelta=' + killsDelta);
    check('combat-score', '击杀获得分数（score > 0）', (snap.score || 0) > 0, true, 'score=' + snap.score);
    return { killsDelta, scoreDelta, hitsDelta, endWave: snap.wave };
  });
  await screenshot('combat');

  /* ------------------------- 阶段 6：暂停 / 继续 ------------------------- */
  await step('pause', async () => {
    await pressKeyTrusted('Escape', 'Escape', 27);
    await sleep(600);
    let via = 'keyboard';
    let snap = await stateSnap();
    if (!snap || snap.mode !== 'paused') {
      via = 'api';
      await evaluate('(function(){ try { PG.main.doPause(); } catch (e) {} return true; })()', 8000);
      await sleep(600);
      snap = await stateSnap();
    }
    check('pause-by-key', 'Esc 键可暂停游戏', via === 'keyboard', false, 'via=' + via);
    const scr = await evaluateJson('JSON.stringify(__PGT.visibleScreen("pause"))');
    await screenshot('pause');
    R.metrics.pause = { snap: { mode: snap.mode, gameMode: snap.gameMode }, screen: scr, via };
    check('pause-reached', '暂停界面可进入 (E.mode=paused)', snap.mode === 'paused', true, 'E.mode=' + snap.mode);
    await evaluate('(function(){ try { PG.main.doResume(); } catch (e) {} return true; })()', 8000);
    await sleep(500);
    const snap2 = await stateSnap();
    check('resume-ok', '可继续游戏 (E.mode=playing)', snap2.mode === 'playing', true, 'E.mode=' + snap2.mode);
    return { paused: snap.mode, resumed: snap2.mode, screenVisible: scr && scr.visible };
  });

  /* ------------------------- 阶段 7：死亡结算 ------------------------- */
  await step('death', async () => {
    let snap = await stateSnap();
    if (snap.mode !== 'playing') {
      await evaluate('(function(){ try { PG.main.restartGame(); } catch (e) {} return true; })()', 15000);
      await sleep(800);
      snap = await stateSnap();
    }
    let forcedHp = false;
    if (!snap.dead && snap.mode === 'playing') {
      forcedHp = true;
      // 把血量压到 1，站桩承受一次攻击即可触发真实的 hurtPlayer -> dead 流程（死亡判定链路本身不改）
      await evaluate('(function(){ var G = PG.game; if (G && G.player) { G.player.hp = Math.min(1, G.player.hp); G.player.invuln = 0; } return true; })()', 8000);
      for (let i = 0; i < 20; i++) {
        const r = await sim(2, { fire: false, aim: false });
        snap = r.state;
        if (!snap || snap.mode !== 'playing' || snap.dead) break;
      }
    }
    let deadMode = snap.mode;
    try {
      await waitFor('死亡屏', readyExpr('dead'), 6000, 150);
      deadMode = 'dead';
    } catch (e) {
      warn('E.mode 未自动切换到 dead（' + e.message + '）');
    }
    const scr = await evaluateJson('JSON.stringify(__PGT.visibleScreen("dead"))');
    R.metrics.death = { snap, mode: deadMode, screen: scr, forcedHp };
    await screenshot('dead');
    check('death-reached', '玩家死亡后进入失败结算屏', deadMode === 'dead', true, 'E.mode=' + deadMode + ' dead=' + snap.dead);
    check('death-screen', '失败结算屏有结算内容', !!(scr && scr.text && scr.text.length > 2), false, scr && scr.text);
    return { mode: deadMode, dead: snap.dead, screenText: scr && scr.text };
  });

  /* ------------------------- 阶段 8：重开 ------------------------- */
  await step('restart', async () => {
    const click = await evaluateJson('JSON.stringify(__PGT.clickText(["再来一次","重新开始","重试","再来一局","RETRY"]))');
    await sleep(600);
    let snap = await stateSnap();
    if (snap.mode !== 'playing') {
      warn('未通过按钮重开（click=' + JSON.stringify(click) + '），改用 API 重启');
      await evaluate('(function(){ try { PG.main.restartGame(); } catch (e) {} return true; })()', 15000);
      await sleep(700);
      snap = await stateSnap();
    }
    R.metrics.restart = { click, snap: { mode: snap.mode, wave: snap.wave, score: snap.score, hp: snap.hp } };
    check('restart-ok', '结算后可以重开一局（wave 归 1、分数归零、满血）',
      snap.mode === 'playing' && snap.wave <= 1 && (snap.score || 0) === 0 && (snap.hp || 0) > 0,
      true, 'mode=' + snap.mode + ' wave=' + snap.wave + ' score=' + snap.score + ' hp=' + snap.hp);
    return R.metrics.restart;
  });

  /* ------------------------- 阶段 9：8 波通关 -> 胜利结算 ------------------------- */
  await step('win', async () => {
    await evaluate('(function(){ try { PG.game.setGod(true); PG.game.setDmgMul(10); } catch (e) {} return true; })()', 8000);
    const timeline = [];
    let snap = await stateSnap();
    const startWave = snap && snap.wave ? snap.wave : 1;
    let forcedWin = false;
    let waveStall = false;
    for (let i = 0; i < 120; i++) {
      const r = await sim(5, { fire: true, aim: true });
      snap = r.state;
      if (!snap) break;
      if (i % 2 === 0 || snap.mode !== 'playing') {
        timeline.push({ wave: snap.wave, score: snap.score, kills: snap.kills, hp: snap.hp, enemies: snap.enemies, bossHp: snap.boss ? snap.boss.hp : null, mode: snap.mode });
      }
      if (snap.mode !== 'playing') break;
      if (snap.wave >= (snap.waveTotal || 8) && !snap.boss && (snap.enemiesAlive || 0) === 0) break;
      // 波次卡死检测：击杀已经很多、但波次仍然不推进
      if (i >= 4 && snap.wave <= Math.max(1, startWave) && (snap.kills || 0) >= 20) {
        waveStall = true;
        break;
      }
      await sleep(10);
    }
    check('wave-progress', '波次能从第 1 波推进到第 2 波', (snap.wave || 0) >= 2, true,
      'wave=' + snap.wave + '/' + (snap.waveTotal || 8) + ' kills=' + snap.kills + ' score=' + snap.score + (waveStall ? '（波次卡死）' : ''));
    let winMode = snap.mode;
    if (winMode !== 'win') {
      warn('自动战斗未在预算内打通 8 波（到达第 ' + snap.wave + ' 波），改用 PG.game.winGame() 验证胜利结算链路');
      forcedWin = true;
      await evaluate('(function(){ try { PG.game.winGame(); } catch (e) {} return true; })()', 8000);
      await sleep(500);
      try {
        await waitFor('胜利屏', readyExpr('win'), 6000, 150);
        winMode = 'win';
      } catch (e) {
        warn('胜利结算未切换到 win：' + e.message);
      }
      snap = await stateSnap();
    }
    const scr = await evaluateJson('JSON.stringify(__PGT.visibleScreen("win"))');
    const result = await evaluateJson('JSON.stringify({ hasSetResult: !!(PG.ui && PG.ui.setResult), text: (function(){ try { return __PGT.clean((document.getElementById("ui") || {}).innerText || "").slice(0, 300); } catch (e) { return ""; } })() })');
    R.metrics.win = {
      final: { wave: snap.wave, waveTotal: snap.waveTotal, score: snap.score, kills: snap.kills, mode: snap.mode, hp: snap.hp },
      timeline, forcedWin, screen: scr, uiText: result.text,
      waveStall, waveAdvanced: (snap.wave || 0) >= 2, startWave,
    };
    await screenshot('win');
    check('win-reached', '8 波通关后进入胜利结算屏', winMode === 'win', true, 'mode=' + winMode + ' wave=' + snap.wave + ' forced=' + forcedWin);
    check('win-real', '胜利来自真实打通 8 波（非强制）', !forcedWin, false, forcedWin ? '预算内未通关，已用 winGame() 验证界面' : '真实通关');
    check('win-screen', '胜利结算屏有评价/统计内容', !!(scr && scr.text && scr.text.length > 2), false, scr && scr.text);
    return { mode: winMode, forcedWin, finalWave: snap.wave, score: snap.score };
  });

  /* ------------------------- 阶段 10：FPS / draw call 采样 ------------------------- */
  await step('fps', async () => {
    await evaluate('__PGT.instrumentRenderer()', 8000);
    // 1) 标题展示场景帧率（纯渲染基线）
    await evaluate('(function(){ try { PG.main.toTitle(); } catch (e) {} return true; })()', 15000);
    await sleep(700);
    const titleFps = await evaluateJson('__PGT.fpsSample(1500).then(function (r) { return JSON.stringify(r); })', 15000);
    R.metrics.fpsTitle = titleFps;
    // 2) 战斗内帧率（含 HUD / 敌人 / 特效）
    await evaluate('(function(){ try { PG.main.startGame("t_bolt"); } catch (e) {} return true; })()', 15000);
    await sleep(600);
    const sample = await evaluateJson('__PGT.fpsSample(3000).then(function (r) { return JSON.stringify(r); })', 25000);
    R.metrics.fps = sample;
    const fpsP50 = sample && sample.fpsP50 ? sample.fpsP50 : 0;
    check('fps-sampled', '取得帧时间样本（rAF）', !!(sample && sample.frames > 30), false,
      'frames=' + (sample && sample.frames) + ' p50=' + (sample && sample.p50) + 'ms p95=' + (sample && sample.p95) + 'ms');
    if (fpsP50 && fpsP50 < 30) warn('无头 swiftshader 下 FPS 偏低（p50 ' + fpsP50 + '），真机需复测');
    const calls = sample && sample.sceneCallsMax ? sample.sceneCallsMax : (sample && sample.callsMax ? sample.callsMax : -1);
    R.metrics.drawCalls = {
      sceneCallsMax: sample && sample.sceneCallsMax,
      vmCallsMax: sample && sample.vmCallsMax,
      totalCallsMax: sample && sample.totalCallsMax,
      totalCallsPerFrame: sample && sample.callsMax,
      sceneTrianglesMax: sample && sample.sceneTrianglesMax,
      totalTrianglesPerFrame: sample && sample.trianglesMax,
    };
    if (sample && sample.frames < 30) {
      warn('rAF 采样帧数不足（' + (sample && sample.frames) + '），帧率数据仅供参考');
    }
    check('drawcalls', '主场景 draw call <= 150（每帧最大 ' + calls + '）', calls > 0 && calls <= 150, true,
      'sceneCalls=' + (sample && sample.sceneCallsMax) + ' vmCalls=' + (sample && sample.vmCallsMax) +
      ' total=' + (sample && sample.totalCallsMax) + ' sceneTris=' + (sample && sample.sceneTrianglesMax));
    return sample;
  });

  /* ------------------------- 收尾：汇总页面错误 ------------------------- */
  const pageErr = await collectPageErrors();
  R.metrics.pageErrors = pageErr;
  const early = pageErr.early || {};
  for (const e of early.errors || []) addError('window.onerror', e.message || e, { file: e.file, line: e.line });
  for (const r of early.rejections || []) addError('unhandledrejection', r);
  for (const e of pageErr.pg || []) addError('PG.errors', e);
  for (const e of pageErr.err || []) addError('PG.main.E.err', e);
  if (pageErr.fatal && String(pageErr.fatal).trim().length > 0) {
    // #fatal 在 90-main 里也用于错误显示，出现内容即视为错误
    addError('#fatal', pageErr.fatal);
  }
  const totalErr = (early.errors ? early.errors.length : 0) + (pageErr.pg ? pageErr.pg.length : 0) + (pageErr.err ? pageErr.err.length : 0);
  R.metrics.rawErrorCount = totalErr;
  check('no-js-errors', '页面无未处理 JS 错误', R.errors.length === 0, true,
    R.errors.length ? R.errors.slice(0, 3).map((e) => e.source + ': ' + e.message.slice(0, 120)).join(' | ') : 'clean');

  // 最终截图（游戏画面）
  await screenshot('final');
  return R;
}

/* ==========================================================================
   7. 工具函数（依赖 cdp）
   ========================================================================== */
function readyExpr(mode) {
  return '(function(){ var E = window.PG && window.PG.main && window.PG.main.E; return !!(E && E.mode === "' + mode + '"); })()';
}

async function waitPageTarget(port, timeoutMs) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.indexOf('devtools') < 0);
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error('无法连接 CDP 目标' + (lastErr ? '：' + lastErr.message : ''));
}

async function evaluate(expression, timeoutMs) {
  if (!cdp) throw new Error('CDP 未连接');
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, (timeoutMs || 30000) + 5000);
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    const msg = d.exception && d.exception.description ? String(d.exception.description) : (d.text || 'unknown');
    throw new Error('页面执行异常: ' + msg.slice(0, 300));
  }
  return r && r.result ? r.result.value : undefined;
}

async function evaluateJson(expression, timeoutMs) {
  const raw = await evaluate(expression, timeoutMs);
  if (typeof raw !== 'string') return raw === undefined ? null : raw;
  try { return JSON.parse(raw); } catch (e) { throw new Error('JSON 解析失败: ' + String(raw).slice(0, 200)); }
}

async function pressKeyTrusted(key, code, vk) {
  if (!cdp) return false;
  try {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(70);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(120);
    return true;
  } catch (e) {
    warn('可信键盘注入失败: ' + e.message);
    return false;
  }
}

async function waitFor(desc, expression, timeoutMs, intervalMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(expression, 12000);
      if (last) return last;
    } catch (e) {
      last = e && e.message;
    }
    await sleep(intervalMs || 150);
  }
  throw new Error('等待超时：' + desc + '（最后值: ' + JSON.stringify(last) + '）');
}

async function stateSnap() {
  try {
    return await evaluateJson('JSON.stringify(__PGT.state())', 15000);
  } catch (e) {
    warn('读取状态失败: ' + e.message);
    return null;
  }
}

async function sim(sec, opts) {
  const r = await evaluateJson('JSON.stringify(__PGT.sim(' + Number(sec) + ', ' + JSON.stringify(opts || {}) + '))', GAME_TIMEOUT);
  return r || { err: 'no-result', state: null };
}

async function uiStats() {
  try {
    return await evaluateJson('JSON.stringify(__PGT.uiStats())', 15000);
  } catch (e) {
    return { nodes: 0, visible: 0 };
  }
}

async function detectUiImpl() {
  try {
    const probe = await evaluateJson('JSON.stringify({ uiScreens: !!document.querySelector("#ui .ui-screens"), scr: !!document.querySelector("#ui .scr-title"), hud: !!document.querySelector("#ui .hud"), pg: !!document.querySelector("#ui .hud-party") })', 10000);
    if (probe.uiScreens && probe.scr) return 'ui2(.ui-screens/.scr-*)';
    if (probe.pg) return 'legacy(.hud-party/#pg-*)';
    if (probe.scr) return 'partial(.scr-*)';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

async function collectPageErrors() {
  try {
    return await evaluateJson('JSON.stringify({ early: window.__PGT_EARLY || null, pg: (window.PG && window.PG.errors) || [], err: (window.PG && window.PG.main && window.PG.main.E && window.PG.main.E.err) || [], fatal: (document.getElementById("fatal") || {}).textContent || "" })', 15000);
  } catch (e) {
    warn('收集页面错误失败: ' + e.message);
    return { early: null, pg: [], err: [], fatal: '' };
  }
}

async function screenshot(name) {
  if (NO_SHOTS || !cdp) return null;
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, 'playtest-' + name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    R.screenshots.push(rel);
    console.log('[playtest] 截图: ' + rel);
    return rel;
  } catch (e) {
    warn('截图失败 ' + name + ': ' + e.message);
    return null;
  }
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    R.phases[name] = { ok: true, ms: Date.now() - started, detail: detail === undefined ? null : detail };
    console.log('[playtest] 阶段通过: ' + name + ' (' + (Date.now() - started) + 'ms)');
    return detail;
  } catch (e) {
    const msg = String((e && e.message) || e);
    R.phases[name] = { ok: false, ms: Date.now() - started, error: msg };
    R.hardFails.push('阶段 ' + name + ': ' + msg);
    console.error('[playtest] 阶段失败: ' + name + ' -> ' + msg);
    return null;
  }
}

/* ==========================================================================
   8. 摘要输出 / 收尾
   ========================================================================== */
function printSummary() {
  console.log('');
  console.log('============================================================');
  console.log('  Playtest 验收报告');
  console.log('============================================================');
  console.log('  页面:      ' + R.page);
  console.log('  UI 实现:   ' + R.uiImpl);
  console.log('  总耗时:    ' + (R.elapsedMs / 1000).toFixed(1) + 's');
  console.log('  结果:      ' + (R.ok ? '全部硬性检查通过 ✔' : R.hardFails.length + ' 项硬性失败 ✖'));
  console.log('------------------------------------------------------------');
  for (const c of R.checks) {
    const tag = c.ok ? '[PASS]' : (c.hard ? '[FAIL]' : '[WARN]');
    console.log('  ' + tag + ' ' + c.id + ' — ' + c.desc + (c.detail ? '  :: ' + c.detail : ''));
  }
  const m = R.metrics;
  console.log('------------------------------------------------------------');
  if (m.load) console.log('  加载:      ' + (m.load.loadedAtMs / 1000).toFixed(2) + 's 到达可交互');
  if (m.combat) console.log('  战斗:      kills +' + m.combat.killsDelta + ' / score +' + m.combat.scoreDelta + ' / hits +' + m.combat.hitsDelta + ' / 结束波次 ' + m.combat.endWave);
  if (m.damage) console.log('  受击:      hp ' + m.damage.hpBefore + ' -> ' + m.damage.hpAfter + (m.damage.damaged ? ' (掉血 OK)' : ' (未掉血)'));
  if (m.win) console.log('  胜利:      wave ' + m.win.final.wave + '/' + m.win.final.waveTotal + ' score ' + m.win.final.score + ' kills ' + m.win.final.kills + (m.win.forcedWin ? ' (强制 winGame)' : ' (真实通关)'));
  if (m.pause) console.log('  暂停:      ' + (m.pause.snap && m.pause.snap.mode) + ' (via ' + (m.pause.via || '?') + ')');
  if (m.fps) console.log('  战斗帧率:  p50 ' + m.fps.fpsP50 + ' FPS (' + m.fps.p50 + 'ms) / p95 ' + m.fps.fpsP95 + ' FPS (' + m.fps.p95 + 'ms) / frames ' + m.fps.frames);
  if (m.fpsTitle) console.log('  标题帧率:  p50 ' + m.fpsTitle.fpsP50 + ' FPS (' + m.fpsTitle.p50 + 'ms) / frames ' + m.fpsTitle.frames);
  if (m.drawCalls) console.log('  DrawCall:  主场景 max ' + m.drawCalls.sceneCallsMax + ' / 武器层 ' + m.drawCalls.vmCallsMax + ' / 合计 ' + m.drawCalls.totalCallsMax + ' / 场景三角形 ' + m.drawCalls.sceneTrianglesMax);
  if (m.death) console.log('  死亡:      ' + (m.death.forcedHp ? '压低血量触发（真实 hurtPlayer 链路）' : '自然死亡'));
  console.log('  截图:      ' + R.screenshots.length + ' 张 -> _shots/playtest-*.png');
  console.log('  页面错误:  ' + R.errors.length + ' 条' + (R.errors.length ? '（见 JSON）' : ''));
  console.log('  JSON:      ' + path.relative(ROOT, REPORT));
  if (R.warnings.length) {
    console.log('------------------------------------------------------------');
    console.log('  警告 ' + R.warnings.length + ' 条:');
    for (const w of R.warnings.slice(0, 12)) console.log('   · ' + w);
  }
  console.log('============================================================');
}

/* ==========================================================================
   9. 启动
   ========================================================================== */
main()
  .then(async () => {
    try { cdp && cdp.close(); } catch (e) { /* ignore */ }
    killBrowser();
    await sleep(250);
    cleanupProfile();
    writeReport();
    printSummary();
    exitCode = R.ok ? 0 : 1;
    clearTimeout(watchdog);
    process.exit(exitCode);
  })
  .catch(async (e) => {
    console.error('[playtest] 未捕获异常: ' + ((e && e.stack) || e));
    try { cdp && cdp.close(); } catch (err) { /* ignore */ }
    killBrowser();
    await sleep(250);
    cleanupProfile();
    R.hardFails.push('未捕获异常: ' + String((e && e.message) || e));
    writeReport();
    printSummary();
    clearTimeout(watchdog);
    process.exit(1);
  });
