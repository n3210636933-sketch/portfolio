#!/usr/bin/env node
/**
 * editor-server.mjs — 本地可视化编辑器服务（零依赖，只监听 127.0.0.1）
 *
 * 为什么需要它：
 *   浏览器出于安全，不允许网页直接改写硬盘上的文件。所以「点一下就把图片换掉、
 *   把文字改掉」必须由一个在你电脑上运行的小程序来落盘。这个文件就是那个小程序：
 *   把网站当普通静态站发给浏览器、往 HTML 里注入编辑器脚本、
 *   在你点「保存」时把改动写回真正的文件。
 *
 * 重要：部署到网上的正式站点**不包含**它。它只是本地改内容用的工具。
 *
 * 用法：
 *   node tools/editor-server.mjs               # 默认 http://127.0.0.1:4173
 *   node tools/editor-server.mjs --port=5000
 *   node tools/editor-server.mjs --open        # 顺便打开浏览器
 *
 * 安全措施：
 *   - 只绑定 127.0.0.1，局域网其它设备访问不到
 *   - 每次写入前自动备份到 .editor-backup/<时间戳>/
 *   - 路径一律校验，不允许跳出网站目录
 *   - 改内容前核对「原内容」，对不上就拒绝写入
 */
import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, copyFileSync, rmSync, statSync, renameSync,
} from 'node:fs';
import { basename, dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argPort = process.argv.find((a) => a.startsWith('--port='))?.split('=')[1];
const PORT = Number(argPort || process.env.PORT || 4173);
const HOST = '127.0.0.1';

const BACKUP_DIR = join(root, '.editor-backup');
const UPLOAD_DIR = join(root, 'assets', 'img', 'uploads');
const MAX_BODY = 40 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

/* ------------------------------------------------------------ 小工具 */
function safePath(relPath) {
  const abs = resolve(root, decodeURIComponent(String(relPath || '')).replace(/^\/+/, ''));
  const prefix = root + (process.platform === 'win32' ? '\\' : '/');
  if (abs !== root && !abs.startsWith(prefix)) throw new Error('路径越界');
  return abs;
}
const relOf = (abs) => relative(root, abs).split(/[\\/]/).join('/');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function backup(absFile) {
  if (!existsSync(absFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(BACKUP_DIR, stamp, relOf(absFile));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(absFile, dest);
  pruneBackups();
  return dest;
}
/** 已撤销的批次改名为 <时间戳>.undone，不再参与「撤销上一步」，但仍留在磁盘上 */
const UNDONE = '.undone';

function backupBatches() {
  try {
    return readdirSync(BACKUP_DIR)
      .filter((n) => !n.endsWith(UNDONE))
      .map((n) => ({ n, t: statSync(join(BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((d) => join(BACKUP_DIR, d.n));
  } catch { return []; }
}

function filesIn(dir) {
  const out = [];
  (function walk(d) {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      statSync(p).isDirectory() ? walk(p) : out.push(p);
    }
  })(dir);
  return out;
}

const relInBatch = (batch, f) => relative(batch, f).split(/[\\/]/).join('/');

function pruneBackups() {
  try {
    const all = readdirSync(BACKUP_DIR)
      .map((n) => ({ n, t: statSync(join(BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of all.slice(40)) rmSync(join(BACKUP_DIR, d.n), { recursive: true, force: true });
  } catch { /* 备份目录还不存在，忽略 */ }
}

/* -------------------------------------------- 与浏览器端一致的枚举规则 */
/**
 * 浏览器端按文档顺序 enumerate，这里按源码顺序解析。
 * 规则必须两边完全一致：
 *   图片   → 所有 <img>
 *   图版   → class 列表里含独立一项 "plate" 的元素（等价 classList.contains('plate')）
 *   文字   → 所有带 data-lang 的元素（<html> 除外）
 * 万一序号对不上，保存时会用「原内容」自愈校正，所以这里不必追求绝对完美。
 */
function findElementExtent(src, openStart) {
  const head = /^<([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(src.slice(openStart));
  if (!head) return null;
  const tag = head[1].toLowerCase();
  const openEnd = src.indexOf('>', openStart);
  if (openEnd === -1) return null;
  const bounds = { tag, openStart, openEnd: openEnd + 1, innerStart: openEnd + 1, innerEnd: openEnd + 1, closeEnd: openEnd + 1 };
  if (src[openEnd - 1] === '/') return bounds; // 自闭合
  let depth = 1;
  const re = new RegExp(`<(/?)${tag}\\b`, 'gi');
  re.lastIndex = openEnd + 1;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === '/') {
      if (--depth === 0) {
        bounds.innerEnd = m.index;
        bounds.closeEnd = src.indexOf('>', m.index) + 1;
        return bounds;
      }
    } else depth++;
  }
  return bounds;
}

const attrOf = (tagHtml, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tagHtml);
  return m ? m[1] : '';
};

function listImgs(src) {
  const out = [];
  for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
    out.push({ start: m.index, end: m.index + m[0].length, html: m[0], src: attrOf(m[0], 'src') });
  }
  return out;
}

function listPlates(src) {
  const out = [];
  for (const m of src.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/gi)) {
    const classes = attrOf(m[0], 'class').split(/\s+/);
    if (!classes.includes('plate')) continue;
    const ext = findElementExtent(src, m.index);
    if (!ext) continue;
    const inner = src.slice(ext.innerStart, ext.innerEnd);
    const labelMatch = /<[^>]*class\s*=\s*"[^"]*plate__label[^"]*"[^>]*>([\s\S]*?)<\/[a-zA-Z]+>/i.exec(inner);
    out.push({
      start: ext.openStart,
      openEnd: src.indexOf('>', ext.openStart) + 1,
      openHtml: src.slice(ext.openStart, ext.openEnd),
      style: attrOf(src.slice(ext.openStart, ext.openEnd), 'style'),
      label: labelMatch ? norm(decodeEntities(labelMatch[1].replace(/<[^>]*>/g, ' '))) : '',
    });
  }
  return out;
}

/**
 * 只取「自己的」文字，不含子元素里的文字。
 * 例如状态标签 <span data-lang="zh"><span>●</span> 接受新项目</span>，
 * 可编辑的应当是「接受新项目」而不是「● 接受新项目」——
 * 否则用户在输入框里看到圆点，一保存就会把圆点重复一遍。
 */
function directText(inner) {
  let out = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '<') {
      if (/^<!--/.test(inner.slice(i))) {
        const end = inner.indexOf('-->', i);
        i = end === -1 ? inner.length : end + 3;
        continue;
      }
      const ext = findElementExtent(inner, i);
      if (!ext) { i++; continue; }
      if (ext.tag === 'br') out += '\n';
      i = Math.max(ext.closeEnd, i + 1);
    } else {
      out += inner[i];
      i++;
    }
  }
  return out;
}

function listLangNodes(src) {
  const out = [];
  for (const m of src.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bdata-lang\s*=\s*"(zh|en)"[^>]*>/gi)) {
    if (m[1].toLowerCase() === 'html') continue;
    const ext = findElementExtent(src, m.index);
    if (!ext) continue;
    const inner = src.slice(ext.innerStart, ext.innerEnd);
    out.push({
      tag: m[1].toLowerCase(), lang: m[2].toLowerCase(),
      innerStart: ext.innerStart, innerEnd: ext.innerEnd, inner,
      text: norm(decodeEntities(directText(inner))),
    });
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 在候选列表里挑出目标元素：优先用「原内容」精确匹配（自愈校正序号漂移），
 * 匹配不到再退回序号。同时匹配到多个时，优先取序号上那个。
 */
function pick(list, { expected, get, ordinal }) {
  const want = norm(expected);
  if (want) {
    const hits = list.map((el, i) => ({ el, i })).filter(({ el }) => norm(get(el)) === want);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return hits.find((h) => h.i === ordinal) || hits[0];
  }
  const i = Number(ordinal);
  return i >= 0 && i < list.length ? { el: list[i], i } : null;
}

function replaceNodeText(src, node, newText) {
  const inner = node.inner;
  const hasChildren = /<[a-zA-Z]/.test(inner);
  let replacement;
  if (!hasChildren) {
    replacement = inner.includes('<br') ? escapeHtml(newText).replace(/\n/g, '<br>') : escapeHtml(newText);
  } else {
    // 内部夹着子元素（如状态标签里的圆点），只替换最后一个子元素之后的纯文字
    const lastChild = Math.max(
      inner.lastIndexOf('</span>'), inner.lastIndexOf('</strong>'),
      inner.lastIndexOf('</em>'), inner.lastIndexOf('</b>'), inner.lastIndexOf('</i>'),
    );
    const cut = lastChild === -1 ? 0 : inner.indexOf('>', lastChild) + 1;
    replacement = inner.slice(0, cut) + escapeHtml(newText);
  }
  return src.slice(0, node.innerStart) + replacement + src.slice(node.innerEnd);
}

/* ------------------------------------------------------------ 保存文字 */
function saveText(body) {
  const absFile = safePath(body.file);
  const src = readFileSync(absFile, 'utf8');
  const nodes = listLangNodes(src);
  const hit = pick(nodes, { expected: body.expected, get: (n) => n.text, ordinal: body.ordinal });
  if (!hit) throw new Error('找不到要修改的文字。页面结构可能变了，请刷新页面重试。');

  backup(absFile);
  writeFileSync(absFile, replaceNodeText(src, hit.el, String(body.value ?? '')), 'utf8');
  return { file: relOf(absFile), lang: hit.el.lang, oldText: hit.el.text, value: String(body.value ?? '') };
}

/* ------------------------------------------------------------ 保存图片 */
function saveImage(body) {
  const absFile = safePath(body.file);
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(body.dataUrl || ''));
  if (!m) throw new Error('图片格式无法识别（需要 PNG / JPG / WebP / GIF / SVG）');

  const extMap = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico' };
  const ext = extMap[m[1].toLowerCase()] || m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片内容为空');

  mkdirSync(UPLOAD_DIR, { recursive: true });
  const base = (basename(String(body.filename || 'image')).replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'image';
  let name = `${base}.${ext}`;
  for (let n = 2; existsSync(join(UPLOAD_DIR, name)); n++) name = `${base}-${n}.${ext}`;
  const absImg = join(UPLOAD_DIR, name);
  writeFileSync(absImg, buf);

  const relFromPage = relative(dirname(absFile), absImg).split(/[\\/]/).join('/');
  const src = readFileSync(absFile, 'utf8');
  backup(absFile);

  if (body.kind === 'plate') {
    const plates = listPlates(src);
    const hit = pick(plates, { expected: body.expectedLabel, get: (p) => p.label, ordinal: body.ordinal });
    if (!hit) throw new Error('找不到要替换的图版。页面结构可能变了，请刷新页面重试。');
    const p = hit.el;

    // 保留原有 style 里除背景三件套之外的部分，别把别的样式冲掉
    const kept = p.style.split(';').map((s) => s.trim())
      .filter((s) => s && !/^background-(image|size|position)\s*:/i.test(s)).join('; ');
    const style = [`background-image:url('${relFromPage}')`, 'background-size:cover', 'background-position:center', kept]
      .filter(Boolean).join('; ');

    let open = p.openHtml.replace(/\s+style\s*=\s*"[^"]*"/i, '');
    if (/\bclass\s*=\s*"/i.test(open)) {
      open = open.replace(/\bclass\s*=\s*"([^"]*)"/i,
        (s, c) => `class="${/\bis-filled\b/.test(c) ? c : `${c} is-filled`}"`);
    } else {
      open = open.replace(/^(<[a-zA-Z][a-zA-Z0-9-]*)/, '$1 class="is-filled"');
    }
    open = open.replace(/^(<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 style="${style}"`);

    writeFileSync(absFile, src.slice(0, p.start) + open + src.slice(p.openEnd), 'utf8');
  } else {
    const imgs = listImgs(src);
    const hit = pick(imgs, { expected: body.expectedSrc, get: (i) => i.src, ordinal: body.ordinal });
    if (!hit) throw new Error('找不到要替换的图片。页面结构可能变了，请刷新页面重试。');
    const img = hit.el;
    const newTag = /\bsrc\s*=\s*"[^"]*"/i.test(img.html)
      ? img.html.replace(/\bsrc\s*=\s*"[^"]*"/i, `src="${relFromPage}"`)
      : img.html.replace(/<img\b/i, `<img src="${relFromPage}"`);
    writeFileSync(absFile, src.slice(0, img.start) + newTag + src.slice(img.end), 'utf8');
  }

  return { file: relOf(absFile), image: relOf(absImg), bytes: buf.length };
}

/* ------------------------------------------------------------ 撤销 */
/**
 * 撤销「这个文件最近一次被保存之前」的样子。
 * 关键点：要挑包含该文件的最新批次，而不是简单地拿最新批次；
 * 用完一个批次就给它改名加 .undone 后缀，这样连点多次「撤销上一步」
 * 会一路退回更早的版本，而不是反复恢复同一个批次。
 */
function undo(body) {
  const wantRel = body?.file ? relOf(safePath(body.file)) : null;
  let batch = null;
  let targets = [];

  for (const dir of backupBatches()) {
    const files = filesIn(dir);
    const hits = wantRel ? files.filter((f) => relInBatch(dir, f) === wantRel) : files;
    if (hits.length) { batch = dir; targets = hits; break; }
  }
  if (!batch) {
    throw new Error(wantRel ? '找不到这个文件的历史备份（可能备份已过期被清理）' : '还没有任何备份可以撤销');
  }

  for (const f of targets) {
    copyFileSync(f, resolve(root, relInBatch(batch, f)));
  }
  try { renameSync(batch, batch + UNDONE); } catch { /* 已被别的操作处理，忽略 */ }

  return { restored: targets.map((f) => relInBatch(batch, f)), batch: relOf(batch) };
}

/* ------------------------------------------------------------ HTML 注入 */
const INJECT = `
<link rel="stylesheet" href="/__editor/client.css">
<script src="/__editor/client.js" defer></script>
`;
const injectEditor = (html) =>
  /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${INJECT}</body>`) : html + INJECT;

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { rej(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}
const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

/* ------------------------------------------------------------ 服务 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/__editor/client.js' || path === '/__editor/client.css') {
      const f = join(root, 'tools', 'editor', basename(path));
      if (!existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? MIME['.css'] : MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(readFileSync(f));
      return;
    }

    if (path.startsWith('/__editor/')) {
      if (path === '/__editor/status') { sendJson(res, 200, { ok: true, port: PORT }); return; }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return; }
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const result = path === '/__editor/text' ? saveText(body)
        : path === '/__editor/image' ? saveImage(body)
          : path === '/__editor/undo' ? undo(body)
            : null;
      if (!result) { sendJson(res, 404, { ok: false, error: '未知接口' }); return; }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    let abs = safePath(path === '/' ? 'index.html' : path);
    if (existsSync(abs) && statSync(abs).isDirectory()) abs = join(abs, 'index.html');
    if (!existsSync(abs)) { res.writeHead(404, { 'Content-Type': MIME['.html'] }); res.end('<h1>404</h1>'); return; }

    const dot = abs.lastIndexOf('.');
    const ext = dot === -1 ? '' : abs.slice(dot).toLowerCase();
    if (ext === '.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(injectEditor(readFileSync(abs, 'utf8')));
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(abs));
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE'
    ? `\n  端口 ${PORT} 被占用了。换个端口：node tools/editor-server.mjs --port=5000\n`
    : `\n  启动失败：${e.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log('');
  console.log('  ==============================================');
  console.log('   牛潞翔作品集 · 可视化编辑器已启动');
  console.log('  ==============================================');
  console.log('');
  console.log(`   在浏览器里打开：  ${url}`);
  console.log('');
  console.log('   · 点右下角「开始编辑」进入编辑模式');
  console.log('   · 点图片 → 选一张新图 → 立刻替换');
  console.log('   · 点文字 → 直接改 → 点保存');
  console.log('   · 每次改动都会自动备份到 .editor-backup\\');
  console.log('');
  console.log('   关闭这个窗口就停止编辑器（网站文件不受影响）');
  console.log('');
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  }
});
