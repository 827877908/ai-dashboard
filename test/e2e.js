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
// 编排器的 status.json —— 与悬浮窗同级推断，不写死本机盘符
const STATUS = path.join(ROOT, '..', 'orchestrator', 'plans', 'status.json');
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

  // 本机可能还有真实实例在跑，它会跟测试实例抢焦点 → 测试面板被判定失焦而收起
  // （那是产品的正确行为，单独有对应用例）。这里每次交互前把面板拉回来，
  // 保证测的是功能而不是焦点竞争。
  const ensurePanel = async () => {
    await app.evaluate(async ({ BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('panel.html'));
      if (!p) return;
      if (!p.isVisible()) p.show();
      p.focus();
    });
    await wait(120);
  };

  // ── 2. 默认视图是「我的清单」 ────────────────────────────────
  const activeTab = await panel.evaluate(() => document.querySelector('.tab.is-active').dataset.view);
  assert(activeTab === 'todo', '默认视图是「我的清单」');

  // ── 3. 清单：添加 / 打勾 / 持久化 ───────────────────────────
  await panel.evaluate(() => localStorage.removeItem('ai-dashboard.todos.v1'));
  await panel.reload();
  await wait(900);
  await ensurePanel();
  await panel.fill('#todo-input', '买咖啡豆');
  await panel.press('#todo-input', 'Enter');
  await panel.fill('#todo-input', '写周报');
  await panel.press('#todo-input', 'Enter');

  let texts = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-text')].map((e) => e.textContent));
  assert(texts.includes('买咖啡豆') && texts.includes('写周报'), '两条清单已添加');

  await ensurePanel();
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
  await ensurePanel();
  await panel.click('.todo-item .todo-del');
  await wait(300);
  texts = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-text')].map((e) => e.textContent));
  assert(texts.length === 1, '划掉后条目已删除');

  // ── 3.5 今日 / 长期 分组 ──────────────────────────────────
  // 开关切到「长期」→ 新条目进长期组
  await ensurePanel();
  await panel.click('.scope-btn[data-scope="long"]');
  await panel.fill('#todo-input', '读完那本书');
  await panel.press('#todo-input', 'Enter');
  await wait(300);
  let scoped = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-item')].map((e) => `${e.dataset.scope}|${e.querySelector('.todo-text').textContent}`));
  assert(scoped.includes('long|读完那本书'), '切到「长期」后新条目进长期组');
  assert(scoped.some((s) => s.startsWith('today|')), '原有条目仍在今日组');

  // ⇄ 一键在两组间移动
  await ensurePanel();
  await panel.click('.todo-item[data-scope="today"] .todo-scope-btn');
  await wait(300);
  scoped = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-item')].map((e) => e.dataset.scope));
  assert(scoped.filter((s) => s === 'long').length === 2, '⇄ 按钮能在今日/长期之间移动条目');

  // 分组标题恒定显示（空组也显示 0），带数量
  const groupLabels = await panel.evaluate(() =>
    [...document.querySelectorAll('.todo-group')].map((e) => e.textContent.trim()));
  assert(groupLabels.some((g) => g.startsWith('今日')) && groupLabels.some((g) => g.startsWith('长期')),
    `清单按今日/长期分段显示（${groupLabels.join(' / ')}）`);

  // 统计文案跟着分组走
  const meta = await panel.evaluate(() => document.getElementById('todo-left').textContent);
  assert(meta.includes('今日') && meta.includes('长期'), `统计区分两组（${meta}）`);

  // ── 4. Tab 切到 AI 监控 ────────────────────────────────────
  await ensurePanel();
  await panel.click('.tab[data-view="ai"]');
  const aiOn = await panel.evaluate(() =>
    document.getElementById('view-ai').classList.contains('is-active') &&
    document.getElementById('view-todo').classList.contains('is-active') === false);
  assert(aiOn, 'Tab 切换到「AI 监控」生效');

  const aiStats = await panel.evaluate(() =>
    ['s-pending', 's-running', 's-done', 's-skipped', 's-cost']
      .map((id) => document.getElementById(id).textContent).join(' | '));
  console.log(`  AI 统计行 = ${aiStats}`);

  // 主进程指向的应该是编排器那个 status.json（同级推断，不写死盘符）
  const reported = await panel.evaluate(() => window.bridge.statusPath());
  assert(
    reported.replace(/\\/g, '/').endsWith('orchestrator/plans/status.json'),
    `主进程自动定位到编排器的 status.json（${reported}）`,
  );

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
  // ── 6. 长按拖拽：跟手精度（基准 = 真实光标，坐标系统一用 DIP） ─
  //     判据用「抓取偏移是否恒定」：拖拽时窗口应完全跟手，
  //     所以「光标 − 窗口左上角」这个差值应当始终不变。
  //     这比「前后位移差」更直接 —— 拖拽没激活时偏移会整个跳掉，一眼能看出。
  const sample = () =>
    app.evaluate(({ screen, BrowserWindow }) => {
      const b = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('ball.html'));
      const w = b ? b.getPosition() : [0, 0];
      const c = screen.getCursorScreenPoint();
      return { wx: w[0], wy: w[1], cx: c.x, cy: c.y, ox: c.x - w[0], oy: c.y - w[1] };
    });

  await ball.mouse.move(24, 24);
  await ball.mouse.down();
  await wait(600);                        // 超过 320ms 长按阈值 → 进入拖拽
  const s0 = await sample();
  const real = readRealCursor();
  moveRealCursor(real.x + 170, real.y + 100);
  await wait(400);
  let s1 = await sample();
  // 等窗口追到最终位置（连续两次读数相同）
  for (let i = 0; i < 20; i++) {
    await wait(120);
    const now = await sample();
    const settled = now.wx === s1.wx && now.wy === s1.wy;
    s1 = now;
    if (settled) break;
  }
  await ball.mouse.up();
  await wait(400);

  const drift = Math.hypot(s1.ox - s0.ox, s1.oy - s0.oy);
  console.log(`  抓取偏移 ${s0.ox},${s0.oy} → ${s1.ox},${s1.oy}（窗口 ${s0.wx},${s0.wy} → ${s1.wx},${s1.wy}）`);
  // 阈值 12px：跟随是 16ms 一帧，光标又是瞬间跳 170px（人手不会这么跳），
  // 残差主要来自「最后一帧还没追到位」。球本身 48px，这点残差感知不到。
  assert(drift <= 12, `长按拖拽跟手（抓取偏移漂移 ${drift.toFixed(1)}px）`);

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
