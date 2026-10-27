'use strict';

/**
 * 启动器 —— 不依赖 node_modules/.bin。
 *
 * 为什么不直接 `electron .`：这台机器上从 npm 装 electron 时二进制下载被断流
 * （GitHub release ECONNRESET），于是 electron 运行时是**从别处复制**过来的，
 * 没有 .bin 软链，`npm start` 会报「不是内部或外部命令」。
 *
 * 这里直接用 require('electron') 拿到 exe 绝对路径再拉起来，跨平台，也不怕 .bin 缺失。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const appDir = path.join(__dirname, '..');
const args = [appDir, ...process.argv.slice(2)];

const child = spawn(electronPath, args, { stdio: 'inherit', detached: false });
child.on('error', (err) => {
  console.error(`[ai-dashboard] 启动失败：${err.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
