#!/usr/bin/env node
// 构建：把 three.js + 各模块 + CSS 打包成可分发的产物
//   node build.mjs              -> dist/山海森之突袭_V1.html（单文件交付物，可直接双击游玩）
//   node build.mjs --dir        -> dist/web/（目录版：index.html + assets/ 外链资源，可静态托管 / 硬链接部署）
//   node build.mjs --all        -> 同时生成「单文件 + 目录版」两套产物
//   node build.mjs --dev        -> dev.html（<script src> 版，改完刷新即见）
//   node build.mjs --dev --out=tests/x.html
//   node build.mjs --dir --out-dir=build/site
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
const dirMode = argv.includes('--dir');
const allMode = argv.includes('--all');
const optVal = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

if (dev && (dirMode || allMode)) {
  console.error('[build] 用法错误：--dev 只用于单文件调试产物，不能和 --dir / --all 同时使用');
  process.exit(2);
}

const SINGLE_FILE = path.join(root, 'dist', '山海森之突袭_V1.html');
const DIR_OUT = path.join(root, 'dist', 'web');
const singleOut = optVal('out')
  ? path.join(root, optVal('out'))
  : (dev ? path.join(root, 'dev.html') : SINGLE_FILE);
const dirOut = optVal('out-dir') ? path.join(root, optVal('out-dir')) : DIR_OUT;

// 一次运行要产出哪些产物
const modes = allMode ? ['single', 'dir'] : (dirMode ? ['dir'] : ['single']);

const JS_ORDER = ['10-audio.js', '20-world.js', '30-models.js', '32-beasts.js', '35-art.js', '40-util.js', '50-game.js', '80-hud.js', '85-ui.js', '90-main.js'];
// hud 样式必须最后加载：全屏界面 CSS 里若残留 .hud 规则，也不该压过 HUD 自己的样式
const CSS_FILES = ['70-ui.css', '75-hud.css'];

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const kb = (n) => (n / 1024).toFixed(0);
const template = read('src/index.html');
const threeSrc = read('vendor/three.min.js');

// 拼接所有 CSS（两种产物共用同一份内容）
function buildCss() {
  let css = '';
  for (const f of CSS_FILES) {
    const p = path.join(root, 'src', f);
    if (fs.existsSync(p)) css += '\n/* ==== ' + f + ' ==== */\n' + read('src/' + f);
  }
  return css;
}

// 拼接所有 JS。单文件模式要转义 </script；目录版写成独立文件，保持源码原样。
function buildJs(escapeScript) {
  let js = '';
  for (const f of JS_ORDER) {
    const p = path.join(root, 'src', f);
    if (!fs.existsSync(p)) continue;
    const src = read('src/' + f);
    js += '\n/* ==================== ' + f + ' ==================== */\n' +
      (escapeScript ? src.replace(/<\/script/gi, '<\\/script') : src);
  }
  return js;
}

function title(t) {
  return t.replace(/__TITLE__/g, () => '山海森之突袭');
}

// ---------------------------------------------------------------------------
// 单文件产物（保持原有行为与字节完全一致）
// ---------------------------------------------------------------------------
function buildSingle(outFile) {
  const css = buildCss();
  let body;
  if (dev) {
    body = '<script src="vendor/three.min.js"></script>\n' +
      JS_ORDER.map((f) => {
        const p = path.join(root, 'src', f);
        return fs.existsSync(p) ? '<script src="src/' + f + '"></script>' : '';
      }).filter(Boolean).join('\n');
  } else {
    // 注意：必须用函数式替换。three.min.js 压缩代码里含 "$&" 这类序列，
    // 若直接作为替换字符串会被 String.replace 当作特殊模式改写（会破坏 three.js 源码）。
    const threeSafe = threeSrc.replace(/<\/script/gi, '<\\/script');
    body = '<script>\n' + threeSafe + '\n</script>\n<script>\n' + buildJs(true) + '\n</script>';
  }

  let html = template
    .replace('<!--CSS-->', () => '<style>' + css + '\n</style>')
    .replace('<!--BODY-->', () => body);
  html = title(html);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html, 'utf8');
  console.log('built ' + path.relative(root, outFile) + '  ' + kb(html.length) + ' KB  (' + (dev ? 'dev' : 'single-file') + ')');
}

// ---------------------------------------------------------------------------
// 目录版产物：dist/web/{index.html, assets/{three.min.js, app.css, app.js}}
// 普通静态站点结构，相对路径引用，可直接 file:// 双击，也可以丢进任意静态服务器。
// ---------------------------------------------------------------------------
function buildDir(outDir) {
  const assets = path.join(outDir, 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const css = buildCss();
  let js = buildJs(false);
  // 标题页右下角版本标签在单文件里写死为「单文件离线版」，目录版里换成「目录版」，
  // 只影响目录版产物，不改动源码与单文件产物。
  const LABEL_FROM = 'v1.0 · 单文件离线版';
  const LABEL_TO = 'v1.0 · 目录版';
  if (js.includes(LABEL_FROM)) js = js.replace(LABEL_FROM, LABEL_TO);
  else console.warn('[build] 提示：未找到版本标签 "' + LABEL_FROM + '"，目录版沿用源码文案');

  fs.writeFileSync(path.join(assets, 'three.min.js'), threeSrc, 'utf8');
  fs.writeFileSync(path.join(assets, 'app.css'), css, 'utf8');
  fs.writeFileSync(path.join(assets, 'app.js'), js, 'utf8');

  let html = template
    .replace('<!--CSS-->', () => '<link rel="stylesheet" href="./assets/app.css">')
    .replace('<!--BODY-->', () => '<script src="./assets/three.min.js"></script>\n<script src="./assets/app.js"></script>');
  html = title(html);

  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

  const files = [
    ['index.html', Buffer.byteLength(html)],
    ['assets/three.min.js', Buffer.byteLength(threeSrc)],
    ['assets/app.css', Buffer.byteLength(css)],
    ['assets/app.js', Buffer.byteLength(js)],
  ];
  const total = files.reduce((n, f) => n + f[1], 0);
  console.log('built ' + path.relative(root, outDir) + '/  ' + kb(total) + ' KB  (dir, ' + files.length + ' files)');
  for (const [name, bytes] of files) console.log('  ' + name.padEnd(22, ' ') + String(kb(bytes)).padStart(5, ' ') + ' KB');
}

if (modes.includes('single')) buildSingle(singleOut);
if (modes.includes('dir')) buildDir(dirOut);
