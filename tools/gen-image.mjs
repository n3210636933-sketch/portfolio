#!/usr/bin/env node
/**
 * gen-image.mjs — 命令行直接生图（编辑器之外的入口）
 *
 * 用法：
 *   node tools/gen-image.mjs "日出时分薄雾峡谷上方的发光浮空城市，电影级写实"
 *   node tools/gen-image.mjs "提示词" --ratio=16:9 --size=2K
 *   node tools/gen-image.mjs "转成赛博朋克夜景，保留原始构图" --image=assets/img/works/01-jinweier/cover.jpg
 *   node tools/gen-image.mjs "提示词" --n=4
 *   node tools/gen-image.mjs "提示词" --out="C:\Users\牛潞翔0.o\Desktop\生成" --name=test
 *   node tools/gen-image.mjs "提示词" --base64          # 只打印 base64，不落盘
 *
 * 默认参数：--size=2K（1024 太快、4K 太慢，2K 是这个网站图片的常用档）
 *           --ratio=1:1（给了 --image 就按参考图的比例）  --n=1
 *           --out=assets/img/ai（相对当前目录；不在当前目录就写绝对路径）
 * 提示词写法（官方推荐，照这个结构写效果最稳）：
 *   [主体] + [场景/环境] + [风格] + [光照] + [构图] + [质量要求]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generate, saveImageBuffer, parseArgs, stamp, pixelSize, extOf, fileBase,
  RATIOS, SIZES, outputPixels, pickRatio,
} from './agnes-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { opts, positional } = parseArgs();

if (opts.help || opts.h || !positional.length) {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(self.slice(self.indexOf('/**') + 3, self.indexOf('*/')));
  process.exit(positional.length ? 0 : 1);
}

const prompt = positional.join(' ').trim();
const size = String(opts.size || '2K').toUpperCase();
if (!SIZES.some((s) => s.value === size)) {
  console.error(`  ✗ --size 只能是 ${SIZES.map((s) => s.value).join(' / ')}，收到 ${opts.size}`);
  process.exit(1);
}

/* 图生图：读参考图 */
let image = null, imageExt = '', imgDim = null;
if (opts.image) {
  const p = isAbsolute(String(opts.image)) ? String(opts.image) : resolve(process.cwd(), String(opts.image));
  image = readFileSync(p);
  imageExt = extOf(p);
  imgDim = pixelSize(image);
  console.log(`  参考图：${p}（${(image.length / 1024).toFixed(0)}KB${imgDim ? `，${imgDim.width}×${imgDim.height}` : ''}）`);
}

let ratio;
if (opts.ratio) {
  ratio = String(opts.ratio);
  if (!RATIOS.includes(ratio)) {
    console.error(`  ✗ --ratio 只能是 ${RATIOS.join(' / ')}，收到 ${opts.ratio}`);
    process.exit(1);
  }
} else if (imgDim && imgDim.width && imgDim.height) {
  ratio = pickRatio({ width: imgDim.width, height: imgDim.height });
  console.log(`  没给 --ratio，按参考图比例取 ${ratio}`);
} else {
  ratio = '1:1';
}

const n = Math.max(1, Math.min(12, Number(opts.n || 1)));
const outDir = opts.out
  ? (isAbsolute(String(opts.out)) ? String(opts.out) : resolve(process.cwd(), String(opts.out)))
  : join(root, 'assets', 'img', 'ai');
const px = outputPixels(size, ratio);

console.log('');
console.log(`  模型 agnes-image-2.5-flash ｜ ${size} ${ratio} → ${px.width}×${px.height} ｜ 共 ${n} 张`);
console.log(`  提示词：${prompt}`);
console.log('');

let ok = 0, fail = 0;
for (let i = 1; i <= n; i++) {
  if (n > 1) console.log(`  ── 第 ${i}/${n} 张 ${'─'.repeat(38)}`);
  try {
    const { buf, ext, meta } = await generate({
      prompt, size, ratio, image, imageExt,
      onProgress: (m) => console.log('    · ' + m),
    });
    if (opts.base64) {
      console.log(`    ✓ ${(buf.length / 1024).toFixed(0)}KB ${(meta.ms / 1000).toFixed(1)}s`);
      console.log('data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + buf.toString('base64'));
    } else {
      const nameHint = `${fileBase(opts.name || 'ai')}-${stamp()}` + (n > 1 ? `-${i}` : '');
      const abs = saveImageBuffer(outDir, buf, { ext, name: nameHint });
      const rel = abs.startsWith(root) ? abs.slice(root.length + 1).replace(/\\/g, '/') : abs;
      console.log(`    ✓ ${(buf.length / 1024).toFixed(0)}KB  ${meta.actual ? meta.actual.width + '×' + meta.actual.height + '  ' : ''}${(meta.ms / 1000).toFixed(1)}s`);
      console.log(`      ${rel}`);
    }
    ok++;
  } catch (e) {
    fail++;
    console.error('    ✗ ' + e.message);
    if (n === 1) process.exit(1);
  }
}

console.log('');
console.log(`  完成：成功 ${ok} 张${fail ? `，失败 ${fail} 张` : ''}`);
if (!opts.base64 && ok) console.log(`  输出目录：${outDir}`);
console.log('');
process.exit(fail && !ok ? 1 : 0);
