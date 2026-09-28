#!/usr/bin/env node
/**
 * make-resume.mjs
 * 用 Edge 把 tools/resume.html 渲染成 A4 简历 PDF，输出到
 *   assets/resume/niuluxiang-resume.pdf
 *
 * 走 DevTools Protocol 的 Page.printToPDF，零 npm 依赖。
 * 内容来源于 D:\卓面文件\简历.pdf 提取出的真实信息，改简历请直接改 tools/resume.html。
 *
 * 用法：node tools/make-resume.mjs [--force]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(root, 'tools', 'resume.html');
const OUT = resolve(root, 'assets', 'resume', 'niuluxiang-resume.pdf');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edgePath) {
  console.error('找不到 Microsoft Edge，无法生成 PDF。');
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`找不到 ${SRC}`);
  process.exit(1);
}

const PORT = 9800 + (process.pid % 300);
const PROFILE = join(root, `.edge-resume-${process.pid}`);
const fileUrl = 'file:///' + encodeURI(SRC.replace(/\\/g, '/'));

const edge = spawn(
  edgePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

/** 轮询 /json/version 直到 DevTools 就绪 */
async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(120);
  }
  throw new Error('Edge DevTools 启动超时');
}

const wsUrl = await waitForDevtools();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject: rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});

/** sessionId 必须是 CDP 报文的顶层字段，塞进 params 会报 method not found */
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

let sessionId;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));

  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: fileUrl }, sessionId);

  // 等 load 事件
  await new Promise((res) => {
    const t = setTimeout(res, 15000);
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Page.loadEventFired') {
        clearTimeout(t);
        ws.removeEventListener('message', h);
        res();
      }
    };
    ws.addEventListener('message', h);
  });

  // 等网络字体真正就位，否则会以回退字体排版
  await send(
    'Runtime.evaluate',
    {
      expression: `document.fonts.ready.then(() => true)`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId
  );
  await sleep(400);

  const { data } = await send(
    'Page.printToPDF',
    {
      printBackground: true,
      paperWidth: 8.27,   // A4
      paperHeight: 11.69,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: true,
    },
    sessionId
  );

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(data, 'base64'));

  const { result } = await send(
    'Runtime.evaluate',
    { expression: `document.body.scrollHeight / (96 / 25.4) + 'mm'`, returnByValue: true },
    sessionId
  );
  const kb = (readFileSync(OUT).length / 1024).toFixed(0);
  console.log(`✓ 已生成 ${OUT}`);
  console.log(`  内容高度约 ${result.value}（A4 一页 = 297mm），${kb} KB`);
} finally {
  ws.close();
  edge.kill();
  await sleep(350);
  rmSync(PROFILE, { recursive: true, force: true });
}
