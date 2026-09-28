#!/usr/bin/env node
/**
 * check.mjs — 静态站自检（零依赖）
 *
 * 检查项：
 *  1. 所有 .html 里的本地 href / src 是否指向真实存在的文件（跳过 http(s)/mailto/tel/#/data:）
 *  2. 双语文案配对（zh / en 数量一致，且同一父元素下 zh 与 en 成对）
 *  3. 每页是否恰好一个 aria-current="page"
 *  4. 6 个详情页是否都存在，且「下一个项目」链是否成环
 *  5. works.html 的 6 张卡片 href 是否都有对应文件
 *  6. 是否残留 TODO 之外的占位／自检文件
 *
 * 用法：node tools/check.mjs
 * 退出码：0 = 全部通过；1 = 有 error
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const errors = [];
const warnings = [];
const ok = [];

/* ---------------------------------------------------------------- helpers */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = walk(root);
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));
const rel = (p) => relative(root, p).split(/[\\/]/).join('/');

// tools/ 下是开发用文件（例如打印用的 tools/resume.html），不随站点发布，
// 因此不参与「站点页面」类的检查（双语配对、导航 aria-current、图片引用）。
const pageFiles = htmlFiles.filter((f) => !rel(f).startsWith('tools/'));

/* -------------------------------------------------- 1. 本地链接可达性 */
const SKIP = /^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i;
const ATTR = /\b(?:href|src)\s*=\s*"([^"]*)"/gi;

for (const file of htmlFiles) {
  const src = readFileSync(file, 'utf8');
  const baseDir = dirname(file);
  for (const m of src.matchAll(ATTR)) {
    let target = m[1].trim();
    if (!target || SKIP.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    const abs = resolve(baseDir, decodeURIComponent(target));
    if (!existsSync(abs)) {
      errors.push(`${rel(file)}  →  链接不存在: ${target}`);
    }
  }
}
if (!errors.length) ok.push(`链接检查：${htmlFiles.length} 个 HTML，全部本地 href/src 可达`);

/* ------------------------------------------------------ 2. 双语文案配对 */
/**
 * 父元素级配对扫描：把每个带 data-lang 的元素登记到它的直接父元素，
 * 再检查每个父元素的直接子元素是否 zh / en 成对。
 * 比「逐行数标签」精确得多——本站的规范写法就是 zh 一行、en 下一行，
 * 逐行比较会把每一对正确配对都误报成错。
 */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function langPairProblems(file, src) {
  // 剥离注释与脚本/样式内容，避免把代码里的 `<` 当成标签；同时保留行号
  const clean = src
    .replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (s) => s.replace(/[^\n]/g, ' '));
  const lineAt = (idx) => clean.slice(0, idx).split('\n').length;

  const root = { tag: '#root', line: 0, langs: new Set() };
  const all = [root];
  const stack = [root];
  for (const m of clean.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];
    if (tag === 'html') continue; // <html data-lang="zh"> 是文档语言，不是文案节点
    if (!closing) {
      if (VOID_TAGS.has(tag) || m[4] === '/') continue;
      const el = { tag, line: lineAt(m.index), langs: new Set(), parent: stack[stack.length - 1] };
      all.push(el);
      stack.push(el);
      const lm = attrs.match(/data-lang\s*=\s*"([^"]*)"/);
      if (lm) el.own = lm[1];
    } else {
      if (VOID_TAGS.has(tag)) continue;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
    }
  }

  for (const el of all) if (el.own) el.parent.langs.add(el.own);

  const out = [];
  for (const el of all) {
    if (el.langs.size !== 1) continue;
    const only = [...el.langs][0];
    const other = only === 'zh' ? 'en' : 'zh';
    out.push(`${rel(file)}:${el.line}  →  <${el.tag}> 的直接子元素只有 data-lang="${only}"，缺少 "${other}" 对应文案`);
  }
  return out;
}

let bilingualClean = true;
for (const file of pageFiles) {
  const src = readFileSync(file, 'utf8');
  // 去掉 <html ...> 开标签本身（它带 data-lang="zh"，不是文案节点）
  const body = src.replace(/<html\b[^>]*>/i, '');
  const zh = (body.match(/data-lang="zh"/g) || []).length;
  const en = (body.match(/data-lang="en"/g) || []).length;
  if (zh !== en) {
    bilingualClean = false;
    errors.push(`${rel(file)}  →  双语数量不配对: data-lang="zh" × ${zh} vs data-lang="en" × ${en}`);
  }
  const pairProblems = langPairProblems(file, src);
  if (pairProblems.length) {
    bilingualClean = false;
    errors.push(...pairProblems);
  }
  // 语言切换按钮
  if (!src.includes('data-set-lang="zh"') || !src.includes('data-set-lang="en"')) {
    bilingualClean = false;
    errors.push(`${rel(file)}  →  缺少语言切换按钮`);
  }
}
if (bilingualClean) ok.push('双语检查：每页 zh / en 文案数量一致，语言切换按钮齐全');

/* --------------------------------------------------------- 3. aria-current */
for (const file of pageFiles) {
  const src = readFileSync(file, 'utf8');
  const n = (src.match(/aria-current="page"/g) || []).length;
  if (n !== 1) errors.push(`${rel(file)}  →  aria-current="page" 出现 ${n} 次（应为 1）`);
}
if (!errors.some((e) => e.includes('aria-current'))) ok.push('导航检查：每页恰好标记 1 处当前页');

/* ------------------------------------------------------- 4. 详情页链路成环 */
const SLUGS = [
  'jinweier-baijiu',
  'wahaha-ad',
  'heineken-package',
  'rendao-book',
  'chencu-ip',
  'zuoquan-infographic',
  'illustration',
  'commercial-photo',
];
for (const slug of SLUGS) {
  const p = join(root, 'projects', `${slug}.html`);
  if (!existsSync(p)) {
    errors.push(`缺少详情页: projects/${slug}.html`);
    continue;
  }
  const src = readFileSync(p, 'utf8');
  const m = src.match(/class="next-project"\s+href="([^"]+)"/) || src.match(/href="([^"]+)"[^>]*class="next-project"/);
  if (!m) {
    errors.push(`projects/${slug}.html  →  缺少「下一个项目」链接`);
    continue;
  }
  const expected = SLUGS[(SLUGS.indexOf(slug) + 1) % SLUGS.length];
  if (m[1] !== `${expected}.html`) {
    errors.push(`projects/${slug}.html  →  next-project 指向 ${m[1]}，期望 ${expected}.html`);
  }
}
if (!errors.some((e) => e.includes('详情页') || e.includes('next-project'))) {
  ok.push(`详情页检查：${SLUGS.length} 个页面齐全，next-project 链路成环`);
}

/* --------------------------------------------- 5. works.html 卡片 ↔ 详情页 */
const worksPath = join(root, 'works.html');
if (!existsSync(worksPath)) {
  errors.push('缺少 works.html');
} else {
  const src = readFileSync(worksPath, 'utf8');
  const hrefs = [...src.matchAll(/class="work-card[^"]*"\s+href="([^"]+)"/g)].map((m) => m[1]);
  if (hrefs.length !== SLUGS.length) errors.push(`works.html  →  work-card 数量为 ${hrefs.length}，期望 ${SLUGS.length}`);
  for (const h of hrefs) {
    if (!existsSync(resolve(root, h))) errors.push(`works.html  →  卡片链接不存在: ${h}`);
  }
  // data-cat 与筛选按钮对应
  const cats = new Set();
  for (const m of src.matchAll(/data-cat="([^"]+)"/g)) {
    m[1].split(/\s+/).forEach((c) => c && cats.add(c));
  }
  for (const m of src.matchAll(/class="filter-btn"\s+data-filter="([^"]+)"/g)) {
    const key = m[1];
    if (key !== 'all' && !cats.has(key)) {
      warnings.push(`works.html  →  筛选按钮 "${key}" 没有任何项目命中`);
    }
  }
  if (hrefs.length === SLUGS.length) ok.push(`作品页检查：${SLUGS.length} 张卡片链接有效，筛选分类与 data-cat 对应`);
}

/* ------------------------------------------------------------ 6. 残留文件 */
for (const junk of ['dsh-selftest.txt']) {
  if (existsSync(join(root, junk))) errors.push(`残留文件未删除: ${junk}`);
}
// 未替换的占位图 / 简历
const resume = join(root, 'assets', 'resume', 'niuluxiang-resume.pdf');
if (!existsSync(resume)) errors.push('缺少 assets/resume/niuluxiang-resume.pdf（「下载简历」会 404）');

/* ----------------------------------------------------------- 资源完整性 */
const IMG_REF = /src="([^"]*assets\/img\/[^"]+)"/g;
for (const file of pageFiles) {
  const src = readFileSync(file, 'utf8');
  const baseDir = dirname(file);
  for (const m of src.matchAll(IMG_REF)) {
    const abs = resolve(baseDir, m[1]);
    if (!existsSync(abs)) errors.push(`${rel(file)}  →  图片缺失: ${m[1]}`);
  }
}

/* --------------------------------------------------------------- 输出 */
const line = '─'.repeat(64);
console.log(`\n静态站自检  ·  ${rel(root) || root}\n${line}`);

for (const s of ok) console.log(`  ✓ ${s}`);
for (const w of warnings) console.log(`  ! ${w}`);
for (const e of errors) console.log(`  ✕ ${e}`);

console.log(line);
const pages = pageFiles.length;
const files = allFiles.length;
console.log(`  扫描：${files} 个文件 / ${pages} 个页面   通过 ${ok.length}  警告 ${warnings.length}  错误 ${errors.length}`);

if (errors.length) {
  console.log('\n  结果：失败\n');
  process.exit(1);
}
console.log('\n  结果：通过\n');
