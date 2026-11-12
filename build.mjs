#!/usr/bin/env node
// 构建：把 three.js + 各模块 + CSS 打包成可分发的产物
//   node build.mjs              -> dist/山海森之突袭_V1.html（单文件交付物，可直接双击游玩）
//   node build.mjs --dir        -> dist/web/（目录版：index.html + assets/ 外链资源，可静态托管 / 硬链接部署）
//   node build.mjs --toy        -> dist/toy/ + dist/toy.zip（B站 Toy 发布包：根目录直接是 index.html）
//   node build.mjs --all        -> 同时生成「单文件 + 目录版 + Toy 发布包」三套产物
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
const toyMode = argv.includes('--toy');
const allMode = argv.includes('--all');
const optVal = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

if (dev && (dirMode || toyMode || allMode)) {
  console.error('[build] 用法错误：--dev 只用于单文件调试产物，不能和 --dir / --toy / --all 同时使用');
  process.exit(2);
}

const SINGLE_FILE = path.join(root, 'dist', '山海森之突袭_V1.html');
const DIR_OUT = path.join(root, 'dist', 'web');
const TOY_OUT = path.join(root, 'dist', 'toy');
const singleOut = optVal('out')
  ? path.join(root, optVal('out'))
  : (dev ? path.join(root, 'dev.html') : SINGLE_FILE);
const dirOut = optVal('out-dir') ? path.join(root, optVal('out-dir')) : DIR_OUT;
const toyOut = optVal('toy-out') ? path.join(root, optVal('toy-out')) : TOY_OUT;

// 一次运行要产出哪些产物
const modes = allMode ? ['single', 'dir', 'toy'] : (toyMode ? ['toy'] : (dirMode ? ['dir'] : ['single']));

const JS_ORDER = ['10-audio.js', '20-world.js', '30-models.js', '32-beasts.js', '35-art.js', '40-util.js', '50-game.js', '80-hud.js', '85-ui.js', '90-main.js'];
// hud 样式必须最后加载：全屏界面 CSS 里若残留 .hud 规则，也不该压过 HUD 自己的样式
const CSS_FILES = ['70-ui.css', '75-hud.css'];

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const kb = (n) => (n / 1024).toFixed(0);
const template = read('src/index.html');

// three.js r160 的 UMD 构建第一句是 deprecation console.warn，字符串里带 threejs.org 外链。
// 内联进页面后每次加载都会在控制台冒一条警告：审核侧容易误判成脚本异常，Toy 包里也不该夹带外链。
// 换成等价的空表达式，只去掉这句警告，后面的 MIT 许可头与主体代码原样保留。
const threeRaw = read('vendor/three.min.js');
const threeSrc = threeRaw.replace(/^\uFEFF?console\.warn\('Scripts[^']*'\),/, '0,');
if (threeSrc === threeRaw) console.warn('[build] 提示：未匹配到 three.js 的 deprecation 警告，按原样内联');

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
function buildDir(outDir, label) {
  const assets = path.join(outDir, 'assets');
  fs.mkdirSync(assets, { recursive: true });

  const css = buildCss();
  let js = buildJs(false);
  // 标题页右下角的版本标签在源码里写死为「单文件离线版」，目录版 / Toy 包各换各的口径。
  // 只影响这两套产物，不改动源码与单文件产物。
  const LABEL_FROM = 'v1.0 · 单文件离线版';
  const LABEL_TO = label ? 'v1.0 · ' + label : 'v1.0';
  if (js.includes(LABEL_FROM)) js = js.replace(LABEL_FROM, LABEL_TO);
  else console.warn('[build] 提示：未找到版本标签 "' + LABEL_FROM + '"，沿用源码文案');

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

// ---------------------------------------------------------------------------
// Toy 发布包：B站 Toy 只收「zip 根目录直接是 index.html」的静态包，
// 入口 index.html 限 1MB、整包限 50MB，且只发布白名单后缀（.html/.css/.js/.png…）的文件。
// 单文件版把 three.js 和全部代码都内联了，约 1.2MB，不能当 Toy 入口，所以这里以目录版为底再打 zip。
// Node 没有内置 zip，写一个不压缩（store）的最小实现，避免给构建脚本引入依赖。
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(entries, outFile) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // 文件名按 UTF-8 解释
    local.writeUInt16LE(0, 8);           // 0 = 不压缩（store）
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);             // extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // disk
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(outFile, Buffer.concat([...parts, cdBuf, eocd]));
}

function buildToy(outDir) {
  // 先按目录版产出（index.html + assets/），再把包根当成 zip 根打包
  buildDir(outDir, null);

  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else entries.push({ name: rel, data: fs.readFileSync(full) });
    }
  };
  walk(outDir, '');

  const zipFile = outDir.replace(/[\\/]+$/, '') + '.zip';
  zipStore(entries, zipFile);

  const entry = entries.find((e) => e.name === 'index.html');
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  const problems = [];
  if (!entry) problems.push('包根目录缺少 index.html');
  else if (entry.data.length > 1000000) problems.push('index.html ' + entry.data.length + ' B，超过平台 1MB 入口上限');
  if (total > 50 * 1024 * 1024) problems.push('整包 ' + kb(total) + ' KB，超过平台 50MB 上限');

  console.log('built ' + path.relative(root, zipFile) + '  ' + kb(total) + ' KB  (toy, ' + entries.length + ' files)');
  if (problems.length) {
    for (const p of problems) console.error('[build] 失败：' + p);
    process.exitCode = 1;
    return;
  }
  console.log('  上传 ' + path.relative(root, zipFile) + ' 即可（root 必须是 index.html）');
}

if (modes.includes('single')) buildSingle(singleOut);
if (modes.includes('dir')) buildDir(dirOut, '目录版');
if (modes.includes('toy')) buildToy(toyOut);
