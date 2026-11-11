#!/usr/bin/env node
// 构建：把 three.js + 各模块 + CSS 拼成单文件 HTML
//   node build.mjs              -> dist/山海森之突袭_V1.html（单文件交付物，可直接双击游玩）
//   node build.mjs --dev        -> dev.html（<script src> 版，改完刷新即见）
//   node build.mjs --dev --out=tests/x.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
const outArg = argv.find((a) => a.startsWith('--out='));
const outFile = outArg
  ? path.join(root, outArg.slice(6))
  : (dev ? path.join(root, 'dev.html') : path.join(root, 'dist', '山海森之突袭_V1.html'));

const JS_ORDER = ['10-audio.js', '20-world.js', '30-models.js', '32-beasts.js', '35-art.js', '40-util.js', '50-game.js', '80-hud.js', '85-ui.js', '90-main.js'];
// hud 样式必须最后加载：全屏界面 CSS 里若残留 .hud 规则，也不该压过 HUD 自己的样式
const CSS_FILES = ['70-ui.css', '75-hud.css'];

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const template = read('src/index.html');
const threeSrc = read('vendor/three.min.js');

let css = '';
for (const f of CSS_FILES) {
  const p = path.join(root, 'src', f);
  if (fs.existsSync(p)) css += '\n/* ==== ' + f + ' ==== */\n' + read('src/' + f);
}

let body;
if (dev) {
  body = '<script src="vendor/three.min.js"></script>\n' +
    JS_ORDER.map((f) => {
      const p = path.join(root, 'src', f);
      return fs.existsSync(p) ? '<script src="src/' + f + '"></script>' : '';
    }).filter(Boolean).join('\n');
} else {
  let js = '';
  for (const f of JS_ORDER) {
    const p = path.join(root, 'src', f);
    if (!fs.existsSync(p)) continue;
    const src = read('src/' + f);
    // 防止源码里出现 </script> 提前闭合
    js += '\n/* ==================== ' + f + ' ==================== */\n' + src.replace(/<\/script/gi, '<\\/script');
  }
  // three.min.js 里同样可能有 </script> 片段
  const threeSafe = threeSrc.replace(/<\/script/gi, '<\\/script');
  body = '<script>\n' + threeSafe + '\n</script>\n<script>\n' + js + '\n</script>';
}

// 注意：必须用函数式替换。three.min.js 压缩代码里含 "$&" 这类序列，
// 若直接作为替换字符串会被 String.replace 当作特殊模式改写（会破坏 three.js 源码）。
let html = template
  .replace('<!--CSS-->', () => '<style>' + css + '\n</style>')
  .replace('<!--BODY-->', () => body)
  .replace(/__TITLE__/g, () => '山海森之突袭');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html, 'utf8');
const kb = (html.length / 1024).toFixed(0);
console.log('built ' + path.relative(root, outFile) + '  ' + kb + ' KB  (' + (dev ? 'dev' : 'single-file') + ')');