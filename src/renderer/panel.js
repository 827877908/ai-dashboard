'use strict';

/**
 * 面板：两个视图，一套数据源各管各的。
 *
 *   「我的清单」—— 本地持久化状态（localStorage），你写的，跟 AI 无关
 *   「AI 监控」 —— 外部只读投影（status.json），编排器写的，本面板只读不改
 *
 * 两条链路互不依赖：AI 没跑起来，你的清单照样能用；
 * 清单写坏了，AI 监控照样显示。
 */

const el = {
  dot: document.getElementById('dot'),
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  groups: document.getElementById('groups'),
  sPending: document.getElementById('s-pending'),
  sRunning: document.getElementById('s-running'),
  sDone: document.getElementById('s-done'),
  sSkipped: document.getElementById('s-skipped'),
  sCost: document.getElementById('s-cost'),
  footPath: document.getElementById('foot-path'),
  footTime: document.getElementById('foot-time'),
  tabs: [...document.querySelectorAll('.tab')],
  views: [...document.querySelectorAll('.view')],
  todoForm: document.getElementById('todo-form'),
  todoInput: document.getElementById('todo-input'),
  todoList: document.getElementById('todo-list'),
  todoLeft: document.getElementById('todo-left'),
  todoBadge: document.getElementById('todo-badge'),
  todoClear: document.getElementById('todo-clear'),
};

const TODO_KEY = 'ai-dashboard.todos.v1';
const ICON = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–', blocked: '⊘' };
const ORDER = { running: 0, pending: 1, blocked: 2, failed: 3, skipped: 4, done: 5 };

let currentView = 'todo';
let lastDoc = null;
let lastUpdate = 0;
let seq = 0;

// ══════════════════════════════════════════════════════════════════
// 一、个人清单 —— 本地持久化状态
// ══════════════════════════════════════════════════════════════════

function loadTodos() {
  try {
    const raw = localStorage.getItem(TODO_KEY);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((t) => t && typeof t.text === 'string' && t.text.trim());
  } catch {
    return [];
  }
}

function saveTodos() {
  try {
    localStorage.setItem(TODO_KEY, JSON.stringify(todos));
  } catch {
    /* 写不进去就算了，界面照常用 */
  }
}

let todos = loadTodos();

function newId() {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}`;
}

function todoLeft() {
  return todos.filter((t) => !t.done).length;
}

/** 未完成在前（新的在上），已完成沉到底部。 */
function sortedTodos() {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function renderTodos() {
  const list = sortedTodos();
  if (!list.length) {
    el.todoList.innerHTML =
      '<div class="empty"><span class="big">✓</span>清单是空的<br/>上面加一条试试</div>';
  } else {
    el.todoList.innerHTML = list
      .map(
        (t) =>
          `<div class="todo-item${t.done ? ' is-done' : ''}" data-id="${esc(t.id)}">` +
          `<button class="todo-check" data-act="toggle" title="${t.done ? '标记未完成' : '标记完成'}">` +
          `${t.done ? '✓' : ''}</button>` +
          `<span class="todo-text">${esc(t.text)}</span>` +
          `<button class="todo-del" data-act="del" title="划掉">✕</button>` +
          `</div>`
      )
      .join('');
  }
  const left = todoLeft();
  el.todoLeft.textContent = left ? `还剩 ${left} 件` : '全部做完了';
  el.todoBadge.textContent = left ? String(left) : '';
  el.todoBadge.style.display = left ? '' : 'none';
  updateHead();
}

function addTodo(text) {
  const value = String(text || '').trim();
  if (!value) return;
  todos.push({ id: newId(), text: value, done: false, createdAt: Date.now(), doneAt: null });
  saveTodos();
  renderTodos();
}

function toggleTodo(id) {
  const t = todos.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  saveTodos();
  renderTodos();
}

function deleteTodo(id) {
  todos = todos.filter((x) => x.id !== id);
  saveTodos();
  renderTodos();
}

function clearDone() {
  todos = todos.filter((t) => !t.done);
  saveTodos();
  renderTodos();
}

// 事件委托：清单会频繁增删，别给每个节点单独绑
el.todoList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.todo-item').dataset.id;
  if (btn.dataset.act === 'toggle') toggleTodo(id);
  else if (btn.dataset.act === 'del') deleteTodo(id);
});

el.todoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addTodo(el.todoInput.value);
  el.todoInput.value = '';
  el.todoInput.focus(); // 连续添加不用重新点
});

el.todoClear.addEventListener('click', clearDone);

// ══════════════════════════════════════════════════════════════════
// 二、AI 监控 —— 外部只读投影
// ══════════════════════════════════════════════════════════════════

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtMoney(v) {
  const n = Number(v || 0);
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** 把任务映射到 GUI 用的五态 */
function normalizeStatus(t) {
  const s = String(t.status || 'pending').toLowerCase();
  if (s === 'ok' || s === 'success' || s === 'completed') return 'done';
  if (s === 'in_progress') return 'running';
  if (s === 'blocked') return 'blocked';
  if (s === 'error') return 'failed';
  if (['pending', 'running', 'done', 'failed', 'skipped', 'blocked'].includes(s)) return s;
  return 'pending';
}

/** 统计行单独抽出来 —— 每个渲染分支都要调，不然数字会和列表对不上。 */
function updateStats(totals) {
  el.sPending.textContent = String(totals.pending ?? 0);
  el.sRunning.textContent = String(totals.running ?? 0);
  el.sDone.textContent = String(totals.done ?? 0);
  el.sSkipped.textContent = String(totals.skipped ?? 0);
  el.sCost.textContent = fmtMoney(totals.costUsd);
}

function renderAiWaiting() {
  el.dot.dataset.mode = 'idle';
  updateStats({});
  el.groups.innerHTML =
    '<div class="empty"><span class="big">·</span>编排器还没跑起来<br/>跑一次编排任务就会出现</div>';
  updateHead();
}

function renderAiStale(doc) {
  el.dot.dataset.mode = 'error';
  const totals = doc.totals || {};
  updateStats(totals);
  renderAiTasks(doc.tasks || [], totals);
  updateHead();
}

function renderAi(doc) {
  const totals = doc.totals || {};
  el.dot.dataset.mode = doc.state || 'idle';
  updateStats(totals);
  renderAiTasks(doc.tasks || [], totals);
  updateHead();
}

function renderAiTasks(tasks, totals) {
  if (!tasks.length) {
    el.groups.innerHTML = '<div class="empty"><span class="big">·</span>还没有任务清单</div>';
    return;
  }
  const buckets = { running: [], pending: [], blocked: [], failed: [], skipped: [], done: [] };
  for (const t of tasks) buckets[normalizeStatus(t)].push(t);

  const sections = [
    ['running', '进行中'], ['pending', '待办'], ['blocked', '受阻'],
    ['failed', '失败'], ['skipped', '跳过'], ['done', '完成'],
  ];

  const html = [];
  for (const [key, label] of sections) {
    const list = buckets[key];
    if (!list.length) continue;
    list.sort((a, b) => ORDER[normalizeStatus(a)] - ORDER[normalizeStatus(b)]);
    html.push(`<div class="group-label">${label}<span class="cnt">${list.length}</span></div>`);
    for (const t of list) {
      const st = normalizeStatus(t);
      const meta = [];
      if (t.durationMs) meta.push(fmtDuration(t.durationMs));
      if (t.costUsd) meta.push(fmtMoney(t.costUsd));
      if (t.attempts && t.attempts > 1) meta.push(`第${t.attempts}次`);
      if (t.kind) meta.push(esc(t.kind));
      const err = t.error ? `<span class="err">${esc(t.error)}</span>` : '';
      html.push(
        `<div class="task" data-status="${st}">` +
        `<span class="task-icon">${ICON[st] || '○'}</span>` +
        `<div class="task-main">` +
        `<div class="task-title">${esc(t.title || t.id || '')}</div>` +
        (meta.length || err
          ? `<div class="task-meta">${meta.map((m) => `<span>${m}</span>`).join('')}${err}</div>`
          : '') +
        `</div></div>`
      );
    }
  }
  el.groups.innerHTML = html.join('');
}

// ══════════════════════════════════════════════════════════════════
// 三、头部 + 视图切换
// ══════════════════════════════════════════════════════════════════

function updateHead() {
  if (currentView === 'todo') {
    const left = todoLeft();
    el.title.textContent = '我的清单';
    el.subtitle.textContent = left ? `${left} 件待办 · 本地保存` : '本地保存 · 刷新不丢';
    el.dot.style.display = 'none'; // 状态灯是 AI 的语义，清单视图里不该出现
    return;
  }
  el.dot.style.display = '';
  const doc = lastDoc;
  el.title.textContent = (doc && doc.idea) || 'AI 进度';
  const bits = [];
  // run 级状态用「运行结束」而不是「已完成」—— 避免和统计行的任务级「完成」撞词
  const stateText = {
    running: '执行中', done: '运行结束', error: '出错', idle: '空闲', interrupted: '已中断',
  }[(doc && doc.state) || ''];
  if (stateText) bits.push(stateText);
  if (doc && doc.totals && doc.totals.total) bits.push(`${doc.totals.total} 个任务`);
  el.subtitle.textContent = bits.join(' · ') || '等待 status.json';
}

function switchView(name) {
  currentView = name;
  for (const t of el.tabs) t.classList.toggle('is-active', t.dataset.view === name);
  for (const v of el.views) v.classList.toggle('is-active', v.id === `view-${name}`);
  updateHead();
  if (name === 'todo') el.todoInput.focus();
}

for (const tab of el.tabs) {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
}

// ── 尾部：状态路径 + 心跳时间 ────────────────────────────────────
if (window.bridge) {
  const p = window.bridge.statusPath();
  if (p) el.footPath.textContent = p;
}

setInterval(() => {
  if (!lastUpdate) return;
  const age = Math.round((Date.now() - lastUpdate) / 1000);
  el.footTime.textContent = age <= 2 ? '刚刚更新' : `${age}s 前`;
}, 1000);

if (window.bridge) {
  window.bridge.onStatus((payload) => {
    if (!payload) return;
    if (payload.state === 'waiting') {
      renderAiWaiting();
      return;
    }
    lastUpdate = Date.now();
    lastDoc = payload.data || {};
    const age = lastUpdate - (Date.parse(lastDoc.updatedAt) || lastUpdate);
    if (age > 10000 && lastDoc.state === 'running') {
      renderAiStale(lastDoc);
      return;
    }
    renderAi(lastDoc);
  });
}

document.getElementById('close').addEventListener('click', () => {
  if (window.bridge) window.bridge.closePanel();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.bridge) window.bridge.closePanel();
});

// 首屏：个人清单是默认视图
renderTodos();
switchView('todo');
