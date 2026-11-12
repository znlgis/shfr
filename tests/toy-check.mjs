#!/usr/bin/env node
/* tests/toy-check.mjs — B站 Toy 发布包自检
   ---------------------------------------------------------------------------
   对着 Toy 发布 FAQ 里跟「上传后被拒 / 白屏 / 打不开」直接相关的硬规则逐条检查：
     1. 包根目录必须有 index.html（不能是 dist/toy/index.html 这种多一层）
     2. 入口 index.html 不超过 1MB（平台限制，超了会被截断/拒收）
     3. 整包不超过 50MB
     4. 文件后缀必须在平台白名单内（可执行文件 / 后端脚本会被直接过滤）
     5. 资源用相对路径（/assets/x.js 会解析到站点根，结果就是白屏 / 404）
     6. 不引用站外资源、不内嵌 iframe
     7. 没有自由输入框 / 可编辑区域（UGC 是内容安全红线）
     8. index.html 的 title 与 viewport 齐全

   用法：
     node tests/toy-check.mjs                # 检查 dist/toy（目录，默认就够）
     node tests/toy-check.mjs --zip          # 额外校验 dist/toy.zip 的包根
     node tests/toy-check.mjs --dir=build/x  # 检查指定目录
   --------------------------------------------------------------------------- */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dirArg = (argv.find((a) => a.startsWith('--dir=')) || '').slice(6);
const TARGET = dirArg ? path.resolve(ROOT, dirArg) : path.join(ROOT, 'dist', 'toy');
const CHECK_ZIP = argv.includes('--zip') || !dirArg;

const ENTRY_MAX = 1000 * 1000;          // 平台：入口 index.html 1MB
const TOTAL_MAX = 50 * 1024 * 1024;     // 平台：整包 50MB
const ALLOWED = new Set([
  '.html', '.htm', '.css', '.js', '.json', '.md', '.csv', '.tsv', '.wasm', '.data',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.woff2', '.woff', '.ttf', '.eot',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm',
]);
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.json', '.svg']);

const results = [];
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok: !!ok, detail: detail || '' });
  return !!ok;
}

function walk(dir, prefix, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, rel, out);
    else out.push({ name: rel, bytes: st.size, full });
  }
  return out;
}

if (!fs.existsSync(TARGET)) {
  console.error('[toy-check] 找不到 ' + path.relative(ROOT, TARGET) + '，先跑：node build.mjs --toy');
  process.exit(2);
}

const files = walk(TARGET, '', []);
const byName = new Map(files.map((f) => [f.name, f]));
const entry = byName.get('index.html');
const total = files.reduce((n, f) => n + f.bytes, 0);

check('entry-exists', '包根目录存在 index.html', !!entry, entry ? '' : '文件清单：' + files.map((f) => f.name).join(', '));
check('entry-size', 'index.html ≤ 1MB', !!entry && entry.bytes <= ENTRY_MAX, entry ? entry.bytes + ' B' : '');
check('total-size', '整包 ≤ 50MB', total <= TOTAL_MAX, (total / 1024 / 1024).toFixed(2) + ' MB');

const badExt = files.filter((f) => !ALLOWED.has(path.extname(f.name).toLowerCase()));
check('ext-whitelist', '所有文件后缀都在平台白名单内', badExt.length === 0, badExt.map((f) => f.name).join(', '));

// 读取文本文件做静态扫描
const texts = new Map();
for (const f of files) {
  if (TEXT_EXT.has(path.extname(f.name).toLowerCase())) {
    texts.set(f.name, fs.readFileSync(f.full, 'utf8'));
  }
}

const html = texts.get('index.html') || '';

// 5. 相对路径：src/href/url() 以 / 开头就是站根绝对路径
const absRefs = [];
for (const [name, text] of texts) {
  const re = /(?:src|href)\s*=\s*["'](\/[^"']*)["']|url\(\s*["']?(\/[^"')]+)/g;
  let m;
  while ((m = re.exec(text))) absRefs.push(name + ' -> ' + (m[1] || m[2]));
}
check('relative-paths', '资源引用都是相对路径（没有 /assets/... 这种站根路径）', absRefs.length === 0, absRefs.slice(0, 5).join(' | '));

// 6. 站外资源 / iframe
const extRefs = [];
for (const [name, text] of texts) {
  const re = /(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']|<iframe\b/gi;
  let m;
  while ((m = re.exec(text))) extRefs.push(name + ' -> ' + m[0].slice(0, 80));
}
check('no-external-refs', '没有站外资源引用 / 内嵌 iframe', extRefs.length === 0, extRefs.slice(0, 5).join(' | '));

// 7. UGC 输入（内容安全红线）
const inputs = /<input\b|<textarea\b|contenteditable\s*=\s*["']?true/i.test(html);
check('no-ugc-input', '页面没有自由输入框 / 可编辑区域', !inputs, inputs ? '命中 <input>/<textarea>/contenteditable' : '');

// 8. 基础元信息
const hasTitle = /<title>[^<]*\S[^<]*<\/title>/i.test(html);
const hasViewport = /name=["']viewport["']/i.test(html);
check('meta-title', 'index.html 有非空 <title>', hasTitle);
check('meta-viewport', 'index.html 有 viewport meta（移动端适配）', hasViewport);

// 4b. 引用落地：html 里 ./assets/x 必须真的在包里
const missing = [];
const refRe = /(?:src|href)\s*=\s*["'](\.\/[^"'?#]+)(?:[?#][^"']*)?["']/g;
let rm;
while ((rm = refRe.exec(html))) {
  const rel = rm[1].replace(/^\.\//, '');
  if (!byName.has(rel)) missing.push(rel);
}
check('refs-resolve', 'index.html 引用的资源都在包里', missing.length === 0, missing.join(', '));

// 9. zip 校验：包根同样必须是 index.html
if (CHECK_ZIP) {
  const zipFile = TARGET.replace(/[\\/]+$/, '') + '.zip';
  if (!fs.existsSync(zipFile)) {
    check('zip-exists', '已生成 ' + path.basename(zipFile), false, '先跑 node build.mjs --toy');
  } else {
    const buf = fs.readFileSync(zipFile);
    const names = readZipNames(buf);
    check('zip-exists', '已生成 ' + path.basename(zipFile), true, (buf.length / 1024).toFixed(0) + ' KB');
    check('zip-root-entry', 'zip 根目录就是 index.html（没有多一层目录）',
      names.includes('index.html') && !names.some((n) => n.split('/').length > 1 && n.endsWith('/index.html') && !names.includes('index.html')));
    const zipBad = names.filter((n) => !n.endsWith('/') && !ALLOWED.has(path.extname(n).toLowerCase()));
    check('zip-ext-whitelist', 'zip 内文件后缀都在白名单内', zipBad.length === 0, zipBad.slice(0, 5).join(', '));
    check('zip-dir-match', 'zip 内容与目录产物一致', names.length === files.length, names.length + ' vs ' + files.length);
  }
}

function readZipNames(buf) {
  // 从结尾找 EOCD，再顺着中央目录读 UTF-8 文件名
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('Toy 发布包自检  ' + path.relative(ROOT, TARGET) + '  (' + files.length + ' files, ' + (total / 1024).toFixed(0) + ' KB)');
console.log('--------------------------------------------------------------');
for (const r of results) {
  console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.desc + (r.detail ? '  :: ' + r.detail : ''));
}
console.log('--------------------------------------------------------------');
console.log(failed.length ? '  ' + failed.length + ' 项未通过' : '  全部通过');
process.exit(failed.length ? 1 : 0);
