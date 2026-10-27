'use strict';

/**
 * AI 编排进度悬浮窗 —— 主进程
 *
 * 架构定位：**个人工作台的宿主进程**，不是 AI 监控器。
 * AI 进度是「外部只读投影」，你的清单是「本地持久化状态」，两者物理隔离、互不污染。
 *
 * 本进程只做四件事：
 *   1. 造窗口（圆球 + 面板）
 *   2. 每秒读一次 status.json，把 AI 进度推给渲染层（事件驱动，单向）
 *   3. 承载拖拽：光标跟随 + 坐标解耦（渲染层只报意图，坐标算在主进程）
 *   4. 托盘常驻
 *
 * 它不认识编排器内部，不发请求，不写文件。
 */

const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('fs');

// 测试用：独立 userData 目录 → 独立的单实例锁 + 独立的 localStorage，
// 免得测试实例跟真实实例抢缓存、抢清单。
if (process.env.AI_DASHBOARD_USER_DATA) {
  app.setPath('userData', process.env.AI_DASHBOARD_USER_DATA);
}

let statusPath = resolveStatusPath();
const POLL_MS = 1000;

const BALL_SIZE = 48;
const PANEL_W = 400;
const PANEL_H = 560;
const PANEL_GAP = 10;

/** @type {BrowserWindow|null} */ let ball = null;
/** @type {BrowserWindow|null} */ let panel = null;
/** @type {Tray|null} */ let tray = null;
let panelOpen = false;
let panelHasFocus = false;

// ── 拖拽状态机 ───────────────────────────────────────────────────────
let dragging = false;
let dragOffset = { x: 0, y: 0 };
let followTimer = null;
let lastBallPos = { x: 0, y: 0 };

// ── 路径解析：环境变量 > 命令行参数 > 默认编排器路径 ────────────────────
function resolveStatusPath(argv = process.argv, env = process.env) {
  const fromEnv = env.AI_DASHBOARD_STATUS;
  const fromArg = (argv.find((a) => a.startsWith('--status=')) || '').split('=')[1];
  return path.resolve(fromEnv || fromArg || 'D:/codex_Files/orchestrator/plans/status.json');
}

// ── 托盘图标：代码生成 16x16 圆点，省一个二进制文件 ───────────────────
function makeTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const i = (y * size + x) * 4;
      buf[i] = 0x4a;
      buf[i + 1] = 0x9e;
      buf[i + 2] = 0xff;
      buf[i + 3] = d <= 6.6 ? 0xff : 0x00;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// ── 圆球窗口 ─────────────────────────────────────────────────────────
function createBall() {
  const area = screen.getPrimaryDisplay().workArea;

  ball = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    x: area.x + area.width - BALL_SIZE - 24,
    y: area.y + 24,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // 不要设 focusable:false —— Windows 上会连带把点击吃掉
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ball.setAlwaysOnTop(true, 'screen-saver');
  ball.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ball.loadFile(path.join(__dirname, 'renderer', 'ball.html'));
  ball.once('ready-to-show', () => {
    lastBallPos = { x: ball.getPosition()[0], y: ball.getPosition()[1] };
    ball.showInactive();
  });

  ball.on('click', () => togglePanel());
  ball.on('moved', () => {
    if (!dragging && ball) {
      const [x, y] = ball.getPosition();
      lastBallPos = { x, y };
    }
  });
}

// ── 面板窗口（无边框） ───────────────────────────────────────────────
function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(path.join(__dirname, 'renderer', 'panel.html'));

  // 失焦隐藏：点面板外的空白处 → 收起。
  // 两个条件缺一不可：
  //   ① 面板**曾经拿到过焦点**（否则它可能只是被别的窗口抢了焦点，
  //      从来没被交互过，收起来反而莫名其妙）
  //   ② 此刻确实不在焦点上
  // 延迟 180ms 再判定，避免窗口刚显示时的焦点抖动误收。
  panel.on('focus', () => {
    panelHasFocus = true;
  });
  panel.on('blur', () => {
    setTimeout(() => {
      if (panel && !panel.isDestroyed() && panelOpen && panelHasFocus && !panel.isFocused()) {
        hidePanel();
      }
    }, 180);
  });
  panel.on('closed', () => {
    panel = null;
    panelOpen = false;
  });
}

/** 全部显示器的并集 —— 多屏下球的合法活动范围。 */
function desktopBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 面板贴着球出现：优先球的右侧，放不下就翻到左侧，再做屏幕边界收敛。
 *  收敛用的是**球所在那块屏**的工作区，不是主屏 —— 多屏下球拖到哪，面板就跟到哪。 */
function computePanelPos() {
  const [bx, by] = ball.getPosition();
  const area = screen.getDisplayNearestPoint({ x: bx, y: by }).workArea;
  let px = bx + BALL_SIZE + PANEL_GAP;
  let py = by;
  if (px + PANEL_W > area.x + area.width) px = bx - PANEL_W - PANEL_GAP;
  if (px < area.x) px = area.x;
  if (py + PANEL_H > area.y + area.height) py = area.y + area.height - PANEL_H;
  if (py < area.y) py = area.y;
  return { x: Math.round(px), y: Math.round(py) };
}

function showPanel() {
  if (!panel) createPanel();
  if (!ball) return;
  panelOpen = true;
  panel.setPosition(computePanelPos().x, computePanelPos().y);
  panel.show(); // 面板要能被交互（打字 / 打勾），必须拿到焦点
  panel.focus();
  panel.webContents.send('status', readStatus());
}

function hidePanel() {
  if (!panel) return;
  panelOpen = false;
  panel.hide();
}

function togglePanel() {
  if (panelOpen) hidePanel();
  else showPanel();
}

// ── 拖拽：光标跟随 + 坐标解耦 ─────────────────────────────────────────
//
// 渲染层只报「开始拖 / 结束拖」的意图，坐标系留在主进程：
// 拖拽开始时算出「抓取点相对窗口左上角的偏移」，之后每帧把窗口挪到
// 「光标位置 - 偏移」。因为窗口完全跟手，指针始终落在球内 ——
// mouseup 永远收得到，不会出现「拖到一半松手丢事件」。
function followCursor() {
  if (!dragging || !ball || ball.isDestroyed()) return;
  const cur = screen.getCursorScreenPoint();
  const nx = Math.round(cur.x - dragOffset.x);
  const ny = Math.round(cur.y - dragOffset.y);
  ball.setPosition(nx, ny);
  // 面板开着时跟着球走，避免拖走球后面板留在原地
  if (panelOpen && panel && !panel.isDestroyed()) {
    panel.setPosition(panel.getPosition()[0] + (nx - lastBallPos.x),
                      panel.getPosition()[1] + (ny - lastBallPos.y));
  }
  lastBallPos = { x: nx, y: ny };
  followTimer = setTimeout(followCursor, 16);
}

// ── 读 status.json（容错：文件不存在 / 半写 / 非法 JSON 都不能崩） ─────
function readStatus() {
  try {
    const raw = fs.readFileSync(statusPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { state: 'empty' };
    return { state: 'ok', data };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'waiting' };
    return { state: 'waiting' };
  }
}

/** 把当前状态推给两个窗口（数据源切换后要立刻推一次，不等下一秒）。 */
function pushStatus() {
  const payload = readStatus();
  if (panel && !panel.isDestroyed() && panelOpen) {
    panel.webContents.send('status', payload);
  }
  if (ball && !ball.isDestroyed()) {
    ball.webContents.send('status', payload);
  }
}

// ── 轮询：每秒一次（事件驱动的唯一数据源） ────────────────────────────
setInterval(pushStatus, POLL_MS);

// ── 托盘菜单 ─────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(makeTrayIcon());
  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: () => showPanel() },
    { label: '收起面板', click: () => hidePanel() },
    { type: 'separator' },
    {
      label: '显示圆球',
      type: 'checkbox',
      checked: true,
      click: (item) => (item.checked ? ball.showInactive() : ball.hide()),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('个人工作台');
  tray.setContextMenu(menu);
}

// ── 生命周期 ─────────────────────────────────────────────────────────

// 单实例锁：多开一个实例不会复制一份清单、也不会互相抢缓存目录。
// 第二个实例不是被静默丢弃 —— 它把「要看哪个 status.json」交给已有实例，
// 已有实例换数据源并把面板叫出来。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const incoming = (argv || []).find((a) => a.startsWith('--status='));
    if (incoming) {
      statusPath = resolveStatusPath(argv);
      pushStatus();
    }
    if (ball && !ball.isDestroyed()) ball.showInactive();
    showPanel();
  });

  app.whenReady().then(() => {
    createBall();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createBall();
    });
  });
}

app.on('window-all-closed', () => {
  // 常驻托盘，不退出
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

// ── IPC ──────────────────────────────────────────────────────────────
ipcMain.on('toggle-panel', () => togglePanel());
ipcMain.on('close-panel', () => hidePanel());
ipcMain.on('status-path', (event) => {
  event.returnValue = statusPath;
});

// ── 个人清单的持久化 ────────────────────────────────────────────────
//
// 为什么不用 localStorage 当唯一真相：它是攒批异步落盘的，
// 写完立刻断电/强杀进程会丢最后几秒的改动（实测会丢）。
// 这里改成主进程同步写明文文件 —— 写完那一刻数据已经在磁盘上。
// 顺带好处：文件在 userData 目录里，用户能直接找到、能复制、能导入。
const TODO_FILE = () => path.join(app.getPath('userData'), 'todos.json');

function writeTodosAtomic(list) {
  const target = TODO_FILE();
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

ipcMain.on('todos-save', (_event, list) => {
  if (!Array.isArray(list)) return;
  writeTodosAtomic(list);
});

ipcMain.handle('todos-load', () => {
  try {
    const raw = readFileSync(TODO_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;   // 没有文件 → 交给渲染层回退到 localStorage
  }
});

ipcMain.on('drag-start', () => {
  if (!ball || ball.isDestroyed()) return;
  const cur = screen.getCursorScreenPoint();
  const [bx, by] = ball.getPosition();
  dragOffset = { x: cur.x - bx, y: cur.y - by };
  dragging = true;
  followCursor();
});

ipcMain.on('drag-end', () => {
  if (!dragging) return;
  dragging = false;
  clearTimeout(followTimer);
  if (ball && !ball.isDestroyed()) {
    const [x, y] = ball.getPosition();
    lastBallPos = { x, y };
    // 把新位置交回渲染层做持久化（localStorage 是渲染层的主场）
    ball.webContents.send('position-saved', { x, y });
  }
});

ipcMain.on('apply-position', (_event, pos) => {
  if (!ball || ball.isDestroyed() || !pos) return;
  // 收敛到**所有显示器并集**内 —— 单屏假设会让多屏用户一恢复位置就被拽回主屏
  const area = desktopBounds();
  const x = Math.min(Math.max(Math.round(pos.x), area.x), area.x + area.width - BALL_SIZE);
  const y = Math.min(Math.max(Math.round(pos.y), area.y), area.y + area.height - BALL_SIZE);
  ball.setPosition(x, y);
  lastBallPos = { x, y };
});
