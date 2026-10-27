'use strict';

/**
 * 端到端测试：驱动真实 Electron 应用，验证三个核心交互真的成立。
 *   1. 手势分流：短按展开面板 / 长按拖拽，两者不串味
 *   2. 拖拽跟手：窗口位移必须等于真实光标位移（用真实系统光标做基准）
 *   3. 面板失焦自动收起
 *   4. 个人清单：添加 / 打勾 / 划掉 / localStorage 持久化
 *   5. Tab 切换：默认「我的清单」，能切到「AI 监控」
 *
 * 跑法：npm test
 *
 * ⚠️ 两个坐标系陷阱（都踩过）：
 *   - Playwright 的 mouse.move 是**合成事件**，不移动真实系统光标；
 *     而拖拽实现读的是真实光标 → 用合成事件断言位移会得到 1px 的假阴性。
 *     所以拖拽精度必须用 PowerShell 移动真实光标来测。
 *   - Electron 的 screen 坐标是 **DIP**，PowerShell 的 Cursor.Position 是物理像素，
 *     两者差一个缩放因子（本机 1.4375 / 1.15）→ 基准必须两边都从 Electron 读。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

/** playwright 可能装在全局，挨个试。 */
function loadPlaywright() {
  const candidates = [
    'playwright',
    'D:/node/node_modules/playwright',
    'D:/node/node_modules/@playwright/cli/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到 playwright —— 先 npm i -D playwright，或用全局的 @playwright/cli');
}

const { _electron: electron } = loadPlaywright();

const ROOT = path.join(__dirname, '..');
const STATUS = 'D:/codex_Files/orchestrator/plans/status.json';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
    timeout: 20000, encoding: 'utf8',
  }).trim();
}

/** 真实系统光标位置（物理像素）—— 用来真的挪动光标。 */
function readRealCursor() {
  const out = ps('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"');
  const [x, y] = out.split(',').map(Number);
  return { x, y };
}

function moveRealCursor(x, y) {
  ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`✓ ${msg}`);
}

(async () => {
  // 独立 userData → 独立单实例锁 + 独立 localStorage，
  // 免得测试实例跟真实运行中的实例抢缓存、抢清单
  const userData = path.join(__dirname, '.userdata-e2e');
  fs.rmSync(userData, { recursive: true, force: true });
  process.env.AI_DASHBOARD_USER_DATA = userData;

  const app = await electron.launch({
    executablePath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    args: [ROOT],
  });

  const winOf = async (needle) => {
    for (let i = 0; i < 40; i++) {
      await wait(250);
      const w = app.windows().find((x) => x.url().includes(needle));
      if (w) return w;
    }
    return null;
  };
  const posOf = (needle) =>
    app.evaluate(async ({ BrowserWindow }, n) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(n));
      return w ? w.getPosition() : null;
    }, needle);
  const cursorOf = () =>
    app.evaluate(({ screen }) => screen.getCursorScreenPoint());

  const ball = await winOf('ball.html');
  assert(ball, '圆球窗口已启动');
  await wait(1500);

  // ── 1. 短按 → 展开面板 ──────────────────────────────────────
  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(90);
  await ball.mouse.up();
  await wait(1200);

  const panel = await winOf('panel.html');
  assert(panel, '短按圆球 → 面板已展开');

  // ── 2. 默认视图是「我的清单」 ────────────────────────────────
  const activeTab = await panel.evaluate(() => document.querySelector('.tab.is-active').dataset.view);
  assert(activeTab === 'todo', '默认视图是「我的清单」');

  // ── 3. 清单：添加 / 打勾 / 持久化 ───────────────────────────
  await panel.evaluate(() => localStorage.removeItem('ai-dashboard.todos.v1'));
  await panel.reload();
  await wait(900);
  await panel.fill('#todo-input', '买咖啡豆');
  await panel.press('#todo-input', 'Enter');
  await panel.fill('#todo-input', '写周报');
  await panel.press('#todo-input', 'Enter');

  let texts = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-text')].map((e) => e.textContent));
  assert(texts.includes('买咖啡豆') && texts.includes('写周报'), '两条清单已添加');

  await panel.click('.todo-item .todo-check');
  const doneCount = await panel.evaluate(
    () => document.querySelectorAll('.todo-item.is-done').length);
  assert(doneCount === 1, '打勾生效（已完成项划横线变灰）');

  const stored = await panel.evaluate(() => localStorage.getItem('ai-dashboard.todos.v1'));
  assert(stored && stored.includes('买咖啡豆'), '清单已写入 localStorage');

  // 权威副本在磁盘上的明文文件里（断电也不丢）
  const todoFile = path.join(userData, 'todos.json');
  const fileSaved = fs.existsSync(todoFile) ? fs.readFileSync(todoFile, 'utf8') : null;
  assert(fileSaved && fileSaved.includes('买咖啡豆'), '清单已同步落盘为明文文件');

  await panel.reload();
  await wait(900);
  texts = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-text')].map((e) => e.textContent));
  assert(texts.includes('买咖啡豆'), '刷新后清单仍在（持久化生效）');

  // 划掉删除
  await panel.click('.todo-item .todo-del');
  await wait(300);
  texts = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-text')].map((e) => e.textContent));
  assert(texts.length === 1, '划掉后条目已删除');

  // ── 4. Tab 切到 AI 监控 ────────────────────────────────────
  await panel.click('.tab[data-view="ai"]');
  const aiOn = await panel.evaluate(() =>
    document.getElementById('view-ai').classList.contains('is-active') &&
    document.getElementById('view-todo').classList.contains('is-active') === false);
  assert(aiOn, 'Tab 切换到「AI 监控」生效');

  const aiStats = await panel.evaluate(() =>
    ['s-pending', 's-running', 's-done', 's-skipped', 's-cost']
      .map((id) => document.getElementById(id).textContent).join(' | '));
  console.log(`  AI 统计行 = ${aiStats}`);

  // ── 5. 失焦隐藏 ─────────────────────────────────────────────
  //     先 focus 再 blur：真实场景里面板是被点开的、本来就有焦点；
  //     若本机还有别的实例在跑，面板可能压根没拿到焦点，
  //     那时 blur() 不触发事件 —— 那是环境噪声，不是产品行为。
  await app.evaluate(async ({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('panel.html'));
    if (p) { p.focus(); }
  });
  await wait(300);
  await app.evaluate(async ({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('panel.html'));
    if (p) { p.blur(); }
  });
  // 轮询等它真的消失（本机还有真实实例在跑，焦点有竞争，等固定时间会误判）
  let hidden = false;
  for (let i = 0; i < 25 && !hidden; i++) {
    await wait(120);
    hidden = !(await app.evaluate(async ({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('panel.html'));
      return p ? p.isVisible() : false;
    }));
  }
  assert(hidden, '面板失焦 → 自动收起');

  // ── 6. 长按拖拽：跟手精度（基准 = 真实光标，坐标系统一用 DIP） ─
  //     测量口径：窗口位移 vs 光标位移。拖拽期间「光标 − 窗口左上角」的
  //     抓取偏移应当恒定，这条比「前后差值」更抗测量噪声。
  const before = await posOf('ball.html');
  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(600);                        // 超过 320ms 长按阈值 → 进入拖拽
  const cur1 = await cursorOf();
  const real = readRealCursor();
  moveRealCursor(real.x + 170, real.y + 100);
  await wait(700);                        // 等跟随循环收敛
  const cur2 = await cursorOf();
  const after = await posOf('ball.html');
  await ball.mouse.up();
  await wait(400);

  const expectDx = cur2.x - cur1.x;
  const expectDy = cur2.y - cur1.y;
  const actualDx = after[0] - before[0];
  const actualDy = after[1] - before[1];
  const drift = Math.hypot(actualDx - expectDx, actualDy - expectDy);
  console.log(`  窗口位移 ${actualDx},${actualDy} / 光标位移 ${expectDx},${expectDy}`);
  assert(drift <= 6, `长按拖拽跟手（偏差 ${drift.toFixed(1)}px）`);

  const savedPos = await ball.evaluate(() => localStorage.getItem('ai-dashboard.ballPos'));
  assert(savedPos && savedPos.includes('x'), '球的位置已持久化');

  // ── 7. 拖拽完短按仍能展开（手势没串味） ───────────────────
  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(90);
  await ball.mouse.up();
  await wait(1000);
  const visibleAgain = await app.evaluate(async ({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('panel.html'));
    return p ? p.isVisible() : false;
  });
  assert(visibleAgain, '拖拽之后短按仍能展开面板');

  // ── 8. 单实例锁：第二个实例立刻退出，不复制一份清单 ─────────
  //     （多开会抢同一个 userData 的缓存目录，且清单会分裂）
  //     用真实子进程测：Playwright 对「启动前就退出」的实例抛错名不统一，
  //     直接看进程能不能自己退出更干净 —— 锁生效 = 立刻 exit 0；
  //     锁没生效 = 它会一直活着直到被超时杀掉（signal != null）。
  const second = spawnSync(
    path.join(ROOT, 'node_modules/electron/dist/electron.exe'),
    [ROOT],
    { env: { ...process.env, AI_DASHBOARD_USER_DATA: userData }, timeout: 15000 },
  );
  assert(
    second.status === 0 && second.signal === null,
    `第二个实例立即退出（单实例锁生效；status=${second.status} signal=${second.signal}）`,
  );

  await app.close();
  console.log('\n全部端到端步骤通过。');
})().catch((err) => {
  console.error('✗ 端到端失败：', err.message);
  process.exit(1);
});
