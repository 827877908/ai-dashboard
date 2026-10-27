'use strict';

/**
 * 拖拽诊断：拖拽期间连续采样「窗口位置」与「光标位置」，
 * 看两者的差值（= 抓取偏移）是否恒定。
 *   恒定 → 实现是对的，偏差在测量端
 *   不恒定 → 实现有问题，能直接看出在哪一段散架
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

function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { timeout: 20000, encoding: 'utf8' }).trim();
}
function readRealCursor() {
  const out = ps('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"');
  const [x, y] = out.split(',').map(Number);
  return { x, y };
}
function moveRealCursor(x, y) {
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`);
}

(async () => {
  const userData = path.join(__dirname, '.userdata-diag');
  fs.rmSync(userData, { recursive: true, force: true });
  process.env.AI_DASHBOARD_USER_DATA = userData;

  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [ROOT],
  });
  const sample = () =>
    app.evaluate(({ screen, BrowserWindow }) => {
      const b = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('ball.html'));
      const w = b ? b.getPosition() : [0, 0];
      const c = screen.getCursorScreenPoint();
      return { wx: w[0], wy: w[1], cx: c.x, cy: c.y, ox: c.x - w[0], oy: c.y - w[1] };
    });

  let ball = null;
  for (let i = 0; i < 40 && !ball; i++) {
    await wait(250);
    ball = app.windows().find((w) => w.url().includes('ball.html'));
  }
  await wait(1500);

  console.log('--- 按下前 ---');
  console.log(JSON.stringify(await sample()));

  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(600); // 进入拖拽态

  console.log('--- 拖拽已激活（光标还没动）---');
  const s0 = await sample();
  console.log(JSON.stringify(s0));

  const real = readRealCursor();
  console.log(`--- 真实光标（物理）= ${real.x},${real.y} ---`);
  moveRealCursor(real.x + 170, real.y + 100);

  for (let i = 0; i < 8; i++) {
    await wait(150);
    const s = await sample();
    console.log(`t+${(i + 1) * 150}ms  win=(${s.wx},${s.wy})  cursor=(${s.cx},${s.cy})  offset=(${s.ox},${s.oy})`);
  }

  await ball.mouse.up();
  await app.close();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
