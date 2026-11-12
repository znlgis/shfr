#!/usr/bin/env node
/* tests/toy-mobile.mjs — 竖屏手机回归（B站 Toy 的主要容器是 App WebView）
   ---------------------------------------------------------------------------
   桌面 playtest 覆盖不到的三件事，这里用 CDP 设备模拟各验一遍：
     1. 竖屏触摸设备上，一次性横屏提示会出现，并在几秒后自动消失（不常驻、不挡操作）
     2. 触屏 HUD 会挂载摇杆与开火/装填/冲刺/跳跃/灵兽技按钮，且不越出可视区
     3. WebGL 不可用时显示可读的 #unsupported 说明卡，而不是一屏红色报错

   用法：node tests/toy-mobile.mjs [--url=<页面>] [--keep]
   --------------------------------------------------------------------------- */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const URL_ARG = (argv.find((a) => a.startsWith('--url=')) || '').slice(6);
const PAGE = URL_ARG
  ? (URL_ARG.startsWith('http') || URL_ARG.startsWith('file:') ? URL_ARG : pathToFileURL(path.resolve(ROOT, URL_ARG)).href)
  : pathToFileURL(path.join(ROOT, 'dist', 'toy', 'index.html')).href;
const VIEW = { w: 390, h: 844 };

if (!fs.existsSync(fileURLToPath(new URL(PAGE)))) {
  console.error('[toy-mobile] 找不到页面：' + PAGE + '\n先跑：node build.mjs --toy');
  process.exit(2);
}

const results = [];
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok: !!ok, hard: true, detail: detail || '' });
  return !!ok;
}
function skip(id, desc, detail) {
  results.push({ id, desc, ok: true, hard: false, skipped: true, detail: detail || '' });
}

function findBrowser() {
  const cands = [process.env.EDGE_PATH, process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
const BROWSER = findBrowser();
if (!BROWSER) { console.error('[toy-mobile] 找不到 Edge / Chrome，可设置 EDGE_PATH'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => this.onMessage(ev));
  }
  onMessage(ev) {
    let msg = null;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
      return;
    }
    const list = this.listeners.get(msg.method);
    if (list) for (const fn of list) { try { fn(msg.params); } catch (e) {} }
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); }, wait);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

async function waitTarget(port, timeout) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {}
    await sleep(150);
  }
  throw new Error('等待浏览器调试端口超时');
}

async function evaluate(cdp, expr, timeout) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  }, timeout || 20000);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || '页面求值异常');
  }
  return r.result ? r.result.value : undefined;
}

const SHOT_DIR = path.join(ROOT, '_shots');
async function shot(cdp, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    const file = path.join(SHOT_DIR, 'toy-mobile-' + name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('[toy-mobile] 截图: ' + path.relative(ROOT, file));
  } catch (e) {
    console.log('[toy-mobile] 截图失败（' + name + '）: ' + e.message);
  }
}

async function waitFor(cdp, expr, timeout, label) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    let v = false;
    try { v = await evaluate(cdp, expr, 8000); } catch (e) {}
    if (v) return true;
    await sleep(150);
  }
  throw new Error('等待超时：' + label);
}

async function main() {
  const port = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'toy-mobile-'));
  const child = spawn(BROWSER, [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=' + VIEW.w + ',' + VIEW.h,
    '--force-device-scale-factor=1',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    '--mute-audio',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

  let cdp = null;
  try {
    const target = await waitTarget(port, 25000);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    const consoleErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p && p.exceptionDetails;
      consoleErrors.push('exception: ' + ((d && d.exception && d.exception.description) || (d && d.text) || '?'));
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p && p.type === 'error') {
        consoleErrors.push('console.error: ' + (p.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type || '')).join(' ').slice(0, 300));
      }
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p && p.entry && p.entry.level === 'error') consoleErrors.push('log: ' + String(p.entry.text || '').slice(0, 300));
    });

    // 竖屏触摸设备
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.w, height: VIEW.h, deviceScaleFactor: 3, mobile: true,
      screenWidth: VIEW.w, screenHeight: VIEW.h,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    await cdp.send('Page.navigate', { url: PAGE });
    await waitFor(cdp, "document.readyState === 'complete'", 20000, '页面加载');
    await waitFor(cdp, "!!(window.PG && window.PG.main && window.PG.main.E)", 25000, '游戏初始化');

    const env = await evaluate(cdp, "JSON.stringify({coarse: matchMedia('(pointer: coarse)').matches, touch: 'ontouchstart' in window, maxTouch: navigator.maxTouchPoints, w: innerWidth, h: innerHeight})").then(JSON.parse);
    const touchy = env.coarse || env.touch || env.maxTouch > 0;

    // ---- 1. 竖屏横屏提示 ----
    if (touchy) {
      const shown = await waitFor(cdp, "document.getElementById('rotate-tip') && document.getElementById('rotate-tip').classList.contains('on')", 8000, '横屏提示出现').then(() => true).catch(() => false);
      const opacity = await evaluate(cdp, "getComputedStyle(document.getElementById('rotate-tip')).opacity");
      check('rotate-tip-shown', '竖屏触摸设备上出现横屏提示', shown, 'class.on=' + shown + ', opacity=' + opacity);
      const blocking = await evaluate(cdp, "(function(){var t=document.getElementById('rotate-tip');var cs=getComputedStyle(t);return {pe: cs.pointerEvents, z: cs.zIndex};})()");
      check('rotate-tip-nonblocking', '横屏提示不接收指针事件（不挡操作）', blocking.pe === 'none', 'pointer-events=' + blocking.pe);
      await sleep(8200);
      const gone = await evaluate(cdp, "!document.getElementById('rotate-tip').classList.contains('on')");
      check('rotate-tip-autodismiss', '横屏提示会自动消失（不做常驻引导）', gone);
      await cdp.send('Page.reload', { ignoreCache: true });
      await waitFor(cdp, "document.readyState === 'complete'", 20000, '重载（截图竖屏标题）');
      await waitFor(cdp, "document.getElementById('rotate-tip').classList.contains('on')", 8000, '横屏提示').catch(() => {});
      await shot(cdp, 'portrait-title');
    } else {
      skip('rotate-tip-shown', '竖屏触摸设备上出现横屏提示', '当前模拟未触发 coarse pointer，跳过触屏断言');
    }

    // ---- 2. 触屏 HUD ----
    await evaluate(cdp, "window.__PG_DEBUG && window.__PG_DEBUG.select('t_bolt')");
    await waitFor(cdp, "document.querySelectorAll('.hud-tbtn').length >= 5", 12000, '触屏按钮挂载').catch(() => {});
    const hud = await evaluate(cdp, `(function(){
      var btns = document.querySelectorAll('.hud-tbtn');
      var wrap = document.querySelector('.hud-tbtns');
      var fire = document.querySelector('.hud-tbtn.t-fire');
      var r = wrap ? wrap.getBoundingClientRect() : null;
      var fr = fire ? fire.getBoundingClientRect() : null;
      return {
        count: btns.length,
        labels: Array.prototype.map.call(btns, function(b){ return b.textContent.trim(); }),
        inView: r ? (r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.top >= -1) : false,
        fireSize: fr ? Math.round(Math.min(fr.width, fr.height)) : 0,
        rect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null
      };
    })()`).then((s) => (typeof s === 'string' ? JSON.parse(s) : s));
    check('touch-hud-buttons', '触屏挂了 5 个战斗按钮（开火/装填/冲刺/跳跃/灵兽技）', hud.count === 5, 'count=' + hud.count + ' labels=' + (hud.labels || []).join('/'));
    check('touch-hud-in-view', '触屏按钮区在当前视口内（不被安全区挤出去）', hud.inView, 'rect=' + JSON.stringify(hud.rect));
    check('touch-fire-target', '开火按钮足够大（≥ 44px，便于点按）', hud.fireSize >= 44, hud.fireSize + 'px');
    await shot(cdp, 'portrait-hud');

    // ---- 3. WebGL 不可用兜底 ----
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "(function(){var g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t){if(String(t).indexOf('webgl')>=0)return null;return g.apply(this,arguments);};})();",
    }).then((r) => { cdp._nocgl = r.identifier; });
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, "document.readyState === 'complete'", 20000, '重载（无 WebGL）');
    await sleep(1200);
    const fallback = await evaluate(cdp, `(function(){
      var u = document.getElementById('unsupported');
      var f = document.getElementById('fatal');
      return JSON.stringify({
        unsupported: !!u && getComputedStyle(u).display !== 'none',
        text: u ? (u.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
        fatalShown: !!f && getComputedStyle(f).display !== 'none',
        fatalText: f ? (f.textContent || '').slice(0, 80) : ''
      });
    })()`).then(JSON.parse);
    check('webgl-fallback', 'WebGL 不可用时显示可读的兜底说明', fallback.unsupported, fallback.text);
    check('webgl-fallback-no-stack', '兜底时不再弹出红色报错框', !fallback.fatalShown, fallback.fatalText);
    await shot(cdp, 'no-webgl');

    check('no-js-errors', '页面没有未处理的 JS 错误 / console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    try { if (cdp) cdp.ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    if (!argv.includes('--keep')) {
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

await main();

console.log('');
console.log('竖屏 / 触屏回归  ' + PAGE);
console.log('--------------------------------------------------------------');
for (const r of results) {
  const tag = r.skipped ? '  SKIP  ' : (r.ok ? '  PASS  ' : '  FAIL  ');
  console.log(tag + r.desc + (r.detail ? '  :: ' + r.detail : ''));
}
const failed = results.filter((r) => !r.ok && r.hard);
console.log('--------------------------------------------------------------');
console.log(failed.length ? '  ' + failed.length + ' 项未通过' : '  全部通过');
process.exit(failed.length ? 1 : 0);
