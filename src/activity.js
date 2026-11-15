'use strict';

/**
 * activity.js —— 读 Claude Code 的**会话记录**，推出「宝现在在干什么」。
 *
 * 🔴 2026-11-15 加的：悬浮窗原来只反映**编排器**的状态。
 *    但宝平时干活（改代码、跑探针）大多**不走编排器** → 悬浮窗一直显示「空闲」，
 *    她看不到我在干嘛（2026-11-15 她的原话：「话说你在干活儿的时候，这儿也没更新状态」）。
 *
 * 做法：**只读**最新的那个会话 .jsonl 的**尾巴**，从最后几条消息里推：
 *   · 最后一个 assistant 的 tool_use → 「跑 xxx」「改 xxx」「读 xxx」「派 agent」
 *   · 最后一个 assistant 的文本        → 取前 24 字
 * 什么都不用维护 —— 我不用手动报状态，它自己看。
 *
 * 约束：
 *   · **只读**，不写不改会话记录
 *   · 只读尾巴（最后 160 KB）—— 会话记录能到 90 MB，全读会卡
 *   · 文件不存在 / 解析失败 / 正在写（半截行）→ 一律返回 null，不崩
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 读多少尾巴（够看完最近几十条消息，又不至于卡）。 */
const TAIL_BYTES = 160 * 1024;
/** 最多回看多少行。 */
const MAX_LINES = 60;
/** 活动多久没更新算「没了」（毫秒）。 */
const STALE_MS = 90 * 1000;

/** ~/.claude/projects 下的所有会话目录。 */
function projectDirs() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const dirs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    dirs.push(path.join(root, e.name));
  }
  return dirs;
}

/** 最新的那个会话 .jsonl（按修改时间）。 */
function newestTranscript() {
  let best = null;
  let bestMtime = 0;
  for (const dir of projectDirs()) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = { file: full, mtimeMs: st.mtimeMs };
      }
    }
  }
  return best;
}

/** 读文件尾巴（不整file读）。 */
function readTail(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** 一个文件路径 → 「文件名」（路径太长不好看）。 */
function baseName(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1) || s;
}

/** 一个 Bash 命令 → 「做什么」（取命令名，不取整条）。 */
function describeCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '跑命令';
  /* 🔴 跳过「准备动作」（cd / export / set …）—— 它们不是真活，
   *   标签应该说清**真正在跑的那条**（例如 "跑 probe-flow-line.mjs"）。 */
  const parts = s.split(/&&|\|\||;/).map((p) => p.trim()).filter(Boolean);
  const meaningful = parts.find((p) =>
    !/^(cd|export|set|source|echo|pwd|ls|dir)\b/.test(p)) || parts[parts.length - 1];
  /* 去掉命令前面的环境变量赋值（OUT_DIR=dist node x.js → node x.js） */
  let target = (meaningful || parts[0] || s).replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
  const m = target.match(/^(node|npm|npx|python3?|bash|sh|git|taskkill|cargo|go)\s+([^\s;&|]+)/);
  if (m) {
    const tool = m[1];
    const arg = baseName(m[2]);
    if (tool === 'npm') {
      /* npm run test:scenarios → 跑 test:scenarios（别只显示 "跑 run"） */
      if (arg === 'run') {
        const next = target.split(/\s+/)[2];
        return `跑 ${next ? baseName(next) : 'npm'}`;
      }
      if (/^(test|probe|shot|build|start|opc)$/i.test(arg)) return `跑 ${arg}`;
      return `npm ${arg}`;
    }
    if (tool === 'npx' || tool === 'node') return `跑 ${arg}`;
    if (tool === 'python' || tool === 'python3') return `跑 ${arg}`;
    if (tool === 'git') return `git ${arg}`;
    if (tool === 'cargo') return `跑 cargo ${arg}`;
    return `跑 ${tool}`;
  }
  return '跑命令';
}

/** 从最后一条 assistant 消息里推出活动标签。 */
function labelFromMessage(msg) {
  const content = msg && msg.message && msg.message.content;
  if (typeof content === 'string') return { kind: 'say', label: content.trim().slice(0, 24) };
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const input = block.input || {};
    switch (block.name) {
      case 'Bash': return { kind: 'run', label: describeCommand(input.command) };
      case 'Edit':
      case 'Write':
      case 'NotebookEdit': return { kind: 'edit', label: `改 ${baseName(input.file_path)}` };
      case 'Read': return { kind: 'read', label: `读 ${baseName(input.file_path)}` };
      case 'Agent':
      case 'Task': return { kind: 'agent', label: '派 agent' };
      case 'Skill': return { kind: 'skill', label: `用 ${input.skill || 'skill'}` };
      default: return { kind: 'tool', label: block.name };
    }
  }
  for (const block of content) {
    if (block && block.type === 'text' && block.text && block.text.trim()) {
      return { kind: 'say', label: block.text.trim().slice(0, 24) };
    }
  }
  return null;
}

/**
 * 读一次「现在在干什么」。
 * @returns {null | {label: string, kind: string, at: number}}
 */
function readActivity() {
  const t = newestTranscript();
  if (!t) return null;
  const raw = readTail(t.file, TAIL_BYTES);
  if (!raw) return null;
  const lines = raw.split('\n');
  /* 尾巴的第一行可能是半截（截断点落在行中间）→ 丢掉。 */
  if (lines.length > 1) lines.shift();
  let last = null;
  for (let i = lines.length - 1; i >= 0 && i > lines.length - MAX_LINES; i--) {
    const line = lines[i];
    if (!line || line.length < 8) continue;
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;                       /* 正在写的半截行 → 跳过 */
    }
    if (obj.type !== 'assistant') continue;
    const label = labelFromMessage(obj);
    if (label) { last = label; break; }
  }
  if (!last) return null;
  return { ...last, at: t.mtimeMs };
}

/** 活动是不是已经过期（太久没动 → 不显示，免得一直挂着旧的）。 */
function isStale(activity) {
  if (!activity) return true;
  return Date.now() - activity.at > STALE_MS;
}

module.exports = { readActivity, isStale, newestTranscript };
