#!/usr/bin/env node
/**
 * shoot.mjs — 用 Edge 的真实渲染引擎给页面截图（零依赖）
 *
 * 为什么需要它：静态站没法「看」，只能靠真实浏览器渲染后回读 PNG 来验收版式。
 * 直接用 `msedge --screenshot` 只能截视口，拿不到整页；这里用 DevTools Protocol
 * 的 Page.captureScreenshot + captureBeyondViewport 拿整页图。
 * Node 24 自带 fetch 与 WebSocket，所以不需要任何 npm 依赖。
 *
 * 用法：
 *   node tools/shoot.mjs                 # 截 index / works / about / contact
 *   node tools/shoot.mjs --all           # 再加上 6 个详情页
 *   node tools/shoot.mjs --en            # 顺便截一份英文模式
 *   node tools/shoot.mjs --lang en       # 只截英文模式
 *
 * 产物：.shots/<name>.png（整页）与 .shots/<name>@top.png（首屏视口）
 * 说明：整页图会先把 .reveal / .load-in / .bar-item 强制置为已进场状态，
 *       否则视口外的滚动揭示动画停在 opacity:0，整页图会有一片空白。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.shots');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!EDGE) {
  console.error('找不到 msedge.exe，尝试过的路径：\n  ' + EDGE_CANDIDATES.join('\n  '));
  process.exit(1);
}

const argv = process.argv.slice(2);
const includeAll = argv.includes('--all');
const langs = argv.includes('--lang')
  ? [argv[argv.indexOf('--lang') + 1]]
  : argv.includes('--en')
    ? ['zh', 'en']
    : ['zh'];

const PAGES = [
  'index.html',
  'works.html',
  'about.html',
  'contact.html',
  ...(includeAll
    ? [
        'projects/jinweier-baijiu.html',
        'projects/wahaha-ad.html',
        'projects/heineken-package.html',
        'projects/rendao-book.html',
        'projects/chencu-ip.html',
        'projects/zuoquan-infographic.html',
        'projects/illustration.html',
        'projects/commercial-photo.html',
      ]
    : []),
];

const PORT = 9333 + (process.pid % 400);
const userDataDir = join(root, '.edge-profile');

/* ------------------------------------------------------------ 启浏览器 */
rmSync(userDataDir, { recursive: true, force: true });
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('Edge DevTools 端口未就绪');
}

/* ------------------------------------------------------------ CDP 小客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        const waiters = this.events.get(msg.method);
        if (waiters) { this.events.delete(msg.method); waiters.forEach((w) => w(msg.params)); }
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    // 扁平模式下 sessionId 必须是报文顶层字段，塞进 params 里浏览器会当成未知方法
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(msg));
    });
  }
  once(method, timeout = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} 超时`)), timeout);
      const arr = this.events.get(method) || [];
      arr.push((p) => { clearTimeout(t); res(p); });
      this.events.set(method, arr);
    });
  }
}

// file:// 下不保证有可用的 localStorage，所以语言状态不去碰存储，
// 而是加载完成后直接点页面上的语言切换按钮，走 site.js 的真实切换路径。
// 加 --base=<url> 可以改截线上站点，用来验收真实部署：
//   node tools/shoot.mjs --all --base=https://user.github.io/repo
const baseArg = argv.find((a) => a.startsWith('--base='));
const baseUrl = baseArg ? baseArg.slice('--base='.length).replace(/\/+$/, '') : null;
const fileUrl = (relPath) =>
  baseUrl ? `${baseUrl}/${relPath}` : 'file:///' + encodeURI(join(root, relPath).replace(/\\/g, '/'));

async function openSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
  });
  return ws;
}

/* ------------------------------------------------------------ 主流程 */
try {
  const version = await waitForDevTools();
  console.log(`Edge ${version.Browser}`);
  console.log(`DevTools ws: ${version.webSocketDebuggerUrl.split('/').slice(0, 3).join('/')}\n`);

  const ws = await openSocket(version.webSocketDebuggerUrl);
  const cdp = new CDP(ws);
  const { targetInfos } = await cdp.send('Target.getTargets', {}, false);
  const page = targetInfos.find((t) => t.type === 'page');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false);

  // 之后所有 Page/Runtime/Emulation 命令都走这个扁平会话
  const raw = cdp.send.bind(cdp);
  cdp.send = (method, params = {}) => raw(method, params, sessionId);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  mkdirSync(outDir, { recursive: true });

  for (const lang of langs) {
    for (const relPath of PAGES) {
      const name = relPath.replace(/\.html$/, '').replace(/\//g, '__');
      const suffix = lang === 'en' ? '-en' : '';
      const url = fileUrl(relPath);

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      });

      // 语言切换在页面加载之后进行：点真实的切换按钮，
      // file:// 下 localStorage 不可靠，但按钮点击这条路径一定成立。
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded.catch(() => {});
      // 等字体与 Lenis 就位
      await sleep(1400);

      if (lang === 'en') {
        const switched = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const btn = document.querySelector('[data-set-lang="en"]');
            if (!btn) return 'no-button';
            btn.click();
            return document.documentElement.getAttribute('data-lang');
          })()`,
          returnByValue: true,
        });
        const now = switched.result?.value;
        if (now !== 'en') {
          console.log(`  ! ${relPath} 语言切换未生效（data-lang=${now}）`);
        }
        await sleep(500);
      }

      // 1) 首屏视口（保留真实的揭示动画状态）
      const top = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(outDir, `${name}${suffix}@top.png`), Buffer.from(top.data, 'base64'));

      // 2) 整页：先强制所有揭示动画进场，再按内容高度截全
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          document.querySelectorAll('.reveal,.bar-item').forEach(e => e.classList.add('is-in'));
          document.querySelectorAll('.load-in').forEach(e => { e.style.opacity = '1'; e.style.transform = 'none'; });
          // 关键：整页截图会一次性拍下视口外的内容，但 loading="lazy" 的图片
          // 从未进入过视口，浏览器不会去加载它们，拍出来就是一片空白。
          document.querySelectorAll('img[loading="lazy"]').forEach(i => { i.loading = 'eager'; });
          if (window.__lenis) window.__lenis.destroy && window.__lenis.destroy();
          window.scrollTo(0, 0);
        })()`,
      });
      // 等所有图片真正解码完成，否则截图仍可能拍到空白
      await cdp.send('Runtime.evaluate', {
        expression: `Promise.all([...document.images].map(i => i.complete
          ? Promise.resolve()
          : new Promise(r => { i.addEventListener('load', r, {once:true}); i.addEventListener('error', r, {once:true}); })
        ))`,
        awaitPromise: true,
        returnByValue: true,
      });
      await sleep(450);

      const { contentSize } = await cdp.send('Page.getLayoutMetrics');
      const full = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1440, height: Math.ceil(contentSize.height), scale: 1 },
      });
      writeFileSync(join(outDir, `${name}${suffix}.png`), Buffer.from(full.data, 'base64'));

      console.log(`  ✓ ${relPath}${suffix ? ' (en)' : ''}  →  ${Math.ceil(contentSize.height)}px 高`);
    }
  }

  ws.close();
} catch (err) {
  console.error('截图失败:', err.message);
  process.exitCode = 1;
} finally {
  edge.kill();
  await sleep(400);
  rmSync(userDataDir, { recursive: true, force: true });
}
