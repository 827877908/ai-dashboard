'use strict';

/**
 * 圆球：两种手势，必须分清。
 *
 *   短按（<320ms 且位移 <5px）→ 点击 → 展开面板
 *   长按（≥320ms）           → 进入拖拽 → 主进程接管光标跟随
 *
 * 为什么长按才拖：球贴屏幕边缘，拖拽和点击共用一个 48×48 的热区，
 * 短按即拖会让"点开面板"变得不可靠。
 *
 * 位置持久化：localStorage（渲染层主场），主进程负责落地窗口坐标。
 */
const ballEl = document.getElementById('ball');

const LONG_PRESS_MS = 320;
const MOVE_TOLERANCE = 5;
const POS_KEY = 'ai-dashboard.ballPos';

let press = null;
let longPressTimer = null;
let dragging = false;

// ── 状态色：跟 AI 进度联动 ─────────────────────────────────────────
const STATES = { idle: 'idle', running: 'running', done: 'done', error: 'error' };

function applyState(payload) {
  if (!payload) return;
  if (payload.state === 'waiting') {
    ballEl.dataset.mode = 'idle';
    return;
  }
  const data = payload.data || {};
  const totals = data.totals || {};
  let state = STATES[data.state] || 'idle';
  if (state === 'idle' && (totals.running || 0) > 0) state = 'running';
  ballEl.dataset.mode = state;
}

if (window.bridge) {
  window.bridge.onStatus(applyState);

  // 位置恢复：先读本地存的落点，再让主进程贴过去
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      const p = JSON.parse(saved);
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        window.bridge.applyPosition(p.x, p.y);
      }
    }
  } catch {
    /* 存坏了就当没存过 */
  }

  // 主进程落地新位置 → 写回本地
  window.bridge.onPositionSaved((pos) => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {
      /* 写不进去也不影响本次拖拽 */
    }
  });
}

// ── 手势：长按拖拽 vs 点击 ──────────────────────────────────────────
ballEl.addEventListener('mousedown', (e) => {
  press = { x: e.screenX, y: e.screenY, t: Date.now() };
  dragging = false;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    dragging = true;
    document.body.classList.add('dragging');
    if (window.bridge) window.bridge.dragStart();
  }, LONG_PRESS_MS);
});

window.addEventListener('mouseup', (e) => {
  clearTimeout(longPressTimer);
  document.body.classList.remove('dragging');

  // 拖拽收尾：只结束拖拽，不当成点击
  if (dragging) {
    dragging = false;
    if (window.bridge) window.bridge.dragEnd();
    return;
  }

  if (!press) return;
  const moved = Math.hypot(e.screenX - press.x, e.screenY - press.y);
  const held = Date.now() - press.t;
  press = null;

  // 短按 + 没怎么动 → 当作点击展开
  if (moved <= MOVE_TOLERANCE && held < 800 && window.bridge) {
    window.bridge.togglePanel();
  }
});

// 拖拽中途窗口失焦/鼠标抬起在窗口外 → 兜底结束拖拽，避免球一直跟着鼠标跑
window.addEventListener('blur', () => {
  clearTimeout(longPressTimer);
  if (dragging) {
    dragging = false;
    document.body.classList.remove('dragging');
    if (window.bridge) window.bridge.dragEnd();
  }
});
