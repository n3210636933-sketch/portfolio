#!/usr/bin/env node
/**
 * agnes-image.mjs — Agnes 生图能力的全部实现（零依赖，只用 Node 自带的 fetch）
 *
 * 提供给三个地方调用：
 *   1. tools/editor-server.mjs  编辑器里点图片 →「AI 生图」
 *   2. tools/gen-image.mjs      命令行直接出图
 *   3. tools/set-key.mjs        换 key 时顺手做一次连通性体检
 *
 * 关于 key：
 *   key **绝不**写进这个文件，也绝不写进网站目录（那个目录会整份发布到 GitHub Pages，
 *   是公开的）。它只从下面两个地方读，优先级从高到低：
 *     1) 环境变量 AGNES_API_KEY
 *     2) C:\Users\牛潞翔0.o\.agnes-key   ← 在网站文件夹外面，永远发不出去
 *   跟发布令牌 .portfolio-token 放在一起，是同一套思路。
 *
 * 接口事实（2026-08 实测 + 官方文档 https://www.agnes-ai.cn/zh-Hans/docs/agnes-image-25-flash）：
 *   POST https://api.agnes-ai.cn/v1/images/generations
 *   必填 model / prompt / size；ratio 默认 1:1；
 *   response_format 必须放在 extra_body 里，放顶层会报错；
 *   图生图把参考图放进 extra_body.image（公共 URL 或 data:image/...;base64,...），
 *   不需要传 tags: ["img2img"]；
 *   响应形如 { created, task_id, data: [{ url, b64_json, revised_prompt }] }。
 *   实测耗时：文生图 1K 约 8.5 秒，图生图 1K 约 26 秒（官方建议客户端超时给 60–360 秒）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, extname, basename } from 'node:path';

export const API_ENDPOINT = 'https://api.agnes-ai.cn/v1/images/generations';
export const MODEL = 'agnes-image-2.5-flash';
export const KEY_FILE = join(homedir(), '.agnes-key');

/** 官方支持的宽高比 */
export const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];
/** 官方支持的尺寸档位；每一档都标了 1:1 下的像素，界面上好让人有概念 */
export const SIZES = [
  { value: '1K', label: '1K', note: '1024² · 最快' },
  { value: '2K', label: '2K', note: '2048² · 推荐' },
  { value: '3K', label: '3K', note: '3072²' },
  { value: '4K', label: '4K', note: '4096² · 最慢' },
];
/** 尺寸档位 × 宽高比 → 实际输出像素（官方表格原文） */
export const SIZE_TABLE = {
  '1:1': { '1K': [1024, 1024], '2K': [2048, 2048], '3K': [3072, 3072], '4K': [4096, 4096] },
  '3:4': { '1K': [864, 1152], '2K': [1728, 2304], '3K': [2592, 3456], '4K': [3456, 4608] },
  '4:3': { '1K': [1152, 864], '2K': [2304, 1728], '3K': [3456, 2592], '4K': [4608, 3456] },
  '16:9': { '1K': [1312, 736], '2K': [2624, 1472], '3K': [3936, 2208], '4K': [5248, 2944] },
  '9:16': { '1K': [736, 1312], '2K': [1472, 2624], '3K': [2208, 3936], '4K': [2944, 5248] },
  '2:3': { '1K': [832, 1248], '2K': [1664, 2496], '3K': [2496, 3744], '4K': [3328, 4992] },
  '3:2': { '1K': [1248, 832], '2K': [2496, 1664], '3K': [3744, 2496], '4K': [4992, 3328] },
  '21:9': { '1K': [1568, 672], '2K': [3136, 1344], '3K': [4704, 2016], '4K': [6272, 2688] },
};
/** 界面上的宽高比下拉，按「这个网站的图版大概长什么样」排的 */
export const RATIO_OPTIONS = [
  { value: '1:1', label: '1:1 方形' },
  { value: '4:3', label: '4:3 横' },
  { value: '3:4', label: '3:4 竖' },
  { value: '3:2', label: '3:2 横' },
  { value: '2:3', label: '2:3 竖' },
  { value: '16:9', label: '16:9 横幅' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '21:9', label: '21:9 超宽' },
];

/* --------------------------------------------------------------- key */
export function resolveKey() {
  const env = String(process.env.AGNES_API_KEY || '').trim();
  if (env) return { key: env, from: '环境变量 AGNES_API_KEY' };
  try {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    const m = /(sk-[A-Za-z0-9_\-]+)/.exec(raw);
    if (m) return { key: m[1], from: KEY_FILE };
    if (raw) return { key: raw, from: KEY_FILE };
  } catch { /* 文件还不存在 */ }
  return { key: '', from: null };
}

export function hasKey() { return !!resolveKey().key; }

export function writeKeyFile(raw) {
  const key = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!/^sk-/.test(key)) throw new Error('这看起来不像一个 key（应当以 sk- 开头）');
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  // 只写自己一行纯文本：文件里不留任何其它内容，免得被编辑器顺手带出去
  writeFileSync(KEY_FILE, key + '\n', { encoding: 'utf8', mode: 0o600 });
  return KEY_FILE;
}

/* ------------------------------------------------------- 尺寸 / 宽高比 */
export function clampSize(size) {
  const s = String(size ?? '').trim().toUpperCase();
  return SIZES.some((x) => x.value === s) ? s : '2K';
}

/**
 * 决定这次用什么宽高比。
 *
 * 规矩只有一条：**元素在页面上的真实形状优先**。
 * 编辑器里把一张图换成另一张，视觉上必须还能占住原来的位置 —— 如果这里按用户
 * 在下拉框里的选择走，选错一次就会把整块版式顶歪，而用户多半还以为只是「图换了一张」。
 * 所以在编辑器里调用时传 ratio:'AUTO'，让像素说话；命令行出图想指定比例时传具体值即可。
 */
export function pickRatio({ ratio, width, height } = {}) {
  const w = Number(width), h = Number(height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return ratioFromPixels(w, h);
  const r = String(ratio ?? '').trim();
  if (RATIOS.includes(r)) return r;
  return '1:1';
}

/** 从元素尺寸里挑最接近的官方宽高比 */
export function ratioFromPixels(w, h) {
  const target = Number(w) / Number(h);
  let best = '1:1', bestErr = Infinity;
  for (const r of RATIOS) {
    const [a, b] = r.split(':').map(Number);
    const err = Math.abs(target - a / b) / (a / b);
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return best;
}

export function outputPixels(size, ratio) {
  const s = clampSize(size);
  const r = RATIOS.includes(String(ratio)) ? String(ratio) : '1:1';
  const [w, h] = SIZE_TABLE[r][s];
  return { width: w, height: h };
}

/* --------------------------------------------------------- 图片小工具 */
export function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 12 && buf.slice(4, 12).toString('latin1') === 'ftypheic') return 'heic';
  return null;
}

/** 不装任何依赖读像素尺寸：PNG 的 IHDR 和 JPEG 的 SOF 段都在文件头部 */
export function pixelSize(buf) {
  if (sniffImage(buf) === 'png' && buf.length > 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (sniffImage(buf) === 'jpg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export function toDataUri(buf, hintExt) {
  const kind = sniffImage(buf) || String(hintExt || 'png').replace(/^\./, '').toLowerCase();
  const mime = kind === 'jpg' || kind === 'jpeg' ? 'image/jpeg' : `image/${kind}`;
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/* -------------------------------------------------------------- 调用 */
/**
 * 调一次生图接口。返回 { buf, ext, meta }，buf 是图片字节，ext 是落盘后缀。
 * @param {object} o
 * @param {string} o.prompt  提示词（必填）
 * @param {string} [o.size]  1K / 2K / 3K / 4K
 * @param {string} [o.ratio] 1:1 等
 * @param {Buffer} [o.image] 图生图 / 多图合成的输入图字节
 * @param {string} [o.imageExt]
 * @param {number} [o.timeoutMs]
 * @param {(m:string)=>void} [o.onProgress]
 */
export async function generate({
  prompt, size = '2K', ratio = '1:1', image = null, imageExt = '', emit,
  timeoutMs = Number(process.env.AGNES_TIMEOUT_MS || 360000), onProgress,
} = {}) {
  const say = (m) => { if (typeof onProgress === 'function') onProgress(m); };
  const text = String(prompt || '').trim();
  if (!text) throw new Error('提示词不能为空');
  const { key, from } = resolveKey();
  if (!key) {
    throw new Error(`没有找到 Agnes 的 API key。请先跑一次：\n    node tools/set-key.mjs sk-你的新key\n  或者设一个环境变量 AGNES_API_KEY（当前两者都没有）`);
  }
  const body = {
    model: MODEL,
    prompt: text,
    size: clampSize(size),
    ratio: pickRatio({ ratio }),
    extra_body: { response_format: 'url' },
  };
  const images = [];
  if (Buffer.isBuffer(image) && image.length) images.push(toDataUri(image, imageExt));
  if (images.length) body.extra_body.image = images;

  const px = outputPixels(body.size, body.ratio);
  say(`正在生图：${body.size} ${body.ratio} → ${px.width}×${px.height}${images.length ? '（图生图）' : ''}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  let json, status;
  try {
    const r = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = r.status;
    const textBody = await r.text();
    try { json = JSON.parse(textBody); } catch { json = { raw: textBody }; }
    if (!r.ok) {
      const msg = (json.error && (json.error.message || json.error.code)) || json.message || textBody.slice(0, 300);
      throw new Error(`Agnes 返回 ${r.status}：${msg}`);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`生图超时（超过 ${Math.round(timeoutMs / 1000)} 秒还没返回），可以调小尺寸再试一次`);
    if (e.message && /^Agnes 返回/.test(e.message)) throw e;
    throw new Error(`连不上 api.agnes-ai.cn：${e.message}${e.cause && e.cause.code ? '（' + e.cause.code + '）' : ''}\n  key 来源：${from}`);
  } finally {
    clearTimeout(timer);
  }

  const item = (json.data && json.data[0]) || {};
  let buf = null;
  if (item.b64_json) {
    say('拿到 base64 图，正在解码…');
    buf = Buffer.from(String(item.b64_json).replace(/^data:[^,]+,/, ''), 'base64');
  } else if (item.url) {
    say('拿到图片地址，正在下载…');
    const ir = await fetch(item.url);
    if (!ir.ok) throw new Error(`图片下载失败：HTTP ${ir.status}`);
    buf = Buffer.from(await ir.arrayBuffer());
  }
  if (!buf || !buf.length) {
    throw new Error(`接口没有返回图片：${JSON.stringify(json).slice(0, 300)}`);
  }
  const ext = sniffImage(buf) || 'png';
  const dim = pixelSize(buf);
  return {
    buf,
    ext,
    meta: {
      request: { size: body.size, ratio: body.ratio, ...px },
      bytes: buf.length,
      actual: dim,
      taskId: json.task_id || null,
      ms: Date.now() - t0,
      httpStatus: status,
      keyFrom: from,
      mode: images.length ? 'img2img' : 'txt2img',
    },
  };
}

/* ------------------------------------------------------ 图片写到硬盘 */
/**
 * 把字节写成文件。outDir 直接给绝对路径（目录不存在会自动建）。
 * 默认落在项目的 assets/img/ai/ 下面，重名不会覆盖，会自动 -2 -3。
 * 刻意不往 assets/img/uploads/ 里塞：那个目录是「用户自己上传的图」，
 * 混进 AI 生成的图，以后想整体清一遍就分不清了。
 */
export function saveImageBuffer(outDir, buf, { ext = 'png', name = 'ai' } = {}) {
  mkdirSync(outDir, { recursive: true });
  const safe = String(name || 'ai').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'ai';
  let file = `${safe}.${ext}`;
  for (let n = 2; existsSync(join(outDir, file)); n++) file = `${safe}-${n}.${ext}`;
  const abs = join(outDir, file);
  writeFileSync(abs, buf);
  return abs;
}

/** 20260814-153012 这种时间戳，用来给生成图起名 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* -------------------------------------------------------------- CLI */
/** 从 argv 里取 --key=value / --key value 形式的参数，剩下的当位置参数 */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
      else opts[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { opts, positional };
}

export function extOf(p) { return extname(p || '').replace(/^\./, '').toLowerCase() || ''; }
export const fileBase = (p) => basename(p || '').replace(/\.[^.]+$/, '');
