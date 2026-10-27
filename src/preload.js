'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层能碰到的全部能力。
 * 不暴露 fs、不暴露 ipcRenderer 本体 —— 渲染层是纯展示 + 本地状态。
 */
contextBridge.exposeInMainWorld('bridge', {
  // AI 进度（主进程每秒推送）
  onStatus: (cb) => ipcRenderer.on('status', (_e, payload) => cb(payload)),
  statusPath: () => ipcRenderer.sendSync('status-path'),

  // 面板开合
  togglePanel: () => ipcRenderer.send('toggle-panel'),
  closePanel: () => ipcRenderer.send('close-panel'),

  // 拖拽：渲染层只报意图，坐标系在主进程
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // 位置持久化：localStorage 在渲染层，主进程只负责落地窗口坐标
  applyPosition: (x, y) => ipcRenderer.send('apply-position', { x, y }),
  onPositionSaved: (cb) => ipcRenderer.on('position-saved', (_e, pos) => cb(pos)),
});
