#!/usr/bin/env node
/**
 * set-key.mjs — 写入 / 更换 Agnes 的 API key（顺便当场体检一次）
 *
 * 用法：
 *   node tools/set-key.mjs sk-你的key        # 写入并实测一次
 *   node tools/set-key.mjs --check           # 只看现在用的是哪个 key、还灵不灵
 *   node tools/set-key.mjs --show            # 打印 key 文件路径和打码后的内容
 *
 * 为什么要有这个文件：网站文件夹会被整份发布到 GitHub Pages（公开的），
 * 所以 key 只能存在网站文件夹外面。这里统一写到：
 *   C:\Users\<你>\.agnes-key
 * 跟发布令牌 .portfolio-token 放在一起。
 */
import { existsSync, statSync } from 'node:fs';
import { KEY_FILE, resolveKey, writeKeyFile, generate } from './agnes-image.mjs';

const mask = (k) => (!k ? '(无)' : k.slice(0, 7) + '…' + k.slice(-4) + `  (${k.length} 位)`);

const line = '  ' + '─'.repeat(58);
function head(title) {
  console.log('');
  console.log('  ══════════════════════════════════════════════════════════');
  console.log('   ' + title);
  console.log('  ══════════════════════════════════════════════════════════');
}

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const show = argv.includes('--show');
const key = argv.find((a) => !a.startsWith('--'));

head(check || show ? 'Agnes API key 状态' : '写入 Agnes API key');

if (key) {
  if (!/^sk-/.test(key.trim())) {
    console.error(`\n  ✗ 这看起来不像一个 key（应当以 sk- 开头）：${mask(key.trim())}\n`);
    process.exit(1);
  }
  const dest = writeKeyFile(key);
  console.log(`\n  ✓ 已写入：${dest}`);
  console.log('    （在网站文件夹外面，永远不会被发布上线；编辑器服务重启后生效）');
}

const cur = resolveKey();
console.log('');
console.log(`  key 文件 ：${KEY_FILE}${existsSync(KEY_FILE) ? '' : '   ← 还不存在'}`);
if (existsSync(KEY_FILE)) {
  const st = statSync(KEY_FILE);
  console.log(`  文件时间 ：${st.mtime.toLocaleString()}`);
}
console.log(`  当前使用的 key：${mask(cur.key)}`);
console.log(`  来源        ：${cur.from || '(两处都没找到)'}`);

if (!cur.key) {
  console.log('\n  下一步：node tools/set-key.mjs sk-你的key\n');
  process.exit(check ? 1 : 0);
}

if (check || key) {
  console.log(line);
  console.log('  正在实测一次最小生图（1K / 1:1，约 8–10 秒）…');
  try {
    const { buf, ext, meta } = await generate({
      prompt: 'A plain light gray test card, no text',
      size: '1K',
      ratio: '1:1',
      timeoutMs: 120000,
      onProgress: (m) => console.log('    · ' + m),
    });
    console.log(line);
    console.log(`  ✓ 接口正常：${(buf.length / 1024).toFixed(0)}KB ${ext}` +
      `${meta.actual ? `，${meta.actual.width}×${meta.actual.height}` : ''}，耗时 ${(meta.ms / 1000).toFixed(1)}s`);
    console.log(`    task_id：${meta.taskId || '(未返回)'}`);
  } catch (e) {
    console.log(line);
    console.log('  ✗ 实测失败：' + e.message);
    process.exit(1);
  }
}

console.log('');
console.log('  编辑器里怎么用：双击「编辑网站.bat」→ 点右下角「开始编辑」→ 点任意一张图');
console.log('  → 面板里选「AI 生图」→ 写提示词 → 生成。生成的图会自动落盘、改好引用、发布上线。');
console.log('');
