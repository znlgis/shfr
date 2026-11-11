#!/usr/bin/env node
/**
 * tests/shot.mjs — 通用「无头 Edge 截图」工具（QA / Lead / 各模块作者复用）
 *
 * 用法：
 *   node tests/shot.mjs <url-or-input.html> [out.png] [w] [h] [waitMs] [--flags]
 *
 * 示例：
 *   node tests/shot.mjs dev.html
 *   node tests/shot.mjs dev.html _shots/home.png 1600 900 9000
 *   node tests/shot.mjs "file:///D:/self/ai-work/dsh-work/poke3d/tests/audio.html?auto=1" _shots/audio.png
 *   node tests/shot.mjs "https://example.com" out.png 1280 800 5000 --json
 *
 * 参数：
 *   <url-or-input.html>  http(s):// 或 file:/// URL；也接受本地文件路径（相对当前目录或相对 poke3d 根目录）
 *   [out.png]            输出 PNG 路径；缺省 _shots/<页面名>.png（绝对路径会打印出来）
 *   [w] [h]              视口宽高，缺省 1280 x 800
 *   [waitMs]             虚拟时间预算，缺省 8000（给页面加载 / 异步自检留时间）
 *   --json               除人类可读输出外，再打印一行 SHOT_RESULT={...} 方便程序解析
 *   --keep-profile       保留临时浏览器 profile 目录（默认截图后删除）
 *   --verbose            打印 Edge 的 stderr（默认只在失败/页面报错时摘录）
 *   --no-autoplay        不添加 --autoplay-policy=no-user-gesture-required（默认添加，方便音频页面自测）
 *
 * 退出码：0 成功；1 截图失败（页面打不开 / 浏览器缺失 / 输出为空）；2 参数用法错误。
 *
 * 说明：
 *   - 浏览器路径优先取环境变量 EDGE_PATH / CHROME_PATH，其次自动探测 Edge、Chrome 常见安装位置。
 *   - 每次运行使用独立的临时 user-data-dir，多个截图任务可并发而不会抢同一个 profile。
 *   - 会把页面控制台错误（CONSOLE / Uncaught）从 stderr 里摘出来，作为 [page] 警告输出；这对发现白屏/JS 报错很有用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// poke3d 工程根（本文件位于 <root>/tests/shot.mjs）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  '用法: node tests/shot.mjs <url-or-input.html> [out.png] [w] [h] [waitMs] [--json] [--verbose] [--keep-profile] [--no-autoplay]',
  '示例: node tests/shot.mjs dev.html _shots/home.png 1280 800 8000',
].join('\n');

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const flags = new Set();
const positional = [];
for (const a of rawArgs) {
  if (a.startsWith('--')) flags.add(a.slice(2).toLowerCase());
  else positional.push(a);
}
const wantJson = flags.has('json');
const verbose = flags.has('verbose');
const keepProfile = flags.has('keep-profile');
const autoplay = !flags.has('no-autoplay');

function die(code, msg) {
  console.error('[shot] 错误: ' + msg);
  if (code === 2) console.error(USAGE);
  process.exit(code);
}

const input = positional[0];
if (!input) die(2, '缺少输入页面（URL 或本地 HTML 路径）');

// 宽/高/等待时间：宽松解析，非法值给默认并提示
function numAt(idx, fallback, min, max) {
  const v = positional[idx];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn('[shot] 参数 ' + idx + ' = "' + v + '" 非法，使用默认值 ' + fallback);
    return fallback;
  }
  return Math.round(n);
}
const WIDTH = numAt(2, 1280, 200, 7680);
const HEIGHT = numAt(3, 800, 200, 4320);
const WAIT_MS = numAt(4, 8000, 100, 120000);

// ---------------------------------------------------------------------------
// 输入 -> URL
// ---------------------------------------------------------------------------
function resolveTarget(arg) {
  // 已是 URL：只接受 http(s) / file
  if (/^(https?|file):\/\//i.test(arg)) {
    if (/^file:\/\//i.test(arg)) {
      let url;
      try {
        url = new URL(arg);
      } catch {
        die(1, 'file:// URL 格式不对: ' + arg);
      }
      const p = fileURLToPath(url);
      if (!fs.existsSync(p)) die(1, '文件不存在: ' + p);
      return { url: arg, label: 'file' };
    }
    return { url: arg, label: 'url' };
  }
  // 本地路径：绝对路径 / 当前目录相对 / poke3d 根目录相对
  const candidates = [
    path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg),
    path.resolve(ROOT, arg),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      if (fs.statSync(p).isDirectory()) die(1, '输入是目录，需要 HTML 文件: ' + p);
      return { url: pathToFileURL(p).href, label: 'file', file: p };
    }
  }
  const tried = [...new Set(candidates)];
  die(1, '找不到输入页面: ' + arg + '\n        已尝试: ' + tried.join('\n                '));
}

const target = resolveTarget(input);

// ---------------------------------------------------------------------------
// 输出路径
// ---------------------------------------------------------------------------
function sanitize(s) {
  return String(s)
    .replace(/[?#].*$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'shot';
}
function defaultOutName() {
  let base = 'page';
  if (target.file) base = path.basename(target.file, path.extname(target.file));
  else {
    try {
      const u = new URL(target.url);
      const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
      base = sanitize(last.replace(/\.[a-z0-9]+$/i, ''));
    } catch { base = 'page'; }
  }
  // 带 query 的页面（例如 ?auto=1）把 query 也带进文件名，避免互相覆盖
  try {
    const u = new URL(target.url);
    if (u.search) base += '-' + sanitize(u.search.replace(/^\?/, '').replace(/&/g, '-'));
  } catch { /* ignore */ }
  return path.join(ROOT, '_shots', base + '.png');
}

let outPath = positional[1] ? path.resolve(process.cwd(), positional[1]) : defaultOutName();
// 允许传相对 poke3d 根的路径（当 cwd 不在 poke3d 时）
if (positional[1] && !path.isAbsolute(positional[1]) && !fs.existsSync(path.dirname(outPath))) {
  const alt = path.resolve(ROOT, positional[1]);
  if (fs.existsSync(path.dirname(alt))) outPath = alt;
}
outPath = path.resolve(outPath);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ---------------------------------------------------------------------------
// 找浏览器
// ---------------------------------------------------------------------------
function findBrowser() {
  const envPaths = [process.env.EDGE_PATH, process.env.CHROME_PATH].filter(Boolean);
  const candidates = [
    ...envPaths,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // 非 Windows / 开发机常见的 Edge/Chrome
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}
const browser = findBrowser();
if (!browser) {
  die(1, '找不到 Edge/Chrome。可设置环境变量 EDGE_PATH 指向 msedge.exe。\n' +
    '        Windows 默认路径: C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
}

// ---------------------------------------------------------------------------
// 运行 headless 浏览器
// ---------------------------------------------------------------------------
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-shot-'));
const timeoutMs = WAIT_MS + 90000;

// Chromium 需要 --screenshot 的绝对路径；Node 的 path.resolve 在 Windows 上就是 Win 路径
const args = [
  '--headless=new',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--disable-extensions',
  '--disable-component-update',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-features=Translate,MediaRouter',
  '--enable-logging=stderr',
  '--log-level=0',
  '--window-size=' + WIDTH + ',' + HEIGHT,
  '--virtual-time-budget=' + WAIT_MS,
  '--user-data-dir=' + profileDir,
  '--screenshot=' + outPath,
];
if (autoplay) args.push('--autoplay-policy=no-user-gesture-required');
args.push('--run-all-compositor-stages-before-draw');
args.push(target.url);

const t0 = Date.now();
const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stderr = '';
let stdout = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => {
  stderr += d;
  if (stderr.length > 400000) stderr = stderr.slice(-300000);
});

let settled = false;
const killer = setTimeout(() => {
  if (!settled) {
    settled = true;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    cleanup();
    console.error('[shot] 超时：浏览器 ' + timeoutMs + 'ms 内未退出');
    process.exit(1);
  }
}, timeoutMs);

function cleanup() {
  clearTimeout(killer);
  if (keepProfile) {
    console.log('[shot] profile 保留: ' + profileDir);
    return;
  }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function pageConsoleLines(text) {
  // 从 Chromium 的 stderr 里挑出页面控制台/未捕获异常
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/ERROR:CONSOLE|CONSOLE\(\d+\)|Uncaught|Unhandled|FATAL:/.test(line)) out.push(line.trim());
  }
  return out;
}

child.on('error', (err) => {
  if (settled) return;
  settled = true;
  cleanup();
  die(1, '启动浏览器失败: ' + err.message);
});

child.on('close', async (code, signal) => {
  if (settled) return;
  settled = true;
  cleanup();

  const elapsed = Date.now() - t0;
  const consoleLines = pageConsoleLines(stderr);
  const exists = fs.existsSync(outPath);
  const size = exists ? fs.statSync(outPath).size : 0;

  if (consoleLines.length) {
    const uniq = [...new Set(consoleLines)].slice(0, 12);
    console.warn('[shot] 页面控制台警告 ' + uniq.length + ' 条:');
    for (const l of uniq) console.warn('        ' + l.slice(0, 400));
  }
  if (verbose) {
    console.log('----- browser stderr -----');
    console.log(stderr.slice(-12000));
    console.log('----- browser stdout -----');
    console.log(stdout.slice(-4000));
  }

  if (code !== 0 && (!exists || size === 0)) {
    console.error('[shot] 截图失败 (exit=' + code + ', signal=' + (signal || '-') + ')');
    const tail = stderr.trim().split(/\r?\n/).slice(-15).join('\n');
    if (tail) console.error('----- stderr 尾部 -----\n' + tail);
    process.exit(1);
  }
  if (!exists || size === 0) {
    console.error('[shot] 输出文件为空: ' + outPath);
    process.exit(1);
  }

  const result = {
    ok: true,
    png: outPath,
    width: WIDTH,
    height: HEIGHT,
    waitMs: WAIT_MS,
    bytes: size,
    elapsedMs: elapsed,
    consoleWarnings: [...new Set(consoleLines)].length,
    browser,
  };
  console.log('✔ 截图成功: ' + outPath);
  console.log('  ' + WIDTH + 'x' + HEIGHT + ' · ' + (size / 1024).toFixed(1) + ' KB · 耗时 ' + (elapsed / 1000).toFixed(2) + 's · 页面警告 ' + result.consoleWarnings + ' 条');
  if (wantJson) console.log('SHOT_RESULT=' + JSON.stringify(result));
  process.exit(0);
});
