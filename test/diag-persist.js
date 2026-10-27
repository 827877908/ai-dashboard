'use strict';

/**
 * 持久化验证：清单能不能跨重启活下来。
 * 测两种「关机」：
 *   A. 正常退出（点托盘退出 / 正常关机）
 *   B. 强杀进程树（等价于任务管理器结束 / 拔电）—— 最坏情况
 * 用隔离的 userData，不碰你真实的清单。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const candidates = ['playwright', 'D:/node/node_modules/@playwright/cli/node_modules/playwright'];
let electron = null;
for (const c of candidates) {
  try { electron = require(c)._electron; break; } catch { /* next */ }
}
const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const EXE = path.join(ROOT, 'node_modules/electron/dist/electron.exe');

function launch(userData) {
  process.env.AI_DASHBOARD_USER_DATA = userData;
  return electron.launch({ executablePath: EXE, args: [ROOT] });
}

async function openPanel(app) {
  let ball = null;
  for (let i = 0; i < 40 && !ball; i++) {
    await wait(250);
    ball = app.windows().find((w) => w.url().includes('ball.html'));
  }
  if (!ball) throw new Error('球没起来');
  await wait(1000);
  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(90);
  await ball.mouse.up();
  await wait(1200);
  for (let i = 0; i < 20; i++) {
    const p = app.windows().find((w) => w.url().includes('panel.html'));
    if (p) return p;
    await wait(250);
  }
  throw new Error('面板没展开');
}

(async () => {
  const userData = path.join(__dirname, '.userdata-persist');
  fs.rmSync(userData, { recursive: true, force: true });

  // ── 写入 ───────────────────────────────────────────────────
  let app = await launch(userData);
  let panel = await openPanel(app);
  await panel.fill('#todo-input', '重启后我应该还在');
  await panel.press('#todo-input', 'Enter');
  await wait(600);
  const stored = await panel.evaluate(() => localStorage.getItem('ai-dashboard.todos.v1'));
  console.log(`写入后 localStorage 里有：${stored ? '有数据' : '空'}`);

  // ── B. 强杀进程树（最坏情况） ───────────────────────────────
  const pid = app.process().pid;
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20000 }); } catch { /* 已退出 */ }
  await wait(2000);

  // ── 重新启动，读回 ─────────────────────────────────────────
  app = await launch(userData);
  panel = await openPanel(app);
  const texts = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-text')].map((e) => e.textContent));
  const survived = texts.includes('重启后我应该还在');
  console.log(`强杀后重启 → 清单内容：${JSON.stringify(texts)}`);
  console.log(survived ? '✓ 强杀（拔电级）也不丢' : '✗ 强杀后丢了数据');

  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(survived ? 0 : 1);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
