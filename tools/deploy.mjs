#!/usr/bin/env node
/**
 * 一键发布：把本地文件同步到 GitHub 仓库，GitHub Pages 会自动重建站点。
 *
 * 为什么不用 git push：这台机器上 github.com:443 的原始 TCP 连接全部超时
 * （git ls-remote 与 git push 都走不通），但 api.github.com 是通的。
 * 所以这里直接调 GitHub 的 REST + Git Data API，效果和一次 git push 完全一样。
 *
 * 增量发布：先算出每个文件的 git blob SHA，跟远端已有的对比，
 * 只上传真正变了的文件；本地删掉的文件也会在远端删掉。
 * 所以改一张图再发布，只传那一个文件，几秒钟就完成。
 *
 * 令牌读取顺序：
 *   1. 环境变量 GITHUB_TOKEN
 *   2. 用户目录下的 .portfolio-token 文件（在仓库之外，永远不会被提交）
 *
 * 命令行用法：
 *   node tools/deploy.mjs            正常发布
 *   node tools/deploy.mjs --json     以 JSON 输出结果（给编辑器调用）
 *   node tools/deploy.mjs --dry      只列出会变动的文件，不真的发布
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OWNER = 'n3210636933-sketch';
const REPO = 'portfolio';
const BRANCH = 'main';
const API = 'https://api.github.com';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const dryRun = argv.includes('--dry');

/* ------------------------------------------------------------ 令牌 */
function readToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }
  const file = join(homedir(), '.portfolio-token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  return null;
}

/* ------------------------------------------------------------ 请求 */
// 这台机器到 GitHub 的连接偏不稳（github.com:443 的原始 TCP 直接超时，
// api.github.com 偶尔也会抽一下），所以网络层失败自动重试，指数退避。
async function api(method, path, body, token, attempt = 1) {
  const MAX = 4;
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'niuluxiang-portfolio-publisher',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    // 连不上 / 中途断流：可重试
    if (attempt < MAX) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
      return api(method, path, body, token, attempt + 1);
    }
    const err = new Error(`连不上 GitHub（${e.cause && e.cause.code ? e.cause.code : e.message}），已重试 ${MAX} 次`);
    err.status = 0;
    throw err;
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }

  // 5xx / 429 是服务端临时状况，值得重试；4xx 是我们自己写错了，直接报出来
  if (!res.ok && (res.status >= 500 || res.status === 429) && attempt < MAX) {
    await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
    return api(method, path, body, token, attempt + 1);
  }
  if (!res.ok) {
    const msg = (json && json.message) || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* ------------------------------------------------- 本地文件与 blob SHA */
// git 的 blob 对象 ID = sha1("blob " + 字节数 + "\0" + 内容)。
// 只要算得出这个值，就能在不下载远端文件的前提下判断内容是否相同。
function blobSha(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

function localFiles() {
  // --cached 拿已跟踪的，--others --exclude-standard 拿新加的但没被 .gitignore 排除的，
  // 两者合起来正好是「应该发布的所有文件」。
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------ 发布 */
export async function publish({ onProgress } = {}) {
  const token = readToken();
  if (!token) {
    throw new Error('找不到发布令牌。请把令牌写进 ' + join(homedir(), '.portfolio-token'));
  }
  const say = (m) => { if (onProgress) onProgress(m); };

  // 1. 远端现状
  let remoteTree = null;
  try {
    remoteTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`, null, token);
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }
  const remote = new Map();
  for (const node of (remoteTree && remoteTree.tree) || []) {
    if (node.type === 'blob') remote.set(node.path, node.sha);
  }

  // 2. 本地现状，挑出需要上传的
  const files = localFiles();
  const entries = [];
  const toUpload = [];
  for (const rel of files) {
    const abs = join(root, rel);
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    const sha = blobSha(buf);
    entries.push({ path: rel, mode: '100644', type: 'blob', sha });
    if (remote.get(rel) !== sha) toUpload.push({ path: rel, buf });
  }

  // 远端有、本地没有的 → 删掉
  const localSet = new Set(files);
  const toDelete = [...remote.keys()].filter((p) => !localSet.has(p));

  if (!toUpload.length && !toDelete.length) {
    return { ok: true, changed: false, uploaded: 0, deleted: 0, total: files.length,
      message: '本地没有新改动，线上已是最新' };
  }

  if (dryRun) {
    return { ok: true, changed: true, dry: true, uploaded: toUpload.length, deleted: toDelete.length,
      total: files.length, files: toUpload.map((f) => f.path), removed: toDelete,
      message: '（试运行，未真的发布）' };
  }

  say(`发现 ${toUpload.length} 个文件有改动、${toDelete.length} 个待删除`);

  // 3. 并发上传改动的文件（并发 6，对 GitHub 比较友好）
  const CONC = 6;
  for (let i = 0; i < toUpload.length; i += CONC) {
    const batch = toUpload.slice(i, i + CONC);
    await Promise.all(batch.map(async ({ path, buf }) => {
      const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`,
        { content: buf.toString('base64'), encoding: 'base64' }, token);
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }));
    say(`已上传 ${Math.min(i + CONC, toUpload.length)} / ${toUpload.length}`);
  }

  // 4. 建树（base_tree 让未改动的部分沿用远端，不必重传）
  const treeSpec = [...entries];
  for (const p of toDelete) treeSpec.push({ path: p, mode: '100644', type: 'blob', sha: null });

  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`,
    { base_tree: remoteTree ? remoteTree.sha : undefined, tree: treeSpec }, token);

  // 5. 提交
  const parentSha = remoteTree ? remoteTree.sha : null;
  let parents = [];
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, null, token);
    parents = [ref.object.sha];
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e;
  }

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `内容更新（${stamp}）\n\n来自本地可视化编辑器，共 ${toUpload.length} 个文件改动` +
      (toDelete.length ? `、${toDelete.length} 个删除` : ''),
    tree: tree.sha,
    parents,
  }, token);

  // 6. 移动分支
  if (parents.length) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha }, token);
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`,
      { ref: `refs/heads/${BRANCH}`, sha: commit.sha }, token);
  }

  // 7. 确认 Pages 还在正常构建
  let pagesStatus = 'unknown';
  try {
    const pages = await api('GET', `/repos/${OWNER}/${REPO}/pages`, null, token);
    pagesStatus = pages.status || 'unknown';
  } catch { /* 权限不足时忽略 */ }

  return {
    ok: true,
    changed: true,
    uploaded: toUpload.length,
    deleted: toDelete.length,
    total: files.length,
    commit: commit.sha.slice(0, 7),
    pagesStatus,
    url: `https://${OWNER}.github.io/${REPO}/`,
    message: `已发布 ${toUpload.length} 个改动` +
      (toDelete.length ? `、删除 ${toDelete.length} 个` : '') +
      `（版本 ${commit.sha.slice(0, 7)}），约 1 分钟后线上生效`,
  };
}

/* ------------------------------------------------------ 直接运行时执行 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await publish({ onProgress: (m) => { if (!asJson) console.log('  ' + m); } });
    if (asJson) console.log(JSON.stringify(result));
    else {
      console.log('\n  ' + result.message);
      if (result.changed) console.log('  ' + result.url);
      console.log('');
    }
    process.exit(0);
  } catch (e) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: e.message }));
    else console.error('\n  发布失败：' + e.message + '\n');
    process.exit(1);
  }
}
